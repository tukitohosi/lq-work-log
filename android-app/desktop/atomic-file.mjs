import { randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import path from 'node:path'

function asBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new TypeError('待保存内容必须是二进制数据')
}

function temporaryPathFor(targetPath, uniqueId) {
  const directory = path.dirname(targetPath)
  const filename = path.basename(targetPath)
  return path.join(directory, `.${filename}.${process.pid}.${uniqueId}.tmp`)
}

/**
 * Durably replaces an external user-selected file.
 *
 * The temporary file is deliberately created beside the destination so the
 * final rename stays on one filesystem. The old destination remains intact if
 * writing, fsync or rename fails, and a failed temporary file is best-effort
 * removed before the original error is rethrown.
 */
export async function atomicReplaceFile(target, value, options = {}) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new TypeError('目标文件路径无效')
  }
  const targetPath = path.resolve(target)
  const bytes = asBytes(value)
  if (bytes.byteLength === 0) throw new RangeError('待保存内容不能为空')

  const openFile = options.openFile ?? open
  const renameFile = options.renameFile ?? rename
  const removeFile = options.removeFile ?? rm
  const uniqueId = (options.uniqueId ?? randomUUID)()
  const temporaryPath = temporaryPathFor(targetPath, uniqueId)
  let handle = null

  try {
    handle = await openFile(temporaryPath, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await renameFile(temporaryPath, targetPath)
    return targetPath
  } catch (error) {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // Preserve the primary write/fsync/rename error.
      }
    }
    try {
      await removeFile(temporaryPath, { force: true })
    } catch {
      // Best-effort cleanup must not hide the primary failure.
    }
    throw error
  }
}
