import path from 'node:path'
import { MAX_APP_DATA_BYTES } from '../shared/data-limits.mjs'

export const IPC_CHANNELS = Object.freeze({
  saveFile: 'jigongben:save-file',
  print: 'jigongben:print',
  savePdf: 'jigongben:save-pdf',
  setTheme: 'jigongben:set-theme',
  weeklyBackup: 'jigongben:weekly-backup',
  weeklyBackupStatus: 'jigongben:weekly-backup-status',
  apiSessionToken: 'jigongben:api-session-token',
  openWeeklyBackupFolder: 'jigongben:open-weekly-backup-folder',
  closeRequested: 'jigongben:close-requested',
  closeCancelled: 'jigongben:close-cancelled',
  closeComplete: 'jigongben:close-complete',
})

export const WEEKLY_BACKUP_DIRECTORY_NAME = 'L.Q记工本备份'

export const EXTERNAL_FILE_WRITE_ERROR_CODES = Object.freeze({
  diskFull: 'EXTERNAL_SAVE_DISK_FULL',
  ioError: 'EXTERNAL_SAVE_IO_ERROR',
  permissionDenied: 'EXTERNAL_SAVE_PERMISSION_DENIED',
  readOnlyFilesystem: 'EXTERNAL_SAVE_READ_ONLY',
  fileBusy: 'EXTERNAL_SAVE_FILE_BUSY',
  unknown: 'EXTERNAL_SAVE_FAILED',
})

export const SAVE_FILE_KINDS = Object.freeze({
  json: Object.freeze({
    extension: '.json',
    filter: Object.freeze({ name: 'JSON 备份', extensions: Object.freeze(['json']) }),
    maxBytes: MAX_APP_DATA_BYTES,
  }),
  xlsx: Object.freeze({
    extension: '.xlsx',
    filter: Object.freeze({ name: 'Excel 工作簿', extensions: Object.freeze(['xlsx']) }),
    maxBytes: MAX_APP_DATA_BYTES,
  }),
})

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const INVALID_FILENAME_CHARACTER = /[<>:"/\\|?*\u0000-\u001f]/u

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactKeys(value, allowedKeys, label) {
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key))
  if (unknownKey) throw new TypeError(`${label} 包含不允许的字段：${unknownKey}`)
}

function isUint8Array(value) {
  return value instanceof Uint8Array || (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === '[object Uint8Array]'
  )
}

export function resolveDataDirectory(userDataPath) {
  if (typeof userDataPath !== 'string' || userDataPath.length === 0) {
    throw new TypeError('userData 路径无效')
  }
  return path.resolve(userDataPath, 'data')
}

export function resolveWeeklyBackupDirectory(documentsPath) {
  if (typeof documentsPath !== 'string' || documentsPath.length === 0) {
    throw new TypeError('文档路径无效')
  }
  return path.resolve(documentsPath, WEEKLY_BACKUP_DIRECTORY_NAME)
}

export function validateSuggestedFilename(value, expectedExtension) {
  if (typeof value !== 'string') throw new TypeError('文件名必须是字符串')
  const filename = value.normalize('NFC')
  if (
    filename.length === 0 ||
    filename.length > 180 ||
    filename === '.' ||
    filename === '..' ||
    filename.endsWith('.') ||
    filename.endsWith(' ') ||
    INVALID_FILENAME_CHARACTER.test(filename) ||
    WINDOWS_RESERVED_NAME.test(filename)
  ) {
    throw new TypeError('文件名无效')
  }
  if (path.extname(filename).toLowerCase() !== expectedExtension) {
    throw new TypeError(`文件扩展名必须是 ${expectedExtension}`)
  }
  return filename
}

export function validateSelectedPath(filePath, expectedExtension) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('保存路径无效')
  }
  if (path.extname(filePath).toLowerCase() !== expectedExtension) {
    throw new TypeError(`保存路径必须使用 ${expectedExtension} 扩展名`)
  }
  return path.resolve(filePath)
}

export function validateSaveFileRequest(value) {
  if (!isPlainObject(value)) throw new TypeError('保存请求无效')
  assertExactKeys(value, ['kind', 'filename', 'data'], '保存请求')

  const config = SAVE_FILE_KINDS[value.kind]
  if (!config) throw new TypeError('只允许保存 JSON 备份或 XLSX 工作簿')
  const filename = validateSuggestedFilename(value.filename, config.extension)

  let bytes
  if (value.kind === 'json') {
    if (typeof value.data !== 'string') throw new TypeError('JSON 备份必须是文本')
    bytes = Buffer.from(value.data, 'utf8')
    try {
      JSON.parse(value.data)
    } catch {
      throw new TypeError('JSON 备份内容无效')
    }
  } else {
    if (!isUint8Array(value.data)) throw new TypeError('XLSX 工作簿必须是 Uint8Array 二进制数据')
    bytes = Buffer.from(value.data.buffer, value.data.byteOffset, value.data.byteLength)
  }

  if (bytes.byteLength === 0 || bytes.byteLength > config.maxBytes) {
    throw new RangeError(`文件大小必须在 1 字节到 ${config.maxBytes} 字节之间`)
  }
  return { kind: value.kind, filename, bytes: Buffer.from(bytes), config }
}

