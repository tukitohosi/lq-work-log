import { computed, ref, type Ref } from 'vue'
import { ApiError } from '../api'
import { applyAttendancePatch, periodSiteField } from '../attendance'
import type { AppData, AttendancePatch, AttendancePeriod, Settings } from '../types'
import { materializeMutationResponse, type AppMutationResponse } from '../mutation-response'
import { createOperationId } from '../operation-id'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'unknown'
export type MutationRequest = (operationId: string) => Promise<AppMutationResponse>
export type MutationOptions = {
  forceApply?: boolean
  onSuccess?: (result: AppData) => void
  onQueued?: (operationId: string) => void
}

export interface MutationTask {
  id: number
  operationId: string
  request: MutationRequest
  options: MutationOptions
  conflictVersions: Map<string, number>
  optimisticAttendance?: AttendancePatch[]
  attendanceRequest?: (patches: AttendancePatch[], operationId: string) => Promise<AppMutationResponse>
  optimisticSettings?: Partial<Settings>
  affectedCellKeys?: string[]
  affectedDateKeys?: string[]
  complete: (saved: boolean) => void
}

export interface MutationMetadata {
  optimisticAttendance?: AttendancePatch[]
  attendanceRequest?: (patches: AttendancePatch[], operationId: string) => Promise<AppMutationResponse>
  optimisticSettings?: Partial<Settings>
  affectedCellKeys?: Iterable<string>
  affectedDateKeys?: Iterable<string>
}

interface UseMutationsOptions {
  data: Ref<AppData | null>
  onStateApplied?: (state: AppData) => void
}

