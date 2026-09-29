// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  createRendererRecoveryController,
  DEFAULT_RENDERER_STABILITY_WINDOW_MS,
} from '../desktop/renderer-recovery.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function makeHarness(overrides = {}) {
  const state = { destroyed: false, quitting: false }
  const timers = []
  const cancelPendingClose = overrides.cancelPendingClose ?? vi.fn()
  const loadRenderer = overrides.loadRenderer ?? vi.fn().mockResolvedValue(undefined)
  const showRecovered = overrides.showRecovered ?? vi.fn().mockResolvedValue(undefined)
  const showManualRecovery =
    overrides.showManualRecovery ?? vi.fn().mockResolvedValue('exit')
  const showUnresponsive = overrides.showUnresponsive ?? vi.fn().mockResolvedValue('wait')
  const exitApplication = overrides.exitApplication ?? vi.fn().mockResolvedValue(undefined)
  const reportError = overrides.reportError ?? vi.fn()
  const setTimer = overrides.setTimer ?? vi.fn((callback, delay) => {
    const timer = { callback, cleared: false, delay, unref: vi.fn() }
    timers.push(timer)
    return timer
  })
  const clearTimer = overrides.clearTimer ?? vi.fn((timer) => {
    timer.cleared = true
  })

  const controller = createRendererRecoveryController({
    isQuitting: () => state.quitting,
    isWindowDestroyed: () => state.destroyed,
    cancelPendingClose,
    loadRenderer,
    showRecovered,
    showManualRecovery,
    showUnresponsive,
    exitApplication,
    reportError,
    setTimer,
    clearTimer,
    ...overrides,
  })

  return {
    cancelPendingClose,
    clearTimer,
    controller,
    exitApplication,
    loadRenderer,
    reportError,
    setTimer,
    showManualRecovery,
    showRecovered,
    showUnresponsive,
    state,
    timers,
  }
}

