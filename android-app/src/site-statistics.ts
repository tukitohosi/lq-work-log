import { buildMonthlyCompensationLedger, type CompensationLine } from './compensation-ledger'
import { buildPayrollLookup } from './data-index'
import type { AppData, Worker } from './types'

export type SiteStatisticsPeriod =
  | { mode: 'month'; month: string }
  | { mode: 'year'; year: string }

export type SiteStatisticsBucketKind =
  | 'site'
  | 'unassigned-work'
  | 'paid-leave'
  | 'unpaid-leave'
  | 'unassigned-adjustment'

export interface SiteStatisticsMetrics {
  workerCount: number
  personTimes: number
  morningHalfDays: number
  afternoonHalfDays: number
  overtimeHalfDays: number
  totalWorkHalfDays: number
  workDays: number
  paidLeaveHalfDays: number
  unpaidLeaveHalfDays: number
  paidLeavePeriods: number
  unpaidLeavePeriods: number
  basePayFen: number
  allowanceFen: number
  deductionFen: number
  netCostFen: number
}

export interface SiteWorkerStatisticsRow extends Omit<SiteStatisticsMetrics, 'workerCount'> {
  workerId: string
  workerName: string
}

export interface SiteStatisticsRow extends SiteStatisticsMetrics {
  key: string
  bucketKind: SiteStatisticsBucketKind
  siteId: string | null
  siteName: string
  archived: boolean
  workers: SiteWorkerStatisticsRow[]
}

export interface SiteStatisticsSummary {
  period: SiteStatisticsPeriod
  months: string[]
  rows: SiteStatisticsRow[]
  totals: SiteStatisticsMetrics
  /** Canonical source lines, exposed for audited exports and drill-down views. */
  lines: CompensationLine[]
}

export interface SiteStatisticsOptions {
  data: AppData
  period: SiteStatisticsPeriod
  workerIds?: readonly string[]
  /** Include configured sites that have no work or adjustment in the period. */
  includeEmptySites?: boolean
}

interface MutableMetrics {
  workerIds: Set<string>
  personTimeKeys: Set<string>
  morningHalfDays: number
  afternoonHalfDays: number
  overtimeHalfDays: number
  paidLeaveHalfDays: number
  unpaidLeaveHalfDays: number
  paidLeavePeriods: number
  unpaidLeavePeriods: number
  basePayFen: number
  allowanceFen: number
  deductionFen: number
}

interface MutableRow extends MutableMetrics {
  key: string
  bucketKind: SiteStatisticsBucketKind
  siteId: string | null
  siteName: string
  archived: boolean
  workers: Map<string, MutableWorkerRow>
}

interface MutableWorkerRow extends MutableMetrics {
  workerId: string
  workerName: string
}

export function calculateSiteStatistics(options: SiteStatisticsOptions): SiteStatisticsSummary {
  const { data, period } = options
  const lookup = buildPayrollLookup(data)
  const months = monthsForPeriod(period)
  const requestedWorkerIds = options.workerIds ? new Set(options.workerIds) : null
  const workers = data.workers.filter((worker) => !requestedWorkerIds || requestedWorkerIds.has(worker.id))
  const workerById = new Map(workers.map((worker) => [worker.id, worker]))
  const siteById = new Map(data.sites.map((site) => [site.id, site]))
  const rows = new Map<string, MutableRow>()
  const lines: CompensationLine[] = []

  if (options.includeEmptySites) {
    for (const site of data.sites) {
      const key = `site:${site.id}`
      rows.set(key, createMutableRow(key, 'site', site.id, site.name, Boolean(site.archivedAt)))
    }
  }

  for (const worker of workers) {
    for (const month of months) {
      const ledger = buildMonthlyCompensationLedger({ data, worker, month, lookup })
      for (const line of ledger.lines) {
        lines.push(line)
        const descriptor = bucketDescriptor(line, siteById)
        const row = rows.get(descriptor.key) ?? createMutableRow(
          descriptor.key,
          descriptor.bucketKind,
          descriptor.siteId,
          descriptor.siteName,
          descriptor.archived,
        )
        rows.set(descriptor.key, row)
        addLineMetrics(row, line)

        const lineWorker = workerById.get(line.workerId) ?? worker
        const workerRow = row.workers.get(line.workerId) ?? createMutableWorkerRow(lineWorker)
        row.workers.set(line.workerId, workerRow)
        addLineMetrics(workerRow, line)
      }
    }
  }

  const finalizedRows = Array.from(rows.values())
    .map(finalizeRow)
    .sort(compareRows)
  const actualWorkerIds = new Set<string>()
  for (const row of rows.values()) for (const id of row.workerIds) actualWorkerIds.add(id)
  const totals = sumFinalMetrics(finalizedRows, actualWorkerIds.size)

  return {
    period,
    months,
    rows: finalizedRows,
    totals,
    lines,
  }
}

