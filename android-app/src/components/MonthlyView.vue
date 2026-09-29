<script setup lang="ts">
import WorkerAvatar from './WorkerAvatar.vue'
import MobileMonthCalendar from './MobileMonthCalendar.vue'
import { periodSiteField } from '../attendance'
import { currentMonth, isValidMonth, monthLabel, type MonthWeek } from '../date'
import { gridCellKey, makeGridCell, type GridCellRef } from '../grid'
import { fenToCurrency } from '../money'
import { formatOvertimeMultiplier } from '../overtime'
import type { MonthlyPayrollSummary } from '../payroll'
import UiIcon from './UiIcon.vue'
import type {
  AttendanceEntry,
  AttendancePeriod,
  AttendanceValue,
  OrdinaryLeave,
  OvertimeLeave,
  PayAdjustment,
  Worker,
} from '../types'

export type InteractionMode = 'single' | 'path' | 'region'

const props = defineProps<{
  worker: Worker
  readOnly: boolean
  payroll: MonthlyPayrollSummary | null
  adjustments: readonly PayAdjustment[]
  selectedMonth: string
  weeks: readonly MonthWeek[]
  headers: readonly string[]
  interactionMode: InteractionMode
  interactionTableClasses: Record<string, boolean>
  gridCursor: GridCellRef | null
  hoveredGridCell: GridCellRef | null
  monthlyRateDraft: string
  monthlyRateError: string
  monthlyOvertimeDraft: string
  monthlyOvertimeError: string
  monthlyNoteDraft: string
  failedCellKeys: ReadonlySet<string>
  failedDateKeys: ReadonlySet<string>
  attendanceFor: (workerId: string, date: string) => AttendanceEntry | undefined
  statusValue: (workerId: string, date: string, period: AttendancePeriod) => AttendanceValue
  leaveValue: (workerId: string, date: string, period: AttendancePeriod) => OrdinaryLeave | OvertimeLeave | null
  siteNameById: (siteId: string | null | undefined) => string
  isPathPreviewCell: (key: string) => boolean
  isRegionSelectedCell: (key: string) => boolean
}>()

const emit = defineEmits<{
  'edit-worker': []
  'switch-month': [delta: number]
  'set-month': [month: string]
  'current-month': []
  'set-mode': [mode: InteractionMode]
  'fill-week': [dates: string[]]
  'mobile-batch': [dates: string[], period: AttendancePeriod, value: AttendanceValue]
  'mobile-batch-leave': [dates: string[], period: AttendancePeriod]
  'open-day': [workerId: string, date: string]
  'clear-hover': []
  'focus-cell': [cell: GridCellRef]
  'pointer-down': [event: PointerEvent, cell: GridCellRef]
  'pointer-enter': [cell: GridCellRef, event: PointerEvent]
  'attendance-click': [cell: GridCellRef]
  'clear-cell': [event: MouseEvent, cell: GridCellRef]
  'leave-cell': [cell: GridCellRef]
  'rate-input': [value: string]
  'rate-blur': []
  'overtime-input': [value: string]
  'overtime-blur': []
  'note-input': [value: string]
  'note-blur': []
  'set-paid': [paid: boolean]
  'add-adjustment': []
  'edit-adjustment': [item: PayAdjustment]
  'remove-adjustment': [item: PayAdjustment]
  'export-monthly': []
  'export-payslip': []
  'print-monthly': []
  'print-payslip': []
  'pdf-payslip': []
  'export-batch': []
  'print-batch': []
  'pdf-batch': []
}>()

const periods: AttendancePeriod[] = ['morning', 'afternoon', 'overtime']
const interactionModes: InteractionMode[] = ['single', 'path', 'region']

function cellRef(date: string, period: AttendancePeriod, row: number, col: number): GridCellRef {
  return makeGridCell(props.worker.id, date, period, row, col)
}

function statusSymbol(value: AttendanceValue): string {
  return value === 'present' || value === 'half' ? '✓' : value === 'absent' ? '×' : value === 'full' ? '✓✓' : ''
}

