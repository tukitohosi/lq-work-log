import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { validateAppData } from '../server/validation.mjs'
import { shareAndroidFile } from './android-share'
import { ATTENDANCE_PATCH_FIELDS, applyAttendancePatch, blankAttendance, periodLeaveField, periodSiteField } from './attendance'
import { isValidIsoDate } from './date'
import type { AppMutationResponse } from './mutation-response'
import type {
  AppData,
  AttendanceEntry,
  AttendancePatch,
  AttendancePeriod,
  AttendanceValue,
  HistoryRevertTarget,
  InternalBackupInspection,
  InternalBackupMeta,
  OrdinaryLeave,
  OvertimeLeave,
  PayAdjustment,
  PayAdjustmentKind,
  RestoreInspection,
  Site,
  Theme,
  WeekStartsOn,
  Worker,
} from './types'

const DATA_DIRECTORY = 'lq-jigongben'
const RECORDS_PATH = `${DATA_DIRECTORY}/records.json`
const PENDING_PATH = `${DATA_DIRECTORY}/records.pending.json`
const LAST_GOOD_PATH = `${DATA_DIRECTORY}/records.last-good.json`
const BACKUPS_DIRECTORY = `${DATA_DIRECTORY}/backups`
const DATA_LIMIT_BYTES = 64 * 1024 * 1024
const DAILY_BACKUP_LIMIT = 14
const PRE_RESTORE_BACKUP_LIMIT = 10

type MutableResult = boolean | void
type Mutation = (data: AppData) => MutableResult

let cachedState: AppData | null = null
let loadPromise: Promise<AppData> | null = null
let writeQueue: Promise<void> = Promise.resolve()

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isMissingFile(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not exist|does not exist|ENOENT|File does not exist/i.test(message)
}

function timestampToken(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function backupDocument(data: AppData): AppData & { operationReceipts: [] } {
  return { ...clone(data), operationReceipts: [] }
}

function validateAndroidData(value: unknown): AppData {
  const candidate = clone(value) as unknown
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const record = candidate as Record<string, unknown>
    if (record.schemaVersion === 8 && !Object.hasOwn(record, 'operationReceipts')) record.operationReceipts = []
  }
  const validated = validateAppData(candidate) as AppData & { operationReceipts?: unknown[] }
  const { operationReceipts: _operationReceipts, ...appData } = validated
  return appData as AppData
}

function isInvalidDataError(error: unknown): boolean {
  return error instanceof SyntaxError || (error instanceof Error && error.name === 'ApiError')
}

function emptyData(): AppData {
  return {
    schemaVersion: 8,
    revision: 0,
    workers: [],
    attendance: [],
    monthlyRecords: [],
    payAdjustments: [],
    sites: [],
    settings: {
      weekStartsOn: 1,
      currentWorkerId: null,
      theme: 'light',
      sidebarCollapsed: false,
      lastBackupExportAt: null,
      lastBackupReminderAt: null,
      weeklyAutoBackupEnabled: false,
      lastWeeklyBackupAt: null,
      defaultOvertimePayPercent: 100,
    },
  }
}

async function ensureDataDirectories(): Promise<void> {
  await Filesystem.mkdir({ path: DATA_DIRECTORY, directory: Directory.Data, recursive: true }).catch(() => undefined)
  await Filesystem.mkdir({ path: BACKUPS_DIRECTORY, directory: Directory.Data, recursive: true }).catch(() => undefined)
}

async function readText(path: string): Promise<string> {
  const result = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 })
  if (typeof result.data !== 'string') throw new Error('Android 本地数据编码无效')
  return result.data
}

async function readValidated(path: string): Promise<{ data: AppData; text: string }> {
  const text = await readText(path)
  return { data: validateAndroidData(JSON.parse(text)), text }
}

async function writeVerified(path: string, text: string): Promise<void> {
  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: text,
    encoding: Encoding.UTF8,
    recursive: true,
  })
  if (await readText(path) !== text) throw new Error('Android 本地文件写入后校验不一致')
}

