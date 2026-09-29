import { workerDateKey, type AttendanceIndex } from './data-index'
import type { AppData, AttendancePeriod, Worker } from './types'

export interface DailySiteGroup {
  key: string
  siteId: string | null
  name: string
  people: number
  halfDays: number
  workDays: number
  rows: Array<{ worker: Worker; periods: AttendancePeriod[] }>
}

export function filterDailyWorkersBySite(
  workers: readonly Worker[],
  date: string,
  siteFilter: string,
  index: AttendanceIndex,
): Worker[] {
  if (siteFilter === 'all') return [...workers]
  const wanted = siteFilter === 'unassigned' ? null : siteFilter
  return workers.filter((worker) => {
    const entry = index.get(workerDateKey(worker.id, date))
    return Boolean(
      (entry?.morning === 'present' && entry.morningSiteId === wanted)
      || (entry?.afternoon === 'present' && entry.afternoonSiteId === wanted)
      || ((entry?.overtime === 'half' || entry?.overtime === 'full') && entry.overtimeSiteId === wanted),
    )
  })
}

export function calculateDailyTotals(
  workers: readonly Worker[],
  date: string,
  index: AttendanceIndex,
): { people: number; halfDays: number; workDays: number } {
  let halfDays = 0
  let people = 0
  for (const worker of workers) {
    const entry = index.get(workerDateKey(worker.id, date))
    const workerUnits = (entry?.morning === 'present' ? 1 : 0)
      + (entry?.afternoon === 'present' ? 1 : 0)
      + (entry?.overtime === 'half' ? 1 : entry?.overtime === 'full' ? 2 : 0)
    halfDays += workerUnits
    if (workerUnits > 0) people += 1
  }
  return { people, halfDays, workDays: halfDays / 2 }
}

export function buildDailySiteGroups(
  data: Pick<AppData, 'sites'>,
  workers: readonly Worker[],
  date: string,
  index: AttendanceIndex,
): DailySiteGroup[] {
  const groups = new Map<string, {
    siteId: string | null
    name: string
    halfDays: number
    workers: Map<string, { worker: Worker; periods: AttendancePeriod[] }>
  }>()
  const add = (worker: Worker, siteId: string | null | undefined, period: AttendancePeriod, units: number) => {
    const normalizedSiteId = siteId || null
    const key = normalizedSiteId ?? 'unassigned'
    const site = normalizedSiteId ? data.sites.find((candidate) => candidate.id === normalizedSiteId) : null
    const group = groups.get(key) ?? {
      siteId: normalizedSiteId,
      name: site?.name ?? (normalizedSiteId ? '未知工地' : '未分配'),
      halfDays: 0,
      workers: new Map(),
    }
    const row = group.workers.get(worker.id) ?? { worker, periods: [] }
    if (!row.periods.includes(period)) row.periods.push(period)
    group.workers.set(worker.id, row)
    group.halfDays += units
    groups.set(key, group)
  }

  for (const worker of workers) {
    const entry = index.get(workerDateKey(worker.id, date))
    if (entry?.morning === 'present') add(worker, entry.morningSiteId, 'morning', 1)
    if (entry?.afternoon === 'present') add(worker, entry.afternoonSiteId, 'afternoon', 1)
    if (entry?.overtime === 'half') add(worker, entry.overtimeSiteId, 'overtime', 1)
    if (entry?.overtime === 'full') add(worker, entry.overtimeSiteId, 'overtime', 2)
  }

  return [...groups.entries()].map(([key, group]) => ({
    key,
    siteId: group.siteId,
    name: group.name,
    people: group.workers.size,
    halfDays: group.halfDays,
    workDays: group.halfDays / 2,
    rows: [...group.workers.values()],
  })).sort((left, right) => {
    if (left.siteId === null) return 1
    if (right.siteId === null) return -1
    return left.name.localeCompare(right.name, 'zh-CN')
  })
}
