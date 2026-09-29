import type {
  AppData,
  AttendanceEntry,
  MonthlyRecord,
  PayAdjustment,
} from './types'

export type AttendanceIndex = ReadonlyMap<string, AttendanceEntry>

export interface PayrollLookup {
  attendanceByWorkerMonth: ReadonlyMap<string, readonly AttendanceEntry[]>
  adjustmentsByWorkerMonth: ReadonlyMap<string, readonly PayAdjustment[]>
  monthlyRecordByWorkerMonth: ReadonlyMap<string, MonthlyRecord>
  monthlyRecordsByWorker: ReadonlyMap<string, readonly MonthlyRecord[]>
  siteNameById: ReadonlyMap<string, string>
}

export function workerDateKey(workerId: string, date: string): string {
  return `${workerId}\u0000${date}`
}

export function workerMonthKey(workerId: string, month: string): string {
  return `${workerId}\u0000${month}`
}

export function buildAttendanceIndex(entries: readonly AttendanceEntry[]): AttendanceIndex {
  const index = new Map<string, AttendanceEntry>()
  for (const entry of entries) index.set(workerDateKey(entry.workerId, entry.date), entry)
  return index
}

export function buildPayrollLookup(data: AppData): PayrollLookup {
  const attendanceByWorkerMonth = new Map<string, AttendanceEntry[]>()
  for (const entry of data.attendance) {
    appendToBucket(attendanceByWorkerMonth, workerMonthKey(entry.workerId, entry.date.slice(0, 7)), entry)
  }

  const adjustmentsByWorkerMonth = new Map<string, PayAdjustment[]>()
  for (const adjustment of data.payAdjustments ?? []) {
    appendToBucket(
      adjustmentsByWorkerMonth,
      workerMonthKey(adjustment.workerId, adjustment.month),
      adjustment,
    )
  }

  const monthlyRecordByWorkerMonth = new Map<string, MonthlyRecord>()
  const monthlyRecordsByWorker = new Map<string, MonthlyRecord[]>()
  for (const record of data.monthlyRecords) {
    monthlyRecordByWorkerMonth.set(workerMonthKey(record.workerId, record.month), record)
    appendToBucket(monthlyRecordsByWorker, record.workerId, record)
  }
  for (const records of monthlyRecordsByWorker.values()) {
    records.sort((left, right) => left.month.localeCompare(right.month))
  }

  return {
    attendanceByWorkerMonth,
    adjustmentsByWorkerMonth,
    monthlyRecordByWorkerMonth,
    monthlyRecordsByWorker,
    siteNameById: new Map((data.sites ?? []).map((site) => [site.id, site.name])),
  }
}

function appendToBucket<T>(buckets: Map<string, T[]>, key: string, value: T): void {
  const bucket = buckets.get(key)
  if (bucket) bucket.push(value)
  else buckets.set(key, [value])
}
