// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import {
  EXTERNAL_FILE_WRITE_ERROR_CODES,
  externalFileWriteError,
  IPC_CHANNELS,
  isAllowedAppUrl,
  isTrustedIpcEvent,
  resolveDataDirectory,
  resolveWeeklyBackupDirectory,
  validateCloseCompletion,
  validatePdfRequest,
  validatePrintRequest,
  validateSaveFileRequest,
  validateSelectedPath,
  validateSuggestedFilename,
  validateWeeklyBackupRequest,
} from '../desktop/bridge-contract.mjs'

describe('Electron desktop bridge contract', () => {
  it('keeps the exposed IPC surface small and explicit', () => {
    expect(IPC_CHANNELS).toEqual({
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
  })

  it('keeps the sandboxed preload channel names aligned with the main-process contract', async () => {
    const preloadSource = await readFile(
      new URL('../desktop/preload.mjs', import.meta.url),
      'utf8',
    )
    for (const channel of Object.values(IPC_CHANNELS)) {
      expect(preloadSource).toContain(`'${channel}'`)
    }
    expect(preloadSource).not.toContain('ipcRenderer:')
  })

  it('subscribes to close cancellation by request ID and removes the exact listener', async () => {
    const preloadSource = await readFile(
      new URL('../desktop/preload.mjs', import.meta.url),
      'utf8',
    )
    const listeners = new Map()
    let exposedApi
    const ipcRenderer = {
      invoke() {},
      on(channel, listener) {
        listeners.set(channel, listener)
      },
      removeListener(channel, listener) {
        if (listeners.get(channel) === listener) listeners.delete(channel)
      },
    }
    vm.runInNewContext(preloadSource, {
      require(specifier) {
        if (specifier !== 'electron') throw new Error(`unexpected require: ${specifier}`)
        return {
          contextBridge: {
            exposeInMainWorld(name, api) {
              expect(name).toBe('jigongbenDesktop')
              exposedApi = api
            },
          },
          ipcRenderer,
        }
      },
    })

    const received = []
    const remove = exposedApi.onCloseCancelled((requestId) => received.push(requestId))
    const listener = listeners.get(IPC_CHANNELS.closeCancelled)
    expect(typeof listener).toBe('function')
    listener({}, { requestId: '66b0fd1a-8f93-4c1a-8d87-23fb692dc3dd' })
    listener({}, { ignored: true })
    expect(received).toEqual(['66b0fd1a-8f93-4c1a-8d87-23fb692dc3dd'])

    remove()
    expect(listeners.has(IPC_CHANNELS.closeCancelled)).toBe(false)
  })

  it('keeps Electron native chrome and the window background aligned with the validated theme', async () => {
    const mainSource = await readFile(
      new URL('../desktop/main.mjs', import.meta.url),
      'utf8',
    )

    expect(mainSource).toContain('nativeTheme,')
    expect(mainSource).toContain('nativeTheme.themeSource = validated')
    expect(mainSource).toContain('const validated = applyNativeTheme(theme)')
    expect(mainSource).toContain('const validatedTheme = applyNativeTheme(theme)')
    expect(mainSource).toContain(
      "backgroundColor: validatedTheme === 'dark' ? '#151b18' : '#f4f7f2'",
    )
    expect(mainSource).toContain(
      "window.setBackgroundColor(validated === 'dark' ? '#151b18' : '#f4f7f2')",
    )
    expect(mainSource).toContain("rendererUrl.searchParams.set('theme', validatedTheme)")
  })

  it('recovers only the trusted main renderer without restarting the local service', async () => {
    const mainSource = await readFile(
      new URL('../desktop/main.mjs', import.meta.url),
      'utf8',
    )

    expect(mainSource).toContain("window.webContents.on('render-process-gone'")
    expect(mainSource).toContain('createRendererRecoveryController({')
    expect(mainSource).toContain('windowCloseController.cancelPending()')
    expect(mainSource).toContain('await window.loadURL(rendererUrl.href)')
    expect(mainSource).toContain("app.on('before-quit'")
    expect(mainSource).not.toContain("app.on('render-process-gone'")
  })

  it('places production data below Electron userData', () => {
    const userData = path.join('C:\\Users', 'Example', 'AppData', 'Roaming', 'L.Q记工本')
    expect(resolveDataDirectory(userData)).toBe(path.resolve(userData, 'data'))
  })

  it('keeps the weekly backup target below Documents without accepting a renderer path', async () => {
    const documents = path.join('C:\\Users', 'Example', 'Documents')
    expect(resolveWeeklyBackupDirectory(documents)).toBe(
      path.resolve(documents, 'L.Q记工本备份'),
    )
    expect(validateWeeklyBackupRequest(undefined)).toEqual({ force: false })
    expect(validateWeeklyBackupRequest({ force: true })).toEqual({ force: true })
    expect(() => validateWeeklyBackupRequest({ force: 'yes' })).toThrow('布尔值')
    expect(() => validateWeeklyBackupRequest({ force: true, path: 'C:\\tmp' })).toThrow('不允许')

    const preloadSource = await readFile(
      new URL('../desktop/preload.mjs', import.meta.url),
      'utf8',
    )
    expect(preloadSource).toContain('createWeeklyBackupIfDue(force = false)')
    expect(preloadSource).toContain('getWeeklyBackupStatus()')
    expect(preloadSource).toContain('openWeeklyBackupFolder()')
    expect(preloadSource).not.toContain('createWeeklyBackupIfDue(path')
  })

  it('accepts valid JSON text and XLSX bytes with matching safe filenames', () => {
    const json = validateSaveFileRequest({
      kind: 'json',
      filename: '李权_2026-08_备份.json',
      data: '{"schemaVersion":2}',
    })
    expect(json.kind).toBe('json')
    expect(json.bytes.toString('utf8')).toBe('{"schemaVersion":2}')

    const source = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    const xlsx = validateSaveFileRequest({
      kind: 'xlsx',
      filename: '李权_2026年8月记工表.xlsx',
      data: source,
    })
    expect([...xlsx.bytes]).toEqual([...source])

    const backing = new Uint8Array([0, 0x50, 0x4b, 0])
    const sliced = validateSaveFileRequest({
      kind: 'xlsx',
      filename: '跨隔离区.xlsx',
      data: backing.subarray(1, 3),
    })
    expect([...sliced.bytes]).toEqual([0x50, 0x4b])

    const crossRealmBytes = vm.runInNewContext('new Uint8Array([80, 75, 3, 4])')
    const crossRealm = validateSaveFileRequest({
      kind: 'xlsx',
      filename: '跨隔离区工作簿.xlsx',
      data: crossRealmBytes,
    })
    expect([...crossRealm.bytes]).toEqual([0x50, 0x4b, 0x03, 0x04])
  })

  it('rejects path traversal, mismatched extensions, unknown kinds and wrong payload types', () => {
    expect(() => validateSuggestedFilename('..\\records.json', '.json')).toThrow('文件名无效')
    expect(() => validateSuggestedFilename('records.xlsx', '.json')).toThrow('.json')
    expect(() => validateSelectedPath('C:\\tmp\\records.exe', '.json')).toThrow('.json')
    expect(() =>
      validateSaveFileRequest({ kind: 'html', filename: 'records.html', data: '<html>' }),
    ).toThrow('JSON')
    expect(() =>
      validateSaveFileRequest({ kind: 'json', filename: 'records.json', data: new Uint8Array([1]) }),
    ).toThrow('文本')
    expect(() =>
      validateSaveFileRequest({ kind: 'xlsx', filename: 'records.xlsx', data: 'not binary' }),
    ).toThrow('二进制')
    expect(() =>
      validateSaveFileRequest({ kind: 'json', filename: 'records.json', data: '{broken' }),
    ).toThrow('内容无效')
  })

  it('maps native save failures to actionable messages without exposing filesystem paths', () => {
    const privatePath = 'C:\\Users\\Example\\Documents\\.工资条.xlsx.123.tmp'
    const cases = [
      ['ENOSPC', EXTERNAL_FILE_WRITE_ERROR_CODES.diskFull, '磁盘空间'],
      ['EDQUOT', EXTERNAL_FILE_WRITE_ERROR_CODES.diskFull, '存储配额'],
      ['EIO', EXTERNAL_FILE_WRITE_ERROR_CODES.ioError, 'I/O'],
      ['EACCES', EXTERNAL_FILE_WRITE_ERROR_CODES.permissionDenied, '没有写入权限'],
      ['EPERM', EXTERNAL_FILE_WRITE_ERROR_CODES.permissionDenied, '没有写入权限'],
      ['EROFS', EXTERNAL_FILE_WRITE_ERROR_CODES.readOnlyFilesystem, '只读'],
      ['EBUSY', EXTERNAL_FILE_WRITE_ERROR_CODES.fileBusy, '被其他程序占用'],
      ['ETXTBSY', EXTERNAL_FILE_WRITE_ERROR_CODES.fileBusy, '被其他程序占用'],
      ['UNKNOWN_NATIVE_FAILURE', EXTERNAL_FILE_WRITE_ERROR_CODES.unknown, '文件未被占用'],
    ]

    for (const [nativeCode, expectedCode, expectedText] of cases) {
      const nativeError = Object.assign(new Error(`native failure at ${privatePath}`), {
        code: nativeCode,
        path: privatePath,
      })
      const mapped = externalFileWriteError(nativeError)
      expect(mapped).toMatchObject({
        name: 'ExternalFileWriteError',
        code: expectedCode,
      })
      expect(mapped.message).toContain(expectedText)
      expect(mapped.message).not.toContain(privatePath)
      expect(mapped).not.toHaveProperty('path')
      expect(mapped).not.toHaveProperty('cause')
    }
  })

  it('only trusts the main frame on the running loopback origin', () => {
    const origin = 'http://127.0.0.1:43127'
    const mainFrame = { url: `${origin}/` }
    const webContents = { mainFrame, isDestroyed: () => false }
    const window = { webContents, isDestroyed: () => false }
    const event = { sender: webContents, senderFrame: mainFrame }

    expect(isAllowedAppUrl(`${origin}/api/status`, origin)).toBe(true)
    expect(isAllowedAppUrl('https://example.com/', origin)).toBe(false)
    expect(isTrustedIpcEvent(event, window, origin)).toBe(true)
    expect(
      isTrustedIpcEvent(
        { sender: webContents, senderFrame: { url: `${origin}/embedded` } },
        window,
        origin,
      ),
    ).toBe(false)
    expect(
      isTrustedIpcEvent(
        { sender: webContents, senderFrame: { url: 'https://example.com/' } },
        window,
        origin,
      ),
    ).toBe(false)
  })

  it('validates PDF options and close-flush replies', () => {
    expect(validatePdfRequest(undefined)).toEqual({ filename: '记工表.pdf', landscape: true })
    expect(validatePdfRequest({ filename: '李权_2026-08.pdf' })).toEqual({
      filename: '李权_2026-08.pdf',
      landscape: true,
    })
    expect(validatePdfRequest({ filename: '李权_2026-08.pdf', landscape: false })).toEqual({
      filename: '李权_2026-08.pdf',
      landscape: false,
    })
    expect(validatePrintRequest({ landscape: false })).toEqual({ landscape: false })
    expect(() => validatePrintRequest({ landscape: 'portrait' })).toThrow('方向')
    expect(() => validatePdfRequest({ filename: '李权_2026-08.exe' })).toThrow('.pdf')

    const completion = {
      requestId: '66b0fd1a-8f93-4c1a-8d87-23fb692dc3dd',
      ok: false,
      error: '保存失败',
    }
    expect(validateCloseCompletion(completion)).toEqual(completion)
    expect(() => validateCloseCompletion({ requestId: 'wrong', ok: true })).toThrow('ID')
    expect(() =>
      validateCloseCompletion({ ...completion, ok: 'yes' }),
    ).toThrow('状态')
  })

  it('uses durable atomic replacement, acknowledges close IDs and observes unresponsive windows', async () => {
    const [mainSource, preloadSource] = await Promise.all([
      readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../desktop/preload.mjs', import.meta.url), 'utf8'),
    ])

    expect(mainSource).toContain('await persistExternalFile(filePath, validated.bytes)')
    expect(mainSource).toContain('await persistExternalFile(filePath, bytes)')
    expect(mainSource).toContain('throw externalFileWriteError(error)')
    expect(mainSource).not.toContain('await writeFile(filePath')
    expect(mainSource).toContain("if (!chosenPath) return { canceled: true }")
    expect(mainSource).toContain("window.on('unresponsive', handleUnresponsive)")
    expect(mainSource).toContain("window.on('responsive', handleResponsive)")
    expect(mainSource).toContain('IPC_CHANNELS.weeklyBackupStatus')
    expect(mainSource).toContain('onRejected: (reason, context) => showFailure(reason, context)')
    expect(mainSource).toContain("onTimeout: (context) => showFailure('等待数据保存超时（25 秒）。', context)")
    expect(mainSource).toContain('onSendError: (error, context) => showFailure(errorMessage(error), context)')
    expect(mainSource).toContain('mainWindow !== window')
    expect(mainSource).toContain('window.webContents.send(IPC_CHANNELS.closeCancelled, { requestId })')
    expect(preloadSource).toContain('onCloseCancelled(callback)')
    expect(preloadSource).toContain('ipcRenderer.on(channels.closeCancelled, listener)')
    expect(preloadSource).toContain('ipcRenderer.removeListener(channels.closeCancelled, listener)')
    expect(preloadSource).toContain('return ipcRenderer.invoke(channels.closeComplete, result)')
  })
})
