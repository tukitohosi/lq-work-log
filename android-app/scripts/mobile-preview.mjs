import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../server/app.mjs'
import { emptyAppData, validateAppData } from '../server/validation.mjs'

// This preview always uses a fresh sample ledger outside the application directory.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lq-mobile-preview-'))
const sample = emptyAppData()
const now = new Date()
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
const createdAt = `${month}-01T00:00:00.000Z`
sample.sites = [
  { id: 'sample-site-a', name: '滨江花园', note: '手机预览示例工地', createdAt, archivedAt: null },
  { id: 'sample-site-b', name: '新城学校扩建项目', note: '', createdAt, archivedAt: null },
]
sample.workers = ['陈师傅', '王师傅', '赵师傅'].map((name, index) => ({
  id: `sample-worker-${index + 1}`, name, avatarDataUrl: null, avatarEmoji: null,
  defaultDailyRateFen: 30000 + index * 2000, defaultSiteId: sample.sites[index % 2].id,
  note: index ? '' : '这是示例资料，可自由试用', createdAt, archivedAt: null,
}))
sample.settings.currentWorkerId = sample.workers[0].id
sample.settings.lastBackupExportAt = now.toISOString()
sample.monthlyRecords = sample.workers.map((worker) => ({
  workerId: worker.id, month, dailyRateFen: worker.defaultDailyRateFen,
  overtimePayPercent: 150, note: '', paidAt: null,
}))
for (const [index, worker] of sample.workers.entries()) {
  for (let day = 1; day <= Math.min(now.getDate(), 27); day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`
    const resting = day % 7 === 0
    sample.attendance.push({
      workerId: worker.id, date, morning: resting ? 'absent' : 'present', afternoon: resting ? 'absent' : 'present',
      overtime: !resting && day % 3 === 0 ? 'half' : null, dayNote: day === 8 ? '下午转到学校工地' : '',
      morningSiteId: resting ? null : worker.defaultSiteId,
      afternoonSiteId: resting ? null : day === 8 ? 'sample-site-b' : worker.defaultSiteId,
      overtimeSiteId: !resting && day % 3 === 0 ? worker.defaultSiteId : null,
      morningLeave: null, afternoonLeave: null, overtimeLeave: null,
    })
  }
  sample.payAdjustments.push({ id: `sample-adjustment-${index}`, workerId: worker.id, month,
    date: `${month}-05`, kind: 'allowance', amountFen: 20000, label: '高温补贴', note: '',
    siteId: worker.defaultSiteId, createdAt, updatedAt: createdAt })
}
await writeFile(path.join(dataDir, 'records.json'), JSON.stringify(validateAppData(sample)), 'utf8')
const app = await createApp({ rootDir, dataDir, distDir: path.join(rootDir, 'dist') })
const shell = await readFile(path.join(rootDir, 'scripts/mobile-preview.html'))
const server = createServer((request, response) => {
  if (new URL(request.url, 'http://localhost').pathname === '/mobile-preview') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(shell)
  } else {
    // Only this loopback-only, disposable-data preview may embed its own app.
    // Keep the production server's DENY / frame-ancestors 'none' unchanged.
    const setHeader = response.setHeader.bind(response)
    response.setHeader = (name, value) => setHeader(name,
      name.toLowerCase() === 'x-frame-options' ? 'SAMEORIGIN'
        : name.toLowerCase() === 'content-security-policy'
          ? String(value).replace("frame-ancestors 'none'", "frame-ancestors 'self'") : value)
    void app(request, response)
  }
})
const portFlag = process.argv.indexOf('--port')
const requestedPort = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 0
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid preview port')
server.listen(requestedPort, '127.0.0.1', async () => {
  const port = server.address().port
  const info = { url: `http://127.0.0.1:${port}`, previewUrl: `http://127.0.0.1:${port}/mobile-preview`, dataDir, pid: process.pid }
  const statusFlag = process.argv.indexOf('--status-file')
  if (statusFlag >= 0) await writeFile(process.argv[statusFlag + 1], JSON.stringify(info, null, 2), 'utf8')
  console.log(JSON.stringify(info))
})
async function stop() { server.close(); await app.store.close(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
