import { beforeEach, describe, expect, it, vi } from 'vitest'

const share = vi.hoisted(() => vi.fn())

vi.mock('@capacitor/share', () => ({ Share: { share } }))

import { isShareCanceledError, shareAndroidFile } from '../src/android-share'

describe('Android share handling', () => {
  beforeEach(() => share.mockReset())

  it('treats the native Android cancellation as a neutral result', async () => {
    share.mockRejectedValueOnce(new Error('Share canceled'))
    await expect(shareAndroidFile({ files: ['file:///backup.json'] })).resolves.toEqual({ canceled: true })
  })

  it('does not hide real sharing failures', async () => {
    share.mockRejectedValueOnce(new Error('only file urls are supported'))
    await expect(shareAndroidFile({ files: ['bad://backup.json'] })).rejects.toThrow('only file urls are supported')
  })

  it('matches only the native cancellation message', () => {
    expect(isShareCanceledError({ message: 'Share cancelled' })).toBe(true)
    expect(isShareCanceledError(new Error('Share canceled unexpectedly'))).toBe(false)
  })
})
