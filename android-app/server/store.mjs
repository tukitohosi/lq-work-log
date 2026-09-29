import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  access,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { ApiError, SCHEMA_VERSION, emptyAppData, validateAppData } from './validation.mjs';
import { APP_DATA_WARNING_RATIO, MAX_APP_DATA_BYTES } from '../shared/data-limits.mjs';
import { snapshotAppDataForKeys } from '../shared/app-data-delta.mjs';

export const WEEKLY_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;
export const WEEKLY_BACKUP_PREFIX = 'L.Q记工本每周备份-';
export const MAX_WEEKLY_BACKUPS = 12;
export const MAX_DATA_BYTES = MAX_APP_DATA_BYTES;
export const DATA_SIZE_WARNING_BYTES = Math.floor(MAX_DATA_BYTES * APP_DATA_WARNING_RATIO);
export const MAX_OPERATION_RECEIPTS = 2048;
export const DEFAULT_MAX_DAILY_BACKUPS = 30;
export const DEFAULT_MAX_PRE_RESTORE_BACKUPS = 10;
const LOCK_HEARTBEAT_MS = 5_000;

function clone(value) {
  return structuredClone(value);
}

function dateStamp(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function fileTimestamp(date) {
  return `${dateStamp(date)}T${String(date.getHours()).padStart(2, '0')}${String(
    date.getMinutes(),
  ).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}${String(
    date.getMilliseconds(),
  ).padStart(3, '0')}`;
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function serializedJson(data, entityCache = null) {
  // Compact JSON keeps the documented five-year benchmark inside the same
  // 64 MiB round-trip limit and materially reduces every durable write.
  if (!entityCache) return `${JSON.stringify(data)}\n`;
  const properties = [];
  for (const key of Object.keys(data)) {
    const value = data[key];
    let serializedValue;
    if (Array.isArray(value)) {
      const items = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        let serializedItem = entityCache.get(item);
        if (serializedItem === undefined) {
          serializedItem = JSON.stringify(item);
          entityCache.set(item, serializedItem);
        }
        items[index] = serializedItem;
      }
      serializedValue = `[${items.join(',')}]`;
    } else if (value !== null && typeof value === 'object') {
      serializedValue = entityCache.get(value);
      if (serializedValue === undefined) {
        serializedValue = JSON.stringify(value);
        entityCache.set(value, serializedValue);
      }
    } else {
      serializedValue = JSON.stringify(value);
    }
    properties.push(`${JSON.stringify(key)}:${serializedValue}`);
  }
  return `{${properties.join(',')}}\n`;
}

function serializeAppData(data, limitBytes = MAX_DATA_BYTES, entityCache = null) {
  const serialized = serializedJson(data, entityCache);
  const size = Buffer.byteLength(serialized, 'utf8');
  if (size > limitBytes) {
    throw new ApiError(413, 'DATA_LIMIT_REACHED', '记工本数据已超过 64 MiB 上限，请先导出并清理历史图片或数据', {
      sizeBytes: size,
      limitBytes,
    });
  }
  return { serialized, size };
}

export function appDataSizeBytes(data) {
  return Buffer.byteLength(serializedJson(data), 'utf8');
}

export function assertAppDataSize(data, limitBytes = MAX_DATA_BYTES) {
  return serializeAppData(data, limitBytes).size;
}

async function atomicWriteJson(targetPath, data, limitBytes = MAX_DATA_BYTES, preparedSerialized = null) {
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const { serialized } = preparedSerialized === null
    ? serializeAppData(data, limitBytes)
    : { serialized: preparedSerialized };
  let handle;
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
    handle = await open(temporaryPath, 'r');
    try {
      await handle.sync();
    } catch (error) {
      // Some Windows/sandbox-backed filesystems reject fsync even though the
      // file was written successfully. Atomic rename still prevents a partial
      // records.json from becoming the active file.
      if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
    }
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicCopyFile(sourcePath, targetPath) {
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle;
  try {
    let linked = false;
    try {
      // records.json is never edited in place: every commit replaces it with a
      // new inode/file record. A same-volume hard link therefore preserves the
      // exact previous committed bytes in O(1) while retaining last-good's
      // independent lifetime after records.json is replaced.
      await link(sourcePath, temporaryPath);
      linked = true;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EXDEV', 'EINVAL', 'ENOTSUP', 'ENOSYS', 'EMLINK'].includes(error?.code)) {
        throw error;
      }
      await copyFile(sourcePath, temporaryPath, fsConstants.COPYFILE_FICLONE);
    }
    if (!linked) {
      handle = await open(temporaryPath, 'r');
      try {
        await handle.sync();
      } catch (error) {
        if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
      }
      await handle.close();
      handle = undefined;
    }
    await rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function prunePrefixedBackups(directory, prefix, maxFiles) {
  const entries = [];
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const filePath = path.join(directory, name);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) entries.push({ filePath, name, modifiedAt: fileStat.mtimeMs });
    } catch {
      // The file may have been removed by another maintenance pass.
    }
  }
  entries.sort(
    (left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name),
  );
  await Promise.all(entries.slice(maxFiles).map(({ filePath }) => rm(filePath, { force: true })));
}

