import { describe, expect, it } from 'vitest'
import {
  buildAttendanceIndex,
  buildPayrollLookup,
  workerDateKey,
  workerMonthKey,
} from '../src/data-index'
import { buildPayslipData, calculateMonthlyPayroll, calculateYearlyPayroll } from '../src/payroll'
import type {
  AppData,
  AttendanceEntry,
  MonthlyRecord,
  PayAdjustment,
  Worker,
} from '../src/types'

function worker(id: string): Worker {
  return {
    id,
    name: `工人${id}`,
    avatarDataUrl: null,
    avatarEmoji: null,
    defaultDailyRateFen: 30_000,
    note: '',
    defaultSiteId: 'site-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
  }
}

function monthlyRecord(
  workerId: string,
  month: string,
  dailyRateFen: number,
  paidAt: string | null = null,
): MonthlyRecord {
  return { workerId, month, dailyRateFen, overtimePayPercent: 100, note: '', paidAt }
}

function appData(overrides: Partial<AppData> = {}): AppData {
  return {
    schemaVersion: 7,
    revision: 1,
    workers: [],
    attendance: [],
    monthlyRecords: [],
    payAdjustments: [],
    sites: [],
    settings: {
      weekStartsOn: 1,
      currentWorkerId: null,
      theme: 'light',
      sidebarCollapsed: false,
      lastBackupExportAt: null,
      lastBackupReminderAt: null,
      weeklyAutoBackupEnabled: true,
      lastWeeklyBackupAt: null,
      defaultOvertimePayPercent: 100,
    },
    ...overrides,
  }
}

function legacyMonthlySnapshot(data: AppData, item: Worker, month: string) {
  const entries = data.attendance.filter(
    (entry) => entry.workerId === item.id && entry.date.startsWith(`${month}-`),
  )
  const record = data.monthlyRecords.find(
    (candidate) => candidate.workerId === item.id && candidate.month === month,
  )
  const prior = data.monthlyRecords
    .filter((candidate) => candidate.workerId === item.id && candidate.month < month)
    .sort((left, right) => right.month.localeCompare(left.month))[0]
  const dailyRateFen = record?.dailyRateFen ?? prior?.dailyRateFen ?? item.defaultDailyRateFen
  const overtimePayPercent = record?.overtimePayPercent ?? data.settings.defaultOvertimePayPercent
  const morningCount = entries.filter((entry) => entry.morning === 'present').length
  const afternoonCount = entries.filter((entry) => entry.afternoon === 'present').length
  const overtimeHalfDays = entries.reduce(
    (sum, entry) => sum + (entry.overtime === 'full' ? 2 : entry.overtime === 'half' ? 1 : 0),
    0,
  )
  const totalHalfDays = morningCount + afternoonCount + overtimeHalfDays
  const ordinaryHalfDays = morningCount + afternoonCount
  const basePayFen = Math.round(
    (dailyRateFen * (ordinaryHalfDays * 100 + overtimeHalfDays * overtimePayPercent)) / 200,
  )
  const adjustments = data.payAdjustments.filter(
    (adjustment) => adjustment.workerId === item.id && adjustment.month === month,
  )
  const allowanceFen = adjustments.reduce(
    (sum, adjustment) => sum + (adjustment.kind === 'allowance' ? adjustment.amountFen : 0),
    0,
  )
  const deductionFen = adjustments.reduce(
    (sum, adjustment) => sum + (adjustment.kind === 'deduction' ? adjustment.amountFen : 0),
    0,
  )
  return {
    dailyRateFen,
    overtimePayPercent,
    paidAt: record?.paidAt ?? null,
    hasMonthlyRecord: Boolean(record),
    morningCount,
    afternoonCount,
    overtimeHalfDays,
    totalHalfDays,
    workDays: totalHalfDays / 2,
    basePayFen,
    allowanceFen,
    deductionFen,
    netPayFen: basePayFen + allowanceFen - deductionFen,
  }
}

