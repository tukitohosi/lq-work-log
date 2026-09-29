// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import forgeConfig, { ignoreNonRuntimeFile } from '../forge.config.mjs'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

async function reachableLocalModules(entryRelative) {
  const pending = [entryRelative]
  const visited = new Set()
  while (pending.length) {
    const relative = pending.pop()
    if (!relative || visited.has(relative)) continue
    visited.add(relative)
    const source = await readFile(path.join(projectRoot, ...relative.split('/')), 'utf8')
    for (const match of source.matchAll(/["'](\.{1,2}\/[^"']+\.mjs)["']/g)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]))
      if (!visited.has(dependency)) pending.push(dependency)
    }
  }
  return [...visited].sort()
}

describe('desktop packaging allowlist', () => {
  it('keeps only the runtime application files', () => {
    for (const runtimePath of [
      '/package.json',
      '/desktop/main.mjs',
      'dist/assets/index.js',
      '\\server\\app.mjs',
      '/server/store.mjs',
      '/server/validation.mjs',
      '/server/payroll-rules.mjs',
      '/shared/app-data-delta.mjs',
      '/shared/data-limits.mjs',
      '/shared/payroll-rules.mjs',
      'node_modules',
      'node_modules/electron-squirrel-startup/index.js',
      'node_modules/electron-squirrel-startup/node_modules/debug/src/index.js',
    ]) {
      expect(ignoreNonRuntimeFile(runtimePath), runtimePath).toBe(false)
    }
    expect(ignoreNonRuntimeFile('/server/app.test.mjs')).toBe(true)
  })

  it('rejects data, caches, sources and unrelated dependencies with or without a leading slash', () => {
    for (const excludedPath of [
      '/data/records.json',
      'data/records.last-good.json',
      '\\.electron-cache\\hash\\electron.zip',
      '/.nuget-cache/nuget-v7.9.0.exe',
      '/out/make/Setup.exe',
      'src/App.vue',
      '/tests/app.test.ts',
      'node_modules/vue/dist/vue.js',
      '/shared/app-data-delta.d.mts',
      '/shared/notes.md',
      '/shared/nested/runtime.mjs',
      'README.md',
    ]) {
      expect(ignoreNonRuntimeFile(excludedPath), excludedPath).toBe(true)
    }
  })

  it('keeps every local ESM dependency reachable from the desktop entry point', async () => {
    const reachable = await reachableLocalModules('desktop/main.mjs')
    expect(reachable).toEqual(expect.arrayContaining([
      'desktop/main.mjs',
      'server/app.mjs',
      'server/store.mjs',
      'server/validation.mjs',
      'shared/app-data-delta.mjs',
      'shared/data-limits.mjs',
      'shared/payroll-rules.mjs',
    ]))
    for (const relative of reachable) {
      expect(ignoreNonRuntimeFile(`/${relative}`), relative).toBe(false)
    }
  })

  it('derives the Squirrel installer name from package.json instead of a stale release number', async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
    expect(forgeConfig.makers[0].config.setupExe).toBe(
      `L.Q记工本-${packageJson.version}-Setup.exe`,
    )
  })
})
