<script setup lang="ts">
import { computed, ref, useId, type CSSProperties } from 'vue'
import {
  annualChartTooltipPlacement,
  buildAnnualChartModel,
  type AnnualChartMetric,
} from '../annual-chart'
import type { AnnualPayrollSummary } from '../payroll'

const props = defineProps<{
  summary: AnnualPayrollSummary | null
  metric: AnnualChartMetric
}>()

const model = computed(() => buildAnnualChartModel(props.summary, props.metric))
const hoveredMonth = ref<string | null>(null)
const focusedMonth = ref<string | null>(null)
const activeMonth = computed(() => hoveredMonth.value ?? focusedMonth.value)
const activePoint = computed(() => (
  model.value.points.find((point) => point.month === activeMonth.value) ?? null
))
const activePlacement = computed(() => (
  activePoint.value ? annualChartTooltipPlacement(model.value, activePoint.value) : null
))
const tooltipStyle = computed<CSSProperties>(() => {
  const placement = activePlacement.value
  if (!placement) return {}
  return {
    left: `clamp(92px, ${placement.leftPercent}%, calc(100% - 92px))`,
    top: `${placement.topPercent}%`,
  }
})
const titleId = useId()
const descriptionId = useId()
const tooltipId = useId()

function clearHoveredMonth(month: string): void {
  if (hoveredMonth.value === month) hoveredMonth.value = null
}

function clearFocusedMonth(month: string): void {
  if (focusedMonth.value === month) focusedMonth.value = null
}
</script>

<template>
  <figure class="annual-bar-chart" :aria-labelledby="titleId" :aria-describedby="descriptionId">
    <svg
      v-if="model.hasData"
      class="annual-bar-chart__svg"
      :viewBox="`0 0 ${model.width} ${model.height}`"
      role="img"
      preserveAspectRatio="xMidYMid meet"
    >
      <title :id="titleId">{{ model.title }}</title>
      <desc :id="descriptionId">{{ model.description }}</desc>

      <g class="annual-bar-chart__grid" aria-hidden="true">
        <template v-for="tick in model.ticks" :key="tick.value">
          <line :x1="model.plotLeft" :x2="model.plotRight" :y1="tick.y" :y2="tick.y" />
          <text :x="model.plotLeft - 9" :y="tick.y + 4" text-anchor="end">{{ tick.label }}</text>
        </template>
      </g>
      <line
        class="annual-bar-chart__zero"
        :x1="model.plotLeft"
        :x2="model.plotRight"
        :y1="model.zeroY"
        :y2="model.zeroY"
        aria-hidden="true"
      />

      <g
        v-for="(point, index) in model.points"
        :key="`${metric}:${point.month}:${point.workDays}:${point.netPayFen}`"
        class="annual-bar-chart__point"
        :data-month="point.month"
        tabindex="0"
        focusable="true"
        role="img"
        :aria-label="point.accessibleLabel"
        :aria-describedby="activeMonth === point.month ? tooltipId : undefined"
        :style="{ '--annual-bar-delay': `${index * 28}ms` }"
        @mouseenter="hoveredMonth = point.month"
        @mouseleave="clearHoveredMonth(point.month)"
        @focus="focusedMonth = point.month"
        @blur="clearFocusedMonth(point.month)"
      >
        <rect
          class="annual-bar-chart__bar"
          :class="{ 'annual-bar-chart__bar--negative': point.negative }"
          :x="point.x"
          :y="point.y"
          :width="point.width"
          :height="Math.max(point.height, 0.5)"
          rx="4"
        >
          <title>{{ point.accessibleLabel }}</title>
        </rect>
        <text
          class="annual-bar-chart__month"
          :x="point.x + point.width / 2"
          :y="model.plotBottom + 23"
          text-anchor="middle"
          aria-hidden="true"
        >{{ point.label }}</text>
      </g>
    </svg>

    <div v-else class="annual-bar-chart__empty" role="status">
      <strong :id="titleId">{{ model.title }}</strong>
      <span :id="descriptionId">暂无可绘制的年度数据</span>
    </div>

    <div
      v-if="activePoint && activePlacement"
      :id="tooltipId"
      class="annual-bar-chart__tooltip"
      :class="{ 'annual-bar-chart__tooltip--below': activePlacement.below }"
      :style="tooltipStyle"
      role="tooltip"
    >
      <strong>{{ activePoint.label }}</strong>
      <span><em>工数</em><b>{{ activePoint.formattedWorkDays }}</b></span>
      <span><em>实发</em><b :class="{ 'is-negative': activePoint.netPayFen < 0 }">{{ activePoint.formattedNetPay }}</b></span>
    </div>

    <figcaption class="annual-bar-chart__caption">{{ model.description }}</figcaption>
  </figure>