describe('data indexes', () => {
  it('indexes exact attendance cells and every payroll source without mutating source order', () => {
    const firstWorker = worker('worker-1')
    const january: AttendanceEntry = {
      workerId: firstWorker.id,
      date: '2026-01-03',
      morning: 'present',
      afternoon: null,
      overtime: null,
      dayNote: '',
      morningSiteId: 'site-a',
      afternoonSiteId: null,
      overtimeSiteId: null,
    }
    const february = { ...january, date: '2026-02-04' }
    const laterRecord = monthlyRecord(firstWorker.id, '2026-08', 32_000)
    const earlierRecord = monthlyRecord(firstWorker.id, '2026-01', 31_000, '2026-02-01T00:00:00.000Z')
    const adjustment: PayAdjustment = {
      id: 'adjustment-1',
      workerId: firstWorker.id,
      month: '2026-02',
      date: null,
      kind: 'allowance',
      amountFen: 500,
      label: '餐补',
      note: '',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }
    const data = appData({
      workers: [firstWorker],
      attendance: [january, february],
      monthlyRecords: [laterRecord, earlierRecord],
      payAdjustments: [adjustment],
      sites: [{ id: 'site-a', name: '东区', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null }],
    })

    const attendanceIndex = buildAttendanceIndex(data.attendance)
    const payrollLookup = buildPayrollLookup(data)

    expect(attendanceIndex.get(workerDateKey(firstWorker.id, january.date))).toBe(january)
    expect(attendanceIndex.get(workerDateKey(firstWorker.id, '2026-01-04'))).toBeUndefined()
    expect(payrollLookup.attendanceByWorkerMonth.get(workerMonthKey(firstWorker.id, '2026-01'))).toEqual([january])
    expect(payrollLookup.adjustmentsByWorkerMonth.get(workerMonthKey(firstWorker.id, '2026-02'))).toEqual([adjustment])
    expect(payrollLookup.monthlyRecordByWorkerMonth.get(workerMonthKey(firstWorker.id, '2026-01'))).toBe(earlierRecord)
    expect(payrollLookup.monthlyRecordsByWorker.get(firstWorker.id)?.map((record) => record.month)).toEqual(['2026-01', '2026-08'])
    expect(data.monthlyRecords).toEqual([laterRecord, earlierRecord])
    expect(payrollLookup.siteNameById.get('site-a')).toBe('东区')
  })

  it('keeps optional lookup results equivalent while carrying settlement state', () => {
    const firstWorker = worker('worker-1')
    const paidAt = '2026-09-01T12:34:56.000Z'
    const data = appData({
      workers: [firstWorker],
      attendance: [
        {
          workerId: firstWorker.id,
          date: '2026-08-03',
          morning: 'present',
          afternoon: 'present',
          overtime: 'half',
          dayNote: '',
          morningSiteId: 'site-a',
          afternoonSiteId: null,
          overtimeSiteId: 'site-a',
        },
      ],
      monthlyRecords: [monthlyRecord(firstWorker.id, '2026-08', 30_001, paidAt)],
      payAdjustments: [
        {
          id: 'allowance-1',
          workerId: firstWorker.id,
          month: '2026-08',
          date: null,
          kind: 'allowance',
          amountFen: 1_234,
          label: '餐补',
          note: '',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      sites: [{ id: 'site-a', name: '东区', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null }],
    })
    const lookup = buildPayrollLookup(data)

    const compatible = calculateMonthlyPayroll({ data, worker: firstWorker, month: '2026-08' })
    const indexed = calculateMonthlyPayroll({ data, worker: firstWorker, month: '2026-08', lookup })

    expect(indexed).toEqual(compatible)
    expect(indexed).toMatchObject({
      dailyRateFen: 30_001,
      paidAt,
      hasMonthlyRecord: true,
      workDays: 1.5,
      basePayFen: 45_002,
      allowanceFen: 1_234,
      netPayFen: 46_236,
    })
  })
})

describe('large payroll lookup fixture', () => {
  it('reuses one lookup for annual calculations without touching source payroll arrays again', () => {
    const workers = Array.from({ length: 120 }, (_, index) => worker(`worker-${index + 1}`))
    const attendance: AttendanceEntry[] = []
    const monthlyRecords: MonthlyRecord[] = []
    const payAdjustments: PayAdjustment[] = []

    for (const [workerIndex, item] of workers.entries()) {
      monthlyRecords.push(
        monthlyRecord(item.id, '2026-01', 30_000 + workerIndex),
        monthlyRecord(item.id, '2026-07', 31_000 + workerIndex, workerIndex % 2 === 0 ? '2027-01-01T00:00:00.000Z' : null),
      )
      for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
        const month = `2026-${String(monthIndex + 1).padStart(2, '0')}`
        payAdjustments.push({
          id: `${item.id}-${month}`,
          workerId: item.id,
          month,
          date: null,
          kind: monthIndex % 2 === 0 ? 'allowance' : 'deduction',
          amountFen: 100 + monthIndex,
          label: '测试调整',
          note: '',
          createdAt: `${month}-01T00:00:00.000Z`,
          updatedAt: `${month}-01T00:00:00.000Z`,
        })
      }
      for (let dayIndex = 0; dayIndex < 365; dayIndex += 1) {
        const date = new Date(Date.UTC(2026, 0, dayIndex + 1)).toISOString().slice(0, 10)
        attendance.push({
          workerId: item.id,
          date,
          morning: 'present',
          afternoon: dayIndex % 2 === 0 ? 'present' : null,
          overtime: dayIndex % 7 === 0 ? 'full' : dayIndex % 5 === 0 ? 'half' : null,
          dayNote: '',
          morningSiteId: 'site-a',
          afternoonSiteId: dayIndex % 2 === 0 ? 'site-b' : null,
          overtimeSiteId: dayIndex % 7 === 0 || dayIndex % 5 === 0 ? 'site-a' : null,
        })
      }
    }

    const data = appData({
      workers,
      attendance,
      monthlyRecords,
      payAdjustments,
      sites: [
        { id: 'site-a', name: '东区', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
        { id: 'site-b', name: '西区', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
      ],
    })
    const lookup = buildPayrollLookup(data)

    expect(attendance).toHaveLength(43_800)
    expect(lookup.attendanceByWorkerMonth.size).toBe(1_440)
    expect(lookup.adjustmentsByWorkerMonth.size).toBe(1_440)
    expect(lookup.monthlyRecordByWorkerMonth.size).toBe(240)

    for (const item of [workers[0], workers[59], workers[119]]) {
      for (const month of ['2026-01', '2026-06', '2026-07', '2026-12']) {
        expect(calculateMonthlyPayroll({ data, worker: item, month, lookup })).toMatchObject(
          legacyMonthlySnapshot(data, item, month),
        )
      }
    }

    const guardedData = {
      ...data,
      attendance: undefined,
      monthlyRecords: undefined,
      payAdjustments: undefined,
      sites: undefined,
    } as unknown as AppData
    const annual = calculateYearlyPayroll({ data: guardedData, year: '2026', lookup })
    const payslip = buildPayslipData({ data: guardedData, worker: workers[0], month: '2026-07', lookup })

    expect(annual.rows).toHaveLength(120)
    expect(annual.rows[0].months).toHaveLength(12)
    expect(annual.rows[0].months[0]).toMatchObject({
      dailyRateFen: 30_000,
      hasMonthlyRecord: true,
      allowanceFen: 100,
      deductionFen: 0,
    })
    expect(annual.rows[0].months[6]).toMatchObject({
      dailyRateFen: 31_000,
      paidAt: '2027-01-01T00:00:00.000Z',
      allowanceFen: 106,
      deductionFen: 0,
    })
    expect(annual.totals.workDays).toBeGreaterThan(0)
    expect(annual.siteBreakdown.map((site) => site.siteId)).toEqual(['site-a', 'site-b'])
    expect(payslip).toMatchObject({
      paidAt: '2027-01-01T00:00:00.000Z',
      payroll: { dailyRateFen: 31_000 },
    })
  })
})
