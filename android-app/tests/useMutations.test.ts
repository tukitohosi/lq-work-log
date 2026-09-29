import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { applyAttendancePatch } from '../src/attendance'
import { ApiError } from '../src/api'
import {
  attendanceConflictKeys,
  useMutations,
} from '../src/composables/useMutations'
import type { AppData, AttendancePatch } from '../src/types'

function fixture(): AppData {
  return {
    schemaVersion: 8,
    revision: 0,
    workers: [{
      id: 'worker-1',
      name: '测试工人',
      avatarDataUrl: null,
      avatarEmoji: null,
      defaultDailyRateFen: 20_000,
      note: '',
      defaultSiteId: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      archivedAt: null,
    }],
    attendance: [],
    monthlyRecords: [],
    payAdjustments: [],
    sites: [],
    settings: {
      weekStartsOn: 1,
      currentWorkerId: 'worker-1',
      theme: 'light',
      sidebarCollapsed: false,
      lastBackupExportAt: null,
      lastBackupReminderAt: null,
      weeklyAutoBackupEnabled: true,
      lastWeeklyBackupAt: null,
      defaultOvertimePayPercent: 100,
    },
  }
}

function stateWith(base: AppData, patches: readonly AttendancePatch[], revision: number): AppData {
  const result = structuredClone(base)
  result.revision = revision
  for (const patch of patches) applyAttendancePatch(result, patch)
  return result
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('useMutations', () => {
  it('runs requests in FIFO order while preserving optimistic state until the queue settles', async () => {
    const base = fixture()
    const data = ref<AppData | null>(structuredClone(base))
    const controller = useMutations({ data })
    controller.setLatestSuccessfulState(base)
    const firstPatch: AttendancePatch = { workerId: 'worker-1', date: '2026-08-01', morning: 'present' }
    const secondPatch: AttendancePatch = { workerId: 'worker-1', date: '2026-08-01', afternoon: 'present' }
    applyAttendancePatch(data.value!, firstPatch)
    applyAttendancePatch(data.value!, secondPatch)
    const first = deferred<AppData>()
    const second = deferred<AppData>()
    const calls: string[] = []

    const firstSaved = controller.enqueueMutation(
      () => { calls.push('first'); return first.promise },
      {},
      attendanceConflictKeys([firstPatch]),
      { optimisticAttendance: [firstPatch] },
    )
    const secondSaved = controller.enqueueMutation(
      () => { calls.push('second'); return second.promise },
      {},
      attendanceConflictKeys([secondPatch]),
      { optimisticAttendance: [secondPatch] },
    )
    await Promise.resolve()
    expect(calls).toEqual(['first'])

    first.resolve(stateWith(base, [firstPatch], 1))
    await firstSaved
    await vi.waitFor(() => expect(calls).toEqual(['first', 'second']))
    expect(data.value?.attendance[0]).toMatchObject({ morning: 'present', afternoon: 'present' })

    second.resolve(stateWith(base, [firstPatch, secondPatch], 2))
    await expect(secondSaved).resolves.toBe(true)
    expect(data.value?.revision).toBe(2)
    expect(data.value?.attendance[0]).toMatchObject({ morning: 'present', afternoon: 'present' })
    controller.dispose()
  })

  it('derives precise failed cell/date markers and clears them with the failure lifecycle', async () => {
    const base = fixture()
    const data = ref<AppData | null>(structuredClone(base))
    const controller = useMutations({ data })
    controller.setLatestSuccessfulState(base)
    const patch: AttendancePatch = {
      workerId: 'worker-1',
      date: '2026-08-02',
      morning: 'present',
      dayNote: '待核对',
    }
    applyAttendancePatch(data.value!, patch)

    await expect(controller.enqueueMutation(
      () => Promise.reject(new Error('磁盘写入失败')),
      {},
      attendanceConflictKeys([patch]),
      { optimisticAttendance: [patch] },
    )).resolves.toBe(false)

    expect(controller.saveStatus.value).toBe('error')
    expect(controller.saveError.value).toBe('磁盘写入失败')
    expect([...controller.failedAttendanceCellKeys.value]).toEqual(['worker-1|2026-08-02|morning'])
    expect([...controller.failedAttendanceDateKeys.value]).toEqual(['worker-1|2026-08-02'])
    expect(data.value?.attendance[0]).toMatchObject({ morning: 'present', dayNote: '待核对' })

    controller.clearFailures()
    expect(controller.failedAttendanceCellKeys.value.size).toBe(0)
    expect(controller.failedAttendanceDateKeys.value.size).toBe(0)
    expect(controller.saveError.value).toBe('')
    controller.dispose()
  })

  it('replaces an old failed marker when a newer write covers the same field', async () => {
    const base = fixture()
    const data = ref<AppData | null>(structuredClone(base))
    const controller = useMutations({ data })
    controller.setLatestSuccessfulState(base)
    const oldPatch: AttendancePatch = { workerId: 'worker-1', date: '2026-08-03', morning: 'present' }
    applyAttendancePatch(data.value!, oldPatch)
    await controller.enqueueMutation(
      () => Promise.reject(new Error('第一次失败')),
      {},
      attendanceConflictKeys([oldPatch]),
      { optimisticAttendance: [oldPatch] },
    )
    expect(controller.failedAttendanceCellKeys.value.has('worker-1|2026-08-03|morning')).toBe(true)

    const replacement: AttendancePatch = { ...oldPatch, morning: 'absent' }
    applyAttendancePatch(data.value!, replacement)
    const replacementState = stateWith(base, [replacement], 2)
    const saved = controller.enqueueMutation(
      () => Promise.resolve(replacementState),
      {},
      attendanceConflictKeys([replacement]),
      { optimisticAttendance: [replacement] },
    )
    expect(controller.failedAttendanceCellKeys.value.size).toBe(0)

    await expect(saved).resolves.toBe(true)
    expect(controller.failedMutations.value).toHaveLength(0)
    expect(data.value?.attendance[0]?.morning).toBe('absent')
    controller.dispose()
  })

  it('keeps only untouched fields when a newer write partially covers a failed batch', async () => {
    const base = fixture()
    const data = ref<AppData | null>(structuredClone(base))
    const controller = useMutations({ data })
    controller.setLatestSuccessfulState(base)
    const failedPatch: AttendancePatch = {
      workerId: 'worker-1',
      date: '2026-08-04',
      morning: 'present',
      afternoon: 'present',
      dayNote: '仍需保存',
    }
    applyAttendancePatch(data.value!, failedPatch)
    await controller.enqueueMutation(
      () => Promise.reject(new Error('批量失败')),
      {},
      attendanceConflictKeys([failedPatch]),
      { optimisticAttendance: [failedPatch], attendanceRequest: vi.fn() },
    )

    const replacement: AttendancePatch = { workerId: 'worker-1', date: '2026-08-04', morning: 'absent' }
    applyAttendancePatch(data.value!, replacement)
    await controller.enqueueMutation(
      () => Promise.resolve(stateWith(base, [replacement], 2)),
      {},
      attendanceConflictKeys([replacement]),
      { optimisticAttendance: [replacement] },
    )

    expect([...controller.failedAttendanceCellKeys.value]).toEqual(['worker-1|2026-08-04|afternoon'])
    expect([...controller.failedAttendanceDateKeys.value]).toEqual(['worker-1|2026-08-04'])
    expect(controller.failedMutations.value[0]?.optimisticAttendance).toEqual([{
      workerId: 'worker-1',
      date: '2026-08-04',
      afternoon: 'present',
      dayNote: '仍需保存',
    }])
    controller.dispose()
  })

  it('removes failure markers after a successful retry', async () => {
    const base = fixture()
    const patch: AttendancePatch = { workerId: 'worker-1', date: '2026-08-05', overtime: 'half' }
    const successfulState = stateWith(base, [patch], 2)
    const request = vi.fn<() => Promise<AppData>>()
      .mockRejectedValueOnce(new Error('暂时失败'))
      .mockResolvedValueOnce(successfulState)
    const data = ref<AppData | null>(stateWith(base, [patch], 1))
    const controller = useMutations({ data })
    controller.setLatestSuccessfulState(base)

    await controller.enqueueMutation(
      request,
      {},
      attendanceConflictKeys([patch]),
      { optimisticAttendance: [patch], attendanceRequest: () => request() },
    )
    expect(controller.failedAttendanceCellKeys.value.has('worker-1|2026-08-05|overtime')).toBe(true)

    await controller.retryFailed()
    await controller.flushMutations()
    expect(request).toHaveBeenCalledTimes(2)
    expect(controller.failedAttendanceCellKeys.value.size).toBe(0)
    expect(controller.failedMutations.value).toHaveLength(0)
    expect(controller.saveStatus.value).toBe('saved')
    controller.dispose()
  })

  it('preserves FIFO ordering across a 50-task boundary', async () => {
    const base = fixture()
    const data = ref<AppData | null>(structuredClone(base))
    const controller = useMutations({ data })
    controller.setLatestSuccessfulState(base)
    const order: number[] = []
    const completions = Array.from({ length: 50 }, (_, index) => controller.enqueueMutation(
      async () => {
        order.push(index)
        const result = structuredClone(base)
        result.revision = index + 1
        return result
      },
    ))

    await expect(Promise.all(completions)).resolves.toEqual(Array(50).fill(true))
    expect(order).toEqual(Array.from({ length: 50 }, (_, index) => index))
    expect(data.value?.revision).toBe(50)
    controller.dispose()
  })

  it('pauses after an unknown write result and retries with the identical operation id', async () => {
    const base = fixture()
    const data = ref<AppData | null>(structuredClone(base))
    const controller = useMutations({ data })
    controller.setLatestSuccessfulState(base)
    const successfulState = structuredClone(base)
    successfulState.revision = 1
    const operationIds: string[] = []
    const request = vi.fn(async (operationId: string) => {
      operationIds.push(operationId)
      if (operationIds.length === 1) {
        throw new ApiError('结果待确认', 'MUTATION_RESULT_UNKNOWN')
      }
      return successfulState
    })
    const onSuccess = vi.fn()

    await expect(controller.enqueueMutation(request, { onSuccess })).resolves.toBe(false)
    expect(controller.saveStatus.value).toBe('unknown')
    expect(controller.unknownMutations.value).toHaveLength(1)
    expect(await controller.enqueueMutation(vi.fn(async () => successfulState))).toBe(false)

    await controller.retryFailed()
    await controller.flushMutations()
    expect(request).toHaveBeenCalledTimes(2)
    expect(operationIds[1]).toBe(operationIds[0])
    expect(controller.unknownMutations.value).toHaveLength(0)
    expect(data.value?.revision).toBe(1)
    expect(onSuccess).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('settles an unknown-blocked queue and retries every unsent task in order with its original operation id', async () => {
    const base = fixture()
    const data = ref<AppData | null>(structuredClone(base))
    const controller = useMutations({ data })
    controller.setLatestSuccessfulState(base)
    const firstAttempt = deferred<AppData>()
    const calls: Array<{ task: string; operationId: string }> = []
    let firstCall = true
    const firstPatch: AttendancePatch = { workerId: 'worker-1', date: '2026-08-06', morning: 'present' }
    const secondPatch: AttendancePatch = { workerId: 'worker-1', date: '2026-08-06', afternoon: 'absent' }
    const thirdPatch: AttendancePatch = { workerId: 'worker-1', date: '2026-08-06', overtime: 'half' }
    for (const patch of [firstPatch, secondPatch, thirdPatch]) applyAttendancePatch(data.value!, patch)
    const firstRequest = vi.fn((operationId: string) => {
      calls.push({ task: 'first', operationId })
      if (firstCall) {
        firstCall = false
        return firstAttempt.promise
      }
      return Promise.resolve(stateWith(base, [firstPatch], 1))
    })
    const secondRequest = vi.fn((operationId: string) => {
      calls.push({ task: 'second', operationId })
      return Promise.resolve(stateWith(base, [firstPatch, secondPatch], 2))
    })
    const thirdRequest = vi.fn((operationId: string) => {
      calls.push({ task: 'third', operationId })
      return Promise.resolve(stateWith(base, [firstPatch, secondPatch, thirdPatch], 3))
    })

    const completions = [
      controller.enqueueMutation(firstRequest, {}, attendanceConflictKeys([firstPatch]), { optimisticAttendance: [firstPatch] }),
      controller.enqueueMutation(secondRequest, {}, attendanceConflictKeys([secondPatch]), { optimisticAttendance: [secondPatch] }),
      controller.enqueueMutation(thirdRequest, {}, attendanceConflictKeys([thirdPatch]), { optimisticAttendance: [thirdPatch] }),
    ]
    expect(firstRequest).toHaveBeenCalledOnce()
    expect(secondRequest).not.toHaveBeenCalled()
    expect(thirdRequest).not.toHaveBeenCalled()

    firstAttempt.reject(new ApiError('结果待确认', 'MUTATION_RESULT_UNKNOWN'))
    await expect(Promise.all(completions)).resolves.toEqual([false, false, false])
    expect(controller.unknownMutations.value).toHaveLength(1)
    expect(controller.failedMutations.value).toHaveLength(2)
    expect(secondRequest).not.toHaveBeenCalled()
    expect(thirdRequest).not.toHaveBeenCalled()
    const retryableTasks = [controller.unknownMutations.value[0]!, ...controller.failedMutations.value]
    expect(retryableTasks.map((task) => task.optimisticAttendance)).toEqual([
      [firstPatch],
      [secondPatch],
      [thirdPatch],
    ])
    expect(retryableTasks.map((task) => [...task.conflictVersions.keys()])).toEqual([
      attendanceConflictKeys([firstPatch]),
      attendanceConflictKeys([secondPatch]),
      attendanceConflictKeys([thirdPatch]),
    ])
    expect(data.value?.attendance[0]).toMatchObject({
      morning: 'present',
      afternoon: 'absent',
      overtime: 'half',
    })
    await expect(controller.flushMutations()).rejects.toThrow('仍有保存结果待确认')

    const originalOperationIds = [
      controller.unknownMutations.value[0]!.operationId,
      ...controller.failedMutations.value.map((task) => task.operationId),
    ]
    await controller.retryFailed()
    await controller.flushMutations()

    expect(calls).toEqual([
      { task: 'first', operationId: originalOperationIds[0] },
      { task: 'first', operationId: originalOperationIds[0] },
      { task: 'second', operationId: originalOperationIds[1] },
      { task: 'third', operationId: originalOperationIds[2] },
    ])
    expect(controller.unknownMutations.value).toHaveLength(0)
    expect(controller.failedMutations.value).toHaveLength(0)
    expect(controller.saveStatus.value).toBe('saved')
    expect(data.value?.revision).toBe(3)
    expect(data.value?.attendance[0]).toMatchObject({
      morning: 'present',
      afternoon: 'absent',
      overtime: 'half',
    })
    controller.dispose()
  })

  it('keeps flushing when a new mutation is enqueued after the flush has begun', async () => {
    const base = fixture()
    const data = ref<AppData | null>(structuredClone(base))
    const controller = useMutations({ data })
    controller.setLatestSuccessfulState(base)
    const first = deferred<AppData>()
    const second = deferred<AppData>()
    const secondRequest = vi.fn(() => second.promise)
    const firstCompletion = controller.enqueueMutation(() => first.promise)
    const flushing = controller.flushMutations()
    await Promise.resolve()
    const secondCompletion = controller.enqueueMutation(secondRequest)

    const firstState = structuredClone(base)
    firstState.revision = 1
    first.resolve(firstState)
    await firstCompletion
    await vi.waitFor(() => expect(secondRequest).toHaveBeenCalledOnce())
    let flushSettled = false
    void flushing.then(() => { flushSettled = true })
    await Promise.resolve()
    expect(flushSettled).toBe(false)

    const secondState = structuredClone(base)
    secondState.revision = 2
    second.resolve(secondState)
    await expect(secondCompletion).resolves.toBe(true)
    await expect(flushing).resolves.toBeUndefined()
    expect(data.value?.revision).toBe(2)
    controller.dispose()
  })
})
