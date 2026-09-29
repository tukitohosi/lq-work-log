export interface AppDataDelta {
  kind: 'app-data-delta'
  schemaVersion: number
  revision: number
  upserts: Record<string, unknown[]>
  deletes: Record<string, string[]>
  settings?: unknown
}

export function buildAppDataDelta(before: unknown, after: unknown): AppDataDelta
export function isAppDataDelta(value: unknown): value is AppDataDelta
export function applyAppDataDelta<T>(base: T, delta: AppDataDelta): T
