import type { AppData, AttendanceEntry, AttendancePatch, AttendancePeriod, AttendanceValue, Worker } from './types'
import { workerDateKey } from './data-index'

export const ATTENDANCE_PATCH_FIELDS = [
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

export type AttendancePatchField = (typeof ATTENDANCE_PATCH_FIELDS)[number]

export function attendanceKey(workerId: string, date: string): string {
  return workerDateKey(workerId, date)
}

export function blankAttendance(workerId: string, date: string): AttendanceEntry {
  return {
    workerId,
    date,
    morning: null,
    afternoon: null,
    overtime: null,
    dayNote: '',
    morningSiteId: null,
    afternoonSiteId: null,
    overtimeSiteId: null,
    morningLeave: null,
    afternoonLeave: null,
    overtimeLeave: null,
  }
}

export function findAttendance(
  data: AppData,
  workerId: string,
  date: string,
  index?: ReadonlyMap<string, AttendanceEntry>,
): AttendanceEntry | undefined {
  if (index) return index.get(attendanceKey(workerId, date))
  return data.attendance.find((entry) => entry.workerId === workerId && entry.date === date)
}

export function attendanceIsEmpty(entry: AttendanceEntry): boolean {
  return (
    entry.morning === null &&
    entry.afternoon === null &&
    entry.overtime === null &&
    entry.dayNote === '' &&
    entry.morningSiteId === null &&
    entry.afternoonSiteId === null &&
    entry.overtimeSiteId === null
    && (entry.morningLeave ?? null) === null
    && (entry.afternoonLeave ?? null) === null
    && (entry.overtimeLeave ?? null) === null
  )
}

export function sanitizeAttendancePatch(
  current: AttendanceEntry,
  patch: AttendancePatch,
  worker: Worker | undefined,
): AttendancePatch {
  const next: AttendancePatch = { ...patch }
  for (const period of ['morning', 'afternoon', 'overtime'] as const) {
    const leaveField = periodLeaveField(period)
    const siteField = periodSiteField(period)
    const touchesPeriod = patch[period] !== undefined
      || patch[siteField] !== undefined
      || patch[leaveField] !== undefined
    if (!touchesPeriod) continue
    const currentLeave = current[leaveField] ?? null
    const requestedLeave = patch[leaveField]
    if (requestedLeave) {
      ;(next as unknown as Record<string, unknown>)[period] = null
      ;(next as unknown as Record<string, unknown>)[siteField] = null
    } else if (currentLeave && requestedLeave === undefined && (patch[period] !== undefined || patch[siteField] !== undefined)) {
      ;(next as unknown as Record<string, unknown>)[period] = current[period]
      ;(next as unknown as Record<string, unknown>)[siteField] = current[siteField]
    }
    const status = next[period] === undefined ? current[period] : next[period]
    const isWorking = period === 'overtime' ? status !== null : status === 'present'
    if (!isWorking) {
      ;(next as unknown as Record<string, unknown>)[siteField] = null
    } else if (patch[period] !== undefined && patch[siteField] === undefined && current[siteField] === null) {
      ;(next as unknown as Record<string, unknown>)[siteField] = worker?.defaultSiteId ?? null
    }
  }
  return next
}

export function applyAttendancePatch(data: AppData, rawPatch: AttendancePatch): AttendancePatch {
  const entryIndex = data.attendance.findIndex(
    (entry) => entry.workerId === rawPatch.workerId && entry.date === rawPatch.date,
  )
  const current = entryIndex === -1
    ? blankAttendance(rawPatch.workerId, rawPatch.date)
    : data.attendance[entryIndex]
  const worker = data.workers.find((candidate) => candidate.id === rawPatch.workerId)
  const patch = sanitizeAttendancePatch(current, rawPatch, worker)
  const entry = { ...current }
  for (const field of ATTENDANCE_PATCH_FIELDS) {
    const value = patch[field]
    if (value !== undefined) (entry as unknown as Record<string, unknown>)[field] = value
  }
  if (attendanceIsEmpty(entry)) {
    if (entryIndex !== -1) data.attendance.splice(entryIndex, 1)
  } else if (entryIndex === -1) {
    data.attendance.push(entry)
  } else {
    data.attendance[entryIndex] = entry
  }
  return patch
}

export function snapshotPatchFields(
  data: AppData,
  patch: AttendancePatch,
): { before: AttendancePatch; after: AttendancePatch } {
  const entry = findAttendance(data, patch.workerId, patch.date) ?? blankAttendance(patch.workerId, patch.date)
  const worker = data.workers.find((candidate) => candidate.id === patch.workerId)
  const after = sanitizeAttendancePatch(entry, patch, worker)
  const before: AttendancePatch = { workerId: patch.workerId, date: patch.date }
  for (const field of ATTENDANCE_PATCH_FIELDS) {
    if (after[field] !== undefined) {
      ;(before as unknown as Record<string, unknown>)[field] = entry[field]
    }
  }
  return { before, after }
}

export function patchChanged(data: AppData, patch: AttendancePatch): boolean {
  const entry = findAttendance(data, patch.workerId, patch.date) ?? blankAttendance(patch.workerId, patch.date)
  return ATTENDANCE_PATCH_FIELDS.some((field) => patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(entry[field]))
}

export function fullAttendancePatch(data: AppData, workerId: string, date: string): AttendancePatch {
  const entry = findAttendance(data, workerId, date) ?? blankAttendance(workerId, date)
  return {
    workerId,
    date,
    morning: entry.morning,
    afternoon: entry.afternoon,
    overtime: entry.overtime,
    dayNote: entry.dayNote,
    morningSiteId: entry.morningSiteId,
    afternoonSiteId: entry.afternoonSiteId,
    overtimeSiteId: entry.overtimeSiteId,
    morningLeave: entry.morningLeave ?? null,
    afternoonLeave: entry.afternoonLeave ?? null,
    overtimeLeave: entry.overtimeLeave ?? null,
  }
}

export function periodSiteField(period: AttendancePeriod): 'morningSiteId' | 'afternoonSiteId' | 'overtimeSiteId' {
  return `${period}SiteId` as 'morningSiteId' | 'afternoonSiteId' | 'overtimeSiteId'
}

export function periodLeaveField(period: AttendancePeriod): 'morningLeave' | 'afternoonLeave' | 'overtimeLeave' {
  return `${period}Leave` as 'morningLeave' | 'afternoonLeave' | 'overtimeLeave'
}

export function nextAttendanceValue(period: AttendancePeriod, value: AttendanceValue): AttendanceValue {
  if (period === 'overtime') return value === null ? 'half' : value === 'half' ? 'full' : null
  return value === null ? 'present' : value === 'present' ? 'absent' : null
}
