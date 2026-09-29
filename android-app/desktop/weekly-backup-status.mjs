export const WEEKLY_BACKUP_FAILURE_CODES = Object.freeze({
  backupServiceUnavailable: 'BACKUP_SERVICE_UNAVAILABLE',
  directoryUnavailable: 'BACKUP_DIRECTORY_UNAVAILABLE',
  diskFull: 'DISK_FULL',
  ioError: 'IO_ERROR',
  permissionDenied: 'PERMISSION_DENIED',
  readOnlyFilesystem: 'READ_ONLY_FILESYSTEM',
  unknown: 'UNKNOWN',
})

export function weeklyBackupFailureCode(error) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : ''
  if (code === 'ENOSPC' || code === 'EDQUOT') return WEEKLY_BACKUP_FAILURE_CODES.diskFull
  if (code === 'EACCES' || code === 'EPERM') return WEEKLY_BACKUP_FAILURE_CODES.permissionDenied
  if (code === 'EROFS') return WEEKLY_BACKUP_FAILURE_CODES.readOnlyFilesystem
  if (code === 'ENOENT' || code === 'ENOTDIR') return WEEKLY_BACKUP_FAILURE_CODES.directoryUnavailable
  if (code === 'EIO') return WEEKLY_BACKUP_FAILURE_CODES.ioError
  if (code === WEEKLY_BACKUP_FAILURE_CODES.backupServiceUnavailable) {
    return WEEKLY_BACKUP_FAILURE_CODES.backupServiceUnavailable
  }
  return WEEKLY_BACKUP_FAILURE_CODES.unknown
}

export function createWeeklyBackupStatusTracker(options = {}) {
  const now = options.now ?? (() => new Date())
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  let failure = null

  return {
    clear() {
      failure = null
    },
    record(error) {
      const timestamp = now()
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
        throw new TypeError('每周备份失败时间无效')
      }
      failure = {
        lastFailureAt: timestamp.toISOString(),
        errorCode: weeklyBackupFailureCode(error),
      }
      return { ...failure }
    },
    snapshot() {
      return failure
        ? { ...failure }
        : { lastFailureAt: null, errorCode: null }
    },
  }
}

export async function runTrackedWeeklyBackup(operation, tracker) {
  if (typeof operation !== 'function') throw new TypeError('weekly backup operation must be a function')
  if (!tracker || typeof tracker.record !== 'function' || typeof tracker.clear !== 'function') {
    throw new TypeError('weekly backup status tracker is invalid')
  }
  try {
    const result = await operation()
    if (result?.created === true) tracker.clear()
    return result
  } catch (error) {
    tracker.record(error)
    throw error
  }
}
