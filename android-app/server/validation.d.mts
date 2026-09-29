import type { AppData } from '../src/types'

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown
}

export function validateAppData(
  input: unknown,
  options?: { cloneInput?: boolean },
): AppData & { operationReceipts: Array<Record<string, unknown>> }

export function emptyAppData(): AppData & { operationReceipts: [] }