async function deleteIfPresent(path: string): Promise<void> {
  await Filesystem.deleteFile({ path, directory: Directory.Data }).catch((error) => {
    if (!isMissingFile(error)) throw error
  })
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path, directory: Directory.Data })
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

async function ensureDailyBackup(previousText: string): Promise<void> {
  const path = `${BACKUPS_DIRECTORY}/daily-${new Date().toISOString().slice(0, 10)}.json`
  if (!(await fileExists(path))) await writeVerified(path, previousText)
}

async function pruneBackups(prefix: string, limit: number): Promise<void> {
  const result = await Filesystem.readdir({ path: BACKUPS_DIRECTORY, directory: Directory.Data })
  const names = result.files
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
    .reverse()
  await Promise.all(names.slice(limit).map((name) => deleteIfPresent(`${BACKUPS_DIRECTORY}/${name}`)))
}

async function persist(data: AppData, options: { preservePrevious?: boolean } = {}): Promise<void> {
  const validated = validateAndroidData(backupDocument(data))
  const serialized = JSON.stringify(backupDocument(validated))
  const size = new TextEncoder().encode(serialized).byteLength
  if (size > DATA_LIMIT_BYTES) throw new Error('Android 数据超过 64 MiB 上限')
  await ensureDataDirectories()
  await writeVerified(PENDING_PATH, serialized)

  if (options.preservePrevious !== false) {
    try {
      const previous = await readValidated(RECORDS_PATH)
      await writeVerified(LAST_GOOD_PATH, previous.text)
      await ensureDailyBackup(previous.text)
      await pruneBackups('daily-', DAILY_BACKUP_LIMIT)
    } catch (error) {
      if (!isMissingFile(error) && !isInvalidDataError(error)) throw error
      // A missing or corrupt main file must not replace an already valid last-good backup.
    }
  }

  await writeVerified(RECORDS_PATH, serialized)
  await readValidated(RECORDS_PATH)
  await deleteIfPresent(PENDING_PATH)
}

async function load(): Promise<AppData> {
  if (cachedState) return cachedState
  loadPromise ??= (async () => {
    await ensureDataDirectories()
    let foundFile = false
    const failures: string[] = []
    for (const candidate of [RECORDS_PATH, PENDING_PATH, LAST_GOOD_PATH]) {
      try {
        const loaded = await readValidated(candidate)
        foundFile = true
        cachedState = loaded.data
        if (candidate !== RECORDS_PATH) await persist(cachedState, { preservePrevious: false })
        return cachedState
      } catch (error) {
        if (isMissingFile(error)) continue
        foundFile = true
        failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (foundFile) throw new Error(`Android 本地数据校验失败。请从内部备份恢复。${failures.length ? `\n${failures.join('\n')}` : ''}`)
    cachedState = emptyData()
    await persist(cachedState, { preservePrevious: false })
    return cachedState
  })().catch((error) => {
    loadPromise = null
    throw error
  })
  return loadPromise
}

async function mutate(mutator: Mutation): Promise<AppMutationResponse> {
  let resolveResult!: (value: AppData) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<AppData>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    try {
      const current = await load()
      const next = clone(current)
      const changed = mutator(next) !== false
      if (changed) next.revision = current.revision + 1
      await persist(next)
      cachedState = next
      resolveResult(clone(next))
    } catch (error) {
      rejectResult(error)
    }
  })
  return result
}

function newId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function requireWorker(data: AppData, workerId: string): Worker {
  const worker = data.workers.find((candidate) => candidate.id === workerId)
  if (!worker) throw new Error('没有找到该工人')
  return worker
}

function requireSite(data: AppData, siteId: string): Site {
  const site = data.sites.find((candidate) => candidate.id === siteId)
  if (!site) throw new Error('没有找到该工地')
  return site
}

