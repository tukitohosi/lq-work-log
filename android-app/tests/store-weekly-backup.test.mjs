// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DataStore,
  MAX_DATA_BYTES,
  MAX_WEEKLY_BACKUPS,
  WEEKLY_BACKUP_INTERVAL_MS,
  WEEKLY_BACKUP_PREFIX,
  appDataSizeBytes,
  assertAppDataSize,
} from '../server/store.mjs'
import { emptyAppData } from '../server/validation.mjs'

const temporaryRoots = []

async function fixture(initialNow = new Date('2026-08-14T08:00:00.000Z')) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lq-weekly-backup-test-'))
  temporaryRoots.push(root)
  let now = initialNow
  const store = await new DataStore({
    dataDir: path.join(root, 'app-data'),
    now: () => now,
  }).init()
  return {
    root,
    store,
    backupDir: path.join(root, 'Documents', 'L.Q记工本备份'),
    setNow(value) {
      now = value
    },
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('weekly external backups', () => {
  it('writes a due backup atomically and persists the successful timestamp', async () => {
    const { store, backupDir } = await fixture()

    const result = await store.createWeeklyBackupIfDue({ backupDir })

    expect(result).toMatchObject({ created: true, revision: 1 })
    expect(result.filename).toMatch(/^L\.Q记工本每周备份-.+-r1\.json$/)
    const files = await readdir(backupDir)
    expect(files).toEqual([result.filename])
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false)
    const backup = JSON.parse(await readFile(path.join(backupDir, result.filename), 'utf8'))
    expect(backup).toEqual(store.getState())
    expect(backup.settings.lastWeeklyBackupAt).toBe('2026-08-14T08:00:00.000Z')

    const persisted = JSON.parse(await readFile(store.recordsPath, 'utf8'))
    expect(persisted.settings.lastWeeklyBackupAt).toBe(backup.settings.lastWeeklyBackupAt)
  })

  it('waits seven days, honors the setting, and lets an explicit force bypass it', async () => {
    const start = new Date('2026-08-14T08:00:00.000Z')
    const candidate = await fixture(start)
    await candidate.store.createWeeklyBackupIfDue({ backupDir: candidate.backupDir })

    candidate.setNow(new Date(start.getTime() + WEEKLY_BACKUP_INTERVAL_MS - 1))
    await expect(
      candidate.store.createWeeklyBackupIfDue({ backupDir: candidate.backupDir }),
    ).resolves.toMatchObject({ created: false, reason: 'not-due' })

    await candidate.store.mutate((data) => {
      data.settings.weeklyAutoBackupEnabled = false
    })
    candidate.setNow(new Date(start.getTime() + WEEKLY_BACKUP_INTERVAL_MS))
    await expect(
      candidate.store.createWeeklyBackupIfDue({ backupDir: candidate.backupDir }),
    ).resolves.toEqual({ created: false, reason: 'disabled' })

    const forced = await candidate.store.createWeeklyBackupIfDue({
      backupDir: candidate.backupDir,
      force: true,
    })
    expect(forced.created).toBe(true)
    expect(candidate.store.getState().settings.lastWeeklyBackupAt).toBe(
      new Date(start.getTime() + WEEKLY_BACKUP_INTERVAL_MS).toISOString(),
    )
  })

  it('does not advance the successful timestamp when the external write fails', async () => {
    const candidate = await fixture()
    const blockedTarget = path.join(candidate.root, 'not-a-directory')
    await writeFile(blockedTarget, 'occupied by a file', 'utf8')

    await expect(
      candidate.store.createWeeklyBackupIfDue({ backupDir: blockedTarget }),
    ).rejects.toThrow()

    expect(candidate.store.getState()).toMatchObject({
      revision: 0,
      settings: { lastWeeklyBackupAt: null },
    })
  })

  it('retains only the newest twelve fixed-prefix files and preserves unrelated files', async () => {
    const start = new Date('2026-08-14T08:00:00.000Z')
    const candidate = await fixture(start)
    const created = []
    for (let index = 0; index < MAX_WEEKLY_BACKUPS + 2; index += 1) {
      candidate.setNow(new Date(start.getTime() + index * 60_000))
      created.push(
        await candidate.store.createWeeklyBackupIfDue({
          backupDir: candidate.backupDir,
          force: true,
        }),
      )
      if (index === 0) {
        await writeFile(path.join(candidate.backupDir, '手动备份.json'), '{}\n', 'utf8')
      }
    }

    const names = await readdir(candidate.backupDir)
    const weeklyNames = names.filter(
      (name) => name.startsWith(WEEKLY_BACKUP_PREFIX) && name.endsWith('.json'),
    )
    expect(weeklyNames).toHaveLength(MAX_WEEKLY_BACKUPS)
    expect(weeklyNames).not.toContain(created[0].filename)
    expect(weeklyNames).not.toContain(created[1].filename)
    expect(weeklyNames).toContain(created.at(-1).filename)
    expect(names).toContain('手动备份.json')
  })
})

