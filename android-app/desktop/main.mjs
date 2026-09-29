import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
} from 'electron'
import squirrelStartup from 'electron-squirrel-startup'
import { startServer } from '../server/app.mjs'
import { atomicReplaceFile } from './atomic-file.mjs'
import {
  errorMessage,
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
  validateTheme,
  validateWeeklyBackupRequest,
} from './bridge-contract.mjs'
import { createCloseHandshake } from './close-handshake.mjs'
import { createRendererRecoveryController } from './renderer-recovery.mjs'
import {
  createWeeklyBackupStatusTracker,
  runTrackedWeeklyBackup,
  WEEKLY_BACKUP_FAILURE_CODES,
} from './weekly-backup-status.mjs'

const APP_USER_MODEL_ID = 'com.lq.jigongben'
const SERVER_CLOSE_TIMEOUT_MS = 5_000
const WEEKLY_BACKUP_POLL_INTERVAL_MS = 60 * 60 * 1_000

let mainWindow = null
let closeController = null
let runningServer = null
let allowedOrigin = null
let removeIpcHandlers = null
let serverStopPromise = null
let serverStopped = false
let weeklyBackupTimer = null
let appIsQuitting = false
let apiSessionToken = null
const weeklyBackupStatus = createWeeklyBackupStatusTracker()

app.on('before-quit', () => {
  appIsQuitting = true
})

function applyNativeTheme(theme) {
  const validated = validateTheme(theme)
  nativeTheme.themeSource = validated
  return validated
}

function requireTrustedEvent(event) {
  if (!isTrustedIpcEvent(event, mainWindow, allowedOrigin)) {
    throw new Error('已拒绝来自非记工本页面的桌面权限请求')
  }
  return mainWindow
}

function weeklyBackupDirectory() {
  const smokeDocuments = process.env.LQ_JIGONGBEN_TEST_DOCUMENTS
  const documentsPath =
    process.env.LQ_JIGONGBEN_DESKTOP_SMOKE === '1' && smokeDocuments
      ? path.resolve(smokeDocuments)
      : app.getPath('documents')
  return resolveWeeklyBackupDirectory(documentsPath)
}

async function createWeeklyBackupIfDue(force = false) {
  const result = await runTrackedWeeklyBackup(async () => {
    const store = runningServer?.app?.store
    if (!store?.createWeeklyBackupIfDue) {
      const unavailable = new Error('每周备份服务尚未就绪')
      unavailable.code = WEEKLY_BACKUP_FAILURE_CODES.backupServiceUnavailable
      throw unavailable
    }
    return store.createWeeklyBackupIfDue({
      backupDir: weeklyBackupDirectory(),
      force,
    })
  }, weeklyBackupStatus)
  if (result.created) {
    console.log(`[L.Q记工本] 每周备份已创建：${result.filename}`)
  }
  return {
    created: result.created,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.nextDueAt ? { nextDueAt: result.nextDueAt } : {}),
    ...(result.createdAt ? { createdAt: result.createdAt } : {}),
    ...(result.filename ? { filename: result.filename } : {}),
    ...(result.revision ? { revision: result.revision } : {}),
  }
}

function stopWeeklyBackupChecks() {
  if (weeklyBackupTimer) clearInterval(weeklyBackupTimer)
  weeklyBackupTimer = null
}

function startWeeklyBackupChecks() {
  stopWeeklyBackupChecks()
  const check = () => {
    void createWeeklyBackupIfDue(false).catch((error) => {
      console.error('[L.Q记工本] 自动每周备份失败：', errorMessage(error))
    })
  }
  weeklyBackupTimer = setInterval(check, WEEKLY_BACKUP_POLL_INTERVAL_MS)
  weeklyBackupTimer.unref?.()
}

async function chooseSavePath(window, filename, filter) {
  const result = await dialog.showSaveDialog(window, {
    title: '保存文件',
    defaultPath: path.join(app.getPath('documents'), filename),
    buttonLabel: '保存',
    filters: [filter],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  })
  if (result.canceled || !result.filePath) return null
  return result.filePath
}

