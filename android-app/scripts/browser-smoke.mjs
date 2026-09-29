import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { startServer } from '../server/app.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, '..')
const distDir = path.join(rootDir, 'dist')
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const outputFlagIndex = process.argv.indexOf('--output-dir')
if (outputFlagIndex >= 0 && !process.argv[outputFlagIndex + 1]) {
  throw new Error('--output-dir 需要提供目录')
}
const explicitOutputDir = outputFlagIndex >= 0
  ? path.resolve(rootDir, process.argv[outputFlagIndex + 1])
  : null

await Promise.all([access(path.join(distDir, 'index.html')), access(chromePath), access(edgePath)])

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'jigongben-browser-'))
const outputDir = explicitOutputDir ?? path.join(temporaryRoot, 'preview')
await mkdir(outputDir, { recursive: true })
const dataDir = path.join(temporaryRoot, 'data')
const running = await startServer({
  port: 0,
  endPort: 0,
  reuseExisting: false,
  rootDir,
  dataDir,
  distDir,
})

async function waitUntilSaved(page) {
  await page.waitForFunction(() => {
    const text = document.querySelector('.save-indicator')?.textContent || ''
    return !text.includes('正在保存') && !text.includes('保存失败')
  })
}

function attendanceCell(page, date, period) {
  return page.locator(`button.attendance-button[data-date="${date}"][data-period="${period}"]`)
}

async function selectFixtureMonth(page) {
  // The application deliberately opens the current month after a fresh load.
  await page.locator('input[type="month"]').first().fill('2026-08')
  await page.locator('input[type="month"]').first().dispatchEvent('change')
}

async function chooseInteractionMode(page, mode) {
  const button = page.locator(`button.interaction-mode-button[data-mode="${mode}"]`)
  await button.click()
  await assert.doesNotReject(() => button.waitFor({ state: 'visible' }))
  assert.equal(await button.getAttribute('aria-pressed'), 'true')
}

async function dragBetween(page, start, end) {
  const startBox = await start.boundingBox()
  const endBox = await end.boundingBox()
  assert.ok(startBox, 'drag start cell must be visible')
  assert.ok(endBox, 'drag end cell must be visible')
  const startPoint = await start.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  const endPoint = await end.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  await page.mouse.move(startPoint.x, startPoint.y)
  await start.dispatchEvent('pointerdown', { pointerId: 51, pointerType: 'mouse', button: 0 })
  await page.mouse.move(endPoint.x, endPoint.y)
  await end.dispatchEvent('pointerenter', { pointerId: 51, pointerType: 'mouse', button: 0, buttons: 1 })
  const selectedDuringDrag = await page.locator('.attendance-button.is-region-selected').count()
  assert.ok(selectedDuringDrag > 1, `region drag should preview more than one cell, got ${selectedDuringDrag}`)
  await end.dispatchEvent('pointerup', {
    pointerId: 51,
    pointerType: 'mouse',
    button: 0,
    clientX: endPoint.x,
    clientY: endPoint.y,
  })
}

async function computedBackground(page, selector) {
  return page.locator(selector).evaluate((element) => getComputedStyle(element).backgroundColor)
}

async function addWorker(page, name, rate) {
  const emptyButton = page.getByRole('button', { name: '添加工人' }).last()
  if (await emptyButton.isVisible().catch(() => false)) await emptyButton.click()
  else await page.locator('.sidebar .add-worker-button').click()
  await page.locator('.modal-form input').first().fill(name)
  await page.locator('.modal-form .money-input input').fill(rate)
  await page.getByRole('button', { name: '保存' }).click()
  await page.waitForFunction((expected) => document.querySelector('.summary-person h2')?.textContent?.trim() === expected, name)
  await waitUntilSaved(page)
}

