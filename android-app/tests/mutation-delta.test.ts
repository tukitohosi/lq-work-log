import { describe, expect, it } from 'vitest'
import { applyAppDataDelta, buildAppDataDelta } from '../shared/app-data-delta.mjs'
import type { AppData } from '../src/types'

function fixture(): AppData {
  return {
    schemaVersion: 8,
    revision: 1,
    workers: [{
      id: 'worker-1', name: '甲', avatarDataUrl: null, avatarEmoji: null,
      defaultDailyRateFen: 30_000, note: '', defaultSiteId: null,
      createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null,
    }],
    attendance: [],
    monthlyRecords: [],
    payAdjustments: [],
    sites: [{ id: 'site-1', name: '一号', note: '', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null }],
    settings: {
      weekStartsOn: 1, currentWorkerId: 'worker-1', theme: 'light', sidebarCollapsed: false,
      lastBackupExportAt: null, lastBackupReminderAt: null, weeklyAutoBackupEnabled: true,
      lastWeeklyBackupAt: null, defaultOvertimePayPercent: 100,
    },
  }
}

describe('app-data mutation delta', () => {
  it('round-trips entity upserts, deletes and settings without replacing the full state', () => {
    const before = fixture()
    for (let index = 2; index <= 100; index += 1) {
      before.workers.push({
        ...before.workers[0],
        id: `worker-${index}`,
        name: `工人${index}`,
      })
    }
    const after = structuredClone(before)
    after.revision = 2
    after.workers[0].name = '甲（已改）'
    after.attendance.push({
      workerId: 'worker-1', date: '2026-08-01', morning: 'present', afternoon: null,
      overtime: null, dayNote: '', morningSiteId: 'site-1', afternoonSiteId: null,
      overtimeSiteId: null, morningLeave: null, afternoonLeave: null, overtimeLeave: null,
    })
    after.sites = []
    after.settings.theme = 'dark'

    const delta = buildAppDataDelta(before, after)
    expect(delta).toMatchObject({ kind: 'app-data-delta', revision: 2 })
    expect(delta.upserts.workers).toHaveLength(1)
    expect(delta.upserts.attendance).toHaveLength(1)
    expect(delta.deletes.sites).toEqual(['site-1'])
    expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(after).length)
    expect(JSON.stringify(delta).length).toBeLessThanOrEqual(16 * 1024)
    expect(applyAppDataDelta(before, delta)).toEqual(after)
  })
})
