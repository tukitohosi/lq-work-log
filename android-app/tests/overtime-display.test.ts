import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AnnualView from '../src/components/AnnualView.vue'
import PayslipSheet from '../src/components/PayslipSheet.vue'
import type {
  AnnualPayrollSummary,
  MonthlyPayrollSummary,
  PayrollTotals,
  PayslipData,
} from '../src/payroll'
import type { AppData, Worker } from '../src/types'

const worker: Worker = {
  id: 'worker-a',
  name: '测试工人',
  avatarDataUrl: null,
  avatarEmoji: null,
  defaultDailyRateFen: 20_000,
  note: '',
  defaultSiteId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
}

const totals: PayrollTotals = {
  morningCount: 2,
  afternoonCount: 2,
  overtimeHalfDays: 2,
  totalHalfDays: 6,
  workDays: 3,
  basePayFen: 70_000,
  allowanceFen: 0,
  deductionFen: 0,
  netPayFen: 70_000,
}

const payroll: MonthlyPayrollSummary = {
  ...totals,
  workerId: worker.id,
  month: '2026-08',
  dailyRateFen: 20_000,
  overtimePayPercent: 150,
  paidAt: null,
  hasMonthlyRecord: true,
  siteBreakdown: [],
}

const data: AppData = {
  schemaVersion: 7,
  revision: 1,
  workers: [worker],
  attendance: [],
  monthlyRecords: [{ workerId: worker.id, month: '2026-08', dailyRateFen: 20_000, overtimePayPercent: 150, note: '', paidAt: null }],
  payAdjustments: [],
  sites: [],
  settings: {
    weekStartsOn: 6,
    currentWorkerId: worker.id,
    theme: 'light',
    sidebarCollapsed: false,
    lastBackupExportAt: null,
    lastBackupReminderAt: null,
    weeklyAutoBackupEnabled: true,
    lastWeeklyBackupAt: null,
    defaultOvertimePayPercent: 100,
  },
}

describe('overtime multiplier component display', () => {
  it('prints the actual multiplier on single and batch payslip content', () => {
    const slip: PayslipData = {
      worker,
      month: '2026-08',
      paidAt: null,
      payroll,
      adjustments: [],
      siteBreakdown: [],
      ordinaryHalfDays: 4,
      ordinaryWorkDays: 2,
      overtimeWorkDays: 1,
    }
    const wrapper = mount(PayslipSheet, { props: { slip } })

    expect(wrapper.find('.payslip-summary').text()).toContain('加班工数 · 1.5 倍')
  })

  it('shows each relevant month\'s frozen multiplier in the annual table', () => {
    const summary: AnnualPayrollSummary = {
      year: '2026',
      months: ['2026-08'],
      rows: [{ worker, months: [payroll], totals, siteBreakdown: [] }],
      totals,
      siteBreakdown: [],
    }
    const wrapper = mount(AnnualView, {
      props: {
        data,
        summary,
        selectedYear: '2026',
        workerFilter: 'all',
        siteFilter: 'all',
        paidFilter: 'all',
        metric: 'work',
      },
      global: { stubs: { AnnualBarChart: true } },
    })

    expect(wrapper.find('.annual-table small').text()).toBe('加班 1.5 倍')
  })
})
