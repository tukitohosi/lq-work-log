import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { Filesystem } from '@capacitor/filesystem'
import type { AttendancePatch } from '../src/types'

const mockStorage = vi.hoisted(() => ({
  files: new Map<string, string>(),
  modifiedAt: new Map<string, number>(),
  touchedPaths: [] as string[],
}))

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA', Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
      const key = `${directory}:${path}`
      mockStorage.touchedPaths.push(key)
      const data = mockStorage.files.get(key)
      if (data === undefined) throw new Error('File does not exist')
      return { data }
    }),
    writeFile: vi.fn(async ({ path, directory, data }: { path: string; directory: string; data: string }) => {
      const key = `${directory}:${path}`
      mockStorage.touchedPaths.push(key)
      mockStorage.files.set(key, data)
      mockStorage.modifiedAt.set(key, Date.now())
      return { uri: `mock://${key}` }
    }),
    deleteFile: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
      const key = `${directory}:${path}`
      mockStorage.touchedPaths.push(key)
      if (!mockStorage.files.delete(key)) throw new Error('File does not exist')
      mockStorage.modifiedAt.delete(key)
    }),
    stat: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
      const key = `${directory}:${path}`
      const data = mockStorage.files.get(key)
      if (data === undefined) throw new Error('File does not exist')
      return {
        type: 'file',
        size: new TextEncoder().encode(data).byteLength,
        mtime: mockStorage.modifiedAt.get(key) ?? Date.now(),
        ctime: mockStorage.modifiedAt.get(key) ?? Date.now(),
        uri: `mock://${key}`,
      }
    }),
    readdir: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
      const prefix = `${directory}:${path}/`
      const files = [...mockStorage.files.entries()]
        .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map(([key, data]) => ({
          name: key.slice(prefix.length),
          type: 'file',
          size: new TextEncoder().encode(data).byteLength,
          mtime: mockStorage.modifiedAt.get(key) ?? Date.now(),
          ctime: mockStorage.modifiedAt.get(key) ?? Date.now(),
          uri: `mock://${key}`,
        }))
      return { files }
    }),
    getUri: vi.fn(async ({ path, directory }: { path: string; directory: string }) => ({
      uri: `mock://${directory}:${path}`,
    })),
  },
}))

vi.mock('@capacitor/share', () => ({
  Share: { share: vi.fn(async () => undefined) },
}))

async function loadFreshPocApi() {
  vi.resetModules()
  return (await import('../src/android-poc-api')).androidPocApi
}

beforeEach(() => {
  mockStorage.files.clear()
  mockStorage.modifiedAt.clear()
  mockStorage.touchedPaths.length = 0
  vi.clearAllMocks()
})

function legacyV1Backup() {
  return {
    schemaVersion: 1,
    revision: 7,
    workers: [{
      id: 'worker-v1',
      name: '旧版工人',
      defaultDailyRateFen: 30_000,
      note: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    }],
    attendance: [{
      workerId: 'worker-v1',
      date: '2026-01-02',
      morning: 'present',
      afternoon: null,
    }],
    monthlyRecords: [{
      workerId: 'worker-v1',
      month: '2026-01',
      dailyRateFen: 30_000,
      note: '',
    }],
    settings: {
      weekStartsOn: 1,
      currentWorkerId: 'worker-v1',
    },
  }
}