export function validatePdfRequest(value) {
  if (value === undefined) return { filename: '记工表.pdf', landscape: true }
  if (!isPlainObject(value)) throw new TypeError('PDF 保存请求无效')
  assertExactKeys(value, ['filename', 'landscape'], 'PDF 保存请求')
  if (value.landscape !== undefined && typeof value.landscape !== 'boolean') {
    throw new TypeError('PDF 方向必须是 true 或 false')
  }
  return {
    filename: value.filename === undefined ? '记工表.pdf' : validateSuggestedFilename(value.filename, '.pdf'),
    landscape: value.landscape ?? true,
  }
}

export function validatePrintRequest(value) {
  if (value === undefined) return { landscape: true }
  if (!isPlainObject(value)) throw new TypeError('打印请求无效')
  assertExactKeys(value, ['landscape'], '打印请求')
  if (value.landscape !== undefined && typeof value.landscape !== 'boolean') {
    throw new TypeError('打印方向必须是 true 或 false')
  }
  return { landscape: value.landscape ?? true }
}

export function validateTheme(value) {
  if (value !== 'light' && value !== 'dark') throw new TypeError('主题只能是 light 或 dark')
  return value
}

export function validateWeeklyBackupRequest(value) {
  if (value === undefined) return { force: false }
  if (!isPlainObject(value)) throw new TypeError('每周备份请求无效')
  assertExactKeys(value, ['force'], '每周备份请求')
  if (value.force !== undefined && typeof value.force !== 'boolean') {
    throw new TypeError('每周备份 force 必须是布尔值')
  }
  return { force: value.force ?? false }
}

export function validateCloseCompletion(value) {
  if (!isPlainObject(value)) throw new TypeError('关闭完成消息无效')
  assertExactKeys(value, ['requestId', 'ok', 'error'], '关闭完成消息')
  if (typeof value.requestId !== 'string' || !/^[a-f0-9-]{16,64}$/i.test(value.requestId)) {
    throw new TypeError('关闭请求 ID 无效')
  }
  if (typeof value.ok !== 'boolean') throw new TypeError('关闭完成状态无效')
  if (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 2_000)) {
    throw new TypeError('关闭错误信息无效')
  }
  return { requestId: value.requestId, ok: value.ok, error: value.error }
}

export function isAllowedAppUrl(candidate, allowedOrigin) {
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' && url.origin === allowedOrigin
  } catch {
    return false
  }
}

export function isTrustedIpcEvent(event, mainWindow, allowedOrigin) {
  if (!event || !mainWindow || mainWindow.isDestroyed?.()) return false
  const webContents = mainWindow.webContents
  if (!webContents || webContents.isDestroyed?.() || event.sender !== webContents) return false
  if (!event.senderFrame || event.senderFrame !== webContents.mainFrame) return false
  return isAllowedAppUrl(event.senderFrame.url, allowedOrigin)
}

export function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error || '未知错误')
}

/**
 * Converts a native filesystem failure into an actionable renderer-safe error.
 *
 * Node filesystem messages normally contain the selected absolute path (and
 * sometimes the same-directory temporary path). Never pass those messages
 * through Electron IPC: the renderer only needs a stable category and a safe
 * recovery instruction.
 */
export function externalFileWriteError(error) {
  const nativeCode = typeof error?.code === 'string' ? error.code.toUpperCase() : ''
  let code = EXTERNAL_FILE_WRITE_ERROR_CODES.unknown
  let message = '文件写入失败，请确认保存位置可写且文件未被占用后重试。'

  if (nativeCode === 'ENOSPC' || nativeCode === 'EDQUOT') {
    code = EXTERNAL_FILE_WRITE_ERROR_CODES.diskFull
    message = '文件写入失败：磁盘空间或存储配额不足，请清理空间后重试。'
  } else if (nativeCode === 'EIO') {
    code = EXTERNAL_FILE_WRITE_ERROR_CODES.ioError
    message = '文件写入失败：磁盘 I/O 异常，请检查磁盘或更换保存位置后重试。'
  } else if (nativeCode === 'EACCES' || nativeCode === 'EPERM') {
    code = EXTERNAL_FILE_WRITE_ERROR_CODES.permissionDenied
    message = '文件写入失败：没有写入权限，请选择其他文件夹后重试。'
  } else if (nativeCode === 'EROFS') {
    code = EXTERNAL_FILE_WRITE_ERROR_CODES.readOnlyFilesystem
    message = '文件写入失败：目标位置为只读，请选择可写位置后重试。'
  } else if (nativeCode === 'EBUSY' || nativeCode === 'ETXTBSY') {
    code = EXTERNAL_FILE_WRITE_ERROR_CODES.fileBusy
    message = '文件写入失败：目标文件正被其他程序占用，请关闭占用程序后重试。'
  }

  const mapped = new Error(message)
  mapped.name = 'ExternalFileWriteError'
  mapped.code = code
  return mapped
}
