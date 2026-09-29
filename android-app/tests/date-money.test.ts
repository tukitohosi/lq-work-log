import { describe, expect, it } from 'vitest'
import {
  isValidIsoDate,
  monthWeeks,
  shiftMonth,
  weekdayLabels,
} from '../src/date'
import { fenToCurrency, fenToInput, parseYuanToFen } from '../src/money'
import { buildPayslipData, calculateMonthlyPayroll, calculateYearlyPayroll } from '../src/payroll'
import type { AppData, Worker } from '../src/types'

describe('month calendar calculations', () => {
  it('lays August 2026 out in UTC from Saturday through Friday', () => {
    const weeks = monthWeeks('2026-08', 6, '2026-08-08')

    expect(weekdayLabels(6)).toEqual(['六', '日', '一', '二', '三', '四', '五'])
    expect(weeks).toHaveLength(5)
    expect(weeks[0].days.map((cell) => cell.iso)).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
    ])
    expect(weeks[1].days[0]).toMatchObject({
      iso: '2026-08-08',
      day: 8,
      isToday: true,
      isWeekend: true,
    })
    expect(weeks.at(-1)?.days.map((cell) => cell.day)).toEqual([29, 30, 31, null, null, null, null])
  })

  it('keeps leading blanks when Monday or Sunday is the first column', () => {
    const mondayFirst = monthWeeks('2026-08', 1, '1900-01-01')
    const sundayFirst = monthWeeks('2026-08', 0, '1900-01-01')

    expect(weekdayLabels(1)).toEqual(['一', '二', '三', '四', '五', '六', '日'])
    expect(mondayFirst[0].days.map((cell) => cell.day)).toEqual([null, null, null, null, null, 1, 2])
    expect(weekdayLabels(0)).toEqual(['日', '一', '二', '三', '四', '五', '六'])
    expect(sundayFirst[0].days.map((cell) => cell.day)).toEqual([null, null, null, null, null, null, 1])
  })

  it('handles leap years and month shifts across year boundaries', () => {
    const leapFebruary = monthWeeks('2024-02', 6, '1900-01-01')
    const ordinaryFebruary = monthWeeks('2025-02', 6, '1900-01-01')

    expect(leapFebruary.flatMap((week) => week.days).filter((cell) => cell.iso)).toHaveLength(29)
    expect(ordinaryFebruary.flatMap((week) => week.days).filter((cell) => cell.iso)).toHaveLength(28)
    expect(isValidIsoDate('2024-02-29')).toBe(true)
    expect(isValidIsoDate('2025-02-29')).toBe(false)
    expect(shiftMonth('2025-12', 1)).toBe('2026-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  })
})

describe('money calculations and input conversion', () => {
  it('stores yuan inputs as an integer number of fen', () => {
    expect(parseYuanToFen('300')).toBe(30_000)
    expect(parseYuanToFen(' ￥1,234.5 ')).toBe(123_450)
    expect(parseYuanToFen('12.345')).toBeNull()
    expect(parseYuanToFen('-1')).toBeNull()
    expect(fenToInput(30_001)).toBe('300.01')
  })

  it('rounds expected wages to the nearest fen after multiplying half-days', () => {
    const dailyRateFen = 30_001
    const completedHalfDays = 3
    const expectedPayFen = Math.round((dailyRateFen * completedHalfDays) / 2)

    expect(expectedPayFen).toBe(45_002)
    expect(fenToCurrency(expectedPayFen)).toContain('450.02')
  })
})

describe('shared payroll calculations', () => {
  const worker: Worker = {
    id: 'worker-1',
    name: '李权',
    avatarDataUrl: null,
    avatarEmoji: null,
    defaultDailyRateFen: 30_001,
    note: '',
    defaultSiteId: 'site-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
  }
  const data: AppData = {
    schemaVersion: 7,
    revision: 1,
    workers: [worker],
    attendance: [
      {
        workerId: worker.id,
        date: '2026-08-01',
        morning: 'present',
        afternoon: 'absent',
        overtime: 'half',
        dayNote: '',
        morningSiteId: 'site-a',
        afternoonSiteId: null,
        overtimeSiteId: 'site-b',
      },
      {
        workerId: worker.id,
        date: '2026-08-02',
        morning: 'present',
        afternoon: 'present',
        overtime: 'full',
        dayNote: '',
        morningSiteId: 'site-a',
        afternoonSiteId: null,
        overtimeSiteId: 'site-b',
      },
    ],
    monthlyRecords: [{ workerId: worker.id, month: '2026-08', dailyRateFen: 30_001, overtimePayPercent: 100, note: '', paidAt: '2026-09-01T00:00:00.000Z' }],
    payAdjustments: [
      { id: 'a', workerId: worker.id, month: '2026-08', date: '2026-08-01', kind: 'allowance', amountFen: 1_234, label: '餐补', note: '', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'b', workerId: worker.id, month: '2026-08', date: null, kind: 'deduction', amountFen: 100_000, label: '借支', note: '', createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' },
    ],
    sites: [
      { id: 'site-a', name: '东区', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
      { id: 'site-b', name: '西区', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
    ],
    settings: { weekStartsOn: 6, currentWorkerId: worker.id, theme: 'light', sidebarCollapsed: false, lastBackupExportAt: null, lastBackupReminderAt: null, weeklyAutoBackupEnabled: true, lastWeeklyBackupAt: null, defaultOvertimePayPercent: 100 },
  }

  it('calculates cents, adjustments, negative net pay and site work units once', () => {
    const payroll = calculateMonthlyPayroll({ data, worker, month: '2026-08' })

    expect(payroll).toMatchObject({
      morningCount: 2,
      afternoonCount: 1,
      overtimeHalfDays: 3,
      totalHalfDays: 6,
      workDays: 3,
      overtimePayPercent: 100,
      basePayFen: 90_003,
      allowanceFen: 1_234,
      deductionFen: 100_000,
      netPayFen: -8_763,
      paidAt: '2026-09-01T00:00:00.000Z',
    })
    expect(payroll.siteBreakdown).toEqual([
      expect.objectContaining({ siteId: 'site-a', siteName: '东区', totalHalfDays: 2, workDays: 1 }),
      expect.objectContaining({ siteId: 'site-b', siteName: '西区', totalHalfDays: 3, workDays: 1.5 }),
      expect.objectContaining({ siteId: null, siteName: '未分配', totalHalfDays: 1, workDays: 0.5 }),
    ])
  })

  it('weights only overtime pay while leaving reported work units unchanged', () => {
    const weightedData: AppData = {
      ...data,
      monthlyRecords: data.monthlyRecords.map((record) => ({
        ...record,
        overtimePayPercent: 150,
      })),
    }

    const payroll = calculateMonthlyPayroll({ data: weightedData, worker, month: '2026-08' })

    expect(payroll).toMatchObject({
      morningCount: 2,
      afternoonCount: 1,
      overtimeHalfDays: 3,
      totalHalfDays: 6,
      workDays: 3,
      overtimePayPercent: 150,
      basePayFen: 112_504,
    })
  })

  it('builds annual rows and payslip data from the same monthly source of truth', () => {
    const annual = calculateYearlyPayroll({ data, year: '2026' })
    const payslip = buildPayslipData({ data, worker, month: '2026-08' })

    expect(annual.months).toHaveLength(12)
    expect(annual.rows).toHaveLength(1)
    expect(annual.rows[0].months[7].netPayFen).toBe(-8_763)
    expect(annual.totals).toMatchObject({ workDays: 3, basePayFen: 90_003, netPayFen: -8_763 })
    expect(payslip).toMatchObject({ paidAt: '2026-09-01T00:00:00.000Z', ordinaryWorkDays: 1.5, overtimeWorkDays: 1.5 })
    expect(payslip.adjustments.map((item) => item.label)).toEqual(['餐补', '借支'])
  })

  it('keeps stable adjustment order when more than one item has no date', () => {
    const undated = data.payAdjustments.map((item, index) => ({
      ...item,
      date: null,
      createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
    }))
    const payslip = buildPayslipData({ data: { ...data, payAdjustments: undated }, worker, month: '2026-08' })

    expect(payslip.adjustments.map((item) => item.label)).toEqual(['餐补', '借支'])
  })

  it('filters annual rows by worker and default site and carries forward the latest rate', () => {
    const otherWorker: Worker = { ...worker, id: 'worker-2', name: '王师傅', defaultSiteId: null }
    const filteredData: AppData = {
      ...data,
      workers: [worker, otherWorker],
      monthlyRecords: [
        { workerId: worker.id, month: '2026-01', dailyRateFen: 32_000, overtimePayPercent: 100, note: '', paidAt: null },
        { workerId: worker.id, month: '2026-07', dailyRateFen: 33_000, overtimePayPercent: 100, note: '', paidAt: null },
      ],
    }

    const annual = calculateYearlyPayroll({ data: filteredData, year: '2026', workerIds: [worker.id], defaultSiteIds: ['site-a'] })

    expect(annual.rows.map((row) => row.worker.id)).toEqual([worker.id])
    expect(annual.rows[0].months[7].dailyRateFen).toBe(33_000)
  })
})
