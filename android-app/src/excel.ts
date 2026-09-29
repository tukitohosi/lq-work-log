import * as XLSX from 'xlsx'
import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { shareAndroidFile } from './android-share'
import type { CompensationLineKind } from './compensation-ledger'
import { buildPayrollLookup, workerMonthKey } from './data-index'
import type { PayrollLookup } from './data-index'
import { monthLabel, monthWeeks, weekdayLabels } from './date'
import { formatOvertimeMultiplier } from './overtime'
import {
  buildPayslipData,
  calculateMonthlyPayroll,
  calculateYearlyPayroll,
  type PayslipData,
} from './payroll'
import {
  calculateSiteStatistics,
  type SiteStatisticsOptions,
  type SiteStatisticsBucketKind,
  type SiteStatisticsPeriod,
} from './site-statistics'
import type { AppData, AttendanceEntry, MonthlyRecord, WeekStartsOn, Worker } from './types'

export interface WorkbookExport {
  filename: string
  bytes: Uint8Array
}

export type MonthlyWorkbookExport = WorkbookExport

type CellValue = string | number
type Rows = CellValue[][]

const MONEY_FORMAT = '¥#,##0.00;[Red]-¥#,##0.00'
const COUNT_FORMAT = '#,##0.0'
const MULTIPLIER_FORMAT = '0.##" 倍"'

export function safeText(value: string): string {
  return /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value
}

export function safeFilename(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
  return sanitized || '未命名工人'
}

export function safeSheetName(value: string): string {
  return safeFilename(value).replace(/[\[\]]/g, '_').slice(0, 31) || '记工表'
}

function symbol(entry: AttendanceEntry | undefined, period: 'morning' | 'afternoon'): string {
  const leave = period === 'morning' ? entry?.morningLeave : entry?.afternoonLeave
  if (leave) return leave.payType === 'paid' ? '假（带薪）' : '假（无薪）'
  const status = entry?.[period]
  return status === 'present' ? '✓' : status === 'absent' ? '×' : ''
}

function overtimeSymbol(entry: AttendanceEntry | undefined): string {
  const leave = entry?.overtimeLeave
  if (leave) return leave.payType === 'paid' ? `假（带薪${leave.units === 'full' ? '一工' : '半工'}）` : '假（无薪）'
  return entry?.overtime === 'half' ? '✓' : entry?.overtime === 'full' ? '✓✓' : ''
}

function settlementStatus(paidAt: string | null): string {
  return paidAt ? '已结清' : '未结清'
}

function settlementLabel(paidAt: string | null): string {
  return paidAt ? `已结清（${paidAt}）` : '未结清'
}

