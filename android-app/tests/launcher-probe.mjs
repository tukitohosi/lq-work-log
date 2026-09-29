import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDir = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(testsDir, '..')
const launcherSource = path.join(workspace, '启动记工本.cmd')
const fixtureRoot = path.join(
  tmpdir(),
  `记工本 中文 (验证)&空格-${process.pid}-${Date.now()}`,
)
const fixtureLauncher = path.join(fixtureRoot, '启动记工本.cmd')
const probeLog = path.join(fixtureRoot, 'node-probe.json')
const isolatedDataDir = path.join(fixtureRoot, '隔离 data')
const productionRecords = path.join(workspace, 'data', 'records.json')

async function optionalFileSnapshot(filePath) {
  try {
    const info = await stat(filePath)
    return { exists: true, size: info.size, bytes: (await readFile(filePath)).toString('base64') }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false }
    throw error
  }
}

async function runLauncher(fakeNodeExitCode) {
  const nodeDirectory = path.dirname(process.execPath)
  const systemDirectory = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const command = `call "${fixtureLauncher}"`
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      Path: `${nodeDirectory};${systemDirectory}`,
      PATH: `${nodeDirectory};${systemDirectory}`,
      JIGONGBEN_DATA_DIR: isolatedDataDir,
      JIGONGBEN_PROBE_LOG: probeLog,
      JIGONGBEN_PROBE_EXIT_CODE: String(fakeNodeExitCode),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: true,
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  // Supplies the key consumed by PAUSE on the intentional non-zero path.
  child.stdin.end('x')

  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  let invocation = null
  let invocationReadError = null
  try {
    invocation = JSON.parse(await readFile(probeLog, 'utf8'))
  } catch (error) {
    invocationReadError = error instanceof Error ? error.message : String(error)
  }
  return { ...result, invocation, invocationReadError }
}

async function main() {
  if (process.platform !== 'win32') {
    console.log(JSON.stringify({ skipped: true, reason: 'Windows-only launcher' }, null, 2))
    return
  }

  const productionBefore = await optionalFileSnapshot(productionRecords)
  await mkdir(path.join(fixtureRoot, 'dist'), { recursive: true })
  await mkdir(path.join(fixtureRoot, 'server'), { recursive: true })
  await copyFile(launcherSource, fixtureLauncher)
  await writeFile(path.join(fixtureRoot, 'dist', 'index.html'), '<!doctype html>', 'utf8')
  await writeFile(
    path.join(fixtureRoot, 'server', 'index.mjs'),
    [
      "import { writeFileSync } from 'node:fs'",
      "const payload = { argv: process.argv.slice(2), cwd: process.cwd(), dataDir: process.env.JIGONGBEN_DATA_DIR, execPath: process.execPath }",
      "writeFileSync(process.env.JIGONGBEN_PROBE_LOG, JSON.stringify(payload), 'utf8')",
      "process.exit(Number(process.env.JIGONGBEN_PROBE_EXIT_CODE))",
      '',
    ].join('\n'),
    'utf8',
  )

  try {
    const success = await runLauncher(0)
    const failure = await runLauncher(7)
    const productionAfter = await optionalFileSnapshot(productionRecords)
    const isolatedRecords = await optionalFileSnapshot(path.join(isolatedDataDir, 'records.json'))
    const evidence = {
      fixtureRoot,
      containsChinese: /[\u3400-\u9fff]/u.test(fixtureRoot),
      containsCmdMetacharacters: /[ &()]/u.test(fixtureRoot),
      browserLaunchPreventedByProbeEntrypoint: true,
      success,
      failure,
      expectedNodeArguments: ['--open'],
      expectedWorkingDirectory: fixtureRoot,
      isolatedDataDir,
      isolatedRecordsCreated: isolatedRecords.exists,
      productionRecordsBefore: { exists: productionBefore.exists, size: productionBefore.size ?? null },
      productionDataUnchanged: JSON.stringify(productionBefore) === JSON.stringify(productionAfter),
    }
    console.log(JSON.stringify(evidence, null, 2))

    assert.equal(success.code, 0, '成功路径应返回退出码 0')
    assert.deepEqual(success.invocation.argv, ['--open'], '启动器应向 Node 传递且只传递 --open')
    assert.equal(path.resolve(success.invocation.cwd), path.resolve(fixtureRoot), 'Node 工作目录应切到启动器目录')
    assert.equal(path.resolve(success.invocation.dataDir), path.resolve(isolatedDataDir), '隔离数据目录环境变量应原样传递')
    assert.equal(isolatedRecords.exists, false, 'Node 探针不得创建任何真实记工数据')
    assert.equal(evidence.productionDataUnchanged, true, '验证过程不得修改正式 data/records.json')
    assert.equal(failure.code, 7, '启动器应透传 Node 的非零退出码')
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
