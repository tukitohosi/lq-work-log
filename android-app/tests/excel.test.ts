import { describe, expect, it, vi } from 'vitest'
import type { AppData, MonthlyRecord, Worker } from '../src/types'

import * as XLSX from 'xlsx'
import {
  exportAnnualWorkbook,
  exportBatchPayslipWorkbook,
  exportMonthlyWorkbook,
  exportPayslipWorkbook,
  exportSiteStatisticsWorkbook,
  downloadWorkbook,
  safeFilename,
  safeSheetName,
  safeText,
} from '../src/excel'
import { formatOvertimeMultiplier } from '../src/overtime'

const worker: Worker = {
  id: 'worker-1',
  name: '李权',
  avatarDataUrl: null,
  avatarEmoji: null,
  defaultDailyRateFen: 30_001,
  note: '',
  defaultSiteId: 'site-1',
  createdAt: '2026-08-01T00:00:00.000Z',
  archivedAt: null,
}
const monthlyRecord: MonthlyRecord = {
  workerId: worker.id,
  month: '2026-08',
  dailyRateFen: 30_001,
  overtimePayPercent: 100,
  note: '=SUM(A1:A2)',
  paidAt: '2026-09-01T08:30:00.000Z',
}
const data: AppData = {
  schemaVersion: 7,
  revision: 1,
  workers: [worker],
  attendance: [
    { workerId: worker.id, date: '2026-08-01', morning: 'present', afternoon: 'absent', overtime: 'half', dayNote: '', morningSiteId: 'site-1', afternoonSiteId: null, overtimeSiteId: 'site-1' },
    { workerId: worker.id, date: '2026-08-02', morning: 'present', afternoon: 'present', overtime: 'full', dayNote: '', morningSiteId: 'site-1', afternoonSiteId: null, overtimeSiteId: 'site-1' },
  ],
  monthlyRecords: [monthlyRecord],
  payAdjustments: [
    { id: 'a', workerId: worker.id, month: '2026-08', date: '2026-08-01', kind: 'allowance', amountFen: 1_234, label: '=恶意公式', note: '@备注', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'd', workerId: worker.id, month: '2026-08', date: null, kind: 'deduction', amountFen: 100_000, label: '借支', note: '', createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' },
  ],
  sites: [{ id: 'site-1', name: '+东区', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null }],
  settings: { weekStartsOn: 6, currentWorkerId: worker.id, theme: 'light', sidebarCollapsed: false, lastBackupExportAt: null, lastBackupReminderAt: null, weeklyAutoBackupEnabled: true, lastWeeklyBackupAt: null, defaultOvertimePayPercent: 100 },
}

function readRows(bytes: Uint8Array, sheetName: string): (string | number)[][] {
  const reopened = XLSX.read(bytes, { type: 'array', cellNF: true })
  return XLSX.utils.sheet_to_json<(string | number)[]>(reopened.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: '',
  })
}

function expectNoFormulas(bytes: Uint8Array): void {
  const workbook = XLSX.read(bytes, { type: 'array' })
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    for (const cell of Object.values(sheet)) {
      if (cell && typeof cell === 'object' && 'f' in cell) expect(cell.f).toBeUndefined()
    }
  }
}

describe('monthly Excel export', () => {
  it('reopens with shared payroll totals, marks, money formats and safe notes', () => {
    const exported = exportMonthlyWorkbook({ data, worker, month: '2026-08', weekStartsOn: 6, monthlyRecord })

    expect(exported.filename).toBe('李权_2026年08月记工表.xlsx')
    expect(exported.bytes.byteLength).toBeGreaterThan(1_000)
    const reopened = XLSX.read(exported.bytes, { type: 'array', cellNF: true })
    expect(reopened.SheetNames).toEqual(['李权_2026-08'])
    const sheet = reopened.Sheets['李权_2026-08']
    const rows = readRows(exported.bytes, '李权_2026-08')

    expect(rows[0][0]).toBe('李权 · 2026年8月记工表')
    expect(rows[1].slice(0, 8)).toEqual(['本月工数', 3, '上午出工', 2, '下午出工', 1, '加班工数', 1.5])
    expect(rows[2]).toEqual(['日薪', 300.01, '基础工资', 900.03, '补贴', 12.34, '扣款', 1000])
    expect(rows[3].slice(0, 2)).toEqual(['实发工资', -87.63])
    expect(rows[3].slice(2, 6)).toEqual(['结清状态', '已结清', '结清时间', '2026-09-01T08:30:00.000Z'])
    expect(rows[3].slice(6)).toEqual(['加班倍率', 1])
    expect(rows[4].slice(0, 8)).toEqual(['', '六', '日', '一', '二', '三', '四', '五'])
    expect(rows[6].slice(0, 4)).toEqual(['上午', '✓', '✓', ''])
    expect(rows[7].slice(0, 4)).toEqual(['下午', '×', '✓', ''])
    expect(rows[8].slice(0, 4)).toEqual(['加班', '✓', '✓✓', ''])
    expect(rows.at(-2)?.[1]).toBe("'=SUM(A1:A2)")
    expect(sheet.B4.z).toContain('[Red]')
    expectNoFormulas(exported.bytes)
  })

  it('sanitizes spreadsheet formulas, filenames and Excel sheet names', () => {
    expect(safeText('  =1+1')).toBe("'  =1+1")
    expect(safeFilename('张/师傅:* ')).toBe('张_师傅__')
    expect(safeSheetName('a'.repeat(40))).toHaveLength(31)
  })

  it('writes explicit paid and unpaid leave labels instead of attendance marks', () => {
    const leaveData: AppData = {
      ...data,
      schemaVersion: 8,
      attendance: [{
        ...data.attendance[0],
        morningLeave: { payType: 'paid' },
        afternoonLeave: { payType: 'unpaid' },
        overtimeLeave: { payType: 'paid', units: 'half' },
      }],
    }
    const exported = exportMonthlyWorkbook({ data: leaveData, worker, month: '2026-08', weekStartsOn: 6 })
    const rows = readRows(exported.bytes, '李权_2026-08')

    expect(rows[6][1]).toBe('假（带薪）')
    expect(rows[7][1]).toBe('假（无薪）')
    expect(rows[8][1]).toBe('假（带薪半工）')
  })
})

