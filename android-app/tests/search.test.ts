import { describe, expect, it } from 'vitest'
import { normalizeSearchText, searchAppData } from '../src/search'
import type { AppData } from '../src/types'

function fixture(): AppData {
  return {
    schemaVersion: 7,
    revision: 1,
    workers: [
      {
        id: 'worker-a',
        name: '张三 Alice',
        avatarDataUrl: null,
        avatarEmoji: '👷',
        defaultDailyRateFen: 20_000,
        note: '暑假班组长',
        defaultSiteId: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        archivedAt: null,
      },
      {
        id: 'worker-b',
        name: '李四',
        avatarDataUrl: null,
        avatarEmoji: null,
        defaultDailyRateFen: 18_000,
        note: '负责仓库',
        defaultSiteId: null,
        createdAt: '2026-06-01T00:00:00.000Z',
        archivedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
    attendance: [{
      workerId: 'worker-a',
      date: '2026-08-03',
      morning: 'present',
      afternoon: 'present',
      overtime: null,
      dayNote: '临时调到南门',
      morningSiteId: null,
      afternoonSiteId: null,
      overtimeSiteId: null,
    }],
    monthlyRecords: [{
      workerId: 'worker-b',
      month: '2026-08',
      dailyRateFen: 18_000,
      overtimePayPercent: 100,
      note: '月底一起结算',
      paidAt: null,
    }],
    payAdjustments: [{
      id: 'adjustment-a',
      workerId: 'worker-a',
      month: '2026-08',
      date: '2026-08-03',
      kind: 'allowance',
      amountFen: 2_000,
      label: '交通补贴',
      note: '夜班打车',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    }],
    sites: [],
    settings: {
      weekStartsOn: 1,
      currentWorkerId: null,
      theme: 'light',
      sidebarCollapsed: false,
      lastBackupExportAt: null,
      lastBackupReminderAt: null,
      weeklyAutoBackupEnabled: true,
      lastWeeklyBackupAt: null,
      defaultOvertimePayPercent: 100,
    },
  }
}

describe('searchAppData', () => {
  it('returns no results for an empty or whitespace-only query', () => {
    expect(searchAppData(fixture(), '')).toEqual([])
    expect(searchAppData(fixture(), '  \n ')).toEqual([])
  })

  it('normalizes Latin case, full-width characters and whitespace', () => {
    expect(normalizeSearchText('  ＡＬＩＣＥ\n班组 ')).toBe('alice 班组')
    const results = searchAppData(fixture(), 'aLiCe')
    expect(results[0]).toMatchObject({ id: 'worker:worker-a', kind: 'worker', workerId: 'worker-a' })
  })

  it('covers worker notes, daily notes, monthly notes and adjustment labels or notes', () => {
    expect(searchAppData(fixture(), '暑假班组长').map((item) => item.kind)).toContain('worker')
    expect(searchAppData(fixture(), '南门')).toEqual([
      expect.objectContaining({ id: 'day-note:worker-a:2026-08-03', month: '2026-08', date: '2026-08-03' }),
    ])
    expect(searchAppData(fixture(), '月底 结算')).toEqual([
      expect.objectContaining({ id: 'monthly-note:worker-b:2026-08', month: '2026-08', archived: true }),
    ])
    expect(searchAppData(fixture(), '交通补贴')).toEqual([
      expect.objectContaining({ id: 'adjustment:adjustment-a', kind: 'adjustment', workerId: 'worker-a' }),
    ])
    expect(searchAppData(fixture(), '夜班打车')[0]?.snippet).toBe('夜班打车')
  })

  it('keeps result IDs stable and supports multi-token Chinese searches', () => {
    const first = searchAppData(fixture(), '张三 南门')
    const second = searchAppData(structuredClone(fixture()), ' 张三   南门 ')
    expect(first.map((item) => item.id)).toEqual(['day-note:worker-a:2026-08-03'])
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id))
  })
})