async function persistExternalFile(filePath, bytes) {
  try {
    await atomicReplaceFile(filePath, bytes)
  } catch (error) {
    throw externalFileWriteError(error)
  }
}

function printWindow(window, options) {
  return new Promise((resolve, reject) => {
    window.webContents.print(
      { silent: false, printBackground: true, landscape: options.landscape, pageSize: 'A4' },
      (success, failureReason) => {
        if (success || /cancel/i.test(failureReason || '')) {
          resolve()
        } else {
          reject(new Error(failureReason || '系统打印失败'))
        }
      },
    )
  })
}

function registerIpc() {
  const handleSaveFile = async (event, request) => {
    const window = requireTrustedEvent(event)
    const validated = validateSaveFileRequest(request)
    const chosenPath = await chooseSavePath(window, validated.filename, validated.config.filter)
    if (!chosenPath) return { canceled: true }
    const filePath = validateSelectedPath(chosenPath, validated.config.extension)
    await persistExternalFile(filePath, validated.bytes)
    return { canceled: false, filePath }
  }

  const handlePrint = async (event, request) => {
    const window = requireTrustedEvent(event)
    await printWindow(window, validatePrintRequest(request))
  }

  const handleSavePdf = async (event, request) => {
    const window = requireTrustedEvent(event)
    const { filename, landscape } = validatePdfRequest(request)
    const chosenPath = await chooseSavePath(window, filename, {
      name: 'PDF 文档',
      extensions: ['pdf'],
    })
    if (!chosenPath) return { canceled: true }
    const filePath = validateSelectedPath(chosenPath, '.pdf')
    const bytes = await window.webContents.printToPDF({
      landscape,
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    })
    await persistExternalFile(filePath, bytes)
    return { canceled: false, filePath }
  }

  const handleSetTheme = async (event, theme) => {
    const window = requireTrustedEvent(event)
    const validated = applyNativeTheme(theme)
    window.setBackgroundColor(validated === 'dark' ? '#151b18' : '#f4f7f2')
  }

  const handleWeeklyBackup = async (event, request) => {
    requireTrustedEvent(event)
    const { force } = validateWeeklyBackupRequest(request)
    return createWeeklyBackupIfDue(force)
  }

  const handleWeeklyBackupStatus = async (event) => {
    requireTrustedEvent(event)
    return weeklyBackupStatus.snapshot()
  }

  const handleApiSessionToken = async (event) => {
    requireTrustedEvent(event)
    if (!apiSessionToken) throw new Error('桌面会话尚未就绪')
    return apiSessionToken
  }

  const handleOpenWeeklyBackupFolder = async (event) => {
    requireTrustedEvent(event)
    const directory = weeklyBackupDirectory()
    await mkdir(directory, { recursive: true })
    const failure = await shell.openPath(directory)
    if (failure) throw new Error(`无法打开每周备份目录：${failure}`)
    return { opened: true }
  }

  const handleCloseComplete = async (event, rawResult) => {
    requireTrustedEvent(event)
    const result = validateCloseCompletion(rawResult)
    const acknowledgement = closeController?.complete(result) ?? {
      accepted: false,
      requestId: result.requestId,
      status: 'inactive',
    }
    if (!acknowledgement.accepted) {
      console.warn(
        `[L.Q记工本] 关闭完成消息未被接受：requestId=${result.requestId}, status=${acknowledgement.status}`,
      )
    }
    return acknowledgement
  }

  ipcMain.handle(IPC_CHANNELS.saveFile, handleSaveFile)
  ipcMain.handle(IPC_CHANNELS.print, handlePrint)
  ipcMain.handle(IPC_CHANNELS.savePdf, handleSavePdf)
  ipcMain.handle(IPC_CHANNELS.setTheme, handleSetTheme)
  ipcMain.handle(IPC_CHANNELS.weeklyBackup, handleWeeklyBackup)
  ipcMain.handle(IPC_CHANNELS.weeklyBackupStatus, handleWeeklyBackupStatus)
  ipcMain.handle(IPC_CHANNELS.apiSessionToken, handleApiSessionToken)
  ipcMain.handle(IPC_CHANNELS.openWeeklyBackupFolder, handleOpenWeeklyBackupFolder)
  ipcMain.handle(IPC_CHANNELS.closeComplete, handleCloseComplete)

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.saveFile)
    ipcMain.removeHandler(IPC_CHANNELS.print)
    ipcMain.removeHandler(IPC_CHANNELS.savePdf)
    ipcMain.removeHandler(IPC_CHANNELS.setTheme)
    ipcMain.removeHandler(IPC_CHANNELS.weeklyBackup)
    ipcMain.removeHandler(IPC_CHANNELS.weeklyBackupStatus)
    ipcMain.removeHandler(IPC_CHANNELS.apiSessionToken)
    ipcMain.removeHandler(IPC_CHANNELS.openWeeklyBackupFolder)
    ipcMain.removeHandler(IPC_CHANNELS.closeComplete)
  }
}