function applyPatch(data: AppData, patch: AttendancePatch, allowLeaveChange = false): void {
  const worker = requireWorker(data, patch.workerId)
  if (worker.archivedAt !== null) throw new Error('已归档工人不能修改记工，请先恢复')
  if (!isValidIsoDate(patch.date)) throw new Error('记工日期无效')
  const allowedFields: readonly string[] = ['workerId', 'date', ...ATTENDANCE_PATCH_FIELDS]
  if (Object.keys(patch).some(field => !allowedFields.includes(field))) throw new Error('考勤补丁包含未知字段')
  if (!ATTENDANCE_PATCH_FIELDS.some(field => Object.hasOwn(patch, field))) throw new Error('考勤补丁至少包含一个要修改的字段')
  const current = data.attendance.find(entry => entry.workerId === patch.workerId && entry.date === patch.date)
    ?? blankAttendance(patch.workerId, patch.date)
  for (const period of ['morning', 'afternoon', 'overtime'] as const) {
    const siteField = periodSiteField(period)
    const leaveField = periodLeaveField(period)
    if (Object.hasOwn(patch, period)) {
      const values = period === 'overtime' ? [null, 'half', 'full'] : [null, 'present', 'absent']
      if (!values.includes(patch[period] as string | null)) throw new Error(period === 'overtime' ? '加班状态只能是 half、full 或 null' : '考勤状态只能是 present、absent 或 null')
    }
    if (!allowLeaveChange) {
      const requestedLeave = patch[leaveField]
      const originalLeave = current[leaveField] ?? null
      const leaveChanged = requestedLeave !== undefined && (
        requestedLeave?.payType !== originalLeave?.payType ||
        (requestedLeave && 'units' in requestedLeave ? requestedLeave.units : null) !==
        (originalLeave && 'units' in originalLeave ? originalLeave.units : null)
      )
      const statusChanged = patch[period] !== undefined && patch[period] !== current[period]
      const siteChanged = patch[siteField] !== undefined && patch[siteField] !== current[siteField]
      if (leaveChanged || (originalLeave && (statusChanged || siteChanged))) {
        throw new Error('请假时段已锁定，请先使用“取消请假”')
      }
    }
    const siteId = patch[siteField]
    if (siteId !== undefined && siteId !== null) {
      const status = patch[period] === undefined ? current[period] : patch[period]
      const working = period === 'overtime' ? status === 'half' || status === 'full' : status === 'present'
      if (!working) throw new Error('只有出工或加班状态才能指定工地')
      // As on the server, archived sites can remain historical references and be restored by undo.
      requireSite(data, siteId)
    }
  }
  applyAttendancePatch(data, patch)
}

function ensureMonthlyRecord(data: AppData, workerId: string, month: string) {
  const worker = requireWorker(data, workerId)
  let record = data.monthlyRecords.find((candidate) => candidate.workerId === workerId && candidate.month === month)
  if (!record) {
    record = {
      workerId,
      month,
      dailyRateFen: worker.defaultDailyRateFen,
      overtimePayPercent: data.settings.defaultOvertimePayPercent,
      note: '',
      paidAt: null,
    }
    data.monthlyRecords.push(record)
  }
  return record
}

function restoreInspection(data: AppData): RestoreInspection {
  return {
    data: clone(data),
    schemaVersion: data.schemaVersion,
    workerCount: data.workers.length,
    archivedWorkerCount: data.workers.filter((worker) => worker.archivedAt !== null).length,
    attendanceCount: data.attendance.length,
    monthCount: data.monthlyRecords.length,
    adjustmentCount: data.payAdjustments.length,
    siteCount: data.sites.length,
    workerNames: data.workers.map((worker) => worker.name),
  }
}

type AndroidBackupDescriptor = {
  id: string
  path: string
  filename: string
  kind: InternalBackupMeta['kind']
}

