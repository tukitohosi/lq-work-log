<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { App as CapacitorApp } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import { ApiError, api, downloadBackup, isAndroidApp } from './api'
import {
  applyAttendancePatch,
  attendanceKey,
  fullAttendancePatch,
  nextAttendanceValue,
  patchChanged,
  periodLeaveField,
  periodSiteField,
  snapshotPatchFields,
} from './attendance'
import { buildAttendanceIndex, buildPayrollLookup, workerDateKey, workerMonthKey } from './data-index'
import { buildDailySiteGroups, calculateDailyTotals, filterDailyWorkersBySite } from './daily-sites'
import {
  attendanceConflictKeys,
  useMutations,
  type MutationRequest,
  type MutationOptions,
} from './composables/useMutations'
import { currentMonth, isFutureIsoDate, isValidIsoDate, isValidMonth, monthLabel, monthWeeks, shiftMonth, todayIso, weekdayLabels } from './date'
import {
  downloadWorkbook,
  exportAnnualWorkbook,
  exportBatchPayslipWorkbook,
  exportMonthlyWorkbook,
  exportPayslipWorkbook,
  exportSiteStatisticsWorkbook,
  safeFilename,
} from './excel'
import { fenToCurrency, fenToInput, parseYuanToFen } from './money'
import { buildPayslipData, calculateMonthlyPayroll, calculateYearlyPayroll, resolveDailyRate } from './payroll'
import {
  makeGridCell,
  regionActionPatches,
  type GridCellRef,
  type RegionAction,
} from './grid'
import { useAttendanceGrid, type InteractionMode } from './composables/useAttendanceGrid'
import {
  overtimePercentToInput,
  parseOvertimeMultiplier,
  useMonthlyDrafts,
} from './composables/useMonthlyDrafts'
import PayslipSheet from './components/PayslipSheet.vue'
import WorkerAvatar from './components/WorkerAvatar.vue'
import GlobalSearchDialog from './components/GlobalSearchDialog.vue'
import AnnualView from './components/AnnualView.vue'
import DailyView from './components/DailyView.vue'
import MonthlyView from './components/MonthlyView.vue'
import DayDetailsDialog from './components/DayDetailsDialog.vue'
import { useWorkerSiteCreation } from './composables/useWorkerSiteCreation'
import UiIcon from './components/UiIcon.vue'
import WorkerDialog from './components/WorkerDialog.vue'
import SiteStatisticsView from './components/SiteStatisticsView.vue'
import { calculateSiteStatistics } from './site-statistics'
import { normalizeSearchText, searchAppData, type GlobalSearchResult } from './search'
import type { BatchWorkerResult, BatchWorkerSubmission, WorkerFormPayload } from './worker-form'
import type {
  AppData,
  AttendancePatch,
  AttendancePeriod,
  AttendanceValue,
  HistoryRevertTarget,
  InternalBackupMeta,
  MonthlyRecord,
  OrdinaryLeave,
  OvertimeLeave,
  PayAdjustment,
  PayAdjustmentKind,
  RestoreInspection,
  Site,
  Theme,
  WeekStartsOn,
  Worker,
} from './types'
import type { AppMutationResponse } from './mutation-response'
import { createOperationId } from './operation-id'
import { printAndroidPage } from './android-print'

type MainView = 'monthly' | 'daily' | 'annual' | 'sites'
type PrintMode = 'monthly' | 'annual' | 'payslip-single' | 'payslip-batch'
type AttendanceUndoTransaction = {
  kind: 'attendance'
  label: string
  before: AttendancePatch[]
  after: AttendancePatch[]
}
type HistoryUndoTransaction = {
  kind: 'history'
  label: string
  targets: HistoryRevertTarget[]
}
type UndoTransactionInput = AttendanceUndoTransaction | HistoryUndoTransaction
type UndoTransaction = UndoTransactionInput & { id: number }

const attendancePeriods: AttendancePeriod[] = ['morning', 'afternoon', 'overtime']

const data = ref<AppData | null>(null)
const loading = ref(true)
const loadError = ref('')
const selectedMonth = ref(currentMonth())
const selectedDate = ref(todayIso())
const selectedYear = ref(currentMonth().slice(0, 4))
const currentView = ref<MainView>('monthly')
const selectedWorkerId = ref<string | null>(null)
const settingsOpen = ref(false)
const archivedOpen = ref(false)
const helpOpen = ref(false)
const globalSearchOpen = ref(false)
const globalSearchQuery = ref('')
const workerFilterQuery = ref('')
const workerFilterInput = ref<HTMLInputElement | null>(null)
const workerDialogOpen = ref(false)
const workerDialogMode = ref<'add' | 'edit'>('add')
const workerError = ref('')
const workerSubmitting = ref(false)
const workerBatchResult = ref<BatchWorkerResult | null>(null)
const adjustmentDialogOpen = ref(false)
const editingAdjustmentId = ref<string | null>(null)
const adjustmentKind = ref<PayAdjustmentKind>('allowance')
const adjustmentAmount = ref('')
const adjustmentLabel = ref('')
const adjustmentNote = ref('')
const adjustmentDate = ref('')
const adjustmentWorkerId = ref('')
const adjustmentSiteId = ref<string | null>(null)
const adjustmentError = ref('')
const siteDialogOpen = ref(false)
const editingSiteId = ref<string | null>(null)
const siteName = ref('')
const siteNote = ref('')
const siteError = ref('')
const siteArchiveTarget = ref<Site | null>(null)
const siteArchiveReplacementChoice = ref('')
const dayDialogOpen = ref(false)
const dayDialogWorkerId = ref('')
const dayDialogDate = ref('')
const dayDialogNote = ref('')
const dayNoteDirty = ref(false)
const dayNoteSaving = ref(false)
const dayDialogClosing = ref(false)
let dayNoteTimer: ReturnType<typeof setTimeout> | null = null
let dayNotePending: Promise<boolean> | null = null
let dayNoteVersion = 0
const dayDialogWorker = computed(() => data.value?.workers.find((worker) => worker.id === dayDialogWorkerId.value) ?? null)
const dayDialogReadOnly = computed(() => !dayDialogWorker.value || Boolean(dayDialogWorker.value.archivedAt)
  || quiescing.value || dayDialogClosing.value || mutationController.unknownMutations.value.length > 0)
const leaveDialogOpen = ref(false)
const leaveTargets = ref<GridCellRef[]>([])
const leaveMorningChoice = ref<'paid' | 'unpaid'>('unpaid')
const leaveAfternoonChoice = ref<'paid' | 'unpaid'>('unpaid')
const leaveOvertimeChoice = ref<'unpaid' | 'paid-half' | 'paid-full'>('unpaid')
const interactionNotice = ref('')
const restoreInput = ref<HTMLInputElement | null>(null)
const restoreInspection = ref<RestoreInspection | null>(null)
const restoreError = ref('')
const restoring = ref(false)
const restoreOperationId = ref<string | null>(null)
const weeklyBackupBusy = ref(false)
const weeklyBackupMessage = ref('')
const weeklyBackupHealth = ref<{ lastFailureAt: string | null; errorCode: string | null } | null>(null)
const dataCapacityHealth = ref<{
  dataSizeBytes: number | null
  dataLimitBytes: number
  dataSizeWarning: boolean
} | null>(null)
const undoStack = ref<UndoTransaction[]>([])
const undoBusy = ref(false)
const internalBackups = ref<InternalBackupMeta[]>([])
const internalBackupsLoading = ref(false)
const internalBackupsError = ref('')
const inspectingBackupId = ref<string | null>(null)
const restoreSourceLabel = ref('')
const defaultOvertimeError = ref('')
const annualWorkerFilter = ref('all')
const annualSiteFilter = ref('all')
const annualPaidFilter = ref<'all' | 'paid' | 'unpaid'>('all')
const annualMetric = ref<'work' | 'pay'>('work')
const siteStatisticsMode = ref<'month' | 'year'>('month')
const siteStatisticsExporting = ref(false)
const fileOperationNotice = ref('')
const fileOperationError = ref('')
const dailySiteFilter = ref('all')
const printMode = ref<PrintMode | null>(null)
const printWorkerId = ref<string | null>(null)
const gridInputMode = ref<'pointer' | 'keyboard'>('keyboard')
const quiescing = ref(false)
const desktopAvailable = computed(() => Boolean(window.jigongbenDesktop))
const globalSearchResults = computed(() => data.value ? searchAppData(data.value, globalSearchQuery.value) : [])
const printSinglePayslip = computed(() => {
  if (!data.value) return null
  const worker = data.value.workers.find((candidate) => candidate.id === (printWorkerId.value ?? selectedWorkerId.value))
  return worker ? buildPayslipData({ data: data.value, worker, month: selectedMonth.value, lookup: payrollLookup.value! }) : null
})

let futureWriteAllowed = false
const paidChangeAcknowledged = new Set<string>()
let removeCloseListener: (() => void) | null = null
let removeCloseCancelledListener: (() => void) | null = null
let pendingCloseRequestId: string | null = null
let closeRequestDrain: Promise<void> | null = null
let activeCloseRequestId: string | null = null
const cancelledCloseRequestIds = new Set<string>()
let lastSuccessfulSnapshot: AppData | null = null
let undoSequence = 0
let interactionNoticeTimer: ReturnType<typeof setTimeout> | null = null
let modalFocusObserver: MutationObserver | null = null
let activeModalDialog: HTMLElement | null = null
let modalReturnFocus: HTMLElement | null = null
let androidBackListener: PluginListenerHandle | null = null
let androidPauseListener: PluginListenerHandle | null = null
let appDisposed = false

function topModalDialog(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).at(-1) ?? null
}

function modalFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    for (let parent: HTMLElement | null = element; parent && parent !== dialog; parent = parent.parentElement) {
      if (getComputedStyle(parent).display === 'none' || getComputedStyle(parent).visibility === 'hidden') return false
    }
    return true
  })
}

function syncModalFocus(): void {
  const nextDialog = topModalDialog()
  if (nextDialog === activeModalDialog) return
  if (nextDialog) {
    if (!activeModalDialog && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      modalReturnFocus = document.activeElement
    }
    activeModalDialog = nextDialog
    queueMicrotask(() => {
      if (activeModalDialog !== nextDialog || nextDialog.contains(document.activeElement)) return
      const target = nextDialog.querySelector<HTMLElement>('[autofocus]') ?? modalFocusableElements(nextDialog)[0]
      if (target) target.focus({ preventScroll: true })
      else {
        nextDialog.tabIndex = -1
        nextDialog.focus({ preventScroll: true })
      }
    })
    return
  }
  activeModalDialog = null
  const returnTarget = modalReturnFocus
  modalReturnFocus = null
  queueMicrotask(() => {
    if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true })
  })
}

function trapModalTab(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return
  const dialog = topModalDialog()
  if (!dialog) return
  const focusable = modalFocusableElements(dialog)
  if (!focusable.length) {
    event.preventDefault()
    dialog.tabIndex = -1
    dialog.focus({ preventScroll: true })
    return
  }
  const first = focusable[0]
  const last = focusable.at(-1)!
  const active = document.activeElement
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault()
    last.focus({ preventScroll: true })
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault()
    first.focus({ preventScroll: true })
  }
}

function updateVisualViewport(): void {
  const viewport = window.visualViewport
  document.documentElement.style.setProperty('--visual-viewport-height', `${viewport?.height ?? window.innerHeight}px`)
}

function closeTopModal(): boolean {
  const dialog = topModalDialog()
  if (!dialog) return false
  const close = dialog.querySelector<HTMLButtonElement>('.modal-header button, .global-search-dialog__close')
  if (close) {
    if (!close.disabled) close.click()
    return true
  }
  if (restoreInspection.value && !restoring.value) cancelRestore()
  return true
}

async function handleAndroidBack(): Promise<void> {
  const active = document.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    active.blur()
    return
  }
  if (closeTopModal()) return
  const batchCancel = document.querySelector<HTMLButtonElement>('.mobile-batch-cancel')
  if (batchCancel) { batchCancel.click(); return }
  if (currentView.value !== 'monthly') { changeView('monthly'); return }
  try {
    await flushPending()
    await CapacitorApp.minimizeApp()
  } catch (error) {
    showInteractionNotice(errorMessage(error))
  }
}

function flushOnBackground(): void {
  if (document.visibilityState === 'hidden') {
    void flushDayNoteDraft()
    void monthlyDrafts.flushAll()
  }
}

const mutationController = useMutations({
  data,
  onStateApplied: (state) => {
    syncSelection()
    applyTheme(state.settings.theme)
  },
})
const {
  saveStatus,
  saveError,
  failedAttendanceCellKeys,
  failedAttendanceDateKeys,
  retryFailed,
  flushMutations,
  setAcceptingMutations,
  setLatestSuccessfulState,
  clearFailures,
  dispose: disposeMutations,
} = mutationController

const workerSiteCreation = useWorkerSiteCreation({
  data,
  enqueueMutation,
  retryMutation: mutationController.retryMutation,
  discardFailedMutation: mutationController.discardFailedMutation,
  saveError,
  addSite: api.addSite,
})

function rememberSuccessfulState(state: AppData, apply = false): void {
  lastSuccessfulSnapshot = structuredClone(state)
  setLatestSuccessfulState(state, apply)
}

function enqueueMutation(
  request: MutationRequest,
  options: MutationOptions = {},
  conflictKeys: string[] = [],
  optimisticAttendance?: AttendancePatch[],
  optimisticSettings?: Partial<AppData['settings']>,
  affectedCellKeys?: Iterable<string>,
  attendanceRequestOverride?: (patches: AttendancePatch[], operationId: string) => Promise<AppMutationResponse>,
): Promise<boolean> {
  const callerOnSuccess = options.onSuccess
  return mutationController.enqueueMutation(request, {
    ...options,
    onSuccess: (result) => {
      // Mutation results are immutable server baselines inside useMutations.
      // Sharing that reference avoids cloning a multi-year ledger after every
      // single-cell save; history commands still clone their one-time before
      // snapshot before issuing the request.
      lastSuccessfulSnapshot = result
      callerOnSuccess?.(result)
    },
  }, conflictKeys, {
    optimisticAttendance,
    optimisticSettings,
    affectedCellKeys,
    attendanceRequest: attendanceRequestOverride ?? (optimisticAttendance
      ? (patches, operationId) => api.setAttendanceBatch(patches, {
          allowFuture: futureWriteAllowed && patches.some((patch) => isFutureIsoDate(patch.date)),
          operationId,
        })
      : undefined),
  })
}

const activeWorkers = computed(() => data.value?.workers.filter((worker) => !worker.archivedAt) ?? [])
const workerFilterTokens = computed(() => normalizeSearchText(workerFilterQuery.value).split(' ').filter(Boolean))
const filteredActiveWorkers = computed(() => {
  if (!workerFilterTokens.value.length) return activeWorkers.value
  return activeWorkers.value.filter((worker) => {
    const name = normalizeSearchText(worker.name)
    return workerFilterTokens.value.every((token) => name.includes(token))
  })
})
const archivedWorkers = computed(() => data.value?.workers.filter((worker) => Boolean(worker.archivedAt)) ?? [])
const activeSites = computed(() => data.value?.sites.filter((site) => !site.archivedAt) ?? [])
const siteArchiveAffectedWorkers = computed(() => siteArchiveTarget.value && data.value
  ? data.value.workers.filter((worker) => worker.defaultSiteId === siteArchiveTarget.value!.id)
  : [])
