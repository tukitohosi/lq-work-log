<script setup lang="ts">
import { computed, ref } from 'vue'
import { monthLabel, shiftMonth } from '../date'
import { fenToCurrency } from '../money'
import type {
  SiteStatisticsBucketKind,
  SiteStatisticsSummary,
} from '../site-statistics'

const props = withDefaults(defineProps<{
  summary: SiteStatisticsSummary | null
  mode: 'month' | 'year'
  selectedMonth: string
  selectedYear: string
  loading?: boolean
  exporting?: boolean
}>(), {
  loading: false,
  exporting: false,
})

const emit = defineEmits<{
  'update:mode': [value: 'month' | 'year']
  'update:selectedMonth': [value: string]
  'update:selectedYear': [value: string]
  'current-period': []
  export: []
}>()

const expandedRows = ref<Set<string>>(new Set())

const selectedPeriodLabel = computed(() => props.mode === 'month'
  ? monthLabel(props.selectedMonth)
  : `${props.selectedYear}年度`)

function setMode(mode: 'month' | 'year'): void {
  if (mode !== props.mode) emit('update:mode', mode)
}

function navigatePeriod(delta: -1 | 1): void {
  if (props.mode === 'month') {
    emit('update:selectedMonth', shiftMonth(props.selectedMonth, delta))
    return
  }
  const year = Number(props.selectedYear)
  if (!Number.isInteger(year)) return
  emit('update:selectedYear', String(Math.min(2200, Math.max(1900, year + delta))))
}

function updateYear(value: string): void {
  if (/^\d{4}$/.test(value)) emit('update:selectedYear', value)
}