function createCloseController(window) {
  let allowClose = false
  let showingFailureDialog = false

  const forceClose = () => {
    allowClose = true
    if (!window.isDestroyed()) window.close()
  }

  const notifyCloseCancelled = (requestId) => {
    if (
      typeof requestId !== 'string' ||
      mainWindow !== window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    ) {
      return false
    }
    window.webContents.send(IPC_CHANNELS.closeCancelled, { requestId })
    return true
  }

  const showFailure = async (reason, context = {}) => {
    if (showingFailureDialog || window.isDestroyed()) return
    const requestId = typeof context?.requestId === 'string' ? context.requestId : null
    showingFailureDialog = true
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title: '保存尚未完成',
        message: '关闭前未能完成数据保存。',
        detail: reason || '未知保存错误',
        buttons: ['重试保存并退出', '取消关闭', '强制退出'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (result.response === 0) {
        showingFailureDialog = false
        requestFlush()
        return
      }
      if (result.response === 1) notifyCloseCancelled(requestId)
      if (result.response === 2) forceClose()
    } catch (error) {
      console.error('[L.Q记工本] 无法显示关闭确认对话框：', errorMessage(error))
    } finally {
      showingFailureDialog = false
    }
  }

  const handshake = createCloseHandshake({
    sendRequest: (request) => window.webContents.send(IPC_CHANNELS.closeRequested, request),
    onAccepted: forceClose,
    onRejected: (reason, context) => showFailure(reason, context),
    onTimeout: (context) => showFailure('等待数据保存超时（25 秒）。', context),
    onSendError: (error, context) => showFailure(errorMessage(error), context),
  })

  const requestFlush = () => {
    if (showingFailureDialog || window.isDestroyed()) return
    if (window.webContents.isDestroyed()) {
      void showFailure('界面进程已结束，无法确认待保存内容。')
      return
    }
    handshake.request()
  }

  const handleClose = (event) => {
    if (allowClose) return
    event.preventDefault()
    requestFlush()
  }

  window.on('close', handleClose)
  window.once('closed', () => handshake.dispose())
  return {
    cancelPending: () => handshake.cancel('renderer-gone'),
    complete: (result) => handshake.complete(result),
    requestFlush,
  }
}

function rendererFailureDetail(context) {
  const details = context?.details ?? {}
  const lines = [
    `原因：${typeof details.reason === 'string' ? details.reason : 'unknown'}`,
    ...(Number.isInteger(details.exitCode) ? [`退出代码：${details.exitCode}`] : []),
    ...(context?.error ? [`重新加载错误：${context.error}`] : []),
  ]
  return lines.join('\n')
}

async function showRendererRecovered(window, context) {
  if (process.env.LQ_JIGONGBEN_DESKTOP_SMOKE === '1' || window.isDestroyed()) return
  await dialog.showMessageBox(window, {
    type: 'warning',
    title: '界面已恢复',
    message: context?.automatic
      ? '记工本界面异常退出后已自动重新加载。'
      : '记工本界面已重新加载。',
    detail:
      '本机服务和已经保存的数据仍然保留。崩溃前尚未显示“已保存”的修改，以及撤销历史，可能需要重新操作。',
    buttons: ['知道了'],
    defaultId: 0,
    noLink: true,
  })
}

