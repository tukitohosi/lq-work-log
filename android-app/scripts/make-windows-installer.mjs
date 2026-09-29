import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadArtifact } from '@electron/get'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const extraForgeArgs = process.argv.slice(2)
const electronVersion = '43.3.0'
const electronZipName = `electron-v${electronVersion}-win32-x64.zip`
const electronZipSha256 = '18528bedc6a9b04bdc5efb7b803cbc3cb0e5ea6415d54046e23d464d89a00da9'
const nugetVersion = '7.9.0'
const nugetSha256 = '992d70cac5b06c38efec91806caba64cdcc07e6d963a0959dbbbaf264d33b800'
const nugetUrl = `https://dist.nuget.org/win-x86-commandline/v${nugetVersion}/nuget.exe`

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      windowsHide: true,
      ...options,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(command)} exited with ${signal ?? code}`))
    })
  })
}

function trySubst(drive, target) {
  return new Promise((resolve, reject) => {
    const child = spawn('subst.exe', [drive, target], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code === 0))
  })
}

async function createAsciiMapping(target) {
  for (let code = 'Z'.charCodeAt(0); code >= 'P'.charCodeAt(0); code -= 1) {
    const drive = `${String.fromCharCode(code)}:`
    if (existsSync(`${drive}\\`)) continue
    if (await trySubst(drive, target)) return drive
  }
  throw new Error('无法找到可用盘符来创建临时 ASCII 构建路径。')
}

async function sha256(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const input = createReadStream(file)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', resolve)
    input.on('error', reject)
  })
  return hash.digest('hex')
}

async function findCachedElectronZip(cacheRoot) {
  const directories = await readdir(cacheRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const directory of directories) {
    if (!directory.isDirectory()) continue
    const candidate = path.join(cacheRoot, directory.name, electronZipName)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

async function ensureVerifiedElectronZip() {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  if (packageJson.devDependencies?.electron !== electronVersion) {
    throw new Error(
      `Electron 版本已从 ${electronVersion} 改为 ${packageJson.devDependencies?.electron ?? '未知'}，请同步更新桌面构建脚本中的 ZIP 校验值。`,
    )
  }

  const cacheRoot = path.join(projectRoot, '.electron-cache')
  let zipPath = await findCachedElectronZip(cacheRoot)
  if (!zipPath) {
    console.log(`本地没有 Electron ${electronVersion} 构建缓存，开始从官方发布页下载并校验。`)
    zipPath = await downloadArtifact({
      version: electronVersion,
      platform: 'win32',
      arch: 'x64',
      artifactName: 'electron',
      cacheRoot,
    })
  }

  const actualHash = await sha256(zipPath)
  if (actualHash !== electronZipSha256) {
    throw new Error(
      `Electron 构建缓存校验失败：${zipPath}\n期望 ${electronZipSha256}\n实际 ${actualHash}`,
    )
  }
  console.log(`Electron ${electronVersion} 本地缓存 SHA-256 校验通过。`)
}

async function ensureVerifiedNuget() {
  const cacheRoot = path.join(projectRoot, '.nuget-cache')
  const nugetPath = path.join(cacheRoot, `nuget-v${nugetVersion}.exe`)
  await mkdir(cacheRoot, { recursive: true })
  if (!existsSync(nugetPath)) {
    console.log(`本地没有 NuGet ${nugetVersion} 构建缓存，开始从微软官方分发地址下载并校验。`)
    const temporaryPath = `${nugetPath}.download-${process.pid}`
    try {
      const response = await fetch(nugetUrl)
      if (!response.ok) throw new Error(`NuGet 下载失败（HTTP ${response.status}）`)
      await writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()))
      await rename(temporaryPath, nugetPath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  const actualHash = await sha256(nugetPath)
  if (actualHash !== nugetSha256) {
    throw new Error(
      `NuGet 构建缓存校验失败：${nugetPath}\n期望 ${nugetSha256}\n实际 ${actualHash}`,
    )
  }
  console.log(`NuGet ${nugetVersion} 本地缓存 SHA-256 校验通过。`)
  return nugetPath
}

if (process.platform !== 'win32') {
  throw new Error('Squirrel 安装包只能在 Windows 上构建。')
}

let mappedDrive
let tempDrive
let physicalTempRoot
let buildRoot = projectRoot

try {
  const [, nugetPath] = await Promise.all([ensureVerifiedElectronZip(), ensureVerifiedNuget()])

  if (/[^\x00-\x7f]/.test(projectRoot)) {
    mappedDrive = await createAsciiMapping(projectRoot)
    buildRoot = `${mappedDrive}\\`
    console.log(`检测到中文项目路径，临时映射为 ${mappedDrive}（构建完成后自动移除）。`)
  }

  physicalTempRoot = await mkdtemp(path.join(os.tmpdir(), 'lq-jigongben-forge-'))
  tempDrive = await createAsciiMapping(physicalTempRoot)
  const buildTempRoot = `${tempDrive}\\`
  const squirrelVendorPhysical = path.join(physicalTempRoot, 'squirrel-vendor')
  await cp(path.join(projectRoot, 'node_modules', 'electron-winstaller', 'vendor'), squirrelVendorPhysical, {
    recursive: true,
  })
  await copyFile(nugetPath, path.join(squirrelVendorPhysical, 'nuget.exe'))
  const squirrelVendorBuild = path.win32.join(buildTempRoot, 'squirrel-vendor')

  const forgeCli = path.win32.join(
    buildRoot,
    'node_modules',
    '@electron-forge',
    'cli',
    'dist',
    'electron-forge.js',
  )
  await run(
    process.execPath,
    [forgeCli, 'make', '--platform=win32', '--arch=x64', ...extraForgeArgs],
    {
      cwd: buildRoot,
      env: {
        ...process.env,
        LQ_ELECTRON_CACHE_VERIFIED: '1',
        LQ_SQUIRREL_VENDOR_DIRECTORY: squirrelVendorBuild,
        TEMP: buildTempRoot,
        TMP: buildTempRoot,
      },
    },
  )
} finally {
  if (tempDrive) {
    const removed = await trySubst(tempDrive, '/D').catch(() => false)
    if (!removed) {
      console.warn(`临时盘符 ${tempDrive} 未能自动移除，可运行：subst ${tempDrive} /D`)
    }
  }
  if (physicalTempRoot) {
    const resolvedTempRoot = path.resolve(physicalTempRoot)
    const expectedParent = path.resolve(os.tmpdir())
    if (
      path.dirname(resolvedTempRoot) !== expectedParent ||
      !path.basename(resolvedTempRoot).startsWith('lq-jigongben-forge-')
    ) {
      throw new Error(`拒绝清理非预期临时目录：${resolvedTempRoot}`)
    }
    await rm(resolvedTempRoot, { recursive: true, force: true })
  }
  if (mappedDrive) {
    const removed = await trySubst(mappedDrive, '/D').catch(() => false)
    if (!removed) {
      console.warn(`临时盘符 ${mappedDrive} 未能自动移除，可运行：subst ${mappedDrive} /D`)
    }
  }
}