describe('Android private persistence', () => {
  it('starts empty, persists test attendance, and reloads it after an app restart', async () => {
    const firstRun = await loadFreshPocApi()
    expect(await firstRun.getState()).toMatchObject({
      schemaVersion: 8,
      revision: 0,
      workers: [],
      attendance: [],
    })

    await firstRun.addWorker({
      name: '候选版测试工人',
      avatarDataUrl: null,
      avatarEmoji: '👷',
      defaultDailyRateFen: 30_000,
      note: '仅用于 Android 候选版验证',
    })
    const workerId = (await firstRun.getState()).workers[0].id
    await firstRun.setAttendance({
      workerId,
      date: '2026-09-22',
      period: 'morning',
      status: 'present',
    })

    const afterRestart = await loadFreshPocApi()
    const restored = await afterRestart.getState()
    expect(restored.revision).toBe(2)
    expect(restored.workers).toHaveLength(1)
    expect(restored.workers[0]).toMatchObject({ id: workerId, name: '候选版测试工人' })
    expect(restored.attendance).toContainEqual(expect.objectContaining({
      workerId,
      date: '2026-09-22',
      morning: 'present',
    }))

    expect(mockStorage.files.has('DATA:lq-jigongben/records.json')).toBe(true)
    expect(mockStorage.files.has('DATA:lq-jigongben/records.pending.json')).toBe(false)
    expect([...mockStorage.files.keys()]).toContain('DATA:lq-jigongben/records.last-good.json')
    expect([...mockStorage.files.keys()].some((path) => /backups\/daily-\d{4}-\d{2}-\d{2}\.json$/.test(path))).toBe(true)
    expect(mockStorage.touchedPaths.every((path) => path.includes('lq-jigongben/'))).toBe(true)
    expect(JSON.parse(mockStorage.files.get('DATA:lq-jigongben/records.json') ?? '{}')).toMatchObject({
      schemaVersion: 8,
      operationReceipts: [],
    })
  })

  it('migrates schema v1 backups and rejects unknown fields with the shared validator', async () => {
    const api = await loadFreshPocApi()
    const inspection = await api.inspectRestore(legacyV1Backup())

    expect(inspection).toMatchObject({
      schemaVersion: 8,
      workerCount: 1,
      attendanceCount: 1,
      monthCount: 1,
      workerNames: ['旧版工人'],
    })
    expect(inspection.data.workers[0]).toMatchObject({
      avatarDataUrl: null,
      avatarEmoji: null,
      defaultSiteId: null,
    })
    await expect(api.inspectRestore({ ...legacyV1Backup(), unexpected: true })).rejects.toThrow('未知字段')
  })

  it('creates inspectable pre-restore, daily, and last-good backups before replacing data', async () => {
    const api = await loadFreshPocApi()
    await api.addWorker({
      name: '恢复前工人',
      avatarDataUrl: null,
      avatarEmoji: '👷',
      defaultDailyRateFen: 30_000,
      note: '',
    })
    const inspection = await api.inspectRestore(legacyV1Backup())
    const restored = await api.restore(reactive(inspection.data))
    const backups = await api.listInternalBackups()

    expect(restored.revision).toBe(2)
    expect(restored.workers[0].name).toBe('旧版工人')
    expect(backups.items.map((item) => item.kind)).toEqual(expect.arrayContaining(['last-good', 'daily', 'pre-restore']))
    const preRestore = backups.items.find((item) => item.kind === 'pre-restore')
    expect(preRestore).toBeDefined()
    const backupInspection = await api.inspectInternalBackup(preRestore!.id)
    expect(backupInspection.workerNames).toContain('恢复前工人')
  })

  it('recovers a fully verified pending write when the main file is absent', async () => {
    const firstRun = await loadFreshPocApi()
    await firstRun.addWorker({
      name: '待恢复工人',
      avatarDataUrl: null,
      avatarEmoji: null,
      defaultDailyRateFen: 30_000,
      note: '',
    })
    const mainKey = 'DATA:lq-jigongben/records.json'
    const pendingKey = 'DATA:lq-jigongben/records.pending.json'
    mockStorage.files.set(pendingKey, mockStorage.files.get(mainKey)!)
    mockStorage.modifiedAt.set(pendingKey, Date.now())
    mockStorage.files.delete(mainKey)
    mockStorage.files.delete('DATA:lq-jigongben/records.last-good.json')

    const recovered = await (await loadFreshPocApi()).getState()
    expect(recovered.workers[0].name).toBe('待恢复工人')
    expect(mockStorage.files.has(mainKey)).toBe(true)
    expect(mockStorage.files.has(pendingKey)).toBe(false)
  })

  it('recovers from a corrupt main file by promoting the last-good copy', async () => {
    const mainKey = 'DATA:lq-jigongben/records.json'
    const lastGoodKey = 'DATA:lq-jigongben/records.last-good.json'
    mockStorage.files.set(mainKey, '{not-valid-json')
    mockStorage.files.set(lastGoodKey, JSON.stringify(legacyV1Backup()))
    mockStorage.modifiedAt.set(mainKey, Date.now())
    mockStorage.modifiedAt.set(lastGoodKey, Date.now() - 1_000)

    const recovered = await (await loadFreshPocApi()).getState()

    expect(recovered.schemaVersion).toBe(8)
    expect(recovered.workers[0].name).toBe('旧版工人')
    expect(JSON.parse(mockStorage.files.get(mainKey) ?? '{}')).toMatchObject({
      schemaVersion: 8,
      workers: [expect.objectContaining({ name: '旧版工人' })],
    })
  })

  it('keeps only the newest 14 daily and 10 pre-restore backups', async () => {
    const mainKey = 'DATA:lq-jigongben/records.json'
    mockStorage.files.set(mainKey, JSON.stringify(legacyV1Backup()))
    mockStorage.modifiedAt.set(mainKey, Date.now())
    for (let day = 1; day <= 16; day += 1) {
      const key = `DATA:lq-jigongben/backups/daily-2026-01-${String(day).padStart(2, '0')}.json`
      mockStorage.files.set(key, '{}')
      mockStorage.modifiedAt.set(key, Date.now() - day)
    }
    for (let day = 1; day <= 12; day += 1) {
      const key = `DATA:lq-jigongben/backups/pre-restore-202601${String(day).padStart(2, '0')}T000000Z.json`
      mockStorage.files.set(key, '{}')
      mockStorage.modifiedAt.set(key, Date.now() - day)
    }

    const api = await loadFreshPocApi()
    await api.addWorker({
      name: '触发每日备份整理',
      avatarDataUrl: null,
      defaultDailyRateFen: 30_000,
      note: '',
    })
    await api.restore((await api.inspectRestore(legacyV1Backup())).data)

    const keys = [...mockStorage.files.keys()]
    expect(keys.filter((key) => key.includes('/backups/daily-'))).toHaveLength(14)
    expect(keys.filter((key) => key.includes('/backups/pre-restore-'))).toHaveLength(10)
  })

  it('recovers the serialized write queue after one storage failure', async () => {
    const api = await loadFreshPocApi()
    await api.getState()
    vi.mocked(Filesystem.writeFile).mockRejectedValueOnce(new Error('disk full'))

    await expect(api.addWorker({
      name: '不应落盘',
      avatarDataUrl: null,
      defaultDailyRateFen: 30_000,
      note: '',
    })).rejects.toThrow('disk full')
    await expect(api.addWorker({
      name: '队列恢复成功',
      avatarDataUrl: null,
      defaultDailyRateFen: 30_000,
      note: '',
    })).resolves.toBeDefined()

    const state = await api.getState()
    expect(state.workers.map((worker) => worker.name)).toEqual(['队列恢复成功'])
    expect((await api.getHealth()).dataLimitBytes).toBe(64 * 1024 * 1024)
  })
})

