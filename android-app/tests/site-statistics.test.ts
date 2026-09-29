import { describe, expect, it } from 'vitest'
import { calculateMonthlyPayroll } from '../src/payroll'
import { calculateSiteStatistics } from '../src/site-statistics'
import type { AppData, Worker } from '../src/types'

const first: Worker = {
  id: 'worker-a', name: '甲师傅', avatarDataUrl: null, avatarEmoji: null,
  defaultDailyRateFen: 30_001, note: '', defaultSiteId: 'site-a',
  createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null,
}
const second: Worker = {
  ...first,
  id: 'worker-b',
  name: '乙师傅',
  defaultDailyRateFen: 20_000,
}

const data: AppData = {
  schemaVersion: 8,
  revision: 1,
  workers: [first, second],
  attendance: [
    {
      workerId: first.id, date: '2026-08-01', morning: 'present', afternoon: 'present', overtime: 'half', dayNote: '',
      morningSiteId: 'site-a', afternoonSiteId: 'site-a', overtimeSiteId: 'site-b',
      morningLeave: null, afternoonLeave: null, overtimeLeave: null,
    },
    {
      workerId: first.id, date: '2026-08-02', morning: 'absent', afternoon: null, overtime: null, dayNote: '',
      morningSiteId: null, afternoonSiteId: null, overtimeSiteId: null,
      morningLeave: null, afternoonLeave: { payType: 'paid' }, overtimeLeave: null,
    },
    {
      workerId: second.id, date: '2026-08-01', morning: 'present', afternoon: 'present', overtime: 'full', dayNote: '',
      morningSiteId: 'site-a', afternoonSiteId: 'site-a', overtimeSiteId: null,
      morningLeave: null, afternoonLeave: null, overtimeLeave: null,
    },
    {
      workerId: second.id, date: '2026-09-01', morning: 'present', afternoon: null, overtime: null, dayNote: '',
      morningSiteId: 'site-b', afternoonSiteId: null, overtimeSiteId: null,
      morningLeave: null, afternoonLeave: null, overtimeLeave: null,
    },
  ],
  monthlyRecords: [
    { workerId: first.id, month: '2026-08', dailyRateFen: 30_001, overtimePayPercent: 100, note: '', paidAt: null },
    { workerId: second.id, month: '2026-09', dailyRateFen: 25_000, overtimePayPercent: 100, note: '', paidAt: null },
  ],
  payAdjustments: [
    { id: 'site-allowance', workerId: first.id, month: '2026-08', date: '2026-08-01', kind: 'allowance', amountFen: 500, label: '工地补贴', note: '', siteId: 'site-a', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'unassigned-deduction', workerId: second.id, month: '2026-08', date: null, kind: 'deduction', amountFen: 200, label: '借支', note: '', siteId: null, createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' },
  ],
  sites: [
    { id: 'site-a', name: '东区', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
    { id: 'site-b', name: '西区', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: '2026-10-01T00:00:00.000Z' },
  ],
  settings: {
    weekStartsOn: 6, currentWorkerId: first.id, theme: 'light', sidebarCollapsed: false,
    lastBackupExportAt: null, lastBackupReminderAt: null, weeklyAutoBackupEnabled: true,
    lastWeeklyBackupAt: null, defaultOvertimePayPercent: 100,
  },
}

describe('site statistics', () => {
  it('counts people and person-times only from actual work and reconciles complete costs', () => {
    const result = calculateSiteStatistics({ data, period: { mode: 'month', month: '2026-08' } })
    const east = result.rows.find((row) => row.siteId === 'site-a')
    const west = result.rows.find((row) => row.siteId === 'site-b')
    const unassignedWork = result.rows.find((row) => row.bucketKind === 'unassigned-work')
    const paidLeave = result.rows.find((row) => row.bucketKind === 'paid-leave')
    const unassignedAdjustment = result.rows.find((row) => row.bucketKind === 'unassigned-adjustment')
    const payrollTotal = [first, second]
      .map((worker) => calculateMonthlyPayroll({ data, worker, month: '2026-08' }).netPayFen)
      .reduce((sum, amount) => sum + amount, 0)

    expect(east).toMatchObject({
      siteName: '东区', workerCount: 2, personTimes: 2,
      morningHalfDays: 2, afternoonHalfDays: 2, totalWorkHalfDays: 4,
      allowanceFen: 500,
    })
    expect(west).toMatchObject({
      siteName: '西区', archived: true, workerCount: 1, personTimes: 1,
      overtimeHalfDays: 1,
    })
    expect(unassignedWork).toMatchObject({ workerCount: 1, personTimes: 1, overtimeHalfDays: 2 })
    expect(paidLeave).toMatchObject({ workerCount: 0, personTimes: 0, paidLeaveHalfDays: 1 })
    expect(unassignedAdjustment).toMatchObject({ workerCount: 0, personTimes: 0, deductionFen: 200, netCostFen: -200 })
    expect(result.totals).toMatchObject({ workerCount: 2, personTimes: 4, totalWorkHalfDays: 7 })
    expect(result.totals.netCostFen).toBe(payrollTotal)
    expect(result.rows.reduce((sum, row) => sum + row.netCostFen, 0)).toBe(payrollTotal)
    expect(result.rows.reduce((sum, row) => sum + row.basePayFen, 0)).toBe(result.totals.basePayFen)
  })

  it('uses each month effective rate in annual statistics and filters workers without rescanning sites', () => {
    const annual = calculateSiteStatistics({
      data,
      period: { mode: 'year', year: '2026' },
      workerIds: [second.id],
      includeEmptySites: true,
    })
    const september = calculateMonthlyPayroll({ data, worker: second, month: '2026-09' })
    const august = calculateMonthlyPayroll({ data, worker: second, month: '2026-08' })

    expect(annual.months).toHaveLength(12)
    expect(annual.lines.every((line) => line.workerId === second.id)).toBe(true)
    expect(annual.totals.netCostFen).toBe(august.netPayFen + september.netPayFen)
    expect(annual.rows.some((row) => row.siteId === 'site-a')).toBe(true)
    expect(annual.rows.some((row) => row.siteId === 'site-b' && row.archived)).toBe(true)
  })
})