const siteArchiveReplacementSites = computed(() => activeSites.value.filter(
  (site) => site.id !== siteArchiveTarget.value?.id,
))
const selectableAdjustmentSites = computed(() => data.value?.sites.filter(
  (site) => !site.archivedAt || site.id === adjustmentSiteId.value,
) ?? [])
const attendanceIndex = computed(() => buildAttendanceIndex(data.value?.attendance ?? []))
const payrollLookup = computed(() => data.value ? buildPayrollLookup(data.value) : null)
const selectedWorker = computed(() => data.value?.workers.find((worker) => worker.id === selectedWorkerId.value) ?? null)
const selectedWorkerReadOnly = computed(() => Boolean(selectedWorker.value?.archivedAt))
const selectedWorkerRateTimeline = computed(() => {
  if (!data.value || !selectedWorker.value || !payrollLookup.value) return []
  const records = data.value.monthlyRecords
    .filter((record) => record.workerId === selectedWorker.value!.id)
    .sort((left, right) => left.month.localeCompare(right.month))
  const result: Array<{ month: string; rateFen: number }> = []
  let previousRate = selectedWorker.value.defaultDailyRateFen
  for (const record of records) {
    const resolved = resolveDailyRate(data.value, selectedWorker.value, record.month, payrollLookup.value)
    if (resolved.rateFen === previousRate) continue
    result.push({ month: record.month, rateFen: resolved.rateFen })
    previousRate = resolved.rateFen
  }
  return result
})
const weeks = computed(() => monthWeeks(isValidMonth(selectedMonth.value) ? selectedMonth.value : currentMonth(), data.value?.settings.weekStartsOn ?? 1))
const headers = computed(() => weekdayLabels(data.value?.settings.weekStartsOn ?? 1))
const gridCells = computed(() => {
  if (!selectedWorker.value) return [] as GridCellRef[]
  const cells: GridCellRef[] = []
  weeks.value.forEach((week, weekIndex) => {
    attendancePeriods.forEach((period, periodIndex) => {
      week.days.forEach((day, weekdayIndex) => {
        if (!day.iso) return
        cells.push(makeGridCell(selectedWorker.value!.id, day.iso, period, weekIndex * 3 + periodIndex, weekdayIndex))
      })
    })
  })
  return cells
})
const attendanceGrid = useAttendanceGrid(gridCells, {
  focusCell: (cell) => void nextTick(() => findGridButton(cell.key)?.focus({ preventScroll: true })),
  canInteract: () => Boolean(data.value && !selectedWorkerReadOnly.value),
  getCellValue: (cell) => statusValue(cell.workerId, cell.date, cell.period),
  canPaintPath: (cell) => Boolean(data.value)
    && allowPaidMonthChanges([{ workerId: cell.workerId, month: cell.date.slice(0, 7) }], '路径刷选')
    && allowFutureAttendance([cell.date], '路径刷选'),
  snapshotDate: (cell) => fullAttendancePatch(data.value!, cell.workerId, cell.date),
  applyPathValue: (cell, value) => {
    if (leaveValue(cell.workerId, cell.date, cell.period)) {
      showInteractionNotice('路径刷选已跳过请假时段。')
      return fullAttendancePatch(data.value!, cell.workerId, cell.date)
    }
    applyAttendancePatch(data.value!, {
      workerId: cell.workerId,
      date: cell.date,
      [cell.period]: value,
    } as AttendancePatch)
    return fullAttendancePatch(data.value!, cell.workerId, cell.date)
  },
  rollbackPath: (patches) => {
    if (!data.value) return
    for (const patch of patches) applyAttendancePatch(data.value, patch)
  },
  onPathCommit: ({ before, after, affectedCellKeys }) => {
    const allowFuture = after.some((patch) => isFutureIsoDate(patch.date))
    enqueueMutation(
      (operationId) => api.setAttendanceBatch(after, { allowFuture, operationId }),
      { onSuccess: () => pushUndo({ kind: 'attendance', label: '路径刷选', before, after }) },
      attendanceConflictKeys(after),
      after,
      undefined,
      affectedCellKeys,
    )
  },
  cellFromPoint,
  cellFromEventTarget: gridCellFromEventTarget,
})
const gridCursor = attendanceGrid.cursor
const hoveredGridCell = attendanceGrid.hovered
const interactionMode = attendanceGrid.interactionMode
const dragSession = attendanceGrid.dragSession
const pendingRegionCells = attendanceGrid.pendingRegionCells
const pendingRegionHasOrdinaryCells = attendanceGrid.pendingRegionHasOrdinaryCells
const isPathPreviewCell = attendanceGrid.isPathPreviewCell
const isRegionSelectedCell = attendanceGrid.isRegionSelectedCell
const clearPendingRegion = attendanceGrid.clearPendingRegion
const cancelGridInteraction = attendanceGrid.cancelInteraction
const cancelDrag = attendanceGrid.cancelDrag
const beginGridPointer = attendanceGrid.beginPointer
const previewGridPointer = attendanceGrid.previewPointer
const trackCapturedPointer = attendanceGrid.trackPointer
const finishGridPointer = attendanceGrid.finishPointer
const currentPayroll = computed(() => {
  if (!data.value || !selectedWorker.value || !payrollLookup.value) return null
  return calculateMonthlyPayroll({ data: data.value, worker: selectedWorker.value, month: selectedMonth.value, lookup: payrollLookup.value })
})
const currentMonthlyRecord = computed(() => {
  if (!data.value || !selectedWorker.value) return null
  return data.value.monthlyRecords.find(
    (record) => record.workerId === selectedWorker.value?.id && record.month === selectedMonth.value,
  ) ?? null
})
const monthlyDrafts = useMonthlyDrafts({
  worker: selectedWorker,
  month: selectedMonth,
  dailyRateFen: computed(() => currentPayroll.value?.dailyRateFen ?? null),
  overtimePayPercent: computed(() => currentPayroll.value?.overtimePayPercent ?? null),
  monthlyNote: computed(() => currentMonthlyRecord.value?.note ?? ''),
  confirmRateChange: (workerId, month) => allowPaidMonthChanges([{ workerId, month }], '修改本月日薪'),
  confirmOvertimeChange: (workerId, month) => allowPaidMonthChanges([{ workerId, month }], '修改本月加班倍率'),
  saveRate: (workerId, month, dailyRateFen) => saveMonthlyRecordWithUndo(
    { workerId, month, dailyRateFen },
    '修改本月日薪',
    'rate',
  ),
  saveOvertimePercent: (workerId, month, overtimePayPercent) => saveMonthlyRecordWithUndo(
    { workerId, month, overtimePayPercent },
    '修改本月加班倍率',
    'overtime',
  ),
  saveNote: (workerId, month, note) => saveMonthlyRecordWithUndo(
    { workerId, month, note },
    '修改本月备注',
    'note',
  ),
})
const monthlyRateDraft = monthlyDrafts.rateDraft
const monthlyRateError = monthlyDrafts.rateError
const monthlyOvertimeDraft = monthlyDrafts.overtimeDraft
const monthlyOvertimeError = monthlyDrafts.overtimeError
const monthlyNoteDraft = monthlyDrafts.noteDraft
const scheduleMonthlyRate = monthlyDrafts.scheduleRate
const flushMonthlyRate = monthlyDrafts.flushRate
const scheduleMonthlyOvertime = monthlyDrafts.scheduleOvertime
const flushMonthlyOvertime = monthlyDrafts.flushOvertime
const scheduleMonthlyNote = monthlyDrafts.scheduleNote
const flushMonthlyNote = monthlyDrafts.flushNote
const currentAdjustments = computed(() => {
  if (!data.value || !selectedWorker.value) return []
  return data.value.payAdjustments
    .filter((item) => item.workerId === selectedWorker.value?.id && item.month === selectedMonth.value)
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.createdAt.localeCompare(b.createdAt))
})
const sidebarGroups = computed(() => {
  if (!data.value) return [] as Array<{ key: string; name: string; workers: Worker[] }>
  const groups = new Map<string, { key: string; name: string; workers: Worker[] }>()
  for (const worker of filteredActiveWorkers.value) {
    const site = worker.defaultSiteId ? data.value.sites.find((candidate) => candidate.id === worker.defaultSiteId) : null
    const key = site?.id ?? 'unassigned'
    const group = groups.get(key) ?? { key, name: site?.name ?? '未分配工地', workers: [] }
    group.workers.push(worker)
    groups.set(key, group)
  }
  return [...groups.values()]
})
const visibleSidebarWorkers = computed(() => sidebarGroups.value.flatMap((group) => group.workers))
const dailyWorkers = computed(() => {
  if (!data.value) return [] as Worker[]
  return data.value.workers.filter((worker) => {
    if (!worker.archivedAt) return true
    return Boolean(
      attendanceFor(worker.id, selectedDate.value)
      || data.value!.payAdjustments.some((item) => item.workerId === worker.id && item.date === selectedDate.value),
    )
  })
})
const filteredDailyWorkers = computed(() => {
  return filterDailyWorkersBySite(dailyWorkers.value, selectedDate.value, dailySiteFilter.value, attendanceIndex.value)
})
const dailyTotals = computed(() => calculateDailyTotals(filteredDailyWorkers.value, selectedDate.value, attendanceIndex.value))
const dailySiteGroups = computed(() => data.value
  ? buildDailySiteGroups(data.value, dailyWorkers.value, selectedDate.value, attendanceIndex.value)
  : [])
const selectedDateIsFuture = computed(() => isFutureIsoDate(selectedDate.value))
const annualSummary = computed(() => {
  if (!data.value || !payrollLookup.value) return null
  const workerIds = annualWorkerFilter.value === 'all' ? undefined : [annualWorkerFilter.value]
  const defaultSiteIds = annualSiteFilter.value === 'all'
    ? undefined
    : [annualSiteFilter.value === 'unassigned' ? null : annualSiteFilter.value]
  const options = { data: data.value, year: selectedYear.value, workerIds, defaultSiteIds, lookup: payrollLookup.value }
  const summary = calculateYearlyPayroll(options)
  if (annualPaidFilter.value === 'all') return summary
  const matchingIds = summary.rows.filter((row) => {
    const effective = row.months.filter((month) => {
      const key = workerMonthKey(row.worker.id, month.month)
      return payrollLookup.value!.attendanceByWorkerMonth.has(key)
        || payrollLookup.value!.monthlyRecordByWorkerMonth.has(key)
        || payrollLookup.value!.adjustmentsByWorkerMonth.has(key)
    })
    if (!effective.length) return false
    const allPaid = effective.every((month) => Boolean(month.paidAt))
    return annualPaidFilter.value === 'paid' ? allPaid : !allPaid
  }).map((row) => row.worker.id)
  return calculateYearlyPayroll({ ...options, workerIds: matchingIds })
})
const siteStatistics = computed(() => {
  if (!data.value) return null
  return calculateSiteStatistics({
    data: data.value,
    period: siteStatisticsMode.value === 'month'
      ? { mode: 'month', month: selectedMonth.value }
      : { mode: 'year', year: selectedYear.value },
    includeEmptySites: true,
  })
})
const backupReminderDue = computed(() => {
  if (!data.value || data.value.workers.length === 0) return false
  const now = Date.now()
  const snoozedAt = data.value.settings.lastBackupReminderAt
  if (snoozedAt && now - Date.parse(snoozedAt) < 7 * 86_400_000) return false
  const baseline = data.value.settings.lastBackupExportAt
    ?? [...data.value.workers].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.createdAt
  return Boolean(baseline && now - Date.parse(baseline) >= 30 * 86_400_000)
})
const singlePayslip = computed(() => {
  if (!data.value || !selectedWorker.value || !payrollLookup.value) return null
  return buildPayslipData({ data: data.value, worker: selectedWorker.value, month: selectedMonth.value, lookup: payrollLookup.value })
})
const batchPayslips = computed(() => {
  if (!data.value || !payrollLookup.value) return []
  const lookup = payrollLookup.value
  return activeWorkers.value.map((worker) => buildPayslipData({ data: data.value!, worker, month: selectedMonth.value, lookup }))
})

function attendanceFor(workerId: string, date: string) {
  return attendanceIndex.value.get(workerDateKey(workerId, date))
}

function statusValue(workerId: string, date: string, period: AttendancePeriod): AttendanceValue {
  return attendanceFor(workerId, date)?.[period] ?? null
}

function leaveValue(workerId: string, date: string, period: AttendancePeriod): OrdinaryLeave | OvertimeLeave | null {
  return attendanceFor(workerId, date)?.[periodLeaveField(period)] ?? null
}

function showInteractionNotice(message: string): void {
  interactionNotice.value = message
  if (interactionNoticeTimer) clearTimeout(interactionNoticeTimer)
  interactionNoticeTimer = setTimeout(() => { interactionNotice.value = '' }, 3_000)
}

function statusSymbol(value: AttendanceValue): string {
  return value === 'present' ? '✓' : value === 'absent' ? '×' : value === 'half' ? '✓' : value === 'full' ? '✓✓' : ''
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : '操作失败，请稍后重试。'
}

async function flushPending(): Promise<void> {
  if (!await flushDayNoteDraft()) throw new Error('单日备注尚未保存，请先处理。')
  await monthlyDrafts.flushAll()
  await flushMutations()
}

function mergePatches(patches: AttendancePatch[]): AttendancePatch[] {
  const merged = new Map<string, AttendancePatch>()
  for (const patch of patches) {
    const key = attendanceKey(patch.workerId, patch.date)
    merged.set(key, { ...(merged.get(key) ?? { workerId: patch.workerId, date: patch.date }), ...patch })
  }
  return [...merged.values()]
}

function pushUndo(transaction: UndoTransactionInput): void {
  undoStack.value.push({ ...transaction, id: ++undoSequence })
  if (undoStack.value.length > 50) undoStack.value.splice(0, undoStack.value.length - 50)
}

function removeUndo(transaction: UndoTransaction): void {
  const index = undoStack.value.findIndex((candidate) => candidate.id === transaction.id)
  if (index >= 0) undoStack.value.splice(index, 1)
}

function snapshotsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function monthlyRecordKey(record: Pick<MonthlyRecord, 'workerId' | 'month'>): string {
  return `${record.workerId}\u0000${record.month}`
}

function collectHistoryTargets(before: AppData, after: AppData): HistoryRevertTarget[] {
  const targets: HistoryRevertTarget[] = []
  const beforeMonthly = new Map(before.monthlyRecords.map((record) => [monthlyRecordKey(record), record]))
  const afterMonthly = new Map(after.monthlyRecords.map((record) => [monthlyRecordKey(record), record]))
  for (const key of new Set([...beforeMonthly.keys(), ...afterMonthly.keys()])) {
    const beforeRecord = beforeMonthly.get(key) ?? null
    const afterRecord = afterMonthly.get(key) ?? null
    if (snapshotsEqual(beforeRecord, afterRecord)) continue
    const source = afterRecord ?? beforeRecord!
    targets.push({
      entity: 'monthlyRecord',
      key: { workerId: source.workerId, month: source.month },
      before: beforeRecord ? structuredClone(beforeRecord) : null,
      after: afterRecord ? structuredClone(afterRecord) : null,
    })
  }

  const beforeAdjustments = new Map(before.payAdjustments.map((item) => [item.id, item]))
  const afterAdjustments = new Map(after.payAdjustments.map((item) => [item.id, item]))
  for (const id of new Set([...beforeAdjustments.keys(), ...afterAdjustments.keys()])) {
    const beforeAdjustment = beforeAdjustments.get(id) ?? null
    const afterAdjustment = afterAdjustments.get(id) ?? null
    if (snapshotsEqual(beforeAdjustment, afterAdjustment)) continue
    targets.push({
      entity: 'payAdjustment',
      key: { id },
      before: beforeAdjustment ? structuredClone(beforeAdjustment) : null,
      after: afterAdjustment ? structuredClone(afterAdjustment) : null,
    })
  }
  const beforeSites = new Map(before.sites.map((site) => [site.id, site]))
  for (const site of after.sites) {
    const previous = beforeSites.get(site.id)
    if (!previous || previous.archivedAt === site.archivedAt) continue
    const workerIds = new Set<string>()
    for (const worker of before.workers) {
      const latest = after.workers.find((candidate) => candidate.id === worker.id)
      if (latest && latest.defaultSiteId !== worker.defaultSiteId) workerIds.add(worker.id)
    }
    const snapshot = (state: AppData) => [...workerIds].sort().map((workerId) => ({
      workerId,
      defaultSiteId: state.workers.find((worker) => worker.id === workerId)?.defaultSiteId ?? null,
    }))
    targets.push({
      entity: 'siteArchive',
      key: { id: site.id },
      before: { archivedAt: previous.archivedAt, workerDefaults: snapshot(before) },
      after: { archivedAt: site.archivedAt, workerDefaults: snapshot(after) },
    })
  }
  return targets
}

function attendanceUndoTargets(transaction: AttendanceUndoTransaction): HistoryRevertTarget[] {
  const fields = [
    'morning',
    'afternoon',
    'overtime',
    'dayNote',
    'morningSiteId',
    'afternoonSiteId',
    'overtimeSiteId',
    'morningLeave',
    'afternoonLeave',
    'overtimeLeave',
  ] as const
  return transaction.after.flatMap((after, index) => {
    const before = transaction.before[index]
    if (!before || before.workerId !== after.workerId || before.date !== after.date) return []
    const beforeFields: Record<string, unknown> = {}
    const afterFields: Record<string, unknown> = {}
    for (const field of fields) {
      const beforeValue = (before as unknown as Record<string, unknown>)[field]
      const afterValue = (after as unknown as Record<string, unknown>)[field]
      if (snapshotsEqual(beforeValue, afterValue)) continue
      beforeFields[field] = beforeValue ?? null
      afterFields[field] = afterValue ?? null
    }
    if (!Object.keys(afterFields).length) return []
    return [{
      entity: 'attendance' as const,
      key: { workerId: after.workerId, date: after.date },
      before: beforeFields,
      after: afterFields,
    }]
  })
}

function enqueueHistoryMutation(
  request: MutationRequest,
  label: string,
  conflictKeys: string[],
): Promise<boolean> {
  let beforeSnapshot: AppData | null = null
  return enqueueMutation(
    async (operationId) => {
      const source = lastSuccessfulSnapshot ?? data.value
      beforeSnapshot = source ? structuredClone(source) : null
      return request(operationId)
    },
    {
      forceApply: true,
      onSuccess: (result) => {
        if (!beforeSnapshot) return
        const targets = collectHistoryTargets(beforeSnapshot, result)
        if (targets.length) pushUndo({ kind: 'history', label, targets })
      },
    },
    conflictKeys,
  )
}

function saveMonthlyRecordWithUndo(
  payload: Parameters<typeof api.setMonthlyRecord>[0],
  label: string,
  field: string,
): Promise<boolean> {
  return enqueueHistoryMutation(
    (operationId) => api.setMonthlyRecord(payload, operationId),
    label,
    [`month:${payload.workerId}:${payload.month}:${field}`],
  )
}

