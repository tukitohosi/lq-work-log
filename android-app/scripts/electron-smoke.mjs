import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { recordDesktopSmoke } from './finalize-release.mjs'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const executablePath = path.join(projectRoot, 'out', 'L.Q记工本-win32-x64', 'L.Q记工本.exe')
const smokeRoot = await mkdtemp(path.join(os.tmpdir(), 'lq-jigongben-electron-smoke-'))
const smokeUserData = path.join(smokeRoot, 'user-data')
const smokeDocuments = path.join(smokeRoot, 'Documents')
const weeklyBackupDir = path.join(smokeDocuments, 'L.Q记工本备份')
const exportDirectory = path.join(smokeRoot, 'exports')
const smokeEnv = {
  ...process.env,
  APPDATA: path.join(smokeRoot, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(smokeRoot, 'AppData', 'Local'),
  LQ_JIGONGBEN_DESKTOP_SMOKE: '1',
  LQ_JIGONGBEN_TEST_DOCUMENTS: smokeDocuments,
}
const workerName = `桌面打包验证-${Date.now()}`
const now = new Date()
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
const note = '关闭窗口前立即保存的备注'
const monthlyRate = '317.25'
const monthlyRateFen = 31_725
let firstApp
let secondApp
let succeeded = false

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('第二个实例未按预期自动退出'))
    }, timeoutMs)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (signal || code !== 0) reject(new Error(`第二个实例异常退出：code=${code}, signal=${signal}`))
      else resolve()
    })
  })
}

async function findFiles(directory, basename) {
  const matches = []
  let entries = []
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return matches
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) matches.push(...(await findFiles(fullPath, basename)))
    else if (entry.isFile() && entry.name.toLowerCase() === basename.toLowerCase()) matches.push(fullPath)
  }
  return matches
}

async function waitForXlsxFile(filePath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const fileStat = await stat(filePath)
      if (fileStat.isFile() && fileStat.size > 1) {
        const bytes = await readFile(filePath)
        if (bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes
      }
    } catch {
      // The save operation has not completed yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Excel 导出未在时限内生成：${path.basename(filePath)}`)
}

async function launchApp() {
  return electron.launch({
    executablePath,
    env: smokeEnv,
    args: [`--user-data-dir=${smokeUserData}`, '--disable-gpu', '--no-proxy-server'],
    timeout: 30_000,
  })
}

async function closeThroughWindow(electronApp) {
  const processExited = new Promise((resolve) => electronApp.process().once('exit', resolve))
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await Promise.race([
    processExited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('关闭握手超时')), 35_000)),
  ])
}

async function crashAndRecoverRenderer(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window || window.isDestroyed()) throw new Error('没有可用于崩溃恢复验证的主窗口')
    const webContents = window.webContents
    const beforeUrl = webContents.getURL()
    await new Promise((resolve, reject) => {
      let timeout
      const handleLoaded = () => {
        clearTimeout(timeout)
        resolve()
      }
      timeout = setTimeout(() => {
        webContents.removeListener('did-finish-load', handleLoaded)
        reject(new Error('界面进程崩溃后没有在 20 秒内恢复'))
      }, 20_000)
      webContents.once('did-finish-load', handleLoaded)
      try {
        webContents.forcefullyCrashRenderer()
      } catch (error) {
        clearTimeout(timeout)
        webContents.removeListener('did-finish-load', handleLoaded)
        reject(error)
      }
    })
    return { beforeUrl, afterUrl: webContents.getURL() }
  })
}

async function inspectRecoveredRenderer(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('没有可用于恢复后验证的主窗口')
    return mainWindow.webContents.executeJavaScript(`
      (async () => {
        const token = await window.jigongbenDesktop?.getApiSessionToken()
        const apiFetch = (url, init = {}) => fetch(url, {
          ...init,
          headers: { ...(init.headers || {}), Authorization: \`Bearer \${token}\` },
        })
        const health = await apiFetch('/api/health').then((response) => response.json())
        const state = await apiFetch('/api/state').then((response) => response.json())
        return {
          appLoaded: Boolean(document.querySelector('.app-shell')),
          bridgeLoaded: Boolean(window.jigongbenDesktop),
          health,
          workerNames: state.workers.map((worker) => worker.name),
        }
      })()
    `, true)
  })
}

