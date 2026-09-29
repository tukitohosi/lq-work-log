import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DailyView from '../src/components/DailyView.vue'
import AnnualView from '../src/components/AnnualView.vue'
import SiteStatisticsView from '../src/components/SiteStatisticsView.vue'
import { calculateYearlyPayroll } from '../src/payroll'
import { calculateSiteStatistics } from '../src/site-statistics'
import type { AppData, AttendancePeriod } from '../src/types'

function fixture(): AppData {
  return {
    schemaVersion: 8, revision: 1,
    workers: [{ id: 'w', name: '手机测试工人', avatarDataUrl: null, avatarEmoji: null, defaultDailyRateFen: 30000, note: '', defaultSiteId: 's', createdAt: '2026-01-01T00:00:00Z', archivedAt: null }],
    sites: [{ id: 's', name: '手机测试工地', note: '', createdAt: '2026-01-01T00:00:00Z', archivedAt: null }],
    attendance: [{ workerId: 'w', date: '2026-09-01', morning: 'present', afternoon: null, overtime: 'half', morningSiteId: 's', afternoonSiteId: null, overtimeSiteId: 's', morningLeave: null, afternoonLeave: { payType: 'paid' }, overtimeLeave: null, dayNote: '测试备注' }],
    monthlyRecords: [{ workerId: 'w', month: '2026-09', dailyRateFen: 30000, overtimePayPercent: 150, note: '', paidAt: null }],
    payAdjustments: [{ id: 'a', workerId: 'w', month: '2026-09', date: '2026-09-01', kind: 'deduction', amountFen: 500, label: '测试扣款', note: '', siteId: 's', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }],
    settings: { weekStartsOn: 1, currentWorkerId: 'w', theme: 'light', sidebarCollapsed: false, lastBackupExportAt: null, lastBackupReminderAt: null, weeklyAutoBackupEnabled: false, lastWeeklyBackupAt: null, defaultOvertimePayPercent: 100 },
  }
}

function daily(data = fixture()) {
  const entry = data.attendance[0]
  return mount(DailyView, { props: {
    data, selectedDate: entry.date, futureDate: false, siteFilter: 'all', groups: [], totals: { people: 1, halfDays: 2, workDays: 1 }, workers: data.workers,
    failedCellKeys: new Set<string>(), failedDateKeys: new Set<string>(), attendanceFor: () => entry,
    statusValue: (_worker: string, _date: string, period: AttendancePeriod) => entry[period],
    leaveValue: (_worker: string, _date: string, period: AttendancePeriod) => period === 'afternoon' ? entry.afternoonLeave! : null,
    selectableSitesFor: () => data.sites, dailyAdjustments: () => data.payAdjustments,
  } })
}

describe('phone report views', () => {
  it('routes phone attendance, leave, site, note and adjustment actions to existing saves', async () => {
    const wrapper = daily()
    const phone = wrapper.get('.mobile-worker-cards')
    const periods = phone.findAll('.mobile-daily-period')
    await periods[0].get('.mobile-status-button').trigger('click')
    expect(wrapper.emitted('cycle')).toEqual([['w', '2026-09-01', 'morning']])
    await periods[1].get('.mobile-status-button').trigger('click')
    expect(wrapper.emitted('leave')).toEqual([['w', '2026-09-01', 'afternoon']])
    expect(periods[1].get('[aria-label="手机测试工人下午清空"]').attributes()).toHaveProperty('disabled')
    await periods[0].get('select').setValue('')
    expect(wrapper.emitted('update-site')).toEqual([['w', '2026-09-01', 'morning', '']])
    await phone.get('textarea').setValue('手机备注')
    await phone.get('textarea').trigger('blur')
    expect(wrapper.emitted('save-note')).toEqual([['w', '2026-09-01', '手机备注']])
    await phone.get('.mobile-daily-adjustments .link-button').trigger('click')
    expect(wrapper.emitted('edit-adjustment')?.[0][1]).toBe('w')
    expect(wrapper.find('.desktop-table .daily-table').exists()).toBe(true)
  })

  it('keeps archived worker phone cards read-only', async () => {
    const data = fixture()
    data.workers[0].archivedAt = '2026-09-02T00:00:00Z'
    const wrapper = daily(data)
    const phone = wrapper.get('.mobile-worker-cards')
    expect(phone.text()).toContain('已归档 · 只读')
    for (const field of phone.findAll('.mobile-daily-period button, select, textarea')) expect(field.attributes()).toHaveProperty('disabled')
    await phone.get('.mobile-status-button').trigger('click')
    expect(wrapper.emitted('cycle')).toBeUndefined()
  })

  it('preserves all twelve months, amounts and overtime multiplier in annual cards', () => {
    const data = fixture()
    const summary = calculateYearlyPayroll({ data, year: '2026' })
    const wrapper = mount(AnnualView, { props: { data, summary, selectedYear: '2026', workerFilter: 'all', siteFilter: 'all', paidFilter: 'all', metric: 'work' } })
    const phone = wrapper.get('.mobile-annual-list')
    expect(phone.findAll('.mobile-annual-months > li')).toHaveLength(12)
    expect(phone.text()).toContain('手机测试工人')
    const september = phone.findAll('.mobile-annual-months > li')[8]
    expect(september.text()).toContain('¥520.00')
    expect(september.text()).toContain('1.5 倍')
    expect(september.text()).toContain('¥5.00')
    expect(wrapper.find('.desktop-table .annual-table').exists()).toBe(true)
  })

  it('expands actual site worker costs on the phone while preserving report table data', async () => {
    const data = fixture()
    const summary = calculateSiteStatistics({ data, period: { mode: 'month', month: '2026-09' } })
    const wrapper = mount(SiteStatisticsView, { props: { summary, mode: 'month', selectedMonth: '2026-09', selectedYear: '2026' } })
    const card = wrapper.findAll('.mobile-site-card').find(item => item.text().includes('手机测试工地'))!
    expect(card.find('.site-worker-card').exists()).toBe(false)
    await card.get('.mobile-site-toggle').trigger('click')
    expect(card.get('.mobile-site-toggle').attributes('aria-expanded')).toBe('true')
    expect(card.get('.site-worker-card').text()).toContain('手机测试工人')
    expect(card.get('.site-worker-card').text()).toContain('¥370.00')
    expect(wrapper.find('.desktop-table .site-statistics-table').exists()).toBe(true)
    await card.get('.mobile-site-toggle').trigger('click')
    expect(card.find('.site-worker-card').exists()).toBe(false)
  })
})
