export const DEFAULT_RENDERER_STABILITY_WINDOW_MS = 60_000

function ensureFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`)
  return value
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error || 'unknown renderer recovery error')
}

export function createRendererRecoveryController(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('renderer recovery options are required')
  }

  const isQuitting = ensureFunction(options.isQuitting, 'isQuitting')
  const isWindowDestroyed = ensureFunction(options.isWindowDestroyed, 'isWindowDestroyed')
  const cancelPendingClose = ensureFunction(options.cancelPendingClose, 'cancelPendingClose')
  const loadRenderer = ensureFunction(options.loadRenderer, 'loadRenderer')
  const showRecovered = ensureFunction(options.showRecovered, 'showRecovered')
  const showManualRecovery = ensureFunction(options.showManualRecovery, 'showManualRecovery')
  const showUnresponsive = ensureFunction(
    options.showUnresponsive ?? (async () => 'wait'),
    'showUnresponsive',
  )
  const exitApplication = ensureFunction(options.exitApplication, 'exitApplication')
  const reportError = options.reportError ?? (() => {})
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const stabilityWindowMs =
    options.stabilityWindowMs ?? DEFAULT_RENDERER_STABILITY_WINDOW_MS

  ensureFunction(reportError, 'reportError')
  ensureFunction(setTimer, 'setTimer')
  ensureFunction(clearTimer, 'clearTimer')
  if (!Number.isFinite(stabilityWindowMs) || stabilityWindowMs <= 0) {
    throw new RangeError('stabilityWindowMs must be a positive number')
  }

  let disposed = false
  let recoveryInFlight = false
  let consecutiveCrashes = 0
  let stableTimer = null
  let unresponsiveActive = false
  let unresponsiveGeneration = 0
  let unresponsivePrompt = null

  const clearStableTimer = () => {
    if (stableTimer !== null) clearTimer(stableTimer)
    stableTimer = null
  }

  const scheduleStableReset = () => {
    clearStableTimer()
    stableTimer = setTimer(() => {
      stableTimer = null
      consecutiveCrashes = 0
    }, stabilityWindowMs)
    stableTimer?.unref?.()
  }

  const notifyRecovered = (context) => {
    void Promise.resolve()
      .then(() => showRecovered(context))
      .catch((error) => reportError(error, 'show-recovered'))
  }

  const quitAfterCrash = async (context) => {
    try {
      await exitApplication(context)
    } catch (error) {
      reportError(error, 'exit-application')
    }
    return { status: 'exited', crashCount: consecutiveCrashes }
  }

  const recoverManually = async (details, initialError) => {
    let loadError = initialError

    while (!disposed && !isQuitting() && !isWindowDestroyed()) {
      let action
      try {
        action = await showManualRecovery({
          details,
          error: loadError ? errorMessage(loadError) : undefined,
          crashCount: consecutiveCrashes,
        })
      } catch (error) {
        reportError(error, 'show-manual-recovery')
        return quitAfterCrash({ details, error: errorMessage(error) })
      }

      if (action !== 'retry') {
        return quitAfterCrash({
          details,
          error: loadError ? errorMessage(loadError) : undefined,
        })
      }

      try {
        await loadRenderer()
        scheduleStableReset()
        notifyRecovered({ details, automatic: false, crashCount: consecutiveCrashes })
        return { status: 'recovered-manually', crashCount: consecutiveCrashes }
      } catch (error) {
        loadError = error
        reportError(error, 'manual-reload')
      }
    }

    return { status: 'ignored', crashCount: consecutiveCrashes }
  }

  const handleRenderProcessGone = async (details = {}) => {
    if (
      disposed ||
      isQuitting() ||
      isWindowDestroyed() ||
      details.reason === 'clean-exit'
    ) {
      return { status: 'ignored', crashCount: consecutiveCrashes }
    }
    if (recoveryInFlight) {
      return { status: 'coalesced', crashCount: consecutiveCrashes }
    }

    recoveryInFlight = true
    unresponsiveActive = false
    unresponsiveGeneration += 1
    unresponsivePrompt = null
    clearStableTimer()
    consecutiveCrashes += 1
    cancelPendingClose()

    try {
      if (consecutiveCrashes === 1) {
        try {
          await loadRenderer()
          scheduleStableReset()
          notifyRecovered({ details, automatic: true, crashCount: consecutiveCrashes })
          return { status: 'recovered-automatically', crashCount: consecutiveCrashes }
        } catch (error) {
          reportError(error, 'automatic-reload')
          return await recoverManually(details, error)
        }
      }

      return await recoverManually(details)
    } finally {
      recoveryInFlight = false
    }
  }

  const handleUnresponsive = async () => {
    if (disposed || isQuitting() || isWindowDestroyed()) {
      return { status: 'ignored' }
    }
    if (unresponsivePrompt || unresponsiveActive) {
      return { status: 'coalesced' }
    }

    unresponsiveActive = true
    const episode = ++unresponsiveGeneration
    const prompt = Promise.resolve().then(() => showUnresponsive({ episode }))
    unresponsivePrompt = prompt
    let action = 'wait'
    try {
      action = await prompt
    } catch (error) {
      reportError(error, 'show-unresponsive')
    } finally {
      if (unresponsivePrompt === prompt) unresponsivePrompt = null
    }

    if (
      disposed ||
      isQuitting() ||
      isWindowDestroyed() ||
      !unresponsiveActive ||
      unresponsiveGeneration !== episode
    ) {
      return { status: 'responsive' }
    }
    if (action === 'exit') {
      try {
        await exitApplication({ reason: 'unresponsive', episode })
      } catch (error) {
        reportError(error, 'exit-unresponsive')
      }
      return { status: 'exited' }
    }
    // Waiting is intentionally the default. An unresponsive event must never
    // reload the renderer automatically because its in-memory drafts may not
    // yet have reached the local server.
    return { status: 'waiting' }
  }

  const handleResponsive = () => {
    if (disposed || !unresponsiveActive) return { status: 'ignored' }
    unresponsiveActive = false
    unresponsiveGeneration += 1
    return { status: 'responsive' }
  }

  const dispose = () => {
    disposed = true
    unresponsiveActive = false
    unresponsiveGeneration += 1
    unresponsivePrompt = null
    clearStableTimer()
  }

  return {
    dispose,
    handleRenderProcessGone,
    handleResponsive,
    handleUnresponsive,
  }
}
