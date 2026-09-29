import { buildPayrollLookup, workerMonthKey } from './data-index'
import type { PayrollLookup } from './data-index'
import { resolveDailyRate, resolveOvertimePayPercent } from './payroll-rules'
import type {
  AppData,
  AttendanceEntry,
  AttendancePeriod,
  PayAdjustment,
  Worker,
} from './types'

export type CompensationLineKind =
  | 'ordinary-work'
  | 'overtime-work'
  | 'paid-leave'
  | 'unpaid-leave'
  | 'allowance'
  | 'deduction'

export type CompensationBucketKind =
  | 'site'
  | 'unassigned-work'
  | 'paid-leave'
  | 'unpaid-leave'
  | 'unassigned-adjustment'

export interface CompensationLine {
  id: string
  workerId: string
  month: string
  date: string | null
  period: AttendancePeriod | null
  kind: CompensationLineKind
  bucketKind: CompensationBucketKind
  siteId: string | null
  siteName: string
  /** Actual worked half-days. Leave never contributes to this value. */
  workHalfDays: number
  /** Paid leave units, or known ordinary unpaid leave units, expressed as half-days. */
  leaveHalfDays: number
  /** Signed payroll effect in fen. Deductions are negative. */
  amountFen: number
}

export interface MonthlyCompensationLedger {
  workerId: string
  month: string
  dailyRateFen: number
  dailyRateSourceMonth: string | null
  overtimePayPercent: number
  lines: CompensationLine[]
  actualWorkHalfDays: number
  paidLeaveHalfDays: number
  unpaidLeaveHalfDays: number
  paidLeavePeriods: number
  unpaidLeavePeriods: number
  basePayFen: number
  allowanceFen: number
  deductionFen: number
  netPayFen: number
}

export interface CompensationLedgerOptions {
  data: AppData
  worker: Worker
  month: string
  lookup?: PayrollLookup
}

interface BasePayCandidate extends Omit<CompensationLine, 'amountFen'> {
  exactNumerator: number
  tieKey: string
}

const PERIOD_ORDER: Record<AttendancePeriod, number> = {
  morning: 0,
  afternoon: 1,
  overtime: 2,
}

/**
 * Builds the canonical, cent-reconciled monthly compensation ledger. Leave wins
 * over malformed legacy attendance in the same period, so it can never be paid
 * twice. All base-pay cents are distributed exactly once by largest remainder.
 */
export function buildMonthlyCompensationLedger(
  options: CompensationLedgerOptions,
): MonthlyCompensationLedger {
  const { data, worker, month } = options
  const lookup = options.lookup ?? buildPayrollLookup(data)
  const rate = resolveDailyRate(data, worker, month, lookup)
  const overtimePayPercent = resolveOvertimePayPercent(data, worker, month, lookup)
  const entries = [...(lookup.attendanceByWorkerMonth.get(workerMonthKey(worker.id, month)) ?? [])]
    .sort((left, right) => left.date.localeCompare(right.date))
  const candidates: BasePayCandidate[] = []
  const zeroValueLeaveLines: CompensationLine[] = []

  for (const entry of entries) {
    addOrdinaryPeriod(entry, 'morning', rate.rateFen, lookup, candidates, zeroValueLeaveLines)
    addOrdinaryPeriod(entry, 'afternoon', rate.rateFen, lookup, candidates, zeroValueLeaveLines)
    addOvertimePeriod(
      entry,
      rate.rateFen,
      overtimePayPercent,
      lookup,
      candidates,
      zeroValueLeaveLines,
    )
  }

  const baseLines = allocateBasePayCents(candidates)
  const adjustments = [...(lookup.adjustmentsByWorkerMonth.get(workerMonthKey(worker.id, month)) ?? [])]
    .sort(compareAdjustments)
    .map((adjustment) => adjustmentLine(adjustment, lookup))
  const lines = [...baseLines, ...zeroValueLeaveLines, ...adjustments]
    .sort(compareCompensationLines)
  const basePayFen = baseLines.reduce((sum, line) => sum + line.amountFen, 0)
  const allowanceFen = adjustments.reduce(
    (sum, line) => sum + (line.kind === 'allowance' ? line.amountFen : 0),
    0,
  )
  const deductionFen = adjustments.reduce(
    (sum, line) => sum + (line.kind === 'deduction' ? -line.amountFen : 0),
    0,
  )

  return {
    workerId: worker.id,
    month,
    dailyRateFen: rate.rateFen,
    dailyRateSourceMonth: rate.sourceMonth,
    overtimePayPercent,
    lines,
    actualWorkHalfDays: baseLines.reduce((sum, line) => sum + line.workHalfDays, 0),
    paidLeaveHalfDays: baseLines.reduce((sum, line) => sum + line.leaveHalfDays, 0),
    unpaidLeaveHalfDays: zeroValueLeaveLines.reduce((sum, line) => sum + line.leaveHalfDays, 0),
    paidLeavePeriods: baseLines.reduce((sum, line) => sum + (line.kind === 'paid-leave' ? 1 : 0), 0),
    unpaidLeavePeriods: zeroValueLeaveLines.length,
    basePayFen,
    allowanceFen,
    deductionFen,
    netPayFen: basePayFen + allowanceFen - deductionFen,
  }
}