async function flushBackgroundWork() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('renderer recovery controller', () => {
  it('ignores clean exits, app shutdown and destroyed windows', async () => {
    const clean = makeHarness()
    expect(await clean.controller.handleRenderProcessGone({ reason: 'clean-exit' })).toMatchObject({
      status: 'ignored',
    })

    const quitting = makeHarness()
    quitting.state.quitting = true
    expect(await quitting.controller.handleRenderProcessGone({ reason: 'crashed' })).toMatchObject({
      status: 'ignored',
    })

    const destroyed = makeHarness()
    destroyed.state.destroyed = true
    expect(await destroyed.controller.handleRenderProcessGone({ reason: 'oom' })).toMatchObject({
      status: 'ignored',
    })

    for (const harness of [clean, quitting, destroyed]) {
      expect(harness.cancelPendingClose).not.toHaveBeenCalled()
      expect(harness.loadRenderer).not.toHaveBeenCalled()
    }
  })

  it('automatically reloads the first crash and coalesces concurrent events', async () => {
    const pendingLoad = deferred()
    const harness = makeHarness({ loadRenderer: vi.fn(() => pendingLoad.promise) })

    const firstRecovery = harness.controller.handleRenderProcessGone({
      reason: 'crashed',
      exitCode: -1,
    })
    const duplicate = await harness.controller.handleRenderProcessGone({
      reason: 'crashed',
      exitCode: -1,
    })

    expect(duplicate).toEqual({ status: 'coalesced', crashCount: 1 })
    expect(harness.cancelPendingClose).toHaveBeenCalledTimes(1)
    pendingLoad.resolve()

    expect(await firstRecovery).toEqual({ status: 'recovered-automatically', crashCount: 1 })
    await flushBackgroundWork()
    expect(harness.showRecovered).toHaveBeenCalledWith({
      details: { reason: 'crashed', exitCode: -1 },
      automatic: true,
      crashCount: 1,
    })
    expect(harness.setTimer).toHaveBeenCalledWith(
      expect.any(Function),
      DEFAULT_RENDERER_STABILITY_WINDOW_MS,
    )
  })

  it('requires an explicit retry for a second crash inside the stability window', async () => {
    const harness = makeHarness()
    await harness.controller.handleRenderProcessGone({ reason: 'crashed' })

    const choice = deferred()
    harness.showManualRecovery.mockImplementationOnce(() => choice.promise)
    const secondRecovery = harness.controller.handleRenderProcessGone({ reason: 'oom' })
    await Promise.resolve()

    expect(harness.loadRenderer).toHaveBeenCalledTimes(1)
    expect(harness.showManualRecovery).toHaveBeenCalledWith({
      details: { reason: 'oom' },
      error: undefined,
      crashCount: 2,
    })

    choice.resolve('retry')
    expect(await secondRecovery).toEqual({ status: 'recovered-manually', crashCount: 2 })
    expect(harness.loadRenderer).toHaveBeenCalledTimes(2)
    expect(harness.exitApplication).not.toHaveBeenCalled()
  })

  it('allows automatic recovery again only after a stable window completes', async () => {
    const harness = makeHarness()
    await harness.controller.handleRenderProcessGone({ reason: 'crashed' })

    const stabilityTimer = harness.timers.at(-1)
    expect(stabilityTimer.delay).toBe(DEFAULT_RENDERER_STABILITY_WINDOW_MS)
    stabilityTimer.callback()

    expect(
      await harness.controller.handleRenderProcessGone({ reason: 'memory-eviction' }),
    ).toEqual({ status: 'recovered-automatically', crashCount: 1 })
    expect(harness.showManualRecovery).not.toHaveBeenCalled()
    expect(harness.loadRenderer).toHaveBeenCalledTimes(2)
  })

  it('falls back to a manual retry when the automatic reload fails', async () => {
    const loadRenderer = vi
      .fn()
      .mockRejectedValueOnce(new Error('automatic load failed'))
      .mockResolvedValueOnce(undefined)
    const harness = makeHarness({
      loadRenderer,
      showManualRecovery: vi.fn().mockResolvedValue('retry'),
    })

    expect(await harness.controller.handleRenderProcessGone({ reason: 'launch-failed' })).toEqual({
      status: 'recovered-manually',
      crashCount: 1,
    })
    expect(harness.showManualRecovery).toHaveBeenCalledWith({
      details: { reason: 'launch-failed' },
      error: 'automatic load failed',
      crashCount: 1,
    })
    expect(loadRenderer).toHaveBeenCalledTimes(2)
    expect(harness.reportError).toHaveBeenCalledWith(expect.any(Error), 'automatic-reload')
  })

  it('never loops automatically after a manual retry fails', async () => {
    const loadRenderer = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('manual retry failed'))
    const showManualRecovery = vi
      .fn()
      .mockResolvedValueOnce('retry')
      .mockResolvedValueOnce('exit')
    const harness = makeHarness({ loadRenderer, showManualRecovery })

    await harness.controller.handleRenderProcessGone({ reason: 'crashed' })
    expect(await harness.controller.handleRenderProcessGone({ reason: 'oom' })).toEqual({
      status: 'exited',
      crashCount: 2,
    })

    expect(loadRenderer).toHaveBeenCalledTimes(2)
    expect(showManualRecovery).toHaveBeenCalledTimes(2)
    expect(harness.exitApplication).toHaveBeenCalledTimes(1)
    expect(harness.reportError).toHaveBeenCalledWith(expect.any(Error), 'manual-reload')
  })

  it('clears the stability timer and ignores future events after disposal', async () => {
    const harness = makeHarness()
    await harness.controller.handleRenderProcessGone({ reason: 'crashed' })
    const timer = harness.timers.at(-1)

    harness.controller.dispose()

    expect(timer.cleared).toBe(true)
    expect(await harness.controller.handleRenderProcessGone({ reason: 'crashed' })).toMatchObject({
      status: 'ignored',
    })
    expect(harness.loadRenderer).toHaveBeenCalledTimes(1)
  })

  it('coalesces duplicate unresponsive events and waits without reloading by default', async () => {
    const choice = deferred()
    const harness = makeHarness({ showUnresponsive: vi.fn(() => choice.promise) })

    const first = harness.controller.handleUnresponsive()
    await Promise.resolve()
    expect(await harness.controller.handleUnresponsive()).toEqual({ status: 'coalesced' })
    expect(harness.showUnresponsive).toHaveBeenCalledTimes(1)
    expect(harness.loadRenderer).not.toHaveBeenCalled()

    choice.resolve('wait')
    expect(await first).toEqual({ status: 'waiting' })
    expect(harness.loadRenderer).not.toHaveBeenCalled()
    expect(harness.controller.handleResponsive()).toEqual({ status: 'responsive' })
    expect(harness.controller.handleResponsive()).toEqual({ status: 'ignored' })
  })

  it('ignores a stale force-exit choice after the window reports responsive', async () => {
    const choice = deferred()
    const harness = makeHarness({ showUnresponsive: vi.fn(() => choice.promise) })

    const pending = harness.controller.handleUnresponsive()
    await Promise.resolve()
    expect(harness.controller.handleResponsive()).toEqual({ status: 'responsive' })
    choice.resolve('exit')

    expect(await pending).toEqual({ status: 'responsive' })
    expect(harness.exitApplication).not.toHaveBeenCalled()
    expect(harness.loadRenderer).not.toHaveBeenCalled()
  })

  it('exits only after an explicit choice and never treats unresponsive as a crash reload', async () => {
    const harness = makeHarness({ showUnresponsive: vi.fn().mockResolvedValue('exit') })

    expect(await harness.controller.handleUnresponsive()).toEqual({ status: 'exited' })
    expect(harness.exitApplication).toHaveBeenCalledWith({ reason: 'unresponsive', episode: 1 })
    expect(harness.loadRenderer).not.toHaveBeenCalled()
  })
})
