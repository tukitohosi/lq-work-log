import type { Ref } from 'vue'
import type { AppData, Site } from '../types'
import type { AppMutationResponse } from '../mutation-response'
import type { MutationOptions, MutationRequest } from './useMutations'

export type SiteCreationPayload = { name: string; note: string }

interface Options {
  data: Ref<AppData | null>
  enqueueMutation: (request: MutationRequest, options?: MutationOptions, conflictKeys?: string[]) => Promise<boolean>
  retryMutation: (operationId: string) => Promise<boolean>
  discardFailedMutation: (operationId: string) => boolean
  saveError: Ref<string>
  addSite: (payload: SiteCreationPayload, operationId?: string) => Promise<AppMutationResponse>
}

interface Creation {
  payload: SiteCreationPayload
  operationId: string | null
  beforeIds: Set<string> | null
  created: Site | null
  saved: boolean
  cancelled: boolean
  pending: Promise<Site> | null
}

export function useWorkerSiteCreation(options: Options) {
  let current: Creation | null = null
  let sequence = 0

  function cancelSiteCreation(): void {
    if (!current) return
    current.cancelled = true
    if (current.operationId) options.discardFailedMutation(current.operationId)
    current = null
  }

  async function finish(creation: Creation, saved: Promise<boolean>): Promise<Site> {
    const succeeded = await saved
    if (creation.cancelled) {
      if (creation.operationId) options.discardFailedMutation(creation.operationId)
      throw new Error('已取消新增工地。')
    }
    if (!succeeded && !creation.saved) throw new Error(options.saveError.value || '工地保存失败，请重试。')
    if (!creation.created) throw new Error('工地已保存，请返回并从默认工地列表中选择。')
    return creation.created
  }

  function createSite(input: SiteCreationPayload): Promise<Site> {
    const payload = { name: input.name.trim().replace(/\s+/gu, ' '), note: input.note.trim() }
    if (!payload.name || [...payload.name].length > 100) return Promise.reject(new Error('工地名称应为 1 至 100 个字符。'))
    if (payload.note.length > 500) return Promise.reject(new Error('工地备注不能超过 500 个字符。'))
    if (current?.pending) return current.pending
    if (current && (current.payload.name !== payload.name || current.payload.note !== payload.note)) cancelSiteCreation()
    if (current?.saved) return current.created
      ? Promise.resolve(current.created)
      : Promise.reject(new Error('工地已保存，请返回并从默认工地列表中选择。'))

    const creation: Creation = current ?? {
      payload, operationId: null, beforeIds: null, created: null, saved: false, cancelled: false, pending: null,
    }
    current = creation
    const completion = creation.operationId
      ? options.retryMutation(creation.operationId)
      : options.enqueueMutation((operationId) => {
          creation.operationId = operationId
          // A sent request may already be committed. Keep its original operation available
          // for unknown-result reconciliation even after its editor has been closed.
          if (creation.cancelled && creation.beforeIds === null) return Promise.reject(new Error('已取消新增工地。'))
          // Capture when this queued request actually starts, and retain the baseline on retries.
          creation.beforeIds ??= new Set(options.data.value?.sites.map((site) => site.id) ?? [])
          return options.addSite(creation.payload, operationId)
        }, {
          forceApply: true,
          onQueued: (operationId) => { creation.operationId = operationId },
          onSuccess: (result) => {
            creation.saved = true
            const added = result.sites.filter((site) => !creation.beforeIds?.has(site.id))
            creation.created = added.length === 1 ? added[0]! : null
          },
        }, [`worker-site-create:${++sequence}`])
    creation.pending = finish(creation, completion).finally(() => { creation.pending = null })
    return creation.pending
  }

  return { createSite, cancelSiteCreation }
}
