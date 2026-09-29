// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createWeeklyBackupStatusTracker,
  runTrackedWeeklyBackup,
  WEEKLY_BACKUP_FAILURE_CODES,
  weeklyBackupFailureCode,
} from '../desktop/weekly-backup-status.mjs'

describe('weekly backup failure status', () => {
  it('maps filesystem failures to stable renderer-safe codes', () => {
    expect(weeklyBackupFailureCode({ code: 'ENOSPC' })).toBe('DISK_FULL')
    expect(weeklyBackupFailureCode({ code: 'EDQUOT' })).toBe('DISK_FULL')
    expect(weeklyBackupFailureCode({ code: 'EACCES' })).toBe('PERMISSION_DENIED')
    expect(weeklyBackupFailureCode({ code: 'EROFS' })).toBe('READ_ONLY_FILESYSTEM')
    expect(weeklyBackupFailureCode({ code: 'ENOENT' })).toBe('BACKUP_DIRECTORY_UNAVAILABLE')
    expect(weeklyBackupFailureCode({ code: 'EIO' })).toBe('IO_ERROR')
    expect(weeklyBackupFailureCode({ code: WEEKLY_BACKUP_FAILURE_CODES.backupServiceUnavailable }))
      .toBe('BACKUP_SERVICE_UNAVAILABLE')
    expect(weeklyBackupFailureCode(new Error('contains a private path'))).toBe('UNKNOWN')
  })

  it('exposes only the most recent failure time/code and clears after success', () => {
    const moments = [
      new Date('2026-08-25T01:02:03.000Z'),
      new Date('2026-08-25T04:05:06.000Z'),
    ]
    const tracker = createWeeklyBackupStatusTracker({ now: () => moments.shift() })
    expect(tracker.snapshot()).toEqual({ lastFailureAt: null, errorCode: null })

    tracker.record(Object.assign(new Error('C:\\private\\path'), { code: 'ENOSPC' }))
    expect(tracker.snapshot()).toEqual({
      lastFailureAt: '2026-08-25T01:02:03.000Z',
      errorCode: 'DISK_FULL',
    })
    tracker.record(Object.assign(new Error('denied'), { code: 'EPERM' }))
    expect(tracker.snapshot()).toEqual({
      lastFailureAt: '2026-08-25T04:05:06.000Z',
      errorCode: 'PERMISSION_DENIED',
    })
    expect(tracker.snapshot()).not.toHaveProperty('message')

    tracker.clear()
    expect(tracker.snapshot()).toEqual({ lastFailureAt: null, errorCode: null })
  })

  it('records a failed operation and clears it only after a backup is created', async () => {
    const tracker = createWeeklyBackupStatusTracker({
      now: () => new Date('2026-08-25T08:09:10.000Z'),
    })
    const failure = Object.assign(new Error('full'), { code: 'ENOSPC' })
    await expect(runTrackedWeeklyBackup(async () => { throw failure }, tracker)).rejects.toBe(failure)
    expect(tracker.snapshot().errorCode).toBe('DISK_FULL')

    await runTrackedWeeklyBackup(async () => ({ created: false, reason: 'not-due' }), tracker)
    expect(tracker.snapshot().errorCode).toBe('DISK_FULL')

    await runTrackedWeeklyBackup(async () => ({ created: true, filename: 'weekly.json' }), tracker)
    expect(tracker.snapshot()).toEqual({ lastFailureAt: null, errorCode: null })
  })
})