function monthsForPeriod(period: SiteStatisticsPeriod): string[] {
  if (period.mode === 'month') return [period.month]
  return Array.from(
    { length: 12 },
    (_, index) => `${period.year}-${String(index + 1).padStart(2, '0')}`,
  )
}

function bucketDescriptor(
  line: CompensationLine,
  siteById: ReadonlyMap<string, AppData['sites'][number]>,
): Pick<MutableRow, 'key' | 'bucketKind' | 'siteId' | 'siteName' | 'archived'> {
  if (line.bucketKind === 'site' && line.siteId) {
    const site = siteById.get(line.siteId)
    return {
      key: `site:${line.siteId}`,
      bucketKind: 'site',
      siteId: line.siteId,
      siteName: site?.name ?? line.siteName,
      archived: Boolean(site?.archivedAt),
    }
  }
  return {
    key: line.bucketKind,
    bucketKind: line.bucketKind,
    siteId: null,
    siteName: line.siteName,
    archived: false,
  }
}

function createMutableMetrics(): MutableMetrics {
  return {
    workerIds: new Set(),
    personTimeKeys: new Set(),
    morningHalfDays: 0,
    afternoonHalfDays: 0,
    overtimeHalfDays: 0,
    paidLeaveHalfDays: 0,
    unpaidLeaveHalfDays: 0,
    paidLeavePeriods: 0,
    unpaidLeavePeriods: 0,
    basePayFen: 0,
    allowanceFen: 0,
    deductionFen: 0,
  }
}

function createMutableRow(
  key: string,
  bucketKind: SiteStatisticsBucketKind,
  siteId: string | null,
  siteName: string,
  archived: boolean,
): MutableRow {
  return {
    ...createMutableMetrics(),
    key,
    bucketKind,
    siteId,
    siteName,
    archived,
    workers: new Map(),
  }
}

function createMutableWorkerRow(worker: Worker): MutableWorkerRow {
  return {
    ...createMutableMetrics(),
    workerId: worker.id,
    workerName: worker.name,
  }
}

function addLineMetrics(metrics: MutableMetrics, line: CompensationLine): void {
  const actualWork = line.kind === 'ordinary-work' || line.kind === 'overtime-work'
  if (actualWork) {
    metrics.workerIds.add(line.workerId)
    if (line.date) metrics.personTimeKeys.add(`${line.workerId}\u0000${line.date}`)
    if (line.period === 'morning') metrics.morningHalfDays += line.workHalfDays
    else if (line.period === 'afternoon') metrics.afternoonHalfDays += line.workHalfDays
    else metrics.overtimeHalfDays += line.workHalfDays
  }

  if (line.kind === 'paid-leave') {
    metrics.paidLeaveHalfDays += line.leaveHalfDays
    metrics.paidLeavePeriods += 1
  } else if (line.kind === 'unpaid-leave') {
    metrics.unpaidLeaveHalfDays += line.leaveHalfDays
    metrics.unpaidLeavePeriods += 1
  }

  if (line.kind === 'ordinary-work' || line.kind === 'overtime-work' || line.kind === 'paid-leave') {
    metrics.basePayFen += line.amountFen
  } else if (line.kind === 'allowance') {
    metrics.allowanceFen += line.amountFen
  } else if (line.kind === 'deduction') {
    metrics.deductionFen += -line.amountFen
  }
}

