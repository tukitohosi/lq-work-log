// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  createCloseHandshake,
  DEFAULT_CLOSE_ACK_GRACE_MS,
  DEFAULT_CLOSE_FLUSH_TIMEOUT_MS,
} from '../desktop/close-handshake.mjs'

function harness() {
  const timers = []
  const sent = []
  let sequence = 0
  const onAccepted = vi.fn()
  const onRejected = vi.fn()
  const onTimeout = vi.fn()
  const onSendError = vi.fn()
  const controller = createCloseHandshake({
    randomId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    sendRequest: (request) => sent.push(request),
    onAccepted,
    onRejected,
    onTimeout,
    onSendError,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false, unref: vi.fn() }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { timer.cleared = true },
  })
  return { controller, onAccepted, onRejected, onSendError, onTimeout, sent, timers }
}

describe('desktop close-flush handshake', () => {
  it('sends a 25-second request and returns a requestId-bound ACK before closing', () => {
    const candidate = harness()
    const requested = candidate.controller.request()

    expect(candidate.sent).toEqual([{
      requestId: requested.requestId,
      timeoutMs: DEFAULT_CLOSE_FLUSH_TIMEOUT_MS,
    }])
    expect(candidate.timers[0].delay).toBe(25_000)
    const acknowledgement = candidate.controller.complete({ requestId: requested.requestId, ok: true })
    expect(acknowledgement).toEqual({
      accepted: true,
      requestId: requested.requestId,
      status: 'accepted',
    })
    expect(candidate.onAccepted).not.toHaveBeenCalled()
    expect(candidate.timers[1].delay).toBe(DEFAULT_CLOSE_ACK_GRACE_MS)
    candidate.timers[1].callback()
    expect(candidate.onAccepted).toHaveBeenCalledWith({ requestId: requested.requestId })
  })

  it('coalesces repeated close attempts and identifies a completion arriving after timeout', async () => {
    const candidate = harness()
    const requested = candidate.controller.request()
    expect(candidate.controller.request()).toEqual({
      status: 'coalesced',
      requestId: requested.requestId,
    })

    candidate.timers[0].callback()
    await Promise.resolve()
    expect(candidate.onTimeout).toHaveBeenCalledWith({
      requestId: requested.requestId,
      timeoutMs: 25_000,
    })
    expect(candidate.controller.complete({ requestId: requested.requestId, ok: true })).toEqual({
      accepted: false,
      requestId: requested.requestId,
      status: 'expired',
    })

    const retry = candidate.controller.request()
    expect(retry.requestId).not.toBe(requested.requestId)
    expect(candidate.controller.complete({ requestId: requested.requestId, ok: false })).toMatchObject({
      accepted: false,
      status: 'expired',
    })
  })

  it('acknowledges a matching renderer failure without accepting stale or unknown IDs', async () => {
    const candidate = harness()
    const requested = candidate.controller.request()
    expect(candidate.controller.complete({
      requestId: '00000000-0000-4000-8000-999999999999',
      ok: true,
    })).toMatchObject({ accepted: false, status: 'unknown' })

    expect(candidate.controller.complete({
      requestId: requested.requestId,
      ok: false,
      error: '磁盘写入失败',
    })).toMatchObject({ accepted: true, status: 'rejected' })
    await Promise.resolve()
    expect(candidate.onRejected).toHaveBeenCalledWith('磁盘写入失败', {
      requestId: requested.requestId,
    })
    expect(candidate.controller.complete({ requestId: requested.requestId, ok: true })).toMatchObject({
      accepted: false,
      status: 'rejected',
    })
  })
})