function allowFutureAttendance(dates: readonly string[], label: string): boolean {
  const futureDates = [...new Set(dates.filter((date) => isFutureIsoDate(date)))].sort()
  if (!futureDates.length || futureWriteAllowed) return true
  const range = futureDates.length === 1
    ? futureDates[0]
    : `${futureDates[0]} 至 ${futureDates.at(-1)}`
  const approved = confirm(
    `${label}包含尚未到来的日期（${range}，共 ${futureDates.length} 天）。\n\n确认后，本次打开记工本期间将允许记录未来日期。是否继续？`,
  )
  if (approved) futureWriteAllowed = true
  return approved
}

function paidContextKey(workerId: string, month: string): string {
  return `${workerId}\u0000${month}`
}

function allowPaidMonthChanges(contexts: readonly { workerId: string; month: string }[], label: string): boolean {
  if (!data.value) return false
  const unsettled = [...new Map(contexts.map((item) => [paidContextKey(item.workerId, item.month), item])).values()]
    .filter((item) => {
      const key = paidContextKey(item.workerId, item.month)
      if (paidChangeAcknowledged.has(key)) return false
      return Boolean(data.value?.monthlyRecords.find(
        (record) => record.workerId === item.workerId && record.month === item.month && record.paidAt,
      ))
    })
  if (!unsettled.length) return true
  const names = unsettled.map((item) => data.value?.workers.find((worker) => worker.id === item.workerId)?.name ?? '工人')
  const approved = confirm(`${label}会改变已标记“结清”的工资数据（${[...new Set(names)].join('、')}）。结清标记不会自动取消，请修改后重新核对金额。是否继续？`)
  if (approved) unsettled.forEach((item) => paidChangeAcknowledged.add(paidContextKey(item.workerId, item.month)))
  return approved
}

function wageChangingPatch(patch: AttendancePatch): boolean {
  return patch.morning !== undefined
    || patch.afternoon !== undefined
    || patch.overtime !== undefined
    || patch.morningLeave !== undefined
    || patch.afternoonLeave !== undefined
    || patch.overtimeLeave !== undefined
}

function skipLockedLeaveFields(rawPatches: AttendancePatch[]): AttendancePatch[] {
  let skipped = 0
  const result = rawPatches.map((rawPatch) => {
    const patch = { ...rawPatch } as AttendancePatch
    const entry = attendanceFor(patch.workerId, patch.date)
    if (!entry) return patch
    for (const period of attendancePeriods) {
      const leaveField = periodLeaveField(period)
      const siteField = periodSiteField(period)
      if (!(entry[leaveField] ?? null) || patch[leaveField] !== undefined) continue
      if (patch[period] === undefined && patch[siteField] === undefined) continue
      delete (patch as unknown as Record<string, unknown>)[period]
      delete (patch as unknown as Record<string, unknown>)[siteField]
      skipped += 1
    }
    return patch
  }).filter((patch) => Object.keys(patch).length > 2)
  if (skipped) showInteractionNotice(`已跳过 ${skipped} 个请假时段；请先使用“取消请假”再修改。`)
  return result
}

function commitAttendancePatches(
  rawPatches: AttendancePatch[],
  label: string,
  recordUndo = true,
  allowUnchanged = false,
  onSaved?: () => void,
): Promise<boolean> | null {
  if (!mutationController.acceptingMutations.value || mutationController.unknownMutations.value.length) {
    showInteractionNotice('请先核对尚未确认的保存结果，再继续修改。')
    return null
  }
  if (!data.value || rawPatches.some((patch) => !isValidIsoDate(patch.date))) return null
  const patches = mergePatches(skipLockedLeaveFields(rawPatches))
  const before: AttendancePatch[] = []
  const after: AttendancePatch[] = []
  for (const patch of patches) {
    if (!allowUnchanged && !patchChanged(data.value, patch)) continue
    const snapshot = snapshotPatchFields(data.value, patch)
    before.push(snapshot.before)
    after.push(snapshot.after)
  }
  if (!after.length) return null
  if (!allowPaidMonthChanges(
    after.filter(wageChangingPatch).map((patch) => ({ workerId: patch.workerId, month: patch.date.slice(0, 7) })),
    label,
  )) return null
  if (!allowFutureAttendance(after.map((patch) => patch.date), label)) return null
  for (const patch of after) applyAttendancePatch(data.value, patch)
  const allowFuture = after.some((patch) => isFutureIsoDate(patch.date))
  return enqueueMutation(
    (operationId) => api.setAttendanceBatch(after, { allowFuture, operationId }),
    {
      onSuccess: () => {
        if (recordUndo) pushUndo({ kind: 'attendance', label, before, after })
        onSaved?.()
      },
    },
    attendanceConflictKeys(after),
    after,
  )
}

async function undoLast(): Promise<void> {
  if (undoBusy.value) return
  undoBusy.value = true
  try {
    await flushPending()
    const transaction = undoStack.value.at(-1)
    if (!transaction) return
    let completion: Promise<boolean> | null
    if (transaction.kind === 'attendance') {
      const targets = attendanceUndoTargets(transaction)
      completion = targets.length ? enqueueMutation(
        (operationId) => api.revertHistory(targets, operationId),
        { forceApply: true, onSuccess: () => removeUndo(transaction) },
        attendanceConflictKeys([...transaction.before, ...transaction.after]),
      )
        : null
    } else {
      completion = enqueueMutation(
        (operationId) => api.revertHistory(transaction.targets, operationId),
        { forceApply: true, onSuccess: () => removeUndo(transaction) },
        transaction.targets.map((target) => {
          if (target.entity === 'monthlyRecord') return `month:${target.key.workerId}:${target.key.month}`
          if (target.entity === 'payAdjustment') return `adjustment:${target.key.id}`
          if (target.entity === 'siteArchive') return `site:${target.key.id}:archive`
          return `attendance:${target.key.workerId}:${target.key.date}`
        }),
      )
    }
    if (completion) await completion
  } catch (error) {
    saveError.value = errorMessage(error)
    saveStatus.value = 'error'
  } finally {
    undoBusy.value = false
  }
}

function cycleAttendance(workerId: string, date: string, period: AttendancePeriod): void {
  if (data.value?.workers.find((worker) => worker.id === workerId)?.archivedAt) return
  if (leaveValue(workerId, date, period)) {
    showInteractionNotice('该时段已请假，请先使用“取消请假”。')
    return
  }
  const current = statusValue(workerId, date, period)
  commitAttendancePatches([{ workerId, date, [period]: nextAttendanceValue(period, current) }], '修改考勤')
}

function clearAttendance(workerId: string, date: string, period: AttendancePeriod): void {
  if (data.value?.workers.find((worker) => worker.id === workerId)?.archivedAt) return
  if (leaveValue(workerId, date, period)) {
    showInteractionNotice('请假格不能用 Backspace 或右键清空，请使用“取消请假”。')
    return
  }
  if (statusValue(workerId, date, period) === null) return
  commitAttendancePatches([{ workerId, date, [period]: null }], '清空考勤')
}

function findGridButton(key: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>('.attendance-button[data-cell-key]')]
    .find((button) => button.dataset.cellKey === key) ?? null
}

function focusGridCell(cell: GridCellRef): void {
  attendanceGrid.setCursor(cell, { focus: true })
}

function setGridCursor(cell: GridCellRef): void {
  attendanceGrid.setCursor(cell)
}

function clearHoveredGridCell(): void {
  attendanceGrid.clearHovered()
}

function cellFromPoint(clientX: number, clientY: number): GridCellRef | null {
  if (typeof document.elementFromPoint !== 'function') return null
  const element = document.elementFromPoint(clientX, clientY)
  const button = element?.closest<HTMLElement>('.attendance-button[data-cell-key]')
  return button ? gridCellFromButton(button) : null
}

function gridCellFromEventTarget(target: EventTarget | null): GridCellRef | null {
  const element = target instanceof Element ? target : null
  const button = element?.closest<HTMLElement>('.attendance-button[data-cell-key]')
  return button ? gridCellFromButton(button) : null
}

function handleAttendanceClick(cell: GridCellRef): void {
  setGridCursor(cell)
  if (attendanceGrid.consumeSuppressedClick()) return
  cycleAttendance(cell.workerId, cell.date, cell.period)
}

function setInteractionMode(mode: InteractionMode): void {
  attendanceGrid.setInteractionMode(mode)
}

function setMonthFromToolbar(value: string): void {
  void updateSelectedMonth(value)
}

function applyRegionAction(action: RegionAction): void {
  if (!pendingRegionCells.value.length || !selectedWorker.value || selectedWorkerReadOnly.value) return
  const selection = attendanceGrid.takeRegionSelection()
  const patches = regionActionPatches(action, selection.cells)
  const labels: Record<RegionAction, string> = { full: '区域全勤', rest: '区域全休', grind: '区域卖命' }
  commitAttendancePatches(patches, labels[action])
  if (selection.end) focusGridCell(selection.end)
}

function openLeaveDialogForTargets(targets: readonly GridCellRef[], returnFocus: GridCellRef | null = null): void {
  const unique = new Map(targets.map((cell) => [cell.key, cell]))
  leaveTargets.value = [...unique.values()]
  if (!leaveTargets.value.length) return
  leaveReturnFocus.value = returnFocus
  leaveMorningChoice.value = 'unpaid'
  leaveAfternoonChoice.value = 'unpaid'
  leaveOvertimeChoice.value = 'unpaid'
  for (const cell of leaveTargets.value) {
    const existing = leaveValue(cell.workerId, cell.date, cell.period)
    if (!existing) continue
    if (cell.period === 'morning') leaveMorningChoice.value = existing.payType
    else if (cell.period === 'afternoon') leaveAfternoonChoice.value = existing.payType
    else if (existing.payType === 'unpaid') leaveOvertimeChoice.value = 'unpaid'
    else leaveOvertimeChoice.value = 'units' in existing && existing.units === 'half' ? 'paid-half' : 'paid-full'
  }
  leaveDialogOpen.value = true
}

const leaveReturnFocus = ref<GridCellRef | null>(null)
const leaveTargetPeriods = computed(() => new Set(leaveTargets.value.map((cell) => cell.period)))
const leaveDialogSummary = computed(() => {
  const dates = new Set(leaveTargets.value.map((cell) => cell.date)).size
  return `${dates} 天 · ${leaveTargets.value.length} 个时段`
})
const leaveReplacementCount = computed(() => leaveTargets.value.filter((cell) => {
  const entry = attendanceFor(cell.workerId, cell.date)
  return Boolean(entry?.[cell.period] || entry?.[periodSiteField(cell.period)])
}).length)
const selectedLeaveCount = computed(() => leaveTargets.value.filter(
  (cell) => Boolean(leaveValue(cell.workerId, cell.date, cell.period)),
).length)

function openCellLeaveDialog(cell: GridCellRef): void {
  openLeaveDialogForTargets([cell], cell)
}

function openDayLeaveDialog(workerId: string, date: string, period?: AttendancePeriod): void {
  if (dayDialogOpen.value) void flushDayNoteDraft()
  const periods = period ? [period] : (['morning', 'afternoon'] as AttendancePeriod[])
  openLeaveDialogForTargets(periods.map((item, index) => makeGridCell(workerId, date, item, index, 0)))
}

function openRegionLeaveDialog(): void {
  const selection = attendanceGrid.takeRegionSelection()
  openLeaveDialogForTargets(selection.cells, selection.end)
}

function closeLeaveDialog(): void {
  leaveDialogOpen.value = false
  leaveTargets.value = []
  const target = leaveReturnFocus.value
  leaveReturnFocus.value = null
  if (target) void nextTick(() => focusGridCell(target))
}

function selectedLeaveForPeriod(period: AttendancePeriod): OrdinaryLeave | OvertimeLeave {
  if (period === 'morning') return { payType: leaveMorningChoice.value }
  if (period === 'afternoon') return { payType: leaveAfternoonChoice.value }
  if (leaveOvertimeChoice.value === 'unpaid') return { payType: 'unpaid' }
  return { payType: 'paid', units: leaveOvertimeChoice.value === 'paid-half' ? 'half' : 'full' }
}

function attendancePatchesToLeaveWire(patches: readonly AttendancePatch[]): Parameters<typeof api.setAttendanceLeave>[0] {
  const wire: Parameters<typeof api.setAttendanceLeave>[0] = []
  for (const patch of patches) {
    for (const period of attendancePeriods) {
      const leaveField = periodLeaveField(period)
      const leave = patch[leaveField]
      if (leave === undefined) continue
      if (period === 'overtime') {
        wire.push({ workerId: patch.workerId, date: patch.date, period, leave: leave as OvertimeLeave | null })
      } else {
        wire.push({ workerId: patch.workerId, date: patch.date, period, leave: leave as OrdinaryLeave | null })
      }
    }
  }
  return wire
}

function applyLeaveChanges(cancel: boolean): void {
  if (!data.value || !leaveTargets.value.length || quiescing.value
    || !mutationController.acceptingMutations.value || mutationController.unknownMutations.value.length
    || leaveTargets.value.some((cell) => data.value?.workers.find((worker) => worker.id === cell.workerId)?.archivedAt)) return
  const rawPatches = leaveTargets.value.map((cell) => ({
    workerId: cell.workerId,
    date: cell.date,
    [periodLeaveField(cell.period)]: cancel ? null : selectedLeaveForPeriod(cell.period),
  } as AttendancePatch))
  const replacementCount = cancel ? 0 : leaveTargets.value.filter((cell) => {
    const entry = attendanceFor(cell.workerId, cell.date)
    return Boolean(entry?.[cell.period] || entry?.[periodSiteField(cell.period)])
  }).length
  if (replacementCount && !confirm(`其中 ${replacementCount} 个时段已有出勤或工地；标记请假会清空这些值。是否继续？`)) return
  const before: AttendancePatch[] = []
  const after: AttendancePatch[] = []
  for (const patch of rawPatches) {
    if (!patchChanged(data.value, patch)) continue
    const snapshot = snapshotPatchFields(data.value, patch)
    before.push(snapshot.before)
    after.push(snapshot.after)
  }
  if (!after.length) {
    showInteractionNotice(cancel ? '所选时段没有请假记录。' : '所选时段已是相同请假状态。')
    closeLeaveDialog()
    return
  }
  const label = cancel ? '取消请假' : '标记请假'
  if (!allowPaidMonthChanges(after.map((patch) => ({ workerId: patch.workerId, month: patch.date.slice(0, 7) })), label)) return
  if (!allowFutureAttendance(after.map((patch) => patch.date), label)) return
  for (const patch of after) applyAttendancePatch(data.value, patch)
  const allowFuture = after.some((patch) => isFutureIsoDate(patch.date))
  const wire = attendancePatchesToLeaveWire(after)
  enqueueMutation(
    (operationId) => api.setAttendanceLeave(wire, { allowFuture, operationId }),
    { onSuccess: () => pushUndo({ kind: 'attendance', label, before, after }) },
    attendanceConflictKeys(after),
    after,
    undefined,
    undefined,
    (patches, operationId) => api.setAttendanceLeave(attendancePatchesToLeaveWire(patches), {
      allowFuture: futureWriteAllowed && patches.some((patch) => isFutureIsoDate(patch.date)),
      operationId,
    }),
  )
  closeLeaveDialog()
}

function fillWeek(dates: string[]): void {
  if (!selectedWorker.value || selectedWorker.value.archivedAt) return
  commitAttendancePatches(
    dates.flatMap((date) => [
      { workerId: selectedWorker.value!.id, date, morning: 'present' as const },
      { workerId: selectedWorker.value!.id, date, afternoon: 'present' as const },
    ]),
    '本周全勤',
  )
}

function updateAttendanceSite(workerId: string, date: string, period: AttendancePeriod, siteId: string): void {
  if (data.value?.workers.find((worker) => worker.id === workerId)?.archivedAt) return
  if (leaveValue(workerId, date, period)) {
    showInteractionNotice('请假时段不能分配工地，请先取消请假。')
    return
  }
  const field = periodSiteField(period)
  commitAttendancePatches([{ workerId, date, [field]: siteId || null }], '修改出勤工地')
}

function saveDayNote(workerId: string, date: string, note: string): Promise<boolean> | null {
  if (data.value?.workers.find((worker) => worker.id === workerId)?.archivedAt) return null
  return commitAttendancePatches([{ workerId, date, dayNote: note.slice(0, 1000) }], '修改单日备注')
}

function scheduleDayNote(value: string): void {
  if (dayDialogReadOnly.value) return
  dayDialogNote.value = value.slice(0, 1000)
  dayNoteDirty.value = true
  dayNoteVersion += 1
  if (dayNoteTimer) clearTimeout(dayNoteTimer)
  dayNoteTimer = setTimeout(() => { void flushDayNoteDraft() }, 500)
}

