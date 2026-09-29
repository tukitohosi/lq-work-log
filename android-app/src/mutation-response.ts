import { applyAppDataDelta, isAppDataDelta, type AppDataDelta } from '../shared/app-data-delta.mjs'
import type { AppData } from './types'

export type AppMutationResponse = AppData | AppDataDelta

export function materializeMutationResponse(
  base: AppData | null,
  response: AppMutationResponse,
): AppData {
  if (!isAppDataDelta(response)) return response as AppData
  if (!base) throw new Error('收到增量保存结果时缺少本地基线，请重新加载记工本。')
  return applyAppDataDelta(base, response) as AppData
}