function recoverableBackupKind(filePath, lastGoodPath) {
  if (filePath === lastGoodPath) return 'last-good';
  const filename = path.basename(filePath);
  if (filename.startsWith('daily-')) return 'daily';
  if (filename.startsWith('pre-restore-')) return 'pre-restore';
  return 'other';
}

function opaqueBackupId(relativePath, size, modifiedAtMs) {
  return createHash('sha256')
    .update(`jigongben-internal-backup\0${relativePath}\0`)
    .update(`${size}\0${modifiedAtMs}`)
    .digest('base64url');
}

export function fingerprintDataDir(dataDir) {
  const normalized = path.resolve(dataDir).replace(/\\/g, '/');
  const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  return createHash('sha256').update(`jigongben-data-dir\0${stable}`).digest('hex');
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function safeFailureReason(error) {
  if (typeof error?.code === 'string') return `文件系统错误 ${error.code}`;
  return error instanceof Error ? error.message : String(error);
}

function isManagedInternalBackup(filename) {
  return (
    /^daily-\d{4}-\d{2}-\d{2}-\d{9}-r\d+\.json$/.test(filename) ||
    /^pre-restore-\d{4}-\d{2}-\d{2}T\d{9}-r\d+\.json$/.test(filename) ||
    /^pre-restore-corrupt-\d{4}-\d{2}-\d{2}T\d{9}\.bin$/.test(filename)
  );
}

export class DataStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.join(options.rootDir ?? process.cwd(), 'data'));
    this.recordsPath = path.join(this.dataDir, 'records.json');
    this.lastGoodPath = path.join(this.dataDir, 'records.last-good.json');
    this.backupsDir = path.join(this.dataDir, 'backups');
    this.lockPath = path.join(this.dataDir, '.jigongben.lock');
    this.dataDirFingerprint = fingerprintDataDir(this.dataDir);
    this.now = options.now ?? (() => new Date());
    this.maxDailyBackups = options.maxDailyBackups ?? options.maxBackups ?? DEFAULT_MAX_DAILY_BACKUPS;
    this.maxPreRestoreBackups =
      options.maxPreRestoreBackups ?? options.maxBackups ?? DEFAULT_MAX_PRE_RESTORE_BACKUPS;
    this.maxDataBytes = options.maxDataBytes ?? MAX_DATA_BYTES;
    if (!Number.isSafeInteger(this.maxDataBytes) || this.maxDataBytes < 1 || this.maxDataBytes > MAX_DATA_BYTES) {
      throw new TypeError('数据容量上限必须是 1 至 64 MiB 之间的安全整数');
    }
    this.acquireLock = options.acquireLock !== false;
    this.data = null;
    this.currentDataSizeBytes = null;
    this.loadError = null;
    this.lastDailyBackupDate = null;
    this.hasRecoveryPoints = false;
    this.queue = Promise.resolve();
    this.operationContext = new AsyncLocalStorage();
    // Weak keys ensure discarded mutation candidates do not accumulate. The
    // attendance fast path replaces changed entities instead of mutating them,
    // so unchanged object identities safely reuse their exact JSON fragments.
    this.serializationCache = new WeakMap();
    this.lockToken = null;
    this.lockHeartbeat = null;
    this.heartbeatWrite = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    if (this.acquireLock) await this.#acquireDataDirLock();
    await mkdir(this.backupsDir, { recursive: true });
    if (!(await exists(this.recordsPath))) {
      this.hasRecoveryPoints = await this.#detectRecoveryTraces();
      if (this.hasRecoveryPoints) {
        this.data = null;
        this.loadError = {
          code: 'RECOVERY_REQUIRED',
          message: '未找到正式数据文件，但检测到历史恢复点，已进入只读保护模式。请先预览并恢复备份。',
          reason: '正式数据文件缺失',
        };
      } else {
        this.data = emptyAppData();
        this.currentDataSizeBytes = serializeAppData(
          this.data,
          this.maxDataBytes,
          this.serializationCache,
        ).size;
      }
      return this;
    }
    try {
      const parsed = JSON.parse(await readFile(this.recordsPath, 'utf8'));
      this.data = validateAppData(parsed, { cloneInput: false });
      this.currentDataSizeBytes = serializeAppData(
        this.data,
        this.maxDataBytes,
        this.serializationCache,
      ).size;
    } catch (error) {
      this.data = null;
      this.loadError = {
        code: error?.code === 'DATA_LIMIT_REACHED' ? 'DATA_LIMIT_REACHED' : 'DATA_CORRUPTED',
        message: error?.code === 'DATA_LIMIT_REACHED'
          ? '正式数据文件超过 64 MiB 安全上限，已进入只读保护模式。请恢复较小的备份。'
          : '正式数据文件无法读取或校验失败，已进入只读保护模式。请导入有效备份恢复。',
        reason: safeFailureReason(error),
      };
    }
    return this;
  }

  get isReadOnly() {
    return this.data === null;
  }

  getState() {
    if (this.isReadOnly) {
      throw new ApiError(503, this.loadError.code, this.loadError.message, {
        reason: this.loadError.reason,
      });
    }
    return clone(this.data);
  }

  /** Internal read-only snapshot used while producing a mutation delta. */
  getStateReference() {
    if (this.isReadOnly) return null;
    return this.data;
  }

  runWithOperation(operation, callback) {
    return this.operationContext.run(operation ?? null, callback);
  }

  async getStatus() {
    const dataSizeBytes = this.currentDataSizeBytes;
    return {
      ok: !this.isReadOnly,
      app: 'jigongben-local',
      schemaVersion: SCHEMA_VERSION,
      revision: this.data?.revision ?? null,
      readOnly: this.isReadOnly,
      error: this.loadError,
      dataDirFingerprint: this.dataDirFingerprint,
      dataSizeBytes,
      dataLimitBytes: this.maxDataBytes,
      dataSizeWarning:
        dataSizeBytes !== null && dataSizeBytes >= Math.floor(this.maxDataBytes * APP_DATA_WARNING_RATIO),
      recovery: {
        available: this.hasRecoveryPoints,
      },
    };
  }

  async getCorruptionResponse() {
    const status = await this.getStatus();
    return {
      error: {
        code: status.error.code,
        message: status.error.message,
        details: { reason: status.error.reason },
      },
      readOnly: true,
      recovery: status.recovery,
    };
  }

  async listRecoverableBackups() {
    return this.#listRecoverableBackupMetadata();
  }

  async inspectRecoverableBackup(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) {
      throw new ApiError(400, 'VALIDATION_ERROR', '内部备份 ID 无效');
    }
    const candidate = (await this.#listRecoverableBackupMetadata({ includeFilePath: true }))
      .find((item) => item.id === id);
    if (!candidate) {
      throw new ApiError(404, 'INTERNAL_BACKUP_NOT_FOUND', '内部备份不存在、已失效或无法通过校验');
    }
    let data;
    try {
      const contents = await readFile(candidate.filePath, 'utf8');
      const fileStat = await lstat(candidate.filePath);
      const currentId = opaqueBackupId(path.relative(this.dataDir, candidate.filePath), fileStat.size, fileStat.mtimeMs);
      if (currentId !== id) throw new Error('备份已变化');
      data = validateAppData(JSON.parse(contents), { cloneInput: false });
      assertAppDataSize(data, this.maxDataBytes);
    } catch {
      throw new ApiError(422, 'INVALID_INTERNAL_BACKUP', '内部备份无法读取或未通过完整校验');
    }
    const { filePath: _filePath, ...backup } = candidate;
    return { backup: clone(backup), data: clone(data) };
  }

  async mutate(mutator) {
    return this.#enqueue(async () => {
      if (this.isReadOnly) {
        throw new ApiError(503, 'READ_ONLY', this.loadError.message, {
          reason: this.loadError.reason,
        });
      }
      const operation = this.operationContext.getStore();
      const existingReceipt = this.#assertOperationCanRun(operation, this.data);
      if (existingReceipt) return this.#mutationResult(this.data, operation);

      const next = clone(this.data);
      const mutationResult = await mutator(next);
      const businessChanged = mutationResult !== false;
      if (!businessChanged && !operation) return this.#mutationResult(this.data, operation);
      next.revision = businessChanged ? this.data.revision + 1 : this.data.revision;
      this.#appendOperationReceipt(next, operation, next.revision);
      const validated = validateAppData(next, { cloneInput: false });
      const prepared = serializeAppData(validated, this.maxDataBytes, this.serializationCache);
      const dataSizeBytes = prepared.size;
      if (businessChanged) await this.#createDailyBackupIfNeeded();
      await this.#persist(validated, this.data, prepared.serialized);
      this.data = validated;
      this.currentDataSizeBytes = dataSizeBytes;
      return this.#mutationResult(this.data, operation);
    });
  }

  /**
   * Fast path for attendance handlers. The prior state has already passed a
   * complete load/restore validation, while request normalization and the
   * attendance applier validate every changed field and reference. Only the two
   * collections those handlers may replace are shallow-copied, so a failed
   * mutation cannot alter the committed in-memory state.
   */
  async mutateAttendance(mutator) {
    return this.#enqueue(async () => {
      if (this.isReadOnly) {
        throw new ApiError(503, 'READ_ONLY', this.loadError.message, {
          reason: this.loadError.reason,
        });
      }
      const operation = this.operationContext.getStore();
      const existingReceipt = this.#assertOperationCanRun(operation, this.data);
      if (existingReceipt) return this.#mutationResult(this.data, operation);

      const previous = this.data;
      if (operation?.responseMode === 'delta' && operation.deltaKeys) {
        // Capture inside the serialized queue. Capturing in the HTTP handler
        // can race an earlier queued edit to the same cell and produce a delta
        // against the wrong revision.
        operation.deltaBeforeState = snapshotAppDataForKeys(previous, operation.deltaKeys);
      }
      const next = {
        ...previous,
        attendance: [...previous.attendance],
        monthlyRecords: [...previous.monthlyRecords],
        operationReceipts: [...previous.operationReceipts],
      };
      const mutationResult = await mutator(next);
      const businessChanged = mutationResult !== false;
      if (!businessChanged && !operation) return this.#mutationResult(this.data, operation);
      next.revision = businessChanged ? previous.revision + 1 : previous.revision;
      this.#appendOperationReceipt(next, operation, next.revision);
      const prepared = serializeAppData(next, this.maxDataBytes, this.serializationCache);
      if (businessChanged) await this.#createDailyBackupIfNeeded();
      await this.#persist(next, previous, prepared.serialized);
      this.data = next;
      this.currentDataSizeBytes = prepared.size;
      return this.#mutationResult(this.data, operation);
    });
  }

  async restore(candidate) {
    const imported = validateAppData(candidate);
    assertAppDataSize(imported, this.maxDataBytes);
    return this.#enqueue(async () => {
      const operation = this.operationContext.getStore();
      const existingReceipt = this.#assertOperationCanRun(operation, this.data);
      if (existingReceipt) return clone(this.data);
      await this.#createPreRestoreBackup();
      const currentRevision = this.data?.revision ?? 0;
      imported.revision = Math.max(currentRevision, imported.revision) + 1;
      this.#appendOperationReceipt(imported, operation, imported.revision);
      const validated = validateAppData(imported, { cloneInput: false });
      const prepared = serializeAppData(validated, this.maxDataBytes, this.serializationCache);
      const dataSizeBytes = prepared.size;
      if (this.data) {
        await atomicWriteJson(this.lastGoodPath, this.data, this.maxDataBytes);
      }
      await atomicWriteJson(this.recordsPath, validated, this.maxDataBytes, prepared.serialized);
      this.data = validated;
      this.currentDataSizeBytes = dataSizeBytes;
      this.loadError = null;
      this.hasRecoveryPoints = true;
      this.lastDailyBackupDate = null;
      await this.#pruneBackups();
      return clone(this.data);
    });
  }

  async createWeeklyBackupIfDue(options = {}) {
    const backupDir = options.backupDir;
    const force = options.force === true;
    if (typeof backupDir !== 'string' || backupDir.length === 0) {
      throw new TypeError('每周备份目录无效');
    }
    const resolvedBackupDir = path.resolve(backupDir);

    return this.#enqueue(async () => {
      if (this.isReadOnly) {
        throw new ApiError(503, 'READ_ONLY', this.loadError.message, {
          reason: this.loadError.reason,
        });
      }

      const settings = this.data.settings;
      if (!force && settings.weeklyAutoBackupEnabled !== true) {
        return { created: false, reason: 'disabled' };
      }

      const now = this.now();
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs)) throw new TypeError('每周备份时间无效');
      const previousBackupMs = settings.lastWeeklyBackupAt
        ? Date.parse(settings.lastWeeklyBackupAt)
        : Number.NaN;
      if (
        !force &&
        Number.isFinite(previousBackupMs) &&
        nowMs - previousBackupMs < WEEKLY_BACKUP_INTERVAL_MS
      ) {
        return {
          created: false,
          reason: 'not-due',
          nextDueAt: new Date(previousBackupMs + WEEKLY_BACKUP_INTERVAL_MS).toISOString(),
        };
      }

      const next = clone(this.data);
      next.revision = this.data.revision + 1;
      next.settings.lastWeeklyBackupAt = now.toISOString();
      const validated = validateAppData(next, { cloneInput: false });
      const prepared = serializeAppData(validated, this.maxDataBytes, this.serializationCache);
      const dataSizeBytes = prepared.size;
      const filename = `${WEEKLY_BACKUP_PREFIX}${fileTimestamp(now)}-r${validated.revision}.json`;

      await mkdir(resolvedBackupDir, { recursive: true });
      const filePath = path.join(resolvedBackupDir, filename);
      await atomicWriteJson(filePath, validated, this.maxDataBytes, prepared.serialized);
      await prunePrefixedBackups(resolvedBackupDir, WEEKLY_BACKUP_PREFIX, MAX_WEEKLY_BACKUPS);
      await this.#createDailyBackupIfNeeded();
      await this.#persist(validated, this.data, prepared.serialized);
      this.data = validated;
      this.currentDataSizeBytes = dataSizeBytes;

      return {
        created: true,
        createdAt: validated.settings.lastWeeklyBackupAt,
        filename,
        filePath,
        revision: validated.revision,
      };
    });
  }

  async #enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  #assertOperationCanRun(operation, data) {
    if (!operation) return null;
    const receipt = data?.operationReceipts?.find(
      (candidate) => candidate.operationId === operation.operationId,
    );
    if (!receipt) return null;
    if (receipt.requestHash !== operation.requestHash) {
      throw new ApiError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        '同一 operationId 不能用于不同的写入请求',
      );
    }
    operation.duplicate = true;
    return receipt;
  }

  #appendOperationReceipt(data, operation, committedRevision) {
    if (!operation) return;
    data.operationReceipts = data.operationReceipts.filter(
      (receipt) => receipt.operationId !== operation.operationId,
    );
    data.operationReceipts.push({
      operationId: operation.operationId,
      requestHash: operation.requestHash,
      committedRevision,
    });
    if (data.operationReceipts.length > MAX_OPERATION_RECEIPTS) {
      data.operationReceipts.splice(0, data.operationReceipts.length - MAX_OPERATION_RECEIPTS);
    }
  }

  #mutationResult(data, operation) {
    return operation?.responseMode === 'delta' ? data : clone(data);
  }

  async #detectRecoveryTraces() {
    if (await exists(this.lastGoodPath)) return true;
    try {
      return (await readdir(this.backupsDir)).some((name) =>
        name.endsWith('.json') || name.endsWith('.bin'));
    } catch {
      return false;
    }
  }

  async #listRecoverableBackupMetadata({ includeFilePath = false } = {}) {
    const filePaths = [];
    if (await exists(this.lastGoodPath)) filePaths.push(this.lastGoodPath);
    try {
      for (const name of await readdir(this.backupsDir)) {
        if (name.endsWith('.json')) filePaths.push(path.join(this.backupsDir, name));
      }
    } catch {
      // The last-good file remains useful even if the backups directory is unavailable.
    }

    const results = [];
    for (const filePath of filePaths) {
      try {
        const fileStat = await lstat(filePath);
        if (!fileStat.isFile()) continue;
        const relativePath = path.relative(this.dataDir, filePath);
        results.push({
          id: opaqueBackupId(relativePath, fileStat.size, fileStat.mtimeMs),
          kind: recoverableBackupKind(filePath, this.lastGoodPath),
          filename: path.basename(filePath),
          modifiedAt: fileStat.mtime.toISOString(),
          size: fileStat.size,
          ...(includeFilePath ? { filePath } : {}),
        });
      } catch {
        // Metadata listing deliberately does not parse or validate backup contents.
      }
    }
    return results.sort((left, right) =>
      right.modifiedAt.localeCompare(left.modifiedAt) || right.filename.localeCompare(left.filename));
  }

  async #persist(next, previous, preparedNext = null) {
    if (await exists(this.recordsPath)) {
      await atomicCopyFile(this.recordsPath, this.lastGoodPath);
    } else {
      await atomicWriteJson(this.lastGoodPath, previous, this.maxDataBytes);
    }
    await atomicWriteJson(this.recordsPath, next, this.maxDataBytes, preparedNext);
    this.hasRecoveryPoints = true;
  }

  async #createDailyBackupIfNeeded() {
    const now = this.now();
    const today = dateStamp(now);
    if (this.lastDailyBackupDate === today) {
      return;
    }
    const prefix = `daily-${today}-`;
    const existing = (await readdir(this.backupsDir)).some(
      (name) => name.startsWith(prefix) && name.endsWith('.json'),
    );
    if (!existing) {
      const filename = `${prefix}${fileTimestamp(now).slice(11)}-r${this.data.revision}.json`;
      const backupPath = path.join(this.backupsDir, filename);
      if (await exists(this.recordsPath)) {
        await atomicCopyFile(this.recordsPath, backupPath);
      } else {
        await atomicWriteJson(backupPath, this.data, this.maxDataBytes);
      }
      this.hasRecoveryPoints = true;
      await this.#pruneBackups();
    }
    this.lastDailyBackupDate = today;
  }

  async #createPreRestoreBackup() {
    const now = this.now();
    if (await exists(this.recordsPath)) {
      if (this.data) {
        const filename = `pre-restore-${fileTimestamp(now)}-r${this.data.revision}.json`;
        await atomicWriteJson(path.join(this.backupsDir, filename), this.data, this.maxDataBytes);
      } else {
        const filename = `pre-restore-corrupt-${fileTimestamp(now)}.bin`;
        await copyFile(this.recordsPath, path.join(this.backupsDir, filename));
      }
    } else if (this.data) {
      const filename = `pre-restore-${fileTimestamp(now)}-r${this.data.revision}.json`;
      await atomicWriteJson(path.join(this.backupsDir, filename), this.data, this.maxDataBytes);
    }
    this.hasRecoveryPoints = true;
  }

  async #pruneBackups() {
    const dailyEntries = [];
    const preRestoreEntries = [];
    for (const name of await readdir(this.backupsDir)) {
      if (!isManagedInternalBackup(name)) continue;
      const filePath = path.join(this.backupsDir, name);
      try {
        const fileStat = await lstat(filePath);
        if (fileStat.isFile()) {
          const target = name.startsWith('daily-') ? dailyEntries : preRestoreEntries;
          target.push({ filePath, modifiedAt: fileStat.mtimeMs });
        }
      } catch {
        // The file may have been removed by another maintenance pass.
      }
    }
    dailyEntries.sort((left, right) => right.modifiedAt - left.modifiedAt);
    preRestoreEntries.sort((left, right) => right.modifiedAt - left.modifiedAt);
    await Promise.all([
      ...dailyEntries.slice(this.maxDailyBackups),
      ...preRestoreEntries.slice(this.maxPreRestoreBackups),
    ].map(({ filePath }) => rm(filePath, { force: true })));
  }

  async #acquireDataDirLock() {
    const token = randomUUID();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const payload = {
        pid: process.pid,
        token,
        dataDirFingerprint: this.dataDirFingerprint,
        heartbeatAt: new Date().toISOString(),
      };
      try {
        await writeFile(this.lockPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'wx' });
        this.lockToken = token;
        this.lockHeartbeat = setInterval(() => {
          const heartbeat = { ...payload, heartbeatAt: new Date().toISOString() };
          this.heartbeatWrite = this.heartbeatWrite.then(async () => {
            const owner = JSON.parse(await readFile(this.lockPath, 'utf8'));
            if (owner?.token !== token || this.lockToken !== token) return;
            await atomicWriteJson(this.lockPath, heartbeat);
          }).catch(() => {});
        }, LOCK_HEARTBEAT_MS);
        this.lockHeartbeat.unref?.();
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }

      let owner;
      try {
        owner = JSON.parse(await readFile(this.lockPath, 'utf8'));
      } catch {
        owner = null;
      }
      if (owner && processIsAlive(owner.pid)) {
        throw new ApiError(409, 'DATA_DIR_IN_USE', '数据目录正在被另一个记工本实例使用');
      }
      const stalePath = `${this.lockPath}.stale.${process.pid}.${randomUUID()}`;
      try {
        await rename(this.lockPath, stalePath);
        await rm(stalePath, { force: true });
      } catch (error) {
        if (!['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) throw error;
      }
    }
    throw new ApiError(409, 'DATA_DIR_IN_USE', '无法安全获取数据目录写入锁');
  }

  async close() {
    if (this.lockHeartbeat) clearInterval(this.lockHeartbeat);
    this.lockHeartbeat = null;
    const token = this.lockToken;
    this.lockToken = null;
    if (!token) return;
    await this.heartbeatWrite.catch(() => {});
    try {
      const owner = JSON.parse(await readFile(this.lockPath, 'utf8'));
      if (owner?.token === token) await rm(this.lockPath, { force: true });
    } catch {
      // Lock may already have been removed with a temporary test directory.
    }
  }
}
