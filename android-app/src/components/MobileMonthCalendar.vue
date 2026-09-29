<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MonthWeek } from '../date'
import type { AttendanceEntry, AttendancePeriod, AttendanceValue, OrdinaryLeave, OvertimeLeave } from '../types'

const props = defineProps<{
  workerId: string
  month: string
  weeks: readonly MonthWeek[]
  headers: readonly string[]
  readOnly: boolean
  failedDateKeys: ReadonlySet<string>
  failedCellKeys?: ReadonlySet<string>
  attendanceFor: (workerId: string, date: string) => AttendanceEntry | undefined
  statusValue: (workerId: string, date: string, period: AttendancePeriod) => AttendanceValue
  leaveValue: (workerId: string, date: string, period: AttendancePeriod) => OrdinaryLeave | OvertimeLeave | null
}>()

const emit = defineEmits<{
  'open-day': [workerId: string, date: string]
  batch: [dates: string[], period: AttendancePeriod, value: AttendanceValue]
  'batch-leave': [dates: string[], period: AttendancePeriod]
}>()

const periods: AttendancePeriod[] = ['morning', 'afternoon', 'overtime']
const periodNames = { morning: '上午', afternoon: '下午', overtime: '加班' }
const periodShortNames = { morning: '上', afternoon: '下', overtime: '加' }
const batchMode = ref(false)
const selectedDates = ref<string[]>([])
const batchPeriod = ref<AttendancePeriod>('morning')
const batchValue = ref<'present' | 'absent' | 'half' | 'full' | 'blank' | 'leave'>('present')
const dates = computed(() => props.weeks.flatMap(week => week.days.flatMap(day => day.iso ? [day.iso] : [])))
const currentWeekDates = computed(() => props.weeks.find(week => week.days.some(day => day.isToday))?.days.flatMap(day => day.iso ? [day.iso] : []) ?? [])

function resetSelection() {
  batchMode.value = false
  selectedDates.value = []
}

watch(() => [props.workerId, props.month, props.readOnly], resetSelection)
watch(batchPeriod, period => { batchValue.value = period === 'overtime' ? 'half' : 'present' })

function statusSymbol(date: string, period: AttendancePeriod): string {
  if (props.leaveValue(props.workerId, date, period)) return '假'
  const value = props.statusValue(props.workerId, date, period)
  return value === 'present' ? '✓' : value === 'absent' ? '×' : value === 'half' ? '½' : value === 'full' ? '1' : '—'
}

function statusLabel(date: string, period: AttendancePeriod): string {
  const leave = props.leaveValue(props.workerId, date, period)
  if (leave) return `${leave.payType === 'paid' ? '带薪' : '无薪'}请假${'units' in leave ? `（${leave.units === 'half' ? '半工' : '一工'}）` : ''}`
  const value = props.statusValue(props.workerId, date, period)
  return value === 'present' ? '出工' : value === 'absent' ? '未出工' : value === 'half' ? '半工' : value === 'full' ? '一工' : '未记录'
}

function dateLabel(date: string): string {
  const states = periods.map(period => `${periodNames[period]}${statusLabel(date, period)}`).join('，')
  const failed = dateHasFailure(date) ? '，有修改保存失败' : ''
  return `${date}，${states}${failed}${batchMode.value ? (selectedDates.value.includes(date) ? '，已选中' : '，未选中') : '，查看或修改当日记录'}`
}

function dateHasFailure(date: string): boolean {
  return props.failedDateKeys.has(`${props.workerId}|${date}`)
    || periods.some(period => props.failedCellKeys?.has(`${props.workerId}|${date}|${period}`))
}

// Let the browser scroll naturally. A moved/cancelled pointer cannot activate a date.
let pointerStart: { x: number; y: number } | null = null
let pointerMoved = false
function startPointer(event: PointerEvent) {
  pointerStart = { x: event.clientX, y: event.clientY }
  pointerMoved = false
}
function movePointer(event: PointerEvent) {
  if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 8) pointerMoved = true
}
function cancelPointer() {
  pointerMoved = true
  pointerStart = null
}
function resetPointer() {
  pointerMoved = false
  pointerStart = null
}
function activateDate(date: string) {
  if (pointerMoved) {
    pointerMoved = false
    pointerStart = null
    return
  }
  pointerStart = null
  if (!batchMode.value) {
    emit('open-day', props.workerId, date)
    return
  }
  if (props.readOnly) return
  selectedDates.value = selectedDates.value.includes(date)
    ? selectedDates.value.filter(value => value !== date)
    : [...selectedDates.value, date].sort()
}

