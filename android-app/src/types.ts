export type AttendanceStatus = 'present' | 'absent' | null
export type OvertimeStatus = 'half' | 'full' | null
export type AttendancePeriod = 'morning' | 'afternoon' | 'overtime'
export type AttendanceValue = AttendanceStatus | OvertimeStatus
export type LeavePayType = 'paid' | 'unpaid'
export type PaidOvertimeLeaveUnits = 'half' | 'full'
export type WeekStartsOn = 0 | 1 | 6
export type Theme = 'light' | 'dark'
export type PayAdjustmentKind = 'allowance' | 'deduction'

export interface OrdinaryLeave {
  payType: LeavePayType
}

export type OvertimeLeave =
  | { payType: 'unpaid' }
  | { payType: 'paid'; units: PaidOvertimeLeaveUnits }

export interface Worker {
  id: string
  name: string
  avatarDataUrl: string | null
  avatarEmoji: string | null
  defaultDailyRateFen: number
  note: string
  defaultSiteId: string | null
  createdAt: string
  archivedAt: string | null
}

export interface AttendanceEntry {
  workerId: string
  date: string
  morning: AttendanceStatus
  afternoon: AttendanceStatus
  overtime: OvertimeStatus
  dayNote: string
  morningSiteId: string | null
  afternoonSiteId: string | null
  overtimeSiteId: string | null
  /** Optional while v1-v7 data is being inspected; v8 migration normalizes it to null. */
  morningLeave?: OrdinaryLeave | null
  /** Optional while v1-v7 data is being inspected; v8 migration normalizes it to null. */
  afternoonLeave?: OrdinaryLeave | null
  /** Optional while v1-v7 data is being inspected; v8 migration normalizes it to null. */
  overtimeLeave?: OvertimeLeave | null
}

export interface MonthlyRecord {
  workerId: string
  month: string
  dailyRateFen: number
  overtimePayPercent: number
  note: string
  paidAt: string | null
}

export interface PayAdjustment {
  id: string
  workerId: string
  month: string
  date: string | null
  kind: PayAdjustmentKind
  amountFen: number
  label: string
  note: string
  /** Optional while v1-v7 data is being inspected; v8 migration normalizes it to null. */
  siteId?: string | null
  createdAt: string
  updatedAt: string
}

export type HistoryRevertTarget =
  | {
      entity: 'attendance'
      key: { workerId: string; date: string }
      /** A field-level snapshot; the server allowlists and validates every key. */
      before: Record<string, unknown>
      /** A field-level snapshot; the server allowlists and validates every key. */
      after: Record<string, unknown>
    }
  | {
      entity: 'monthlyRecord'
      key: { workerId: string; month: string }
      before: MonthlyRecord | null
      after: MonthlyRecord | null
    }
  | {
      entity: 'payAdjustment'
      key: { id: string }
      before: PayAdjustment | null
      after: PayAdjustment | null
    }
  | {
      entity: 'siteArchive'
      key: { id: string }
      before: {
        archivedAt: string | null
        workerDefaults: Array<{ workerId: string; defaultSiteId: string | null }>
      }
      after: {
        archivedAt: string | null
        workerDefaults: Array<{ workerId: string; defaultSiteId: string | null }>
      }
    }

export interface Site {
  id: string
  name: string
  note: string
  createdAt: string
  archivedAt: string | null
}

export interface Settings {
  weekStartsOn: WeekStartsOn
  currentWorkerId: string | null
  theme: Theme
  sidebarCollapsed: boolean
  lastBackupExportAt: string | null
  lastBackupReminderAt: string | null
  weeklyAutoBackupEnabled: boolean
  lastWeeklyBackupAt: string | null
  defaultOvertimePayPercent: number
}

export interface AppData {
  schemaVersion: number
  revision: number
  workers: Worker[]
  attendance: AttendanceEntry[]
  monthlyRecords: MonthlyRecord[]
  payAdjustments: PayAdjustment[]
  sites: Site[]
  settings: Settings
}

export interface AttendancePatch {
  workerId: string
  date: string
  morning?: AttendanceStatus
  afternoon?: AttendanceStatus
  overtime?: OvertimeStatus
  dayNote?: string
  morningSiteId?: string | null
  afternoonSiteId?: string | null
  overtimeSiteId?: string | null
  morningLeave?: OrdinaryLeave | null
  afternoonLeave?: OrdinaryLeave | null
  overtimeLeave?: OvertimeLeave | null
}

export interface ApiErrorBody {
  error?: {
    code?: string
    message?: string
    details?: unknown
  }
}

export interface RestoreSummary {
  data: AppData
  filename: string
  workerCount: number
  archivedWorkerCount: number
  attendanceCount: number
  monthCount: number
  adjustmentCount: number
  siteCount: number
  workerNames: string[]
}

export interface RestoreInspection extends Omit<RestoreSummary, 'filename'> {
  schemaVersion: number
}

export type InternalBackupKind = 'last-good' | 'daily' | 'pre-restore' | 'other'

export interface InternalBackupMeta {
  id: string
  kind: InternalBackupKind
  filename: string
  modifiedAt: string
  size: number
  /** Present only on legacy responses; v8 backup lists intentionally expose metadata only. */
  schemaVersion?: number
  revision?: number
  workerCount?: number
  attendanceCount?: number
  adjustmentCount?: number
  siteCount?: number
}

export interface InternalBackupInspection extends RestoreInspection {
  backup: InternalBackupMeta
}
