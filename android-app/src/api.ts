import { Capacitor } from '@capacitor/core'
import { androidPocApi, exportAndroidBackup } from './android-poc-api'
import type {
  ApiErrorBody,
  AppData,
  AttendancePatch,
  AttendancePeriod,
  AttendanceValue,
  HistoryRevertTarget,
  InternalBackupInspection,
  InternalBackupMeta,
  OrdinaryLeave,
  OvertimeLeave,
  PayAdjustmentKind,
  RestoreInspection,
  Theme,
  WeekStartsOn,
} from './types'
import type { AppMutationResponse } from './mutation-response'
import { createOperationId } from './operation-id'

export class ApiError extends Error {
  code: string
  details?: unknown

  constructor(message: string, code = 'UNKNOWN_ERROR', details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.details = details
  }
}

type RequestOptions = RequestInit & {
  operationId?: string
  timeoutMs?: number
  mutation?: boolean
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const LARGE_REQUEST_TIMEOUT_MS = 60_000
let desktopSessionTokenPromise: Promise<string> | null = null

async function desktopSessionHeaders(): Promise<Record<string, string>> {
  const getToken = window.jigongbenDesktop?.getApiSessionToken
  if (typeof getToken !== 'function') return {}
  desktopSessionTokenPromise ??= getToken().then((token) => {
    if (typeof token !== 'string' || token.length < 32) throw new Error('桌面会话密钥无效')
    return token
  }).catch((error) => {
    desktopSessionTokenPromise = null
    throw error
  })
  return { Authorization: `Bearer ${await desktopSessionTokenPromise}` }
}

async function fetchWithTimeout(path: string, init: RequestOptions = {}): Promise<Response> {
  const isWrite = init.mutation === true
  const controller = new AbortController()
  const timeoutMs = init.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const externalSignal = init.signal
  const abortFromExternal = () => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) abortFromExternal()
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  try {
    const sessionHeaders = await desktopSessionHeaders()
    return await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(isWrite ? { 'X-LQ-Operation-Id': init.operationId ?? createOperationId() } : {}),
        ...sessionHeaders,
        ...init.headers,
      },
    })
  } catch (error) {
    if (timedOut) {
      throw new ApiError(
        isWrite ? '保存请求超时，结果正在等待确认，请勿重复操作。' : '请求超时，请检查本机服务后重试。',
        isWrite ? 'MUTATION_RESULT_UNKNOWN' : 'REQUEST_TIMEOUT',
      )
    }
    if (externalSignal?.aborted) throw new ApiError('操作已取消。', 'REQUEST_ABORTED')
    throw new ApiError(
      isWrite ? '保存连接中断，结果正在等待确认，请勿重复操作。' : '无法连接本机记工服务，请确认启动窗口仍在运行。',
      isWrite ? 'MUTATION_RESULT_UNKNOWN' : 'NETWORK_ERROR',
      error,
    )
  } finally {
    window.clearTimeout(timer)
    externalSignal?.removeEventListener('abort', abortFromExternal)
  }
}

