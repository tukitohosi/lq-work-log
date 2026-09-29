import type { AnnualPayrollSummary } from './payroll'

export type AnnualChartMetric = 'work' | 'pay'

export interface AnnualChartPoint {
  month: string
  label: string
  value: number
  formattedValue: string
  workDays: number
  netPayFen: number
  formattedWorkDays: string
  formattedNetPay: string
  accessibleLabel: string
  x: number
  y: number
  width: number
  height: number
  negative: boolean
}

export interface AnnualChartTick {
  value: number
  label: string
  y: number
}

export interface AnnualChartModel {
  width: number
  height: number
  plotLeft: number
  plotRight: number
  plotTop: number
  plotBottom: number
  zeroY: number
  domainMin: number
  domainMax: number
  hasData: boolean
  title: string
  description: string
  points: AnnualChartPoint[]
  ticks: AnnualChartTick[]
}

export interface AnnualChartOptions {
  width?: number
  height?: number
}

export interface AnnualChartTooltipPlacement {
  leftPercent: number
  topPercent: number
  below: boolean
}

export function buildAnnualChartModel(
  summary: AnnualPayrollSummary | null | undefined,
  metric: AnnualChartMetric,
  options: AnnualChartOptions = {},
): AnnualChartModel {
  const width = Math.max(320, options.width ?? 760)
  const height = Math.max(220, options.height ?? 320)
  const plotLeft = 62
  const plotRight = width - 18
  const plotTop = 22
  const plotBottom = height - 44
  const months = summary?.months.slice(0, 12) ?? []
  const aggregates = months.map((month) => aggregateMonth(summary, month))
  const values = aggregates.map((aggregate) => metric === 'work' ? aggregate.workDays : aggregate.netPayFen)
  const hasData = Boolean(summary?.rows.length) && values.some((value) => value !== 0)

  const rawMin = Math.min(0, ...values)
  const rawMax = Math.max(0, ...values)
  const fallbackSpan = metric === 'pay' ? 100 : 1
  let domainMin = rawMin
  let domainMax = rawMax
  if (domainMin === domainMax) domainMax = domainMin + fallbackSpan

  const span = domainMax - domainMin
  const plotHeight = plotBottom - plotTop
  const yForValue = (value: number) => plotTop + ((domainMax - value) / span) * plotHeight
  const zeroY = yForValue(0)
  const slotWidth = months.length ? (plotRight - plotLeft) / months.length : 0
  const barWidth = Math.min(34, Math.max(8, slotWidth * 0.58))

  const points = months.map((month, index): AnnualChartPoint => {
    const value = values[index]
    const aggregate = aggregates[index]
    const valueY = yForValue(value)
    const label = monthLabel(month)
    const formattedWorkDays = formatAnnualChartValue(aggregate.workDays, 'work')
    const formattedNetPay = formatAnnualChartValue(aggregate.netPayFen, 'pay')
    return {
      month,
      label,
      value,
      formattedValue: formatAnnualChartValue(value, metric),
      workDays: aggregate.workDays,
      netPayFen: aggregate.netPayFen,
      formattedWorkDays,
      formattedNetPay,
      accessibleLabel: `${label}：工数 ${formattedWorkDays}，实发 ${formattedNetPay}`,
      x: plotLeft + index * slotWidth + (slotWidth - barWidth) / 2,
      y: Math.min(valueY, zeroY),
      width: barWidth,
      height: Math.abs(valueY - zeroY),
      negative: value < 0,
    }
  })

  const ticks = makeTicks(domainMin, domainMax, 5).map((value) => ({
    value,
    label: formatAxisValue(value, metric),
    y: yForValue(value),
  }))
  const metricName = metric === 'work' ? '工数' : '实发工资'
  const year = summary?.year ?? ''
  const title = `${year ? `${year}年` : ''}每月${metricName}柱状图`
  const description = hasData
    ? `${title}。${points.map((point) => `${point.label}${point.formattedValue}`).join('，')}。`
    : `${title}。暂无可绘制的数据。`

  return {
    width,
    height,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    zeroY,
    domainMin,
    domainMax,
    hasData,
    title,
    description,
    points,
    ticks,
  }
}

export function formatAnnualChartValue(value: number, metric: AnnualChartMetric): string {
  if (metric === 'work') return `${formatDecimal(value)}工`
  const sign = value < 0 ? '-' : ''
  return `${sign}¥${formatDecimal(Math.abs(value) / 100)}`
}

export function annualChartTooltipPlacement(
  model: AnnualChartModel,
  point: AnnualChartPoint,
): AnnualChartTooltipPlacement {
  const centerX = point.x + point.width / 2
  const anchorY = point.negative ? point.y + point.height : point.y
  return {
    leftPercent: clamp((centerX / model.width) * 100, 0, 100),
    topPercent: clamp((anchorY / model.height) * 100, 0, 100),
    below: anchorY < model.plotTop + 68,
  }
}

function aggregateMonth(
  summary: AnnualPayrollSummary | null | undefined,
  month: string,
): { workDays: number; netPayFen: number } {
  if (!summary) return { workDays: 0, netPayFen: 0 }
  return summary.rows.reduce((total, row) => {
    const item = row.months.find((candidate) => candidate.month === month)
    if (!item) return total
    total.workDays += item.workDays
    total.netPayFen += item.netPayFen
    return total
  }, { workDays: 0, netPayFen: 0 })
}

function makeTicks(min: number, max: number, count: number): number[] {
  const ticks = Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1))
  if (min < 0 && max > 0 && !ticks.some((tick) => Math.abs(tick) < Number.EPSILON)) ticks.push(0)
  return ticks.sort((left, right) => right - left)
}

function formatAxisValue(value: number, metric: AnnualChartMetric): string {
  if (Math.abs(value) < Number.EPSILON) return '0'
  if (metric === 'work') return formatDecimal(value)
  const yuan = value / 100
  if (Math.abs(yuan) >= 10_000) return `${formatDecimal(yuan / 10_000)}万`
  return formatDecimal(yuan)
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
}

function monthLabel(month: string): string {
  const numeric = Number(month.slice(5, 7))
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 12 ? `${numeric}月` : month
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