function applyBatch() {
  if (props.readOnly || selectedDates.value.length === 0) return
  const selection = [...selectedDates.value]
  if (batchValue.value === 'leave') emit('batch-leave', selection, batchPeriod.value)
  else emit('batch', selection, batchPeriod.value, batchValue.value === 'blank' ? null : batchValue.value)
  resetSelection()
}
</script>

<template>
  <section class="mobile-month-calendar mobile-only" aria-label="手机月历">
    <div class="mobile-calendar-actions">
      <p>{{ batchMode ? `已选 ${selectedDates.length} 天` : '点日期，修改当天记工' }}</p>
      <button v-if="!batchMode" class="button button-secondary" type="button" :disabled="readOnly" @click="batchMode = true">批量记工</button>
      <button v-else class="button button-ghost mobile-batch-cancel" type="button" @click="resetSelection">取消批量</button>
    </div>
    <div v-if="batchMode" class="mobile-batch-shortcuts" role="group" aria-label="批量日期选择">
      <button class="button button-ghost" type="button" :disabled="!currentWeekDates.length" :title="currentWeekDates.length ? '选择本周在当前月份内的日期' : '当前月份不包含今天'" @click="selectedDates = [...currentWeekDates]">本周</button>
      <button class="button button-ghost" type="button" @click="selectedDates = [...dates]">全月</button>
      <button class="button button-ghost" type="button" :disabled="!selectedDates.length" @click="selectedDates = []">清空</button>
    </div>
    <div class="mobile-calendar-weekdays" aria-hidden="true"><span v-for="header in headers" :key="header">{{ header }}</span></div>
    <div class="mobile-calendar-weeks" @pointermove="movePointer" @pointercancel="cancelPointer">
      <div v-for="week in weeks" :key="week.key" class="mobile-calendar-week">
        <template v-for="(day, index) in week.days" :key="day.iso ?? `${week.key}-${index}`">
          <button
            v-if="day.iso"
            class="mobile-calendar-day"
            :class="{ 'is-today': day.isToday, 'is-weekend': day.isWeekend, 'is-selected': selectedDates.includes(day.iso), 'has-save-error': dateHasFailure(day.iso) }"
            type="button"
            :data-mobile-date="day.iso"
            :aria-label="dateLabel(day.iso)"
            :aria-pressed="batchMode ? selectedDates.includes(day.iso) : undefined"
            :aria-current="day.isToday ? 'date' : undefined"
            @pointerdown="startPointer"
            @keydown.enter="resetPointer"
            @keydown.space="resetPointer"
            @click="activateDate(day.iso)"
          >
            <span class="mobile-date-number"><strong>{{ day.day }}</strong><span v-if="batchMode && selectedDates.includes(day.iso)" class="mobile-date-marker" aria-hidden="true">✓</span><span v-else-if="attendanceFor(workerId, day.iso)?.dayNote" class="mobile-date-marker" aria-hidden="true">•</span></span>
            <span v-for="period in periods" :key="period" class="mobile-period-state" :class="[`is-${statusValue(workerId, day.iso, period) ?? 'blank'}`, { 'is-leave': Boolean(leaveValue(workerId, day.iso, period)) }]" aria-hidden="true"><span>{{ periodShortNames[period] }}</span><b>{{ statusSymbol(day.iso, period) }}</b></span>
          </button>
          <span v-else class="mobile-calendar-empty" aria-hidden="true"></span>
        </template>
      </div>
    </div>
    <p class="mobile-calendar-key">✓ 出工 · × 未出工 · ½ / 1 加班工数 · 假 请假 · — 未记录</p>
    <form v-if="batchMode" class="mobile-batch-form" @submit.prevent="applyBatch">
      <label class="form-field"><span>时段</span><select v-model="batchPeriod" aria-label="批量时段"><option v-for="period in periods" :key="period" :value="period">{{ periodNames[period] }}</option></select></label>
      <label class="form-field"><span>状态</span><select v-model="batchValue" aria-label="批量状态"><template v-if="batchPeriod === 'overtime'"><option value="half">半工加班</option><option value="full">一工加班</option></template><template v-else><option value="present">出工</option><option value="absent">未出工</option></template><option value="blank">清空记录</option><option value="leave">请假…</option></select></label>
      <button class="button button-primary mobile-batch-apply" type="submit" :disabled="readOnly || !selectedDates.length">{{ batchValue === 'leave' ? '设置请假' : '应用修改' }} · {{ selectedDates.length }} 天</button>
      <small class="mobile-batch-note">已请假的时段保留原记录；修改后可用顶部“撤销”恢复。</small>
    </form>
  </section>
