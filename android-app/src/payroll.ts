import { buildPayrollLookup, workerMonthKey } from './data-index'
import type { PayrollLookup } from './data-index'
import {
  buildMonthlyCompensationLedger,
  type CompensationLine,
} from './compensation-ledger'
import {
  resolveDailyRate,
  resolveOvertimePayPercent,
} from './payroll-rules'
import type { AppData, PayAdjustment, Worker } from './types'

export { resolveDailyRate, resolveOvertimePayPercent } from './payroll-rules'

export interface SiteWorkBreakdown {
  siteId: string | null
  siteName: string
  morningHalfDays: number
  afternoonHalfDays: number
  overtimeHalfDays: number
  totalHalfDays: number
  workDays: number
}

export interface PayrollTotals {
  morningCount: number
  afternoonCount: number
  overtimeHalfDays: number
  totalHalfDays: number
  workDays: number
  basePayFen: number
  allowanceFen: number
  deductionFen: number
  netPayFen: number
}

export interface MonthlyPayrollSummary extends PayrollTotals {
  workerId: string
  month: string
  dailyRateFen: number
  overtimePayPercent: number
  paidAt: string | null
  hasMonthlyRecord: boolean
  siteBreakdown: SiteWorkBreakdown[]
  /** Present on calculated v8 summaries; optional for older persisted report fixtures. */
  dailyRateSourceMonth?: string | null
  paidLeaveHalfDays?: number
  unpaidLeaveHalfDays?: number
  paidLeavePeriods?: number
  unpaidLeavePeriods?: number
  compensationLines?: CompensationLine[]
}

export interface AnnualWorkerPayrollRow {
  worker: Worker
  months: MonthlyPayrollSummary[]
  totals: PayrollTotals
  siteBreakdown: SiteWorkBreakdown[]
}

export interface AnnualPayrollSummary {
  year: string
  months: string[]
  rows: AnnualWorkerPayrollRow[]
  totals: PayrollTotals
  siteBreakdown: SiteWorkBreakdown[]
}

export interface PayslipData {
  worker: Worker
  month: string
  paidAt: string | null
  payroll: MonthlyPayrollSummary
  adjustments: PayAdjustment[]
  siteBreakdown: SiteWorkBreakdown[]
  ordinaryHalfDays: number
  ordinaryWorkDays: number
  overtimeWorkDays: number
}

export interface MonthlyPayrollOptions {
  data: AppData
  worker: Worker
  month: string
  lookup?: PayrollLookup
}

export interface YearlyPayrollOptions {
  data: AppData
  year: string
  workerIds?: readonly string[]
  defaultSiteIds?: readonly (string | null)[]
  lookup?: PayrollLookup
}

export interface PayslipOptions {
  data: AppData
  worker: Worker
  month: string
  lookup?: PayrollLookup
}

const EMPTY_TOTALS: PayrollTotals = {
  morningCount: 0,
  afternoonCount: 0,
  overtimeHalfDays: 0,
  totalHalfDays: 0,
  workDays: 0,
  basePayFen: 0,
  allowanceFen: 0,
  deductionFen: 0,
  netPayFen: 0,
}

export function resolveDailyRateFen(
  data: AppData,
  worker: Worker,
  month: string,
  lookup?: PayrollLookup,
): number {
  return resolveDailyRate(data, worker, month, lookup).rateFen
}

export function calculateMonthlyPayroll(options: MonthlyPayrollOptions): MonthlyPayrollSummary {
  const { data, worker, month } = options
  const lookup = options.lookup ?? buildPayrollLookup(data)
  const key = workerMonthKey(worker.id, month)
  const monthlyRecord = lookup.monthlyRecordByWorkerMonth.get(key)
  const ledger = buildMonthlyCompensationLedger({ data, worker, month, lookup })
  const morningCount = ledger.lines.reduce(
    (sum, line) => sum + (line.kind === 'ordinary-work' && line.period === 'morning' ? line.workHalfDays : 0),
    0,
  )
  const afternoonCount = ledger.lines.reduce(
    (sum, line) => sum + (line.kind === 'ordinary-work' && line.period === 'afternoon' ? line.workHalfDays : 0),
    0,
  )
  const overtimeHalfDays = ledger.lines.reduce(
    (sum, line) => sum + (line.kind === 'overtime-work' ? line.workHalfDays : 0),
    0,
  )
  const ordinaryHalfDays = morningCount + afternoonCount
  const totalHalfDays = ordinaryHalfDays + overtimeHalfDays

  return {
    workerId: worker.id,
    month,
    dailyRateFen: ledger.dailyRateFen,
    dailyRateSourceMonth: ledger.dailyRateSourceMonth,
    overtimePayPercent: ledger.overtimePayPercent,
    paidAt: monthlyRecord?.paidAt ?? null,
    hasMonthlyRecord: Boolean(monthlyRecord),
    morningCount,
    afternoonCount,
    overtimeHalfDays,
    totalHalfDays,
    workDays: totalHalfDays / 2,
    paidLeaveHalfDays: ledger.paidLeaveHalfDays,
    unpaidLeaveHalfDays: ledger.unpaidLeaveHalfDays,
    paidLeavePeriods: ledger.paidLeavePeriods,
    unpaidLeavePeriods: ledger.unpaidLeavePeriods,
    basePayFen: ledger.basePayFen,
    allowanceFen: ledger.allowanceFen,
    deductionFen: ledger.deductionFen,
    netPayFen: ledger.netPayFen,
    siteBreakdown: calculateSiteBreakdown(ledger.lines),
    compensationLines: ledger.lines,
  }
}