export function exportMonthlyWorkbook(options: {
  data: AppData
  worker: Worker
  month: string
  weekStartsOn: WeekStartsOn
  monthlyRecord?: MonthlyRecord
  dailyRateFen?: number
  morningCount?: number
  afternoonCount?: number
  overtimeHalfDays?: number
  lookup?: PayrollLookup
}): MonthlyWorkbookExport {
  const { data, worker, month, weekStartsOn } = options
  const lookup = options.lookup ?? buildPayrollLookup(data)
  const monthlyRecord = options.monthlyRecord
    ?? lookup.monthlyRecordByWorkerMonth.get(workerMonthKey(worker.id, month))
  const payroll = calculateMonthlyPayroll({ data, worker, month, lookup })
  const paidAt = monthlyRecord ? monthlyRecord.paidAt : payroll.paidAt
  const entries = new Map(
    (lookup.attendanceByWorkerMonth.get(workerMonthKey(worker.id, month)) ?? [])
      .map((entry) => [entry.date, entry]),
  )
  const rows: Rows = [
    [`${safeText(worker.name)} · ${monthLabel(month)}记工表`, '', '', '', '', '', '', ''],
    ['本月工数', payroll.workDays, '上午出工', payroll.morningCount, '下午出工', payroll.afternoonCount, '加班工数', payroll.overtimeHalfDays / 2],
    ['日薪', payroll.dailyRateFen / 100, '基础工资', payroll.basePayFen / 100, '补贴', payroll.allowanceFen / 100, '扣款', payroll.deductionFen / 100],
    ['实发工资', payroll.netPayFen / 100, '结清状态', settlementStatus(paidAt), '结清时间', paidAt ?? '', '加班倍率', payroll.overtimePayPercent / 100],
    ['', ...weekdayLabels(weekStartsOn)],
  ]

  for (const week of monthWeeks(month, weekStartsOn)) {
    rows.push(['日期', ...week.days.map((day) => day.day ?? '')])
    rows.push(['上午', ...week.days.map((day) => (day.iso ? symbol(entries.get(day.iso), 'morning') : ''))])
    rows.push(['下午', ...week.days.map((day) => (day.iso ? symbol(entries.get(day.iso), 'afternoon') : ''))])
    rows.push(['加班', ...week.days.map((day) => (day.iso ? overtimeSymbol(entries.get(day.iso)) : ''))])
    rows.push(['', '', '', '', '', '', '', ''])
  }
  rows.push(['月备注', safeText(monthlyRecord?.note || ''), '', '', '', '', '', ''])
  rows.push([
    '说明',
    `上午/下午：✓计0.5个工，×计0；加班：✓计0.5个工，✓✓计1个工；导出于 ${new Date().toLocaleString('zh-CN')}`,
    '', '', '', '', '', '',
  ])

  const sheet = XLSX.utils.aoa_to_sheet(rows)
  sheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
    { s: { r: rows.length - 2, c: 1 }, e: { r: rows.length - 2, c: 7 } },
    { s: { r: rows.length - 1, c: 1 }, e: { r: rows.length - 1, c: 7 } },
  ]
  sheet['!cols'] = [{ wch: 12 }, ...Array.from({ length: 7 }, () => ({ wch: 11 }))]
  sheet['!rows'] = rows.map((_, index) => ({ hpt: index === 0 ? 28 : 22 }))
  setNumberFormat(sheet, ['B2', 'H2'], COUNT_FORMAT)
  setNumberFormat(sheet, ['B3', 'D3', 'F3', 'H3', 'B4'], MONEY_FORMAT)
  setNumberFormat(sheet, ['H4'], MULTIPLIER_FORMAT)

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName(`${worker.name}_${month}`))
  workbook.Props = workbookProperties(`${worker.name} ${monthLabel(month)}记工表`)
  return writeWorkbook(workbook, `${safeFilename(worker.name)}_${month.slice(0, 4)}年${month.slice(5)}月记工表.xlsx`)
}

