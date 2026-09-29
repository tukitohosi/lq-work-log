<script setup lang="ts">
import { fenToCurrency } from '../money'
import { formatOvertimeMultiplier } from '../overtime'
import type { PayslipData } from '../payroll'

defineProps<{ slip: PayslipData }>()
</script>

<template>
  <article class="payslip-sheet">
    <header class="payslip-header">
      <div><h2>L.Q记工本 · 工资条</h2><p>{{ slip.month }} · {{ slip.worker.name }}</p></div>
      <div class="payslip-heading-total"><span class="settlement-stamp" :class="{ 'is-paid': slip.paidAt }">{{ slip.paidAt ? '已结清' : '未结清' }}</span><strong>{{ fenToCurrency(slip.payroll.netPayFen) }}</strong></div>
    </header>
    <div class="payslip-summary">
      <div><span>日薪</span><strong>{{ fenToCurrency(slip.payroll.dailyRateFen) }}</strong></div>
      <div><span>普通工数</span><strong>{{ slip.ordinaryWorkDays }}</strong></div>
      <div><span>加班工数 · {{ formatOvertimeMultiplier(slip.payroll.overtimePayPercent) }}</span><strong>{{ slip.overtimeWorkDays }}</strong></div>
      <div><span>基础工资</span><strong>{{ fenToCurrency(slip.payroll.basePayFen) }}</strong></div>
    </div>
    <table class="payslip-details">
      <thead><tr><th>项目</th><th>说明</th><th>金额 / 工数</th></tr></thead>
      <tbody>
        <tr v-for="site in slip.siteBreakdown" :key="site.siteId ?? 'none'"><td>工地工数</td><td>{{ site.siteName }}</td><td>{{ site.workDays }} 工</td></tr>
        <tr v-for="item in slip.adjustments" :key="item.id"><td>{{ item.kind === 'allowance' ? '补贴' : '扣款' }}</td><td>{{ item.label }}{{ item.date ? `（${item.date}）` : '' }}</td><td :class="item.kind === 'allowance' ? 'positive-pay' : 'negative-pay'">{{ item.kind === 'allowance' ? '+' : '−' }}{{ fenToCurrency(item.amountFen) }}</td></tr>
        <tr v-if="!slip.siteBreakdown.length && !slip.adjustments.length"><td colspan="3">本月无工地或调整明细</td></tr>
      </tbody>
    </table>
    <footer class="payslip-footer"><span>基础 {{ fenToCurrency(slip.payroll.basePayFen) }} · 补贴 {{ fenToCurrency(slip.payroll.allowanceFen) }} · 扣款 {{ fenToCurrency(slip.payroll.deductionFen) }}<template v-if="slip.paidAt"> · 结清于 {{ new Date(slip.paidAt).toLocaleString('zh-CN') }}</template></span><strong class="payslip-net-pay" :class="{ 'negative-pay': slip.payroll.netPayFen < 0 }">实发 {{ fenToCurrency(slip.payroll.netPayFen) }}</strong></footer>
  </article>
</template>
