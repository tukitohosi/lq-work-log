import { describe, expect, it } from 'vitest'
import { isSingleVisibleEmoji } from '../src/avatar'

describe('avatar emoji validation', () => {
  it.each(['😀', '👷🏽', '👨‍👩‍👧‍👦', '🇨🇳', '1️⃣'])('accepts one visible emoji: %s', (value) => {
    expect(isSingleVisibleEmoji(value)).toBe(true)
  })

  it.each(['', 'A', '😀😀', ' 😀', '备注'])('rejects non-single emoji: %s', (value) => {
    expect(isSingleVisibleEmoji(value)).toBe(false)
  })
})
