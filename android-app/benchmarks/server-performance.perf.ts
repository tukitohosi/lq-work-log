import { performance } from 'node:perf_hooks'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from '../server/app.mjs'
import { MAX_DATA_BYTES } from '../server/store.mjs'
import { validateAppData } from '../server/validation.mjs'
import { buildAppDataDelta } from '../shared/app-data-delta.mjs'
import { calculateSiteStatistics } from '../src/site-statistics'
import type { AppData, AttendanceEntry, MonthlyRecord, PayAdjustment, Site, Worker } from '../src/types'

const WORKER_COUNT = 100
const SITE_COUNT = 50
const MONTH_COUNT = 60
const ADJUSTMENT_COUNT = 20_000
const HEALTH_SAMPLES = 100
const MUTATION_SAMPLES = 20
const MUTATION_WORKER_ID = 'w099'
const DAY_MS = 24 * 60 * 60 * 1_000

const LIMITS = {
  healthP95Ms: 50,
  mutationP95Ms: 300,
  mutationTotalMs: 5_000,
  mutationResponseBytes: 16 * 1024,
} as const

type BenchmarkData = AppData & {
  operationReceipts: Array<{
    operationId: string
    requestHash: string
    committedRevision: number
  }>
}

type RunningServer = Awaited<ReturnType<typeof startServer>>

interface PerformanceResult {
  dataset: {
    workers: number
    attendance: number
    monthlyRecords: number
    payAdjustments: number
    sites: number
    serializedBytes: number
  }
  generationMs: number
  cloneMs: number
  validationMs: number
  serializationMs: number
  deltaBuildMs: number
  startupMs: number
  healthP95Ms: number
  healthMaxMs: number
  mutationP95Ms: number
  mutationMaxMs: number
  mutationTotalMs: number
  mutationResponseMaxBytes: number
  annualSiteStatisticsMs: number
  annualSiteStatisticsRows: number
  annualSiteStatisticsLines: number
}

let temporaryRoot = ''
let running: RunningServer | null = null
let result: PerformanceResult