async function backupDescriptors(): Promise<AndroidBackupDescriptor[]> {
  await ensureDataDirectories()
  const items: AndroidBackupDescriptor[] = []
  if (await fileExists(LAST_GOOD_PATH)) {
    items.push({
      id: 'android:last-good',
      path: LAST_GOOD_PATH,
      filename: 'records.last-good.json',
      kind: 'last-good',
    })
  }
  const directory = await Filesystem.readdir({ path: BACKUPS_DIRECTORY, directory: Directory.Data })
  for (const entry of directory.files) {
    if (!/^(daily-\d{4}-\d{2}-\d{2}|pre-restore-\d{8}T\d{6}Z)\.json$/.test(entry.name)) continue
    items.push({
      id: `android:backup:${entry.name}`,
      path: `${BACKUPS_DIRECTORY}/${entry.name}`,
      filename: entry.name,
      kind: entry.name.startsWith('daily-') ? 'daily' : 'pre-restore',
    })
  }
  return items
}

async function backupMetadata(descriptor: AndroidBackupDescriptor): Promise<InternalBackupMeta> {
  const stat = await Filesystem.stat({ path: descriptor.path, directory: Directory.Data })
  const timestamp = typeof stat.mtime === 'number' ? stat.mtime : Date.now()
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    filename: descriptor.filename,
    modifiedAt: new Date(timestamp).toISOString(),
    size: typeof stat.size === 'number' ? stat.size : new TextEncoder().encode(await readText(descriptor.path)).byteLength,
  }
}

async function resolveBackup(id: string): Promise<AndroidBackupDescriptor> {
  const descriptor = (await backupDescriptors()).find((item) => item.id === id)
  if (!descriptor) throw new Error('没有找到该 Android 内部备份')
  return descriptor
}

async function createPreRestoreBackup(data: AppData): Promise<void> {
  const path = `${BACKUPS_DIRECTORY}/pre-restore-${timestampToken()}.json`
  await writeVerified(path, JSON.stringify(backupDocument(validateAndroidData(backupDocument(data)))))
  await pruneBackups('pre-restore-', PRE_RESTORE_BACKUP_LIMIT)
}