async function flushDayNoteDraft(): Promise<boolean> {
  if (dayNoteTimer) clearTimeout(dayNoteTimer)
  dayNoteTimer = null
  if (!dayNoteDirty.value) return dayNotePending ? await dayNotePending : true
  const version = dayNoteVersion
  const note = dayDialogNote.value
  const completion = saveDayNote(dayDialogWorkerId.value, dayDialogDate.value, note)
  if (!completion) {
    const unchanged = (attendanceFor(dayDialogWorkerId.value, dayDialogDate.value)?.dayNote ?? '') === note
    dayNoteDirty.value = !unchanged
    return unchanged
  }
  dayNoteDirty.value = false
  dayNoteSaving.value = true
  dayNotePending = completion
  const saved = await completion
  if (dayNotePending === completion) {
    dayNotePending = null
    dayNoteSaving.value = false
  }
  // Failed writes remain in the mutation queue and the text stays in this form.
  if (!saved && version === dayNoteVersion) showInteractionNotice('备注尚未保存，请重试；输入内容已保留。')
  return saved
}

function openDayDialog(workerId: string, date: string): void {
  if (dayDialogOpen.value) void flushDayNoteDraft()
  dayNoteVersion += 1
  dayDialogWorkerId.value = workerId
  dayDialogDate.value = date
  dayDialogNote.value = attendanceFor(workerId, date)?.dayNote ?? ''
  dayNoteDirty.value = false
  dayDialogOpen.value = true
}

async function closeDayDialog(): Promise<void> {
  if (dayDialogClosing.value) return
  const workerId = dayDialogWorkerId.value
  const date = dayDialogDate.value
  dayDialogClosing.value = true
  try {
    if (!await flushDayNoteDraft()) return
    if (dayDialogWorkerId.value !== workerId || dayDialogDate.value !== date) return
    const key = `${workerId}|${date}`
    if (failedAttendanceDateKeys.value.has(key) || attendancePeriods.some((period) => failedAttendanceCellKeys.value.has(`${key}|${period}`))) {
      showInteractionNotice('当天仍有未保存的修改，请先重试。')
      return
    }
    dayDialogOpen.value = false
  } finally {
    dayDialogClosing.value = false
  }
}

function setDayAttendance(period: AttendancePeriod, value: AttendanceValue): void {
  if (dayDialogReadOnly.value || leaveValue(dayDialogWorkerId.value, dayDialogDate.value, period)) return
  void commitAttendancePatches([{ workerId: dayDialogWorkerId.value, date: dayDialogDate.value, [period]: value }], '修改考勤')
}

function applyMobileBatch(dates: string[], period: AttendancePeriod, value: AttendanceValue): void {
  if (!selectedWorker.value || selectedWorkerReadOnly.value || quiescing.value) return
  const workerId = selectedWorker.value.id
  const selected = [...new Set(dates)].filter((date) => isValidIsoDate(date) && date.startsWith(`${selectedMonth.value}-`))
  void commitAttendancePatches(selected.map((date) => ({ workerId, date, [period]: value })), '批量记工')
}

function mobileBatchLeave(dates: string[], period: AttendancePeriod): void {
  if (!selectedWorker.value || selectedWorkerReadOnly.value || quiescing.value) return
  openLeaveDialogForTargets([...new Set(dates)].filter((date) => isValidIsoDate(date) && date.startsWith(`${selectedMonth.value}-`))
    .map((date, index) => makeGridCell(selectedWorker.value!.id, date, period, index, 0)))
}

function chooseWorker(workerId: string): void {
  cancelGridInteraction(true)
  selectedWorkerId.value = workerId
  if (!data.value) return
  data.value.settings.currentWorkerId = workerId
  enqueueMutation((operationId) => api.setSettings({ currentWorkerId: workerId }, operationId), {}, ['settings:currentWorkerId'])
}

function switchVisibleWorker(delta: -1 | 1): void {
  const workers = visibleSidebarWorkers.value
  if (!workers.length) return
  const currentIndex = workers.findIndex((worker) => worker.id === selectedWorkerId.value)
  const nextIndex = currentIndex < 0
    ? (delta > 0 ? 0 : workers.length - 1)
    : (currentIndex + delta + workers.length) % workers.length
  chooseWorker(workers[nextIndex].id)
}

function syncSelection(): void {
  if (!data.value) return
  const preferred = selectedWorkerId.value ?? data.value.settings.currentWorkerId
  const preferredWorker = data.value.workers.find((worker) => worker.id === preferred)
  selectedWorkerId.value = preferredWorker?.id ?? activeWorkers.value[0]?.id ?? null
}

function openWorkerDialog(mode: 'add' | 'edit'): void {
  cancelGridInteraction()
  workerDialogMode.value = mode
  workerError.value = ''
  workerSubmitting.value = false
  workerBatchResult.value = null
  workerDialogOpen.value = true
}

function closeWorkerDialog(): void {
  if (!workerSubmitting.value) workerDialogOpen.value = false
}

async function submitWorker(payload: WorkerFormPayload): Promise<void> {
  workerSubmitting.value = true
  workerError.value = ''
  let saved = false
  if (workerDialogMode.value === 'add') {
    saved = await enqueueMutation((operationId) => api.addWorker(payload, operationId), {
      forceApply: true,
      onSuccess: (result) => {
        const newest = [...result.workers].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
        if (newest) selectedWorkerId.value = newest.id
      },
    }, ['workers'])
  } else if (selectedWorker.value) {
    const id = selectedWorker.value.id
    saved = await enqueueMutation((operationId) => api.updateWorker(id, payload, operationId), { forceApply: true }, [`worker:${id}`])
  }
  workerSubmitting.value = false
  if (saved) workerDialogOpen.value = false
  else workerError.value = saveError.value || '工人资料保存失败，请重试。'
}

