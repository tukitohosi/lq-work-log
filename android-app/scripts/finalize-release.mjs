import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage, statFile } from '@electron/asar'

export const RELEASE_VERIFICATION_GATE = '.release-verification.json'
export const DESKTOP_SMOKE_GATE = '.desktop-smoke.json'

const scriptPath = fileURLToPath(import.meta.url)
const defaultProjectRoot = path.dirname(path.dirname(scriptPath))
const RUNTIME_SOURCE_ROOTS = [
  'desktop',
  'dist',
  'server',
  'shared',
  'node_modules/electron-squirrel-startup',
]

function normalizeRelative(filePath) {
  return filePath.replaceAll('\\', '/').replace(/^\/+/, '')
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(fullPath)))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

function isRuntimeRelative(relative) {
  if (relative === 'package.json') return true
  if (relative === 'shared') return true
  if (relative.startsWith('shared/')) return /^shared\/[^/]+\.mjs$/i.test(relative)
  if (/^server\/.*\.test\.mjs$/i.test(relative)) return false
  return RUNTIME_SOURCE_ROOTS
    .filter((root) => root !== 'shared')
    .some((root) => relative === root || relative.startsWith(`${root}/`))
}

async function sourceRuntimeFiles(projectRoot) {
  const files = [path.join(projectRoot, 'package.json')]
  for (const root of RUNTIME_SOURCE_ROOTS) {
    const rootPath = path.join(projectRoot, ...root.split('/'))
    const rootFiles = await walk(rootPath)
    files.push(...rootFiles.filter((file) =>
      isRuntimeRelative(normalizeRelative(path.relative(projectRoot, file))),
    ))
  }
  return files.sort((left, right) =>
    normalizeRelative(path.relative(projectRoot, left)).localeCompare(
      normalizeRelative(path.relative(projectRoot, right)),
    ),
  )
}

function archiveRuntimeFiles(archive) {
  const files = []
  for (const rawEntry of listPackage(archive, { isPack: false })) {
    const relative = normalizeRelative(rawEntry)
    if (!isRuntimeRelative(relative)) continue
    const archivePath = rawEntry.replace(/^[\\/]+/, '')
    const metadata = statFile(archive, archivePath, false)
    if (!metadata.files) files.push({ relative, archivePath })
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative))
}

function assertArchiveAllowlist(archive) {
  const unexpected = listPackage(archive, { isPack: false })
    .map(normalizeRelative)
    .filter((relative) => relative !== 'node_modules' && !isRuntimeRelative(relative))
  if (unexpected.length) {
    throw new Error(
      `ASAR 包含运行白名单之外的文件，已停止发布：\n- ${unexpected.slice(0, 20).join('\n- ')}`,
    )
  }
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function sha256(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const input = createReadStream(file)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', resolve)
    input.on('error', reject)
  })
  return hash.digest('hex')
}

function fingerprintManifest(manifest) {
  const hash = createHash('sha256')
  for (const [relative, digest] of [...manifest].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(relative)
    hash.update('\0')
    hash.update(digest)
    hash.update('\n')
  }
  return hash.digest('hex')
}

async function compareRuntimeFiles(projectRoot, archive) {
  const sourceFiles = await sourceRuntimeFiles(projectRoot)
  const sourceRelatives = sourceFiles.map((file) => normalizeRelative(path.relative(projectRoot, file)))
  const archivedFiles = archiveRuntimeFiles(archive)
  const archivedRelatives = archivedFiles.map((file) => file.relative)
  const archivedPaths = new Map(archivedFiles.map((file) => [file.relative, file.archivePath]))
  const sourceSet = new Set(sourceRelatives)
  const archivedSet = new Set(archivedRelatives)
  const missing = sourceRelatives.filter((relative) => !archivedSet.has(relative))
  const extra = archivedRelatives.filter((relative) => !sourceSet.has(relative))
  if (missing.length || extra.length) {
    const details = [
      ...missing.slice(0, 20).map((relative) => `ASAR 缺少：${relative}`),
      ...extra.slice(0, 20).map((relative) => `ASAR 多出：${relative}`),
    ]
    throw new Error(`打包运行文件清单与当前源码不一致：\n- ${details.join('\n- ')}`)
  }

  const sourceManifest = new Map()
  const packagedManifest = new Map()
  const mismatches = []
  for (let index = 0; index < sourceFiles.length; index += 1) {
    const relative = sourceRelatives[index]
    const sourceDigest = hashBytes(await readFile(sourceFiles[index]))
    const packagedDigest = hashBytes(extractFile(archive, archivedPaths.get(relative)))
    sourceManifest.set(relative, sourceDigest)
    packagedManifest.set(relative, packagedDigest)
    if (sourceDigest !== packagedDigest) mismatches.push(relative)
  }
  if (mismatches.length) {
    throw new Error(
      `打包运行文件不是当前源码版本，已停止发布：\n- ${mismatches.slice(0, 20).join('\n- ')}`,
    )
  }
  return {
    fileCount: sourceFiles.length,
    sourceFingerprint: fingerprintManifest(sourceManifest),
    packagedFingerprint: fingerprintManifest(packagedManifest),
  }
}

