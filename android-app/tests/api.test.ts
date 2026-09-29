import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, downloadBackup } from '../src/api'

function makeDesktopBridge(overrides: Partial<JigongbenDesktopBridge> = {}): JigongbenDesktopBridge {
  return {
    saveFile: vi.fn().mockResolvedValue({ canceled: false, filePath: 'C:\\备份.json' }),
    print: vi.fn().mockResolvedValue(undefined),
    savePdf: vi.fn().mockResolvedValue({ canceled: false, filePath: 'C:\\记工表.pdf' }),
    setTheme: vi.fn().mockResolvedValue(undefined),
    createWeeklyBackupIfDue: vi.fn().mockResolvedValue({ created: false, reason: 'not-due' }),
    getWeeklyBackupStatus: vi.fn().mockResolvedValue({ lastFailureAt: null, errorCode: null }),
    getApiSessionToken: vi.fn().mockResolvedValue('test-session-token-abcdefghijklmnopqrstuvwxyz'),
    openWeeklyBackupFolder: vi.fn().mockResolvedValue({ opened: true }),
    onCloseRequested: vi.fn().mockReturnValue(() => undefined),
    onCloseCancelled: vi.fn().mockReturnValue(() => undefined),
    completeClose: vi.fn().mockResolvedValue({ accepted: true }),
    ...overrides,
  }
}

afterEach(() => {
  delete window.jigongbenDesktop
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('backup export', () => {
  it('passes the original JSON and decoded Chinese filename to the desktop save dialog', async () => {
    const contents = '{"schemaVersion":8,"revision":1}'
    const saveFile = vi.fn().mockResolvedValue({ canceled: true })
    const getApiSessionToken = vi.fn().mockResolvedValue('test-session-token-abcdefghijklmnopqrstuvwxyz')
    window.jigongbenDesktop = makeDesktopBridge({ saveFile, getApiSessionToken })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(contents, {
          headers: {
            'content-disposition': "attachment; filename*=UTF-8''%E8%AE%B0%E5%B7%A5%E6%9C%AC%E5%A4%87%E4%BB%BD.json",
          },
        }),
      ),
    )

    await expect(downloadBackup()).resolves.toEqual({ canceled: true })
    expect(saveFile).toHaveBeenCalledWith({
      kind: 'json',
      filename: '记工本备份.json',
      data: contents,
    })
    expect(getApiSessionToken).toHaveBeenCalledOnce()
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer test-session-token-abcdefghijklmnopqrstuvwxyz',
    })
  })

  it('keeps the browser download path when the desktop bridge is absent', async () => {
    const contents = '{"schemaVersion":8,"revision":1}'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(contents)))
    const createObjectURL = vi.fn().mockReturnValue('blob:backup')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    await expect(downloadBackup()).resolves.toEqual({ canceled: false })
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
  })
})

describe('v8 API payloads', () => {
  it('sends future confirmation, emoji avatar and paid state using request-only fields', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ schemaVersion: 7, revision: 1 }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    vi.stubGlobal('fetch', fetchMock)

    await api.setAttendanceBatch(
      [{ workerId: 'worker', date: '2026-08-15', morning: 'present' }],
      { allowFuture: true, operationId: 'attendance-operation-id' },
    )
    await api.addWorker({
      name: 'Emoji 工人',
      avatarDataUrl: null,
      avatarEmoji: '👷',
      defaultDailyRateFen: 30_000,
      note: '',
    })
    await api.setMonthlyRecord({ workerId: 'worker', month: '2026-08', paid: true })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      patches: [{ workerId: 'worker', date: '2026-08-15', morning: 'present' }],
      allowFuture: true,
    })
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'X-LQ-Operation-Id': 'attendance-operation-id',
      'X-LQ-Response-Mode': 'delta',
    })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ avatarEmoji: '👷' })
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      workerId: 'worker',
      month: '2026-08',
      paid: true,
    })
  })

  it('uses opaque backup inspection and snapshot-based history revert endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ items: [] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    vi.stubGlobal('fetch', fetchMock)

    await api.listInternalBackups()
    await api.inspectInternalBackup('opaque-backup-id')
    await api.revertHistory([{
      entity: 'monthlyRecord',
      key: { workerId: 'worker', month: '2026-08' },
      before: null,
      after: {
        workerId: 'worker',
        month: '2026-08',
        dailyRateFen: 30_000,
        overtimePayPercent: 150,
        note: '',
        paidAt: null,
      },
    }])

    expect(fetchMock.mock.calls[0][0]).toBe('/api/internal-backups')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/internal-backups/inspect')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: 'opaque-backup-id' })
    expect(fetchMock.mock.calls[2][0]).toBe('/api/history/revert')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      targets: [{
        entity: 'monthlyRecord',
        key: { workerId: 'worker', month: '2026-08' },
        before: null,
        after: { overtimePayPercent: 150 },
      }],
    })
  })
})

describe('request timeouts', () => {
  function neverRespondingFetch() {
    return vi.fn((_path: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
  }

  it('uses a 10 second timeout for reads and marks write timeouts as unknown', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', neverRespondingFetch())
    const read = api.getState()
    const readResult = expect(read).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(10_000)
    await readResult

    const write = api.addSite({ name: '超时工地', note: '' }, 'stable-operation-id')
    const writeResult = expect(write).rejects.toMatchObject({ code: 'MUTATION_RESULT_UNKNOWN' })
    await vi.advanceTimersByTimeAsync(10_000)
    await writeResult
  })

  it('allows backup and restore inspection requests the full 60 second window', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', neverRespondingFetch())
    let settled = false
    const pending = api.inspectRestore({ schemaVersion: 8 })
    void pending.finally(() => { settled = true }).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(50_000)
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  })
})