function statusLabel(value: AttendanceValue): string {
  return value === 'present' ? '出工' : value === 'absent' ? '未出工' : value === 'half' ? '加班半工' : value === 'full' ? '加班一工' : '空白'
}

function leaveLabel(leave: OrdinaryLeave | OvertimeLeave | null): string {
  if (!leave) return ''
  if (leave.payType === 'unpaid') return '无薪请假'
  return 'units' in leave ? `带薪请假（加班${leave.units === 'half' ? '半工' : '一工'}）` : '带薪请假'
}

function modeLabel(mode: InteractionMode): string {
  return mode === 'single' ? '单格' : mode === 'path' ? '路径刷选' : '区域圈选'
}

function cellTabIndex(cell: GridCellRef): number {
  return !props.gridCursor || props.gridCursor.key === cell.key ? 0 : -1
}
</script>

<template>
  <section class="view-panel monthly-view">
    <article class="summary-card">
      <div class="summary-person">
        <WorkerAvatar class="summary-avatar" :worker="worker" :size="64" />
        <div class="summary-person-copy">
          <span class="eyebrow">当前工人</span>
          <div class="person-title-row"><h2>{{ worker.name }}</h2><button class="text-icon-button" type="button" @click="emit('edit-worker')">编辑资料</button></div>
          <p>{{ worker.note || '暂无人员备注' }} · 默认工地：{{ siteNameById(worker.defaultSiteId) }}</p>
        </div>
      </div>
      <div v-if="payroll" class="summary-metrics">
        <div class="metric"><span>上午</span><strong>{{ payroll.morningCount }}</strong><small>次</small></div>
        <div class="metric"><span>下午</span><strong>{{ payroll.afternoonCount }}</strong><small>次</small></div>
        <div class="metric"><span>加班</span><strong>{{ payroll.overtimeHalfDays / 2 }}</strong><small>工</small></div>
        <div class="metric"><span>总工数</span><strong>{{ payroll.workDays }}</strong><small>工</small></div>
        <div class="metric primary-metric" :class="{ 'negative-pay': payroll.netPayFen < 0 }"><span>实发工资</span><strong>{{ fenToCurrency(payroll.netPayFen) }}</strong><small>基础 {{ fenToCurrency(payroll.basePayFen) }}</small></div>
      </div>
    </article>

    <article class="attendance-card">
      <div class="print-heading"><div><h2>{{ worker.name }} · {{ monthLabel(selectedMonth) }}记工表</h2><p>日薪 {{ fenToCurrency(payroll?.dailyRateFen ?? 0) }} · 加班 {{ formatOvertimeMultiplier(payroll?.overtimePayPercent ?? 100) }} · 总工数 {{ payroll?.workDays ?? 0 }} · 实发 {{ fenToCurrency(payroll?.netPayFen ?? 0) }}</p></div></div>
      <div class="calendar-toolbar">
        <div class="month-switcher">
          <button class="round-button" type="button" title="上月 (Ctrl+←)" aria-label="上月" @click="emit('switch-month', -1)"><UiIcon name="chevron-left" /></button>
          <label class="month-picker"><input :value="selectedMonth" type="month" @change="emit('set-month', ($event.target as HTMLInputElement).value)"><strong>{{ monthLabel(isValidMonth(selectedMonth) ? selectedMonth : currentMonth()) }}</strong></label>
          <button class="round-button" type="button" title="下月 (Ctrl+→)" aria-label="下月" @click="emit('switch-month', 1)"><UiIcon name="chevron-right" /></button>
          <button class="button button-ghost today-button" type="button" @click="emit('current-month')">本月</button>
        </div>
        <div class="legend desktop-only"><span><i class="legend-mark present">✓</i>出工</span><span><i class="legend-mark absent">×</i>未出工</span><span><i class="legend-mark overtime-half">✓</i>半工加班</span><span><i class="legend-mark overtime-full">✓✓</i>一工加班</span><span><i class="legend-mark leave">假</i>请假</span></div>
        <div class="interaction-mode-switcher desktop-only" role="group" aria-label="记工操作模式">
          <button v-for="mode in interactionModes" :key="mode" class="interaction-mode-button" :class="{ active: interactionMode === mode }" :data-mode="mode" type="button" :aria-pressed="interactionMode === mode" @click="emit('set-mode', mode)">{{ modeLabel(mode) }}</button>
        </div>
      </div>
      <MobileMonthCalendar
        :worker-id="worker.id"
        :month="selectedMonth"
        :weeks="weeks"
        :headers="headers"
        :read-only="readOnly"
        :failed-date-keys="failedDateKeys"
        :failed-cell-keys="failedCellKeys"
        :attendance-for="attendanceFor"
        :status-value="statusValue"
        :leave-value="leaveValue"
        @open-day="(workerId, date) => emit('open-day', workerId, date)"
        @batch="(dates, period, value) => emit('mobile-batch', dates, period, value)"
        @batch-leave="(dates, period) => emit('mobile-batch-leave', dates, period)"
      />
      <div class="table-scroll desktop-only" tabindex="0" @pointerleave="emit('clear-hover')">
        <table class="attendance-table" :class="interactionTableClasses">
          <thead @pointerenter="emit('clear-hover')"><tr><th class="header-corner">项目</th><th v-for="header in headers" :key="header">周{{ header }}</th></tr></thead>
          <tbody v-for="(week, weekIndex) in weeks" :key="week.key" class="week-group">
            <tr class="date-row" @pointerenter="emit('clear-hover')">
              <th class="row-label"><span>日期</span><button class="week-fill-button" type="button" :disabled="readOnly" @click="emit('fill-week', week.days.flatMap(day => day.iso ? [day.iso] : []))">本周全勤</button></th>
              <td v-for="cell in week.days" :key="cell.iso ?? `${week.key}-empty-${cell.day}`" :class="{ empty: !cell.iso, weekend: cell.isWeekend, today: cell.isToday, future: cell.isFuture }">
                <button v-if="cell.iso" class="date-button" :class="{ 'has-save-error': failedDateKeys.has(`${worker.id}|${cell.iso}`) }" type="button" @click="emit('open-day', worker.id, cell.iso)"><strong>{{ cell.day }}</strong><span v-if="attendanceFor(worker.id, cell.iso)?.dayNote" class="day-note-indicator" title="有单日备注">●</span><small v-if="cell.isToday" class="today-tag">今天</small></button>
              </td>
            </tr>
            <tr v-for="(period, periodIndex) in periods" :key="period" :class="`${period}-row`">
              <th class="row-label" @pointerenter="emit('clear-hover')">{{ period === 'morning' ? '上午' : period === 'afternoon' ? '下午' : '加班' }}</th>
              <td v-for="(cell, weekdayIndex) in week.days" :key="`${period}-${cell.iso}`" class="attendance-cell" :class="{ empty: !cell.iso, today: cell.isToday, future: cell.isFuture }" @pointerenter="cell.iso ? emit('pointer-enter', cellRef(cell.iso, period, weekIndex * 3 + periodIndex, weekdayIndex), $event) : emit('clear-hover')">
                <template v-if="cell.iso">
                  <button
                    class="attendance-button"
                    :class="[
                      `status-${statusValue(worker.id, cell.iso, period) ?? 'blank'}`,
                      {
                        'is-leave': Boolean(leaveValue(worker.id, cell.iso, period)),
                        'is-grid-current': gridCursor?.key === gridCellKey(worker.id, cell.iso, period),
                        'is-grid-hovered': hoveredGridCell?.key === gridCellKey(worker.id, cell.iso, period),
                        'is-path-preview': isPathPreviewCell(gridCellKey(worker.id, cell.iso, period)),
                        'is-region-selected': isRegionSelectedCell(gridCellKey(worker.id, cell.iso, period)),
                        'has-save-error': failedCellKeys.has(gridCellKey(worker.id, cell.iso, period)),
                      },
                    ]"
                    type="button"
                    :disabled="readOnly"
                    :tabindex="cellTabIndex(cellRef(cell.iso, period, weekIndex * 3 + periodIndex, weekdayIndex))"
                    :data-cell-key="gridCellKey(worker.id, cell.iso, period)"
                    :data-worker-id="worker.id"
                    :data-date="cell.iso"
                    :data-period="period"
                    :data-grid-row="weekIndex * 3 + periodIndex"
                    :data-grid-col="weekdayIndex"
                    :aria-label="`${cell.iso} ${period}：${leaveLabel(leaveValue(worker.id, cell.iso, period)) || statusLabel(statusValue(worker.id, cell.iso, period))}`"
                    :aria-disabled="leaveValue(worker.id, cell.iso, period) ? 'true' : undefined"
                    :aria-current="gridCursor?.key === gridCellKey(worker.id, cell.iso, period) ? 'true' : undefined"
                    @focus="emit('focus-cell', cellRef(cell.iso, period, weekIndex * 3 + periodIndex, weekdayIndex))"
                    @pointerdown="emit('pointer-down', $event, cellRef(cell.iso, period, weekIndex * 3 + periodIndex, weekdayIndex))"
                    @pointerenter="emit('pointer-enter', cellRef(cell.iso, period, weekIndex * 3 + periodIndex, weekdayIndex), $event)"
                    @click="emit('attendance-click', cellRef(cell.iso, period, weekIndex * 3 + periodIndex, weekdayIndex))"
                    @contextmenu="emit('clear-cell', $event, cellRef(cell.iso, period, weekIndex * 3 + periodIndex, weekdayIndex))"
                  >{{ leaveValue(worker.id, cell.iso, period) ? '假' : statusSymbol(statusValue(worker.id, cell.iso, period)) }}</button>
                  <span v-if="statusValue(worker.id, cell.iso, period) === 'present' || statusValue(worker.id, cell.iso, period) === 'half' || statusValue(worker.id, cell.iso, period) === 'full'" class="site-badge" :title="siteNameById(attendanceFor(worker.id, cell.iso)?.[periodSiteField(period)])">{{ siteNameById(attendanceFor(worker.id, cell.iso)?.[periodSiteField(period)]).slice(0, 4) }}</span>
                  <button class="leave-cell-button" type="button" :disabled="readOnly" :title="leaveValue(worker.id, cell.iso, period) ? '查看或取消请假' : '标记请假'" :aria-label="`${cell.iso} ${period} ${leaveValue(worker.id, cell.iso, period) ? '查看或取消请假' : '标记请假'}`" @click.stop="emit('leave-cell', cellRef(cell.iso, period, weekIndex * 3 + periodIndex, weekdayIndex))">假</button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>

    <div class="detail-grid">
      <label class="form-field"><span>本月日薪</span><div class="money-input large"><span>¥</span><input :value="monthlyRateDraft" inputmode="decimal" :disabled="readOnly" aria-label="本月日薪" @input="emit('rate-input', ($event.target as HTMLInputElement).value)" @blur="emit('rate-blur')"></div><small>从 {{ monthLabel(selectedMonth) }} 起沿用，直到再次修改；工资按分精确计算。</small><small v-if="monthlyRateError" class="form-error">{{ monthlyRateError }}</small></label>
      <label class="form-field"><span>本月加班倍率</span><div class="multiplier-input"><input :value="monthlyOvertimeDraft" inputmode="decimal" :disabled="readOnly" aria-label="本月加班倍率" @input="emit('overtime-input', ($event.target as HTMLInputElement).value)" @blur="emit('overtime-blur')"><span>倍</span></div><small>只影响工资计算，不改变工数与工地统计。</small><small v-if="monthlyOvertimeError" class="form-error">{{ monthlyOvertimeError }}</small></label>
      <label class="form-field"><span>本月备注</span><textarea maxlength="1000" :value="monthlyNoteDraft" :disabled="readOnly" aria-label="本月备注" placeholder="例如：本月结算说明…" @input="emit('note-input', ($event.target as HTMLTextAreaElement).value)" @blur="emit('note-blur')"></textarea></label>
    </div>

    <section class="settlement-card" :class="{ 'is-paid': Boolean(payroll?.paidAt) }">
      <div><span class="eyebrow">发薪状态</span><h2>{{ payroll?.paidAt ? '已结清' : '尚未结清' }}</h2><p v-if="payroll?.paidAt">结清时间：{{ new Date(payroll.paidAt).toLocaleString('zh-CN') }}。后续修改不会自动取消标记，请注意核对金额。</p><p v-else>结算完成后可标记，工资数据仍可继续修改。</p></div>
      <button v-if="!readOnly" class="button" :class="payroll?.paidAt ? 'button-ghost' : 'button-primary'" type="button" @click="emit('set-paid', !payroll?.paidAt)">{{ payroll?.paidAt ? '取消结清' : '标记已结清' }}</button>
    </section>

    <section class="adjustment-section">
      <div class="section-toolbar"><div><span class="eyebrow">补贴与扣款</span><h2>本月明细</h2></div><button v-if="!readOnly" class="button button-primary" type="button" @click="emit('add-adjustment')">新增一笔</button></div>
      <div v-if="adjustments.length" class="adjustment-list">
        <article v-for="item in adjustments" :key="item.id" class="adjustment-card" :class="`is-${item.kind}`">
          <div><span class="adjustment-badge">{{ item.kind === 'allowance' ? '补贴' : '扣款' }}</span><h3>{{ item.label }}</h3><p>{{ item.date || '整月' }} · {{ item.note || '无备注' }}</p></div>
          <strong class="adjustment-amount" :class="`is-${item.kind}`">{{ item.kind === 'allowance' ? '+' : '−' }}{{ fenToCurrency(item.amountFen) }}</strong>
          <div v-if="!readOnly" class="adjustment-card-actions"><button class="link-button" type="button" @click="emit('edit-adjustment', item)">编辑</button><button class="link-button" type="button" @click="emit('remove-adjustment', item)">删除</button></div>
        </article>
      </div>
      <p v-else class="empty-list">本月还没有补贴或扣款。</p>
    </section>

    <section v-if="payroll?.siteBreakdown.length" class="content-card">
      <div class="section-toolbar"><h2>实际工地工数</h2></div>
      <div class="site-totals"><div v-for="site in payroll.siteBreakdown" :key="site.siteId ?? 'none'" class="site-total"><span>{{ site.siteName }}</span><strong>{{ site.workDays }} 工</strong></div></div>
    </section>

    <footer class="record-footer">
      <div class="footer-totals"><span>基础 {{ fenToCurrency(payroll?.basePayFen ?? 0) }}</span><span>补贴 +{{ fenToCurrency(payroll?.allowanceFen ?? 0) }}</span><span>扣款 −{{ fenToCurrency(payroll?.deductionFen ?? 0) }}</span><strong :class="{ 'negative-pay': (payroll?.netPayFen ?? 0) < 0 }">实发 {{ fenToCurrency(payroll?.netPayFen ?? 0) }}</strong></div>
      <div class="footer-actions"><button class="button button-secondary" type="button" @click="emit('export-monthly')">导出月表 Excel</button><button class="button button-secondary" type="button" @click="emit('export-payslip')">工资条 Excel</button><button class="button button-ghost" type="button" @click="emit('print-monthly')">打印月表</button><button class="button button-ghost" type="button" @click="emit('print-payslip')">打印工资条</button><button class="button button-ghost" type="button" @click="emit('pdf-payslip')">工资条 PDF</button><button class="button button-ghost" type="button" @click="emit('export-batch')">批量工资条 Excel</button><button class="button button-ghost" type="button" @click="emit('print-batch')">批量打印</button><button class="button button-ghost" type="button" @click="emit('pdf-batch')">批量 PDF</button></div>
    </footer>
  </section>
</template>
