<script setup lang="ts">
import { fenToCurrency } from '../money'
import { gridCellKey } from '../grid'
import { periodSiteField } from '../attendance'
import type { DailySiteGroup } from '../daily-sites'
import type {
  AppData,
  AttendanceEntry,
  AttendancePeriod,
  AttendanceValue,
  OrdinaryLeave,
  OvertimeLeave,
  PayAdjustment,
  Site,
  Worker,
} from '../types'

defineProps<{
  data: AppData
  selectedDate: string
  futureDate: boolean
  siteFilter: string
  groups: readonly DailySiteGroup[]
  totals: { people: number; halfDays: number; workDays: number }
  workers: readonly Worker[]
  failedCellKeys: ReadonlySet<string>
  failedDateKeys: ReadonlySet<string>
  attendanceFor: (workerId: string, date: string) => AttendanceEntry | undefined
  statusValue: (workerId: string, date: string, period: AttendancePeriod) => AttendanceValue
  leaveValue: (workerId: string, date: string, period: AttendancePeriod) => OrdinaryLeave | OvertimeLeave | null
  selectableSitesFor: (workerId: string, date: string, period: AttendancePeriod) => Site[]
  dailyAdjustments: (workerId: string) => PayAdjustment[]
}>()

const emit = defineEmits<{
  'update:selectedDate': [value: string]
  'update:siteFilter': [value: string]
  'select-worker': [worker: Worker]
  cycle: [workerId: string, date: string, period: AttendancePeriod]
  clear: [workerId: string, date: string, period: AttendancePeriod]
  leave: [workerId: string, date: string, period: AttendancePeriod]
  'update-site': [workerId: string, date: string, period: AttendancePeriod, siteId: string]
  'save-note': [workerId: string, date: string, note: string]
  'edit-adjustment': [item: PayAdjustment, workerId: string]
  'add-adjustment': [workerId: string]
}>()

const periods: AttendancePeriod[] = ['morning', 'afternoon', 'overtime']

function statusSymbol(value: AttendanceValue): string {
  return value === 'present' || value === 'half' ? '✓' : value === 'absent' ? '×' : value === 'full' ? '✓✓' : ''
}

function periodLabel(period: AttendancePeriod): string {
  return period === 'morning' ? '上午' : period === 'afternoon' ? '下午' : '加班'
}

function statusLabel(value: AttendanceValue): string {
  if (value === 'present') return '✓ 出工'
  if (value === 'absent') return '× 未出工'
  if (value === 'half') return '✓ 半工'
  if (value === 'full') return '✓✓ 一工'
  return '未记录'
}

function shortPeriodLabel(period: AttendancePeriod): string {
  return period === 'morning' ? '上' : period === 'afternoon' ? '下' : '加'
}

function leaveLabel(leave: OrdinaryLeave | OvertimeLeave | null): string {
  if (!leave) return ''
  if (leave.payType === 'unpaid') return '无薪请假'
  if ('units' in leave) return `带薪请假（${leave.units === 'half' ? '半工' : '一工'}加班）`
  return '带薪请假'
}
</script>

