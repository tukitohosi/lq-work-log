import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))
const iconBase = path.join(projectRoot, 'assets', 'app-icon')
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))

export function ignoreNonRuntimeFile(file) {
  const relative = String(file ?? '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')

  if (!relative) return false
  if (relative === 'package.json') return false
  if (relative === 'desktop' || relative.startsWith('desktop/')) return false
  if (relative === 'dist' || relative.startsWith('dist/')) return false
  if (relative === 'server') return false
  if (relative.startsWith('server/')) return /\.test\.mjs$/i.test(relative)
  if (relative === 'shared') return false
  if (relative.startsWith('shared/')) {
    // Only executable, top-level shared modules belong in the desktop runtime.
    // Type declarations and future documentation/fixtures stay out of ASAR.
    return !/^shared\/[^/]+\.mjs$/i.test(relative)
  }
  if (relative === 'node_modules') return false
  if (
    relative === 'node_modules/electron-squirrel-startup' ||
    relative.startsWith('node_modules/electron-squirrel-startup/')
  ) {
    return false
  }
  return true
}

export default {
  outDir: 'out',
  packagerConfig: {
    asar: true,
    download: {
      cacheRoot: path.join(projectRoot, '.electron-cache'),
      // scripts/make-windows-installer.mjs verifies the pinned ZIP hash first.
      // This avoids @electron/get downloading SHASUMS256.txt on every offline build.
      unsafelyDisableChecksums: process.env.LQ_ELECTRON_CACHE_VERIFIED === '1',
    },
    icon: iconBase,
    executableName: 'L.Q记工本',
    appBundleId: 'com.lq.jigongben',
    appCopyright: 'Copyright © 2026 L.Q',
    win32metadata: {
      CompanyName: 'L.Q',
      FileDescription: '完全离线运行的本地电子记工本',
      InternalName: 'LQJigongben',
      OriginalFilename: 'L.Q记工本.exe',
      ProductName: 'L.Q记工本',
    },
    ignore: ignoreNonRuntimeFile,
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'LQJigongben',
        title: 'L.Q记工本',
        authors: 'L.Q',
        owners: 'L.Q',
        description: '完全离线运行的本地电子记工本',
        exe: 'L.Q记工本.exe',
        setupExe: `L.Q记工本-${packageJson.version}-Setup.exe`,
        setupIcon: `${iconBase}.ico`,
        noMsi: true,
        ...(process.env.LQ_SQUIRREL_VENDOR_DIRECTORY
          ? { vendorDirectory: process.env.LQ_SQUIRREL_VENDOR_DIRECTORY }
          : {}),
      },
    },
  ],
}
