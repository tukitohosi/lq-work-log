import { randomUUID } from 'node:crypto'

export const DEFAULT_CLOSE_FLUSH_TIMEOUT_MS = 25_000
export const DEFAULT_CLOSE_ACK_GRACE_MS = 50

const MAX_FINISHED_REQUESTS = 32

function ensureFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`)
  return value
}

/**
 * Tracks one close-flush request at a time and returns an explicit ACK for
 * every syntactically valid renderer completion. Finished request IDs are kept
 * in a small bounded history so a response arriving after timeout/retry can be
 * identified instead of being mistaken for the active request.
 */
export function createCloseHandshake(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('close handshake options are required')
  }
  const sendRequest = ensureFunction(options.sendRequest, 'sendRequest')
  const onAccepted = ensureFunction(options.onAccepted, 'onAccepted')
  const onRejected = ensureFunction(options.onRejected, 'onRejected')
  const onTimeout = ensureFunction(options.onTimeout, 'onTimeout')
  const onSendError = ensureFunction(options.onSendError, 'onSendError')
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const randomId = options.randomId ?? randomUUID
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLOSE_FLUSH_TIMEOUT_MS
  const acknowledgementGraceMs = options.acknowledgementGraceMs ?? DEFAULT_CLOSE_ACK_GRACE_MS

  ensureFunction(setTimer, 'setTimer')
  ensureFunction(clearTimer, 'clearTimer')
  ensureFunction(randomId, 'randomId')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive number')
  }
  if (!Number.isFinite(acknowledgementGraceMs) || acknowledgementGraceMs < 0) {
    throw new RangeError('acknowledgementGraceMs must not be negative')
  }

  let disposed = false
  let pending = null
  let acceptedTimer = null
  let acceptedRequestId = null
  const finished = new Map()

  const remember = (requestId, status) => {
    finished.delete(requestId)
    finished.set(requestId, status)
    while (finished.size > MAX_FINISHED_REQUESTS) {
      finished.delete(finished.keys().next().value)
    }
  }

  const clearPending = (status = 'cancelled') => {
    if (!pending) return null
    const current = pending
    clearTimer(current.timer)
    pending = null
    remember(current.requestId, status)
    return current
  }

  const request = () => {
    if (disposed) return { status: 'ignored' }
    if (acceptedTimer !== null) {
      return { status: 'coalesced', requestId: acceptedRequestId }
    }
    if (pending) return { status: 'coalesced', requestId: pending.requestId }

    const requestId = randomId()
    const timer = setTimer(() => {
      if (pending?.requestId !== requestId) return
      clearPending('expired')
      void Promise.resolve(onTimeout({ requestId, timeoutMs }))
    }, timeoutMs)
    timer?.unref?.()
    pending = { requestId, timer }

    try {
      sendRequest({ requestId, timeoutMs })
      return { status: 'requested', requestId }
    } catch (error) {
      clearPending('send-failed')
      void Promise.resolve(onSendError(error, { requestId }))
      return { status: 'send-failed', requestId }
    }
  }

  const complete = (result) => {
    const requestId = result.requestId
    if (disposed) return { accepted: false, requestId, status: 'disposed' }
    if (!pending || pending.requestId !== requestId) {
      return {
        accepted: false,
        requestId,
        status: finished.get(requestId) ?? 'unknown',
      }
    }

    clearPending(result.ok ? 'accepted' : 'rejected')
    if (result.ok) {
      acceptedRequestId = requestId
      acceptedTimer = setTimer(() => {
        acceptedTimer = null
        acceptedRequestId = null
        if (!disposed) void Promise.resolve(onAccepted({ requestId }))
      }, acknowledgementGraceMs)
      acceptedTimer?.unref?.()
    } else {
      void Promise.resolve(onRejected(result.error || '页面报告保存失败。', { requestId }))
    }
    return {
      accepted: true,
      requestId,
      status: result.ok ? 'accepted' : 'rejected',
    }
  }

  const cancel = (status = 'cancelled') => {
    clearPending(status)
  }

  const dispose = () => {
    disposed = true
    clearPending('disposed')
    if (acceptedTimer !== null) clearTimer(acceptedTimer)
    acceptedTimer = null
    acceptedRequestId = null
  }

  return {
    cancel,
    complete,
    dispose,
    hasPending: () => Boolean(pending),
    request,
  }
}