describe('annual and payslip Excel exports', () => {
  it('creates and reopens the four required annual sheets with reconciled totals', () => {
    const exported = exportAnnualWorkbook({ data, year: '2026' })
    const reopened = XLSX.read(exported.bytes, { type: 'array', cellNF: true })

    expect(exported.filename).toBe('2026年度记工汇总.xlsx')
    expect(reopened.SheetNames).toEqual(['年度总览', '月度明细', '调整明细', '工地工数'])
    const overview = readRows(exported.bytes, '年度总览')
    const details = readRows(exported.bytes, '月度明细')
    const adjustments = readRows(exported.bytes, '调整明细')
    const sites = readRows(exported.bytes, '工地工数')
    expect(overview[2].slice(-5)).toEqual([3, 900.03, 12.34, 1000, -87.63])
    expect(overview.at(-1)?.slice(-5)).toEqual([3, 900.03, 12.34, 1000, -87.63])
    expect(details.find((row) => row[0] === '2026-08')?.slice(-4)).toEqual([900.03, 12.34, 1000, -87.63])
    expect(details.find((row) => row[0] === '2026-08')?.slice(2, 4)).toEqual(['已结清', '2026-09-01T08:30:00.000Z'])
    expect(adjustments[1].slice(3)).toEqual(['补贴', "'=恶意公式", 12.34, "'@备注"])
    expect(sites[1]).toEqual(['2026-08', '李权', "'+东区", 1, 0, 1.5, 2.5])
    expect(reopened.Sheets['年度总览'].R3.z).toContain('[Red]')
    expectNoFormulas(exported.bytes)
  })

  it('creates single and batch payslips with site and adjustment details', () => {
    const single = exportPayslipWorkbook({ data, worker, month: '2026-08' })
    const batch = exportBatchPayslipWorkbook({ data, month: '2026-08' })
    const singleBook = XLSX.read(single.bytes, { type: 'array', cellNF: true })

    expect(single.filename).toBe('李权_2026-08工资条.xlsx')
    expect(singleBook.SheetNames).toEqual(['李权_2026-08'])
    expect(XLSX.read(batch.bytes, { type: 'array' }).SheetNames).toEqual(['李权_2026-08'])
    const rows = readRows(single.bytes, '李权_2026-08')
    expect(rows[1]).toEqual(['日薪', 300.01, '实发工资', -87.63])
    expect(rows[2]).toEqual(['普通工数', 1.5, '加班工数（1 倍）', 1.5])
    expect(rows[4]).toEqual(['扣款合计', 1000, '结清状态', '已结清（2026-09-01T08:30:00.000Z）'])
    expect(rows[7]).toEqual(["'+东区", 1, 0, 1.5])
    expect(rows.at(-2)?.slice(1)).toEqual(['补贴', "'=恶意公式", 12.34])
    expect(singleBook.Sheets['李权_2026-08'].D2.z).toContain('[Red]')
    const adjustmentMoneyFormats = Object.entries(singleBook.Sheets['李权_2026-08'])
      .filter(([address, cell]) => address.startsWith('D') && cell && typeof cell === 'object' && cell.v === 12.34)
      .map(([, cell]) => cell.z)
    expect(adjustmentMoneyFormats).toContainEqual(expect.stringContaining('¥'))
    expectNoFormulas(single.bytes)
  })

  it('shows the frozen overtime multiplier consistently in monthly, annual and payslip exports', () => {
    const overtimeRecord = { ...monthlyRecord, overtimePayPercent: 150 }
    const overtimeData = { ...data, monthlyRecords: [overtimeRecord] }
    const monthly = exportMonthlyWorkbook({ data: overtimeData, worker, month: '2026-08', weekStartsOn: 6, monthlyRecord: overtimeRecord })
    const annual = exportAnnualWorkbook({ data: overtimeData, year: '2026' })
    const payslip = exportPayslipWorkbook({ data: overtimeData, worker, month: '2026-08' })
    const monthlyBook = XLSX.read(monthly.bytes, { type: 'array', cellNF: true })
    const annualBook = XLSX.read(annual.bytes, { type: 'array', cellNF: true })

    expect(readRows(monthly.bytes, '李权_2026-08')[3].slice(6)).toEqual(['加班倍率', 1.5])
    expect(monthlyBook.Sheets['李权_2026-08'].H4.z).toContain('倍')
    const august = readRows(annual.bytes, '月度明细').find((row) => row[0] === '2026-08')
    expect(august?.slice(4, 6)).toEqual([300.01, 1.5])
    expect(august?.slice(-4)).toEqual([1125.04, 12.34, 1000, 137.38])
    expect(annualBook.Sheets['月度明细'].F9.z).toContain('倍')
    expect(readRows(payslip.bytes, '李权_2026-08')[2]).toEqual(['普通工数', 1.5, '加班工数（1.5 倍）', 1.5])
  })

  it('keeps batch sheet names unique even when long worker names truncate to the same prefix', () => {
    const first = { ...worker, id: 'long-1', name: `${'张'.repeat(40)}甲` }
    const second = { ...worker, id: 'long-2', name: `${'张'.repeat(40)}乙` }
    const exported = exportBatchPayslipWorkbook({ data: { ...data, workers: [first, second] }, month: '2026-08', workers: [first, second] })
    const sheetNames = XLSX.read(exported.bytes, { type: 'array' }).SheetNames

    expect(sheetNames).toHaveLength(2)
    expect(new Set(sheetNames).size).toBe(2)
    expect(sheetNames.every((name) => name.length <= 31)).toBe(true)
  })

  it('creates a readable empty batch workbook instead of failing with no workers', () => {
    const exported = exportBatchPayslipWorkbook({ data: { ...data, workers: [] }, month: '2026-08', workers: [] })
    const workbook = XLSX.read(exported.bytes, { type: 'array' })
    const rows = readRows(exported.bytes, '工资条')

    expect(workbook.SheetNames).toEqual(['工资条'])
    expect(rows).toEqual([['没有可导出的工人']])
  })
})