try {
  const executable = await stat(executablePath)
  assert(executable.isFile(), '没有找到已打包的桌面 EXE')

  firstApp = await launchApp()
  let firstPage = await firstApp.firstWindow({ timeout: 20_000 })
  await firstPage.locator('.app-shell').waitFor({ timeout: 20_000 })

  const initial = await firstPage.evaluate(async ({ name }) => {
    const bridge = window.jigongbenDesktop
    const token = await bridge?.getApiSessionToken()
    const unauthenticated = await fetch('/api/health')
    const unauthenticatedBody = await unauthenticated.json()
    const apiFetch = (url, init = {}) => fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    })
    const health = await apiFetch('/api/health').then((response) => response.json())
    let externalRequestBlocked = false
    try {
      await fetch('https://example.com/', { mode: 'no-cors' })
    } catch {
      externalRequestBlocked = true
    }
    const state = await apiFetch('/api/workers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, avatarDataUrl: null, defaultDailyRateFen: 30_000, note: '' }),
    }).then((response) => response.json())
    const weeklyBackup = await bridge?.createWeeklyBackupIfDue(true)
    const weeklyBackupStatus = await bridge?.getWeeklyBackupStatus()
    const stateAfterBackup = await apiFetch('/api/state').then((response) => response.json())
    return {
      health,
      bridgeMethods: bridge ? Object.keys(bridge).sort() : [],
      unauthenticatedStatus: unauthenticated.status,
      unauthenticatedCode: unauthenticatedBody?.error?.code,
      externalRequestBlocked,
      workerId: state.workers.find((worker) => worker.name === name)?.id,
      weeklyBackup,
      weeklyBackupStatus,
      lastWeeklyBackupAt: stateAfterBackup.settings.lastWeeklyBackupAt,
    }
  }, { name: workerName })

  assert(initial.health?.ok === true, '本地健康检查失败')
  assert(
    initial.unauthenticatedStatus === 401 && initial.unauthenticatedCode === 'API_SESSION_REQUIRED',
    '打包应用的 API 未拒绝缺少会话密钥的请求',
  )
  assert(initial.workerId, '无法通过打包应用创建隔离测试工人')
  assert(initial.externalRequestBlocked, '外部互联网请求没有被桌面安全策略拦截')
  assert(
    JSON.stringify(initial.bridgeMethods) ===
      JSON.stringify([
        'completeClose',
        'createWeeklyBackupIfDue',
        'getApiSessionToken',
        'getWeeklyBackupStatus',
        'onCloseCancelled',
        'onCloseRequested',
        'openWeeklyBackupFolder',
        'print',
        'saveFile',
        'savePdf',
        'setTheme',
      ]),
    '沙箱预加载桥接没有正确加载',
  )
  assert(initial.weeklyBackup?.created === true, '桌面桥接未能强制创建每周备份')
  assert(
    initial.weeklyBackupStatus?.lastFailureAt === null &&
      initial.weeklyBackupStatus?.errorCode === null,
    '每周备份成功后未清除桌面失败状态',
  )
  assert(initial.lastWeeklyBackupAt === initial.weeklyBackup.createdAt, '每周备份成功时间没有持久化')
  assert(!('filePath' in initial.weeklyBackup), '每周备份桥接不应向渲染器暴露文件路径')
  const weeklyFiles = await readdir(weeklyBackupDir)
  assert(
    weeklyFiles.includes(initial.weeklyBackup.filename),
    '每周备份没有写入隔离的 Documents 目录',
  )
  const weeklyData = JSON.parse(
    await readFile(path.join(weeklyBackupDir, initial.weeklyBackup.filename), 'utf8'),
  )
  assert(weeklyData.workers.some((worker) => worker.name === workerName), '每周备份内容缺少测试工人')

  const duplicate = spawn(executablePath, [`--user-data-dir=${smokeUserData}`, '--disable-gpu'], {
    env: smokeEnv,
    stdio: 'ignore',
    windowsHide: true,
  })
  await waitForExit(duplicate)

  await firstPage.reload({ waitUntil: 'domcontentloaded' })
  await firstPage.locator('.app-shell').waitFor({ timeout: 20_000 })

  const workbookExports = [
    { view: '个人月表', action: '导出月表 Excel', filename: '01-monthly.xlsx' },
    { view: '个人月表', action: '工资条 Excel', filename: '02-payslip.xlsx' },
    { view: '个人月表', action: '批量工资条 Excel', filename: '03-batch-payslip.xlsx' },
    { view: '年度汇总', action: '年度 Excel', filename: '04-annual.xlsx' },
    { view: '工地统计', action: '导出工地 Excel', filename: '05-sites.xlsx' },
  ].map((item) => ({ ...item, filePath: path.join(exportDirectory, item.filename) }))
  await mkdir(exportDirectory, { recursive: true })
  await writeFile(workbookExports[0].filePath, 'existing workbook sentinel', 'utf8')
  await firstApp.evaluate(({ dialog }, filePaths) => {
    const remaining = [...filePaths]
    dialog.showSaveDialog = async () => {
      const filePath = remaining.shift()
      return filePath ? { canceled: false, filePath } : { canceled: true }
    }
  }, workbookExports.map((item) => item.filePath))
  for (const workbookExport of workbookExports) {
    await firstPage.getByRole('button', { name: workbookExport.view, exact: true }).click()
    await firstPage.getByRole('button', { name: workbookExport.action, exact: true }).click()
    const signature = await waitForXlsxFile(workbookExport.filePath)
    assert(signature[0] === 0x50 && signature[1] === 0x4b, `${workbookExport.action} 不是有效的 XLSX 文件`)
  }
  await firstPage.getByRole('button', { name: '个人月表', exact: true }).click()
  await firstPage.getByRole('button', { name: '导出月表 Excel', exact: true }).click()
  await firstPage.getByRole('status').filter({ hasText: '月表 Excel 导出已取消' }).waitFor()

  const failedSaveTarget = path.join(exportDirectory, '06-write-failure.xlsx')
  await mkdir(failedSaveTarget)
  await firstApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, failedSaveTarget)
  await firstPage.getByRole('button', { name: '导出月表 Excel', exact: true }).click()
  const writeFailure = firstPage.getByRole('alert').filter({ hasText: '文件写入失败' })
  await writeFailure.waitFor({ timeout: 15_000 })
  const writeFailureText = await writeFailure.textContent()
  assert(!writeFailureText?.includes(smokeRoot), '文件写入失败提示泄露了绝对路径')
  assert((await stat(failedSaveTarget)).isDirectory(), '写入失败后原目标被破坏')
  assert(
    !(await readdir(exportDirectory)).some((name) => name.endsWith('.tmp')),
    '写入失败后遗留了临时文件',
  )
  await writeFailure.getByRole('button', { name: '关闭' }).click()

  const monthlyRateInput = firstPage.getByLabel('本月日薪')
  await monthlyRateInput.waitFor({ timeout: 20_000 })
  await monthlyRateInput.click()
  const monthlyRateFocus = await monthlyRateInput.evaluate((input) => ({
    active: document.activeElement === input,
    disabled: input.disabled,
  }))
  assert(monthlyRateFocus.disabled === false, '本月日薪输入框意外处于禁用状态')
  assert(monthlyRateFocus.active, '鼠标点击后本月日薪输入框没有获得键盘焦点')

  await firstPage.evaluate(() => {
    const nativeSetTimeout = window.setTimeout.bind(window)
    window.setTimeout = (handler, delay = 0, ...args) =>
      nativeSetTimeout(handler, delay === 500 ? 60_000 : delay, ...args)
  })
  await monthlyRateInput.fill(monthlyRate.slice(0, -1))
  await firstPage.keyboard.type(monthlyRate.slice(-1))
  assert(await monthlyRateInput.inputValue() === monthlyRate, '本月日薪没有通过真实键盘输入更新')

  const noteInput = firstPage.locator('label.form-field').filter({ hasText: '本月备注' }).locator('textarea')
  await noteInput.waitFor({ timeout: 20_000 })
  await noteInput.fill(note)
  // The page's 500 ms draft timers are held back above, so only the native
  // close handshake can flush these two pending values before exit.
  await closeThroughWindow(firstApp)
  firstApp = undefined

  secondApp = await launchApp()
  const secondPage = await secondApp.firstWindow({ timeout: 20_000 })
  await secondPage.locator('.app-shell').waitFor({ timeout: 20_000 })
  const restored = await secondPage.evaluate(async ({ name, monthValue }) => {
    const token = await window.jigongbenDesktop?.getApiSessionToken()
    const state = await fetch('/api/state', {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => response.json())
    const worker = state.workers.find((candidate) => candidate.name === name)
    const monthlyRecord = state.monthlyRecords.find(
      (record) => record.workerId === worker?.id && record.month === monthValue,
    )
    return {
      workerFound: Boolean(worker),
      note: monthlyRecord?.note,
      dailyRateFen: monthlyRecord?.dailyRateFen,
    }
  }, { name: workerName, monthValue: month })
  assert(restored.workerFound, '重启后没有找到测试工人')
  assert(restored.note === note, '关闭前的延迟备注没有持久化')
  assert(restored.dailyRateFen === monthlyRateFen, '关闭前的防抖日薪没有持久化')

  const rendererRecovery = await crashAndRecoverRenderer(secondApp)
  assert(rendererRecovery.afterUrl === rendererRecovery.beforeUrl, '崩溃恢复改变了受信页面地址')
  const recoveredRenderer = await inspectRecoveredRenderer(secondApp)
  assert(recoveredRenderer.appLoaded, '崩溃恢复后应用界面没有重新挂载')
  assert(recoveredRenderer.health?.ok === true, '崩溃恢复后本机服务健康检查失败')
  assert(recoveredRenderer.bridgeLoaded, '崩溃恢复后预加载桥接没有重新加载')
  assert(
    recoveredRenderer.workerNames.includes(workerName),
    '崩溃恢复后已落盘的工人数据丢失',
  )

  const recordFiles = await findFiles(smokeRoot, 'records.json')
  assert(recordFiles.length === 1, `隔离数据文件数量异常：${recordFiles.length}`)
  const savedData = JSON.parse(await readFile(recordFiles[0], 'utf8'))
  assert(savedData.workers.some((worker) => worker.name === workerName), '隔离 records.json 内容无效')

  await closeThroughWindow(secondApp)
  secondApp = undefined
  const smokeGate = await recordDesktopSmoke(projectRoot)
  succeeded = true
  console.log(JSON.stringify({
    executablePath,
    isolatedDataFile: recordFiles[0],
    preloadBridgeLoaded: true,
    loopbackHealthPassed: true,
    apiSessionRequiredPassed: true,
    externalNetworkBlocked: true,
    singleInstancePassed: true,
    closeFlushPersisted: true,
    closeDebouncedRatePersisted: true,
    rendererCrashRecoveryPassed: true,
    weeklyBackupPassed: true,
    nativeWorkbookExportsPassed: workbookExports.map((item) => item.filename),
    nativeAtomicOverwritePassed: true,
    nativeFileWriteFailureSanitized: true,
    releaseFingerprint: smokeGate.sourceRuntimeFingerprint,
  }, null, 2))
} finally {
  await firstApp?.close().catch(() => {})
  await secondApp?.close().catch(() => {})
  if (succeeded) await rm(smokeRoot, { recursive: true, force: true })
  else console.error(`桌面 smoke 失败，隔离目录保留在：${smokeRoot}`)
}