function toggleRow(key: string): void {
  const next = new Set(expandedRows.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedRows.value = next
}

function isExpanded(key: string): boolean {
  return expandedRows.value.has(key)
}

function detailsId(key: string): string {
  return `site-statistics-detail-${encodeURIComponent(key).replace(/%/g, '-')}`
}

function formatWorkDays(value: number): string {
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)} 工`
}

function bucketLabel(kind: SiteStatisticsBucketKind): string {
  if (kind === 'site') return '实际工地'
  if (kind === 'unassigned-work') return '未分配工地'
  if (kind === 'paid-leave') return '带薪假'
  if (kind === 'unpaid-leave') return '无薪假'
  return '未归属调整'
}

function bucketTone(kind: SiteStatisticsBucketKind): string {
  if (kind === 'site') return 'site'
  if (kind === 'paid-leave') return 'paid-leave'
  if (kind === 'unpaid-leave') return 'unpaid-leave'
  return 'unassigned'
}
</script>

<template>
  <section class="site-statistics-view view-panel" aria-labelledby="site-statistics-title">
    <header class="site-statistics-header">
      <div>
        <span class="eyebrow">按实际出工归属</span>
        <h2 id="site-statistics-title">{{ selectedPeriodLabel }}工地统计</h2>
        <p>人数按工地去重，人次按“工地＋工人＋日期”去重；同日跨工地分别计 1 人次。</p>
      </div>
      <button
        class="button button-secondary site-statistics-export"
        type="button"
        :disabled="loading || exporting || !summary"
        @click="emit('export')"
      >
        {{ exporting ? '正在生成…' : '导出工地 Excel' }}
      </button>
    </header>

    <div class="site-statistics-controls" aria-label="工地统计周期">
      <div class="site-statistics-mode" role="group" aria-label="统计周期模式">
        <button
          type="button"
          :class="{ active: mode === 'month' }"
          :aria-pressed="mode === 'month'"
          @click="setMode('month')"
        >月度</button>
        <button
          type="button"
          :class="{ active: mode === 'year' }"
          :aria-pressed="mode === 'year'"
          @click="setMode('year')"
        >年度</button>
      </div>
      <div class="site-statistics-period-nav">
        <button type="button" aria-label="上一个统计周期" @click="navigatePeriod(-1)">←</button>
        <input
          v-if="mode === 'month'"
          :value="selectedMonth"
          type="month"
          min="1900-01"
          max="2200-12"
          aria-label="统计月份"
          @input="emit('update:selectedMonth', ($event.target as HTMLInputElement).value)"
        >
        <input
          v-else
          :value="selectedYear"
          type="number"
          min="1900"
          max="2200"
          inputmode="numeric"
          aria-label="统计年份"
          @input="updateYear(($event.target as HTMLInputElement).value)"
        >
        <button type="button" aria-label="下一个统计周期" @click="navigatePeriod(1)">→</button>
        <button class="current-period-button" type="button" @click="emit('current-period')">当前周期</button>
      </div>
    </div>

    <div v-if="summary" class="site-statistics-cards" aria-label="统计总览">
      <article>
        <span>实际出工人数</span>
        <strong>{{ summary.totals.workerCount }} 人</strong>
        <small>请假和仅有调整的工人不计入</small>
      </article>
      <article>
        <span>工地人次</span>
        <strong>{{ summary.totals.personTimes }} 人次</strong>
        <small>同一工地同一天最多计 1 次</small>
      </article>
      <article>
        <span>实际总工数</span>
        <strong>{{ formatWorkDays(summary.totals.workDays) }}</strong>
        <small>上午、下午、加班均按实际工数</small>
      </article>
      <article>
        <span>完整成本</span>
        <strong :class="{ negative: summary.totals.netCostFen < 0 }">{{ fenToCurrency(summary.totals.netCostFen) }}</strong>
        <small>基础工资＋补贴－扣款</small>
      </article>
      <article class="leave-card">
        <span>请假记录</span>
        <strong>带薪 {{ summary.totals.paidLeavePeriods }} / 无薪 {{ summary.totals.unpaidLeavePeriods }}</strong>
        <small>请假不计人数、人次和实际工数</small>
      </article>
    </div>

    <div v-if="loading" class="site-statistics-state" role="status" aria-live="polite">正在计算工地统计…</div>
    <div v-else-if="!summary || !summary.rows.length" class="site-statistics-state" role="status">当前周期没有工地、请假或调整数据。</div>
    <div v-else class="site-statistics-table-wrap desktop-table">
      <table class="site-statistics-table">
        <caption>工地统计明细；点击每行展开对应工人明细</caption>
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">展开</span></th>
            <th scope="col">工地 / 成本桶</th>
            <th scope="col">人数</th>
            <th scope="col">人次</th>
            <th scope="col">上午</th>
            <th scope="col">下午</th>
            <th scope="col">加班</th>
            <th scope="col">总工数</th>
            <th scope="col">基础工资</th>
            <th scope="col">补贴</th>
            <th scope="col">扣款</th>
            <th scope="col">完整成本</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in summary.rows" :key="row.key">
            <tr class="site-statistics-row" :class="{ 'is-expanded': isExpanded(row.key) }">
              <td>
                <button
                  class="expand-button"
                  type="button"
                  :aria-label="`${isExpanded(row.key) ? '收起' : '展开'}${row.siteName}工人明细`"
                  :aria-expanded="isExpanded(row.key)"
                  :aria-controls="detailsId(row.key)"
                  @click="toggleRow(row.key)"
                >{{ isExpanded(row.key) ? '−' : '+' }}</button>
              </td>
              <th scope="row" class="site-name-cell">
                <span>{{ row.siteName }}</span>
                <span class="bucket-badges">
                  <small class="bucket-badge" :data-tone="bucketTone(row.bucketKind)">{{ bucketLabel(row.bucketKind) }}</small>
                  <small v-if="row.archived" class="bucket-badge" data-tone="archived">已归档</small>
                </span>
              </th>
              <td>{{ row.workerCount }} 人</td>
              <td>{{ row.personTimes }} 人次</td>
              <td>{{ formatWorkDays(row.morningHalfDays / 2) }}</td>
              <td>{{ formatWorkDays(row.afternoonHalfDays / 2) }}</td>
              <td>{{ formatWorkDays(row.overtimeHalfDays / 2) }}</td>
              <td><strong>{{ formatWorkDays(row.workDays) }}</strong></td>
              <td>{{ fenToCurrency(row.basePayFen) }}</td>
              <td class="positive">{{ fenToCurrency(row.allowanceFen) }}</td>
              <td class="deduction">{{ fenToCurrency(row.deductionFen) }}</td>
              <td :class="{ negative: row.netCostFen < 0 }"><strong>{{ fenToCurrency(row.netCostFen) }}</strong></td>
            </tr>
            <tr v-if="isExpanded(row.key)" :id="detailsId(row.key)" class="site-worker-detail-row">
              <td colspan="12">
                <div v-if="row.workers.length" class="site-worker-grid">
                  <article v-for="worker in row.workers" :key="worker.workerId" class="site-worker-card">
                    <header>
                      <strong>{{ worker.workerName }}</strong>
                      <span>{{ worker.personTimes }} 人次 · {{ formatWorkDays(worker.workDays) }}</span>
                    </header>
                    <dl>
                      <div><dt>上午 / 下午 / 加班</dt><dd>{{ formatWorkDays(worker.morningHalfDays / 2) }} / {{ formatWorkDays(worker.afternoonHalfDays / 2) }} / {{ formatWorkDays(worker.overtimeHalfDays / 2) }}</dd></div>
                      <div v-if="worker.paidLeavePeriods || worker.unpaidLeavePeriods"><dt>带薪 / 无薪假</dt><dd>{{ worker.paidLeavePeriods }} / {{ worker.unpaidLeavePeriods }} 次</dd></div>
                      <div><dt>基础工资</dt><dd>{{ fenToCurrency(worker.basePayFen) }}</dd></div>
                      <div><dt>补贴 / 扣款</dt><dd>+{{ fenToCurrency(worker.allowanceFen) }} / −{{ fenToCurrency(worker.deductionFen) }}</dd></div>
                      <div><dt>完整成本</dt><dd :class="{ negative: worker.netCostFen < 0 }">{{ fenToCurrency(worker.netCostFen) }}</dd></div>
                    </dl>
                  </article>
                </div>
                <p v-else class="site-worker-empty">此项目在当前周期没有工人明细。</p>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div v-if="!loading && summary?.rows.length" class="mobile-only mobile-site-list" aria-label="工地成本明细">
      <article v-for="row in summary.rows" :key="row.key" class="mobile-site-card">
        <button class="mobile-site-toggle" type="button" :aria-expanded="isExpanded(row.key)" :aria-controls="`${detailsId(row.key)}-mobile`" @click="toggleRow(row.key)">
          <strong>{{ row.siteName }}</strong>
          <span class="bucket-badges"><small class="bucket-badge" :data-tone="bucketTone(row.bucketKind)">{{ bucketLabel(row.bucketKind) }}</small><small v-if="row.archived" class="bucket-badge" data-tone="archived">已归档</small></span>
          <span>{{ row.workerCount }} 人 · {{ row.personTimes }} 人次 · {{ formatWorkDays(row.workDays) }}</span>
          <span :class="{ negative: row.netCostFen < 0 }">完整成本 <b>{{ fenToCurrency(row.netCostFen) }}</b></span>
          <small>{{ isExpanded(row.key) ? '收起明细 ↑' : '展开工数、费用及工人明细 ↓' }}</small>
        </button>
        <div v-if="isExpanded(row.key)" :id="`${detailsId(row.key)}-mobile`" class="mobile-site-details">
          <dl class="mobile-report-metrics">
            <div><dt>上午</dt><dd>{{ formatWorkDays(row.morningHalfDays / 2) }}</dd></div><div><dt>下午</dt><dd>{{ formatWorkDays(row.afternoonHalfDays / 2) }}</dd></div><div><dt>加班</dt><dd>{{ formatWorkDays(row.overtimeHalfDays / 2) }}</dd></div><div><dt>基础工资</dt><dd>{{ fenToCurrency(row.basePayFen) }}</dd></div><div><dt>补贴</dt><dd class="positive">+{{ fenToCurrency(row.allowanceFen) }}</dd></div><div><dt>扣款</dt><dd class="deduction">−{{ fenToCurrency(row.deductionFen) }}</dd></div><div v-if="row.paidLeavePeriods || row.unpaidLeavePeriods"><dt>带薪 / 无薪假</dt><dd>{{ row.paidLeavePeriods }} / {{ row.unpaidLeavePeriods }} 次</dd></div>
          </dl>
          <div v-if="row.workers.length" class="site-worker-grid">
            <article v-for="worker in row.workers" :key="worker.workerId" class="site-worker-card">
              <header><strong>{{ worker.workerName }}</strong><span>{{ worker.personTimes }} 人次 · {{ formatWorkDays(worker.workDays) }}</span></header>
              <dl><div><dt>上午 / 下午 / 加班</dt><dd>{{ formatWorkDays(worker.morningHalfDays / 2) }} / {{ formatWorkDays(worker.afternoonHalfDays / 2) }} / {{ formatWorkDays(worker.overtimeHalfDays / 2) }}</dd></div><div v-if="worker.paidLeavePeriods || worker.unpaidLeavePeriods"><dt>带薪 / 无薪假</dt><dd>{{ worker.paidLeavePeriods }} / {{ worker.unpaidLeavePeriods }} 次</dd></div><div><dt>基础工资</dt><dd>{{ fenToCurrency(worker.basePayFen) }}</dd></div><div><dt>补贴 / 扣款</dt><dd>+{{ fenToCurrency(worker.allowanceFen) }} / −{{ fenToCurrency(worker.deductionFen) }}</dd></div><div><dt>完整成本</dt><dd :class="{ negative: worker.netCostFen < 0 }">{{ fenToCurrency(worker.netCostFen) }}</dd></div></dl>
            </article>
          </div>
          <p v-else class="site-worker-empty">此项目在当前周期没有工人明细。</p>
        </div>
      </article>
    </div>

    <aside class="site-statistics-footnote">
      <strong>口径说明</strong>
      <span>带薪假工资单列到“带薪假”成本桶；无工地出工及未归属调整分别列示。各行完整成本合计与工资台账逐分一致。</span>
    </aside>
  </section>
</template>

<style scoped>
.site-statistics-view {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
}

.site-statistics-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.site-statistics-header h2 {
  margin: 4px 0 6px;
}

.site-statistics-header p,
.site-statistics-footnote,
.site-statistics-cards small {
  color: var(--text-muted, #687080);
}

.site-statistics-header p {
  max-width: 720px;
  margin: 0;
  line-height: 1.55;
}

.site-statistics-export {
  flex: 0 0 auto;
}

.site-statistics-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px;
  border: 1px solid var(--border-color, #dfe3ea);
  border-radius: 14px;
  background: var(--surface-subtle, rgba(127, 127, 127, 0.06));
}

.site-statistics-mode,
.site-statistics-period-nav {
  display: flex;
  align-items: center;
  gap: 6px;
}

.site-statistics-mode button,
.site-statistics-period-nav button,
.site-statistics-period-nav input {
  min-height: 38px;
  border: 1px solid var(--border-color, #d7dce5);
  border-radius: 10px;
  background: var(--surface, #fff);
  color: inherit;
  font: inherit;
}

.site-statistics-mode button,
.site-statistics-period-nav button {
  padding: 0 13px;
  cursor: pointer;
}

.site-statistics-mode button.active {
  border-color: var(--accent, #4c6fff);
  background: var(--accent, #4c6fff);
  color: #fff;
}

.site-statistics-period-nav input {
  width: 142px;
  padding: 0 10px;
}

.current-period-button {
  white-space: nowrap;
}

.site-statistics-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.site-statistics-cards article {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border-color, #dfe3ea);
  border-radius: 14px;
  background: var(--surface, #fff);
}

.site-statistics-cards .leave-card {
  grid-column: span 2;
}

.site-statistics-cards span {
  color: var(--text-muted, #687080);
  font-size: .86rem;
}

.site-statistics-cards strong {
  font-size: clamp(1.08rem, 2vw, 1.45rem);
  overflow-wrap: anywhere;
}

.site-statistics-table-wrap {
  min-width: 0;
  overflow-x: auto;
  border: 1px solid var(--border-color, #dfe3ea);
  border-radius: 14px;
  background: var(--surface, #fff);
}

.site-statistics-table {
  width: 100%;
  min-width: 1080px;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}

.site-statistics-table caption {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.site-statistics-table th,
.site-statistics-table td {
  padding: 12px 10px;
  border-bottom: 1px solid var(--border-color, #e5e8ee);
  text-align: right;
  white-space: nowrap;
}

.site-statistics-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-subtle, #f6f7fa);
  color: var(--text-muted, #687080);
  font-size: .8rem;
}

.site-statistics-table th:first-child,
.site-statistics-table td:first-child,
.site-statistics-table th:nth-child(2),
.site-statistics-table td:nth-child(2) {
  text-align: left;
}

.site-statistics-row:hover,
.site-statistics-row.is-expanded {
  background: var(--surface-subtle, rgba(127, 127, 127, 0.06));
}

.expand-button {
  width: 30px;
  height: 30px;
  border: 1px solid var(--border-color, #d7dce5);
  border-radius: 9px;
  background: var(--surface, #fff);
  color: inherit;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.site-name-cell > span:first-child {
  display: block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bucket-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 5px;
}

.bucket-badge {
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(76, 111, 255, .12);
  color: var(--accent, #3858d6);
  font-weight: 650;
}

.bucket-badge[data-tone="paid-leave"] { background: rgba(203, 137, 25, .15); color: #9a6511; }
.bucket-badge[data-tone="unpaid-leave"] { background: rgba(112, 121, 139, .16); color: #596171; }
.bucket-badge[data-tone="unassigned"] { background: rgba(146, 93, 174, .14); color: #7c4598; }
.bucket-badge[data-tone="archived"] { background: rgba(112, 121, 139, .16); color: #596171; }

.site-worker-detail-row td {
  padding: 14px;
  background: var(--surface-subtle, #f7f8fa);
  white-space: normal;
}

.site-worker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
}

.site-worker-card {
  padding: 13px;
  border: 1px solid var(--border-color, #dfe3ea);
  border-radius: 12px;
  background: var(--surface, #fff);
}

.site-worker-card header {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 9px;
}

.site-worker-card header span {
  color: var(--text-muted, #687080);
  font-size: .82rem;
}

.site-worker-card dl,
.site-worker-card dl div {
  display: grid;
  gap: 5px;
  margin: 0;
}

.site-worker-card dl div {
  grid-template-columns: minmax(120px, 1fr) auto;
  padding: 5px 0;
  border-top: 1px dashed var(--border-color, #dfe3ea);
}

.site-worker-card dt { color: var(--text-muted, #687080); }
.site-worker-card dd { margin: 0; text-align: right; font-weight: 600; }

.site-statistics-state,
.site-statistics-footnote {
  padding: 20px;
  border: 1px dashed var(--border-color, #d7dce5);
  border-radius: 14px;
  text-align: center;
}

.site-statistics-footnote {
  display: flex;
  align-items: baseline;
  gap: 10px;
  text-align: left;
  font-size: .86rem;
  line-height: 1.55;
}

.site-statistics-footnote strong { color: var(--text, inherit); white-space: nowrap; }
.positive { color: var(--positive, #27845a); }
.deduction,
.negative { color: var(--danger, #bf3c48); }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 900px) {
  .site-statistics-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .site-statistics-header { align-items: stretch; }
}

@media screen and (max-width: 760px) {
  .site-statistics-header,
  .site-statistics-controls,
  .site-statistics-footnote {
    align-items: stretch;
    flex-direction: column;
  }

  .site-statistics-export { width: 100%; }
  .site-statistics-mode { display: grid; grid-template-columns: 1fr 1fr; }
  .site-statistics-period-nav { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; }
  .site-statistics-period-nav input { width: 100%; min-width: 0; }
  .current-period-button { grid-column: 1 / -1; }
  .site-statistics-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .site-statistics-cards article { padding: 12px; }
  .site-statistics-cards .leave-card { grid-column: 1 / -1; }
  .site-worker-grid { grid-template-columns: 1fr; }
  .site-worker-card header { flex-direction: column; }
  .site-worker-card,
  .site-statistics-header > div { min-width: 0; overflow-wrap: anywhere; }
  .site-worker-card dl div { grid-template-columns: minmax(0, 1fr); }
  .site-worker-card dd { text-align: left; overflow-wrap: anywhere; }
  .site-statistics-mode button,
  .site-statistics-period-nav button,
  .site-statistics-period-nav input { min-height: 44px; }
  .mobile-site-list { display: grid; gap: 12px; }
  .mobile-site-card { min-width: 0; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
  .mobile-site-toggle { display: grid; gap: 7px; width: 100%; min-width: 0; padding: 14px; border: 0; border-radius: 13px; color: inherit; background: transparent; text-align: left; overflow-wrap: anywhere; }
  .mobile-site-toggle > strong { font-size: 17px; }
  .mobile-site-toggle > small { color: var(--green); }
  .mobile-site-details { display: grid; gap: 12px; padding: 0 12px 12px; }
}

@media print {
  .site-statistics-controls,
  .site-statistics-export,
  .expand-button { display: none !important; }
  .site-statistics-table-wrap { overflow: visible; border: 0; }
  .site-statistics-table { min-width: 0; font-size: 9pt; }
  .site-statistics-table th,
  .site-statistics-table td { padding: 5px 3px; }
}
</style>
