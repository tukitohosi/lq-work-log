export interface WorkerFormPayload {
  name: string
  avatarDataUrl: string | null
  avatarEmoji: string | null
  defaultDailyRateFen: number
  note: string
  defaultSiteId: string | null
}

export interface BatchWorkerItem {
  name: string
  defaultDailyRateFen: number
  defaultSiteId: string | null
}

export interface BatchWorkerSubmission {
  requestId: number
  items: BatchWorkerItem[]
}

export interface BatchWorkerResult {
  requestId: number
  completed: number
  remaining: BatchWorkerItem[]
  error: string
}