describe('managed internal backup retention', () => {
  it('prunes only generated daily/pre-restore files and preserves manual or upgrade backups', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lq-internal-backup-test-'))
    temporaryRoots.push(root)
    let now = new Date('2026-08-14T08:00:00.000Z')
    const store = await new DataStore({
      dataDir: path.join(root, 'app-data'),
      maxBackups: 1,
      now: () => now,
    }).init()
    await writeFile(path.join(store.backupsDir, 'pre-upgrade-v6.json'), '{}\n', 'utf8')
    await writeFile(path.join(store.backupsDir, 'daily-manual-notes.json'), '{}\n', 'utf8')

    await store.mutate((data) => {
      data.settings.theme = 'dark'
    })
    now = new Date('2026-08-15T08:00:00.000Z')
    await store.mutate((data) => {
      data.settings.theme = 'light'
    })

    const names = await readdir(store.backupsDir)
    const managedDaily = names.filter((name) => /^daily-\d{4}-\d{2}-\d{2}-\d{9}-r\d+\.json$/.test(name))
    expect(managedDaily).toHaveLength(1)
    expect(names).toContain('pre-upgrade-v6.json')
    expect(names).toContain('daily-manual-notes.json')
  })

  it('retains daily and pre-restore backups with independent quotas', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lq-separated-backup-test-'))
    temporaryRoots.push(root)
    let now = new Date('2026-08-14T08:00:00.000Z')
    const store = await new DataStore({
      dataDir: path.join(root, 'app-data'),
      maxDailyBackups: 2,
      maxPreRestoreBackups: 1,
      now: () => now,
    }).init()

    await store.mutate((data) => { data.settings.theme = 'dark' })
    now = new Date('2026-08-15T08:00:00.000Z')
    await store.mutate((data) => { data.settings.theme = 'light' })
    now = new Date('2026-08-16T08:00:00.000Z')
    await store.mutate((data) => { data.settings.theme = 'dark' })

    const restoreCandidate = store.getState()
    now = new Date('2026-08-16T09:00:00.000Z')
    await store.restore(restoreCandidate)
    now = new Date('2026-08-16T10:00:00.000Z')
    await store.restore(restoreCandidate)

    const names = await readdir(store.backupsDir)
    const daily = names.filter((name) => /^daily-.*\.json$/.test(name))
    const preRestore = names.filter((name) => /^pre-restore-.*\.json$/.test(name))
    expect(daily).toHaveLength(2)
    expect(preRestore).toHaveLength(1)
  })
})