function addOrdinaryPeriod(
  entry: AttendanceEntry,
  period: 'morning' | 'afternoon',
  dailyRateFen: number,
  lookup: PayrollLookup,
  candidates: BasePayCandidate[],
  zeroValueLeaveLines: CompensationLine[],
): void {
  const leave = period === 'morning' ? entry.morningLeave : entry.afternoonLeave
  if (leave) {
    const common = leaveLineBase(entry, period, leave.payType)
    if (leave.payType === 'paid') {
      candidates.push({
        ...common,
        exactNumerator: dailyRateFen * 100,
        tieKey: lineTieKey(common),
      })
    } else {
      zeroValueLeaveLines.push({ ...common, amountFen: 0 })
    }
    return
  }

  if (entry[period] !== 'present') return
  const siteId = normalizedSiteId(entry[`${period}SiteId`])
  const common: Omit<CompensationLine, 'amountFen'> = {
    id: `attendance:${entry.workerId}:${entry.date}:${period}:work`,
    workerId: entry.workerId,
    month: entry.date.slice(0, 7),
    date: entry.date,
    period,
    kind: 'ordinary-work',
    bucketKind: siteId ? 'site' : 'unassigned-work',
    siteId,
    siteName: siteLabel(siteId, lookup),
    workHalfDays: 1,
    leaveHalfDays: 0,
  }
  candidates.push({
    ...common,
    exactNumerator: dailyRateFen * 100,
    tieKey: lineTieKey(common),
  })
}

function addOvertimePeriod(
  entry: AttendanceEntry,
  dailyRateFen: number,
  overtimePayPercent: number,
  lookup: PayrollLookup,
  candidates: BasePayCandidate[],
  zeroValueLeaveLines: CompensationLine[],
): void {
  const leave = entry.overtimeLeave
  if (leave) {
    const common = leaveLineBase(entry, 'overtime', leave.payType, leave.payType === 'paid'
      ? (leave.units === 'full' ? 2 : 1)
      : 0)
    if (leave.payType === 'paid') {
      candidates.push({
        ...common,
        exactNumerator: dailyRateFen * common.leaveHalfDays * overtimePayPercent,
        tieKey: lineTieKey(common),
      })
    } else {
      zeroValueLeaveLines.push({ ...common, amountFen: 0 })
    }
    return
  }

  const units = entry.overtime === 'full' ? 2 : entry.overtime === 'half' ? 1 : 0
  if (!units) return
  const siteId = normalizedSiteId(entry.overtimeSiteId)
  const common: Omit<CompensationLine, 'amountFen'> = {
    id: `attendance:${entry.workerId}:${entry.date}:overtime:work`,
    workerId: entry.workerId,
    month: entry.date.slice(0, 7),
    date: entry.date,
    period: 'overtime',
    kind: 'overtime-work',
    bucketKind: siteId ? 'site' : 'unassigned-work',
    siteId,
    siteName: siteLabel(siteId, lookup),
    workHalfDays: units,
    leaveHalfDays: 0,
  }
  candidates.push({
    ...common,
    exactNumerator: dailyRateFen * units * overtimePayPercent,
    tieKey: lineTieKey(common),
  })
}