export function exportAnnualWorkbook(options: {
  data: AppData
  year: string
  workerIds?: readonly string[]
  defaultSiteIds?: readonly (string | null)[]
  lookup?: PayrollLookup
}): WorkbookExport {
  const { data, year } = options
  const lookup = options.lookup ?? buildPayrollLookup(data)
  const annual = calculateYearlyPayroll({ ...options, lookup })
  const overview: Rows = [
    [`${year}年度汇总`, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['工人', ...annual.months.map(monthShortLabel), '年度工数', '基础工资', '补贴', '扣款', '实发工资'],
    ...annual.rows.map((row) => [
      safeText(row.worker.name),
      ...row.months.map((month) => month.workDays),
      row.totals.workDays,
      row.totals.basePayFen / 100,
      row.totals.allowanceFen / 100,
      row.totals.deductionFen / 100,
      row.totals.netPayFen / 100,
    ]),
    ['合计', ...annual.months.map((_, index) => annual.rows.reduce((sum, row) => sum + row.months[index].workDays, 0)), annual.totals.workDays, annual.totals.basePayFen / 100, annual.totals.allowanceFen / 100, annual.totals.deductionFen / 100, annual.totals.netPayFen / 100],
  ]
  const monthlyDetails: Rows = [
    ['月份', '工人', '结清状态', '结清时间', '日薪', '加班倍率', '上午出工', '下午出工', '加班工数', '总工数', '基础工资', '补贴', '扣款', '实发工资'],
    ...annual.rows.flatMap((row) => row.months.map((month) => [
      month.month,
      safeText(row.worker.name),
      settlementStatus(month.paidAt),
      month.paidAt ?? '',
      month.dailyRateFen / 100,
      month.overtimePayPercent / 100,
      month.morningCount,
      month.afternoonCount,
      month.overtimeHalfDays / 2,
      month.workDays,
      month.basePayFen / 100,
      month.allowanceFen / 100,
      month.deductionFen / 100,
      month.netPayFen / 100,
    ])),
  ]
  const workerIds = new Set(annual.rows.map((row) => row.worker.id))
  const workerNames = new Map(annual.rows.map((row) => [row.worker.id, row.worker.name]))
  const selectedAdjustments = annual.rows.flatMap((row) => annual.months.flatMap(
    (month) => lookup.adjustmentsByWorkerMonth.get(workerMonthKey(row.worker.id, month)) ?? [],
  ))
  const adjustments: Rows = [
    ['月份', '日期', '工人', '类型', '项目', '金额', '备注'],
    ...selectedAdjustments
      .filter((item) => workerIds.has(item.workerId))
      .sort((a, b) => a.month.localeCompare(b.month) || compareNullableDates(a.date, b.date) || a.createdAt.localeCompare(b.createdAt))
      .map((item) => [
        item.month,
        item.date ?? '',
        safeText(workerNames.get(item.workerId) ?? item.workerId),
        item.kind === 'allowance' ? '补贴' : '扣款',
        safeText(item.label),
        item.amountFen / 100,
        safeText(item.note),
      ]),
  ]
  const siteRows: Rows = [
    ['月份', '工人', '工地', '上午工数', '下午工数', '加班工数', '总工数'],
    ...annual.rows.flatMap((row) => row.months.flatMap((month) => month.siteBreakdown.map((site) => [
      month.month,
      safeText(row.worker.name),
      safeText(site.siteName),
      site.morningHalfDays / 2,
      site.afternoonHalfDays / 2,
      site.overtimeHalfDays / 2,
      site.workDays,
    ]))),
  ]

  const workbook = XLSX.utils.book_new()
  appendReportSheet(workbook, '年度总览', overview, {
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 17 } }],
    columns: [{ wch: 16 }, ...Array.from({ length: 12 }, () => ({ wch: 9 })), { wch: 12 }, ...Array.from({ length: 4 }, () => ({ wch: 14 }))],
    moneyColumns: [14, 15, 16, 17],
    countColumns: Array.from({ length: 13 }, (_, index) => index + 1),
    headerRow: 1,
  })
  appendReportSheet(workbook, '月度明细', monthlyDetails, {
    columns: [{ wch: 10 }, { wch: 16 }, { wch: 10 }, { wch: 26 }, ...Array.from({ length: 10 }, () => ({ wch: 13 }))],
    moneyColumns: [4, 10, 11, 12, 13],
    countColumns: [6, 7, 8, 9],
    multiplierColumns: [5],
  })
  appendReportSheet(workbook, '调整明细', adjustments, {
    columns: [{ wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 10 }, { wch: 20 }, { wch: 14 }, { wch: 34 }],
    moneyColumns: [5],
  })
  appendReportSheet(workbook, '工地工数', siteRows, {
    columns: [{ wch: 10 }, { wch: 16 }, { wch: 22 }, ...Array.from({ length: 4 }, () => ({ wch: 13 }))],
    countColumns: [3, 4, 5, 6],
  })
  workbook.Props = workbookProperties(`${year}年度记工汇总`)
  return writeWorkbook(workbook, `${year}年度记工汇总.xlsx`)
}

export function exportPayslipWorkbook(options: {
  data: AppData
  worker: Worker
  month: string
  lookup?: PayrollLookup
}): WorkbookExport {
  const lookup = options.lookup ?? buildPayrollLookup(options.data)
  const payslip = buildPayslipData({ ...options, lookup })
  const workbook = XLSX.utils.book_new()
  appendPayslipSheet(workbook, payslip)
  workbook.Props = workbookProperties(`${payslip.worker.name} ${monthLabel(payslip.month)}工资条`)
  return writeWorkbook(workbook, `${safeFilename(payslip.worker.name)}_${payslip.month}工资条.xlsx`)
}

