import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/api'
import { useMutations } from '../src/composables/useMutations'
import { useWorkerSiteCreation } from '../src/composables/useWorkerSiteCreation'
import type { AppData, Site } from '../src/types'

function site(id: string, name = '同名工地'): Site {
  return { id, name, note: '', createdAt: '2026-09-01T00:00:00.000Z', archivedAt: null }
}

function fixture(): AppData {
  return {
    schemaVersion: 8, revision: 0, workers: [], attendance: [], monthlyRecords: [], payAdjustments: [], sites: [],
    settings: {
      weekStartsOn: 1, currentWorkerId: null, theme: 'light', sidebarCollapsed: false,
      lastBackupExportAt: null, lastBackupReminderAt: null, weeklyAutoBackupEnabled: true,
      lastWeeklyBackupAt: null, defaultOvertimePayPercent: 100,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(base = fixture()) {
  const data = ref<AppData | null>(structuredClone(base))
  const controller = useMutations({ data })
  controller.setLatestSuccessfulState(base)
  const addSite = vi.fn<(payload: { name: string; note: string }, operationId?: string) => Promise<AppData>>()
  const creation = useWorkerSiteCreation({ data, ...controller, addSite })
  return { data, controller, addSite, ...creation }
}

describe('worker default-site creation', () => {
  it('identifies the new id after earlier queued site writes, even with the same name and timestamp', async () => {
    const base = fixture()
    base.sites = [site('old')]
    const ctx = setup(base)
    const earlier = deferred<AppData>()
    const earlierState = { ...base, revision: 1, sites: [...base.sites, site('earlier')] }
    const earlierSaved = ctx.controller.enqueueMutation(() => earlier.promise)
    ctx.addSite.mockResolvedValue({ ...earlierState, revision: 2, sites: [...earlierState.sites, site('new')] })
    const created = ctx.createSite({ name: ' 同名工地 ', note: '' })
    expect(ctx.addSite).not.toHaveBeenCalled()
    earlier.resolve(earlierState)
    await earlierSaved
    await expect(created).resolves.toMatchObject({ id: 'new' })
    expect(ctx.data.value?.sites.map((item) => item.id)).toEqual(['old', 'earlier', 'new'])
    ctx.controller.dispose()
  })

  it('deduplicates pending clicks and retries only its own failed task with the original operation id', async () => {
    const ctx = setup()
    const unrelated = vi.fn(async () => { throw new Error('另一个保存失败') })
    await ctx.controller.enqueueMutation(unrelated, {}, ['another-edit'])
    const firstAttempt = deferred<AppData>()
    ctx.addSite.mockReturnValueOnce(firstAttempt.promise)
      .mockResolvedValueOnce({ ...fixture(), revision: 1, sites: [site('new')] })
    const first = ctx.createSite({ name: '同名工地', note: '' })
    const duplicate = ctx.createSite({ name: '同名工地', note: '' })
    expect(duplicate).toBe(first)
    const rejection = expect(first).rejects.toThrow('磁盘繁忙')
    firstAttempt.reject(new Error('磁盘繁忙'))
    await rejection
    expect(ctx.controller.failedMutations.value).toHaveLength(2)
    await expect(ctx.createSite({ name: '同名工地', note: '' })).resolves.toMatchObject({ id: 'new' })
    expect(ctx.addSite).toHaveBeenCalledTimes(2)
    expect(ctx.addSite.mock.calls[1]?.[1]).toBe(ctx.addSite.mock.calls[0]?.[1])
    expect(unrelated).toHaveBeenCalledOnce()
    expect(ctx.controller.failedMutations.value).toHaveLength(1)
    ctx.controller.dispose()
  })

  it('cancels only the failed creation and preserves other unsaved operations', async () => {
    const ctx = setup()
    const other = vi.fn(async () => { throw new Error('其他修改') })
    await ctx.controller.enqueueMutation(other, {}, ['other'])
    ctx.addSite.mockRejectedValueOnce(new Error('新增失败'))
    await expect(ctx.createSite({ name: '工地', note: '' })).rejects.toThrow('新增失败')
    ctx.cancelSiteCreation()
    expect(ctx.controller.failedMutations.value).toHaveLength(1)
    expect(ctx.controller.saveError.value).toBe('仍有其他未保存的修改，请重试。')
    await ctx.controller.retryFailed()
    await expect(ctx.controller.flushMutations()).rejects.toThrow('未保存')
    expect(other).toHaveBeenCalledTimes(2)
    expect(ctx.addSite).toHaveBeenCalledOnce()
    ctx.controller.dispose()
  })

  it('retains unknown results for reconciliation and never clears them as a cancelled failure', async () => {
    const ctx = setup()
    ctx.addSite.mockRejectedValueOnce(new ApiError('结果待确认', 'MUTATION_RESULT_UNKNOWN'))
      .mockResolvedValueOnce({ ...fixture(), revision: 1, sites: [site('new')] })
    await expect(ctx.createSite({ name: '工地', note: '' })).rejects.toThrow('结果待确认')
    const operationId = ctx.addSite.mock.calls[0]![1]!
    expect(ctx.controller.discardFailedMutation(operationId)).toBe(false)
    await expect(ctx.createSite({ name: '工地', note: '' })).resolves.toMatchObject({ id: 'new' })
    expect(ctx.addSite.mock.calls[1]?.[1]).toBe(operationId)
    expect(ctx.controller.unknownMutations.value).toHaveLength(0)
    ctx.controller.dispose()
  })

  it('does not retry a successful creation when the response contains an ambiguous id difference', async () => {
    const ctx = setup()
    ctx.addSite.mockResolvedValueOnce({ ...fixture(), revision: 1, sites: [site('a'), site('b')] })
    await expect(ctx.createSite({ name: '工地', note: '' })).rejects.toThrow('工地已保存')
    await expect(ctx.createSite({ name: '工地', note: '' })).rejects.toThrow('工地已保存')
    expect(ctx.addSite).toHaveBeenCalledOnce()
    expect(ctx.controller.failedMutations.value).toHaveLength(0)
    expect(ctx.data.value?.sites).toHaveLength(2)
    ctx.controller.dispose()
  })

  it('keeps a late successful creation in storage but refuses to return it into an abandoned form', async () => {
    const ctx = setup()
    const response = deferred<AppData>()
    ctx.addSite.mockReturnValue(response.promise)
    const created = ctx.createSite({ name: '工地', note: '' })
    const abandoned = expect(created).rejects.toThrow('已取消')
    ctx.cancelSiteCreation()
    response.resolve({ ...fixture(), revision: 1, sites: [site('late')] })
    await abandoned
    expect(ctx.data.value?.sites[0]?.id).toBe('late')
    expect(ctx.controller.failedMutations.value).toHaveLength(0)
    ctx.controller.dispose()
  })

  it('removes a late failed creation from retries after its form was abandoned', async () => {
    const ctx = setup()
    const response = deferred<AppData>()
    ctx.addSite.mockReturnValue(response.promise)
    const created = ctx.createSite({ name: '工地', note: '' })
    const abandoned = expect(created).rejects.toThrow('已取消')
    ctx.cancelSiteCreation()
    response.reject(new Error('落盘失败'))
    await abandoned
    expect(ctx.controller.failedMutations.value).toHaveLength(0)
    ctx.controller.dispose()
  })

  it('discards an abandoned creation that never started because an earlier result became unknown', async () => {
    const ctx = setup()
    const earlier = deferred<AppData>()
    const earlierSaved = ctx.controller.enqueueMutation(() => earlier.promise)
    const created = ctx.createSite({ name: '工地', note: '' })
    const abandoned = expect(created).rejects.toThrow('已取消')
    ctx.cancelSiteCreation()
    earlier.reject(new ApiError('先前结果待确认', 'MUTATION_RESULT_UNKNOWN'))
    await earlierSaved
    await abandoned
    expect(ctx.addSite).not.toHaveBeenCalled()
    expect(ctx.controller.failedMutations.value).toHaveLength(0)
    expect(ctx.controller.unknownMutations.value).toHaveLength(1)
    ctx.controller.dispose()
  })

  it('reconciles a sent unknown creation with its original operation id after the editor is cancelled', async () => {
    const ctx = setup()
    ctx.addSite.mockRejectedValueOnce(new ApiError('写入结果未知', 'MUTATION_RESULT_UNKNOWN'))
      .mockResolvedValueOnce({ ...fixture(), revision: 1, sites: [site('committed')] })
    await expect(ctx.createSite({ name: '工地', note: '' })).rejects.toThrow('写入结果未知')
    const operationId = ctx.addSite.mock.calls[0]?.[1]
    ctx.cancelSiteCreation()
    expect(ctx.controller.unknownMutations.value).toHaveLength(1)
    await ctx.controller.retryFailed()
    await ctx.controller.flushMutations()
    expect(ctx.addSite).toHaveBeenCalledTimes(2)
    expect(ctx.addSite.mock.calls[1]?.[1]).toBe(operationId)
    expect(ctx.controller.unknownMutations.value).toHaveLength(0)
    expect(ctx.controller.failedMutations.value).toHaveLength(0)
    expect(ctx.data.value?.sites[0]?.id).toBe('committed')
    ctx.controller.dispose()
  })
})