const ATTENDANCE_FIELDS = [
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

function cellKey(workerId: string, date: string, period: AttendancePeriod): string {
  return `${workerId}|${date}|${period}`
}

function dateKey(workerId: string, date: string): string {
  return `${workerId}|${date}`
}

function affectedKeysFromPatches(patches: readonly AttendancePatch[]): { cells: string[]; dates: string[] } {
  const cells = new Set<string>()
  const dates = new Set<string>()
  for (const patch of patches) {
    if (patch.dayNote !== undefined) dates.add(dateKey(patch.workerId, patch.date))
    for (const period of ['morning', 'afternoon', 'overtime'] as const) {
      const leaveField = `${period}Leave` as keyof AttendancePatch
      if (patch[period] !== undefined || patch[periodSiteField(period)] !== undefined || patch[leaveField] !== undefined) {
        cells.add(cellKey(patch.workerId, patch.date, period))
      }
    }
  }
  return { cells: [...cells], dates: [...dates] }
}

function cloneStateShell(state: AppData): AppData {
  return {
    ...state,
    workers: [...state.workers],
    attendance: [...state.attendance],
    monthlyRecords: [...state.monthlyRecords],
    payAdjustments: [...state.payAdjustments],
    sites: [...state.sites],
    settings: { ...state.settings },
  }
}

export function useMutations({ data, onStateApplied }: UseMutationsOptions) {
  const saveStatus = ref<SaveStatus>('idle')
  const saveError = ref('')
  const failedMutations = ref<MutationTask[]>([])
  const unknownMutations = ref<MutationTask[]>([])
  const acceptingMutations = ref(true)
  const conflictVersions = new Map<string, number>()
  const queuedTasks: MutationTask[] = []
  let activeTask: MutationTask | null = null
  let mutationSequence = 0
  let pendingMutations = 0
  let processingPromise: Promise<void> | null = null
  let latestSuccessfulState: AppData | null = null
  let savedTimer: ReturnType<typeof setTimeout> | null = null

  function taskIsCurrent(task: MutationTask): boolean {
    return [...task.conflictVersions].every(([key, version]) => conflictVersions.get(key) === version)
  }

  function applyState(state: AppData): void {
    data.value = state
    onStateApplied?.(state)
  }

  function optimisticTasks(): MutationTask[] {
    return [
      ...failedMutations.value,
      ...unknownMutations.value,
      ...(activeTask ? [activeTask] : []),
      ...queuedTasks,
    ].filter(taskIsCurrent).sort((left, right) => left.id - right.id)
  }

  function reconcileLatestState(): void {
    if (!latestSuccessfulState) return
    // Attendance patches replace their touched entity and settings writes only
    // touch this copied settings object. A structural shell is therefore enough
    // to isolate optimistic UI state without cloning every historical record.
    const reconciled = cloneStateShell(latestSuccessfulState)
    for (const task of optimisticTasks()) {
      for (const patch of task.optimisticAttendance ?? []) applyAttendancePatch(reconciled, patch)
      if (task.optimisticSettings) Object.assign(reconciled.settings, task.optimisticSettings)
    }
    applyState(reconciled)
  }

  function setLatestSuccessfulState(state: AppData, apply = false): void {
    latestSuccessfulState = structuredClone(state)
    if (apply) applyState(state)
  }

  function markSaved(): void {
    if (savedTimer) clearTimeout(savedTimer)
    saveStatus.value = 'saved'
    savedTimer = setTimeout(() => {
      if (pendingMutations === 0 && failedMutations.value.length === 0 && unknownMutations.value.length === 0) {
        saveStatus.value = 'idle'
      }
    }, 1_500)
  }

  function updateStatus(): void {
    if (unknownMutations.value.length) saveStatus.value = 'unknown'
    else if (pendingMutations > 0) saveStatus.value = 'saving'
    else if (failedMutations.value.length) saveStatus.value = 'error'
    else markSaved()
  }

  function retainedFailedTasks(candidates: readonly MutationTask[], versions: Map<string, number>): MutationTask[] {
    const retained: MutationTask[] = []
    for (const candidate of candidates) {
      const overlaps = [...candidate.conflictVersions.keys()].some((key) => versions.has(key))
      if (!overlaps) {
        retained.push(candidate)
        continue
      }
      if (!candidate.optimisticAttendance) continue
      const remaining = candidate.optimisticAttendance.map((patch) => {
        const kept: AttendancePatch = { workerId: patch.workerId, date: patch.date }
        for (const field of ATTENDANCE_FIELDS) {
          const key = `attendance:${patch.workerId}:${patch.date}:${field}`
          const value = (patch as unknown as Record<string, unknown>)[field]
          if (value !== undefined && !versions.has(key)) {
            ;(kept as unknown as Record<string, unknown>)[field] = value
          }
        }
        return kept
      }).filter((patch) => Object.keys(patch).length > 2)
      if (!remaining.length) continue
      const remainingConflictKeys = attendanceConflictKeys(remaining)
      const remainingVersions = new Map<string, number>()
      for (const key of remainingConflictKeys) {
        remainingVersions.set(key, candidate.conflictVersions.get(key) ?? conflictVersions.get(key) ?? 0)
      }
      const affected = affectedKeysFromPatches(remaining)
      retained.push({
        ...candidate,
        id: ++mutationSequence,
        operationId: createOperationId(),
        request: candidate.attendanceRequest
          ? (operationId) => candidate.attendanceRequest!(remaining, operationId)
          : candidate.request,
        conflictVersions: remainingVersions,
        optimisticAttendance: remaining,
        affectedCellKeys: affected.cells,
        affectedDateKeys: affected.dates,
      })
    }
    return retained
  }

  function deferQueuedTasksForRetry(): void {
    const deferred = queuedTasks.splice(0)
    if (!deferred.length) return
    failedMutations.value.push(...deferred)
    pendingMutations -= deferred.length
    for (const task of deferred) task.complete(false)
  }

  async function runQueue(): Promise<void> {
    while (queuedTasks.length && unknownMutations.value.length === 0) {
      const task = queuedTasks.shift()!
      activeTask = task
      let saved = false
      try {
        const response = await task.request(task.operationId)
        const result = materializeMutationResponse(latestSuccessfulState ?? data.value, response)
        // materializeMutationResponse produces a new immutable server baseline.
        // Keep it directly; reconcileLatestState creates the isolated UI shell.
        latestSuccessfulState = result
        task.options.onSuccess?.(result)
        saved = true
      } catch (error) {
        if (taskIsCurrent(task)) {
          if (error instanceof ApiError && error.code === 'MUTATION_RESULT_UNKNOWN') {
            unknownMutations.value.push(task)
            saveError.value = error.message
            // The server result of this task must be resolved before later
            // operations are sent. Keep every unsent task intact for an
            // ordered retry, but release callers that are waiting to flush.
            deferQueuedTasksForRetry()
          } else {
            failedMutations.value.push(task)
            saveError.value = error instanceof Error ? error.message : '操作失败，请稍后重试。'
          }
        }
      } finally {
        activeTask = null
        pendingMutations -= 1
        task.complete(saved)
        reconcileLatestState()
        updateStatus()
      }
    }
  }

  function ensureProcessing(): void {
    if (processingPromise || !queuedTasks.length || unknownMutations.value.length) return
    processingPromise = runQueue().finally(() => {
      processingPromise = null
      if (queuedTasks.length && unknownMutations.value.length === 0) ensureProcessing()
    })
  }

  function enqueueMutation(
    request: MutationRequest,
    options: MutationOptions = {},
    conflictKeys: string[] = [],
    metadata: MutationMetadata = {},
  ): Promise<boolean> {
    if (!acceptingMutations.value || unknownMutations.value.length) {
      saveStatus.value = unknownMutations.value.length ? 'unknown' : 'error'
      saveError.value = unknownMutations.value.length
        ? '上一笔保存结果仍待确认，请先重试核对。'
        : '应用正在安全关闭，已停止接收新的修改。'
      return Promise.resolve(false)
    }
    const versions = new Map<string, number>()
    for (const key of conflictKeys) {
      const version = (conflictVersions.get(key) ?? 0) + 1
      conflictVersions.set(key, version)
      versions.set(key, version)
    }
    const derived = metadata.optimisticAttendance
      ? affectedKeysFromPatches(metadata.optimisticAttendance)
      : { cells: [], dates: [] }
    let complete!: (saved: boolean) => void
    const completion = new Promise<boolean>((resolve) => { complete = resolve })
    const task: MutationTask = {
      id: ++mutationSequence,
      operationId: createOperationId(),
      request,
      options,
      conflictVersions: versions,
      optimisticAttendance: metadata.optimisticAttendance,
      attendanceRequest: metadata.attendanceRequest,
      optimisticSettings: metadata.optimisticSettings,
      affectedCellKeys: [...new Set(metadata.affectedCellKeys ?? derived.cells)],
      affectedDateKeys: [...new Set(metadata.affectedDateKeys ?? derived.dates)],
      complete,
    }

    options.onQueued?.(task.operationId)

    failedMutations.value = retainedFailedTasks(failedMutations.value, versions)
    queuedTasks.push(task)
    pendingMutations += 1
    saveStatus.value = 'saving'
    saveError.value = ''
    ensureProcessing()
    return completion
  }

  async function retryFailed(): Promise<void> {
    if (processingPromise) await processingPromise
    const unknown = unknownMutations.value.filter(taskIsCurrent)
    const failed = failedMutations.value.filter(taskIsCurrent)
    unknownMutations.value = []
    failedMutations.value = []
    saveError.value = ''
    const retries = [...unknown, ...failed]
      .sort((left, right) => left.id - right.id)
      .map((task) => ({ ...task, complete: () => undefined }))
    queuedTasks.unshift(...retries)
    pendingMutations += retries.length
    if (queuedTasks.length) {
      saveStatus.value = 'saving'
      ensureProcessing()
    } else updateStatus()
  }

  async function retryMutation(operationId: string): Promise<boolean> {
    const running = activeTask?.operationId === operationId
      ? activeTask
      : queuedTasks.find((task) => task.operationId === operationId)
    if (running) {
      return new Promise<boolean>((resolve) => {
        const complete = running.complete
        running.complete = (saved) => { complete(saved); resolve(saved) }
      })
    }
    if (processingPromise) await processingPromise
    if (!acceptingMutations.value) return false
    const task = [...unknownMutations.value, ...failedMutations.value]
      .find((candidate) => candidate.operationId === operationId && taskIsCurrent(candidate))
    if (!task || unknownMutations.value.some((candidate) => candidate.operationId !== operationId)) return false
    unknownMutations.value = unknownMutations.value.filter((candidate) => candidate.operationId !== operationId)
    failedMutations.value = failedMutations.value.filter((candidate) => candidate.operationId !== operationId)
    const completion = new Promise<boolean>((resolve) => {
      queuedTasks.push({ ...task, complete: resolve })
    })
    pendingMutations += 1
    saveStatus.value = 'saving'
    if (!failedMutations.value.length) saveError.value = ''
    ensureProcessing()
    return completion
  }

  function discardFailedMutation(operationId: string): boolean {
    const previousLength = failedMutations.value.length
    failedMutations.value = failedMutations.value.filter((task) => task.operationId !== operationId)
    if (failedMutations.value.length === previousLength) return false
    if (!unknownMutations.value.length) {
      saveError.value = failedMutations.value.length ? '仍有其他未保存的修改，请重试。' : ''
    }
    reconcileLatestState()
    updateStatus()
    return true
  }

  async function flushMutations(): Promise<void> {
    while (processingPromise || queuedTasks.length || activeTask) {
      if (unknownMutations.value.length && !processingPromise && !activeTask) break
      const observed = processingPromise
      if (observed) await observed
      else {
        ensureProcessing()
        await Promise.resolve()
      }
    }
    if (unknownMutations.value.length) throw new Error('仍有保存结果待确认，请先重试核对。')
    if (failedMutations.value.length) throw new Error('仍有未保存的修改，请先重试。')
  }

  function setAcceptingMutations(accepting: boolean): void {
    acceptingMutations.value = accepting
  }

  function clearFailures(): void {
    failedMutations.value = []
    unknownMutations.value = []
    saveError.value = ''
    reconcileLatestState()
    updateStatus()
  }

  function dispose(): void {
    acceptingMutations.value = false
    if (savedTimer) clearTimeout(savedTimer)
  }

  const failedAttendanceCellKeys = computed(() => new Set(
    [...failedMutations.value, ...unknownMutations.value]
      .filter(taskIsCurrent)
      .flatMap((task) => task.affectedCellKeys ?? []),
  ))
  const failedAttendanceDateKeys = computed(() => new Set(
    [...failedMutations.value, ...unknownMutations.value]
      .filter(taskIsCurrent)
      .flatMap((task) => task.affectedDateKeys ?? []),
  ))

  return {
    saveStatus,
    saveError,
    failedMutations,
    unknownMutations,
    acceptingMutations,
    failedAttendanceCellKeys,
    failedAttendanceDateKeys,
    enqueueMutation,
    retryFailed,
    retryMutation,
    discardFailedMutation,
    flushMutations,
    setAcceptingMutations,
    setLatestSuccessfulState,
    clearFailures,
    dispose,
  }
}

export function attendanceConflictKeys(patches: readonly AttendancePatch[]): string[] {
  const keys: string[] = []
  for (const patch of patches) {
    for (const field of ATTENDANCE_FIELDS) {
      if ((patch as unknown as Record<string, unknown>)[field] !== undefined) {
        keys.push(`attendance:${patch.workerId}:${patch.date}:${field}`)
      }
    }
  }
  return keys
}