export const androidPocApi = {
  async getHealth() {
    const data = await load()
    const dataSizeBytes = new TextEncoder().encode(JSON.stringify(data)).byteLength
    return {
      ok: true,
      revision: data.revision,
      readOnly: false,
      dataSizeBytes,
      dataLimitBytes: DATA_LIMIT_BYTES,
      dataSizeWarning: dataSizeBytes >= DATA_LIMIT_BYTES * 0.8,
    }
  },

  async getState() {
    return clone(await load())
  },

  addWorker(payload: {
    name: string
    avatarDataUrl: string | null
    avatarEmoji?: string | null
    defaultDailyRateFen: number
    note: string
    defaultSiteId?: string | null
  }, _operationId?: string) {
    return mutate((data) => {
      const now = new Date().toISOString()
      const worker: Worker = {
        id: newId('worker'),
        name: payload.name.trim(),
        avatarDataUrl: payload.avatarDataUrl,
        avatarEmoji: payload.avatarEmoji ?? null,
        defaultDailyRateFen: payload.defaultDailyRateFen,
        note: payload.note,
        defaultSiteId: payload.defaultSiteId ?? null,
        createdAt: now,
        archivedAt: null,
      }
      data.workers.push(worker)
      data.settings.currentWorkerId ??= worker.id
    })
  },

  updateWorker(id: string, payload: Partial<Pick<Worker,
    'name' | 'avatarDataUrl' | 'avatarEmoji' | 'defaultDailyRateFen' | 'note' | 'defaultSiteId'
  >> & { archived?: boolean }, _operationId?: string) {
    return mutate((data) => {
      const worker = requireWorker(data, id)
      if (payload.name !== undefined) worker.name = payload.name.trim()
      if (payload.avatarDataUrl !== undefined) worker.avatarDataUrl = payload.avatarDataUrl
      if (payload.avatarEmoji !== undefined) worker.avatarEmoji = payload.avatarEmoji
      if (payload.defaultDailyRateFen !== undefined) worker.defaultDailyRateFen = payload.defaultDailyRateFen
      if (payload.note !== undefined) worker.note = payload.note
      if (payload.defaultSiteId !== undefined) worker.defaultSiteId = payload.defaultSiteId
      if (payload.archived !== undefined) worker.archivedAt = payload.archived ? worker.archivedAt ?? new Date().toISOString() : null
    })
  },

  setAttendance(payload: {
    workerId: string
    date: string
    period: AttendancePeriod
    status: AttendanceValue
  }, _operationId?: string) {
    return mutate((data) => applyPatch(data, {
      workerId: payload.workerId,
      date: payload.date,
      [payload.period]: payload.status,
    }))
  },

  setAttendanceBatch(patches: AttendancePatch[], _options: { allowFuture?: boolean; operationId?: string } = {}) {
    return mutate((data) => {
      for (const patch of patches) applyPatch(data, patch)
    })
  },

  setAttendanceLeave(patches: Array<
    | { workerId: string; date: string; period: 'morning' | 'afternoon'; leave: OrdinaryLeave | null }
    | { workerId: string; date: string; period: 'overtime'; leave: OvertimeLeave | null }
  >, _options: { allowFuture?: boolean; operationId?: string } = {}) {
    return mutate((data) => {
      for (const patch of patches) {
        if (patch.period === 'morning') applyPatch(data, { workerId: patch.workerId, date: patch.date, morningLeave: patch.leave }, true)
        else if (patch.period === 'afternoon') applyPatch(data, { workerId: patch.workerId, date: patch.date, afternoonLeave: patch.leave }, true)
        else applyPatch(data, {
          workerId: patch.workerId,
          date: patch.date,
          overtimeLeave: patch.leave as OvertimeLeave | null,
        }, true)
      }
    })
  },

  setDayNote(payload: { workerId: string; date: string; dayNote: string }, _operationId?: string) {
    return mutate((data) => applyPatch(data, payload))
  },

  setMonthlyRecord(payload: {
    workerId: string
    month: string
    dailyRateFen?: number
    overtimePayPercent?: number
    note?: string
    paid?: boolean
  }, _operationId?: string) {
    return mutate((data) => {
      const record = ensureMonthlyRecord(data, payload.workerId, payload.month)
      if (payload.dailyRateFen !== undefined) record.dailyRateFen = payload.dailyRateFen
      if (payload.overtimePayPercent !== undefined) record.overtimePayPercent = payload.overtimePayPercent
      if (payload.note !== undefined) record.note = payload.note
      if (payload.paid !== undefined) record.paidAt = payload.paid ? record.paidAt ?? new Date().toISOString() : null
    })
  },

  setSettings(payload: Partial<{
    weekStartsOn: WeekStartsOn
    currentWorkerId: string | null
    theme: Theme
    sidebarCollapsed: boolean
    lastBackupExportAt: string | null
    lastBackupReminderAt: string | null
    weeklyAutoBackupEnabled: boolean
    defaultOvertimePayPercent: number
  }>, _operationId?: string) {
    return mutate((data) => {
      Object.assign(data.settings, payload)
    })
  },

  addPayAdjustment(payload: {
    workerId: string
    month: string
    date: string | null
    kind: PayAdjustmentKind
    amountFen: number
    label: string
    note: string
    siteId?: string | null
  }, _operationId?: string) {
    return mutate((data) => {
      requireWorker(data, payload.workerId)
      const now = new Date().toISOString()
      data.payAdjustments.push({
        id: newId('adjustment'),
        ...payload,
        siteId: payload.siteId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      ensureMonthlyRecord(data, payload.workerId, payload.month)
    })
  },

  updatePayAdjustment(id: string, payload: Partial<Pick<PayAdjustment,
    'month' | 'date' | 'kind' | 'amountFen' | 'label' | 'note' | 'siteId'
  >>, _operationId?: string) {
    return mutate((data) => {
      const item = data.payAdjustments.find((candidate) => candidate.id === id)
      if (!item) throw new Error('没有找到该补贴扣款记录')
      Object.assign(item, payload, { updatedAt: new Date().toISOString() })
    })
  },

  deletePayAdjustment(id: string, _operationId?: string) {
    return mutate((data) => {
      data.payAdjustments = data.payAdjustments.filter((candidate) => candidate.id !== id)
    })
  },

  addSite(payload: { name: string; note: string }, _operationId?: string) {
    return mutate((data) => {
      data.sites.push({
        id: newId('site'),
        name: payload.name.trim(),
        note: payload.note,
        createdAt: new Date().toISOString(),
        archivedAt: null,
      })
    })
  },

  updateSite(id: string, payload: { name?: string; note?: string; archived?: boolean; replacementDefaultSiteId?: string | null }, _operationId?: string) {
    return mutate((data) => {
      const site = requireSite(data, id)
      if (payload.name !== undefined) site.name = payload.name.trim()
      if (payload.note !== undefined) site.note = payload.note
      if (payload.archived !== undefined) {
        site.archivedAt = payload.archived ? site.archivedAt ?? new Date().toISOString() : null
        if (payload.archived) {
          for (const worker of data.workers) {
            if (worker.defaultSiteId === id) worker.defaultSiteId = payload.replacementDefaultSiteId ?? null
          }
        }
      }
    })
  },

  async listInternalBackups(): Promise<{ items: InternalBackupMeta[] }> {
    const items = await Promise.all((await backupDescriptors()).map(backupMetadata))
    items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    return { items }
  },

  async inspectInternalBackup(id: string): Promise<InternalBackupInspection> {
    const descriptor = await resolveBackup(id)
    const data = (await readValidated(descriptor.path)).data
    return {
      ...restoreInspection(data),
      backup: await backupMetadata(descriptor),
    }
  },

  revertHistory(targets: HistoryRevertTarget[], _operationId?: string) {
    return mutate((data) => {
      for (const target of targets) {
        if (target.entity === 'attendance') {
          data.attendance = data.attendance.filter((entry) => !(entry.workerId === target.key.workerId && entry.date === target.key.date))
          if (target.before) data.attendance.push(target.before as unknown as AttendanceEntry)
        } else if (target.entity === 'monthlyRecord') {
          data.monthlyRecords = data.monthlyRecords.filter((record) => !(record.workerId === target.key.workerId && record.month === target.key.month))
          if (target.before) data.monthlyRecords.push(target.before)
        } else if (target.entity === 'payAdjustment') {
          data.payAdjustments = data.payAdjustments.filter((item) => item.id !== target.key.id)
          if (target.before) data.payAdjustments.push(target.before)
        } else {
          const site = requireSite(data, target.key.id)
          site.archivedAt = target.before.archivedAt
          for (const snapshot of target.before.workerDefaults) {
            requireWorker(data, snapshot.workerId).defaultSiteId = snapshot.defaultSiteId
          }
        }
      }
    })
  },

  async inspectRestore(value: unknown): Promise<RestoreInspection> {
    return restoreInspection(validateAndroidData(value))
  },

  restore(value: AppData, _operationId?: string): Promise<AppData> {
    let resolveResult!: (value: AppData) => void
    let rejectResult!: (reason: unknown) => void
    const result = new Promise<AppData>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    writeQueue = writeQueue.catch(() => undefined).then(async () => {
      try {
        const current = await load()
        const imported = validateAndroidData(value)
        await createPreRestoreBackup(current)
        imported.revision = current.revision + 1
        await persist(imported)
        cachedState = imported
        resolveResult(clone(imported))
      } catch (error) {
        rejectResult(error)
      }
    })
    return result
  },
}

export async function exportAndroidBackup(): Promise<JigongbenDesktopSaveResult> {
  const data = await androidPocApi.getState()
  const filename = `L.Q记工本-Android-${new Date().toISOString().slice(0, 10)}.json`
  const path = `${DATA_DIRECTORY}/${filename}`
  await Filesystem.writeFile({
    path,
    directory: Directory.Cache,
    data: JSON.stringify(backupDocument(data), null, 2),
    encoding: Encoding.UTF8,
    recursive: true,
  })
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
  const shareResult = await shareAndroidFile({
    title: '导出 L.Q记工本 Android 备份',
    dialogTitle: '导出 L.Q记工本 Android 备份',
    files: [uri],
  })
  return { canceled: shareResult.canceled, filePath: uri }
}