async function chooseRendererRecovery(window, context) {
  if (window.isDestroyed()) return 'exit'
  if (process.env.LQ_JIGONGBEN_DESKTOP_SMOKE === '1') return 'exit'
  const result = await dialog.showMessageBox(window, {
    type: 'error',
    title: '界面再次异常退出',
    message: '为避免反复重载，记工本已暂停自动恢复。',
    detail: `${rendererFailureDetail(context)}\n\n已经保存的数据仍然保留。`,
    buttons: ['再次尝试', '退出'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  return result.response === 0 ? 'retry' : 'exit'
}

async function chooseUnresponsiveAction(window) {
  if (window.isDestroyed() || appIsQuitting) return 'wait'
  if (process.env.LQ_JIGONGBEN_DESKTOP_SMOKE === '1') return 'wait'
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    title: '界面暂时没有响应',
    message: '记工本可能正在处理或保存数据。',
    detail:
      '建议继续等待；系统恢复响应时不会自动重载界面。强制退出可能丢失尚未显示“已保存”的修改。',
    buttons: ['继续等待', '强制退出'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  return result.response === 1 ? 'exit' : 'wait'
}

function secureRendererSession(window) {
  const rendererSession = window.webContents.session
  rendererSession.setPermissionCheckHandler(() => false)
  rendererSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  rendererSession.on('will-download', (event) => event.preventDefault())
  rendererSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false
    try {
      const url = new URL(details.url)
      allowed =
        (url.protocol === 'http:' && url.origin === allowedOrigin) ||
        url.protocol === 'data:' ||
        url.protocol === 'blob:'
    } catch {
      allowed = false
    }
    callback({ cancel: !allowed })
  })
}

async function createMainWindow(theme = 'light') {
  const validatedTheme = applyNativeTheme(theme)
  const window = new BrowserWindow({
    title: 'L.Q记工本',
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: validatedTheme === 'dark' ? '#151b18' : '#f4f7f2',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'desktop', 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  mainWindow = window
  const windowCloseController = createCloseController(window)
  closeController = windowCloseController
  secureRendererSession(window)

  const blockUnexpectedNavigation = (event, targetUrl) => {
    const navigationUrl = typeof event.url === 'string' ? event.url : targetUrl
    if (!isAllowedAppUrl(navigationUrl, allowedOrigin)) event.preventDefault()
  }
  window.webContents.on('will-navigate', blockUnexpectedNavigation)
  window.webContents.on('will-redirect', blockUnexpectedNavigation)
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show()
      window.focus()
      if (!window.webContents.isDestroyed()) window.webContents.focus()
    }
  })
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
      closeController = null
    }
  })

  const rendererUrl = new URL(runningServer.url)
  rendererUrl.searchParams.set('theme', validatedTheme)
  await window.loadURL(rendererUrl.href)

  const rendererRecovery = createRendererRecoveryController({
    isQuitting: () => appIsQuitting,
    isWindowDestroyed: () => window.isDestroyed(),
    cancelPendingClose: () => windowCloseController.cancelPending(),
    loadRenderer: async () => {
      if (window.isDestroyed()) throw new Error('主窗口已经关闭')
      await window.loadURL(rendererUrl.href)
    },
    showRecovered: (context) => showRendererRecovered(window, context),
    showManualRecovery: (context) => chooseRendererRecovery(window, context),
    showUnresponsive: () => chooseUnresponsiveAction(window),
    exitApplication: () => {
      appIsQuitting = true
      windowCloseController.cancelPending()
      if (!window.isDestroyed()) window.destroy()
      app.quit()
    },
    reportError: (error, stage) => {
      console.error(`[L.Q记工本] 渲染器恢复失败（${stage}）：`, errorMessage(error))
    },
  })
  const handleRendererGone = (_event, details) => {
    if (details.reason !== 'clean-exit' && !appIsQuitting && !window.isDestroyed()) {
      console.error(
        `[L.Q记工本] 界面进程异常退出：reason=${details.reason}, exitCode=${details.exitCode}`,
      )
    }
    void rendererRecovery.handleRenderProcessGone(details).catch((error) => {
      console.error('[L.Q记工本] 无法处理界面进程退出：', errorMessage(error))
    })
  }
  window.webContents.on('render-process-gone', handleRendererGone)
  const handleUnresponsive = () => {
    void rendererRecovery.handleUnresponsive().catch((error) => {
      console.error('[L.Q记工本] 无法处理界面未响应状态：', errorMessage(error))
    })
  }
  const handleResponsive = () => {
    const result = rendererRecovery.handleResponsive()
    if (result.status === 'responsive') {
      console.log('[L.Q记工本] 界面已恢复响应，继续使用当前渲染进程。')
    }
  }
  window.on('unresponsive', handleUnresponsive)
  window.on('responsive', handleResponsive)
  window.once('closed', () => rendererRecovery.dispose())
  return window
}