</template>

<style scoped>
.annual-bar-chart {
  position: relative;
  margin: 0;
}

.annual-bar-chart__svg {
  display: block;
  width: 100%;
  min-height: 240px;
  overflow: visible;
}

.annual-bar-chart__grid line {
  stroke: var(--line, #dbe3ef);
  stroke-width: 1;
}

.annual-bar-chart__grid text,
.annual-bar-chart__month {
  fill: var(--muted, #667085);
  font-size: 11px;
}

.annual-bar-chart__zero {
  stroke: var(--ink, #334155);
  stroke-width: 1.25;
}

.annual-bar-chart__point {
  outline: none;
}

.annual-bar-chart__bar {
  fill: var(--green, #4776e6);
  transform-box: fill-box;
  transform-origin: center bottom;
  animation: annual-bar-grow 440ms cubic-bezier(0.2, 0.72, 0.25, 1) both;
  animation-delay: var(--annual-bar-delay, 0ms);
  transition: filter 120ms ease, stroke 120ms ease, stroke-width 120ms ease;
}

.annual-bar-chart__bar--negative {
  fill: var(--red, #d45454);
  transform-origin: center top;
}

.annual-bar-chart__point:hover .annual-bar-chart__bar,
.annual-bar-chart__point:focus-visible .annual-bar-chart__bar {
  filter: brightness(1.08) saturate(1.08);
  stroke: var(--ink, #334155);
  stroke-width: 1.5;
}

.annual-bar-chart__tooltip {
  position: absolute;
  z-index: 2;
  display: grid;
  box-sizing: border-box;
  width: 176px;
  max-width: calc(100% - 16px);
  padding: 10px 12px;
  gap: 6px;
  border: 1px solid var(--line, #dbe3ef);
  border-radius: 10px;
  color: var(--ink, #334155);
  background: var(--surface-raised, var(--surface, #fff));
  box-shadow: var(--card-shadow, 0 9px 28px rgba(32, 62, 50, 0.14));
  pointer-events: none;
  transform: translate(-50%, calc(-100% - 10px));
  font-variant-numeric: tabular-nums;
}

.annual-bar-chart__tooltip--below {
  transform: translate(-50%, 10px);
}

.annual-bar-chart__tooltip > strong {
  font-size: 13px;
}

.annual-bar-chart__tooltip > span {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}

.annual-bar-chart__tooltip em {
  color: var(--muted, #667085);
  font-style: normal;
}

.annual-bar-chart__tooltip b {
  font-weight: 800;
}

.annual-bar-chart__tooltip b.is-negative {
  color: var(--red, #d45454);
}

.annual-bar-chart__empty {
  min-height: 220px;
  display: grid;
  place-content: center;
  gap: 7px;
  border: 1px dashed var(--line, #cbd5e1);
  border-radius: 12px;
  color: var(--muted, #667085);
  text-align: center;
}

.annual-bar-chart__empty strong {
  color: var(--ink, #334155);
}

.annual-bar-chart__caption {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

@keyframes annual-bar-grow {
  from {
    opacity: 0.35;
    transform: scaleY(0);
  }
  to {
    opacity: 1;
    transform: scaleY(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .annual-bar-chart__bar {
    animation: none;
    transition: none;
  }
}

@media print {
  .annual-bar-chart__svg {
    min-height: 190px;
  }

  .annual-bar-chart__bar {
    animation: none !important;
    filter: none !important;
    transform: none !important;
  }

  .annual-bar-chart__tooltip {
    display: none !important;
  }
}
</style>
