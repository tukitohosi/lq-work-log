import { resolveEffectiveDailyRate } from '../shared/payroll-rules.mjs'
import { buildPayrollLookup, workerMonthKey } from './data-index'
import type { PayrollLookup } from './data-index'
import type { AppData, Worker } from './types'

export interface ResolvedDailyRate {
  rateFen: number
  /** The month that introduced the effective rate, or null for the worker default. */
  sourceMonth: string | null
}

/**
 * Resolves the rate effective in a month. A monthly rate remains effective until
 * a later monthly record changes it. This is the single front-end implementation
 * used by payroll, timelines, statistics and exports.
 */
export function resolveDailyRate(
  data: AppData,
  worker: Worker,
  month: string,
  lookup?: PayrollLookup,
): ResolvedDailyRate {
  const effectiveLookup = lookup ?? buildPayrollLookup(data)
  return resolveEffectiveDailyRate(
    data,
    worker,
    month,
    effectiveLookup.monthlyRecordsByWorker.get(worker.id) ?? [],
  )
}

export function resolveOvertimePayPercent(
  data: AppData,
  worker: Worker,
  month: string,
  lookup?: PayrollLookup,
): number {
  const effectiveLookup = lookup ?? buildPayrollLookup(data)
  const record = effectiveLookup.monthlyRecordByWorkerMonth.get(workerMonthKey(worker.id, month))
  return record?.overtimePayPercent ?? data.settings.defaultOvertimePayPercent
}
