<script setup lang="ts">
import { periodLeaveField, periodSiteField } from '../attendance'
import type { SaveStatus } from '../composables/useMutations'
import type { AttendanceEntry, AttendancePeriod, AttendanceValue, Site, Worker } from '../types'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  open: boolean
  worker: Worker | null
  date: string
  entry: AttendanceEntry | undefined
  sites: readonly Site[]
  readOnly: boolean
  note: string
  notePending: boolean
  saveStatus: SaveStatus
  saveError: string
}>()
const emit = defineEmits<{
  close: []
  status: [period: AttendancePeriod, value: AttendanceValue]
  site: [period: AttendancePeriod, siteId: string]
  leave: [period?: AttendancePeriod]
  'note-input': [value: string]
  'note-blur': []
  retry: []
}>()
const periods: AttendancePeriod[] = ['morning', 'afternoon', 'overtime']
function label(period: AttendancePeriod): string {
  return period === 'morning' ? '上午' : period === 'afternoon' ? '下午' : '加班'
}
function choices(period: AttendancePeriod): { value: AttendanceValue; label: string }[] {
  return period === 'overtime'
    ? [{ value: 'half', label: '半工' }, { value: 'full', label: '一工' }, { value: null, label: '空白' }]
    : [{ value: 'present', label: '出工' }, { value: 'absent', label: '未出工' }, { value: null, label: '空白' }]
}
function selectableSites(period: AttendancePeriod): Site[] {
  return props.sites.filter((site) => !site.archivedAt || site.id === props.entry?.[periodSiteField(period)])
}
function leaveText(period: AttendancePeriod): string {
  const leave = props.entry?.[periodLeaveField(period)]
  if (!leave) return ''
  return leave.payType === 'unpaid' ? '无薪请假' : 'units' in leave ? `带薪请假 · ${leave.units === 'half' ? '半工' : '一工'}` : '带薪请假'
}
function inputNote(event: Event): void {
  if (!(event as InputEvent).isComposing) emit('note-input', (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <Transition name="modal">
    <div v-if="open" class="modal-backdrop" @mousedown.self="emit('close')">
      <section class="modal day-details-dialog" role="dialog" aria-modal="true" aria-labelledby="day-dialog-title">
        <header class="modal-header">
          <div><span class="eyebrow">{{ worker?.name }} · 当日详情</span><h2 id="day-dialog-title">{{ date }}</h2></div>
          <button class="icon-button" type="button" aria-label="关闭当日详情" @click="emit('close')"><UiIcon name="close" /></button>
        </header>
        <div class="modal-form">
          <div class="day-save-state" :class="{ 'has-error': saveStatus === 'error' || saveStatus === 'unknown' }" role="status" aria-live="polite">
            <span>{{ worker?.archivedAt ? '已归档 · 只读' : saveStatus === 'unknown' ? '保存结果待核对' : saveStatus === 'error' ? '保存失败，修改仍保留' : notePending || saveStatus === 'saving' ? '正在自动保存…' : saveStatus === 'saved' ? '已保存 · 修改后自动保存' : '修改后自动保存' }}</span>
            <template v-if="saveStatus === 'error' || saveStatus === 'unknown'"><p>{{ saveError }}</p><button class="button button-secondary" type="button" @click="emit('retry')">重试未保存修改</button></template>
          </div>
          <button class="button button-secondary" type="button" :disabled="readOnly" @click="emit('leave')">全天请假（上午＋下午）</button>
          <section v-for="period in periods" :key="period" class="day-period-card" :aria-label="label(period)">
            <div class="day-period-heading"><h3>{{ label(period) }}</h3><span v-if="leaveText(period)">{{ leaveText(period) }}</span></div>
            <div class="day-status-options">
              <button v-for="choice in choices(period)" :key="choice.value ?? 'blank'" class="day-status-button" :class="{ active: !entry?.[periodLeaveField(period)] && (entry?.[period] ?? null) === choice.value }" type="button" :data-period="period" :data-status="choice.value ?? 'blank'" :aria-label="`${label(period)}${choice.label}`" :aria-pressed="!entry?.[periodLeaveField(period)] && (entry?.[period] ?? null) === choice.value" :disabled="readOnly || Boolean(entry?.[periodLeaveField(period)])" @click="emit('status', period, choice.value)">{{ choice.label }}</button>
              <button class="day-status-button" :class="{ active: Boolean(entry?.[periodLeaveField(period)]) }" type="button" :disabled="readOnly" :aria-label="`${label(period)}${leaveText(period) ? '调整请假' : '请假'}`" @click="emit('leave', period)">{{ leaveText(period) ? '调整请假' : '请假' }}</button>
            </div>
            <label class="form-field"><span>{{ label(period) }}工地</span><select :aria-label="`${label(period)}工地`" :value="entry?.[periodSiteField(period)] ?? ''" :disabled="readOnly || Boolean(entry?.[periodLeaveField(period)]) || !entry?.[period] || entry?.[period] === 'absent'" @change="emit('site', period, ($event.target as HTMLSelectElement).value)"><option value="">未分配</option><option v-for="site in selectableSites(period)" :key="site.id" :value="site.id" :disabled="Boolean(site.archivedAt)">{{ site.name }}{{ site.archivedAt ? '（已归档）' : '' }}</option></select></label>
          </section>
          <label class="form-field"><span>单日备注</span><textarea :value="note" maxlength="1000" rows="3" :disabled="readOnly" aria-label="单日备注" placeholder="例如：因雨停工、材料未到…" @input="inputNote" @compositionend="emit('note-input', ($event.target as HTMLTextAreaElement).value)" @blur="emit('note-blur')"></textarea><small>{{ note.length }}/1000 · 自动保存</small></label>
        </div>
        <footer class="modal-actions day-done"><button class="button button-primary" type="button" @click="emit('close')">完成</button></footer>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.day-save-state { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.day-save-state.has-error { color: var(--red); }
.day-save-state p { margin: 8px 0; }
.day-period-card { min-width: 0; padding: 14px; display: grid; gap: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-subtle); }
.day-period-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.day-period-heading h3 { margin: 0; font-size: 16px; }
.day-period-heading span { font-size: 12px; color: var(--muted); }
.day-status-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.day-status-button { min-width: 0; min-height: 44px; padding: 8px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); color: var(--ink); font-weight: 700; touch-action: pan-y; }
.day-status-button.active { background: var(--green-soft); border-color: var(--green); color: var(--green); }
.day-status-button:disabled { opacity: .55; }
.day-done { position: sticky; bottom: 0; margin: 0; padding: 12px 22px; background: var(--surface); border-top: 1px solid var(--line); }
.day-done button { flex: 1; }
.day-details-dialog :is(select, textarea) { width: 100%; min-width: 0; }
</style>
