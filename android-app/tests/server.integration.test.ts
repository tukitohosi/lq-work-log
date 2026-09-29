// @vitest-environment node
/// <reference types="node" />

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error The production service is intentionally a native ESM JavaScript module.
import { startServer } from '../server/app.mjs'
import type { AppData } from '../src/types'

type Started = {
  server: Server | null
  url: string
  app: { store: unknown } | null
  reused: boolean
}

const originalDataDir = process.env.JIGONGBEN_DATA_DIR
const openServers: Server[] = []
const temporaryDirectories: string[] = []
const TEST_AVATAR =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function startIsolated(options: { corruptRecords?: string } = {}): Promise<Started & { dataDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'jigongben-test-'))
  temporaryDirectories.push(root)
  const dataDir = path.join(root, 'data')
  const distDir = path.join(root, 'dist')
  await mkdir(dataDir, { recursive: true })
  await mkdir(distDir, { recursive: true })
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><html><body>本地记工本测试页</body></html>', 'utf8')
  if (options.corruptRecords !== undefined) {
    await writeFile(path.join(dataDir, 'records.json'), options.corruptRecords, 'utf8')
  }

  process.env.JIGONGBEN_DATA_DIR = dataDir
  const started = (await startServer({
    host: '127.0.0.1',
    port: 0,
    reuseExisting: false,
    distDir,
    now: () => new Date('2026-12-31T12:00:00.000Z'),
  })) as Started
  if (!started.server) throw new Error('Expected a newly started test server')
  openServers.push(started.server)
  return { ...started, dataDir }
}

async function jsonRequest<T>(
  baseUrl: string,
  route: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: T }> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
  const body = (await response.json()) as T
  return { response, body }
}

async function mutate<T extends object>(baseUrl: string, route: string, method: string, body: T) {
  return jsonRequest<AppData>(baseUrl, route, { method, body: JSON.stringify(body) })
}

afterEach(async () => {
  while (openServers.length > 0) await closeServer(openServers.pop()!)
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
  if (originalDataDir === undefined) delete process.env.JIGONGBEN_DATA_DIR
  else process.env.JIGONGBEN_DATA_DIR = originalDataDir
})