export function exportBatchPayslipWorkbook(options: {
  data: AppData
  month: string
  workers?: readonly Worker[]
  lookup?: PayrollLookup
}): WorkbookExport {
  const workers = options.workers ?? options.data.workers.filter((worker) => !worker.archivedAt)
  const lookup = options.lookup ?? buildPayrollLookup(options.data)
  const workbook = XLSX.utils.book_new()
  const usedNames = new Set<string>()
  for (const worker of workers) {
    appendPayslipSheet(workbook, buildPayslipData({ ...options, worker, lookup }), usedNames)
  }
  if (workers.length === 0) appendReportSheet(workbook, '工资条', [['没有可导出的工人']], { columns: [{ wch: 24 }] })
  workbook.Props = workbookProperties(`${monthLabel(options.month)}工资条`)
  return writeWorkbook(workbook, `${options.month}全部工资条.xlsx`)
}

export function exportSiteStatisticsWorkbook(options: SiteStatisticsOptions): WorkbookExport {
  const statistics = calculateSiteStatistics(options)
  const periodLabel = siteStatisticsPeriodLabel(statistics.period)
  const summaryRows: Rows = [
    [`${periodLabel}工地统计`, '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['工地/成本桶', '类别', '状态', '人数', '人次', '上午工数', '下午工数', '加班工数', '总工数', '带薪假工数', '无薪假工数', '基础工资', '补贴', '扣款', '完整成本'],
    ...statistics.rows.map((row) => [
      safeText(row.siteName),
      siteBucketLabel(row.bucketKind),
      row.archived ? '已归档' : '',
      row.workerCount,
      row.personTimes,
      row.morningHalfDays / 2,
      row.afternoonHalfDays / 2,
      row.overtimeHalfDays / 2,
      row.workDays,
      row.paidLeaveHalfDays / 2,
      row.unpaidLeaveHalfDays / 2,
      row.basePayFen / 100,
      row.allowanceFen / 100,
      row.deductionFen / 100,
      row.netCostFen / 100,
    ]),
    [
      '合计', '', '', statistics.totals.workerCount, statistics.totals.personTimes,
      statistics.totals.morningHalfDays / 2,
      statistics.totals.afternoonHalfDays / 2,
      statistics.totals.overtimeHalfDays / 2,
      statistics.totals.workDays,
      statistics.totals.paidLeaveHalfDays / 2,
      statistics.totals.unpaidLeaveHalfDays / 2,
      statistics.totals.basePayFen / 100,
      statistics.totals.allowanceFen / 100,
      statistics.totals.deductionFen / 100,
      statistics.totals.netCostFen / 100,
    ],
  ]
  const workerRows: Rows = [
    ['工地/成本桶', '工人', '人次', '上午工数', '下午工数', '加班工数', '总工数', '带薪假工数', '无薪假工数', '基础工资', '补贴', '扣款', '完整成本'],
    ...statistics.rows.flatMap((row) => row.workers.map((worker) => [
      safeText(row.siteName),
      safeText(worker.workerName),
      worker.personTimes,
      worker.morningHalfDays / 2,
      worker.afternoonHalfDays / 2,
      worker.overtimeHalfDays / 2,
      worker.workDays,
      worker.paidLeaveHalfDays / 2,
      worker.unpaidLeaveHalfDays / 2,
      worker.basePayFen / 100,
      worker.allowanceFen / 100,
      worker.deductionFen / 100,
      worker.netCostFen / 100,
    ])),
  ]
  const workerNames = new Map(options.data.workers.map((worker) => [worker.id, worker.name]))
  const ledgerRows: Rows = [
    ['月份', '日期', '工人', '工地/成本桶', '时段', '类型', '实际工数', '请假工数', '金额'],
    ...statistics.lines.map((line) => [
      line.month,
      line.date ?? '',
      safeText(workerNames.get(line.workerId) ?? line.workerId),
      safeText(line.siteName),
      line.period ? attendancePeriodLabel(line.period) : '',
      compensationKindLabel(line.kind),
      line.workHalfDays / 2,
      line.leaveHalfDays / 2,
      line.amountFen / 100,
    ]),
  ]

  const workbook = XLSX.utils.book_new()
  appendReportSheet(workbook, '工地汇总', summaryRows, {
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }],
    columns: [{ wch: 24 }, { wch: 16 }, { wch: 10 }, ...Array.from({ length: 8 }, () => ({ wch: 12 })), ...Array.from({ length: 4 }, () => ({ wch: 14 }))],
    countColumns: [3, 4, 5, 6, 7, 8, 9, 10],
    moneyColumns: [11, 12, 13, 14],
    headerRow: 1,
  })
  appendReportSheet(workbook, '工人明细', workerRows, {
    columns: [{ wch: 24 }, { wch: 16 }, ...Array.from({ length: 7 }, () => ({ wch: 12 })), ...Array.from({ length: 4 }, () => ({ wch: 14 }))],
    countColumns: [2, 3, 4, 5, 6, 7, 8],
    moneyColumns: [9, 10, 11, 12],
  })
  appendReportSheet(workbook, '工资台账', ledgerRows, {
    columns: [{ wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 24 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 14 }],
    countColumns: [6, 7],
    moneyColumns: [8],
  })
  workbook.Props = workbookProperties(`${periodLabel}工地统计`)
  return writeWorkbook(workbook, `${siteStatisticsFilenamePrefix(statistics.period)}工地统计.xlsx`)
}