async function resolvePackagedApplication(projectRoot, packageJson) {
  const outDir = path.join(projectRoot, 'out')
  const files = await walk(outDir)
  const archives = files.filter((file) => path.basename(file).toLowerCase() === 'app.asar')
  if (archives.length !== 1) {
    const details = archives.length ? `\n- ${archives.join('\n- ')}` : '（没有找到）'
    throw new Error(`无法唯一确定打包后的 app.asar：${details}`)
  }
  const archive = archives[0]
  const appRoot = path.dirname(path.dirname(archive))
  const executable = path.join(appRoot, `${packageJson.productName}.exe`)
  const executableStat = await stat(executable).catch(() => null)
  if (!executableStat?.isFile()) throw new Error(`没有找到打包后的主程序：${executable}`)
  return { archive, executable }
}

async function resolveInstaller(projectRoot, version, explicitSource) {
  if (explicitSource) {
    const resolved = path.resolve(projectRoot, explicitSource)
    const fileStat = await stat(resolved).catch(() => null)
    if (!fileStat?.isFile() || path.extname(resolved).toLowerCase() !== '.exe') {
      throw new Error(`指定的安装包不是 EXE 文件：${resolved}`)
    }
    return resolved
  }

  const expectedName = `L.Q记工本-${version}-Setup.exe`
  const files = await walk(path.join(projectRoot, 'out', 'make'))
  const exact = files.filter((file) => path.basename(file) === expectedName)
  if (exact.length !== 1) {
    const details = exact.length ? `\n- ${exact.join('\n- ')}` : '（没有找到）'
    throw new Error(`无法唯一确定当前版本 ${version} 的 Forge 安装包：${details}`)
  }
  return exact[0]
}

async function assertNoLooseUserData(projectRoot) {
  const outDir = path.join(projectRoot, 'out')
  const files = await walk(outDir)
  const forbidden = files.filter((file) => {
    const relative = normalizeRelative(path.relative(outDir, file)).toLowerCase()
    return /\/resources\/app(?:\.asar\.unpacked)?\/data\/(?:records(?:\.last-good)?\.json|backups\/)/.test(
      `/${relative}`,
    )
  })
  if (forbidden.length > 0) {
    throw new Error(`检测到打包目录包含用户数据，已停止发布：\n- ${forbidden.join('\n- ')}`)
  }
}

export function releaseEvidenceIdentity(evidence) {
  return {
    version: evidence.version,
    sourceRuntimeFingerprint: evidence.sourceRuntimeFingerprint,
    packagedRuntimeFingerprint: evidence.packagedRuntimeFingerprint,
    executableSha256: evidence.executableSha256,
    asarSha256: evidence.asarSha256,
    installerSha256: evidence.installerSha256,
    executable: evidence.executable,
    archive: evidence.archive,
    installer: evidence.installer,
  }
}

function identitiesMatch(left, right) {
  return JSON.stringify(releaseEvidenceIdentity(left)) === JSON.stringify(releaseEvidenceIdentity(right))
}