describe.sequential('local HTTP service', () => {
  it('reuses a port only when the running service owns the same data directory', async () => {
    const started = await startIsolated()
    const firstPort = Number(new URL(started.url).port)
    const otherRoot = await mkdtemp(path.join(tmpdir(), 'jigongben-other-data-'))
    temporaryDirectories.push(otherRoot)
    const otherDataDir = path.join(otherRoot, 'data')
    const otherDistDir = path.join(otherRoot, 'dist')
    await mkdir(otherDistDir, { recursive: true })
    await writeFile(path.join(otherDistDir, 'index.html'), '<!doctype html><title>other</title>', 'utf8')

    const other = (await startServer({
      host: '127.0.0.1',
      port: firstPort,
      endPort: Math.min(firstPort + 10, 65535),
      reuseExisting: true,
      dataDir: otherDataDir,
      distDir: otherDistDir,
    })) as Started
    expect(other.reused).toBe(false)
    expect(other.server).not.toBeNull()
    expect(other.url).not.toBe(started.url)
    openServers.push(other.server!)
  })

  it('serves health/static content and supports the worker, month, attendance and archive workflow', async () => {
    const started = await startIsolated()

    const health = await jsonRequest<{ ok: boolean; revision: number; readOnly: boolean }>(
      started.url,
      '/api/health',
    )
    expect(health.response.status).toBe(200)
    expect(health.body).toMatchObject({ ok: true, revision: 0, readOnly: false })

    const reused = await startServer({
      host: '127.0.0.1',
      port: Number(new URL(started.url).port),
      endPort: Number(new URL(started.url).port),
      reuseExisting: true,
    })
    expect(reused).toMatchObject({ reused: true, server: null, url: started.url })

    const page = await fetch(`${started.url}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('content-security-policy')).toContain("img-src 'self' data: blob:")
    expect(await page.text()).toContain('本地记工本测试页')

    const added = await mutate(started.url, '/api/workers', 'POST', {
      name: ' 李权 ',
      defaultDailyRateFen: 30_000,
      note: '木工',
    })
    expect(added.response.status).toBe(200)
    expect(added.body.revision).toBe(1)
    expect(added.body.workers[0]).toMatchObject({
      name: '李权',
      avatarDataUrl: null,
      avatarEmoji: null,
      defaultDailyRateFen: 30_000,
      note: '木工',
    })
    expect(added.body.settings.currentWorkerId).toBe(added.body.workers[0].id)
    const workerId = added.body.workers[0].id

    const renamed = await mutate(started.url, `/api/workers/${encodeURIComponent(workerId)}`, 'PATCH', {
      name: '李权师傅',
      avatarDataUrl: TEST_AVATAR,
      avatarEmoji: null,
      defaultDailyRateFen: 32_000,
      note: '带班木工',
    })
    expect(renamed.response.status).toBe(200)
    expect(renamed.body.workers[0]).toMatchObject({
      name: '李权师傅',
      avatarDataUrl: TEST_AVATAR,
      defaultDailyRateFen: 32_000,
      note: '带班木工',
    })

    const monthly = await mutate(started.url, '/api/monthly-records', 'PUT', {
      workerId,
      month: '2026-08',
      dailyRateFen: 32_550,
      overtimePayPercent: 100,
      note: '一期工程',
    })
    expect(monthly.response.status).toBe(200)
    expect(monthly.body.monthlyRecords).toContainEqual({
      workerId,
      month: '2026-08',
      dailyRateFen: 32_550,
      overtimePayPercent: 100,
      note: '一期工程',
      paidAt: null,
    })

    const attendance = await mutate(started.url, '/api/attendance', 'PUT', {
      workerId,
      date: '2026-08-08',
      period: 'morning',
      status: 'present',
    })
    expect(attendance.response.status).toBe(200)
    expect(attendance.body.attendance).toContainEqual(expect.objectContaining({
      workerId,
      date: '2026-08-08',
      morning: 'present',
      afternoon: null,
      overtime: null,
      dayNote: '',
      morningSiteId: null,
      afternoonSiteId: null,
      overtimeSiteId: null,
    }))

    const overtime = await mutate(started.url, '/api/attendance', 'PUT', {
      workerId,
      date: '2026-08-08',
      period: 'overtime',
      status: 'full',
    })
    expect(overtime.response.status).toBe(200)
    expect(overtime.body.attendance[0]).toMatchObject({ overtime: 'full' })

    const archived = await mutate(
      started.url,
      `/api/workers/${encodeURIComponent(workerId)}`,
      'PATCH',
      { archived: true },
    )
    expect(archived.response.status).toBe(200)
    expect(archived.body.workers[0].archivedAt).toEqual(expect.any(String))
    expect(archived.body.settings.currentWorkerId).toBeNull()

    const restored = await mutate(
      started.url,
      `/api/workers/${encodeURIComponent(workerId)}`,
      'PATCH',
      { archived: false },
    )
    expect(restored.response.status).toBe(200)
    expect(restored.body.workers[0].archivedAt).toBeNull()
    expect(restored.body.settings.currentWorkerId).toBe(workerId)

    const persisted = JSON.parse(await readFile(path.join(started.dataDir, 'records.json'), 'utf8')) as AppData
    expect(persisted).toEqual(restored.body)
    expect(await readFile(path.join(started.dataDir, 'records.last-good.json'), 'utf8')).toContain('李权师傅')
  })

  it('serializes concurrent writes without losing cells and locks inherited monthly wages', async () => {
    const started = await startIsolated()
    const added = await mutate(started.url, '/api/workers', 'POST', {
      name: '王强',
      defaultDailyRateFen: 30_000,
      note: '',
    })
    const workerId = added.body.workers[0].id
    await mutate(started.url, '/api/monthly-records', 'PUT', {
      workerId,
      month: '2026-07',
      dailyRateFen: 32_550,
    })

    const writes = Array.from({ length: 16 }, (_, index) =>
      mutate(started.url, '/api/attendance', 'PUT', {
        workerId,
        date: `2026-08-${String(index + 1).padStart(2, '0')}`,
        period: index % 2 === 0 ? 'morning' : 'afternoon',
        status: 'present',
      }),
    )
    const results = await Promise.all(writes)
    const revisions = results.map((result) => result.body.revision).sort((a, b) => a - b)
    expect(revisions).toEqual(Array.from({ length: 16 }, (_, index) => index + 3))

    const stateAfterWrites = await jsonRequest<AppData>(started.url, '/api/state')
    expect(stateAfterWrites.body.attendance).toHaveLength(16)
    expect(new Set(stateAfterWrites.body.attendance.map((entry) => entry.date))).toHaveProperty('size', 16)
    expect(stateAfterWrites.body.monthlyRecords).toContainEqual({
      workerId,
      month: '2026-08',
      dailyRateFen: 32_550,
      overtimePayPercent: 100,
      note: '',
      paidAt: null,
    })

    await mutate(started.url, `/api/workers/${encodeURIComponent(workerId)}`, 'PATCH', {
      defaultDailyRateFen: 40_000,
    })
    await mutate(started.url, '/api/attendance', 'PUT', {
      workerId,
      date: '2026-09-01',
      period: 'morning',
      status: 'present',
    })
    const finalState = await jsonRequest<AppData>(started.url, '/api/state')
    expect(finalState.body.monthlyRecords).toEqual(
      expect.arrayContaining([
        { workerId, month: '2026-07', dailyRateFen: 32_550, overtimePayPercent: 100, note: '', paidAt: null },
        { workerId, month: '2026-08', dailyRateFen: 32_550, overtimePayPercent: 100, note: '', paidAt: null },
        { workerId, month: '2026-09', dailyRateFen: 32_550, overtimePayPercent: 100, note: '', paidAt: null },
      ]),
    )
  })

  it('exports a complete JSON backup and restores it as a revisioned whole-database replacement', async () => {
    const started = await startIsolated()
    const first = await mutate(started.url, '/api/workers', 'POST', {
      name: '陈明',
      defaultDailyRateFen: 25_000,
      note: '',
    })
    const firstWorkerId = first.body.workers[0].id
    await mutate(started.url, '/api/attendance', 'PUT', {
      workerId: firstWorkerId,
      date: '2026-08-08',
      period: 'afternoon',
      status: 'absent',
    })

    const backup = await jsonRequest<AppData>(started.url, '/api/backup')
    expect(backup.response.status).toBe(200)
    expect(backup.response.headers.get('content-disposition')).toContain("filename*=UTF-8''")
    expect(backup.body.workers.map((worker) => worker.name)).toEqual(['陈明'])

    const invalidRestore = await mutate(started.url, '/api/restore', 'POST', {
      data: { ...backup.body, schemaVersion: 999 },
    })
    expect(invalidRestore.response.status).toBe(400)
    expect((invalidRestore.body as unknown as { error: { code: string } }).error.code).toBe(
      'UNSUPPORTED_SCHEMA',
    )
    const unchanged = await jsonRequest<AppData>(started.url, '/api/state')
    expect(unchanged.body).toEqual(backup.body)

    await mutate(started.url, '/api/workers', 'POST', {
      name: '临时工',
      defaultDailyRateFen: 10_000,
      note: '',
    })
    const restored = await mutate(started.url, '/api/restore', 'POST', { data: backup.body })

    expect(restored.response.status).toBe(200)
    expect(restored.body.revision).toBeGreaterThan(backup.body.revision)
    expect(restored.body.workers.map((worker) => worker.name)).toEqual(['陈明'])
    expect(restored.body.attendance).toEqual(backup.body.attendance)
    const backupNames = await readdir(path.join(started.dataDir, 'backups'))
    expect(backupNames.some((name) => name.startsWith('pre-restore-') && name.endsWith('.json'))).toBe(true)
  })

  it('protects corrupt data in read-only mode but allows a validated recovery import', async () => {
    const started = await startIsolated({ corruptRecords: '{ this is not JSON' })

    const health = await jsonRequest<{ ok: boolean; readOnly: boolean; error: { code: string } }>(
      started.url,
      '/api/health',
    )
    expect(health.response.status).toBe(503)
    expect(health.body).toMatchObject({ ok: false, readOnly: true, error: { code: 'DATA_CORRUPTED' } })

    const state = await jsonRequest<{ error: { code: string }; readOnly: boolean }>(
      started.url,
      '/api/state',
    )
    expect(state.response.status).toBe(503)
    expect(state.body).toMatchObject({ error: { code: 'DATA_CORRUPTED' }, readOnly: true })

    const rejectedWrite = await mutate(started.url, '/api/workers', 'POST', {
      name: '不应写入',
      defaultDailyRateFen: 1,
      note: '',
    })
    expect(rejectedWrite.response.status).toBe(503)
    expect((rejectedWrite.body as unknown as { error: { code: string } }).error.code).toBe('READ_ONLY')
    expect(await readFile(path.join(started.dataDir, 'records.json'), 'utf8')).toBe('{ this is not JSON')

    const validEmptyBackup = {
      schemaVersion: 1,
      revision: 0,
      workers: [],
      attendance: [],
      monthlyRecords: [],
      settings: {
        weekStartsOn: 6,
        currentWorkerId: null,
        theme: 'light',
        sidebarCollapsed: false,
        lastBackupExportAt: null,
        lastBackupReminderAt: null,
      },
      payAdjustments: [],
      sites: [],
    }
    const recovered = await mutate(started.url, '/api/restore', 'POST', { data: validEmptyBackup })
    expect(recovered.response.status).toBe(200)
    expect(recovered.body).toMatchObject({
      schemaVersion: 8,
      revision: 1,
      workers: [],
      settings: { defaultOvertimePayPercent: 100 },
    })
    const recoveredHealth = await jsonRequest<{ ok: boolean; readOnly: boolean }>(
      started.url,
      '/api/health',
    )
    expect(recoveredHealth.response.status).toBe(200)
    expect(recoveredHealth.body).toMatchObject({ ok: true, readOnly: false })
    const backupNames = await readdir(path.join(started.dataDir, 'backups'))
    expect(backupNames.some((name) => name.startsWith('pre-restore-corrupt-') && name.endsWith('.bin'))).toBe(true)
  })
})