export interface WorkbookDownloadResult {
  canceled: boolean
  filePath?: string
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export async function downloadWorkbook({ filename, bytes }: WorkbookExport): Promise<WorkbookDownloadResult> {
  const ownedBytes = Uint8Array.from(bytes)
  if (window.jigongbenDesktop) {
    return await window.jigongbenDesktop.saveFile({
      kind: 'xlsx',
      filename,
      data: ownedBytes,
    })
  }
  if (Capacitor.isNativePlatform()) {
    const directory = 'lq-jigongben-exports'
    const path = `${directory}/${safeFilename(filename)}`
    await Filesystem.mkdir({ path: directory, directory: Directory.Cache, recursive: true }).catch(() => undefined)
    await Filesystem.writeFile({ path, directory: Directory.Cache, data: bytesToBase64(ownedBytes), recursive: true })
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
    const shareResult = await shareAndroidFile({ title: filename, dialogTitle: `导出 ${filename}`, files: [uri] })
    return { canceled: shareResult.canceled, filePath: uri }
  }
  const blob = new Blob([ownedBytes.buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  return { canceled: false }
}

export const downloadMonthlyWorkbook = downloadWorkbook

export async function downloadSiteStatisticsWorkbook(
  options: SiteStatisticsOptions,
): Promise<WorkbookDownloadResult> {
  return await downloadWorkbook(exportSiteStatisticsWorkbook(options))
}

function appendPayslipSheet(workbook: XLSX.WorkBook, payslip: PayslipData, usedNames = new Set<string>()): void {
  const payroll = payslip.payroll
  const rows: Rows = [
    [`${safeText(payslip.worker.name)} · ${monthLabel(payslip.month)}工资条`, '', '', ''],
    ['日薪', payroll.dailyRateFen / 100, '实发工资', payroll.netPayFen / 100],
    ['普通工数', payslip.ordinaryWorkDays, `加班工数（${formatOvertimeMultiplier(payroll.overtimePayPercent)}）`, payslip.overtimeWorkDays],
    ['基础工资', payroll.basePayFen / 100, '补贴合计', payroll.allowanceFen / 100],
    ['扣款合计', payroll.deductionFen / 100, '结清状态', settlementLabel(payslip.paidAt)],
    ['', '', '', ''],
    ['工地', '上午工数', '下午工数', '加班工数'],
    ...payslip.siteBreakdown.map((site) => [safeText(site.siteName), site.morningHalfDays / 2, site.afternoonHalfDays / 2, site.overtimeHalfDays / 2]),
    ['', '', '', ''],
    ['日期', '类型', '项目', '金额'],
    ...payslip.adjustments.map((item) => [item.date ?? '', item.kind === 'allowance' ? '补贴' : '扣款', safeText(item.label), item.amountFen / 100]),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }]
  sheet['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 24 }, { wch: 16 }]
  sheet['!rows'] = rows.map((_, index) => ({ hpt: index === 0 ? 28 : 22 }))
  setNumberFormat(sheet, ['B2', 'D2', 'B4', 'D4', 'B5'], MONEY_FORMAT)
  for (let row = 8; row <= 7 + payslip.siteBreakdown.length; row += 1) setNumberFormat(sheet, [`B${row}`, `C${row}`, `D${row}`], COUNT_FORMAT)
  const adjustmentStart = 10 + payslip.siteBreakdown.length
  for (let row = adjustmentStart; row < adjustmentStart + payslip.adjustments.length; row += 1) setNumberFormat(sheet, [`D${row}`], MONEY_FORMAT)

  const baseName = safeSheetName(`${payslip.worker.name}_${payslip.month}`)
  let name = baseName
  let suffix = 2
  while (usedNames.has(name)) {
    const suffixText = `_${suffix}`
    name = `${baseName.slice(0, 31 - suffixText.length)}${suffixText}`
    suffix += 1
  }
  usedNames.add(name)
  XLSX.utils.book_append_sheet(workbook, sheet, name)
}

function appendReportSheet(
  workbook: XLSX.WorkBook,
  name: string,
  rows: Rows,
  options: {
    merges?: XLSX.Range[]
    columns: XLSX.ColInfo[]
    moneyColumns?: number[]
    countColumns?: number[]
    multiplierColumns?: number[]
    headerRow?: number
  },
): void {
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  sheet['!merges'] = options.merges
  sheet['!cols'] = options.columns
  sheet['!rows'] = rows.map((_, index) => ({ hpt: index === 0 && options.headerRow === 1 ? 28 : 22 }))
  const firstDataRow = (options.headerRow ?? 0) + 2
  for (let row = firstDataRow; row <= rows.length; row += 1) {
    for (const column of options.moneyColumns ?? []) setNumberFormat(sheet, [`${XLSX.utils.encode_col(column)}${row}`], MONEY_FORMAT)
    for (const column of options.countColumns ?? []) setNumberFormat(sheet, [`${XLSX.utils.encode_col(column)}${row}`], COUNT_FORMAT)
    for (const column of options.multiplierColumns ?? []) setNumberFormat(sheet, [`${XLSX.utils.encode_col(column)}${row}`], MULTIPLIER_FORMAT)
  }
  sheet['!autofilter'] = rows.length > (options.headerRow ?? 0) + 1
    ? { ref: `${XLSX.utils.encode_cell({ r: options.headerRow ?? 0, c: 0 })}:${XLSX.utils.encode_cell({ r: rows.length - 1, c: Math.max(0, rows[options.headerRow ?? 0].length - 1) })}` }
    : undefined
  XLSX.utils.book_append_sheet(workbook, sheet, name)
}

function setNumberFormat(sheet: XLSX.WorkSheet, addresses: string[], format: string): void {
  for (const address of addresses) if (sheet[address]) sheet[address].z = format
}

function monthShortLabel(month: string): string {
  return `${Number(month.slice(5))}月`
}

function siteStatisticsPeriodLabel(period: SiteStatisticsPeriod): string {
  return period.mode === 'month' ? monthLabel(period.month) : `${period.year}年度`
}

function siteStatisticsFilenamePrefix(period: SiteStatisticsPeriod): string {
  return period.mode === 'month' ? period.month : `${period.year}年度`
}

function siteBucketLabel(kind: SiteStatisticsBucketKind): string {
  if (kind === 'site') return '实际工地'
  if (kind === 'unassigned-work') return '未分配工地'
  if (kind === 'paid-leave') return '带薪假'
  if (kind === 'unpaid-leave') return '无薪假'
  return '未归属调整'
}

function attendancePeriodLabel(period: 'morning' | 'afternoon' | 'overtime'): string {
  if (period === 'morning') return '上午'
  if (period === 'afternoon') return '下午'
  return '加班'
}

function compensationKindLabel(kind: CompensationLineKind): string {
  if (kind === 'ordinary-work') return '普通出工'
  if (kind === 'overtime-work') return '加班出工'
  if (kind === 'paid-leave') return '带薪假'
  if (kind === 'unpaid-leave') return '无薪假'
  return kind === 'allowance' ? '补贴' : '扣款'
}

function compareNullableDates(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a.localeCompare(b)
}

function workbookProperties(title: string): XLSX.FullProperties {
  return {
    Title: title,
    Subject: '本地电子记工本导出',
    Author: '记工本',
    CreatedDate: new Date(),
  }
}

function writeWorkbook(workbook: XLSX.WorkBook, filename: string): WorkbookExport {
  const generated = XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'array',
    compression: true,
  }) as ArrayBuffer | Uint8Array
  return {
    filename,
    bytes: generated instanceof Uint8Array ? generated : new Uint8Array(generated),
  }
}
