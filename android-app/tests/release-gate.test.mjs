// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPackage } from '@electron/asar'
import {
  collectReleaseEvidence,
  releaseEvidenceIdentity,
} from '../scripts/finalize-release.mjs'

const temporaryRoots = []

async function writeBoth(projectRoot, stagingRoot, relative, contents) {
  for (const root of [projectRoot, stagingRoot]) {
    const target = path.join(root, ...relative.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
}

async function releaseFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lq-release-gate-test-'))
  temporaryRoots.push(root)
  const projectRoot = path.join(root, 'project')
  const stagingRoot = path.join(root, 'staging')
  const packageJson = `${JSON.stringify({
    name: 'release-gate-fixture',
    productName: 'FixtureApp',
    version: '9.8.7',
    main: 'desktop/main.mjs',
  }, null, 2)}\n`
  await writeBoth(projectRoot, stagingRoot, 'package.json', packageJson)
  await writeBoth(projectRoot, stagingRoot, 'desktop/main.mjs', 'export const desktop = true\n')
  await writeBoth(projectRoot, stagingRoot, 'dist/index.html', '<main>fixture</main>\n')
  await writeBoth(projectRoot, stagingRoot, 'shared/runtime.mjs', 'export const shared = true\n')
  await writeFile(
    path.join(projectRoot, 'shared', 'runtime.d.mts'),
    'export declare const shared: boolean\n',
  )
  if (options.packageSharedTypeDeclaration) {
    await writeFile(
      path.join(stagingRoot, 'shared', 'runtime.d.mts'),
      'export declare const shared: boolean\n',
    )
  }
  await writeBoth(
    projectRoot,
    stagingRoot,
    'server/app.mjs',
    "export { shared as server } from '../shared/runtime.mjs'\n",
  )
  await writeBoth(
    projectRoot,
    stagingRoot,
    'node_modules/electron-squirrel-startup/index.js',
    'module.exports = false\n',
  )

  const appRoot = path.join(projectRoot, 'out', 'FixtureApp-win32-x64')
  const archive = path.join(appRoot, 'resources', 'app.asar')
  await mkdir(path.dirname(archive), { recursive: true })
  await createPackage(stagingRoot, archive)
  await writeFile(path.join(appRoot, 'FixtureApp.exe'), 'packaged executable')
  const installer = path.join(
    projectRoot,
    'out',
    'make',
    'squirrel.windows',
    'x64',
    'L.Q记工本-9.8.7-Setup.exe',
  )
  await mkdir(path.dirname(installer), { recursive: true })
  await writeFile(installer, 'installer')
  return { projectRoot }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('release integrity gate', () => {
  it('matches source runtime files to the packaged ASAR and fingerprints the executable', async () => {
    const { projectRoot } = await releaseFixture()

    const evidence = await collectReleaseEvidence(projectRoot)

    expect(evidence).toMatchObject({
      version: '9.8.7',
      runtimeFileCount: 6,
      executable: 'out/FixtureApp-win32-x64/FixtureApp.exe',
      archive: 'out/FixtureApp-win32-x64/resources/app.asar',
    })
    expect(evidence.sourceRuntimeFingerprint).toBe(evidence.packagedRuntimeFingerprint)
    expect(evidence.executableSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(releaseEvidenceIdentity({ ...evidence, passedAt: 'ignored' })).not.toHaveProperty(
      'passedAt',
    )
  })

  it('rejects a stale package after a runtime source file changes', async () => {
    const { projectRoot } = await releaseFixture()
    await writeFile(path.join(projectRoot, 'desktop', 'main.mjs'), 'export const desktop = false\n')

    await expect(collectReleaseEvidence(projectRoot)).rejects.toThrow('不是当前源码版本')
  })

  it('rejects non-runtime declarations packaged under the shared directory', async () => {
    const { projectRoot } = await releaseFixture({ packageSharedTypeDeclaration: true })

    await expect(collectReleaseEvidence(projectRoot)).rejects.toThrow('ASAR 包含运行白名单之外的文件')
  })
})