describe('overtime multiplier display', () => {
  it('formats integer percentage storage without floating-point noise', () => {
    expect(formatOvertimeMultiplier(0)).toBe('0 倍')
    expect(formatOvertimeMultiplier(100)).toBe('1 倍')
    expect(formatOvertimeMultiplier(125)).toBe('1.25 倍')
    expect(formatOvertimeMultiplier(150)).toBe('1.5 倍')
    expect(formatOvertimeMultiplier(1000)).toBe('10 倍')
  })
})

describe('site-statistics Excel and desktop download', () => {
  it('exports reconciled summary, worker detail and canonical ledger sheets', () => {
    const siteData: AppData = {
      ...data,
      schemaVersion: 8,
      attendance: data.attendance.map((entry, index) => index === 0
        ? { ...entry, afternoonLeave: { payType: 'paid' } }
        : entry),
      payAdjustments: data.payAdjustments.map((item, index) => ({
        ...item,
        siteId: index === 0 ? 'site-1' : null,
      })),
    }
    const exported = exportSiteStatisticsWorkbook({
      data: siteData,
      period: { mode: 'month', month: '2026-08' },
    })
    const workbook = XLSX.read(exported.bytes, { type: 'array' })
    const summary = readRows(exported.bytes, '工地汇总')

    expect(exported.filename).toBe('2026-08工地统计.xlsx')
    expect(workbook.SheetNames).toEqual(['工地汇总', '工人明细', '工资台账'])
    expect(summary[1].slice(-4)).toEqual(['基础工资', '补贴', '扣款', '完整成本'])
    const total = summary.at(-1)
    expect(Number(total?.[14])).toBeCloseTo(Number(total?.[11]) + Number(total?.[12]) - Number(total?.[13]), 8)
    expect(readRows(exported.bytes, '工资台账').some((row) => row[5] === '带薪假')).toBe(true)
    expectNoFormulas(exported.bytes)
  })

  it('awaits the Electron save bridge with owned XLSX bytes', async () => {
    const saveFile = vi.fn().mockResolvedValue({ canceled: false, filePath: 'C:\\导出.xlsx' })
    Object.defineProperty(window, 'jigongbenDesktop', {
      configurable: true,
      value: { saveFile },
    })
    try {
      const source = new Uint8Array([1, 2, 3])
      const result = await downloadWorkbook({ filename: '月表.xlsx', bytes: source })

      expect(result).toEqual({ canceled: false, filePath: 'C:\\导出.xlsx' })
      expect(saveFile).toHaveBeenCalledWith({
        kind: 'xlsx',
        filename: '月表.xlsx',
        data: expect.any(Uint8Array),
      })
      expect(Array.from(saveFile.mock.calls[0][0].data)).toEqual([1, 2, 3])
      expect(saveFile.mock.calls[0][0].data).not.toBe(source)
    } finally {
      Reflect.deleteProperty(window, 'jigongbenDesktop')
    }
  })
})
