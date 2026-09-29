import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SiteStatisticsView from '../src/components/SiteStatisticsView.vue'
import type {
  SiteStatisticsMetrics,
  SiteStatisticsSummary,
} from '../src/site-statistics'

function metrics(overrides: Partial<SiteStatisticsMetrics> = {}): SiteStatisticsMetrics {
  return {
    workerCount: 0,
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
    ...overrides,
  }
}

const summary: SiteStatisticsSummary = {
  period: { mode: 'month', month: '2026-08' },
  months: ['2026-08'],
  totals: metrics({
    workerCount: 2,
    personTimes: 5,
    morningHalfDays: 4,
    afternoonHalfDays: 2,
    overtimeHalfDays: 1,
    totalWorkHalfDays: 7,
    workDays: 3.5,
    paidLeaveHalfDays: 1,
    paidLeavePeriods: 1,
    unpaidLeavePeriods: 2,
    basePayFen: 100_001,
    allowanceFen: 800,
    deductionFen: 300,
    netCostFen: 100_501,
  }),
  rows: [
    {
      key: 'site:archived',
      bucketKind: 'site',
      siteId: 'archived',
      siteName: '旧工地',
      archived: true,
      ...metrics({
        workerCount: 1,
        personTimes: 2,
        morningHalfDays: 2,
        totalWorkHalfDays: 2,
        workDays: 1,
        basePayFen: 30_000,
        netCostFen: 30_000,
      }),
      workers: [{
        workerId: 'worker-a',
        workerName: '甲师傅',
        personTimes: 2,
        morningHalfDays: 2,
        afternoonHalfDays: 0,
        overtimeHalfDays: 0,
        totalWorkHalfDays: 2,
        workDays: 1,
        paidLeaveHalfDays: 0,
        unpaidLeaveHalfDays: 0,
        paidLeavePeriods: 0,
        unpaidLeavePeriods: 0,
        basePayFen: 30_000,
        allowanceFen: 0,
        deductionFen: 0,
        netCostFen: 30_000,
      }],
    },
    {
      key: 'paid-leave',
      bucketKind: 'paid-leave',
      siteId: null,
      siteName: '带薪假（未归属工地）',
      archived: false,
      ...metrics({
        paidLeaveHalfDays: 1,
        paidLeavePeriods: 1,
        basePayFen: 15_001,
        netCostFen: 15_001,
      }),
      workers: [{
        workerId: 'worker-b',
        workerName: '乙师傅',
        personTimes: 0,
        morningHalfDays: 0,
        afternoonHalfDays: 0,
        overtimeHalfDays: 0,
        totalWorkHalfDays: 0,
        workDays: 0,
        paidLeaveHalfDays: 1,
        unpaidLeaveHalfDays: 0,
        paidLeavePeriods: 1,
        unpaidLeavePeriods: 0,
        basePayFen: 15_001,
        allowanceFen: 0,
        deductionFen: 0,
        netCostFen: 15_001,
      }],
    },
  ],
  lines: [],
}

describe('SiteStatisticsView', () => {
  it('renders clear totals, archived/special buckets and expandable worker details', async () => {
    const wrapper = mount(SiteStatisticsView, {
      props: {
        summary,
        mode: 'month',
        selectedMonth: '2026-08',
        selectedYear: '2026',
      },
    })

    expect(wrapper.get('h2').text()).toBe('2026年8月工地统计')
    expect(wrapper.find('.site-statistics-cards').text()).toContain('2 人')
    expect(wrapper.find('.site-statistics-cards').text()).toContain('5 人次')
    expect(wrapper.find('.site-statistics-cards').text()).toContain('3.5 工')
    expect(wrapper.find('.site-statistics-cards').text()).toContain('带薪 1 / 无薪 2')
    expect(wrapper.findAll('.bucket-badge').map((badge) => badge.text())).toEqual(expect.arrayContaining([
      '实际工地', '已归档', '带薪假',
    ]))
    expect(wrapper.text()).not.toContain('甲师傅')

    const expand = wrapper.findAll('.expand-button')[0]
    expect(expand.attributes('aria-expanded')).toBe('false')
    await expand.trigger('click')
    expect(expand.attributes('aria-expanded')).toBe('true')
    expect(wrapper.text()).toContain('甲师傅')
    expect(wrapper.find('.site-worker-card').text()).toContain('2 人次 · 1 工')
    expect(wrapper.find('.site-worker-card').text()).toContain('¥300.00')

    await expand.trigger('click')
    expect(wrapper.text()).not.toContain('甲师傅')
  })

  it('keeps all period changes controlled by props and emits navigation/current/export intents', async () => {
    const wrapper = mount(SiteStatisticsView, {
      props: {
        summary,
        mode: 'month',
        selectedMonth: '2026-08',
        selectedYear: '2026',
      },
    })

    await wrapper.get('[aria-label="上一个统计周期"]').trigger('click')
    await wrapper.get('[aria-label="下一个统计周期"]').trigger('click')
    expect(wrapper.emitted('update:selectedMonth')).toEqual([['2026-07'], ['2026-09']])
    expect(wrapper.props('selectedMonth')).toBe('2026-08')

    await wrapper.get('[aria-label="统计月份"]').setValue('2026-10')
    expect(wrapper.emitted('update:selectedMonth')?.at(-1)).toEqual(['2026-10'])
    await wrapper.findAll('.site-statistics-mode button')[1].trigger('click')
    expect(wrapper.emitted('update:mode')).toEqual([['year']])
    await wrapper.get('.current-period-button').trigger('click')
    await wrapper.get('.site-statistics-export').trigger('click')
    expect(wrapper.emitted('current-period')).toHaveLength(1)
    expect(wrapper.emitted('export')).toHaveLength(1)

    await wrapper.setProps({ mode: 'year', selectedYear: '2026' })
    await wrapper.get('[aria-label="上一个统计周期"]').trigger('click')
    await wrapper.get('[aria-label="下一个统计周期"]').trigger('click')
    expect(wrapper.emitted('update:selectedYear')).toEqual([['2025'], ['2027']])
    await wrapper.get('[aria-label="统计年份"]').setValue('2028')
    expect(wrapper.emitted('update:selectedYear')?.at(-1)).toEqual(['2028'])
  })

  it('separates loading and empty states and disables export without a summary', async () => {
    const wrapper = mount(SiteStatisticsView, {
      props: {
        summary: null,
        mode: 'month',
        selectedMonth: '2026-08',
        selectedYear: '2026',
        loading: true,
      },
    })

    expect(wrapper.get('[role="status"]').text()).toContain('正在计算')
    expect(wrapper.get('.site-statistics-export').attributes()).toHaveProperty('disabled')
    await wrapper.setProps({ loading: false })
    expect(wrapper.get('[role="status"]').text()).toContain('没有工地、请假或调整数据')
  })
})