</template>

<style scoped>
.mobile-month-calendar { display: none; }
@media screen and (max-width: 760px) {
  .mobile-month-calendar { display: block; min-width: 0; padding: 8px; touch-action: pan-y; }
  .mobile-calendar-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px 8px; }
  .mobile-calendar-actions p { margin: 0; min-width: 0; color: var(--muted); font-size: 12px; }
  .mobile-calendar-actions .button { min-height: 40px; padding: 7px 10px; font-size: 12px; }
  .mobile-batch-shortcuts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-bottom: 8px; }
  .mobile-batch-shortcuts .button { min-width: 0; min-height: 42px; padding: 6px; }
  .mobile-calendar-weekdays, .mobile-calendar-week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px; }
  .mobile-calendar-weekdays { margin-bottom: 5px; color: var(--muted); text-align: center; font-size: 11px; line-height: 24px; }
  .mobile-calendar-weeks { display: grid; gap: 4px; }
  .mobile-calendar-day { min-width: 0; width: 100%; min-height: 87px; padding: 4px 3px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink); touch-action: pan-y; text-align: left; user-select: none; -webkit-user-select: none; }
  .mobile-calendar-day.is-weekend { background: var(--weekend-bg); }
  .mobile-calendar-day.is-today { border-color: var(--orange); }
  .mobile-calendar-day.is-today .mobile-date-number strong { color: var(--today-ink); }
  .mobile-calendar-day.is-selected { border-color: var(--green); background: var(--green-soft); box-shadow: inset 0 0 0 1px var(--green); }
  .mobile-calendar-day.has-save-error { border-color: var(--red); border-style: dashed; }
  .mobile-date-number { display: flex; align-items: center; justify-content: space-between; min-height: 21px; margin-bottom: 3px; gap: 1px; }
  .mobile-date-number strong { font-size: 14px; line-height: 19px; font-variant-numeric: tabular-nums; }
  .mobile-date-marker { color: var(--green); font-size: 10px; }
  .mobile-period-state { display: flex; align-items: center; justify-content: space-between; gap: 1px; min-height: 17px; font-size: 10px; line-height: 17px; }
  .mobile-period-state > span { color: var(--muted); }
  .mobile-period-state b { font-size: 12px; color: var(--green-dark); }
  .mobile-period-state.is-absent b { color: var(--red); }
  .mobile-period-state.is-half b, .mobile-period-state.is-full b { color: var(--overtime-ink); }
  .mobile-period-state.is-blank b { color: var(--blank-hint); }
  .mobile-period-state.is-leave b { color: var(--overtime-ink); }
  .mobile-calendar-key { margin: 8px 1px 2px; color: var(--muted); font-size: 10px; line-height: 1.7; overflow-wrap: anywhere; }
  .mobile-batch-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding-top: 12px; }
  .mobile-batch-form .form-field { min-width: 0; }
  .mobile-batch-form select { width: 100%; min-width: 0; min-height: 44px; padding: 8px; }
  .mobile-batch-apply, .mobile-batch-note { grid-column: 1 / -1; }
  .mobile-batch-note { color: var(--muted); line-height: 1.6; }
}
@media print { .mobile-month-calendar { display: none !important; } }
</style>