function leaveLineBase(
  entry: AttendanceEntry,
  period: AttendancePeriod,
  payType: 'paid' | 'unpaid',
  leaveHalfDays = 1,
): Omit<CompensationLine, 'amountFen'> {
  const paid = payType === 'paid'
  return {
    id: `attendance:${entry.workerId}:${entry.date}:${period}:${paid ? 'paid-leave' : 'unpaid-leave'}`,
    workerId: entry.workerId,
    month: entry.date.slice(0, 7),
    date: entry.date,
    period,
    kind: paid ? 'paid-leave' : 'unpaid-leave',
    bucketKind: paid ? 'paid-leave' : 'unpaid-leave',
    siteId: null,
    siteName: paid ? '带薪假（未归属工地）' : '无薪假（未归属工地）',
    workHalfDays: 0,
    leaveHalfDays,
  }
}

function adjustmentLine(adjustment: PayAdjustment, lookup: PayrollLookup): CompensationLine {
  const siteId = normalizedSiteId(adjustment.siteId)
  const signedAmount = adjustment.kind === 'deduction' ? -adjustment.amountFen : adjustment.amountFen
  return {
    id: `adjustment:${adjustment.id}`,
    workerId: adjustment.workerId,
    month: adjustment.month,
    date: adjustment.date,
    period: null,
    kind: adjustment.kind,
    bucketKind: siteId ? 'site' : 'unassigned-adjustment',
    siteId,
    siteName: siteId ? siteLabel(siteId, lookup) : '未归属调整',
    workHalfDays: 0,
    leaveHalfDays: 0,
    amountFen: signedAmount,
  }
}

function allocateBasePayCents(candidates: readonly BasePayCandidate[]): CompensationLine[] {
  if (!candidates.length) return []
  const totalNumerator = candidates.reduce((sum, line) => sum + line.exactNumerator, 0)
  const targetFen = Math.round(totalNumerator / 200)
  const floorAmounts = candidates.map((line) => Math.floor(line.exactNumerator / 200))
  let centsToAssign = targetFen - floorAmounts.reduce((sum, value) => sum + value, 0)
  const order = candidates
    .map((line, index) => ({
      index,
      remainder: line.exactNumerator % 200,
      tieKey: line.tieKey,
    }))
    .sort((left, right) => right.remainder - left.remainder || compareCodeUnits(left.tieKey, right.tieKey))

  for (const item of order) {
    if (centsToAssign <= 0) break
    floorAmounts[item.index] += 1
    centsToAssign -= 1
  }

  return candidates.map(({ exactNumerator: _exactNumerator, tieKey: _tieKey, ...line }, index) => ({
    ...line,
    amountFen: floorAmounts[index],
  }))
}

function lineTieKey(line: Omit<CompensationLine, 'amountFen'>): string {
  return `${line.date ?? ''}\u0000${String(PERIOD_ORDER[line.period ?? 'morning'])}\u0000${line.bucketKind}\u0000${line.siteId ?? ''}\u0000${line.id}`
}

function siteLabel(siteId: string | null, lookup: PayrollLookup): string {
  if (!siteId) return '未分配工地'
  return lookup.siteNameById.get(siteId) ?? `未知工地（${siteId}）`
}

function normalizedSiteId(siteId: string | null | undefined): string | null {
  return siteId || null
}

function compareAdjustments(left: PayAdjustment, right: PayAdjustment): number {
  return left.month.localeCompare(right.month)
    || compareNullableDates(left.date, right.date)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
}

function compareCompensationLines(left: CompensationLine, right: CompensationLine): number {
  return left.month.localeCompare(right.month)
    || compareNullableDates(left.date, right.date)
    || (left.period === null ? 3 : PERIOD_ORDER[left.period]) - (right.period === null ? 3 : PERIOD_ORDER[right.period])
    || left.id.localeCompare(right.id)
}

function compareNullableDates(left: string | null, right: string | null): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left.localeCompare(right)
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