describe.sequential('L.Q记工本服务端大数据性能门禁', () => {
  beforeAll(async () => {
    const generationStartedAt = performance.now()
    let data: BenchmarkData | null = buildBenchmarkData()
    const generationMs = performance.now() - generationStartedAt

    expect(data.workers).toHaveLength(WORKER_COUNT)
    expect(data.attendance).toHaveLength(182_600)
    expect(data.monthlyRecords).toHaveLength(WORKER_COUNT * MONTH_COUNT)
    expect(data.payAdjustments).toHaveLength(ADJUSTMENT_COUNT)
    expect(data.sites).toHaveLength(SITE_COUNT)

    const cloneStartedAt = performance.now()
    let diagnosticNext: BenchmarkData | null = structuredClone(data)
    const cloneMs = performance.now() - cloneStartedAt
    const diagnosticEntry = diagnosticNext.attendance.at(-1)
    if (!diagnosticEntry) throw new Error('性能夹具缺少考勤')
    diagnosticEntry.morning = 'absent'
    diagnosticEntry.morningSiteId = null

    const validationStartedAt = performance.now()
    validateAppData(diagnosticNext, { cloneInput: false })
    const validationMs = performance.now() - validationStartedAt

    const deltaStartedAt = performance.now()
    buildAppDataDelta(data, diagnosticNext)
    const deltaBuildMs = performance.now() - deltaStartedAt
    diagnosticNext = null

    const statisticsStartedAt = performance.now()
    const annualStatistics = calculateSiteStatistics({
      data,
      period: { mode: 'year', year: '2025' },
      includeEmptySites: true,
    })
    const annualSiteStatisticsMs = performance.now() - statisticsStartedAt
    const annualSiteStatisticsRows = annualStatistics.rows.length
    const annualSiteStatisticsLines = annualStatistics.lines.length
    expect(annualStatistics.months).toHaveLength(12)
    expect(annualSiteStatisticsRows).toBeGreaterThanOrEqual(SITE_COUNT)
    expect(annualSiteStatisticsLines).toBeGreaterThan(0)

    const serializationStartedAt = performance.now()
    const serialized = `${JSON.stringify(data)}\n`
    const serializationMs = performance.now() - serializationStartedAt
    const serializedBytes = Buffer.byteLength(serialized, 'utf8')
    expect(serializedBytes).toBeLessThanOrEqual(MAX_DATA_BYTES)

    const dataset = {
      workers: data.workers.length,
      attendance: data.attendance.length,
      monthlyRecords: data.monthlyRecords.length,
      payAdjustments: data.payAdjustments.length,
      sites: data.sites.length,
      serializedBytes,
    }
    data = null

    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'lq-server-performance-'))
    const dataDir = path.join(temporaryRoot, 'data')
    const distDir = path.join(temporaryRoot, 'dist')
    await Promise.all([
      mkdir(dataDir, { recursive: true }),
      mkdir(distDir, { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(dataDir, 'records.json'), serialized, 'utf8'),
      writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>performance</title>', 'utf8'),
    ])

    const startupStartedAt = performance.now()
    running = await startServer({
      port: 0,
      endPort: 0,
      reuseExisting: false,
      rootDir: temporaryRoot,
      dataDir,
      distDir,
      now: () => new Date('2026-12-31T12:00:00.000Z'),
    })
    const startupMs = performance.now() - startupStartedAt

    result = {
      dataset,
      generationMs,
      cloneMs,
      validationMs,
      serializationMs,
      deltaBuildMs,
      startupMs,
      healthP95Ms: 0,
      healthMaxMs: 0,
      mutationP95Ms: 0,
      mutationMaxMs: 0,
      mutationTotalMs: 0,
      mutationResponseMaxBytes: 0,
      annualSiteStatisticsMs,
      annualSiteStatisticsRows,
      annualSiteStatisticsLines,
    }
  })

  afterAll(async () => {
    if (running?.server) {
      await new Promise<void>((resolve, reject) => {
        running?.server?.close((error?: Error) => error ? reject(error) : resolve())
      })
      await running.app?.store?.close?.()
    }
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('keeps failed shallow-copy mutations isolated and preserves exact last-good bytes', async () => {
    if (!running) throw new Error('性能服务未启动')
    const recordsPath = path.join(temporaryRoot, 'data', 'records.json')
    const lastGoodPath = path.join(temporaryRoot, 'data', 'records.last-good.json')
    const committedBeforeFailure = await readFile(recordsPath)

    const failed = await fetch(`${running.url}/api/attendance/batch`, {
      method: 'PUT',
      headers: mutationHeaders('performance-isolation-failure'),
      body: JSON.stringify({
        patches: [
          { workerId: MUTATION_WORKER_ID, date: '2025-12-31', morning: 'absent' },
          { workerId: 'missing-worker', date: '2025-12-31', morning: 'absent' },
        ],
      }),
    })
    expect(failed.status).toBe(404)
    expect((await readFile(recordsPath)).equals(committedBeforeFailure)).toBe(true)

    // The target was already "present" in the committed state. An empty
    // entity delta proves the first patch from the failed batch did not leak
    // through the shallow collection copy into live memory.
    const noOp = await fetch(`${running.url}/api/attendance`, {
      method: 'PUT',
      headers: mutationHeaders('performance-isolation-probe'),
      body: JSON.stringify({
        workerId: MUTATION_WORKER_ID,
        date: '2025-12-31',
        period: 'morning',
        status: 'present',
      }),
    })
    const noOpBody = await noOp.json()
    expect(noOp.status).toBe(200)
    expect(noOpBody).toMatchObject({
      kind: 'app-data-delta',
      upserts: { attendance: [], monthlyRecords: [] },
      deletes: { attendance: [], monthlyRecords: [] },
    })
    expect((await readFile(lastGoodPath)).equals(committedBeforeFailure)).toBe(true)
  })

  it('meets the health, single-cell mutation, response-size and annual-statistics gates', async () => {
    if (!running) throw new Error('性能服务未启动')

    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(`${running.url}/api/health`)
      expect(response.status).toBe(200)
      await response.arrayBuffer()
    }

    const healthDurations: number[] = []
    for (let index = 0; index < HEALTH_SAMPLES; index += 1) {
      const startedAt = performance.now()
      const response = await fetch(`${running.url}/api/health`)
      await response.arrayBuffer()
      healthDurations.push(performance.now() - startedAt)
      expect(response.status).toBe(200)
    }

    const mutationDurations: number[] = []
    const mutationResponseBytes: number[] = []
    const mutationSequenceStartedAt = performance.now()
    for (let index = 0; index < MUTATION_SAMPLES; index += 1) {
      const body = JSON.stringify({
        workerId: MUTATION_WORKER_ID,
        date: '2025-12-31',
        period: 'morning',
        status: index % 2 === 0 ? 'absent' : 'present',
      })
      const startedAt = performance.now()
      const response = await fetch(`${running.url}/api/attendance`, {
        method: 'PUT',
        headers: mutationHeaders(`performance-mutation-${index}`),
        body,
      })
      const responseBody = await response.text()
      mutationDurations.push(performance.now() - startedAt)
      mutationResponseBytes.push(Buffer.byteLength(responseBody, 'utf8'))
      expect(response.status, responseBody).toBe(200)
      expect(JSON.parse(responseBody)).toMatchObject({ kind: 'app-data-delta' })
    }

    result.healthP95Ms = percentile(healthDurations, 0.95)
    result.healthMaxMs = Math.max(...healthDurations)
    result.mutationP95Ms = percentile(mutationDurations, 0.95)
    result.mutationMaxMs = Math.max(...mutationDurations)
    result.mutationTotalMs = performance.now() - mutationSequenceStartedAt
    result.mutationResponseMaxBytes = Math.max(...mutationResponseBytes)

    process.stdout.write(`\nLQ_SERVER_PERFORMANCE_RESULT ${JSON.stringify(result, null, 2)}\n`)

    expect(result.healthP95Ms).toBeLessThanOrEqual(LIMITS.healthP95Ms)
    expect(result.mutationP95Ms).toBeLessThanOrEqual(LIMITS.mutationP95Ms)
    expect(result.mutationTotalMs).toBeLessThanOrEqual(LIMITS.mutationTotalMs)
    expect(result.mutationResponseMaxBytes).toBeLessThanOrEqual(LIMITS.mutationResponseBytes)
  })
})

