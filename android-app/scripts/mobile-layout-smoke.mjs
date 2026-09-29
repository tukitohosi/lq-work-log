import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'android-poc-evidence', 'mobile-ui-20260929')
await mkdir(output, { recursive: true })
const temporary = await mkdtemp(path.join(os.tmpdir(), 'lq-mobile-layout-check-'))
const statusFile = path.join(temporary, 'server.json')
const preview = spawn(process.execPath, [path.join(root, 'scripts/mobile-preview.mjs'), '--status-file', statusFile], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let startupError = ''
preview.stderr.on('data', chunk => { startupError += chunk.toString() })
const info = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Preview did not start: ${startupError}`)), 15000)
  preview.stdout.on('data', async () => {
    try { const result = JSON.parse(await readFile(statusFile, 'utf8')); clearTimeout(timeout); resolve(result) } catch { /* More output may follow. */ }
  })
  preview.once('exit', code => { clearTimeout(timeout); reject(new Error(`Preview exited ${code}: ${startupError}`)) })
})
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--disable-gpu'] })
const evidence = []
const errors = []
async function checkWidth(page, label) {
  const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, root: document.documentElement.scrollWidth, dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(el => el.getBoundingClientRect().width).map(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, inner: el.clientWidth, scroll: el.scrollWidth })) }))
  assert.ok(widths.root <= widths.viewport + 1, `${label}: page ${JSON.stringify(widths)}`)
  for (const dialog of widths.dialogs) {
    assert.ok(dialog.left >= -1 && dialog.right <= widths.viewport + 1, `${label}: dialog out of bounds`)
    assert.ok(dialog.scroll <= dialog.inner + 1, `${label}: dialog content scrolls horizontally`)
  }
  evidence.push({ label, ...widths })
}
async function ready(page) {
  await page.goto(info.url)
  await page.locator('.summary-person h2').waitFor()
}
async function closeSettings(page) { await page.getByRole('button', { name: '关闭设置', exact: true }).click() }
try {
  // Exercise the actual user-facing wrapper, not just a standalone narrow page.
  const shellPage = await browser.newPage({ viewport: { width: 1000, height: 1000 }, locale: 'zh-CN' })
  shellPage.on('pageerror', error => errors.push(error.message))
  await shellPage.goto(info.previewUrl)
  const framedApp = shellPage.frameLocator('#phone')
  await framedApp.locator('.summary-person h2').waitFor()
  assert.ok(await framedApp.locator('[data-mobile-date]').count() >= 28)
  await shellPage.locator('#width').selectOption('320')
  assert.equal(await framedApp.locator('html').evaluate(element => element.clientWidth), 320)
  await shellPage.setViewportSize({ width: 450, height: 1000 })
  assert.equal(await framedApp.locator('html').evaluate(element => element.clientWidth), 320)
  await shellPage.setViewportSize({ width: 1000, height: 1000 })
  await shellPage.locator('#width').selectOption('390')
  await framedApp.locator('[data-mobile-date]').first().click()
  await framedApp.getByRole('button', { name: '完成', exact: true }).click()
  await framedApp.getByRole('button', { name: '设置', exact: true }).click()
  await framedApp.getByRole('button', { name: '关闭设置', exact: true }).click()
  await shellPage.screenshot({ path: path.join(output, '00-preview.png') })
  await shellPage.close()

  for (const width of [320, 360, 390, 412, 430]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: 'zh-CN' })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', dialog => dialog.accept())
    await ready(page)
    await checkWidth(page, `${width}:monthly`)
    const dates = page.locator('[data-mobile-date]')
    assert.ok(await dates.count() >= 28)
    const boxes = await dates.evaluateAll(elements => elements.map(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })))
    assert.ok(boxes.every(box => box.left >= 0 && box.right <= width), `${width}: all dates within screen`)
    if (width === 390) await page.screenshot({ path: path.join(output, '01-month.png'), fullPage: true })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '关闭设置', exact: true }).waitFor()
    await checkWidth(page, `${width}:settings`)
    if (width === 390) await page.screenshot({ path: path.join(output, '02-settings.png') })
    await closeSettings(page)
    await dates.first().tap()
    await page.locator('.day-details-dialog').waitFor()
    await checkWidth(page, `${width}:day-dialog`)
    if (width === 390) await page.screenshot({ path: path.join(output, '03-day.png') })
    await page.getByRole('button', { name: '完成', exact: true }).click()
    for (const [name, selector] of [['当日总览', '.daily-overview'], ['年度汇总', '.annual-summary'], ['工地统计', '.site-statistics-view']]) {
      await page.getByRole('button', { name, exact: true }).click()
      await page.locator(selector).waitFor()
      await page.locator(`${selector} details`).evaluateAll(elements => elements.forEach(element => { element.open = true }))
      if (name === '工地统计') {
        for (const toggle of await page.locator('.mobile-site-toggle').all()) await toggle.click()
      }
      await checkWidth(page, `${width}:${name}`)
    }
    await context.close()
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => dialog.accept())
  await ready(page)
  const state = async () => (await (await page.request.get(`${info.url}/api/state`)).json())
  for (const [month, days] of [['2026-02', 28], ['2028-02', 29], ['2026-09', 30], ['2026-08', 31]]) {
    await page.locator('input[type="month"]').first().fill(month)
    await page.locator('input[type="month"]').first().dispatchEvent('change')
    await page.waitForFunction(expected => document.querySelectorAll('[data-mobile-date]').length === expected, days)
    const actual = await page.locator('[data-mobile-date]').evaluateAll(elements => elements.map(element => element.dataset.mobileDate))
    assert.equal(new Set(actual).size, days)
    assert.equal(actual[0], `${month}-01`)
    assert.equal(actual.at(-1), `${month}-${days}`)
    await checkWidth(page, `month:${month}`)
  }
  // A real touch drag may scroll, but must never mark attendance or open a day.
  const beforeSwipe = JSON.stringify((await state()).attendance)
  await page.locator('.mobile-calendar-weeks').scrollIntoViewIfNeeded()
  const box = await page.locator('.mobile-calendar-weeks').boundingBox()
  const cdp = await context.newCDPSession(page)
  const x = box.x + box.width / 2, y = Math.min(700, box.y + box.height - 20)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 100 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  assert.equal(JSON.stringify((await state()).attendance), beforeSwipe)
  assert.equal(await page.locator('.day-details-dialog').count(), 0)

  await page.locator('[data-mobile-date="2026-08-01"]').tap()
  await page.getByRole('button', { name: '上午出工', exact: true }).click()
  await page.getByRole('textbox', { name: '单日备注', exact: true }).fill('手机自动保存验证')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await page.locator('.day-details-dialog').waitFor({ state: 'detached' })
  const workerId = (await state()).settings.currentWorkerId
  assert.ok((await state()).attendance.some(entry => entry.workerId === workerId && entry.date === '2026-08-01' && entry.morning === 'present' && entry.dayNote === '手机自动保存验证'))

  await page.getByRole('button', { name: '编辑资料', exact: true }).last().click()
  await page.locator('.worker-profile-form input').first().fill('陈师傅资料草稿保留')
  await page.locator('.worker-default-site').selectOption('__create_site__')
  await page.getByRole('textbox', { name: '工地名称', exact: true }).fill('现场新增示例工地')
  await page.getByRole('textbox', { name: '工地备注', exact: true }).fill('在工人资料里创建')
  await checkWidth(page, 'inline-new-site')
  await page.screenshot({ path: path.join(output, '04-new-site.png') })
  await page.getByRole('button', { name: '保存并选用', exact: true }).click()
  await page.locator('.worker-site-form').waitFor({ state: 'detached' })
  assert.equal(await page.locator('.worker-profile-form input').first().inputValue(), '陈师傅资料草稿保留')
  const createdId = await page.locator('.worker-default-site').inputValue()
  assert.equal((await state()).sites.find(site => site.id === createdId)?.name, '现场新增示例工地')
  await page.locator('.worker-profile-form button[type="submit"]').click()
  await page.locator('.worker-dialog').waitFor({ state: 'detached' })
  assert.equal((await state()).workers.find(worker => worker.id === workerId)?.defaultSiteId, createdId)

  await page.locator('.record-footer').scrollIntoViewIfNeeded()
  for (const button of await page.locator('.footer-actions button').all()) {
    const rect = await button.boundingBox()
    assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= 391)
  }
  await page.screenshot({ path: path.join(output, '05-actions.png') })
  await page.evaluate(() => { for (const el of document.querySelectorAll('body *')) { const size = parseFloat(getComputedStyle(el).fontSize); el.style.fontSize = `${size * 1.3}px` } })
  await checkWidth(page, '390:130-percent-text')
  await page.reload()
  await page.locator('.summary-person h2').waitFor()
  const longWorker = await page.request.patch(`${info.url}/api/workers/${workerId}`, { data: { name: '手机长姓名测试'.repeat(5), note: '长备注换行验证'.repeat(70) } })
  assert.ok(longWorker.ok())
  const longSite = await page.request.patch(`${info.url}/api/sites/${createdId}`, { data: { name: '长工地名称测试'.repeat(12), note: '长工地备注'.repeat(80) } })
  assert.ok(longSite.ok())
  await page.reload()
  await page.locator('.summary-person h2').waitFor()
  await checkWidth(page, '390:long-worker-and-site')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.evaluate(() => document.documentElement.style.setProperty('--visual-viewport-height', '400px'))
  assert.ok((await page.locator('.modal').boundingBox()).height <= 400)
  await checkWidth(page, '390:keyboard-height')
  await closeSettings(page)
  await page.emulateMedia({ media: 'print' })
  assert.equal(await page.locator('.mobile-month-calendar').isVisible(), false)
  assert.equal(await page.locator('.attendance-table').isVisible(), true)
  await page.pdf({ path: path.join(output, 'monthly-print.pdf'), format: 'A4', landscape: true })
  await context.close()

  const landscape = await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true, locale: 'zh-CN' })
  await ready(landscape)
  await checkWidth(landscape, '844:landscape')
  await landscape.close()
  assert.deepEqual(errors, [])
  await writeFile(path.join(output, 'layout-results.json'), JSON.stringify({ passed: true, checks: evidence, pageErrors: errors }, null, 2))
  console.log(`Mobile UI checks passed: ${evidence.length} layout checks; calendar lengths, touch scrolling, autosave, inline site creation and print verified. Evidence: ${output}`)
} finally {
  await browser.close()
  preview.kill()
}