function closeHttpServer(server) {
  if (!server || !server.listening) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    let forcedFinish
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(forcedFinish)
      resolve()
    }
    const timeout = setTimeout(() => {
      server.closeAllConnections?.()
      // closeAllConnections normally makes the close callback run
      // immediately. Keep a short final fallback for a broken native socket.
      forcedFinish = setTimeout(finish, 250)
      forcedFinish.unref?.()
    }, SERVER_CLOSE_TIMEOUT_MS)
    timeout.unref?.()
    server.close(finish)
    server.closeIdleConnections?.()
  })
}

function stopServer() {
  if (!serverStopPromise) {
    serverStopPromise = closeHttpServer(runningServer?.server).finally(() => {
      serverStopped = true
    })
  }
  return serverStopPromise
}

async function showStartupError(error) {
  const message = errorMessage(error)
  if (app.isReady()) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'L.Q记工本启动失败',
      message: '无法启动本地记工服务。',
      detail: message,
      buttons: ['确定'],
      noLink: true,
    })
  } else {
    dialog.showErrorBox('L.Q记工本启动失败', message)
  }
}

async function bootstrap() {
  await app.whenReady()
  Menu.setApplicationMenu(null)

  const rootDir = app.getAppPath()
  const dataDir = resolveDataDirectory(app.getPath('userData'))
  apiSessionToken = randomBytes(32).toString('base64url')
  runningServer = await startServer({
    host: '127.0.0.1',
    port: 0,
    endPort: 0,
    reuseExisting: false,
    rootDir,
    dataDir,
    distDir: path.join(rootDir, 'dist'),
    sessionToken: apiSessionToken,
  })
  allowedOrigin = new URL(runningServer.url).origin
  runningServer.server.on('error', (error) => {
    if (!serverStopPromise) {
      void showStartupError(error).catch(() => {}).finally(() => app.quit())
    }
  })

  removeIpcHandlers = registerIpc()
  await createWeeklyBackupIfDue(false).catch((error) => {
    console.error('[L.Q记工本] 启动时自动每周备份失败：', errorMessage(error))
  })
  startWeeklyBackupChecks()
  let startupTheme = 'light'
  try {
    startupTheme = runningServer.app?.store?.getState?.().settings?.theme === 'dark' ? 'dark' : 'light'
  } catch {
    // Corrupt-data recovery still opens with a safe light background.
  }
  await createMainWindow(startupTheme)
}

if (squirrelStartup) {
  app.quit()
} else {
  app.setAppUserModelId(APP_USER_MODEL_ID)
  const hasSingleInstanceLock = app.requestSingleInstanceLock()
  if (!hasSingleInstanceLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      if (!mainWindow.webContents.isDestroyed()) mainWindow.webContents.focus()
    })

    app.on('window-all-closed', () => app.quit())
    app.on('will-quit', (event) => {
      stopWeeklyBackupChecks()
      if (serverStopped || !runningServer?.server) {
        removeIpcHandlers?.()
        removeIpcHandlers = null
        return
      }
      event.preventDefault()
      void stopServer().finally(() => {
        removeIpcHandlers?.()
        removeIpcHandlers = null
        app.quit()
      })
    })

    bootstrap().catch(async (error) => {
      await showStartupError(error).catch(() => {})
      // A page that never loaded cannot answer the close-flush handshake. At
      // this point the window has never been shown and contains no user edits.
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
      await stopServer().catch(() => {})
      app.quit()
    })
  }
}