function buildBenchmarkData(): BenchmarkData {
  const createdAt = '2021-01-01T00:00:00.000Z'
  const sites: Site[] = Array.from({ length: SITE_COUNT }, (_, index) => ({
    id: siteId(index),
    name: `工地${String(index + 1).padStart(2, '0')}`,
    note: '',
    createdAt,
    archivedAt: null,
  }))
  const workers: Worker[] = Array.from({ length: WORKER_COUNT }, (_, index) => ({
    id: workerId(index),
    name: `工人${String(index + 1).padStart(3, '0')}`,
    avatarDataUrl: null,
    avatarEmoji: null,
    defaultDailyRateFen: 12_000 + index,
    note: '',
    defaultSiteId: siteId(index % SITE_COUNT),
    createdAt,
    archivedAt: null,
  }))
  const dates = datesBetween('2021-01-01', '2025-12-31')
  const months = Array.from({ length: MONTH_COUNT }, (_, index) => {
    const year = 2021 + Math.floor(index / 12)
    return `${year}-${String(index % 12 + 1).padStart(2, '0')}`
  })

  const attendance: AttendanceEntry[] = []
  for (let workerIndex = 0; workerIndex < WORKER_COUNT; workerIndex += 1) {
    for (let dateIndex = 0; dateIndex < dates.length; dateIndex += 1) {
      const overtime = dateIndex % 5 === 0 ? 'half' as const : null
      attendance.push({
        workerId: workerId(workerIndex),
        date: dates[dateIndex],
        morning: 'present',
        afternoon: 'present',
        overtime,
        dayNote: '',
        morningSiteId: siteId((workerIndex + dateIndex) % SITE_COUNT),
        afternoonSiteId: siteId((workerIndex + dateIndex + 1) % SITE_COUNT),
        overtimeSiteId: overtime ? siteId((workerIndex + dateIndex + 2) % SITE_COUNT) : null,
        morningLeave: null,
        afternoonLeave: null,
        overtimeLeave: null,
      })
    }
  }

  const monthlyRecords: MonthlyRecord[] = []
  for (let workerIndex = 0; workerIndex < WORKER_COUNT; workerIndex += 1) {
    for (const month of months) {
      monthlyRecords.push({
        workerId: workerId(workerIndex),
        month,
        dailyRateFen: 12_000 + workerIndex,
        overtimePayPercent: 125,
        note: '',
        paidAt: null,
      })
    }
  }

  const payAdjustments: PayAdjustment[] = Array.from({ length: ADJUSTMENT_COUNT }, (_, index) => ({
    id: `a${String(index).padStart(5, '0')}`,
    workerId: workerId(index % WORKER_COUNT),
    month: months[index % months.length],
    date: null,
    kind: index % 4 === 0 ? 'deduction' : 'allowance',
    amountFen: 100 + index % 5_000,
    label: index % 4 === 0 ? '扣款' : '补贴',
    note: '',
    siteId: index % 5 === 0 ? null : siteId(index % SITE_COUNT),
    createdAt,
    updatedAt: createdAt,
  }))

  return {
    schemaVersion: 8,
    revision: 1,
    workers,
    attendance,
    monthlyRecords,
    payAdjustments,
    sites,
    operationReceipts: [],
    settings: {
      weekStartsOn: 1,
      currentWorkerId: workers[0].id,
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

function datesBetween(first: string, last: string): string[] {
  const dates: string[] = []
  const firstMs = Date.parse(`${first}T00:00:00.000Z`)
  const lastMs = Date.parse(`${last}T00:00:00.000Z`)
  for (let value = firstMs; value <= lastMs; value += DAY_MS) {
    dates.push(new Date(value).toISOString().slice(0, 10))
  }
  return dates
}

function workerId(index: number): string {
  return `w${String(index).padStart(3, '0')}`
}

function siteId(index: number): string {
  return `s${String(index).padStart(2, '0')}`
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function mutationHeaders(operationId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-LQ-Operation-Id': operationId,
    'X-LQ-Response-Mode': 'delta',
  }
}