function finalizeRow(row: MutableRow): SiteStatisticsRow {
  return {
    key: row.key,
    bucketKind: row.bucketKind,
    siteId: row.siteId,
    siteName: row.siteName,
    archived: row.archived,
    ...finalizeMetrics(row),
    workers: Array.from(row.workers.values())
      .map((worker): SiteWorkerStatisticsRow => ({
        workerId: worker.workerId,
        workerName: worker.workerName,
        ...withoutWorkerCount(finalizeMetrics(worker)),
      }))
      .sort((left, right) => left.workerName.localeCompare(right.workerName, 'zh-CN') || left.workerId.localeCompare(right.workerId)),
  }
}

function finalizeMetrics(metrics: MutableMetrics): SiteStatisticsMetrics {
  const totalWorkHalfDays = metrics.morningHalfDays + metrics.afternoonHalfDays + metrics.overtimeHalfDays
  return {
    workerCount: metrics.workerIds.size,
    personTimes: metrics.personTimeKeys.size,
    morningHalfDays: metrics.morningHalfDays,
    afternoonHalfDays: metrics.afternoonHalfDays,
    overtimeHalfDays: metrics.overtimeHalfDays,
    totalWorkHalfDays,
    workDays: totalWorkHalfDays / 2,
    paidLeaveHalfDays: metrics.paidLeaveHalfDays,
    unpaidLeaveHalfDays: metrics.unpaidLeaveHalfDays,
    paidLeavePeriods: metrics.paidLeavePeriods,
    unpaidLeavePeriods: metrics.unpaidLeavePeriods,
    basePayFen: metrics.basePayFen,
    allowanceFen: metrics.allowanceFen,
    deductionFen: metrics.deductionFen,
    netCostFen: metrics.basePayFen + metrics.allowanceFen - metrics.deductionFen,
  }
}

function withoutWorkerCount(metrics: SiteStatisticsMetrics): Omit<SiteStatisticsMetrics, 'workerCount'> {
  const { workerCount: _workerCount, ...rest } = metrics
  return rest
}

function sumFinalMetrics(rows: readonly SiteStatisticsRow[], workerCount: number): SiteStatisticsMetrics {
  const total = {
    workerCount,
    personTimes: 0,
    morningHalfDays: 0,
    afternoonHalfDays: 0,
    overtimeHalfDays: 0,
    totalWorkHalfDays: 0,
    workDays: 0,
    paidLeaveHalfDays: 0,
    unpaidLeaveHalfDays: 0,
    paidLeavePeriods: 0,
    unpaidLeavePeriods: 0,
    basePayFen: 0,
    allowanceFen: 0,
    deductionFen: 0,
    netCostFen: 0,
  }
  for (const row of rows) {
    total.personTimes += row.personTimes
    total.morningHalfDays += row.morningHalfDays
    total.afternoonHalfDays += row.afternoonHalfDays
    total.overtimeHalfDays += row.overtimeHalfDays
    total.paidLeaveHalfDays += row.paidLeaveHalfDays
    total.unpaidLeaveHalfDays += row.unpaidLeaveHalfDays
    total.paidLeavePeriods += row.paidLeavePeriods
    total.unpaidLeavePeriods += row.unpaidLeavePeriods
    total.basePayFen += row.basePayFen
    total.allowanceFen += row.allowanceFen
    total.deductionFen += row.deductionFen
  }
  total.totalWorkHalfDays = total.morningHalfDays + total.afternoonHalfDays + total.overtimeHalfDays
  total.workDays = total.totalWorkHalfDays / 2
  total.netCostFen = total.basePayFen + total.allowanceFen - total.deductionFen
  return total
}

function compareRows(left: SiteStatisticsRow, right: SiteStatisticsRow): number {
  const rank = (row: SiteStatisticsRow): number => {
    if (row.bucketKind === 'site') return row.archived ? 1 : 0
    if (row.bucketKind === 'unassigned-work') return 2
    if (row.bucketKind === 'paid-leave') return 3
    if (row.bucketKind === 'unpaid-leave') return 4
    return 5
  }
  return rank(left) - rank(right)
    || left.siteName.localeCompare(right.siteName, 'zh-CN')
    || left.key.localeCompare(right.key)
}
