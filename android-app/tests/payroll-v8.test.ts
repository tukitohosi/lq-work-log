import { describe, expect, it } from 'vitest'
import { buildMonthlyCompensationLedger } from '../src/compensation-ledger'
import { calculateMonthlyPayroll, resolveDailyRate } from '../src/payroll'
import type { AppData, Worker } from '../src/types'

const worker: Worker = {
  id: 'worker-a',
  name: '甲师傅',
  avatarDataUrl: null,
  avatarEmoji: null,
  defaultDailyRateFen: 10_001,
  note: '',
  defaultSiteId: 'site-a',
  createdAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
}

const data: AppData = {
  schemaVersion: 8,
  revision: 1,
  workers: [worker],
  attendance: [
    {
      workerId: worker.id,
      date: '2026-08-01',
      morning: 'present',
      afternoon: 'present',
      overtime: 'full',
      dayNote: '',
      morningSiteId: 'site-a',
      afternoonSiteId: 'site-a',
      overtimeSiteId: 'site-b',
      morningLeave: null,
      afternoonLeave: null,
      overtimeLeave: null,
    },
    {
      workerId: worker.id,
      date: '2026-08-02',
      morning: 'present',
      afternoon: 'present',
      overtime: 'full',
      dayNote: '',
      morningSiteId: 'site-a',
      afternoonSiteId: 'site-b',
      overtimeSiteId: 'site-b',
      morningLeave: null,
      afternoonLeave: { payType: 'paid' },
      overtimeLeave: { payType: 'paid', units: 'half' },
    },
    {
      workerId: worker.id,
      date: '2026-08-03',
      morning: 'present',
      afternoon: 'present',
      overtime: null,
      dayNote: '',
      morningSiteId: 'site-a',
      afternoonSiteId: 'site-b',
      overtimeSiteId: null,
      morningLeave: { payType: 'unpaid' },
      afternoonLeave: null,
      overtimeLeave: { payType: 'unpaid' },
    },
  ],
  monthlyRecords: [
    { workerId: worker.id, month: '2026-01', dailyRateFen: 11_000, overtimePayPercent: 100, note: '', paidAt: null },
    { workerId: worker.id, month: '2026-07', dailyRateFen: 10_001, overtimePayPercent: 100, note: '', paidAt: null },
    { workerId: worker.id, month: '2026-08', dailyRateFen: 10_001, overtimePayPercent: 150, note: '', paidAt: null },
  ],
  payAdjustments: [
    { id: 'allowance', workerId: worker.id, month: '2026-08', date: '2026-08-02', kind: 'allowance', amountFen: 101, label: '餐补', note: '', siteId: 'site-a', createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' },
    { id: 'deduction', workerId: worker.id, month: '2026-08', date: null, kind: 'deduction', amountFen: 51, label: '借支', note: '', siteId: null, createdAt: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-03T00:00:00.000Z' },
  ],
  sites: [
    { id: 'site-a', name: '东区', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
    { id: 'site-b', name: '西区', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
  ],
  settings: {
    weekStartsOn: 6,
    currentWorkerId: worker.id,
    theme: 'light',
    sidebarCollapsed: false,
    lastBackupExportAt: null,
    lastBackupReminderAt: null,
    weeklyAutoBackupEnabled: true,
    lastWeeklyBackupAt: null,
    defaultOvertimePayPercent: 100,
  },
}

describe('v8 compensation ledger', () => {
  it('pays leave without counting it as actual work and lets leave win malformed conflicts', () => {
    const ledger = buildMonthlyCompensationLedger({ data, worker, month: '2026-08' })
    const payroll = calculateMonthlyPayroll({ data, worker, month: '2026-08' })

    expect(ledger).toMatchObject({
      dailyRateFen: 10_001,
      dailyRateSourceMonth: '2026-08',
      overtimePayPercent: 150,
      actualWorkHalfDays: 6,
      paidLeaveHalfDays: 2,
      unpaidLeaveHalfDays: 1,
      paidLeavePeriods: 2,
      unpaidLeavePeriods: 2,
      basePayFen: 47_505,
      allowanceFen: 101,
      deductionFen: 51,
      netPayFen: 47_555,
    })
    expect(ledger.lines.reduce((sum, line) => sum + line.amountFen, 0)).toBe(ledger.netPayFen)
    expect(ledger.lines.filter((line) => line.kind === 'paid-leave')).toHaveLength(2)
    expect(ledger.lines.some((line) => line.date === '2026-08-02' && line.period === 'afternoon' && line.kind === 'ordinary-work')).toBe(false)
    expect(ledger.lines.some((line) => line.date === '2026-08-03' && line.period === 'morning' && line.kind === 'ordinary-work')).toBe(false)

    expect(payroll).toMatchObject({
      morningCount: 2,
      afternoonCount: 2,
      overtimeHalfDays: 2,
      totalHalfDays: 6,
      workDays: 3,
      paidLeaveHalfDays: 2,
      unpaidLeavePeriods: 2,
      basePayFen: 47_505,
      netPayFen: 47_555,
    })
    expect(payroll.siteBreakdown.map((row) => [row.siteId, row.totalHalfDays])).toEqual([
      ['site-a', 3],
      ['site-b', 3],
    ])
  })

  it('allocates half-cent ties deterministically and reconciles every cent', () => {
    const oneFenWorker = { ...worker, defaultDailyRateFen: 1 }
    const oneFenData: AppData = {
      ...data,
      workers: [oneFenWorker],
      attendance: [{
        workerId: oneFenWorker.id,
        date: '2026-09-01',
        morning: 'present',
        afternoon: 'present',
        overtime: null,
        dayNote: '',
        morningSiteId: 'site-a',
        afternoonSiteId: 'site-b',
        overtimeSiteId: null,
        morningLeave: null,
        afternoonLeave: null,
        overtimeLeave: null,
      }],
      monthlyRecords: [],
      payAdjustments: [],
    }
    const first = buildMonthlyCompensationLedger({ data: oneFenData, worker: oneFenWorker, month: '2026-09' })
    const second = buildMonthlyCompensationLedger({ data: oneFenData, worker: oneFenWorker, month: '2026-09' })

    expect(first.basePayFen).toBe(1)
    expect(first.lines.filter((line) => line.kind === 'ordinary-work').map((line) => line.amountFen)).toEqual([1, 0])
    expect(second.lines).toEqual(first.lines)
  })

  it('returns both the effective rate and the month that introduced it', () => {
    expect(resolveDailyRate(data, worker, '2026-06')).toEqual({ rateFen: 11_000, sourceMonth: '2026-01' })
    expect(resolveDailyRate(data, worker, '2026-07')).toEqual({ rateFen: 10_001, sourceMonth: '2026-07' })
    expect(resolveDailyRate({ ...data, monthlyRecords: [] }, worker, '2026-08')).toEqual({ rateFen: 10_001, sourceMonth: null })
  })
})