async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
  let response: Response
  try {
    response = await fetchWithTimeout(path, init)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('无法连接本机记工服务，请确认启动窗口仍在运行。', 'NETWORK_ERROR', error)
  }

  if (!response.ok) {
    let body: ApiErrorBody | null = null
    try {
      body = (await response.json()) as ApiErrorBody
    } catch {
      // The fallback below is intentionally user-facing.
    }
    throw new ApiError(
      body?.error?.message || `操作失败（HTTP ${response.status}）`,
      body?.error?.code || `HTTP_${response.status}`,
      body?.error?.details,
    )
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function requestMutation(path: string, init: RequestOptions): Promise<AppMutationResponse> {
  return request<AppMutationResponse>(path, {
    ...init,
    mutation: true,
    headers: {
      'X-LQ-Response-Mode': 'delta',
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

const desktopApi = {
  getHealth: () => request<{
    ok: boolean
    revision: number | null
    readOnly: boolean
    dataSizeBytes: number | null
    dataLimitBytes: number
    dataSizeWarning: boolean
  }>('/api/health'),

  getState: () => request<AppData>('/api/state'),

  addWorker: (payload: {
    name: string
    avatarDataUrl: string | null
    avatarEmoji?: string | null
    defaultDailyRateFen: number
    note: string
    defaultSiteId?: string | null
  }, operationId?: string) =>
    requestMutation('/api/workers', { method: 'POST', body: JSON.stringify(payload), operationId }),

  updateWorker: (
    id: string,
    payload: {
      name?: string
      avatarDataUrl?: string | null
      avatarEmoji?: string | null
      defaultDailyRateFen?: number
      note?: string
      defaultSiteId?: string | null
      archived?: boolean
    },
    operationId?: string,
  ) =>
    requestMutation(`/api/workers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload), operationId }),

  setAttendance: (payload: {
    workerId: string
    date: string
    period: AttendancePeriod
    status: AttendanceValue
  }, operationId?: string) => requestMutation('/api/attendance', { method: 'PUT', body: JSON.stringify(payload), operationId }),

  setAttendanceBatch: (patches: AttendancePatch[], options: { allowFuture?: boolean; operationId?: string } = {}) => {
    const { operationId, ...bodyOptions } = options
    return requestMutation('/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({ patches, ...bodyOptions }),
      operationId,
    })
  },

  setAttendanceLeave: (
    patches: Array<
      | { workerId: string; date: string; period: 'morning' | 'afternoon'; leave: OrdinaryLeave | null }
      | { workerId: string; date: string; period: 'overtime'; leave: OvertimeLeave | null }
    >,
    options: { allowFuture?: boolean; operationId?: string } = {},
  ) => {
    const { operationId, ...bodyOptions } = options
    return requestMutation('/api/attendance/leave', {
      method: 'PUT',
      body: JSON.stringify({ patches, ...bodyOptions }),
      operationId,
    })
  },

  setDayNote: (payload: { workerId: string; date: string; dayNote: string }, operationId?: string) =>
    requestMutation('/api/attendance/day-note', { method: 'PUT', body: JSON.stringify(payload), operationId }),

  setMonthlyRecord: (payload: {
    workerId: string
    month: string
    dailyRateFen?: number
    overtimePayPercent?: number
    note?: string
    paid?: boolean
  }, operationId?: string) =>
    requestMutation('/api/monthly-records', { method: 'PUT', body: JSON.stringify(payload), operationId }),

  setSettings: (payload: {
    weekStartsOn?: WeekStartsOn
    currentWorkerId?: string | null
    theme?: Theme
    sidebarCollapsed?: boolean
    lastBackupExportAt?: string | null
    lastBackupReminderAt?: string | null
    weeklyAutoBackupEnabled?: boolean
    defaultOvertimePayPercent?: number
  }, operationId?: string) =>
    requestMutation('/api/settings', { method: 'PUT', body: JSON.stringify(payload), operationId }),

  addPayAdjustment: (payload: {
    workerId: string
    month: string
    date: string | null
    kind: PayAdjustmentKind
    amountFen: number
    label: string
    note: string
    siteId?: string | null
  }, operationId?: string) => requestMutation('/api/pay-adjustments', { method: 'POST', body: JSON.stringify(payload), operationId }),

  updatePayAdjustment: (
    id: string,
    payload: {
      month?: string
      date?: string | null
      kind?: PayAdjustmentKind
      amountFen?: number
      label?: string
      note?: string
      siteId?: string | null
    },
    operationId?: string,
  ) =>
    requestMutation(`/api/pay-adjustments/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
      operationId,
    }),

  deletePayAdjustment: (id: string, operationId?: string) =>
    requestMutation(`/api/pay-adjustments/${encodeURIComponent(id)}`, { method: 'DELETE', operationId }),

  addSite: (payload: { name: string; note: string }, operationId?: string) =>
    requestMutation('/api/sites', { method: 'POST', body: JSON.stringify(payload), operationId }),

  updateSite: (id: string, payload: { name?: string; note?: string; archived?: boolean; replacementDefaultSiteId?: string | null }, operationId?: string) =>
    requestMutation(`/api/sites/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
      operationId,
    }),

  listInternalBackups: () => request<{ items: InternalBackupMeta[] }>('/api/internal-backups'),

  inspectInternalBackup: (id: string) =>
    request<InternalBackupInspection>('/api/internal-backups/inspect', {
      method: 'POST',
      body: JSON.stringify({ id }),
      timeoutMs: LARGE_REQUEST_TIMEOUT_MS,
    }),

  revertHistory: (targets: HistoryRevertTarget[], operationId?: string) =>
    requestMutation('/api/history/revert', {
      method: 'POST',
      body: JSON.stringify({ targets }),
      operationId,
    }),

  inspectRestore: async (data: unknown) => {
    const inspected = await request<Omit<RestoreInspection, 'schemaVersion'>>('/api/restore/inspect', {
      method: 'POST',
      body: JSON.stringify({ data }),
      timeoutMs: LARGE_REQUEST_TIMEOUT_MS,
    })
    return { ...inspected, schemaVersion: inspected.data.schemaVersion }
  },

  restore: (data: AppData, operationId?: string) => request<AppData>('/api/restore', {
    method: 'POST',
    body: JSON.stringify(data),
    operationId,
    mutation: true,
    timeoutMs: LARGE_REQUEST_TIMEOUT_MS,
  }),
}

export const isAndroidApp = Capacitor.isNativePlatform()
export const api = (isAndroidApp ? androidPocApi : desktopApi) as typeof desktopApi

export async function downloadBackup(): Promise<JigongbenDesktopSaveResult> {
  if (isAndroidApp) return exportAndroidBackup()
  let response: Response
  try {
    response = await fetchWithTimeout('/api/backup', { timeoutMs: LARGE_REQUEST_TIMEOUT_MS })
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('无法连接本机记工服务，请确认启动窗口仍在运行。', 'NETWORK_ERROR', error)
  }
  if (!response.ok) {
    let message = `备份失败（HTTP ${response.status}）`
    try {
      const body = (await response.json()) as ApiErrorBody
      message = body.error?.message || message
    } catch {
      // Keep the status fallback.
    }
    throw new ApiError(message, `HTTP_${response.status}`)
  }
  const contents = await response.text()
  const disposition = response.headers.get('content-disposition') || ''
  const matched = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  const filename = matched ? decodeURIComponent(matched[1]) : `记工本备份_${new Date().toISOString().slice(0, 10)}.json`
  const desktop = window.jigongbenDesktop
  if (desktop) {
    return desktop.saveFile({ kind: 'json', filename, data: contents })
  }

  const blob = new Blob([contents], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  return { canceled: false }
}