export async function collectReleaseEvidence(projectRoot = defaultProjectRoot, explicitSource) {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const version = packageJson.version
  if (!version || typeof version !== 'string') throw new Error('package.json 缺少有效版本号')

  await assertNoLooseUserData(projectRoot)
  const { archive, executable } = await resolvePackagedApplication(projectRoot, packageJson)
  const packagedPackage = JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
  if (packagedPackage.name !== packageJson.name || packagedPackage.version !== version) {
    throw new Error(
      `ASAR 版本与当前源码不一致：源码 ${packageJson.name}@${version}，ASAR ${packagedPackage.name}@${packagedPackage.version}`,
    )
  }
  assertArchiveAllowlist(archive)
  const runtime = await compareRuntimeFiles(projectRoot, archive)
  const installer = await resolveInstaller(projectRoot, version, explicitSource)
  return {
    gateVersion: 1,
    version,
    runtimeFileCount: runtime.fileCount,
    sourceRuntimeFingerprint: runtime.sourceFingerprint,
    packagedRuntimeFingerprint: runtime.packagedFingerprint,
    executable: normalizeRelative(path.relative(projectRoot, executable)),
    archive: normalizeRelative(path.relative(projectRoot, archive)),
    installer: normalizeRelative(path.relative(projectRoot, installer)),
    executableSha256: await sha256(executable),
    asarSha256: await sha256(archive),
    installerSha256: await sha256(installer),
  }
}

async function writeGate(projectRoot, filename, kind, evidence) {
  const gate = {
    ...evidence,
    kind,
    passedAt: new Date().toISOString(),
  }
  const target = path.join(projectRoot, 'out', filename)
  await writeFile(target, `${JSON.stringify(gate, null, 2)}\n`, 'utf8')
  return gate
}

async function requireMatchingGate(projectRoot, filename, kind, evidence) {
  const gatePath = path.join(projectRoot, 'out', filename)
  let gate
  try {
    gate = JSON.parse(await readFile(gatePath, 'utf8'))
  } catch {
    throw new Error(`缺少有效的${kind}门禁记录，请先运行完整发布链：${filename}`)
  }
  if (gate.kind !== kind || !identitiesMatch(gate, evidence)) {
    throw new Error(`${kind}门禁记录已过期，当前源码或打包文件发生了变化`)
  }
  return gate
}

export async function recordDesktopSmoke(projectRoot = defaultProjectRoot) {
  const evidence = await collectReleaseEvidence(projectRoot)
  return writeGate(projectRoot, DESKTOP_SMOKE_GATE, 'desktop-smoke', evidence)
}

async function verifyOnly(projectRoot, explicitSource) {
  await Promise.all([
    rm(path.join(projectRoot, 'out', RELEASE_VERIFICATION_GATE), { force: true }),
    rm(path.join(projectRoot, 'out', DESKTOP_SMOKE_GATE), { force: true }),
  ])
  const evidence = await collectReleaseEvidence(projectRoot, explicitSource)
  await writeGate(projectRoot, RELEASE_VERIFICATION_GATE, 'release-verification', evidence)
  console.log(`ASAR/源码版本与 ${evidence.runtimeFileCount} 个运行文件指纹校验通过。`)
  console.log(`主程序 SHA-256：${evidence.executableSha256}`)
  console.log(`安装包 SHA-256：${evidence.installerSha256}`)
}

async function finalize(projectRoot, explicitSource) {
  const evidence = await collectReleaseEvidence(projectRoot, explicitSource)
  await requireMatchingGate(
    projectRoot,
    RELEASE_VERIFICATION_GATE,
    'release-verification',
    evidence,
  )
  await requireMatchingGate(projectRoot, DESKTOP_SMOKE_GATE, 'desktop-smoke', evidence)

  const releaseDir = path.join(projectRoot, 'release')
  const releaseName = `L.Q记工本-${evidence.version}-Setup.exe`
  const destination = path.join(releaseDir, releaseName)
  const source = path.resolve(projectRoot, ...evidence.installer.split('/'))
  await mkdir(releaseDir, { recursive: true })
  await copyFile(source, destination)
  const checksum = await sha256(destination)
  const checksumPath = `${destination}.sha256`
  await writeFile(checksumPath, `${checksum}  ${releaseName}\n`, 'utf8')

  console.log(`安装包：${path.relative(projectRoot, destination)}`)
  console.log(`SHA-256：${checksum}`)
  console.log(`校验文件：${path.relative(projectRoot, checksumPath)}`)
}

async function main() {
  const args = process.argv.slice(2)
  const verify = args.includes('--verify-only')
  const unknownFlag = args.find((argument) => argument.startsWith('-') && argument !== '--verify-only')
  if (unknownFlag) throw new Error(`未知参数：${unknownFlag}`)
  const explicitSource = args.find((argument) => !argument.startsWith('-'))
  if (verify) await verifyOnly(defaultProjectRoot, explicitSource)
  else await finalize(defaultProjectRoot, explicitSource)
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main()
}