describe('Android attendance and leave parity', () => {
  async function setupWorker() {
    const api = await loadFreshPocApi()
    await api.addSite({ name: '测试默认工地', note: '' })
    const siteId = (await api.getState()).sites[0]!.id
    await api.addWorker({ name: '记工规则测试', avatarDataUrl: null, defaultDailyRateFen: 30_000, note: '', defaultSiteId: siteId })
    const workerId = (await api.getState()).workers[0]!.id
    return { api, workerId, siteId, date: '2026-09-01' }
  }

  it.each(['paid', 'unpaid'] as const)('clears work/site for %s leave, protects it, then resumes with the default site', async payType => {
    const { api, workerId, siteId, date } = await setupWorker()
    await api.setAttendanceBatch([{ workerId, date, morning: 'present', afternoon: 'present', dayNote: '保留备注' }])
    expect((await api.getState()).attendance[0]).toMatchObject({ morning: 'present', morningSiteId: siteId, afternoonSiteId: siteId })

    await api.setAttendanceLeave([{ workerId, date, period: 'morning', leave: { payType } }])
    const onLeave = await api.getState()
    expect(onLeave.attendance[0]).toMatchObject({
      morning: null, morningSiteId: null, morningLeave: { payType },
      afternoon: 'present', afternoonSiteId: siteId, dayNote: '保留备注',
    })
    const savedOnLeave = mockStorage.files.get('DATA:lq-jigongben/records.json')
    await expect(api.setAttendance({ workerId, date, period: 'morning', status: 'present' })).rejects.toThrow('请假时段已锁定')
    await expect(api.setAttendanceBatch([{ workerId, date, morningLeave: null }])).rejects.toThrow('请假时段已锁定')
    expect(await api.getState()).toEqual(onLeave)
    expect(mockStorage.files.get('DATA:lq-jigongben/records.json')).toBe(savedOnLeave)

    await api.setAttendanceLeave([{ workerId, date, period: 'morning', leave: null }])
    expect((await api.getState()).attendance[0]).toMatchObject({ morning: null, morningSiteId: null, morningLeave: null, afternoon: 'present' })
    await api.setAttendance({ workerId, date, period: 'morning', status: 'present' })
    expect((await api.getState()).attendance[0]).toMatchObject({ morning: 'present', morningSiteId: siteId, morningLeave: null })
    expect((await (await loadFreshPocApi()).getState()).attendance[0]).toMatchObject({ morning: 'present', morningSiteId: siteId, morningLeave: null })
  })

  it.each(['absent', null] as const)('clears the actual site when work changes to %s', async status => {
    const { api, workerId, siteId, date } = await setupWorker()
    await api.setAttendanceBatch([{ workerId, date, morning: 'present', afternoon: 'present', dayNote: '保留备注' }])
    await api.setAttendance({ workerId, date, period: 'morning', status })
    const state = await api.getState()
    expect(state.attendance[0]).toMatchObject({ morning: status, morningSiteId: null, afternoon: 'present', afternoonSiteId: siteId, dayNote: '保留备注' })
  })

  it('retains an explicit unassigned site and removes a fully blank day', async () => {
    const { api, workerId, date } = await setupWorker()
    await api.setAttendanceBatch([{ workerId, date, morning: 'present', morningSiteId: null }])
    expect((await api.getState()).attendance[0]).toMatchObject({ morning: 'present', morningSiteId: null })
    await api.setAttendance({ workerId, date, period: 'morning', status: null })
    expect((await api.getState()).attendance).toEqual([])
    await api.setAttendanceLeave([{ workerId, date, period: 'afternoon', leave: { payType: 'paid' } }])
    await api.setAttendanceLeave([{ workerId, date, period: 'afternoon', leave: null }])
    expect((await api.getState()).attendance).toEqual([])
  })

  it('supports both overtime values and valid paid/unpaid leave without retaining the overtime site', async () => {
    const { api, workerId, siteId, date } = await setupWorker()
    await api.setAttendance({ workerId, date, period: 'overtime', status: 'half' })
    expect((await api.getState()).attendance[0]).toMatchObject({ overtime: 'half', overtimeSiteId: siteId })
    await api.setAttendance({ workerId, date, period: 'overtime', status: 'full' })
    expect((await api.getState()).attendance[0]).toMatchObject({ overtime: 'full', overtimeSiteId: siteId })
    await api.setAttendanceLeave([{ workerId, date, period: 'overtime', leave: { payType: 'paid', units: 'full' } }])
    expect((await api.getState()).attendance[0]).toMatchObject({ overtime: null, overtimeSiteId: null, overtimeLeave: { payType: 'paid', units: 'full' } })
    await api.setAttendanceLeave([{ workerId, date, period: 'overtime', leave: { payType: 'unpaid' } }])
    expect((await api.getState()).attendance[0]).toMatchObject({ overtime: null, overtimeSiteId: null, overtimeLeave: { payType: 'unpaid' } })
    await api.setAttendanceLeave([{ workerId, date, period: 'overtime', leave: null }])
    await api.setAttendance({ workerId, date, period: 'overtime', status: 'half' })
    expect((await api.getState()).attendance[0]).toMatchObject({ overtime: 'half', overtimeSiteId: siteId, overtimeLeave: null })
    await api.setAttendance({ workerId, date, period: 'overtime', status: null })
    expect((await api.getState()).attendance).toEqual([])
    await expect(api.setAttendance({ workerId, date, period: 'overtime', status: 'present' })).rejects.toThrow('加班状态')
    await expect(api.setAttendance({ workerId, date, period: 'morning', status: 'full' })).rejects.toThrow('考勤状态')
    await expect(api.setAttendanceLeave([{ workerId, date, period: 'overtime', leave: { payType: 'paid' } } as never])).rejects.toThrow('units')
  })

  it('preserves archived site history and allows an undo reference without reassigning the default', async () => {
    const { api, workerId, siteId, date } = await setupWorker()
    await api.setAttendance({ workerId, date, period: 'morning', status: 'present' })
    await api.updateSite(siteId, { archived: true })
    await api.setDayNote({ workerId, date, dayNote: '历史备注' })
    expect((await api.getState()).attendance[0]).toMatchObject({ morningSiteId: siteId, dayNote: '历史备注' })
    await api.setAttendance({ workerId, date, period: 'morning', status: 'absent' })
    await api.setAttendanceBatch([{ workerId, date, morning: 'present', morningSiteId: siteId }])
    await api.setAttendance({ workerId, date: '2026-09-02', period: 'morning', status: 'present' })
    const state = await api.getState()
    expect(state.workers[0]!.defaultSiteId).toBeNull()
    expect(state.attendance.find(entry => entry.date === date)).toMatchObject({ morning: 'present', morningSiteId: siteId })
    expect(state.attendance.find(entry => entry.date === '2026-09-02')).toMatchObject({ morning: 'present', morningSiteId: null })
  })

  it('rejects an invalid batch before persistence without partially changing the cache or other dates', async () => {
    const { api, workerId, siteId, date } = await setupWorker()
    await api.setAttendance({ workerId, date, period: 'morning', status: 'present' })
    const before = await api.getState()
    const files = new Map(mockStorage.files)
    const writes = vi.mocked(Filesystem.writeFile).mock.calls.length
    await expect(api.setAttendanceBatch([
      { workerId, date, morning: 'absent' },
      { workerId, date: '2026-09-02', afternoon: 'half' } as unknown as AttendancePatch,
    ])).rejects.toThrow('考勤状态')
    await expect(api.setAttendanceBatch([{ workerId, date, morning: 'absent', morningSiteId: siteId }])).rejects.toThrow('只有出工或加班状态')
    await expect(api.setAttendanceBatch([{ workerId, date, unknownField: true } as unknown as AttendancePatch])).rejects.toThrow('未知字段')
    await expect(api.setAttendanceLeave([
      { workerId, date, period: 'morning', leave: { payType: 'unpaid' } },
      { workerId, date: '2026-09-02', period: 'overtime', leave: { payType: 'paid', units: 'invalid' } } as never,
    ])).rejects.toThrow('units')
    expect(await api.getState()).toEqual(before)
    expect(mockStorage.files).toEqual(files)
    expect(vi.mocked(Filesystem.writeFile)).toHaveBeenCalledTimes(writes)
    expect(await (await loadFreshPocApi()).getState()).toEqual(before)
  })

  it('keeps the original attendance after a storage failure and permits a successful leave retry', async () => {
    const { api, workerId, siteId, date } = await setupWorker()
    await api.setAttendance({ workerId, date, period: 'morning', status: 'present' })
    const before = await api.getState()
    const files = new Map(mockStorage.files)
    vi.mocked(Filesystem.writeFile).mockRejectedValueOnce(new Error('disk full'))
    await expect(api.setAttendanceLeave([{ workerId, date, period: 'morning', leave: { payType: 'paid' } }])).rejects.toThrow('disk full')
    expect(await api.getState()).toEqual(before)
    expect(mockStorage.files).toEqual(files)
    expect((await api.getState()).attendance[0]).toMatchObject({ morning: 'present', morningSiteId: siteId })
    await api.setAttendanceLeave([{ workerId, date, period: 'morning', leave: { payType: 'paid' } }])
    expect((await api.getState()).attendance[0]).toMatchObject({ morning: null, morningSiteId: null, morningLeave: { payType: 'paid' } })
  })
})
