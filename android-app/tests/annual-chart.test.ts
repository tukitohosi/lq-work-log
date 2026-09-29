import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import {
  annualChartTooltipPlacement,
  buildAnnualChartModel,
  formatAnnualChartValue,
} from '../src/annual-chart'
import AnnualBarChart from '../src/components/AnnualBarChart.vue'
import type { AnnualPayrollSummary, AnnualWorkerPayrollRow, MonthlyPayrollSummary, PayrollTotals } from '../src/payroll'

const emptyTotals = (): PayrollTotals => ({
  morningCount: 0,
  afternoonCount: 0,
  overtimeHalfDays: 0,
  totalHalfDays: 0,
  workDays: 0,
  basePayFen: 0,
  allowanceFen: 0,
  deductionFen: 0,
  netPayFen: 0,
})

function monthly(month: string, workDays: number, netPayFen: number): MonthlyPayrollSummary {
  return {
    ...emptyTotals(),
    workerId: 'worker-a',
    month,
    dailyRateFen: 20_000,
    overtimePayPercent: 100,
    paidAt: null,
    hasMonthlyRecord: true,
    workDays,
    totalHalfDays: workDays * 2,
    netPayFen,
    siteBreakdown: [],
  }
}

function summary(values: Array<{ work: number; pay: number }>): AnnualPayrollSummary {
  const months = Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`)
  const row: AnnualWorkerPayrollRow = {
    worker: {
      id: 'worker-a',
      name: '张三',
      avatarDataUrl: null,
      avatarEmoji: null,
      defaultDailyRateFen: 20_000,
      note: '',
      defaultSiteId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    },
    months: months.map((month, index) => monthly(month, values[index]?.work ?? 0, values[index]?.pay ?? 0)),
    totals: emptyTotals(),
    siteBreakdown: [],
  }
  return { year: '2026', months, rows: [row], totals: emptyTotals(), siteBreakdown: [] }
}

describe('buildAnnualChartModel', () => {
  it('aggregates twelve monthly work values into fixed bar geometry', () => {
    const model = buildAnnualChartModel(summary([{ work: 2.5, pay: 50_000 }, { work: 4, pay: 80_000 }]), 'work')
    expect(model.hasData).toBe(true)
    expect(model.points).toHaveLength(12)
    expect(model.points[0]).toMatchObject({
      month: '2026-01',
      label: '1月',
      value: 2.5,
      workDays: 2.5,
      netPayFen: 50_000,
      formattedWorkDays: '2.5工',
      formattedNetPay: '¥500',
      accessibleLabel: '1月：工数 2.5工，实发 ¥500',
      negative: false,
    })
    expect(model.points[1].height).toBeGreaterThan(model.points[0].height)
    expect(model.zeroY).toBeCloseTo(model.plotBottom)
  })

  it('places negative and positive pay bars on opposite sides of a zero baseline', () => {
    const model = buildAnnualChartModel(summary([
      { work: 1, pay: 25_000 },
      { work: 1, pay: -10_000 },
    ]), 'pay')
    const positive = model.points[0]
    const negative = model.points[1]

    expect(model.domainMin).toBe(-10_000)
    expect(model.domainMax).toBe(25_000)
    expect(positive.y).toBeLessThan(model.zeroY)
    expect(positive.y + positive.height).toBeCloseTo(model.zeroY)
    expect(negative.y).toBeCloseTo(model.zeroY)
    expect(negative.y + negative.height).toBeGreaterThan(model.zeroY)
    expect(model.ticks.some((tick) => tick.value === 0)).toBe(true)
  })

  it('returns an accessible empty model without invalid coordinates', () => {
    const model = buildAnnualChartModel(null, 'pay')
    expect(model.hasData).toBe(false)
    expect(model.points).toEqual([])
    expect(Number.isFinite(model.zeroY)).toBe(true)
    expect(model.description).toContain('暂无可绘制的数据')
  })

  it('formats work and negative pay values for labels and descriptions', () => {
    expect(formatAnnualChartValue(2.5, 'work')).toBe('2.5工')
    expect(formatAnnualChartValue(-12_345, 'pay')).toBe('-¥123.45')
  })

  it('anchors tooltips to positive and negative bar ends', () => {
    const model = buildAnnualChartModel(summary([
      { work: 1, pay: 25_000 },
      { work: 1, pay: -10_000 },
    ]), 'pay')
    const positive = annualChartTooltipPlacement(model, model.points[0])
    const negative = annualChartTooltipPlacement(model, model.points[1])

    expect(positive.leftPercent).toBeGreaterThan(0)
    expect(positive.leftPercent).toBeLessThan(100)
    expect(positive.topPercent).toBeCloseTo((model.points[0].y / model.height) * 100)
    expect(positive.below).toBe(true)
    expect(negative.topPercent).toBeCloseTo(
      ((model.points[1].y + model.points[1].height) / model.height) * 100,
    )
    expect(negative.below).toBe(false)
  })
})

describe('AnnualBarChart interactions', () => {
  it('shows both monthly metrics on hover and keeps the native SVG description', async () => {
    const wrapper = mount(AnnualBarChart, {
      props: {
        summary: summary([{ work: 2.5, pay: 50_000 }]),
        metric: 'work',
      },
    })
    const january = wrapper.find('[data-month="2026-01"]')

    expect(wrapper.find('svg > title').text()).toBe('2026年每月工数柱状图')
    expect(wrapper.find('svg > desc').text()).toContain('1月2.5工')
    expect(january.attributes('tabindex')).toBe('0')
    expect(january.attributes('aria-label')).toBe('1月：工数 2.5工，实发 ¥500')
    expect(january.find('title').text()).toBe('1月：工数 2.5工，实发 ¥500')

    await january.trigger('mouseenter')
    const tooltip = wrapper.find('[role="tooltip"]')
    expect(tooltip.exists()).toBe(true)
    expect(tooltip.text()).toContain('1月')
    expect(tooltip.text()).toContain('工数2.5工')
    expect(tooltip.text()).toContain('实发¥500')
    expect(tooltip.attributes('style')).toContain('clamp(92px')
    expect(january.attributes('aria-describedby')).toBe(tooltip.attributes('id'))

    await january.trigger('mouseleave')
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false)
  })

  it('supports keyboard focus, negative values and staggered bar delays', async () => {
    const wrapper = mount(AnnualBarChart, {
      attachTo: document.body,
      props: {
        summary: summary([
          { work: 1, pay: 25_000 },
          { work: 1, pay: -10_000 },
        ]),
        metric: 'pay',
      },
    })
    const points = wrapper.findAll('.annual-bar-chart__point')
    const february = points[1]

    expect(points[0].attributes('style')).toContain('--annual-bar-delay: 0ms')
    expect(february.attributes('style')).toContain('--annual-bar-delay: 28ms')
    expect(february.find('rect').classes()).toContain('annual-bar-chart__bar--negative')

    await february.trigger('focus')
    const tooltip = wrapper.find('[role="tooltip"]')
    expect(tooltip.text()).toContain('2月')
    expect(tooltip.text()).toContain('工数1工')
    expect(tooltip.text()).toContain('实发-¥100')
    expect(tooltip.find('.is-negative').exists()).toBe(true)

    await february.trigger('blur')
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the accessible empty state when the selected metric has no values', () => {
    const wrapper = mount(AnnualBarChart, {
      props: {
        summary: summary([]),
        metric: 'pay',
      },
    })

    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.find('[role="status"]').text()).toContain('暂无可绘制的年度数据')
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false)
  })
})