<template>
  <section class="daily-overview view-panel" :class="{ 'is-future-date': futureDate }">
    <div class="daily-toolbar"><div><span class="eyebrow">按天查看所有工人</span><h2>{{ selectedDate }}</h2></div><div class="filter-bar"><label class="filter-field"><span>日期</span><input :value="selectedDate" type="date" @change="emit('update:selectedDate', ($event.target as HTMLInputElement).value)"></label><label class="filter-field"><span>工地</span><select :value="siteFilter" @change="emit('update:siteFilter', ($event.target as HTMLSelectElement).value)"><option value="all">全部工地</option><option value="unassigned">未分配</option><option v-for="site in data.sites" :key="site.id" :value="site.id">{{ site.name }}{{ site.archivedAt ? '（已归档）' : '' }}</option></select></label></div></div>
    <div class="daily-stats"><div class="stat-card"><span>列表人数</span><strong>{{ totals.people }}</strong></div><div class="stat-card"><span>当日工数</span><strong>{{ totals.workDays }}</strong></div><div class="stat-card"><span>半工单位</span><strong>{{ totals.halfDays }}</strong></div></div>
    <section class="daily-site-overview" aria-label="按实际工地分组">
      <div class="section-toolbar"><div><span class="eyebrow">实际出勤工地</span><h2>工地分组</h2></div><button v-if="siteFilter !== 'all'" class="link-button" type="button" @click="emit('update:siteFilter', 'all')">显示全部</button></div>
      <div class="daily-site-grid">
        <button v-for="group in groups" :key="group.key" class="daily-site-card" :class="{ active: siteFilter === group.key }" type="button" @click="emit('update:siteFilter', group.key)">
          <span class="daily-site-card-heading"><strong>{{ group.name }}</strong><small>{{ group.people }} 人 · {{ group.workDays }} 工</small></span>
          <span class="daily-site-workers"><span v-for="row in group.rows" :key="row.worker.id">{{ row.worker.name }}（{{ row.periods.map(shortPeriodLabel).join('、') }}）</span></span>
        </button>
        <p v-if="!groups.length" class="empty-list">当天还没有已出工的工地记录。</p>
      </div>
    </section>
    <div class="mobile-only mobile-worker-cards" aria-label="当日工人记录">
      <article v-for="worker in workers" :key="worker.id" class="mobile-worker-card" :class="{ 'is-archived': worker.archivedAt }">
        <header class="mobile-card-heading">
          <button class="link-button" type="button" @click="emit('select-worker', worker)">{{ worker.name }}</button>
          <span v-if="worker.archivedAt" class="archived-badge">已归档 · 只读</span>
          <span v-else class="mobile-save-hint">修改自动保存</span>
        </header>
        <section v-for="period in periods" :key="period" class="mobile-daily-period" :aria-label="`${worker.name}${periodLabel(period)}`">
          <strong>{{ periodLabel(period) }}</strong>
          <div class="mobile-period-actions">
            <button class="button mobile-status-button" :class="[`status-${statusValue(worker.id, selectedDate, period) ?? 'blank'}`, { 'is-leave': Boolean(leaveValue(worker.id, selectedDate, period)), 'has-save-error': failedCellKeys.has(gridCellKey(worker.id, selectedDate, period)) }]" type="button" :disabled="Boolean(worker.archivedAt)" :aria-label="`${worker.name}${periodLabel(period)}：${leaveLabel(leaveValue(worker.id, selectedDate, period)) || statusLabel(statusValue(worker.id, selectedDate, period))}，点击修改`" @click="leaveValue(worker.id, selectedDate, period) ? emit('leave', worker.id, selectedDate, period) : emit('cycle', worker.id, selectedDate, period)">{{ leaveValue(worker.id, selectedDate, period) ? '请假' : statusLabel(statusValue(worker.id, selectedDate, period)) }}</button>
            <button class="button button-ghost" type="button" :disabled="Boolean(worker.archivedAt)" :aria-label="`${worker.name}${periodLabel(period)}请假`" @click="emit('leave', worker.id, selectedDate, period)">请假</button>
            <button class="button button-ghost" type="button" :disabled="Boolean(worker.archivedAt) || Boolean(leaveValue(worker.id, selectedDate, period)) || statusValue(worker.id, selectedDate, period) === null" :aria-label="`${worker.name}${periodLabel(period)}清空`" @click="emit('clear', worker.id, selectedDate, period)">清空</button>
          </div>
          <small v-if="leaveValue(worker.id, selectedDate, period)">{{ leaveLabel(leaveValue(worker.id, selectedDate, period)) }}</small>
          <label class="form-field"><span>实际工地</span><select :value="attendanceFor(worker.id, selectedDate)?.[periodSiteField(period)] ?? ''" :disabled="Boolean(worker.archivedAt) || Boolean(leaveValue(worker.id, selectedDate, period)) || statusValue(worker.id, selectedDate, period) === null || statusValue(worker.id, selectedDate, period) === 'absent'" :aria-label="`${worker.name}${periodLabel(period)}实际工地`" @change="emit('update-site', worker.id, selectedDate, period, ($event.target as HTMLSelectElement).value)"><option value="">未分配</option><option v-for="site in selectableSitesFor(worker.id, selectedDate, period)" :key="site.id" :value="site.id" :disabled="Boolean(site.archivedAt)">{{ site.name }}{{ site.archivedAt ? '（已归档）' : '' }}</option></select></label>
          <small v-if="failedCellKeys.has(gridCellKey(worker.id, selectedDate, period))" class="form-error">此时段保存失败，请通过顶部提示重试。</small>
        </section>
        <label class="form-field" :class="{ 'has-save-error': failedDateKeys.has(`${worker.id}|${selectedDate}`) }"><span>每日备注</span><textarea maxlength="1000" :value="attendanceFor(worker.id, selectedDate)?.dayNote ?? ''" :disabled="Boolean(worker.archivedAt)" :aria-label="`${worker.name}每日备注`" placeholder="当天说明，离开输入框自动保存" @blur="emit('save-note', worker.id, selectedDate, ($event.target as HTMLTextAreaElement).value)"></textarea></label>
        <div class="mobile-daily-adjustments"><strong>当日补贴 / 扣款</strong><button v-for="item in dailyAdjustments(worker.id)" :key="item.id" class="link-button" type="button" :disabled="Boolean(worker.archivedAt)" @click="emit('edit-adjustment', item, worker.id)">{{ item.kind === 'allowance' ? '+' : '−' }}{{ fenToCurrency(item.amountFen) }} {{ item.label }}</button><button v-if="!worker.archivedAt" class="button button-secondary" type="button" @click="emit('add-adjustment', worker.id)">＋ 添加一笔</button></div>
      </article>
      <p v-if="workers.length === 0" class="empty-list">这一天没有符合筛选条件的工人。</p>
    </div>
    <div class="daily-table-wrap desktop-table">
      <table class="daily-table"><thead><tr><th>工人</th><th v-for="period in periods" :key="period">{{ periodLabel(period) }}</th><th>每日备注</th><th>当日调整</th></tr></thead>
        <tbody><tr v-for="worker in workers" :key="worker.id" :class="{ 'is-archived': worker.archivedAt }">
          <td class="worker-cell"><button class="link-button" type="button" @click="emit('select-worker', worker)">{{ worker.name }}</button><span v-if="worker.archivedAt" class="archived-badge">已归档 · 只读</span></td>
          <td v-for="period in periods" :key="period">
            <button class="attendance-button" :class="[`status-${statusValue(worker.id, selectedDate, period) ?? 'blank'}`, { 'is-leave': Boolean(leaveValue(worker.id, selectedDate, period)), 'has-save-error': failedCellKeys.has(gridCellKey(worker.id, selectedDate, period)) }]" type="button" :disabled="Boolean(worker.archivedAt)" :aria-label="leaveLabel(leaveValue(worker.id, selectedDate, period)) || `${periodLabel(period)}考勤`" :aria-disabled="leaveValue(worker.id, selectedDate, period) ? 'true' : undefined" @click="leaveValue(worker.id, selectedDate, period) ? emit('leave', worker.id, selectedDate, period) : emit('cycle', worker.id, selectedDate, period)" @contextmenu.prevent="!worker.archivedAt && (leaveValue(worker.id, selectedDate, period) ? emit('leave', worker.id, selectedDate, period) : emit('clear', worker.id, selectedDate, period))">{{ leaveValue(worker.id, selectedDate, period) ? '假' : statusSymbol(statusValue(worker.id, selectedDate, period)) }}</button>
            <button v-if="!worker.archivedAt" class="leave-inline-button" type="button" :aria-label="`${worker.name}${periodLabel(period)}${leaveValue(worker.id, selectedDate, period) ? '调整请假' : '标记请假'}`" @click="emit('leave', worker.id, selectedDate, period)">假</button>
            <select class="compact-select" :value="attendanceFor(worker.id, selectedDate)?.[periodSiteField(period)] ?? ''" :disabled="Boolean(worker.archivedAt) || Boolean(leaveValue(worker.id, selectedDate, period)) || statusValue(worker.id, selectedDate, period) === null || statusValue(worker.id, selectedDate, period) === 'absent'" @change="emit('update-site', worker.id, selectedDate, period, ($event.target as HTMLSelectElement).value)"><option value="">未分配</option><option v-for="site in selectableSitesFor(worker.id, selectedDate, period)" :key="site.id" :value="site.id" :disabled="Boolean(site.archivedAt)">{{ site.name }}{{ site.archivedAt ? '（已归档）' : '' }}</option></select>
          </td>
          <td class="daily-note-cell" :class="{ 'has-save-error': failedDateKeys.has(`${worker.id}|${selectedDate}`) }"><textarea maxlength="1000" :value="attendanceFor(worker.id, selectedDate)?.dayNote ?? ''" :disabled="Boolean(worker.archivedAt)" placeholder="当天说明" @blur="emit('save-note', worker.id, selectedDate, ($event.target as HTMLTextAreaElement).value)"></textarea></td>
          <td><div v-for="item in dailyAdjustments(worker.id)" :key="item.id"><button class="link-button" type="button" :disabled="Boolean(worker.archivedAt)" @click="emit('edit-adjustment', item, worker.id)">{{ item.kind === 'allowance' ? '+' : '−' }}{{ fenToCurrency(item.amountFen) }} {{ item.label }}</button></div><button v-if="!worker.archivedAt" class="link-button" type="button" @click="emit('add-adjustment', worker.id)">＋ 添加</button></td>
        </tr><tr v-if="workers.length === 0"><td colspan="6" class="empty-cell">这一天没有符合筛选条件的工人。</td></tr></tbody>
      </table>
    </div>
  </section>
</template>