async function submitBatchWorkers(submission: BatchWorkerSubmission): Promise<void> {
  workerSubmitting.value = true
  workerError.value = ''
  workerBatchResult.value = null
  let completed = 0
  for (const item of submission.items) {
    const saved = await enqueueMutation(
      (operationId) => api.addWorker({
        name: item.name,
        avatarDataUrl: null,
        avatarEmoji: null,
        defaultDailyRateFen: item.defaultDailyRateFen,
        note: '',
        defaultSiteId: item.defaultSiteId,
      }, operationId),
      { forceApply: true },
      ['workers'],
    )
    if (!saved) {
      workerBatchResult.value = {
        requestId: submission.requestId,
        completed,
        remaining: submission.items.slice(completed),
        error: saveError.value,
      }
      workerSubmitting.value = false
      return
    }
    completed += 1
  }
  workerSubmitting.value = false
  workerDialogOpen.value = false
  const newest = [...(data.value?.workers ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (newest) selectedWorkerId.value = newest.id
}

async function setWorkerArchived(worker: Worker, archived: boolean): Promise<boolean> {
  if (archived && !confirm(`确认归档“${worker.name}”？历史考勤、工资和备份都会保留，归档后不可继续记工。`)) return false
  const saved = await enqueueMutation(
    (operationId) => api.updateWorker(worker.id, { archived }, operationId),
    { forceApply: true },
    [`worker:${worker.id}`],
  )
  return saved === true
}

async function archiveSelectedWorker(): Promise<void> {
  if (!selectedWorker.value || selectedWorker.value.archivedAt || workerSubmitting.value) return
  workerSubmitting.value = true
  workerError.value = ''
  const saved = await setWorkerArchived(selectedWorker.value, true)
  workerSubmitting.value = false
  if (saved) {
    workerDialogOpen.value = false
    const configuredWorker = data.value?.workers.find((worker) => (
      worker.id === data.value?.settings.currentWorkerId && !worker.archivedAt
    ))
    selectedWorkerId.value = (configuredWorker ?? activeWorkers.value[0])?.id ?? null
  } else if (saved === false) workerError.value = saveError.value || '归档失败，请重试。'
}

function openAdjustment(item?: PayAdjustment, workerId = selectedWorkerId.value ?? ''): void {
  cancelGridInteraction()
  editingAdjustmentId.value = item?.id ?? null
  adjustmentWorkerId.value = item?.workerId ?? workerId
  adjustmentKind.value = item?.kind ?? 'allowance'
  adjustmentAmount.value = item ? fenToInput(item.amountFen) : ''
  adjustmentLabel.value = item?.label ?? ''
  adjustmentNote.value = item?.note ?? ''
  adjustmentDate.value = item?.date ?? (currentView.value === 'daily' ? selectedDate.value : '')
  adjustmentSiteId.value = item?.siteId ?? null
  adjustmentError.value = ''
  adjustmentDialogOpen.value = true
}

function submitAdjustment(): void {
  const amountFen = parseYuanToFen(adjustmentAmount.value)
  const label = adjustmentLabel.value.trim()
  const date = adjustmentDate.value || null
  const month = date?.slice(0, 7) ?? selectedMonth.value
  if (!adjustmentWorkerId.value || amountFen === null || amountFen <= 0 || !label || (date && !isValidIsoDate(date))) {
    adjustmentError.value = '请选择工人，并填写正数金额、项目和有效日期。'
    return
  }
  const contexts = [{ workerId: adjustmentWorkerId.value, month }]
  if (editingAdjustmentId.value) {
    const existing = data.value?.payAdjustments.find((item) => item.id === editingAdjustmentId.value)
    if (existing) contexts.push({ workerId: existing.workerId, month: existing.month })
  }
  if (!allowPaidMonthChanges(contexts, editingAdjustmentId.value ? '编辑工资明细' : '新增工资明细')) return
  adjustmentDialogOpen.value = false
  const payload = { month, date, kind: adjustmentKind.value, amountFen, label, note: adjustmentNote.value.trim(), siteId: adjustmentSiteId.value }
  if (editingAdjustmentId.value) {
    const id = editingAdjustmentId.value
    enqueueHistoryMutation((operationId) => api.updatePayAdjustment(id, payload, operationId), '编辑工资明细', [`adjustment:${id}`])
  } else {
    enqueueHistoryMutation(
      (operationId) => api.addPayAdjustment({ workerId: adjustmentWorkerId.value, ...payload }, operationId),
      '新增工资明细',
      ['adjustments'],
    )
  }
}

function removeAdjustment(item: PayAdjustment): void {
  if (!allowPaidMonthChanges([{ workerId: item.workerId, month: item.month }], '删除工资明细')) return
  if (!confirm(`确认删除“${item.label}”这笔${item.kind === 'allowance' ? '补贴' : '扣款'}？`)) return
  enqueueHistoryMutation((operationId) => api.deletePayAdjustment(item.id, operationId), '删除工资明细', [`adjustment:${item.id}`])
}

function setMonthlyPaid(paid: boolean): void {
  if (!selectedWorker.value || selectedWorkerReadOnly.value) return
  const workerId = selectedWorker.value.id
  const month = selectedMonth.value
  if (!paid && !confirm(`确认取消 ${selectedWorker.value.name} ${month} 的“已结清”标记？`)) return
  paidChangeAcknowledged.delete(paidContextKey(workerId, month))
  enqueueMutation(
    (operationId) => api.setMonthlyRecord({ workerId, month, paid }, operationId),
    { forceApply: true },
    [`month:${workerId}:${month}:paid`],
  )
}

function openSiteDialog(site?: Site): void {
  editingSiteId.value = site?.id ?? null
  siteName.value = site?.name ?? ''
  siteNote.value = site?.note ?? ''
  siteError.value = ''
  siteDialogOpen.value = true
}

function submitSite(): void {
  const name = siteName.value.trim()
  if (!name) {
    siteError.value = '请输入工地名称。'
    return
  }
  siteDialogOpen.value = false
  if (editingSiteId.value) {
    const id = editingSiteId.value
    enqueueMutation((operationId) => api.updateSite(id, { name, note: siteNote.value.trim() }, operationId), { forceApply: true }, [`site:${id}`])
  } else enqueueMutation((operationId) => api.addSite({ name, note: siteNote.value.trim() }, operationId), { forceApply: true }, ['sites'])
}

function toggleSiteArchived(site: Site): void {
  const archived = !site.archivedAt
  if (!archived) {
    if (!confirm(`确认恢复工地“${site.name}”？恢复后可重新用于默认工地、出勤和工资调整。`)) return
    enqueueHistoryMutation(
      (operationId) => api.updateSite(site.id, { archived: false }, operationId),
      '恢复工地',
      [`site:${site.id}:archive`],
    )
    return
  }
  siteError.value = ''
  siteArchiveTarget.value = site
  siteArchiveReplacementChoice.value = siteArchiveAffectedWorkers.value.length ? '' : '__clear__'
}

function closeSiteArchiveDialog(): void {
  siteArchiveTarget.value = null
  siteArchiveReplacementChoice.value = ''
  siteError.value = ''
}

function confirmSiteArchive(): void {
  const site = siteArchiveTarget.value
  if (!site) return
  if (siteArchiveAffectedWorkers.value.length && !siteArchiveReplacementChoice.value) {
    siteError.value = '请选择新的活动工地，或明确选择“清空默认工地”。'
    return
  }
  const replacementDefaultSiteId = siteArchiveReplacementChoice.value === '__clear__'
    ? null
    : siteArchiveReplacementChoice.value || null
  const conflictKeys = [
    `site:${site.id}:archive`,
    ...siteArchiveAffectedWorkers.value.map((worker) => `worker:${worker.id}:defaultSiteId`),
  ]
  closeSiteArchiveDialog()
  enqueueHistoryMutation(
    (operationId) => api.updateSite(site.id, { archived: true, replacementDefaultSiteId }, operationId),
    '归档工地并重分配默认工地',
    conflictKeys,
  )
}

function setTheme(theme: Theme): void {
  if (!data.value || data.value.settings.theme === theme) return
  data.value.settings.theme = theme
  applyTheme(theme)
  enqueueMutation((operationId) => api.setSettings({ theme }, operationId), {}, ['settings:theme'], undefined, { theme })
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.getElementById('theme-bootstrap')?.remove()
  void window.jigongbenDesktop?.setTheme(theme).catch(() => undefined)
}

function setWeekStartsOn(weekStartsOn: WeekStartsOn): void {
  if (!data.value || data.value.settings.weekStartsOn === weekStartsOn) return
  data.value.settings.weekStartsOn = weekStartsOn
  enqueueMutation((operationId) => api.setSettings({ weekStartsOn }, operationId), {}, ['settings:weekStartsOn'], undefined, { weekStartsOn })
}

function setDefaultOvertimeMultiplier(event: Event): void {
  if (!data.value) return
  const input = event.target as HTMLInputElement
  const defaultOvertimePayPercent = parseOvertimeMultiplier(input.value)
  if (defaultOvertimePayPercent === null) {
    defaultOvertimeError.value = '请输入 0–10 之间、最多两位小数的倍率。'
    input.value = overtimePercentToInput(data.value.settings.defaultOvertimePayPercent)
    return
  }
  defaultOvertimeError.value = ''
  input.value = overtimePercentToInput(defaultOvertimePayPercent)
  if (defaultOvertimePayPercent === data.value.settings.defaultOvertimePayPercent) return
  data.value.settings.defaultOvertimePayPercent = defaultOvertimePayPercent
  enqueueMutation(
    (operationId) => api.setSettings({ defaultOvertimePayPercent }, operationId),
    {},
    ['settings:defaultOvertimePayPercent'],
    undefined,
    { defaultOvertimePayPercent },
  )
}

function setWeeklyAutoBackup(enabled: boolean): void {
  if (!data.value || data.value.settings.weeklyAutoBackupEnabled === enabled) return
  data.value.settings.weeklyAutoBackupEnabled = enabled
  enqueueMutation(
    (operationId) => api.setSettings({ weeklyAutoBackupEnabled: enabled }, operationId),
    { forceApply: true },
    ['settings:weeklyAutoBackupEnabled'],
    undefined,
    { weeklyAutoBackupEnabled: enabled },
  ).then((saved) => {
    if (saved && enabled) void createWeeklyBackup(false)
  })
}

async function createWeeklyBackup(force = true): Promise<void> {
  weeklyBackupMessage.value = ''
  if (!window.jigongbenDesktop) {
    weeklyBackupMessage.value = '每周自动备份仅在 Windows 桌面版可用；浏览器中请继续使用“导出备份”。'
    return
  }
  weeklyBackupBusy.value = true
  try {
    await flushPending()
    const result = await window.jigongbenDesktop.createWeeklyBackupIfDue(force)
    const state = await api.getState()
    rememberSuccessfulState(state, true)
    weeklyBackupMessage.value = result.created
      ? `备份成功：${result.filename ?? '已写入备份目录'}`
      : result.reason === 'disabled'
        ? '每周自动备份当前已关闭。'
        : `尚未到期${result.nextDueAt ? `，下次预计 ${new Date(result.nextDueAt).toLocaleString('zh-CN')}` : '。'}`
  } catch (error) {
    weeklyBackupMessage.value = errorMessage(error)
  } finally {
    weeklyBackupBusy.value = false
    void refreshWeeklyBackupHealth()
  }
}

async function refreshWeeklyBackupHealth(): Promise<void> {
  if (!window.jigongbenDesktop) {
    weeklyBackupHealth.value = null
    return
  }
  try {
    weeklyBackupHealth.value = await window.jigongbenDesktop.getWeeklyBackupStatus()
  } catch {
    weeklyBackupHealth.value = null
  }
}

async function refreshDataCapacityHealth(): Promise<void> {
  try {
    dataCapacityHealth.value = await api.getHealth()
  } catch {
    dataCapacityHealth.value = null
  }
}

function weeklyBackupFailureMessage(code: string | null): string {
  if (code === 'DISK_FULL') return '磁盘空间或配额不足，请清理空间后立即重试。'
  if (code === 'PERMISSION_DENIED') return '文档备份目录不可写，请检查权限。'
  if (code === 'READ_ONLY_FILESYSTEM') return '备份磁盘为只读，请更换可写位置。'
  if (code === 'IO_ERROR') return '备份磁盘发生 I/O 错误，请检查磁盘状态。'
  if (code === 'BACKUP_DIRECTORY_UNAVAILABLE') return '文档备份目录暂不可用。'
  if (code === 'BACKUP_SERVICE_UNAVAILABLE') return '本机备份服务暂不可用。'
  return '自动备份最近一次失败，请立即重试并检查磁盘。'
}

async function openWeeklyBackupFolder(): Promise<void> {
  if (!window.jigongbenDesktop) {
    weeklyBackupMessage.value = '备份目录仅在 Windows 桌面版可打开。'
    return
  }
  try {
    await window.jigongbenDesktop.openWeeklyBackupFolder()
  } catch (error) {
    weeklyBackupMessage.value = errorMessage(error)
  }
}

function toggleSidebar(): void {
  if (!data.value) return
  const sidebarCollapsed = !data.value.settings.sidebarCollapsed
  if (sidebarCollapsed) workerFilterQuery.value = ''
  data.value.settings.sidebarCollapsed = sidebarCollapsed
  enqueueMutation((operationId) => api.setSettings({ sidebarCollapsed }, operationId), {}, ['settings:sidebarCollapsed'], undefined, { sidebarCollapsed })
}

function clearWorkerFilter(): void {
  workerFilterQuery.value = ''
  void nextTick(() => workerFilterInput.value?.focus({ preventScroll: true }))
}

async function exportBackup(): Promise<void> {
  fileOperationError.value = ''
  fileOperationNotice.value = ''
  try {
    await flushPending()
    const result = await downloadBackup()
    if (result.canceled) {
      fileOperationNotice.value = 'JSON 备份导出已取消。'
      return
    }
    const now = new Date().toISOString()
    const saved = await enqueueMutation(
      (operationId) => api.setSettings({ lastBackupExportAt: now, lastBackupReminderAt: null }, operationId),
      {},
      ['settings:lastBackupExportAt', 'settings:lastBackupReminderAt'],
    )
    if (!saved) throw new Error('备份文件已保存，但导出时间没有写入记工本，请重试。')
    fileOperationNotice.value = 'JSON 备份已保存。'
  } catch (error) {
    fileOperationError.value = `JSON 备份导出失败：${errorMessage(error)}`
  }
}

function snoozeBackupReminder(): void {
  if (!data.value) return
  const now = new Date().toISOString()
  data.value.settings.lastBackupReminderAt = now
  enqueueMutation((operationId) => api.setSettings({ lastBackupReminderAt: now }, operationId), {}, ['settings:lastBackupReminderAt'])
}

async function selectRestoreFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  restoreError.value = ''
  restoreInspection.value = null
  restoreOperationId.value = null
  restoreSourceLabel.value = file.name
  try {
    const parsed = JSON.parse(await file.text()) as unknown
    restoreInspection.value = await api.inspectRestore(parsed)
  } catch (error) {
    restoreError.value = error instanceof SyntaxError ? '备份文件不是有效的 JSON。' : errorMessage(error)
  } finally {
    ;(event.target as HTMLInputElement).value = ''
  }
}

async function confirmRestore(): Promise<void> {
  if (!restoreInspection.value) return
  restoring.value = true
  try {
    await flushPending()
    const operationId = restoreOperationId.value ?? createOperationId()
    restoreOperationId.value = operationId
    const restored = await api.restore(restoreInspection.value.data, operationId)
    rememberSuccessfulState(restored)
    data.value = restored
    loadError.value = ''
    undoStack.value = []
    clearFailures()
    cancelGridInteraction(true)
    restoreInspection.value = null
    restoreOperationId.value = null
    restoreSourceLabel.value = ''
    syncSelection()
    applyTheme(restored.settings.theme)
    void loadInternalBackups()
    void refreshDataCapacityHealth()
  } catch (error) {
    restoreError.value = errorMessage(error)
  } finally {
    restoring.value = false
  }
}

function cancelRestore(): void {
  restoreInspection.value = null
  restoreOperationId.value = null
  restoreSourceLabel.value = ''
  restoreError.value = ''
}

function internalBackupKindLabel(kind: InternalBackupMeta['kind']): string {
  if (kind === 'last-good') return '最近有效副本'
  if (kind === 'daily') return '每日备份'
  if (kind === 'pre-restore') return '恢复前备份'
  return '内部备份'
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function loadInternalBackups(): Promise<void> {
  internalBackupsLoading.value = true
  internalBackupsError.value = ''
  try {
    internalBackups.value = (await api.listInternalBackups()).items
  } catch (error) {
    internalBackups.value = []
    internalBackupsError.value = errorMessage(error)
  } finally {
    internalBackupsLoading.value = false
  }
}

async function inspectInternalBackup(item: InternalBackupMeta): Promise<void> {
  inspectingBackupId.value = item.id
  restoreError.value = ''
  restoreOperationId.value = null
  try {
    restoreInspection.value = await api.inspectInternalBackup(item.id)
    restoreSourceLabel.value = `${internalBackupKindLabel(item.kind)} · ${item.filename}`
  } catch (error) {
    restoreError.value = errorMessage(error)
  } finally {
    inspectingBackupId.value = null
  }
}

async function runWorkbookExport(label: string, build: () => ReturnType<typeof exportMonthlyWorkbook>): Promise<void> {
  fileOperationError.value = ''
  fileOperationNotice.value = ''
  let workbook: ReturnType<typeof exportMonthlyWorkbook>
  try {
    workbook = build()
  } catch (error) {
    fileOperationError.value = `${label}生成失败：${errorMessage(error)}`
    return
  }
  try {
    const result = await downloadWorkbook(workbook)
    fileOperationNotice.value = result.canceled ? `${label}已取消。` : `${label}已保存。`
  } catch (error) {
    fileOperationError.value = `${label}写入失败：${errorMessage(error)}`
  }
}

async function exportMonthly(): Promise<void> {
  if (!data.value || !selectedWorker.value) return
  await runWorkbookExport('月表 Excel 导出', () => exportMonthlyWorkbook({ data: data.value!, worker: selectedWorker.value!, month: selectedMonth.value, weekStartsOn: data.value!.settings.weekStartsOn }))
}

async function exportAnnual(): Promise<void> {
  if (!data.value) return
  const workerIds = annualPaidFilter.value === 'all'
    ? (annualWorkerFilter.value === 'all' ? undefined : [annualWorkerFilter.value])
    : annualSummary.value?.rows.map((row) => row.worker.id) ?? []
  const defaultSiteIds = annualSiteFilter.value === 'all' ? undefined : [annualSiteFilter.value === 'unassigned' ? null : annualSiteFilter.value]
  await runWorkbookExport('年度汇总 Excel 导出', () => exportAnnualWorkbook({ data: data.value!, year: selectedYear.value, workerIds, defaultSiteIds }))
}

async function exportSinglePayslip(): Promise<void> {
  if (!data.value || !selectedWorker.value) return
  await runWorkbookExport('单人工资条 Excel 导出', () => exportPayslipWorkbook({ data: data.value!, worker: selectedWorker.value!, month: selectedMonth.value }))
}

async function exportBatchPayslips(): Promise<void> {
  if (!data.value) return
  await runWorkbookExport('批量工资条 Excel 导出', () => exportBatchPayslipWorkbook({ data: data.value!, month: selectedMonth.value, workers: activeWorkers.value }))
}

async function exportSiteStatistics(): Promise<void> {
  if (!data.value || siteStatisticsExporting.value) return
  siteStatisticsExporting.value = true
  await runWorkbookExport('工地统计 Excel 导出', () => exportSiteStatisticsWorkbook({
    data: data.value!,
    period: siteStatisticsMode.value === 'month'
      ? { mode: 'month', month: selectedMonth.value }
      : { mode: 'year', year: selectedYear.value },
    includeEmptySites: true,
  }))
  siteStatisticsExporting.value = false
}

async function startPrint(mode: PrintMode, workerId: string | null = selectedWorkerId.value): Promise<void> {
  printMode.value = mode
  printWorkerId.value = workerId
  document.documentElement.dataset.printMode = mode
  try {
    await nextTick()
    const landscape = mode === 'monthly' || mode === 'annual'
    const desktop = window.jigongbenDesktop
    if (desktop) await desktop.print({ landscape })
    else if (isAndroidApp) {
      const worker = data.value?.workers.find((candidate) => candidate.id === workerId)
      const jobName = mode === 'annual'
        ? `L.Q记工本_${selectedYear.value}年度`
        : mode.startsWith('payslip')
          ? `L.Q记工本_工资条_${selectedMonth.value}_${worker?.name ?? '全部工人'}`
          : `L.Q记工本_记工表_${selectedMonth.value}_${worker?.name ?? ''}`
      await printAndroidPage(safeFilename(jobName), landscape)
    } else window.print()
  } catch (error) {
    fileOperationError.value = `打印失败：${errorMessage(error)}`
  } finally {
    delete document.documentElement.dataset.printMode
    printMode.value = null
  }
}

async function savePdf(mode: PrintMode, workerId: string | null = selectedWorkerId.value): Promise<void> {
  const desktop = window.jigongbenDesktop
  if (!desktop) {
    await startPrint(mode, workerId)
    return
  }
  printMode.value = mode
  printWorkerId.value = workerId
  document.documentElement.dataset.printMode = mode
  try {
    await nextTick()
    const worker = data.value?.workers.find((candidate) => candidate.id === workerId)
    const base = mode === 'annual' ? `年度汇总_${selectedYear.value}` : mode.startsWith('payslip') ? `工资条_${selectedMonth.value}_${worker?.name ?? '全部工人'}` : `记工表_${worker?.name ?? ''}_${selectedMonth.value}`
    const result = await desktop.savePdf({ filename: `${safeFilename(base)}.pdf`, landscape: mode === 'monthly' || mode === 'annual' })
    fileOperationNotice.value = result.canceled ? 'PDF 导出已取消。' : 'PDF 已保存。'
  } catch (error) {
    fileOperationError.value = `PDF 导出失败：${errorMessage(error)}`
  } finally {
    delete document.documentElement.dataset.printMode
    printMode.value = null
  }
}

async function switchMonth(delta: number): Promise<void> {
  const base = isValidMonth(selectedMonth.value) ? selectedMonth.value : currentMonth()
  const cursor = gridCursor.value
  cancelGridInteraction()
  selectedMonth.value = shiftMonth(base, delta)
  selectedYear.value = selectedMonth.value.slice(0, 4)
  if (!cursor || cursor.workerId !== selectedWorkerId.value) return
  const [year, month] = selectedMonth.value.split('-').map(Number)
  const day = Math.min(Number(cursor.date.slice(8)), new Date(year, month, 0).getDate())
  const targetDate = `${selectedMonth.value}-${String(day).padStart(2, '0')}`
  await nextTick()
  const target = gridCells.value.find((cell) => cell.date === targetDate && cell.period === cursor.period)
  if (target) focusGridCell(target)
}

async function updateSelectedMonth(value: string): Promise<void> {
  const target = isValidMonth(value) ? value : currentMonth()
  if (target === selectedMonth.value) return
  const base = isValidMonth(selectedMonth.value) ? selectedMonth.value : currentMonth()
  const [baseYear, baseMonth] = base.split('-').map(Number)
  const [targetYear, targetMonth] = target.split('-').map(Number)
  await switchMonth((targetYear - baseYear) * 12 + targetMonth - baseMonth)
}

function updateSelectedDate(value: string): void {
  selectedDate.value = isValidIsoDate(value) ? value : todayIso()
}

function selectableSitesFor(workerId: string, date: string, period: AttendancePeriod): Site[] {
  if (!data.value) return []
  const currentSiteId = attendanceFor(workerId, date)?.[periodSiteField(period)]
  return data.value.sites.filter((site) => !site.archivedAt || site.id === currentSiteId)
}

function selectWorkerFromOverview(worker: Worker): void {
  cancelGridInteraction(true)
  if (worker.archivedAt) selectedWorkerId.value = worker.id
  else chooseWorker(worker.id)
  currentView.value = 'monthly'
}

function openGlobalSearch(): void {
  cancelGridInteraction()
  globalSearchOpen.value = true
}

function selectGlobalSearchResult(result: GlobalSearchResult): void {
  globalSearchOpen.value = false
  cancelGridInteraction(true)
  const worker = data.value?.workers.find((candidate) => candidate.id === result.workerId)
  if (!worker) return
  if (worker.archivedAt) selectedWorkerId.value = worker.id
  else chooseWorker(worker.id)
  if (result.month) selectedMonth.value = result.month
  if (result.date) {
    selectedDate.value = result.date
    currentView.value = 'daily'
  } else currentView.value = 'monthly'
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
}

function gridCellFromButton(button: HTMLElement): GridCellRef | null {
  const workerId = button.dataset.workerId
  const date = button.dataset.date
  const period = button.dataset.period as AttendancePeriod | undefined
  const row = Number(button.dataset.gridRow)
  const col = Number(button.dataset.gridCol)
  if (!workerId || !date || !period || !Number.isInteger(row) || !Number.isInteger(col)) return null
  return makeGridCell(workerId, date, period, row, col)
}

function moveGridCursor(key: string): boolean {
  return Boolean(attendanceGrid.move(key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'))
}

function focusedGridCell(): GridCellRef | null {
  const active = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>('.attendance-button[data-cell-key]')
    : null
  return active ? gridCellFromButton(active) : null
}

function editingGridTarget(): GridCellRef | null {
  return gridInputMode.value === 'keyboard'
    ? focusedGridCell() ?? gridCursor.value ?? hoveredGridCell.value
    : hoveredGridCell.value ?? focusedGridCell() ?? gridCursor.value
}

function navigationGridTarget(): GridCellRef | null {
  return focusedGridCell() ?? gridCursor.value ?? hoveredGridCell.value
}

function applyNumericAttendanceShortcut(key: string, cell: GridCellRef): boolean {
  let value: AttendanceValue
  if (cell.period === 'overtime') {
    if (key !== '3' && key !== '4') return false
    value = key === '3' ? 'half' : 'full'
  } else {
    if (key !== '1' && key !== '2') return false
    value = key === '1' ? 'present' : 'absent'
  }
  focusGridCell(cell)
  commitAttendancePatches([{ workerId: cell.workerId, date: cell.date, [cell.period]: value }], '键盘快速记工')
  return true
}

function handleShortcut(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || restoring.value || quiescing.value) return
  const primaryModifier = event.ctrlKey || event.metaKey
  if (event.key === 'Escape') {
    if (closeTopModal()) {
      event.preventDefault()
      return
    }
    if (globalSearchOpen.value) {
      event.preventDefault()
      globalSearchOpen.value = false
      return
    }
    if (dragSession.value) {
      event.preventDefault()
      cancelDrag()
      return
    }
    if (pendingRegionCells.value.length) {
      event.preventDefault()
      clearPendingRegion()
      return
    }
    if (helpOpen.value) {
      event.preventDefault()
      helpOpen.value = false
      return
    }
  }
  if (primaryModifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
    const blockingModal = isModalStateOpen() && !globalSearchOpen.value
    if (!blockingModal) {
      event.preventDefault()
      openGlobalSearch()
    }
    return
  }
  if (isModalStateOpen()) return
  if (isTextEditingTarget(event.target)) return
  const arrowKey = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
  if (event.repeat && !arrowKey) return
  if (primaryModifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'z') {
    if (undoStack.value.length) {
      event.preventDefault()
      undoLast()
    }
    return
  }
  if (primaryModifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'n') {
    event.preventDefault()
    openWorkerDialog('add')
    return
  }
  const wantsDesktopToday = desktopAvailable.value && primaryModifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 't'
  const wantsUniversalToday = !primaryModifier && event.altKey && !event.shiftKey && event.key.toLowerCase() === 't'
  if (wantsDesktopToday || wantsUniversalToday) {
    event.preventDefault()
    void goToToday()
    return
  }
  if (currentView.value === 'monthly' && primaryModifier && !event.altKey && !event.shiftKey) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      void switchMonth(-1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      void switchMonth(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      switchVisibleWorker(-1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      switchVisibleWorker(1)
    }
    return
  }
  if (currentView.value !== 'monthly' || primaryModifier || event.altKey || event.shiftKey) return
  const editCell = editingGridTarget()
  if (['1', '2', '3', '4'].includes(event.key)) {
    if (!editCell || event.repeat || selectedWorkerReadOnly.value || !applyNumericAttendanceShortcut(event.key, editCell)) return
    event.preventDefault()
    return
  }
  if (event.key === 'Backspace') {
    if (!editCell || event.repeat || selectedWorkerReadOnly.value) return
    event.preventDefault()
    focusGridCell(editCell)
    clearAttendance(editCell.workerId, editCell.date, editCell.period)
    return
  }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  const cell = navigationGridTarget()
  if (!cell) return
  gridInputMode.value = 'keyboard'
  if (!gridCursor.value || gridCursor.value.key !== cell.key) gridCursor.value = cell
  event.preventDefault()
  if (!moveGridCursor(event.key) && !focusedGridCell()) focusGridCell(cell)
}

function isModalStateOpen(): boolean {
  return Boolean(
    workerDialogOpen.value
    || dayDialogOpen.value
    || adjustmentDialogOpen.value
    || settingsOpen.value
    || siteDialogOpen.value
    || siteArchiveTarget.value
    || archivedOpen.value
    || restoreInspection.value
    || helpOpen.value
    || globalSearchOpen.value
    || leaveDialogOpen.value
    || pendingRegionCells.value.length,
  )
}

function changeView(view: MainView): void {
  if (currentView.value === view) return
  cancelGridInteraction(true)
  currentView.value = view
}

function goToCurrentMonth(): void {
  void updateSelectedMonth(currentMonth())
}

async function goToToday(): Promise<void> {
  const today = todayIso()
  if (currentView.value === 'daily') {
    selectedDate.value = today
    return
  }
  if (currentView.value === 'annual') {
    selectedYear.value = today.slice(0, 4)
    return
  }
  if (currentView.value === 'sites') {
    if (siteStatisticsMode.value === 'month') await updateSelectedMonth(today.slice(0, 7))
    else selectedYear.value = today.slice(0, 4)
    return
  }
  const preferredPeriod = gridCursor.value?.period ?? 'morning'
  await updateSelectedMonth(today.slice(0, 7))
  await nextTick()
  const target = gridCells.value.find((cell) => cell.date === today && cell.period === preferredPeriod)
    ?? gridCells.value.find((cell) => cell.date === today && cell.period === 'morning')
  if (target) {
    gridInputMode.value = 'keyboard'
    focusGridCell(target)
  }
}

function goCurrentSitePeriod(): void {
  void goToToday()
}

function closeHelp(): void {
  helpOpen.value = false
}

function openHelp(): void {
  cancelGridInteraction()
  helpOpen.value = true
}

function closeRegionAction(): void {
  const selection = attendanceGrid.takeRegionSelection()
  if (selection.end) focusGridCell(selection.end)
}

function regionActionDescription(): string {
  return attendanceGrid.regionDescription.value
}

function openArchived(): void {
  cancelGridInteraction()
  archivedOpen.value = true
}

function openSettings(): void {
  cancelGridInteraction()
  settingsOpen.value = true
  void loadInternalBackups()
  void refreshWeeklyBackupHealth()
  void refreshDataCapacityHealth()
}

function openDayDetails(workerId: string, date: string): void {
  cancelGridInteraction()
  openDayDialog(workerId, date)
}

function clearGridCell(event: MouseEvent, cell: GridCellRef): void {
  event.preventDefault()
  if (event.currentTarget instanceof HTMLButtonElement) event.currentTarget.focus({ preventScroll: true })
  setGridCursor(cell)
  clearAttendance(cell.workerId, cell.date, cell.period)
}

function handleGridPointerEnter(cell: GridCellRef, event: PointerEvent): void {
  gridInputMode.value = 'pointer'
  previewGridPointer(cell, event)
}

function handleGridPointerDown(event: PointerEvent, cell: GridCellRef): void {
  gridInputMode.value = 'pointer'
  beginGridPointer(event, cell)
}

function setCursorFromFocus(cell: GridCellRef): void {
  if (!selectedWorkerReadOnly.value) setGridCursor(cell)
}

function interactionTableClass(): Record<string, boolean> {
  return attendanceGrid.interactionTableClasses.value
}

function consumeSuppressedGridClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null
  if (!target?.closest('.attendance-table')) return
  if (!attendanceGrid.consumeSuppressedClick()) return
  event.preventDefault()
  event.stopPropagation()
}

function handleWindowBlur(): void {
  cancelGridInteraction()
}

function dailyAdjustments(workerId: string): PayAdjustment[] {
  return data.value?.payAdjustments.filter((item) => item.workerId === workerId && item.date === selectedDate.value) ?? []
}

function siteNameById(siteId: string | null | undefined): string {
  if (!siteId) return '未分配'
  return data.value?.sites.find((site) => site.id === siteId)?.name ?? '历史工地'
}

function reloadApp(): void {
  window.location.reload()
}

async function handleDesktopCloseRequest(requestId: string): Promise<void> {
  activeCloseRequestId = requestId
  quiescing.value = true
  cancelGridInteraction(true)
  fileOperationNotice.value = ''
  interactionNotice.value = ''
  try {
    // Draft flushes may enqueue their final writes, so stop accepting only
    // after every debounce bucket has been drained.
    if (!await flushDayNoteDraft()) throw new Error('单日备注尚未保存，请先处理。')
    await monthlyDrafts.flushAll()
    if (cancelledCloseRequestIds.has(requestId)) return
    setAcceptingMutations(false)
    try {
      await flushMutations()
    } catch (error) {
      if (saveStatus.value !== 'unknown') throw error
      // A timed-out write may already be committed. Retry the stored task
      // once with its original operationId so the server can return the
      // persisted receipt without duplicating the mutation.
      await retryFailed()
      await flushMutations()
    }
    if (cancelledCloseRequestIds.has(requestId)) return
    const acknowledgement = await window.jigongbenDesktop!.completeClose({ requestId, ok: true })
    if (!acknowledgement.accepted) {
      setAcceptingMutations(true)
      quiescing.value = false
      fileOperationError.value = '关闭确认已过期，程序仍保持打开；正在处理最新的关闭请求。'
    }
  } catch (error) {
    if (cancelledCloseRequestIds.has(requestId)) return
    try {
      await window.jigongbenDesktop?.completeClose({ requestId, ok: false, error: errorMessage(error) })
    } finally {
      setAcceptingMutations(true)
      quiescing.value = false
    }
  } finally {
    const wasCancelled = cancelledCloseRequestIds.delete(requestId)
    if (activeCloseRequestId === requestId) activeCloseRequestId = null
    if (wasCancelled) {
      setAcceptingMutations(true)
      quiescing.value = false
    }
  }
}

function cancelDesktopCloseRequest(_requestId: string): void {
  // “取消关闭” applies to the whole close attempt. A retry may already have a
  // newer requestId queued while the earlier flush is still settling, so drop
  // every queued request and cancel whichever handler is currently active.
  pendingCloseRequestId = null
  if (activeCloseRequestId) cancelledCloseRequestIds.add(activeCloseRequestId)
  setAcceptingMutations(true)
  quiescing.value = false
  fileOperationError.value = '已取消关闭，可以继续编辑；尚未完成的保存仍会在后台核对。'
}

function queueDesktopCloseRequest(requestId: string): void {
  // The main process may issue a fresh requestId after its previous handshake
  // timed out. Retain the latest request while the old flush is still running;
  // otherwise the retry would be silently dropped by the quiescing guard.
  pendingCloseRequestId = requestId
  if (closeRequestDrain) return
  closeRequestDrain = (async () => {
    while (pendingCloseRequestId) {
      const nextRequestId = pendingCloseRequestId
      pendingCloseRequestId = null
      await handleDesktopCloseRequest(nextRequestId)
    }
  })().catch((error) => {
    setAcceptingMutations(true)
    quiescing.value = false
    fileOperationError.value = `无法响应关闭请求：${errorMessage(error)}`
  }).finally(() => {
    closeRequestDrain = null
    if (pendingCloseRequestId) queueDesktopCloseRequest(pendingCloseRequestId)
  })
}

onMounted(async () => {
  updateVisualViewport()
  window.visualViewport?.addEventListener('resize', updateVisualViewport)
  window.addEventListener('resize', updateVisualViewport)
  document.addEventListener('visibilitychange', flushOnBackground)
  if (isAndroidApp) {
    void Promise.all([
      CapacitorApp.addListener('backButton', () => { void handleAndroidBack() }),
      CapacitorApp.addListener('pause', () => { void flushDayNoteDraft(); void monthlyDrafts.flushAll() }),
    ]).then(([back, pause]) => {
      if (appDisposed) { void back.remove(); void pause.remove(); return }
      androidBackListener = back
      androidPauseListener = pause
    }).catch(() => { showInteractionNotice('系统返回监听未就绪，请使用面板内的关闭按钮。') })
  }
  window.addEventListener('keydown', trapModalTab, true)
  window.addEventListener('keydown', handleShortcut)
  window.addEventListener('pointermove', trackCapturedPointer)
  window.addEventListener('pointerup', finishGridPointer)
  window.addEventListener('pointercancel', cancelDrag)
  window.addEventListener('click', consumeSuppressedGridClick, true)
  window.addEventListener('blur', handleWindowBlur)
  modalFocusObserver = new MutationObserver(syncModalFocus)
  modalFocusObserver.observe(document.body, { childList: true, subtree: true })
  removeCloseListener = window.jigongbenDesktop?.onCloseRequested(queueDesktopCloseRequest) ?? null
  removeCloseCancelledListener = window.jigongbenDesktop?.onCloseCancelled(cancelDesktopCloseRequest) ?? null
  try {
    const initialState = await api.getState()
    rememberSuccessfulState(initialState)
    data.value = initialState
    selectedWorkerId.value = data.value.settings.currentWorkerId
    syncSelection()
    applyTheme(data.value.settings.theme)
    void refreshWeeklyBackupHealth()
    void refreshDataCapacityHealth()
  } catch (error) {
    loadError.value = errorMessage(error)
    await loadInternalBackups()
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  appDisposed = true
  void flushDayNoteDraft()
  if (dayNoteTimer) clearTimeout(dayNoteTimer)
  window.visualViewport?.removeEventListener('resize', updateVisualViewport)
  window.removeEventListener('resize', updateVisualViewport)
  document.removeEventListener('visibilitychange', flushOnBackground)
  void androidBackListener?.remove()
  void androidPauseListener?.remove()
  window.removeEventListener('keydown', trapModalTab, true)
  window.removeEventListener('keydown', handleShortcut)
  window.removeEventListener('pointermove', trackCapturedPointer)
  window.removeEventListener('pointerup', finishGridPointer)
  window.removeEventListener('pointercancel', cancelDrag)
  window.removeEventListener('click', consumeSuppressedGridClick, true)
  window.removeEventListener('blur', handleWindowBlur)
  modalFocusObserver?.disconnect()
  modalFocusObserver = null
  activeModalDialog = null
  modalReturnFocus = null
  removeCloseListener?.()
  removeCloseCancelledListener?.()
  void monthlyDrafts.dispose()
  if (interactionNoticeTimer) clearTimeout(interactionNoticeTimer)
  disposeMutations()
  attendanceGrid.dispose()
})

watch(selectedMonth, (month) => {
  if (isValidMonth(month)) selectedYear.value = month.slice(0, 4)
})

watch(selectedWorkerId, (workerId, previousWorkerId) => {
  if (previousWorkerId && workerId !== previousWorkerId) cancelGridInteraction(true)
})

watch(currentView, (view, previousView) => {
  if (view !== previousView) cancelGridInteraction(true)
})
</script>

<template>
  <main v-if="loading" class="loading-screen">正在打开记工本…</main>
  <main v-else-if="loadError" class="loading-screen error-screen">
    <h1>记工本暂时打不开</h1>
    <p>{{ loadError }}</p>
    <button class="primary-button" type="button" @click="reloadApp">重新加载</button>
    <section class="load-recovery-panel" aria-labelledby="load-recovery-title">
      <div class="section-toolbar">
        <div><span class="eyebrow">本机数据保护</span><h2 id="load-recovery-title">从内部备份恢复</h2></div>
        <button class="button button-ghost" type="button" :disabled="internalBackupsLoading" @click="loadInternalBackups">刷新</button>
      </div>
      <p>可先预览程序自动保存的有效副本，也可选择一份手动导出的 JSON；两种来源都会先经过完整迁移与校验。</p>
      <div class="modal-actions load-recovery-actions">
        <button class="button button-secondary" type="button" :disabled="restoring" @click="restoreInput?.click()">选择手动 JSON 备份</button>
        <input ref="restoreInput" type="file" accept="application/json,.json" hidden @change="selectRestoreFile">
      </div>
      <p v-if="internalBackupsLoading" role="status">正在读取内部备份…</p>
      <p v-else-if="internalBackupsError" class="form-error" role="alert">{{ internalBackupsError }}</p>
      <div v-else-if="internalBackups.length" class="internal-backup-list">
        <article v-for="item in internalBackups" :key="item.id" class="internal-backup-card">
          <div><strong>{{ internalBackupKindLabel(item.kind) }}</strong><span>{{ new Date(item.modifiedAt).toLocaleString('zh-CN') }} · {{ formatFileSize(item.size) }}</span><small>{{ item.filename }} · 完整内容只在点击预览后校验</small></div>
          <button class="button button-secondary" type="button" :disabled="Boolean(inspectingBackupId)" @click="inspectInternalBackup(item)">{{ inspectingBackupId === item.id ? '正在预览…' : '预览并恢复' }}</button>
        </article>
      </div>
      <p v-else class="empty-list">没有可用的内部备份。</p>
    </section>
  </main>
  <main v-else-if="data" class="app-shell" :class="{ 'is-sidebar-collapsed': data.settings.sidebarCollapsed, 'is-quiescing': quiescing }" :aria-busy="quiescing">
    <header class="app-header">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">L.Q</div>
        <div><h1>记工本</h1><p>离线记工 · 数据只留在本机</p></div>
      </div>
      <div class="header-actions">
        <div class="save-indicator" :class="`is-${saveStatus}`" role="status">
          <span class="status-dot"></span>
          <span>{{ saveStatus === 'saving' ? '正在保存' : saveStatus === 'saved' ? '已保存' : saveStatus === 'unknown' ? '等待确认' : saveStatus === 'error' ? '保存失败' : '自动保存' }}</span>
        </div>
        <button class="button button-ghost undo-button" type="button" :disabled="undoStack.length === 0 || undoBusy" title="撤销最近一次支持的操作 (Ctrl+Z)" aria-label="撤销" @click="undoLast"><UiIcon name="undo" /><span class="header-button-label">撤销</span></button>
        <button class="icon-button mobile-help-button" type="button" title="操作说明" aria-label="操作说明" @click="openHelp"><UiIcon name="help" /></button>
        <button class="button button-ghost" type="button" title="全局搜索 (Ctrl+F)" aria-label="搜索" @click="openGlobalSearch"><UiIcon name="search" /><span class="header-button-label">搜索</span></button>
        <button class="button button-ghost" type="button" title="设置" aria-label="设置" @click="openSettings"><UiIcon name="settings" /><span class="header-button-label">设置</span></button>
      </div>
    </header>

    <section v-if="isAndroidApp" class="android-app-banner" role="status">
      <strong>Android 离线版</strong>
      <span>数据只保存在本设备；可从“设置”导入或导出完整 JSON 备份。</span>
    </section>

    <Transition name="fade">
      <section v-if="backupReminderDue" class="backup-reminder" role="status">
        <div><strong>建议导出一份备份</strong><p>距上次成功导出已超过 30 天，留一份 JSON 文件会更安心。</p></div>
        <div class="backup-reminder-actions">
          <button class="button button-primary" type="button" @click="exportBackup">立即导出</button>
          <button class="button button-ghost" type="button" @click="snoozeBackupReminder">7 天后提醒</button>
        </div>
      </section>
    </Transition>

    <div v-if="saveStatus === 'error' || saveStatus === 'unknown'" class="error-banner" role="alert">
      <span>{{ saveError }}</span>
      <button type="button" @click="retryFailed">{{ saveStatus === 'unknown' ? '核对并重试' : '重试未保存修改' }}</button>
    </div>

    <div class="workspace" :class="{ 'is-sidebar-collapsed': data.settings.sidebarCollapsed }">
      <aside class="sidebar" :class="{ collapsed: data.settings.sidebarCollapsed }">
        <div class="sidebar-heading">
          <div><span class="eyebrow">工人</span><strong>{{ filteredActiveWorkers.length }} / {{ activeWorkers.length }} 人</strong></div>
          <div class="sidebar-heading-actions">
            <button class="icon-button" type="button" :title="data.settings.sidebarCollapsed ? '展开侧栏' : '折叠侧栏'" :aria-label="data.settings.sidebarCollapsed ? '展开侧栏' : '折叠侧栏'" @click="toggleSidebar"><UiIcon :name="data.settings.sidebarCollapsed ? 'chevron-right' : 'chevron-left'" /></button>
          </div>
        </div>
        <label class="worker-filter" :class="{ 'has-query': workerFilterQuery }">
          <span class="sr-only">筛选工人姓名</span>
          <input ref="workerFilterInput" v-model="workerFilterQuery" type="search" placeholder="筛选工人姓名" autocomplete="off" @keydown.esc="workerFilterQuery = ''">
          <button v-if="workerFilterQuery" type="button" aria-label="清空工人筛选" title="清空筛选" @click="clearWorkerFilter"><UiIcon name="close" :size="15" /></button>
        </label>
        <div class="worker-list">
          <template v-for="group in sidebarGroups" :key="group.key">
            <div class="site-group-heading"><span>{{ group.name }}</span><small>{{ group.workers.length }}</small></div>
            <div v-for="worker in group.workers" :key="worker.id" class="worker-row" :class="{ active: worker.id === selectedWorkerId }">
              <button class="worker-select" type="button" :title="worker.name" @click="chooseWorker(worker.id)">
                <WorkerAvatar class="avatar" :worker="worker" :size="36" />
                <span class="worker-copy"><strong>{{ worker.name }}</strong><small>{{ siteNameById(worker.defaultSiteId) }}</small></span>
              </button>
              <button class="worker-menu" type="button" title="编辑资料" aria-label="编辑资料" @click="chooseWorker(worker.id); openWorkerDialog('edit')"><UiIcon name="more" /></button>
            </div>
          </template>
          <p v-if="activeWorkers.length === 0" class="sidebar-empty">还没有工人</p>
          <p v-else-if="filteredActiveWorkers.length === 0" class="sidebar-empty">没有匹配的工人</p>
          <div class="mobile-worker-actions">
            <button class="mobile-add-worker" type="button" title="添加工人" aria-label="添加工人" @click="openWorkerDialog('add')"><UiIcon name="user-plus" /></button>
            <button class="mobile-archived-worker" type="button" title="已归档工人" aria-label="已归档工人" @click="openArchived"><UiIcon name="archive" /><small>{{ archivedWorkers.length }}</small></button>
          </div>
        </div>
        <button class="add-worker-button" type="button" title="添加工人 (Ctrl+N)" @click="openWorkerDialog('add')"><UiIcon name="user-plus" /><span class="worker-copy">添加工人</span></button>
        <div class="sidebar-footer">
          <button class="archived-button" type="button" title="已归档工人" aria-label="已归档工人" @click="openArchived"><UiIcon class="button-icon" name="archive" /><span class="button-label sidebar-footer-label">已归档 {{ archivedWorkers.length }}</span></button>
          <button class="help-button" type="button" title="操作说明" aria-label="操作说明" @click="openHelp"><UiIcon class="button-icon" name="help" /><span class="button-label sidebar-footer-label">操作说明</span></button>
        </div>
      </aside>

      <section class="main-content">
        <nav class="view-tabs" aria-label="主视图">
          <button type="button" :class="{ active: currentView === 'monthly' }" :aria-selected="currentView === 'monthly'" @click="changeView('monthly')" aria-label="个人月表"><span class="desktop-only">个人月表</span><span class="mobile-only">月历</span></button>
          <button type="button" :class="{ active: currentView === 'daily' }" :aria-selected="currentView === 'daily'" @click="changeView('daily')" aria-label="当日总览"><span class="desktop-only">当日总览</span><span class="mobile-only">当日</span></button>
          <button type="button" :class="{ active: currentView === 'annual' }" :aria-selected="currentView === 'annual'" @click="changeView('annual')" aria-label="年度汇总"><span class="desktop-only">年度汇总</span><span class="mobile-only">年度</span></button>
          <button type="button" :class="{ active: currentView === 'sites' }" :aria-selected="currentView === 'sites'" @click="changeView('sites')" aria-label="工地统计"><span class="desktop-only">工地统计</span><span class="mobile-only">工地</span></button>
        </nav>

        <MonthlyView
          v-if="currentView === 'monthly' && selectedWorker"
          :worker="selectedWorker"
          :read-only="selectedWorkerReadOnly || quiescing"
          :payroll="currentPayroll"
          :adjustments="currentAdjustments"
          :selected-month="selectedMonth"
          :weeks="weeks"
          :headers="headers"
          :interaction-mode="interactionMode"
          :interaction-table-classes="interactionTableClass()"
          :grid-cursor="gridCursor"
          :hovered-grid-cell="hoveredGridCell"
          :monthly-rate-draft="monthlyRateDraft"
          :monthly-rate-error="monthlyRateError"
          :monthly-overtime-draft="monthlyOvertimeDraft"
          :monthly-overtime-error="monthlyOvertimeError"
          :monthly-note-draft="monthlyNoteDraft"
          :failed-cell-keys="failedAttendanceCellKeys"
          :failed-date-keys="failedAttendanceDateKeys"
          :attendance-for="attendanceFor"
          :status-value="statusValue"
          :leave-value="leaveValue"
          :site-name-by-id="siteNameById"
          :is-path-preview-cell="isPathPreviewCell"
          :is-region-selected-cell="isRegionSelectedCell"
          @edit-worker="openWorkerDialog('edit')"
          @switch-month="switchMonth"
          @set-month="setMonthFromToolbar"
          @current-month="goToCurrentMonth"
          @set-mode="setInteractionMode"
          @fill-week="fillWeek"
          @open-day="openDayDetails"
          @mobile-batch="applyMobileBatch"
          @mobile-batch-leave="mobileBatchLeave"
          @clear-hover="clearHoveredGridCell"
          @focus-cell="setCursorFromFocus"
          @pointer-down="handleGridPointerDown"
          @pointer-enter="handleGridPointerEnter"
          @attendance-click="handleAttendanceClick"
          @clear-cell="clearGridCell"
          @leave-cell="openCellLeaveDialog"
          @rate-input="scheduleMonthlyRate"
          @rate-blur="flushMonthlyRate"
          @overtime-input="scheduleMonthlyOvertime"
          @overtime-blur="flushMonthlyOvertime"
          @note-input="scheduleMonthlyNote"
          @note-blur="flushMonthlyNote"
          @set-paid="setMonthlyPaid"
          @add-adjustment="openAdjustment()"
          @edit-adjustment="openAdjustment"
          @remove-adjustment="removeAdjustment"
          @export-monthly="exportMonthly"
          @export-payslip="exportSinglePayslip"
          @print-monthly="startPrint('monthly')"
          @print-payslip="startPrint('payslip-single')"
          @pdf-payslip="savePdf('payslip-single')"
          @export-batch="exportBatchPayslips"
          @print-batch="startPrint('payslip-batch', null)"
          @pdf-batch="savePdf('payslip-batch', null)"
        />

        <section v-else-if="currentView === 'monthly'" class="empty-workspace">
          <div class="empty-illustration" aria-hidden="true">
            <svg viewBox="0 0 64 64" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 17h32a5 5 0 0 1 5 5v25a5 5 0 0 1-5 5H14a5 5 0 0 1-5-5V22a5 5 0 0 1 5-5Z" />
              <path d="M20 11v12M40 11v12M9 28h42" />
              <path d="m33 43 14-14 5 5-14 14-7 2 2-7Z" fill="var(--green-soft)" />
              <path d="m44 32 5 5" />
            </svg>
          </div>
          <h2>先添加一名工人</h2>
          <p>添加后即可按上午、下午和加班记录。</p>
          <button class="button button-primary" type="button" @click="openWorkerDialog('add')">添加工人</button>
        </section>

        <DailyView
          v-else-if="currentView === 'daily'"
          v-model:site-filter="dailySiteFilter"
          :data="data"
          :selected-date="selectedDate"
          :future-date="selectedDateIsFuture"
          :groups="dailySiteGroups"
          :totals="dailyTotals"
          :workers="filteredDailyWorkers"
          :failed-cell-keys="failedAttendanceCellKeys"
          :failed-date-keys="failedAttendanceDateKeys"
          :attendance-for="attendanceFor"
          :status-value="statusValue"
          :leave-value="leaveValue"
          :selectable-sites-for="selectableSitesFor"
          :daily-adjustments="dailyAdjustments"
          @update:selected-date="updateSelectedDate"
          @select-worker="selectWorkerFromOverview"
          @cycle="cycleAttendance"
          @clear="clearAttendance"
          @leave="(workerId, date, period) => openDayLeaveDialog(workerId, date, period)"
          @update-site="updateAttendanceSite"
          @save-note="saveDayNote"
          @edit-adjustment="openAdjustment"
          @add-adjustment="openAdjustment(undefined, $event)"
        />

        <AnnualView
          v-else-if="currentView === 'annual'"
          v-model:selected-year="selectedYear"
          v-model:worker-filter="annualWorkerFilter"
          v-model:site-filter="annualSiteFilter"
          v-model:paid-filter="annualPaidFilter"
          v-model:metric="annualMetric"
          :data="data"
          :summary="annualSummary"
          @export="exportAnnual"
          @print="startPrint('annual', null)"
          @pdf="savePdf('annual', null)"
        />

        <SiteStatisticsView
          v-else
          v-model:mode="siteStatisticsMode"
          v-model:selected-month="selectedMonth"
          v-model:selected-year="selectedYear"
          :summary="siteStatistics"
          :exporting="siteStatisticsExporting"
          @current-period="goCurrentSitePeriod"
          @export="exportSiteStatistics"
        />
      </section>
    </div>

    <section v-if="printMode === 'payslip-single' && printSinglePayslip" class="payslip-list print-only"><PayslipSheet :slip="printSinglePayslip" /></section>
    <section v-if="printMode === 'payslip-batch'" class="payslip-list print-only"><PayslipSheet v-for="slip in batchPayslips" :key="slip.worker.id" :slip="slip" /></section>

    <GlobalSearchDialog :open="globalSearchOpen" :query="globalSearchQuery" :results="globalSearchResults" @close="globalSearchOpen = false" @update:query="globalSearchQuery = $event" @select="selectGlobalSearchResult" />

    <Transition name="modal">
      <div v-if="pendingRegionCells.length" class="modal-backdrop" @mousedown.self="closeRegionAction">
        <section class="modal region-action-modal region-action-dialog" role="dialog" aria-modal="true" aria-label="区域记工选项">
          <div class="modal-header">
            <div><span class="eyebrow">区域圈选</span><h2>选择记工方式</h2></div>
            <button class="icon-button" type="button" aria-label="取消区域操作" @click="closeRegionAction"><UiIcon name="close" /></button>
          </div>
          <div class="region-action-content">
            <p class="region-action-summary">{{ regionActionDescription() }}</p>
            <div class="region-action-grid">
              <button class="region-action-option region-action-button" data-action="full" type="button" :disabled="!pendingRegionHasOrdinaryCells" @click="applyRegionAction('full')"><strong>全勤</strong><span>选区内上午、下午标记为 ✓；加班不变。</span></button>
              <button class="region-action-option region-action-button" data-action="rest" type="button" @click="applyRegionAction('rest')"><strong>全休</strong><span>选区内上午、下午标记为 ×；加班清空。</span></button>
              <button class="region-action-option region-action-button" data-action="grind" type="button" @click="applyRegionAction('grind')"><strong>卖命</strong><span>选区内上午、下午及加班全部标记为单钩。</span></button>
              <button class="region-action-option region-action-button" data-action="leave" type="button" @click="openRegionLeaveDialog"><strong>请假</strong><span>逐时段选择带薪或无薪；加班带薪需另选半工或一工。</span></button>
            </div>
            <div class="modal-actions"><button class="button button-ghost" type="button" @click="closeRegionAction">取消，不修改</button></div>
          </div>
        </section>
      </div>
    </Transition>

    <Transition name="modal">
      <div v-if="leaveDialogOpen" class="modal-backdrop" @mousedown.self="closeLeaveDialog">
        <section class="modal leave-dialog" role="dialog" aria-modal="true" aria-labelledby="leave-dialog-title">
          <div class="modal-header">
            <div><span class="eyebrow">请假设置 · {{ leaveDialogSummary }}</span><h2 id="leave-dialog-title">标记或取消请假</h2></div>
            <button class="icon-button" type="button" aria-label="关闭请假设置" @click="closeLeaveDialog"><UiIcon name="close" /></button>
          </div>
          <div class="modal-form">
            <p>请假格仍可聚焦和圈选，但普通点击、数字键、Backspace、路径刷选、批量记工和工地修改都不会覆盖它。</p>
            <label v-if="leaveTargetPeriods.has('morning')" class="form-field"><span>上午请假</span><select v-model="leaveMorningChoice"><option value="unpaid">无薪（0 元）</option><option value="paid">带薪（0.5 个当月日薪）</option></select></label>
            <label v-if="leaveTargetPeriods.has('afternoon')" class="form-field"><span>下午请假</span><select v-model="leaveAfternoonChoice"><option value="unpaid">无薪（0 元）</option><option value="paid">带薪（0.5 个当月日薪）</option></select></label>
            <label v-if="leaveTargetPeriods.has('overtime')" class="form-field"><span>加班请假</span><select v-model="leaveOvertimeChoice"><option value="unpaid">无薪（0 元）</option><option value="paid-half">带薪半工（按当月加班倍率）</option><option value="paid-full">带薪一工（按当月加班倍率）</option></select></label>
            <div v-if="leaveReplacementCount" class="warning-callout">应用后会原子清空 {{ leaveReplacementCount }} 个时段已有的出勤和实际工地；提交前还会再次确认。</div>
            <p v-if="selectedLeaveCount" class="backup-status-message">所选范围已有 {{ selectedLeaveCount }} 个请假时段；取消请假不会恢复之前被替换的出勤。</p>
            <div class="modal-actions">
              <button class="button button-ghost" type="button" @click="closeLeaveDialog">返回</button>
              <button class="button button-secondary" type="button" @click="applyLeaveChanges(true)">取消请假</button>
              <button class="button button-primary" type="button" @click="applyLeaveChanges(false)">应用请假</button>
            </div>
          </div>
        </section>
      </div>
    </Transition>

    <Transition name="modal">
      <div v-if="helpOpen" class="modal-backdrop" @mousedown.self="closeHelp">
        <section class="modal modal-wide help-modal help-dialog" role="dialog" aria-modal="true" aria-label="操作说明">
          <div class="modal-header">
            <div><span class="eyebrow">简易使用指南</span><h2>操作说明</h2></div>
            <button class="icon-button" type="button" aria-label="关闭操作说明" @click="closeHelp"><UiIcon name="close" /></button>
          </div>
          <div class="help-guide">
            <section class="help-guide-section mobile-only"><h3>手机记工</h3><p>点月历中的日期，进入当日面板。出工、工地和备注会自动保存，完成后关闭面板。请假需要选定类型后应用；批量记工先选择日期，再应用修改。滑动页面不会修改记工。</p><p>在“编辑资料”的默认工地列表里选择“新增工地”，保存后即可选用。</p></section>
            <section class="help-guide-section desktop-only"><h3>鼠标记工</h3><ul><li><strong>单格：</strong>左键依次循环“空白 → ✓ → ×”，右键直接清空。</li><li><strong>路径刷选：</strong>选中该模式后，按住左键沿经过的格子涂刷；上午、下午可互刷，加班单独刷。</li><li><strong>区域圈选：</strong>从一个考勤格拖到另一个格，松开后选择“全勤 / 全休 / 卖命”；确认前不会修改数据。</li><li><strong>本周全勤：</strong>日期行左侧按钮会把当周上午和下午设为出工，不改加班。</li></ul></section>
            <section class="help-guide-section desktop-only"><h3>键盘快捷键</h3><dl class="help-shortcut-list"><div><dt><kbd>Ctrl</kbd> + <kbd>Z</kbd></dt><dd>撤销最近一次支持的操作，最多 50 步。</dd></div><div><dt><kbd>Ctrl</kbd> + <kbd>N</kbd></dt><dd>打开“添加工人”。</dd></div><div><dt><kbd>Ctrl</kbd> + <kbd>F</kbd></dt><dd>搜索工人、人员/日/月备注和补贴扣款。</dd></div><div><dt><kbd>Ctrl</kbd> + <kbd>T</kbd> / <kbd>Alt</kbd> + <kbd>T</kbd></dt><dd>回到今天；Ctrl+T 仅用于 Windows 安装版，Alt+T 在所有运行方式可用。</dd></div><div><dt><kbd>Ctrl</kbd> + <kbd>←</kbd> / <kbd>→</kbd></dt><dd>切换上月 / 下月。</dd></div><div><dt><kbd>Ctrl</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd></dt><dd>按侧栏当前可见顺序切换工人。</dd></div><div><dt><kbd>←</kbd> / <kbd>→</kbd></dt><dd>在同一时段向前 / 向后选择日期。</dd></div><div><dt><kbd>↑</kbd> / <kbd>↓</kbd></dt><dd>沿表格同一列移动；从加班向下会到下周同列上午。</dd></div><div><dt><kbd>1</kbd> / <kbd>2</kbd></dt><dd>上午、下午直接标记出工 / 未出工。</dd></div><div><dt><kbd>3</kbd> / <kbd>4</kbd></dt><dd>加班直接标记半工 / 一工。</dd></div><div><dt><kbd>Backspace</kbd></dt><dd>清空鼠标停留或键盘聚焦的考勤格。</dd></div></dl><p>方向键移动后，数字键和 Backspace 始终作用于最新键盘焦点；真实移动鼠标后才切回鼠标目标。输入框和弹窗中保留系统原有操作。</p></section>
            <section class="help-guide-section"><h3>保存与备份</h3><p>所有修改自动保存。建议定期从“设置”导出 JSON 备份；打印和 PDF 始终使用浅色白底。</p></section>
          </div>
          <div class="modal-actions"><button class="button button-primary" type="button" @click="closeHelp">知道了</button></div>
        </section>
      </div>
    </Transition>

    <WorkerDialog
      :open="workerDialogOpen"
      :mode="workerDialogMode"
      :worker="workerDialogMode === 'edit' ? selectedWorker : null"
      :sites="activeSites"
      :all-sites="data.sites"
      :create-site="workerSiteCreation.createSite"
      :cancel-site-creation="workerSiteCreation.cancelSiteCreation"
      :existing-names="data.workers.map(worker => worker.name)"
      :submitting="workerSubmitting"
      :server-error="workerError"
      :batch-result="workerBatchResult"
      :rate-timeline="selectedWorkerRateTimeline"
      @close="closeWorkerDialog"
      @archive="archiveSelectedWorker"
      @submit-single="submitWorker"
      @submit-batch="submitBatchWorkers"
    />

    <DayDetailsDialog
      :open="dayDialogOpen && !leaveDialogOpen"
      :worker="dayDialogWorker"
      :date="dayDialogDate"
      :entry="attendanceFor(dayDialogWorkerId, dayDialogDate)"
      :sites="data.sites"
      :read-only="dayDialogReadOnly"
      :note="dayDialogNote"
      :note-pending="dayNoteDirty || dayNoteSaving"
      :save-status="saveStatus"
      :save-error="saveError"
      @close="closeDayDialog"
      @status="setDayAttendance"
      @site="(period, siteId) => updateAttendanceSite(dayDialogWorkerId, dayDialogDate, period, siteId)"
      @leave="(period) => openDayLeaveDialog(dayDialogWorkerId, dayDialogDate, period)"
      @note-input="scheduleDayNote"
      @note-blur="flushDayNoteDraft"
      @retry="retryFailed"
    />

    <Transition name="modal"><div v-if="adjustmentDialogOpen" class="modal-backdrop" @mousedown.self="adjustmentDialogOpen = false"><section class="modal" role="dialog" aria-modal="true"><div class="modal-header"><div><span class="eyebrow">工资调整</span><h2>{{ editingAdjustmentId ? '编辑明细' : '新增补贴或扣款' }}</h2></div><button class="icon-button" type="button" aria-label="关闭工资调整" @click="adjustmentDialogOpen = false"><UiIcon name="close" /></button></div><form class="modal-form" @submit.prevent="submitAdjustment"><label class="form-field"><span>工人</span><select v-model="adjustmentWorkerId" :disabled="Boolean(editingAdjustmentId)"><option v-for="worker in activeWorkers" :key="worker.id" :value="worker.id">{{ worker.name }}</option></select></label><fieldset><legend>类型</legend><label class="radio-card"><input v-model="adjustmentKind" type="radio" value="allowance"><span>补贴</span></label><label class="radio-card"><input v-model="adjustmentKind" type="radio" value="deduction"><span>扣款</span></label></fieldset><label class="form-field"><span>正数金额</span><div class="money-input"><span>¥</span><input v-model="adjustmentAmount" inputmode="decimal"></div></label><label class="form-field"><span>项目</span><input v-model="adjustmentLabel" maxlength="100" placeholder="例如：高温补贴"></label><label class="form-field"><span>日期（可选）</span><input v-model="adjustmentDate" type="date"><small>不选日期则归入当前月份。</small></label><label class="form-field"><span>归属工地（可选）</span><select v-model="adjustmentSiteId"><option :value="null">未归属调整</option><option v-for="site in selectableAdjustmentSites" :key="site.id" :value="site.id" :disabled="Boolean(site.archivedAt)">{{ site.name }}{{ site.archivedAt ? '（已归档，仅保留原引用）' : '' }}</option></select><small>选择后计入工地完整成本；不选则进入“未归属调整”桶。</small></label><label class="form-field"><span>备注</span><textarea v-model="adjustmentNote" maxlength="500"></textarea></label><p v-if="adjustmentError" class="form-error">{{ adjustmentError }}</p><div class="modal-actions"><button class="button button-ghost" type="button" @click="adjustmentDialogOpen = false">取消</button><button class="button button-primary" type="submit">保存</button></div></form></section></div></Transition>

    <Transition name="modal">
      <div v-if="settingsOpen" class="modal-backdrop" @mousedown.self="settingsOpen = false">
        <section class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div class="modal-header"><div><span class="eyebrow">偏好与数据</span><h2 id="settings-title">设置</h2></div><button class="icon-button" type="button" aria-label="关闭设置" @click="settingsOpen = false"><UiIcon name="close" /></button></div>
          <div class="settings-content">
            <fieldset><legend>显示主题</legend><label class="radio-card"><input type="radio" name="theme" :checked="data.settings.theme === 'light'" @change="setTheme('light')"><span>浅色<small>清爽纸张风格</small></span></label><label class="radio-card"><input type="radio" name="theme" :checked="data.settings.theme === 'dark'" @change="setTheme('dark')"><span>深色<small>夜间更柔和</small></span></label></fieldset>
            <fieldset><legend>每周起始日</legend><label class="radio-card"><input type="radio" name="week" :checked="data.settings.weekStartsOn === 1" @change="setWeekStartsOn(1)"><span>周一</span></label><label class="radio-card"><input type="radio" name="week" :checked="data.settings.weekStartsOn === 0" @change="setWeekStartsOn(0)"><span>周日</span></label></fieldset>
            <label class="form-field settings-multiplier"><span>新月份默认加班倍率</span><div class="multiplier-input"><input :value="overtimePercentToInput(data.settings.defaultOvertimePayPercent)" inputmode="decimal" aria-label="新月份默认加班倍率" @change="setDefaultOvertimeMultiplier"><span>倍</span></div><small>创建月记录时冻结；修改默认值不会追溯既有月份。</small><small v-if="defaultOvertimeError" class="form-error">{{ defaultOvertimeError }}</small></label>
            <section class="site-section"><div class="section-toolbar"><h2>工地管理</h2><button class="button button-primary" type="button" @click="openSiteDialog()">新增工地</button></div><div class="site-list"><article v-for="site in data.sites" :key="site.id" class="site-card" :class="{ 'is-archived': site.archivedAt }"><div><h3>{{ site.name }}</h3><p>{{ site.note || '无备注' }}<span v-if="site.archivedAt"> · 已归档</span></p></div><div class="site-card-actions"><button class="link-button" type="button" @click="openSiteDialog(site)">编辑</button><button class="link-button" type="button" @click="toggleSiteArchived(site)">{{ site.archivedAt ? '恢复' : '归档' }}</button></div></article><p v-if="data.sites.length === 0" class="empty-list">还没有工地。</p></div></section>
            <section class="data-tools weekly-backup-settings">
              <div class="section-toolbar"><div><span class="eyebrow">{{ isAndroidApp ? 'Android 离线版' : 'Windows 桌面版' }}</span><h2>{{ isAndroidApp ? '设备内数据保护' : '每周外部备份' }}</h2></div><label v-if="desktopAvailable" class="toggle-field"><input type="checkbox" :checked="data.settings.weeklyAutoBackupEnabled" @change="setWeeklyAutoBackup(($event.target as HTMLInputElement).checked)"><span>{{ data.settings.weeklyAutoBackupEnabled ? '已开启' : '已关闭' }}</span></label></div>
              <p v-if="desktopAvailable">开启后在启动及运行中检查；超过 7 天会写入“文档\L.Q记工本备份”，仅保留最近 12 份。关闭程序后不会驻留后台。</p>
              <p v-else-if="isAndroidApp">应用会在私有目录维护最近有效、每日和恢复前备份；请定期手动导出到设备外。</p>
              <p v-else>浏览器启动方式不会写入固定目录，请使用下面的手动导出。</p>
              <small v-if="data.settings.lastWeeklyBackupAt">上次成功：{{ new Date(data.settings.lastWeeklyBackupAt).toLocaleString('zh-CN') }}</small><small v-else-if="desktopAvailable">尚无成功的每周备份。</small>
              <div v-if="weeklyBackupHealth?.lastFailureAt" class="warning-callout backup-health-warning" role="alert"><strong>自动备份需要处理</strong><span>{{ weeklyBackupFailureMessage(weeklyBackupHealth.errorCode) }}</span><small>最近失败：{{ new Date(weeklyBackupHealth.lastFailureAt).toLocaleString('zh-CN') }}</small></div>
              <div v-if="desktopAvailable" class="modal-actions"><button class="button button-secondary" type="button" :disabled="weeklyBackupBusy || !data.settings.weeklyAutoBackupEnabled" @click="createWeeklyBackup(true)">{{ weeklyBackupBusy ? '正在备份…' : '立即备份' }}</button><button class="button button-ghost" type="button" @click="openWeeklyBackupFolder">打开备份目录</button></div>
              <p v-if="weeklyBackupMessage" class="backup-status-message" role="status">{{ weeklyBackupMessage }}</p>
            </section>
            <section class="data-tools data-capacity-settings">
              <h2>数据容量</h2>
              <p v-if="dataCapacityHealth && dataCapacityHealth.dataSizeBytes !== null">当前完整账本约 {{ formatFileSize(dataCapacityHealth.dataSizeBytes) }} / {{ formatFileSize(dataCapacityHealth.dataLimitBytes) }}。</p>
              <p v-else>容量状态暂不可用；重新打开设置时会再次检查。</p>
              <div v-if="dataCapacityHealth?.dataSizeWarning" class="warning-callout" role="alert"><strong>账本已接近容量上限</strong><span>请先导出完整 JSON 备份，并清理不再需要的历史头像或记录；达到上限后程序会在写盘前安全拒绝新增数据。</span></div>
            </section>
            <section class="internal-backups-section">
              <div class="section-toolbar"><div><span class="eyebrow">自动数据保护</span><h2>内部备份</h2></div><button class="button button-ghost" type="button" :disabled="internalBackupsLoading" @click="loadInternalBackups">刷新</button></div>
              <p>这些副本由程序保存在本机数据目录；预览通过后才会恢复，界面不会暴露或接受文件路径。</p>
              <p v-if="internalBackupsLoading" class="backup-status-message" role="status">正在读取内部备份…</p>
              <p v-else-if="internalBackupsError" class="form-error" role="alert">{{ internalBackupsError }}</p>
              <div v-else-if="internalBackups.length" class="internal-backup-list">
                <article v-for="item in internalBackups" :key="item.id" class="internal-backup-card">
                  <div><div class="internal-backup-title"><strong>{{ internalBackupKindLabel(item.kind) }}</strong><span>{{ item.filename }}</span></div><span>{{ new Date(item.modifiedAt).toLocaleString('zh-CN') }} · {{ formatFileSize(item.size) }}</span><small>点击预览后才读取、迁移并校验完整备份。</small></div>
                  <button class="button button-secondary" type="button" :disabled="Boolean(inspectingBackupId)" @click="inspectInternalBackup(item)">{{ inspectingBackupId === item.id ? '正在预览…' : '预览并恢复' }}</button>
                </article>
              </div>
              <p v-else class="empty-list">没有可用的内部备份。</p>
            </section>
            <section class="data-tools"><h2>手动 JSON 备份</h2><p>导出完整 JSON，可在另一台设备手动恢复。恢复前会先保存当前数据。</p><div class="modal-actions"><button class="button button-secondary" type="button" @click="exportBackup">导出备份</button><button class="button button-ghost" type="button" @click="restoreInput?.click()">从 JSON 恢复</button><input ref="restoreInput" type="file" accept="application/json,.json" hidden @change="selectRestoreFile"></div><small v-if="data.settings.lastBackupExportAt">上次成功导出：{{ new Date(data.settings.lastBackupExportAt).toLocaleString('zh-CN') }}</small></section>
            <p class="local-data-note">完全离线：不联网、不登录、不自动跨设备同步。</p>
          </div>
        </section>
      </div>
    </Transition>

    <Transition name="modal"><div v-if="siteDialogOpen" class="modal-backdrop" @mousedown.self="siteDialogOpen = false"><section class="modal" role="dialog" aria-modal="true"><div class="modal-header"><h2>{{ editingSiteId ? '编辑工地' : '新增工地' }}</h2><button class="icon-button" type="button" aria-label="关闭工地编辑" @click="siteDialogOpen = false"><UiIcon name="close" /></button></div><form class="modal-form" @submit.prevent="submitSite"><label class="form-field"><span>工地名称</span><input v-model="siteName" maxlength="100" autofocus></label><label class="form-field"><span>备注</span><textarea v-model="siteNote" maxlength="500"></textarea></label><p v-if="siteError" class="form-error">{{ siteError }}</p><div class="modal-actions"><button class="button button-ghost" type="button" @click="siteDialogOpen = false">取消</button><button class="button button-primary" type="submit">保存</button></div></form></section></div></Transition>

    <Transition name="modal">
      <div v-if="siteArchiveTarget" class="modal-backdrop" @mousedown.self="closeSiteArchiveDialog">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="site-archive-title">
          <div class="modal-header"><div><span class="eyebrow">危险操作</span><h2 id="site-archive-title">归档“{{ siteArchiveTarget.name }}”</h2></div><button class="icon-button" type="button" aria-label="取消归档工地" @click="closeSiteArchiveDialog"><UiIcon name="close" /></button></div>
          <div class="modal-form">
            <p>历史考勤、工资及既有补贴扣款引用会保留；归档后不能再用于新增记录。</p>
            <div class="warning-callout"><strong>受影响默认工人：{{ siteArchiveAffectedWorkers.length }} 人</strong><span v-if="siteArchiveAffectedWorkers.length">{{ siteArchiveAffectedWorkers.map(worker => worker.name).join('、') }}</span><span v-else>没有工人的默认工地需要改动。</span></div>
            <label v-if="siteArchiveAffectedWorkers.length" class="form-field"><span>这些工人的新默认工地</span><select v-model="siteArchiveReplacementChoice" @change="siteError = ''"><option value="" disabled>请选择处理方式</option><option value="__clear__">明确清空默认工地</option><option v-for="candidate in siteArchiveReplacementSites" :key="candidate.id" :value="candidate.id">改为 {{ candidate.name }}</option></select><small>只改变默认分配；历史出勤的实际工地不会被改写。</small></label>
            <p v-if="siteError" class="form-error" role="alert">{{ siteError }}</p>
            <div class="modal-actions"><button class="button button-ghost" type="button" @click="closeSiteArchiveDialog">取消</button><button class="button button-danger" type="button" @click="confirmSiteArchive">确认归档</button></div>
          </div>
        </section>
      </div>
    </Transition>

    <Transition name="modal"><div v-if="archivedOpen" class="modal-backdrop" @mousedown.self="archivedOpen = false"><section class="modal" role="dialog" aria-modal="true"><div class="modal-header"><h2>已归档工人</h2><button class="icon-button" type="button" aria-label="关闭归档列表" @click="archivedOpen = false"><UiIcon name="close" /></button></div><div class="settings-content"><div v-for="worker in archivedWorkers" :key="worker.id" class="archived-row"><span>{{ worker.name }}</span><div class="row-actions"><button class="link-button" type="button" @click="selectedWorkerId = worker.id; currentView = 'monthly'; archivedOpen = false">查看历史</button><button class="link-button" type="button" @click="setWorkerArchived(worker, false)">恢复</button></div></div><p v-if="!archivedWorkers.length" class="empty-list">没有已归档工人。</p></div></section></div></Transition>

  </main>

  <Transition name="modal"><div v-if="restoreInspection" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><div class="modal-header"><div><span v-if="restoreSourceLabel" class="eyebrow">{{ restoreSourceLabel }}</span><h2>确认恢复备份</h2></div></div><div class="restore-content"><p>备份已通过{{ isAndroidApp ? '应用内' : '服务端' }}完整校验，将迁移为数据 v{{ restoreInspection.schemaVersion }}。</p><div class="restore-summary-grid"><div><span>工人</span><strong>{{ restoreInspection.workerCount }}</strong></div><div><span>考勤</span><strong>{{ restoreInspection.attendanceCount }}</strong></div><div><span>补贴扣款</span><strong>{{ restoreInspection.adjustmentCount }}</strong></div><div><span>工地</span><strong>{{ restoreInspection.siteCount }}</strong></div></div><div class="warning-callout">恢复会替换当前数据；系统会先自动创建一份恢复前备份，并清空当前撤销历史。</div><div class="modal-actions"><button class="button button-ghost" type="button" :disabled="restoring" @click="cancelRestore">取消</button><button class="button button-danger" type="button" :disabled="restoring" @click="confirmRestore">{{ restoring ? '正在恢复…' : '确认恢复' }}</button></div></div></section></div></Transition>
  <Transition name="fade"><div v-if="restoreError" class="toast" role="alert">{{ restoreError }} <button class="link-button" type="button" @click="restoreError = ''">关闭</button></div></Transition>
  <Transition name="fade"><div v-if="fileOperationError" class="toast file-operation-toast is-error" role="alert">{{ fileOperationError }} <button class="link-button" type="button" @click="fileOperationError = ''">关闭</button></div></Transition>
  <Transition name="fade"><div v-if="fileOperationNotice" class="toast file-operation-toast" role="status">{{ fileOperationNotice }} <button class="link-button" type="button" @click="fileOperationNotice = ''">关闭</button></div></Transition>
  <Transition name="fade"><div v-if="interactionNotice" class="toast interaction-toast" role="status">{{ interactionNotice }} <button class="link-button" type="button" @click="interactionNotice = ''">关闭</button></div></Transition>
</template>