export function calculateYearlyPayroll(options: YearlyPayrollOptions): AnnualPayrollSummary {
  const { data, year, workerIds, defaultSiteIds } = options
  const lookup = options.lookup ?? buildPayrollLookup(data)
  const months = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`)
  const requestedWorkers = workerIds ? new Set(workerIds) : null
  const requestedSites = defaultSiteIds ? new Set(defaultSiteIds) : null
  const workers = data.workers.filter((worker) => {
    if (requestedWorkers && !requestedWorkers.has(worker.id)) return false
    if (requestedSites && !requestedSites.has(worker.defaultSiteId ?? null)) return false
    return true
  })
  const rows = workers.map((worker) => {
    const payrollMonths = months.map((month) => calculateMonthlyPayroll({ data, worker, month, lookup }))
    return {
      worker,
      months: payrollMonths,
      totals: sumPayrollTotals(payrollMonths),
      siteBreakdown: mergeSiteBreakdowns(payrollMonths.flatMap((item) => item.siteBreakdown)),
    }
  })

  return {
    year,
    months,
    rows,
    totals: sumPayrollTotals(rows.map((row) => row.totals)),
    siteBreakdown: mergeSiteBreakdowns(rows.flatMap((row) => row.siteBreakdown)),
  }
}

export function buildPayslipData(options: PayslipOptions): PayslipData {
  const { data, worker, month } = options
  const lookup = options.lookup ?? buildPayrollLookup(data)
  const payroll = calculateMonthlyPayroll({ ...options, lookup })
  const adjustments = [...(lookup.adjustmentsByWorkerMonth.get(workerMonthKey(worker.id, month)) ?? [])]
    .sort((a, b) => compareNullableDates(a.date, b.date) || a.createdAt.localeCompare(b.createdAt))

  return {
    worker,
    month,
    paidAt: payroll.paidAt,
    payroll,
    adjustments,
    siteBreakdown: payroll.siteBreakdown,
    ordinaryHalfDays: payroll.morningCount + payroll.afternoonCount,
    ordinaryWorkDays: (payroll.morningCount + payroll.afternoonCount) / 2,
    overtimeWorkDays: payroll.overtimeHalfDays / 2,
  }
}

function compareNullableDates(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a.localeCompare(b)
}

function calculateSiteBreakdown(
  lines: readonly CompensationLine[],
): SiteWorkBreakdown[] {
  const totals = new Map<string, SiteWorkBreakdown>()
  const add = (siteId: string | null | undefined, period: 'morning' | 'afternoon' | 'overtime', units: number) => {
    if (!units) return
    const normalizedId = siteId || null
    const key = normalizedId ?? ''
    const row = totals.get(key) ?? {
      siteId: normalizedId,
      siteName: normalizedId ? `未知工地（${normalizedId}）` : '未分配',
      morningHalfDays: 0,
      afternoonHalfDays: 0,
      overtimeHalfDays: 0,
      totalHalfDays: 0,
      workDays: 0,
    }
    if (period === 'morning') row.morningHalfDays += units
    else if (period === 'afternoon') row.afternoonHalfDays += units
    else row.overtimeHalfDays += units
    row.totalHalfDays += units
    row.workDays = row.totalHalfDays / 2
    totals.set(key, row)
  }

  for (const line of lines) {
    if (line.kind !== 'ordinary-work' && line.kind !== 'overtime-work') continue
    add(line.siteId, line.period ?? 'overtime', line.workHalfDays)
    const row = totals.get(line.siteId ?? '')
    if (row) row.siteName = line.siteName === '未分配工地' ? '未分配' : line.siteName
  }

  return Array.from(totals.values()).sort((a, b) => {
    if (a.siteId === null) return 1
    if (b.siteId === null) return -1
    return a.siteName.localeCompare(b.siteName, 'zh-CN')
  })
}

function mergeSiteBreakdowns(rows: SiteWorkBreakdown[]): SiteWorkBreakdown[] {
  const totals = new Map<string, SiteWorkBreakdown>()
  for (const item of rows) {
    const key = item.siteId ?? ''
    const row = totals.get(key) ?? { ...item, morningHalfDays: 0, afternoonHalfDays: 0, overtimeHalfDays: 0, totalHalfDays: 0, workDays: 0 }
    row.morningHalfDays += item.morningHalfDays
    row.afternoonHalfDays += item.afternoonHalfDays
    row.overtimeHalfDays += item.overtimeHalfDays
    row.totalHalfDays += item.totalHalfDays
    row.workDays = row.totalHalfDays / 2
    totals.set(key, row)
  }
  return Array.from(totals.values()).sort((a, b) => {
    if (a.siteId === null) return 1
    if (b.siteId === null) return -1
    return a.siteName.localeCompare(b.siteName, 'zh-CN')
  })
}

function sumPayrollTotals(rows: readonly PayrollTotals[]): PayrollTotals {
  const result = { ...EMPTY_TOTALS }
  for (const item of rows) {
    result.morningCount += item.morningCount
    result.afternoonCount += item.afternoonCount
    result.overtimeHalfDays += item.overtimeHalfDays
    result.totalHalfDays += item.totalHalfDays
    result.basePayFen += item.basePayFen
    result.allowanceFen += item.allowanceFen
    result.deductionFen += item.deductionFen
    result.netPayFen += item.netPayFen
  }
  result.workDays = result.totalHalfDays / 2
  return result
}