describe('data directory locking', () => {
  it('rejects a second live writer and permits reopening after the owner closes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lq-data-lock-test-'))
    temporaryRoots.push(root)
    const dataDir = path.join(root, 'app-data')
    const first = await new DataStore({ dataDir }).init()
    await expect(new DataStore({ dataDir }).init()).rejects.toMatchObject({
      code: 'DATA_DIR_IN_USE',
    })
    await first.close()
    const reopened = await new DataStore({ dataDir }).init()
    expect(reopened.getState().revision).toBe(0)
    await reopened.close()
  })

  it('atomically reclaims a lock only after its recorded process is confirmed dead', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lq-stale-lock-test-'))
    temporaryRoots.push(root)
    const dataDir = path.join(root, 'app-data')
    await mkdir(dataDir, { recursive: true })
    const lockPath = path.join(dataDir, '.jigongben.lock')
    await writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-owner-token',
      dataDirFingerprint: 'stale',
      heartbeatAt: '2000-01-01T00:00:00.000Z',
    }), 'utf8')

    const store = await new DataStore({ dataDir }).init()
    const owner = JSON.parse(await readFile(lockPath, 'utf8'))
    expect(owner.pid).toBe(process.pid)
    expect(owner.token).not.toBe('dead-owner-token')
    expect((await readdir(dataDir)).some((name) => name.includes('.stale.'))).toBe(false)
    await store.close()
  })
})

describe('application data size boundary', () => {
  it('counts the exact persisted UTF-8 bytes and accepts exactly the configured limit', () => {
    const data = emptyAppData()
    data.workers.push({
      id: 'utf8-worker',
      name: '中文工人',
      avatarDataUrl: null,
      avatarEmoji: '👷',
      defaultDailyRateFen: 30_000,
      note: '测试 UTF-8 字节',
      defaultSiteId: null,
      createdAt: '2026-08-14T00:00:00.000Z',
      archivedAt: null,
    })
    const serialized = `${JSON.stringify(data)}\n`
    const exactBytes = Buffer.byteLength(serialized, 'utf8')
    expect(appDataSizeBytes(data)).toBe(exactBytes)
    expect(assertAppDataSize(data, exactBytes)).toBe(exactBytes)
    expect(() => assertAppDataSize(data, exactBytes - 1)).toThrowError(
      expect.objectContaining({
        status: 413,
        code: 'DATA_LIMIT_REACHED',
        details: { sizeBytes: exactBytes, limitBytes: exactBytes - 1 },
      }),
    )
    expect(MAX_DATA_BYTES).toBe(64 * 1024 * 1024)
  })

  it('rejects an oversized mutation before backups or records change', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lq-size-zero-write-test-'))
    temporaryRoots.push(root)
    const dataDir = path.join(root, 'app-data')
    const baseline = emptyAppData()
    baseline.revision = 1
    baseline.settings.theme = 'dark'
    const worker = {
      id: 'oversized-worker',
      name: '边界工人',
      avatarDataUrl: null,
      avatarEmoji: null,
      defaultDailyRateFen: 30_000,
      note: '界'.repeat(1_000),
      defaultSiteId: null,
      createdAt: '2026-08-14T00:00:00.000Z',
      archivedAt: null,
    }
    const oversized = structuredClone(baseline)
    oversized.revision = 2
    oversized.workers.push(worker)
    const scaledLimit = appDataSizeBytes(oversized) - 1
    const store = await new DataStore({ dataDir, maxDataBytes: scaledLimit }).init()
    await store.mutate((data) => { data.settings.theme = 'dark' })
    const stateBefore = store.getState()
    const recordsBefore = await readFile(store.recordsPath)
    const backupsBefore = await readdir(store.backupsDir)

    await expect(store.mutate((data) => { data.workers.push(worker) })).rejects.toMatchObject({
      status: 413,
      code: 'DATA_LIMIT_REACHED',
      details: { limitBytes: scaledLimit },
    })

    expect(store.getState()).toEqual(stateBefore)
    expect(await readFile(store.recordsPath)).toEqual(recordsBefore)
    expect(await readdir(store.backupsDir)).toEqual(backupsBefore)
    expect((await readdir(dataDir)).some((name) => name.endsWith('.tmp'))).toBe(false)
    await store.close()
  })
})
