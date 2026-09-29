const { contextBridge, ipcRenderer } = require('electron')

const channels = Object.freeze({
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

const desktopApi = Object.freeze({
  saveFile(request) {
    return ipcRenderer.invoke(channels.saveFile, request)
  },

  print(request) {
    return ipcRenderer.invoke(channels.print, request)
  },

  savePdf(request) {
    return ipcRenderer.invoke(channels.savePdf, request)
  },

  setTheme(theme) {
    return ipcRenderer.invoke(channels.setTheme, theme)
  },

  createWeeklyBackupIfDue(force = false) {
    return ipcRenderer.invoke(channels.weeklyBackup, { force })
  },

  getWeeklyBackupStatus() {
    return ipcRenderer.invoke(channels.weeklyBackupStatus)
  },

  getApiSessionToken() {
    return ipcRenderer.invoke(channels.apiSessionToken)
  },

  openWeeklyBackupFolder() {
    return ipcRenderer.invoke(channels.openWeeklyBackupFolder)
  },

  onCloseRequested(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function')
    const listener = (_event, request) => {
      const requestId = typeof request === 'string' ? request : request?.requestId
      if (typeof requestId === 'string') callback(requestId)
    }
    ipcRenderer.on(channels.closeRequested, listener)
    return () => ipcRenderer.removeListener(channels.closeRequested, listener)
  },

  onCloseCancelled(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function')
    const listener = (_event, cancellation) => {
      const requestId = typeof cancellation === 'string' ? cancellation : cancellation?.requestId
      if (typeof requestId === 'string') callback(requestId)
    }
    ipcRenderer.on(channels.closeCancelled, listener)
    return () => ipcRenderer.removeListener(channels.closeCancelled, listener)
  },

  completeClose(result) {
    return ipcRenderer.invoke(channels.closeComplete, result)
  },
})

contextBridge.exposeInMainWorld('jigongbenDesktop', desktopApi)
