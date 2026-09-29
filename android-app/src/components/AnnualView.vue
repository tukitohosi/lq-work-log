<script setup lang="ts">
import AnnualBarChart from './AnnualBarChart.vue'
import { fenToCurrency } from '../money'
import { formatOvertimeMultiplier } from '../overtime'
import type { AnnualPayrollSummary } from '../payroll'
import type { AppData } from '../types'

defineProps<{
  data: AppData
  summary: AnnualPayrollSummary | null
  selectedYear: string
  workerFilter: string
  siteFilter: string
  paidFilter: 'all' | 'paid' | 'unpaid'
  metric: 'work' | 'pay'
}>()

const emit = defineEmits<{
  'update:selectedYear': [value: string]
  'update:workerFilter': [value: string]
  'update:siteFilter': [value: string]
  'update:paidFilter': [value: 'all' | 'paid' | 'unpaid']
  'update:metric': [value: 'work' | 'pay']
  export: []
  print: []
  pdf: []
}>()
</script>

<template>
  <section class="annual-summary view-panel">
    <div class="annual-toolbar"><div><span class="eyebrow">全年数据</span><h2>{{ selectedYear }} 年度汇总</h2></div><div class="toolbar-actions"><button class="button button-secondary" type="button" @click="emit('export')">年度 Excel</button><button class="button button-ghost" type="button" @click="emit('print')">打印</button><button class="button button-ghost" type="button" @click="emit('pdf')">PDF</button></div></div>
    <div class="filter-bar">
      <label class="filter-field"><span>年份</span><input :value="selectedYear" type="number" min="1900" max="2200" @input="emit('update:selectedYear', ($event.target as HTMLInputElement).value)"></label>
      <label class="filter-field"><span>工人</span><select :value="workerFilter" @change="emit('update:workerFilter', ($event.target as HTMLSelectElement).value)"><option value="all">全部工人</option><option v-for="worker in data.workers" :key="worker.id" :value="worker.id">{{ worker.name }}{{ worker.archivedAt ? '（已归档）' : '' }}</option></select></label>
      <label class="filter-field"><span>默认工地</span><select :value="siteFilter" @change="emit('update:siteFilter', ($event.target as HTMLSelectElement).value)"><option value="all">全部</option><option value="unassigned">未分配</option><option v-for="site in data.sites" :key="site.id" :value="site.id">{{ site.name }}</option></select></label>
      <label class="filter-field"><span>结清情况</span><select :value="paidFilter" @change="emit('update:paidFilter', ($event.target as HTMLSelectElement).value as 'all' | 'paid' | 'unpaid')"><option value="all">全部</option><option value="paid">已全部结清</option><option value="unpaid">有未结清</option></select></label>
      <label class="filter-field"><span>指标</span><select :value="metric" @change="emit('update:metric', ($event.target as HTMLSelectElement).value as 'work' | 'pay')"><option value="work">工数</option><option value="pay">实发工资</option></select></label>
    </div>
    <div v-if="summary" class="annual-stats"><div class="stat-card"><span>年度工数</span><strong>{{ summary.totals.workDays }}</strong></div><div class="stat-card"><span>基础工资</span><strong>{{ fenToCurrency(summary.totals.basePayFen) }}</strong></div><div class="stat-card"><span>补贴 / 扣款</span><strong>+{{ fenToCurrency(summary.totals.allowanceFen) }} / −{{ fenToCurrency(summary.totals.deductionFen) }}</strong></div><div class="stat-card"><span>年度实发</span><strong :class="{ 'negative-pay': summary.totals.netPayFen < 0 }">{{ fenToCurrency(summary.totals.netPayFen) }}</strong></div></div>
    <AnnualBarChart class="annual-chart-card" :summary="summary" :metric="metric" />
    <div class="mobile-only mobile-annual-list" aria-label="按工人查看年度明细">
      <details v-for="row in summary?.rows" :key="row.worker.id" class="mobile-annual-worker">
        <summary><strong>{{ row.worker.name }}</strong><span>{{ row.totals.workDays }} 工 · {{ fenToCurrency(row.totals.netPayFen) }}</span><small>展开 12 个月明细</small></summary>
        <dl class="mobile-report-metrics">
          <div><dt>年度工数</dt><dd>{{ row.totals.workDays }} 工</dd></div><div><dt>基础工资</dt><dd>{{ fenToCurrency(row.totals.basePayFen) }}</dd></div><div><dt>补贴</dt><dd class="positive-pay">+{{ fenToCurrency(row.totals.allowanceFen) }}</dd></div><div><dt>扣款</dt><dd class="negative-pay">−{{ fenToCurrency(row.totals.deductionFen) }}</dd></div><div><dt>年度实发</dt><dd :class="{ 'negative-pay': row.totals.netPayFen < 0 }">{{ fenToCurrency(row.totals.netPayFen) }}</dd></div>
        </dl>
        <ol class="mobile-annual-months">
          <li v-for="month in row.months" :key="month.month">
            <header><strong>{{ Number(month.month.slice(5)) }} 月</strong><span>{{ month.paidAt ? '已结清' : '未结清' }}</span></header>
            <dl class="mobile-report-metrics"><div><dt>工数</dt><dd>{{ month.workDays }} 工</dd></div><div><dt>实发</dt><dd :class="{ 'negative-pay': month.netPayFen < 0 }">{{ fenToCurrency(month.netPayFen) }}</dd></div><div><dt>基础工资</dt><dd>{{ fenToCurrency(month.basePayFen) }}</dd></div><div><dt>补贴 / 扣款</dt><dd>+{{ fenToCurrency(month.allowanceFen) }} / −{{ fenToCurrency(month.deductionFen) }}</dd></div></dl>
            <small>加班 {{ month.overtimeHalfDays / 2 }} 工 · {{ formatOvertimeMultiplier(month.overtimePayPercent) }}</small>
          </li>
        </ol>
      </details>
      <p v-if="!summary?.rows.length" class="empty-list">没有符合筛选条件的数据。</p>
    </div>
    <div class="annual-table-wrap desktop-table"><table class="annual-table"><thead><tr><th>工人</th><th v-for="month in summary?.months" :key="month">{{ Number(month.slice(5)) }}月</th><th>年度工数</th><th>基础工资</th><th>补贴</th><th>扣款</th><th>实发</th></tr></thead><tbody><tr v-for="row in summary?.rows" :key="row.worker.id"><td class="worker-cell">{{ row.worker.name }}</td><td v-for="month in row.months" :key="month.month"><span>{{ metric === 'work' ? month.workDays : fenToCurrency(month.netPayFen) }}</span><template v-if="month.overtimeHalfDays > 0 || month.hasMonthlyRecord"><br><small>加班 {{ formatOvertimeMultiplier(month.overtimePayPercent) }}</small></template></td><td><strong>{{ row.totals.workDays }}</strong></td><td>{{ fenToCurrency(row.totals.basePayFen) }}</td><td class="positive-pay">{{ fenToCurrency(row.totals.allowanceFen) }}</td><td class="negative-pay">{{ fenToCurrency(row.totals.deductionFen) }}</td><td :class="{ 'negative-pay': row.totals.netPayFen < 0 }"><strong>{{ fenToCurrency(row.totals.netPayFen) }}</strong></td></tr><tr v-if="!summary?.rows.length"><td colspan="18" class="empty-cell">没有符合筛选条件的数据。</td></tr></tbody></table></div>
  </section>
</template>
