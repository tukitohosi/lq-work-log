// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { atomicReplaceFile } from '../desktop/atomic-file.mjs'

const temporaryRoots = []

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lq-atomic-file-test-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('atomic external file replacement', () => {
  it('fsyncs a same-directory temporary file and atomically replaces the destination', async () => {
    const root = await temporaryRoot()
    const target = path.join(root, '工资条.xlsx')
    await writeFile(target, 'old')
    const order = []
    const handle = {
      writeFile: vi.fn(async () => order.push('write')),
      sync: vi.fn(async () => order.push('sync')),
      close: vi.fn(async () => order.push('close')),
    }
    let temporaryPath

    await atomicReplaceFile(target, new Uint8Array([1, 2, 3]), {
      uniqueId: () => 'fixed-id',
      openFile: vi.fn(async (candidate, flags) => {
        temporaryPath = candidate
        expect(flags).toBe('wx')
        return handle
      }),
      renameFile: vi.fn(async (source, destination) => {
        order.push('rename')
        expect(source).toBe(temporaryPath)
        expect(destination).toBe(path.resolve(target))
      }),
    })

    expect(path.dirname(temporaryPath)).toBe(path.dirname(path.resolve(target)))
    expect(order).toEqual(['write', 'sync', 'close', 'rename'])
  })

  it('writes exact bytes, replaces existing content and leaves no temporary file', async () => {
    const root = await temporaryRoot()
    const target = path.join(root, '备份.json')
    await writeFile(target, 'old')

    await atomicReplaceFile(target, Buffer.from('{"ok":true}', 'utf8'))

    expect(await readFile(target, 'utf8')).toBe('{"ok":true}')
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('preserves the old destination and cleans the temporary file when rename fails', async () => {
    const root = await temporaryRoot()
    const target = path.join(root, '记工表.xlsx')
    await writeFile(target, 'old workbook')
    const failure = Object.assign(new Error('destination is busy'), { code: 'EPERM' })

    await expect(atomicReplaceFile(target, new Uint8Array([0x50, 0x4b]), {
      uniqueId: () => 'rename-failure',
      renameFile: vi.fn(async () => { throw failure }),
    })).rejects.toBe(failure)

    expect(await readFile(target, 'utf8')).toBe('old workbook')
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
