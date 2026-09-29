import { describe, expect, it } from 'vitest'
import { buildAttendanceIndex } from '../src/data-index'
import { buildDailySiteGroups, calculateDailyTotals, filterDailyWorkersBySite } from '../src/daily-sites'
import type { AttendanceEntry, Site, Worker } from '../src/types'

const workers: Worker[] = [
  { id: 'w1', name: '甲', avatarDataUrl: null, avatarEmoji: null, defaultDailyRateFen: 10000, note: '', defaultSiteId: null, createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
  { id: 'w2', name: '乙', avatarDataUrl: null, avatarEmoji: null, defaultDailyRateFen: 10000, note: '', defaultSiteId: null, createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
]
const sites: Site[] = [
  { id: 'a', name: '甲地', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
  { id: 'b', name: '乙地', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
]
const attendance: AttendanceEntry[] = [
  { workerId: 'w1', date: '2026-08-01', morning: 'present', afternoon: 'present', overtime: 'full', dayNote: '', morningSiteId: 'a', afternoonSiteId: 'b', overtimeSiteId: 'a' },
  { workerId: 'w2', date: '2026-08-01', morning: 'present', afternoon: null, overtime: null, dayNote: '', morningSiteId: null, afternoonSiteId: null, overtimeSiteId: null },
]

describe('daily actual-site grouping', () => {
  it('splits one worker across sites, deduplicates people and keeps unassigned separate', () => {
    const index = buildAttendanceIndex(attendance)
    const groups = buildDailySiteGroups({ sites }, workers, '2026-08-01', index)
    expect(groups.map((group) => [group.key, group.people, group.halfDays])).toEqual([
      ['a', 1, 3],
      ['b', 1, 1],
      ['unassigned', 1, 1],
    ])
    expect(groups[0].rows[0].periods).toEqual(['morning', 'overtime'])
  })

  it('uses actual period sites for filtering and totals', () => {
    const index = buildAttendanceIndex(attendance)
    expect(filterDailyWorkersBySite(workers, '2026-08-01', 'b', index).map((worker) => worker.id)).toEqual(['w1'])
    expect(filterDailyWorkersBySite(workers, '2026-08-01', 'unassigned', index).map((worker) => worker.id)).toEqual(['w2'])
    expect(calculateDailyTotals(workers, '2026-08-01', index)).toEqual({ people: 2, halfDays: 5, workDays: 2.5 })
  })
})