let chrome
let edge
try {
  chrome = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  })
  const chromeContext = await chrome.newContext({ acceptDownloads: true, locale: 'zh-CN' })
  const page = await chromeContext.newPage()
  await page.goto(running.url, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '先添加一名工人' }).waitFor()

  await addWorker(page, '李权', '300')
  await page.locator('input[type="month"]').evaluate((element) => {
    element.value = '2026-08'
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })

  await page.locator('.summary-card .text-icon-button').click()
  await page.locator('.avatar-picker input[type="file"]').setInputFiles(path.join(rootDir, '样表.jpg'))
  try {
    await page.locator('.avatar-preview img').waitFor({ timeout: 10_000 })
  } catch (error) {
    const formError = await page.locator('.modal-form [role="alert"]').textContent().catch(() => '')
    const preview = await page.locator('.avatar-preview').innerHTML().catch(() => '')
    throw new Error(`头像文件选择后未显示预览。界面错误：${formError || '无'}；预览内容：${preview || '无'}`, { cause: error })
  }
  await page.getByRole('button', { name: '移除头像' }).click()
  const avatarBase64 = (await readFile(path.join(rootDir, '样表.jpg'))).toString('base64')
  await page.locator('.avatar-picker').evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'clipboard-avatar.jpg', { type: 'image/jpeg' }))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    element.dispatchEvent(event)
  }, avatarBase64)
  await page.locator('.avatar-preview img').waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: '保存' }).click()
  await waitUntilSaved(page)
  await page.locator('.summary-avatar img').waitFor()

  const morningCell = attendanceCell(page, '2026-08-08', 'morning')
  await morningCell.click()
  await waitUntilSaved(page)
  await page.waitForFunction(() => document.querySelector('.summary-metrics')?.textContent?.includes('总工数0.5'))
  assert.match((await page.locator('.summary-metrics').textContent()) || '', /150\.00/)

  const overtimeCell = attendanceCell(page, '2026-08-08', 'overtime')
  await overtimeCell.click()
  await waitUntilSaved(page)
  assert.equal((await overtimeCell.textContent())?.trim(), '✓')
  await page.waitForFunction(() => document.querySelector('.summary-metrics')?.textContent?.includes('总工数1'))
  assert.match((await page.locator('.summary-metrics').textContent()) || '', /300\.00/)

  const hoverMorning = attendanceCell(page, '2026-08-09', 'morning')
  const hoverAfternoon = attendanceCell(page, '2026-08-09', 'afternoon')
  await morningCell.focus()
  await hoverMorning.hover()
  await page.keyboard.press('1')
  await waitUntilSaved(page)
  assert.equal((await hoverMorning.textContent())?.trim(), '✓')
  await hoverAfternoon.hover()
  await page.keyboard.press('2')
  await waitUntilSaved(page)
  assert.equal((await hoverAfternoon.textContent())?.trim(), '×')
  await hoverMorning.hover()
  await page.keyboard.press('Backspace')
  await waitUntilSaved(page)
  assert.equal((await hoverMorning.textContent())?.trim(), '')
  await hoverAfternoon.hover()
  await page.keyboard.press('Backspace')
  await waitUntilSaved(page)
  assert.equal((await hoverAfternoon.textContent())?.trim(), '')

  // A stationary hover target must not steal the next edit after keyboard navigation.
  const keyboardStart = attendanceCell(page, '2026-08-09', 'morning')
  const keyboardTarget = attendanceCell(page, '2026-08-10', 'morning')
  await keyboardStart.hover()
  await keyboardStart.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('1')
  await waitUntilSaved(page)
  assert.equal((await keyboardStart.textContent())?.trim(), '')
  assert.equal((await keyboardTarget.textContent())?.trim(), '✓')
  await page.keyboard.press('Backspace')
  await waitUntilSaved(page)
  assert.equal((await keyboardTarget.textContent())?.trim(), '')

  await page.reload({ waitUntil: 'networkidle' })
  await selectFixtureMonth(page)
  await attendanceCell(page, '2026-08-08', 'morning').waitFor()
  const persistedOvertime = attendanceCell(page, '2026-08-08', 'overtime')
  await persistedOvertime.waitFor()
  assert.match((await persistedOvertime.getAttribute('aria-label')) || '', /加班半工/)
  await page.locator('.summary-avatar img').waitFor()
  assert.match((await page.locator('.summary-metrics').textContent()) || '', /总工数1/)

  await page.getByRole('button', { name: '设置' }).click()
  await page.locator('input[name="theme"][type="radio"]').nth(1).check()
  await waitUntilSaved(page)
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
  const darkBody = await computedBackground(page, 'body')
  const darkCard = await computedBackground(page, '.attendance-card')
  assert.notEqual(darkBody, 'rgb(255, 255, 255)')
  assert.notEqual(darkCard, 'rgb(255, 255, 255)')
  await page.locator('.modal-backdrop').filter({ hasText: '偏好与数据' }).locator('.modal-header .icon-button').click()

  await page.locator('button.help-button[aria-label="操作说明"]').click()
  await page.locator('[role="dialog"][aria-label="操作说明"]').waitFor()
  assert.match((await page.locator('.help-guide').textContent()) || '', /Ctrl\s*\+\s*Z/)
  assert.match((await page.locator('.help-guide').textContent()) || '', /区域圈选/)
  await page.keyboard.press('Escape')
  await page.locator('.help-dialog').waitFor({ state: 'detached' })

  await chooseInteractionMode(page, 'region')
  const regionStart = attendanceCell(page, '2026-08-10', 'morning')
  const regionEnd = attendanceCell(page, '2026-08-11', 'overtime')
  await dragBetween(page, regionStart, regionEnd)
  const regionDialog = page.locator('.region-action-dialog')
  await regionDialog.waitFor()
  assert.equal(await page.locator('.attendance-button.is-region-selected').count(), 6)
  assert.equal((await attendanceCell(page, '2026-08-10', 'morning').textContent())?.trim(), '')
  await regionDialog.locator('button[data-action="grind"]').click()
  await regionDialog.waitFor({ state: 'detached' })
  await waitUntilSaved(page)
  assert.equal((await attendanceCell(page, '2026-08-10', 'morning').textContent())?.trim(), '✓')
  assert.equal((await attendanceCell(page, '2026-08-11', 'afternoon').textContent())?.trim(), '✓')
  assert.equal((await attendanceCell(page, '2026-08-11', 'overtime').textContent())?.trim(), '✓')

  await attendanceCell(page, '2026-08-10', 'morning').focus()
  await page.keyboard.press('Control+z')
  await waitUntilSaved(page)
  assert.equal((await attendanceCell(page, '2026-08-10', 'morning').textContent())?.trim(), '')

  await chooseInteractionMode(page, 'region')
  await dragBetween(page, attendanceCell(page, '2026-08-08', 'overtime'), attendanceCell(page, '2026-08-09', 'overtime'))
  const overtimeRestDialog = page.locator('.region-action-dialog')
  await overtimeRestDialog.waitFor()
  await overtimeRestDialog.locator('button[data-action="rest"]').click()
  await overtimeRestDialog.waitFor({ state: 'detached' })
  await waitUntilSaved(page)
  assert.equal((await attendanceCell(page, '2026-08-08', 'overtime').textContent())?.trim(), '')
  await attendanceCell(page, '2026-08-08', 'overtime').focus()
  await page.keyboard.press('Control+z')
  await waitUntilSaved(page)
  assert.equal((await attendanceCell(page, '2026-08-08', 'overtime').textContent())?.trim(), '✓')

  await attendanceCell(page, '2026-08-10', 'morning').focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-date')), '2026-08-11')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-period')), 'morning')
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-date')), '2026-08-11')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-period')), 'afternoon')

  const monthBeforeShortcut = await page.locator('input[type="month"]').inputValue()
  await page.keyboard.press('Control+ArrowRight')
  assert.notEqual(await page.locator('input[type="month"]').inputValue(), monthBeforeShortcut)
  await page.keyboard.press('Control+ArrowLeft')
  assert.equal(await page.locator('input[type="month"]').inputValue(), monthBeforeShortcut)

  await persistedOvertime.click()
  await waitUntilSaved(page)
  assert.equal((await persistedOvertime.textContent())?.trim(), '✓✓')
  await page.waitForFunction(() => document.querySelector('.summary-metrics')?.textContent?.includes('总工数1.5'))
  assert.match((await page.locator('.summary-metrics').textContent()) || '', /450\.00/)

  await addWorker(page, '王强', '280')
  assert.match((await page.locator('.summary-metrics').textContent()) || '', /总工数0/)
  const workerFilter = page.getByPlaceholder('筛选工人姓名')
  await workerFilter.fill('李')
  await page.keyboard.press('Control+ArrowDown')
  assert.equal((await page.locator('.summary-person h2').textContent())?.trim(), '王强')
  await workerFilter.blur()
  await page.keyboard.press('Control+ArrowDown')
  await page.waitForFunction(() => document.querySelector('.summary-person h2')?.textContent?.trim() === '李权')
  await workerFilter.fill('')
  await waitUntilSaved(page)
  assert.match((await page.locator('.summary-metrics').textContent()) || '', /总工数1\.5/)

  const overtimeMultiplier = page.getByLabel('本月加班倍率')
  await overtimeMultiplier.fill('1.5')
  await overtimeMultiplier.blur()
  await waitUntilSaved(page)
  assert.match((await page.locator('.summary-metrics').textContent()) || '', /600\.00/)

  const excelDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出月表 Excel' }).click()
  const excelDownload = await excelDownloadPromise
  assert.match(excelDownload.suggestedFilename(), /^李权_2026年08月记工表\.xlsx$/)
  const excelPath = path.join(temporaryRoot, excelDownload.suggestedFilename())
  await excelDownload.saveAs(excelPath)
  assert.ok((await stat(excelPath)).size > 1_000)

  const backupDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '设置' }).click()
  await page.locator('.internal-backup-card').first().waitFor()
  await page.locator('.internal-backup-card').first().getByRole('button', { name: '预览并恢复' }).click()
  await page.getByRole('heading', { name: '确认恢复备份' }).waitFor()
  await page.getByRole('button', { name: '取消' }).last().click()
  await page.getByRole('button', { name: '导出备份' }).click()
  const backupDownload = await backupDownloadPromise
  assert.match(backupDownload.suggestedFilename(), /^记工本备份_\d{4}-\d{2}-\d{2}\.json$/)
  const backupPath = path.join(temporaryRoot, backupDownload.suggestedFilename())
  await backupDownload.saveAs(backupPath)
  assert.ok((await stat(backupPath)).size > 100)

  await page.evaluate(() => {
    document.querySelectorAll('.toast button').forEach((button) => button.click())
  })
  await page.waitForTimeout(500)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(100)
  await page.screenshot({
    path: path.join(outputDir, '记工本界面预览-Chrome.png'),
    fullPage: true,
  })
  await page.pdf({
    path: path.join(outputDir, '记工本打印预览.pdf'),
    format: 'A4',
    landscape: true,
    printBackground: true,
  })
  await chromeContext.close()

  const mobileContext = await chrome.newContext({
    locale: 'zh-CN',
    viewport: { width: 390, height: 844 },
  })
  const mobilePage = await mobileContext.newPage()
  await mobilePage.goto(running.url, { waitUntil: 'networkidle' })
  await mobilePage.waitForFunction(() => document.querySelector('.summary-person h2')?.textContent?.trim() === '李权')
  await selectFixtureMonth(mobilePage)
  await mobilePage.locator('button.mobile-help-button[aria-label="操作说明"]').click()
  await mobilePage.locator('[role="dialog"][aria-label="操作说明"]').waitFor()
  await mobilePage.keyboard.press('Escape')
  await mobilePage.locator('.help-dialog').waitFor({ state: 'detached' })
  await mobilePage.screenshot({
    path: path.join(outputDir, '记工本手机预览.png'),
    fullPage: true,
  })
  await mobileContext.close()
  await chrome.close()
  chrome = undefined

  edge = await chromium.launch({
    executablePath: edgePath,
    headless: true,
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  })
  const edgePage = await edge.newPage({ locale: 'zh-CN' })
  await edgePage.goto(running.url, { waitUntil: 'networkidle' })
  await edgePage.waitForFunction(() => document.querySelector('.summary-person h2')?.textContent?.trim() === '李权')
  await selectFixtureMonth(edgePage)
  await attendanceCell(edgePage, '2026-08-08', 'morning').waitFor()
  await attendanceCell(edgePage, '2026-08-08', 'overtime').waitFor()
  await edgePage.locator('.summary-avatar img').waitFor()
  assert.match((await edgePage.locator('.summary-metrics').textContent()) || '', /600\.00/)
  await edgePage.screenshot({
    path: path.join(outputDir, '记工本界面预览-Edge.png'),
    fullPage: true,
  })
  await edge.close()
  edge = undefined

  console.log('[浏览器验收] Chrome：头像、方向键意图、悬停按键/Backspace、区域全休、工人过滤、倍率、内部备份预览、Excel、PDF 均通过')
  console.log('[浏览器验收] Edge：跨浏览器读取、头像、考勤与工资均通过')
  console.log(
    explicitOutputDir
      ? `[浏览器验收] 预览文件：${outputDir}`
      : '[浏览器验收] 临时预览已验证，结束后自动清理；如需保留请传 --output-dir preview',
  )
} finally {
  await chrome?.close().catch(() => {})
  await edge?.close().catch(() => {})
  await new Promise((resolve) => running.server.close(resolve))
  await rm(temporaryRoot, { recursive: true, force: true })
}
