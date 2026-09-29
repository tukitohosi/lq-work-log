import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAttendancePatch } from '../src/attendance'
import { ApiError } from '../src/api'
import type {
  AppData,
  AttendancePatch,
  HistoryRevertTarget,
  InternalBackupInspection,
  InternalBackupMeta,
  PayAdjustment,
} from '../src/types'

const mocks = vi.hoisted(() => ({
  getHealth: vi.fn(),
  getState: vi.fn(),
  addWorker: vi.fn(),
  updateWorker: vi.fn(),
  setAttendance: vi.fn(),
  setAttendanceBatch: vi.fn(),
  setAttendanceLeave: vi.fn(),
  setDayNote: vi.fn(),
  setMonthlyRecord: vi.fn(),
  setSettings: vi.fn(),
  addPayAdjustment: vi.fn(),
  updatePayAdjustment: vi.fn(),
  deletePayAdjustment: vi.fn(),
  addSite: vi.fn(),
  updateSite: vi.fn(),
  inspectRestore: vi.fn(),
  listInternalBackups: vi.fn(),
  inspectInternalBackup: vi.fn(),
  revertHistory: vi.fn(),
  restore: vi.fn(),
  downloadBackup: vi.fn(),
  exportAnnualWorkbook: vi.fn(),
  exportSiteStatisticsWorkbook: vi.fn(),
  downloadWorkbook: vi.fn(),
}))

vi.mock('../src/api', () => ({
  isAndroidApp: false,
  ApiError: class ApiError extends Error {
    code: string
    details?: unknown

    constructor(message: string, code = 'UNKNOWN_ERROR', details?: unknown) {
      super(message)
      this.code = code
      this.details = details
    }
  },
  api: {
    getHealth: mocks.getHealth,
    getState: mocks.getState,
    addWorker: mocks.addWorker,
    updateWorker: mocks.updateWorker,
    setAttendance: mocks.setAttendance,
    setAttendanceBatch: mocks.setAttendanceBatch,
    setAttendanceLeave: mocks.setAttendanceLeave,
    setDayNote: mocks.setDayNote,
    setMonthlyRecord: mocks.setMonthlyRecord,
    setSettings: mocks.setSettings,
    addPayAdjustment: mocks.addPayAdjustment,
    updatePayAdjustment: mocks.updatePayAdjustment,
    deletePayAdjustment: mocks.deletePayAdjustment,
    addSite: mocks.addSite,
    updateSite: mocks.updateSite,
    inspectRestore: mocks.inspectRestore,
    listInternalBackups: mocks.listInternalBackups,
    inspectInternalBackup: mocks.inspectInternalBackup,
    revertHistory: mocks.revertHistory,
    restore: mocks.restore,
  },
  downloadBackup: mocks.downloadBackup,
}))

vi.mock('../src/excel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/excel')>()
  return {
    ...actual,
    exportAnnualWorkbook: mocks.exportAnnualWorkbook,
    exportSiteStatisticsWorkbook: mocks.exportSiteStatisticsWorkbook,
    downloadWorkbook: mocks.downloadWorkbook,
  }
})

import App from '../src/App.vue'
import MonthlyView from '../src/components/MonthlyView.vue'

function pointerEvent(type: string, init: PointerEventInit & { pointerId: number }, target?: EventTarget): Event {
  const event = new Event(type, { bubbles: init.bubbles ?? true, cancelable: true }) as PointerEvent
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    button: { value: init.button ?? 0 },
    ...(target ? { target: { value: target } } : {}),
  })
  return event
}

function makeState(): AppData {
  return {
    schemaVersion: 8,
    revision: 4,
    workers: [
      {
        id: 'worker-li',
        name: '李权',
        avatarDataUrl: null,
        avatarEmoji: null,
        defaultDailyRateFen: 30_001,
        note: '',
        defaultSiteId: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        archivedAt: null,
      },
      {
        id: 'worker-wang',
        name: '王强',
        avatarDataUrl: null,
        avatarEmoji: null,
        defaultDailyRateFen: 28_000,
        note: '',
        defaultSiteId: null,
        createdAt: '2026-07-02T00:00:00.000Z',
        archivedAt: null,
      },
    ],
    attendance: [
      { workerId: 'worker-li', date: '2026-08-02', morning: 'present', afternoon: 'present', overtime: 'half', dayNote: '', morningSiteId: null, afternoonSiteId: null, overtimeSiteId: null, morningLeave: null, afternoonLeave: null, overtimeLeave: null },
      { workerId: 'worker-li', date: '2026-08-03', morning: 'present', afternoon: null, overtime: 'full', dayNote: '', morningSiteId: null, afternoonSiteId: null, overtimeSiteId: null, morningLeave: null, afternoonLeave: null, overtimeLeave: null },
    ],
    monthlyRecords: [{
      workerId: 'worker-li',
      month: '2026-08',
      dailyRateFen: 30_001,
      overtimePayPercent: 100,
      note: '',
      paidAt: null,
    }],
    payAdjustments: [],
    sites: [],
    settings: {
      weekStartsOn: 6,
      currentWorkerId: 'worker-li',
      theme: 'light',
      sidebarCollapsed: false,
      lastBackupExportAt: '2026-08-01T00:00:00.000Z',
      lastBackupReminderAt: null,
      weeklyAutoBackupEnabled: true,
      lastWeeklyBackupAt: null,
      defaultOvertimePayPercent: 100,
    },
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function makeInternalBackup(): InternalBackupMeta {
  return {
    id: 'opaque-backup-id',
    kind: 'daily',
    filename: 'daily-2026-08-08.json',
    modifiedAt: '2026-08-08T01:02:03.000Z',
    size: 4_096,
    schemaVersion: 7,
    revision: 3,
    workerCount: 2,
    attendanceCount: 2,
    adjustmentCount: 0,
    siteCount: 0,
  }
}

function makeAdjustment(): PayAdjustment {
  return {
    id: 'adjustment-existing',
    workerId: 'worker-li',
    month: '2026-08',
    date: '2026-08-06',
    kind: 'allowance',
    amountFen: 8_888,
    label: '高温补贴',
    note: '原备注',
    siteId: null,
    createdAt: '2026-08-06T01:02:03.000Z',
    updatedAt: '2026-08-06T01:02:03.000Z',
  }
}

function makeInternalInspection(backup: InternalBackupMeta, restored: AppData): InternalBackupInspection {
  return {
    backup,
    data: clone(restored),
    schemaVersion: restored.schemaVersion,
    workerCount: restored.workers.length,
    archivedWorkerCount: restored.workers.filter((worker) => worker.archivedAt).length,
    attendanceCount: restored.attendance.length,
    monthCount: restored.monthlyRecords.length,
    adjustmentCount: restored.payAdjustments.length,
    siteCount: restored.sites.length,
    workerNames: restored.workers.map((worker) => worker.name),
  }
}

function makeDesktopBridge(overrides: Partial<JigongbenDesktopBridge> = {}): JigongbenDesktopBridge {
  return {
    saveFile: vi.fn().mockResolvedValue({ canceled: false, filePath: 'C:\\导出.xlsx' }),
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

describe('App attendance interactions', () => {
  let serverState: AppData

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-08T08:00:00+08:00'))
    vi.clearAllMocks()
    serverState = makeState()
    mocks.getState.mockImplementation(async () => clone(serverState))
    mocks.getHealth.mockResolvedValue({
      ok: true,
      revision: serverState.revision,
      readOnly: false,
      dataSizeBytes: 48_000,
      dataLimitBytes: 64 * 1024 * 1024,
      dataSizeWarning: false,
    })
    mocks.addWorker.mockImplementation(async (payload: {
      name: string
      avatarDataUrl: string | null
      avatarEmoji?: string | null
      defaultDailyRateFen: number
      note: string
      defaultSiteId?: string | null
    }) => {
      serverState.workers.push({
        id: `worker-added-${serverState.workers.length + 1}`,
        name: payload.name,
        avatarDataUrl: payload.avatarDataUrl,
        avatarEmoji: payload.avatarEmoji ?? null,
        defaultDailyRateFen: payload.defaultDailyRateFen,
        note: payload.note,
        defaultSiteId: payload.defaultSiteId ?? null,
        createdAt: new Date(Date.now() + serverState.workers.length).toISOString(),
        archivedAt: null,
      })
      serverState.revision += 1
      return clone(serverState)
    })
    mocks.updateWorker.mockImplementation(async (id: string, changes: {
      name?: string
      avatarDataUrl?: string | null
      avatarEmoji?: string | null
      defaultDailyRateFen?: number
      note?: string
      defaultSiteId?: string | null
      archived?: boolean
    }) => {
      const worker = serverState.workers.find((candidate) => candidate.id === id)!
      const { archived, ...profileChanges } = changes
      Object.assign(worker, profileChanges)
      if (archived !== undefined) worker.archivedAt = archived ? '2026-08-08T04:05:06.000Z' : null
      serverState.revision += 1
      return clone(serverState)
    })
    mocks.setSettings.mockImplementation(async (changes: Partial<AppData['settings']>) => {
      Object.assign(serverState.settings, changes)
      serverState.revision += 1
      return clone(serverState)
    })
    mocks.setAttendanceBatch.mockImplementation(async (patches: AttendancePatch[]) => {
      for (const patch of patches) applyAttendancePatch(serverState, patch)
      serverState.revision += 1
      return clone(serverState)
    })
    mocks.setAttendanceLeave.mockImplementation(async (patches: Array<{
      workerId: string
      date: string
      period: 'morning' | 'afternoon' | 'overtime'
      leave: unknown
    }>) => {
      for (const item of patches) {
        applyAttendancePatch(serverState, {
          workerId: item.workerId,
          date: item.date,
          [`${item.period}Leave`]: item.leave,
        } as AttendancePatch)
      }
      serverState.revision += 1
      return clone(serverState)
    })
    mocks.setMonthlyRecord.mockImplementation(
      async (payload: {
        workerId: string
        month: string
        dailyRateFen?: number
        overtimePayPercent?: number
        note?: string
        paid?: boolean
      }) => {
        let record = serverState.monthlyRecords.find(
          (candidate) => candidate.workerId === payload.workerId && candidate.month === payload.month,
        )
        if (!record) {
          const worker = serverState.workers.find((candidate) => candidate.id === payload.workerId)
          const created: AppData['monthlyRecords'][number] = {
            workerId: payload.workerId,
            month: payload.month,
            dailyRateFen: payload.dailyRateFen ?? worker?.defaultDailyRateFen ?? 0,
            overtimePayPercent: payload.overtimePayPercent ?? serverState.settings.defaultOvertimePayPercent,
            note: payload.note ?? '',
            paidAt: null,
          }
          serverState.monthlyRecords.push(created)
          record = created
        }
        if (payload.dailyRateFen !== undefined) record.dailyRateFen = payload.dailyRateFen
        if (payload.overtimePayPercent !== undefined) record.overtimePayPercent = payload.overtimePayPercent
        if (payload.note !== undefined) record.note = payload.note
        if (payload.paid !== undefined) record.paidAt = payload.paid ? record.paidAt ?? new Date().toISOString() : null
        serverState.revision += 1
        return clone(serverState)
      },
    )
    mocks.addPayAdjustment.mockImplementation(async (payload: {
      workerId: string
      month: string
      date: string | null
      kind: 'allowance' | 'deduction'
      amountFen: number
      label: string
      note: string
    }) => {
      const timestamp = '2026-08-08T02:03:04.000Z'
      serverState.payAdjustments.push({
        id: `adjustment-${serverState.payAdjustments.length + 1}`,
        ...payload,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      if (!serverState.monthlyRecords.some(
        (record) => record.workerId === payload.workerId && record.month === payload.month,
      )) {
        const worker = serverState.workers.find((candidate) => candidate.id === payload.workerId)!
        serverState.monthlyRecords.push({
          workerId: payload.workerId,
          month: payload.month,
          dailyRateFen: worker.defaultDailyRateFen,
          overtimePayPercent: serverState.settings.defaultOvertimePayPercent,
          note: '',
          paidAt: null,
        })
      }
      serverState.revision += 1
      return clone(serverState)
    })
    mocks.updatePayAdjustment.mockImplementation(async (id: string, changes: Partial<AppData['payAdjustments'][number]>) => {
      const item = serverState.payAdjustments.find((candidate) => candidate.id === id)!
      Object.assign(item, changes, { updatedAt: '2026-08-08T03:04:05.000Z' })
      serverState.revision += 1
      return clone(serverState)
    })
    mocks.deletePayAdjustment.mockImplementation(async (id: string) => {
      serverState.payAdjustments = serverState.payAdjustments.filter((item) => item.id !== id)
      serverState.revision += 1
      return clone(serverState)
    })
    mocks.updateSite.mockImplementation(async (id: string, changes: {
      name?: string
      note?: string
      archived?: boolean
      replacementDefaultSiteId?: string | null
    }) => {
      const site = serverState.sites.find((candidate) => candidate.id === id)!
      if (changes.name !== undefined) site.name = changes.name
      if (changes.note !== undefined) site.note = changes.note
      if (changes.archived !== undefined) {
        site.archivedAt = changes.archived ? '2026-08-08T05:06:07.000Z' : null
        if (changes.archived) {
          for (const worker of serverState.workers) {
            if (worker.defaultSiteId === id) worker.defaultSiteId = changes.replacementDefaultSiteId ?? null
          }
        }
      }
      serverState.revision += 1
      return clone(serverState)
    })
    mocks.revertHistory.mockImplementation(async (targets: HistoryRevertTarget[]) => {
      for (const target of targets) {
        if (target.entity === 'monthlyRecord') {
          serverState.monthlyRecords = serverState.monthlyRecords.filter(
            (record) => record.workerId !== target.key.workerId || record.month !== target.key.month,
          )
          if (target.before) serverState.monthlyRecords.push(JSON.parse(JSON.stringify(target.before)) as typeof target.before)
        } else if (target.entity === 'payAdjustment') {
          serverState.payAdjustments = serverState.payAdjustments.filter((item) => item.id !== target.key.id)
          if (target.before) serverState.payAdjustments.push(JSON.parse(JSON.stringify(target.before)) as typeof target.before)
        } else if (target.entity === 'attendance') {
          applyAttendancePatch(serverState, {
            workerId: target.key.workerId,
            date: target.key.date,
            ...JSON.parse(JSON.stringify(target.before)) as Record<string, unknown>,
          } as AttendancePatch)
        } else {
          const site = serverState.sites.find((candidate) => candidate.id === target.key.id)!
          site.archivedAt = target.before.archivedAt
          for (const item of target.before.workerDefaults) {
            const worker = serverState.workers.find((candidate) => candidate.id === item.workerId)!
            worker.defaultSiteId = item.defaultSiteId
          }
        }
      }
      serverState.revision += 1
      return clone(serverState)
    })
    mocks.listInternalBackups.mockResolvedValue({ items: [] })
    mocks.restore.mockImplementation(async (restored: AppData) => {
      serverState = JSON.parse(JSON.stringify(restored)) as AppData
      return clone(serverState)
    })
    mocks.downloadBackup.mockResolvedValue({ canceled: false })
    mocks.exportAnnualWorkbook.mockReturnValue({ filename: '年度汇总.xlsx', bytes: new Uint8Array() })
    mocks.exportSiteStatisticsWorkbook.mockReturnValue({ filename: '工地统计.xlsx', bytes: new Uint8Array() })
    mocks.downloadWorkbook.mockResolvedValue({ canceled: false, filePath: 'C:\\导出.xlsx' })
  })

  afterEach(() => {
    delete window.jigongbenDesktop
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.printMode
    document.documentElement.style.colorScheme = ''
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders half-day totals and rounds the expected wage to fen', async () => {
    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.text()).toContain('总工数3工')
    expect(wrapper.text()).toContain('900.03')
    expect(wrapper.text()).toContain('上午2次')
    expect(wrapper.text()).toContain('下午1次')
    expect(wrapper.text()).toContain('加班1.5工')
    wrapper.unmount()
  })

  it('cycles a cell blank -> present -> absent -> blank and persists every state', async () => {
    const wrapper = mount(App)
    await flushPromises()

    const attendanceButton = () =>
      wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]')

    expect(attendanceButton().element.tagName).toBe('BUTTON')
    expect(attendanceButton().text()).toBe('')

    await attendanceButton().trigger('click')
    await flushPromises()
    expect(attendanceButton().text()).toBe('✓')

    await attendanceButton().trigger('click')
    await flushPromises()
    expect(attendanceButton().text()).toBe('×')

    await attendanceButton().trigger('click')
    await flushPromises()
    expect(attendanceButton().text()).toBe('')
    expect(mocks.setAttendanceBatch.mock.calls.map(([patches]) => patches[0].morning)).toEqual([
      'present', 'absent', null,
    ])
    wrapper.unmount()
  })

  it('cycles overtime blank -> single check -> double check -> blank and counts half/full work', async () => {
    const wrapper = mount(App)
    await flushPromises()

    const overtimeButton = () => wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 overtime"]')
    expect(overtimeButton().text()).toBe('')

    await overtimeButton().trigger('click')
    await flushPromises()
    expect(overtimeButton().text()).toBe('✓')

    await overtimeButton().trigger('click')
    await flushPromises()
    expect(overtimeButton().text()).toBe('✓✓')

    await overtimeButton().trigger('click')
    await flushPromises()
    expect(overtimeButton().text()).toBe('')
    expect(mocks.setAttendanceBatch.mock.calls.map(([patches]) => patches[0].overtime)).toEqual(['half', 'full', null])
    wrapper.unmount()
  })

  it('switches workers without mixing their monthly attendance', async () => {
    const wrapper = mount(App)
    await flushPromises()

    const wangButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('王强') && !button.attributes('aria-label'))
    expect(wangButton).toBeDefined()
    await wangButton!.trigger('click')
    await flushPromises()

    expect(mocks.setSettings).toHaveBeenCalledWith({ currentWorkerId: 'worker-wang' }, expect.any(String))
    expect(wrapper.text()).toContain('王强')
    expect(wrapper.text()).toContain('总工数0工')
    expect(wrapper.text()).toContain('0.00')
    wrapper.unmount()
  })

  it('uses native print and PDF actions when the desktop bridge exists', async () => {
    const print = vi.fn().mockResolvedValue(undefined)
    const savePdf = vi.fn().mockResolvedValue({ canceled: false, filePath: 'C:\\记工表.pdf' })
    window.jigongbenDesktop = makeDesktopBridge({ print, savePdf })
    const wrapper = mount(App)
    await flushPromises()

    const button = (label: string) => wrapper.findAll('button').find((candidate) => candidate.text() === label)
    expect(button('打印月表')).toBeDefined()
    expect(button('工资条 PDF')).toBeDefined()

    await button('打印月表')!.trigger('click')
    await button('工资条 PDF')!.trigger('click')
    await flushPromises()
    expect(print).toHaveBeenCalledOnce()
    expect(savePdf).toHaveBeenCalledWith({ filename: '工资条_2026-08_李权.pdf', landscape: false })
    wrapper.unmount()
  })

  it('switches theme through settings and persists it to both service and desktop window', async () => {
    const setTheme = vi.fn().mockResolvedValue(undefined)
    window.jigongbenDesktop = makeDesktopBridge({ setTheme })
    const wrapper = mount(App)
    await flushPromises()

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(setTheme).toHaveBeenCalledWith('light')
    await wrapper.findAll('button').find((button) => button.text() === '设置')!.trigger('click')
    const darkRadio = wrapper.find<HTMLInputElement>('input[name="theme"]:not(:checked)')
    await darkRadio.setValue(true)
    await flushPromises()

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(mocks.setSettings).toHaveBeenCalledWith({ theme: 'dark' }, expect.any(String))
    expect(setTheme).toHaveBeenLastCalledWith('dark')
    wrapper.unmount()
  })

  it('moves focus into a modal, traps Tab, and restores the opening control', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    const opener = wrapper.findAll<HTMLButtonElement>('button').find((button) => button.text() === '设置')!
    opener.element.focus()
    await opener.trigger('click')
    await flushPromises()
    const dialog = wrapper.get<HTMLElement>('[aria-labelledby="settings-title"]')
    await vi.waitFor(() => expect(dialog.element.contains(document.activeElement)).toBe(true))

    const focusable = Array.from(dialog.element.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'))
      .filter((element) => !element.hidden)
    focusable.at(-1)!.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(focusable[0])

    await wrapper.get<HTMLButtonElement>('[aria-label="关闭设置"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(document.activeElement).toBe(opener.element))
    wrapper.unmount()
  })

  it('saves the default overtime multiplier through settings', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.findAll<HTMLButtonElement>('button').find((button) => button.text().includes('设置'))!.trigger('click')
    const multiplier = wrapper.find<HTMLInputElement>('input[aria-label="新月份默认加班倍率"]')
    await multiplier.setValue('1.75')
    await flushPromises()

    expect(mocks.setSettings).toHaveBeenCalledWith({ defaultOvertimePayPercent: 175 }, expect.any(String))
    expect(multiplier.element.value).toBe('1.75')
    wrapper.unmount()
  })

  it('shows the 80 percent data-capacity warning in settings', async () => {
    mocks.getHealth.mockResolvedValue({
      ok: true,
      revision: serverState.revision,
      readOnly: false,
      dataSizeBytes: 54 * 1024 * 1024,
      dataLimitBytes: 64 * 1024 * 1024,
      dataSizeWarning: true,
    })
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.findAll<HTMLButtonElement>('button').find((button) => button.text().includes('设置'))!.trigger('click')
    await vi.waitFor(() => expect(mocks.getHealth).toHaveBeenCalled())

    const capacity = wrapper.get('.data-capacity-settings')
    expect(capacity.text()).toContain('54.0 MB / 64.0 MB')
    expect(capacity.text()).toContain('账本已接近容量上限')
    wrapper.unmount()
  })

  it('lists opaque internal backups, previews one, and clears undo history after restore', async () => {
    const backup = makeInternalBackup()
    const restored = makeState()
    restored.revision = 3
    restored.attendance = []
    mocks.listInternalBackups.mockResolvedValue({ items: [backup] })
    mocks.inspectInternalBackup.mockResolvedValue(makeInternalInspection(backup, restored))
    const wrapper = mount(App)
    await flushPromises()

    await wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]').trigger('click')
    await flushPromises()
    expect(wrapper.find<HTMLButtonElement>('button.undo-button').element.disabled).toBe(false)
    await wrapper.findAll<HTMLButtonElement>('button').find((button) => button.text().includes('设置'))!.trigger('click')
    await vi.waitFor(() => expect(mocks.listInternalBackups).toHaveBeenCalledOnce())

    const backupCard = wrapper.find('.internal-backup-card')
    expect(backupCard.text()).toContain('每日备份')
    expect(backupCard.text()).toContain('点击预览后才读取、迁移并校验')
    expect(backup).not.toHaveProperty('path')
    await backupCard.find<HTMLButtonElement>('button').trigger('click')
    await vi.waitFor(() => expect(mocks.inspectInternalBackup).toHaveBeenCalledWith('opaque-backup-id'))
    expect(mocks.inspectInternalBackup).toHaveBeenCalledWith(expect.not.stringContaining('\\'))

    await wrapper.findAll<HTMLButtonElement>('button').find((button) => button.text() === '确认恢复')!.trigger('click')
    await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledWith(restored, expect.any(String)))
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.find<HTMLButtonElement>('button.undo-button').element.disabled).toBe(true))
    wrapper.unmount()
  })

  it('can preview and restore an internal backup from the load-error protection page', async () => {
    const backup = makeInternalBackup()
    const restored = makeState()
    mocks.getState.mockRejectedValueOnce(new Error('主数据损坏'))
    mocks.listInternalBackups.mockResolvedValue({ items: [backup] })
    mocks.inspectInternalBackup.mockResolvedValue(makeInternalInspection(backup, restored))
    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.find('.error-screen').text()).toContain('主数据损坏')
    const recovery = wrapper.find('.load-recovery-panel')
    expect(recovery.text()).toContain('从内部备份恢复')
    await recovery.find('.internal-backup-card button').trigger('click')
    await vi.waitFor(() => expect(mocks.inspectInternalBackup).toHaveBeenCalledWith('opaque-backup-id'))
    await wrapper.findAll<HTMLButtonElement>('button').find((button) => button.text() === '确认恢复')!.trigger('click')
    await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledWith(restored, expect.any(String)))
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.find('.error-screen').exists()).toBe(false))
    expect(wrapper.find('.app-shell').exists()).toBe(true)
    wrapper.unmount()
  })

  it('offers manual JSON recovery when the main file and internal backups are unavailable', async () => {
    const restored = makeState()
    mocks.getState.mockRejectedValueOnce(new Error('正式数据文件缺失，需要恢复'))
    mocks.listInternalBackups.mockResolvedValue({ items: [] })
    mocks.inspectRestore.mockResolvedValue({
      data: clone(restored),
      schemaVersion: restored.schemaVersion,
      workerCount: restored.workers.length,
      archivedWorkerCount: 0,
      attendanceCount: restored.attendance.length,
      monthCount: restored.monthlyRecords.length,
      adjustmentCount: restored.payAdjustments.length,
      siteCount: restored.sites.length,
      workerNames: restored.workers.map((worker) => worker.name),
    })
    const wrapper = mount(App)
    await flushPromises()

    const recovery = wrapper.get('.load-recovery-panel')
    expect(recovery.text()).toContain('选择手动 JSON 备份')
    expect(recovery.text()).toContain('没有可用的内部备份')
    const input = recovery.get<HTMLInputElement>('input[type="file"]')
    const file = new File([JSON.stringify(restored)], '手动备份.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(restored) })
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await vi.waitFor(() => expect(mocks.inspectRestore).toHaveBeenCalledWith(restored))

    await wrapper.findAll<HTMLButtonElement>('button').find((button) => button.text() === '确认恢复')!.trigger('click')
    await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledWith(restored, expect.any(String)))
    await vi.waitFor(() => expect(wrapper.find('.app-shell').exists()).toBe(true))
    wrapper.unmount()
  })

  it('reuses the restore operation id after an unknown result', async () => {
    const backup = makeInternalBackup()
    const restored = makeState()
    mocks.listInternalBackups.mockResolvedValue({ items: [backup] })
    mocks.inspectInternalBackup.mockResolvedValue(makeInternalInspection(backup, restored))
    mocks.restore
      .mockRejectedValueOnce(new ApiError('恢复响应丢失', 'MUTATION_RESULT_UNKNOWN'))
      .mockResolvedValueOnce(clone(restored))
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.findAll<HTMLButtonElement>('button').find((button) => button.text().includes('设置'))!.trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.internal-backup-card').exists()).toBe(true))
    await wrapper.get('.internal-backup-card button').trigger('click')
    await vi.waitFor(() => expect(mocks.inspectInternalBackup).toHaveBeenCalledOnce())

    const confirmRestoreButton = () => wrapper.findAll<HTMLButtonElement>('button')
      .find((button) => button.text() === '确认恢复')!
    await confirmRestoreButton().trigger('click')
    await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledTimes(1))
    await confirmRestoreButton().trigger('click')
    await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledTimes(2))
    expect(mocks.restore.mock.calls[1][1]).toBe(mocks.restore.mock.calls[0][1])
    wrapper.unmount()
  })

  it('supports focused-cell Ctrl+Z, Ctrl+N, Ctrl+month arrows and bare grid navigation', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()

    const morning = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]')
    await morning.trigger('click')
    await flushPromises()
    expect(morning.text()).toBe('✓')
    morning.element.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    await flushPromises()
    expect(morning.text()).toBe('')
    expect(mocks.revertHistory).toHaveBeenLastCalledWith([
      expect.objectContaining({
        entity: 'attendance',
        key: { workerId: 'worker-li', date: '2026-08-01' },
        before: expect.objectContaining({ morning: null }),
        after: expect.objectContaining({ morning: 'present' }),
      }),
    ], expect.any(String))

    const month = wrapper.find<HTMLInputElement>('input[type="month"]')
    expect(month.element.value).toBe('2026-08')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    expect(month.element.value).toBe('2026-08')
    expect(document.activeElement).toBe(wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-02 morning"]').element)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-02 afternoon"]').element)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-02 overtime"]').element)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-09 morning"]').element)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true }))
    await flushPromises()
    expect(month.element.value).toBe('2026-09')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }))
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').text()).toContain('添加工人')
    wrapper.unmount()
  })

  it('does not trigger app undo while a text field owns native Ctrl+Z', async () => {
    const wrapper = mount(App)
    await flushPromises()
    const morning = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]')
    await morning.trigger('click')
    await flushPromises()

    const note = wrapper.find<HTMLTextAreaElement>('.detail-grid textarea')
    note.element.focus()
    note.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    await flushPromises()

    expect(morning.text()).toBe('✓')
    expect(mocks.setAttendanceBatch).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('right-click clears a marked cell while a blank cell remains a no-op', async () => {
    const wrapper = mount(App)
    await flushPromises()
    const morning = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]')

    await morning.trigger('contextmenu')
    expect(mocks.setAttendanceBatch).not.toHaveBeenCalled()
    await morning.trigger('click')
    await flushPromises()
    expect(morning.text()).toBe('✓')
    mocks.setAttendanceBatch.mockClear()
    await morning.trigger('contextmenu')
    await flushPromises()

    expect(morning.text()).toBe('')
    expect(mocks.setAttendanceBatch).toHaveBeenCalledWith([
      expect.objectContaining({ workerId: 'worker-li', date: '2026-08-01', morning: null }),
    ], { allowFuture: false, operationId: expect.any(String) })
    wrapper.unmount()
  })

  it('retries current failed mutations and drops a stale conflicting cell write', async () => {
    mocks.setAttendanceBatch
      .mockRejectedValueOnce(new Error('服务暂时不可用 1'))
      .mockRejectedValueOnce(new Error('服务暂时不可用 2'))
    const wrapper = mount(App)
    await flushPromises()

    await wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]').trigger('click')
    await wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 afternoon"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('服务暂时不可用 2'))
    expect(wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]').classes()).toContain('has-save-error')
    expect(wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 afternoon"]').classes()).toContain('has-save-error')

    const retryButton = wrapper.findAll('button').find((button) => button.text() === '重试未保存修改')
    await retryButton!.trigger('click')
    await vi.waitFor(() => expect(mocks.setAttendanceBatch).toHaveBeenCalledTimes(4))

    const payloads = mocks.setAttendanceBatch.mock.calls.map(([payload]) => payload)
    expect(payloads.slice(2).flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ workerId: 'worker-li', date: '2026-08-01', morning: 'present' }),
      expect.objectContaining({ workerId: 'worker-li', date: '2026-08-01', afternoon: 'present' }),
    ]))
    expect(mocks.setAttendanceBatch.mock.calls[2][1].operationId).toBe(mocks.setAttendanceBatch.mock.calls[0][1].operationId)
    expect(mocks.setAttendanceBatch.mock.calls[3][1].operationId).toBe(mocks.setAttendanceBatch.mock.calls[1][1].operationId)
    await vi.waitFor(() => expect(wrapper.text()).not.toContain('服务暂时不可用'))
    expect(wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]').classes()).not.toContain('has-save-error')
    expect(wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 afternoon"]').classes()).not.toContain('has-save-error')
    wrapper.unmount()
  })

  it('keeps a queued optimistic cell visible after an earlier save resolves, then allows undo', async () => {
    let resolveFirst!: (state: AppData) => void
    let resolveSecond!: (state: AppData) => void
    mocks.setAttendanceBatch
      .mockImplementationOnce(() => new Promise<AppData>((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise<AppData>((resolve) => { resolveSecond = resolve }))
      .mockImplementationOnce(async (patches: AttendancePatch[]) => {
        for (const patch of patches) applyAttendancePatch(serverState, patch)
        serverState.revision += 1
        return clone(serverState)
      })
    const wrapper = mount(App)
    await flushPromises()

    const morning = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]')
    const afternoon = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 afternoon"]')
    await morning.trigger('click')
    await afternoon.trigger('click')
    applyAttendancePatch(serverState, { workerId: 'worker-li', date: '2026-08-01', morning: 'present' })
    serverState.revision += 1
    resolveFirst(clone(serverState))
    await flushPromises()
    expect(afternoon.text()).toBe('✓')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    await flushPromises()
    applyAttendancePatch(serverState, { workerId: 'worker-li', date: '2026-08-01', afternoon: 'present' })
    serverState.revision += 1
    resolveSecond(clone(serverState))
    await flushPromises()
    await vi.waitFor(() => expect(mocks.revertHistory).toHaveBeenCalledOnce())
    expect(mocks.revertHistory).toHaveBeenLastCalledWith([
      expect.objectContaining({
        entity: 'attendance',
        key: { workerId: 'worker-li', date: '2026-08-01' },
        before: expect.objectContaining({ afternoon: null }),
        after: expect.objectContaining({ afternoon: 'present' }),
      }),
    ], expect.any(String))
    await vi.waitFor(() => expect(afternoon.text()).toBe(''))
    wrapper.unmount()
  })

  it('treats one week fill as one atomic batch and one undo step', async () => {
    const wrapper = mount(App)
    await flushPromises()
    const fill = wrapper.findAll('button').find((button) => button.text() === '本周全勤')
    expect(fill).toBeDefined()
    await fill!.trigger('click')
    await flushPromises()
    const filled = mocks.setAttendanceBatch.mock.calls.at(-1)?.[0] as AttendancePatch[]
    expect(filled.length).toBeGreaterThanOrEqual(1)
    expect(filled.every((patch) => patch.morning === 'present' && patch.afternoon === 'present')).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    await flushPromises()
    const undone = mocks.revertHistory.mock.calls.at(-1)?.[0] as HistoryRevertTarget[]
    expect(undone).toHaveLength(filled.length)
    expect(undone).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entity: 'attendance',
        before: expect.objectContaining({ morning: null, afternoon: null }),
        after: expect.objectContaining({ morning: 'present', afternoon: 'present' }),
      }),
    ]))
    wrapper.unmount()
  })

  it('keeps preview state precise to one period and restores path previews on cancel', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('button.interaction-mode-button[data-mode="path"]').trigger('click')
    const morning = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]')
    const afternoon = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 afternoon"]')
    const nextMorning = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-02 morning"]')
    morning.element.dispatchEvent(pointerEvent('pointerdown', { pointerId: 7, button: 0 }))
    nextMorning.element.dispatchEvent(pointerEvent('pointerenter', { pointerId: 7 }))
    await flushPromises()
    expect(morning.text()).toBe('✓')
    expect(morning.classes()).toContain('is-path-preview')
    expect(afternoon.classes()).not.toContain('is-path-preview')
    expect(afternoon.text()).toBe('')
    window.dispatchEvent(pointerEvent('pointercancel', { pointerId: 7 }))
    await flushPromises()
    expect(morning.text()).toBe('')
    expect(nextMorning.text()).toBe('✓')
    expect(mocks.setAttendanceBatch).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('selects a rectangular region without writing, cancels it, then commits grind as one batch and undo', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('button.interaction-mode-button[data-mode="region"]').trigger('click')
    const start = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-04 morning"]')
    const end = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-05 overtime"]')

    start.element.dispatchEvent(pointerEvent('pointerdown', { pointerId: 11, button: 0 }))
    end.element.dispatchEvent(pointerEvent('pointerenter', { pointerId: 11 }))
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 11 }, end.element))
    await flushPromises()
    expect(mocks.setAttendanceBatch).not.toHaveBeenCalled()
    expect(wrapper.find('.region-action-dialog').exists()).toBe(true)
    expect(wrapper.findAll('.is-region-selected')).toHaveLength(6)

    await wrapper.find('.region-action-dialog .modal-actions button').trigger('click')
    expect(wrapper.find('.region-action-dialog').exists()).toBe(false)
    expect(mocks.setAttendanceBatch).not.toHaveBeenCalled()

    start.element.dispatchEvent(pointerEvent('pointerdown', { pointerId: 12, button: 0 }))
    end.element.dispatchEvent(pointerEvent('pointerenter', { pointerId: 12 }))
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 12 }, end.element))
    await flushPromises()
    await wrapper.find('.region-action-dialog button[data-action="grind"]').trigger('click')
    await flushPromises()

    expect(mocks.setAttendanceBatch).toHaveBeenCalledTimes(1)
    const grind = mocks.setAttendanceBatch.mock.calls[0][0] as AttendancePatch[]
    expect(grind).toHaveLength(2)
    expect(grind).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: '2026-08-04', morning: 'present', afternoon: 'present', overtime: 'half' }),
      expect.objectContaining({ date: '2026-08-05', morning: 'present', afternoon: 'present', overtime: 'half' }),
    ]))

    end.element.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    await flushPromises()
    expect(mocks.revertHistory).toHaveBeenCalledOnce()
    const undo = mocks.revertHistory.mock.calls[0][0] as HistoryRevertTarget[]
    expect(undo).toHaveLength(2)
    expect(undo).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'attendance', key: { workerId: 'worker-li', date: '2026-08-04' }, before: expect.objectContaining({ morning: null, afternoon: null, overtime: null }) }),
      expect.objectContaining({ entity: 'attendance', key: { workerId: 'worker-li', date: '2026-08-05' }, before: expect.objectContaining({ morning: null, afternoon: null, overtime: null }) }),
    ]))
    wrapper.unmount()
  })

  it.each([
    ['full', 'present', 'present', undefined],
    ['rest', 'absent', 'absent', null],
  ] as const)('applies region %s with the expected overtime behavior', async (action, morning, afternoon, overtime) => {
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('button.interaction-mode-button[data-mode="region"]').trigger('click')
    const start = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-04 morning"]')
    const end = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-04 overtime"]')
    start.element.dispatchEvent(pointerEvent('pointerdown', { pointerId: 15, button: 0 }))
    end.element.dispatchEvent(pointerEvent('pointerenter', { pointerId: 15 }))
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 15 }, end.element))
    await flushPromises()
    await wrapper.find(`.region-action-dialog button[data-action="${action}"]`).trigger('click')
    await flushPromises()
    const patch = (mocks.setAttendanceBatch.mock.calls[0][0] as AttendancePatch[])[0]!
    expect(patch).toEqual(expect.objectContaining({ date: '2026-08-04', morning, afternoon }))
    expect(patch.overtime).toBe(overtime)
    wrapper.unmount()
  })

  it('keeps keyboard intent after an arrow move until the pointer really moves', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    const cellA = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-04 morning"]')
    const cellB = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-05 morning"]')
    const cellC = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-05 afternoon"]')

    await cellA.trigger('pointerenter')
    cellA.element.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(cellB.element)

    // The old hover remains on A, but the numeric shortcut must edit B.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))
    await flushPromises()
    expect(cellA.text()).toBe('')
    expect(cellB.text()).toBe('✓')
    expect(document.activeElement).toBe(cellB.element)

    await cellC.trigger('pointerenter')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))
    await flushPromises()
    expect(cellC.text()).toBe('×')
    expect(document.activeElement).toBe(cellC.element)
    wrapper.unmount()
  })

  it('clears the hovered cell with Backspace and restores it with Ctrl+Z', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    const overtime = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-03 overtime"]')
    await overtime.trigger('pointerenter')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
    await flushPromises()
    expect(overtime.text()).toBe('')
    expect(mocks.setAttendanceBatch).toHaveBeenLastCalledWith(
      [expect.objectContaining({ date: '2026-08-03', overtime: null })],
      expect.any(Object),
    )

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    await flushPromises()
    expect(overtime.text()).toBe('✓✓')
    wrapper.unmount()
  })

  it('filters workers by normalized name and cycles visible workers with Ctrl+arrows', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    const filter = wrapper.find<HTMLInputElement>('.worker-filter input')
    await filter.setValue(' 王 强 ')
    expect(wrapper.findAll('.worker-select')).toHaveLength(1)
    expect(wrapper.text()).toContain('1 / 2 人')

    filter.element.blur()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true }))
    await flushPromises()
    expect(mocks.setSettings).toHaveBeenLastCalledWith({ currentWorkerId: 'worker-wang' }, expect.any(String))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true }))
    await flushPromises()
    expect(mocks.setSettings).toHaveBeenLastCalledWith({ currentWorkerId: 'worker-wang' }, expect.any(String))
    wrapper.unmount()
  })

  it('dims dates after today without a visible label and confirms the first write once per session', async () => {
    const confirmFuture = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    vi.stubGlobal('confirm', confirmFuture)
    const wrapper = mount(App)
    await flushPromises()
    const first = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-09 morning"]')
    const second = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-10 afternoon"]')

    expect(first.element.closest('td')?.classList.contains('future')).toBe(true)
    expect(wrapper.text()).not.toContain('未来')
    await first.trigger('click')
    await flushPromises()
    expect(first.text()).toBe('')
    expect(mocks.setAttendanceBatch).not.toHaveBeenCalled()

    await first.trigger('click')
    await flushPromises()
    expect(first.text()).toBe('✓')
    expect(mocks.setAttendanceBatch).toHaveBeenLastCalledWith(
      [expect.objectContaining({ date: '2026-08-09', morning: 'present' })],
      { allowFuture: true, operationId: expect.any(String) },
    )
    await second.trigger('click')
    await flushPromises()
    expect(second.text()).toBe('✓')
    expect(confirmFuture).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('debounces monthly rate saves for 500ms and flushes a note before switching workers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-08T08:00:00+08:00'))
    const wrapper = mount(App)
    await flushPromises()
    const rate = wrapper.find<HTMLInputElement>('input[aria-label="本月日薪"]')
    await rate.setValue('400.25')
    await vi.advanceTimersByTimeAsync(499)
    expect(mocks.setMonthlyRecord).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(mocks.setMonthlyRecord).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'worker-li', month: '2026-08', dailyRateFen: 40_025 }), expect.any(String))

    mocks.setMonthlyRecord.mockClear()
    const note = wrapper.find<HTMLTextAreaElement>('textarea[aria-label="本月备注"]')
    await note.setValue('切换前必须保存')
    const wang = wrapper.findAll<HTMLButtonElement>('.worker-select').find((button) => button.text().includes('王强'))!
    await wang.trigger('click')
    await flushPromises()
    expect(mocks.setMonthlyRecord).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'worker-li', month: '2026-08', note: '切换前必须保存' }), expect.any(String))
    wrapper.unmount()
  })

  it.each([
    { label: '日薪', selector: 'input[aria-label="本月日薪"]', value: '410.25', field: 'dailyRateFen', before: 30_001, after: 41_025 },
    { label: '备注', selector: 'textarea[aria-label="本月备注"]', value: '统一撤销备注', field: 'note', before: '', after: '统一撤销备注' },
    { label: '加班倍率', selector: 'input[aria-label="本月加班倍率"]', value: '1.5', field: 'overtimePayPercent', before: 100, after: 150 },
  ])('adds the monthly $label change to unified undo history', async (entry) => {
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find<HTMLButtonElement>('button.undo-button').element.disabled).toBe(true)
    const field = wrapper.find<HTMLInputElement | HTMLTextAreaElement>(entry.selector)
    await field.setValue(entry.value)
    await field.trigger('blur')
    await flushPromises()

    expect(mocks.setMonthlyRecord).toHaveBeenLastCalledWith(expect.objectContaining({
      workerId: 'worker-li',
      month: '2026-08',
      [entry.field]: entry.after,
    }), expect.any(String))
    expect(mocks.setMonthlyRecord).toHaveBeenCalledOnce()
    const undo = wrapper.find<HTMLButtonElement>('button.undo-button')
    await vi.waitFor(() => expect(undo.element.disabled).toBe(false))
    await undo.trigger('click')
    await vi.waitFor(() => expect(mocks.revertHistory).toHaveBeenCalledOnce())

    const targets = mocks.revertHistory.mock.calls[0][0] as HistoryRevertTarget[]
    expect(targets).toEqual([
      expect.objectContaining({
        entity: 'monthlyRecord',
        key: { workerId: 'worker-li', month: '2026-08' },
        before: expect.objectContaining({ [entry.field]: entry.before }),
        after: expect.objectContaining({ [entry.field]: entry.after }),
      }),
    ])
    await vi.waitFor(() => expect(wrapper.find<HTMLButtonElement>('button.undo-button').element.disabled).toBe(true))
    await wrapper.find<HTMLButtonElement>('button.undo-button').trigger('click')
    expect(mocks.revertHistory).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('records a newly created month with a null before snapshot', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find<HTMLInputElement>('.month-picker input[type="month"]').setValue('2026-09')
    await flushPromises()

    const note = wrapper.find<HTMLTextAreaElement>('textarea[aria-label="本月备注"]')
    await note.setValue('九月新记录')
    await note.trigger('blur')
    await flushPromises()
    await wrapper.find<HTMLButtonElement>('button.undo-button').trigger('click')
    await flushPromises()

    expect(mocks.revertHistory).toHaveBeenCalledWith([
      expect.objectContaining({
        entity: 'monthlyRecord',
        key: { workerId: 'worker-li', month: '2026-09' },
        before: null,
        after: expect.objectContaining({
          dailyRateFen: 30_001,
          overtimePayPercent: 100,
          note: '九月新记录',
        }),
      }),
    ], expect.any(String))
    wrapper.unmount()
  })

  it('undoes a new adjustment together with the month record it created', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.findAll<HTMLButtonElement>('button').find((button) => button.text() === '新增一笔')!.trigger('click')
    const form = wrapper.find('form.modal-form')
    await form.find<HTMLInputElement>('input[inputmode="decimal"]').setValue('66.60')
    await form.find<HTMLInputElement>('input[maxlength="100"]').setValue('九月交通补贴')
    await form.find<HTMLInputElement>('input[type="date"]').setValue('2026-09-05')
    await form.trigger('submit')
    await flushPromises()

    expect(mocks.addPayAdjustment).toHaveBeenCalledWith(expect.objectContaining({
      workerId: 'worker-li',
      month: '2026-09',
      amountFen: 6_660,
      label: '九月交通补贴',
      siteId: null,
    }), expect.any(String))
    await wrapper.find<HTMLButtonElement>('button.undo-button').trigger('click')
    await vi.waitFor(() => expect(mocks.revertHistory).toHaveBeenCalledOnce())

    const targets = mocks.revertHistory.mock.calls[0][0] as HistoryRevertTarget[]
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entity: 'monthlyRecord',
        key: { workerId: 'worker-li', month: '2026-09' },
        before: null,
        after: expect.objectContaining({ overtimePayPercent: 100 }),
      }),
      expect.objectContaining({
        entity: 'payAdjustment',
        key: { id: 'adjustment-1' },
        before: null,
        after: expect.objectContaining({
          id: 'adjustment-1',
          createdAt: '2026-08-08T02:03:04.000Z',
          updatedAt: '2026-08-08T02:03:04.000Z',
        }),
      }),
    ]))
    wrapper.unmount()
  })

  it('captures the exact before and after snapshots when editing an adjustment', async () => {
    const original = makeAdjustment()
    serverState.payAdjustments = [clone(original)]
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('.adjustment-card').findAll<HTMLButtonElement>('button').find((button) => button.text() === '编辑')!.trigger('click')
    const form = wrapper.find('form.modal-form')
    await form.find<HTMLInputElement>('input[inputmode="decimal"]').setValue('99.99')
    await form.find<HTMLTextAreaElement>('textarea').setValue('修改后备注')
    await form.trigger('submit')
    await flushPromises()
    await wrapper.find<HTMLButtonElement>('button.undo-button').trigger('click')
    await vi.waitFor(() => expect(mocks.revertHistory).toHaveBeenCalledOnce())

    expect(mocks.revertHistory).toHaveBeenCalledWith([
      expect.objectContaining({
        entity: 'payAdjustment',
        key: { id: original.id },
        before: original,
        after: expect.objectContaining({
          ...original,
          amountFen: 9_999,
          note: '修改后备注',
          updatedAt: '2026-08-08T03:04:05.000Z',
        }),
      }),
    ], expect.any(String))
    wrapper.unmount()
  })

  it('keeps an adjustment id and timestamps in the deletion undo snapshot', async () => {
    const original = makeAdjustment()
    serverState.payAdjustments = [clone(original)]
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('.adjustment-card').findAll<HTMLButtonElement>('button').find((button) => button.text() === '删除')!.trigger('click')
    await flushPromises()
    await wrapper.find<HTMLButtonElement>('button.undo-button').trigger('click')
    await vi.waitFor(() => expect(mocks.revertHistory).toHaveBeenCalledOnce())

    expect(mocks.revertHistory).toHaveBeenCalledWith([{
      entity: 'payAdjustment',
      key: { id: original.id },
      before: original,
      after: null,
    }], expect.any(String))
    wrapper.unmount()
  })

  it('validates all batch rows before writing and preserves remaining rows after a mid-batch failure', async () => {
    const addWorker = mocks.addWorker.getMockImplementation()!
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('.add-worker-button').trigger('click')
    await wrapper.findAll('.worker-entry-tabs button')[1].trigger('click')
    let rows = wrapper.findAll('.batch-worker-row')
    await rows[0].findAll('input')[0].setValue('暑假工甲')
    await rows[0].findAll('input')[1].setValue('180')
    await rows[0].findAll('input')[1].trigger('keydown', { key: 'Enter' })
    rows = wrapper.findAll('.batch-worker-row')
    await rows[1].findAll('input')[0].setValue('暑假工乙')

    await wrapper.find('form').trigger('submit')
    expect(mocks.addWorker).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('第 2 行需要填写姓名和正确的日薪')

    await rows[1].findAll('input')[1].setValue('190')
    mocks.addWorker.mockImplementationOnce(addWorker).mockRejectedValueOnce(new Error('第二人保存失败'))
    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.text()).toContain('已成功添加 1 人；剩余 1 行尚未添加'))
    expect(mocks.addWorker).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('.batch-worker-row')).toHaveLength(1)
    expect(wrapper.find<HTMLInputElement>('.batch-worker-row input').element.value).toBe('暑假工乙')
    wrapper.unmount()
  })

  it('opens global search with Ctrl+F even from an input and navigates to the selected worker', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    const note = wrapper.find<HTMLTextAreaElement>('textarea[aria-label="本月备注"]')
    note.element.focus()
    note.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
    await flushPromises()
    expect(wrapper.find('.global-search-dialog').exists()).toBe(true)
    await wrapper.find<HTMLInputElement>('.global-search-dialog input[type="search"]').setValue('王强')
    await flushPromises()
    const result = wrapper.findAll<HTMLButtonElement>('.global-search-result').find((button) => button.text().includes('王强'))!
    await result.trigger('click')
    await flushPromises()
    expect(wrapper.find('.global-search-dialog').exists()).toBe(false)
    expect(wrapper.find('.summary-person h2').text()).toBe('王强')
    wrapper.unmount()
  })

  it('groups one worker into multiple actual-site cards by attended periods', async () => {
    serverState.sites = [
      { id: 'site-a', name: '一号工地', note: '', createdAt: '2026-07-01T00:00:00.000Z', archivedAt: null },
      { id: 'site-b', name: '二号工地', note: '', createdAt: '2026-07-02T00:00:00.000Z', archivedAt: null },
    ]
    const entry = serverState.attendance.find((item) => item.workerId === 'worker-li' && item.date === '2026-08-02')!
    entry.morningSiteId = 'site-a'
    entry.afternoonSiteId = 'site-b'
    entry.overtimeSiteId = 'site-a'
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.findAll('.view-tabs button')[1].trigger('click')
    await wrapper.find<HTMLInputElement>('.daily-toolbar input[type="date"]').setValue('2026-08-02')
    await flushPromises()

    const cards = wrapper.findAll<HTMLButtonElement>('.daily-site-card')
    const siteA = cards.find((card) => card.text().includes('一号工地'))!
    const siteB = cards.find((card) => card.text().includes('二号工地'))!
    expect(siteA.text()).toContain('李权（上、加）')
    expect(siteB.text()).toContain('李权（下）')
    await siteA.trigger('click')
    expect(wrapper.findAll('.daily-table tbody tr').filter((row) => row.text().includes('李权'))).toHaveLength(1)
    wrapper.unmount()
  })

  it('warns before changing a paid month and keeps the settlement marker', async () => {
    serverState.monthlyRecords[0].paidAt = '2026-08-07T02:00:00.000Z'
    const confirmPaid = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    vi.stubGlobal('confirm', confirmPaid)
    const wrapper = mount(App)
    await flushPromises()
    const morning = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]')
    expect(wrapper.text()).toContain('已结清')
    await morning.trigger('click')
    expect(morning.text()).toBe('')
    await morning.trigger('click')
    await flushPromises()
    expect(morning.text()).toBe('✓')
    expect(wrapper.text()).toContain('已结清')
    expect(confirmPaid).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('treats an all-absent attendance month as unpaid and exports only the paid-filtered rows', async () => {
    serverState.monthlyRecords[0].paidAt = '2026-08-07T02:00:00.000Z'
    serverState.attendance.push({
      workerId: 'worker-wang',
      date: '2026-07-03',
      morning: 'absent',
      afternoon: 'absent',
      overtime: null,
      dayNote: '',
      morningSiteId: null,
      afternoonSiteId: null,
      overtimeSiteId: null,
    })
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.findAll('.view-tabs button').find((button) => button.attributes('aria-label') === '年度汇总')!.trigger('click')
    const paidFilter = wrapper.findAll('.filter-field')
      .find((field) => field.text().includes('结清情况'))!
      .find('select')
    await paidFilter.setValue('unpaid')
    await flushPromises()

    expect(wrapper.findAll('.annual-table .worker-cell').map((cell) => cell.text())).toEqual(['王强'])
    await wrapper.findAll('button').find((button) => button.text() === '年度 Excel')!.trigger('click')

    expect(mocks.exportAnnualWorkbook).toHaveBeenCalledWith(expect.objectContaining({
      year: '2026',
      workerIds: ['worker-wang'],
      defaultSiteIds: undefined,
    }))
    expect(mocks.downloadWorkbook).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('reports workbook generation separately from desktop file-write failures', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.findAll('.view-tabs button').find((button) => button.attributes('aria-label') === '年度汇总')!.trigger('click')
    const exportButton = wrapper.findAll<HTMLButtonElement>('button')
      .find((button) => button.text() === '年度 Excel')!

    mocks.exportAnnualWorkbook.mockImplementationOnce(() => {
      throw new Error('工作簿公式生成异常')
    })
    await exportButton.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('年度汇总 Excel 导出生成失败：工作簿公式生成异常')
    expect(mocks.downloadWorkbook).not.toHaveBeenCalled()

    mocks.downloadWorkbook.mockRejectedValueOnce(new Error('目标文件被其他程序占用，请关闭后重试。'))
    await exportButton.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('年度汇总 Excel 导出写入失败：目标文件被其他程序占用，请关闭后重试。')
    wrapper.unmount()
  })

  it('sets, locks, cancels and conflict-safely undoes a paid leave cell', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()

    await wrapper.get<HTMLButtonElement>('button[aria-label="2026-08-04 morning 标记请假"]').trigger('click')
    const leaveDialog = wrapper.get('.leave-dialog')
    expect(leaveDialog.text()).toContain('1 天 · 1 个时段')
    const morningLeaveSelect = leaveDialog.findAll('label').find((label) => label.text().includes('上午请假'))!.find('select')
    await morningLeaveSelect.setValue('paid')
    await leaveDialog.findAll<HTMLButtonElement>('.modal-actions button').find((button) => button.text() === '应用请假')!.trigger('click')
    await flushPromises()

    expect(mocks.setAttendanceLeave).toHaveBeenCalledWith([{
      workerId: 'worker-li',
      date: '2026-08-04',
      period: 'morning',
      leave: { payType: 'paid' },
    }], { allowFuture: false, operationId: expect.any(String) })
    const leaveCell = () => wrapper.get<HTMLButtonElement>('button[aria-label^="2026-08-04 morning："]')
    expect(leaveCell().text()).toBe('假')
    expect(leaveCell().attributes('aria-disabled')).toBe('true')
    expect(leaveCell().attributes('aria-label')).toContain('带薪请假')

    mocks.setAttendanceBatch.mockClear()
    await leaveCell().trigger('pointerenter')
    leaveCell().element.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
    await flushPromises()
    expect(mocks.setAttendanceBatch).not.toHaveBeenCalled()
    expect(leaveCell().text()).toBe('假')
    expect(wrapper.text()).toContain('请使用“取消请假”')

    await wrapper.get<HTMLButtonElement>('button[aria-label="2026-08-04 morning 查看或取消请假"]').trigger('click')
    await wrapper.get('.leave-dialog').findAll<HTMLButtonElement>('.modal-actions button').find((button) => button.text() === '取消请假')!.trigger('click')
    await flushPromises()
    expect(mocks.setAttendanceLeave).toHaveBeenLastCalledWith([{
      workerId: 'worker-li',
      date: '2026-08-04',
      period: 'morning',
      leave: null,
    }], { allowFuture: false, operationId: expect.any(String) })
    expect(leaveCell().text()).toBe('')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    await vi.waitFor(() => expect(mocks.revertHistory).toHaveBeenCalledOnce())
    expect(mocks.revertHistory).toHaveBeenCalledWith([expect.objectContaining({
      entity: 'attendance',
      key: { workerId: 'worker-li', date: '2026-08-04' },
      before: expect.objectContaining({ morningLeave: { payType: 'paid' } }),
      after: expect.objectContaining({ morningLeave: null }),
    })], expect.any(String))
    await vi.waitFor(() => expect(serverState.attendance.find((entry) => entry.workerId === 'worker-li' && entry.date === '2026-08-04')?.morningLeave).toEqual({ payType: 'paid' }))
    await vi.waitFor(() => expect({
      vmRevision: (wrapper.vm as unknown as { data: AppData }).data.revision,
      serverRevision: serverState.revision,
      leave: (wrapper.vm as unknown as { data: AppData }).data.attendance.find((entry) => entry.workerId === 'worker-li' && entry.date === '2026-08-04')?.morningLeave,
      saveStatus: (wrapper.vm as unknown as { saveStatus: string }).saveStatus,
      saveError: (wrapper.vm as unknown as { saveError: string }).saveError,
    }).toEqual({ vmRevision: serverState.revision, serverRevision: serverState.revision, leave: { payType: 'paid' }, saveStatus: 'saved', saveError: '' }))
    await vi.waitFor(() => expect(leaveCell().text()).toBe('假'))
    wrapper.unmount()
  })

  it('uses Alt+T everywhere and reserves Ctrl+T for the Windows desktop app', async () => {
    const browserWrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    const browserMonth = browserWrapper.get<HTMLInputElement>('.month-picker input[type="month"]')
    await browserMonth.setValue('2026-07')
    await browserMonth.trigger('change')
    await flushPromises()

    const browserCtrlT = new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(browserCtrlT)
    await flushPromises()
    expect(browserCtrlT.defaultPrevented).toBe(false)
    expect(browserWrapper.get<HTMLInputElement>('.month-picker input[type="month"]').element.value).toBe('2026-07')

    const altT = new KeyboardEvent('keydown', { key: 't', altKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(altT)
    await flushPromises()
    expect(altT.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect((browserWrapper.vm as unknown as { selectedMonth: string }).selectedMonth).toBe('2026-08'))
    await vi.waitFor(() => expect(browserWrapper.get<HTMLInputElement>('.month-picker input[type="month"]').element.value).toBe('2026-08'))
    await vi.waitFor(() => expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toContain('2026-08-08 morning'))
    browserWrapper.unmount()

    window.jigongbenDesktop = makeDesktopBridge()
    const desktopWrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    await desktopWrapper.get<HTMLInputElement>('.month-picker input[type="month"]').setValue('2026-07')
    await desktopWrapper.get<HTMLInputElement>('.month-picker input[type="month"]').trigger('change')
    await flushPromises()
    const desktopCtrlT = new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(desktopCtrlT)
    await flushPromises()
    expect(desktopCtrlT.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(desktopWrapper.get<HTMLInputElement>('.month-picker input[type="month"]').element.value).toBe('2026-08'))
    desktopWrapper.unmount()
  })

  it('keeps the archive-worker action in edit mode and moves a confirmed worker to history', async () => {
    const confirmArchive = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    vi.stubGlobal('confirm', confirmArchive)
    const wrapper = mount(App)
    await flushPromises()

    await wrapper.findAll<HTMLButtonElement>('.worker-menu')[0].trigger('click')
    expect(wrapper.get('#worker-dialog-title').text()).toBe('编辑工人')
    const archive = () => wrapper.get<HTMLButtonElement>('.archive-worker-action')
    expect(archive().text()).toContain('归档工人')
    await archive().trigger('click')
    expect(mocks.updateWorker).not.toHaveBeenCalled()
    expect(wrapper.get('#worker-dialog-title').text()).toBe('编辑工人')

    await archive().trigger('click')
    await flushPromises()
    expect(mocks.updateWorker).toHaveBeenCalledWith('worker-li', { archived: true }, expect.any(String))
    expect(wrapper.find('#worker-dialog-title').exists()).toBe(false)
    expect(wrapper.findAll('.worker-select').map((button) => button.text()).join(' ')).not.toContain('李权')
    expect(wrapper.get('.archived-button').text()).toContain('已归档 1')
    expect(wrapper.get('.summary-person h2').text()).toBe('王强')
    expect(wrapper.get<HTMLInputElement>('input[aria-label="本月日薪"]').element.disabled).toBe(false)
    expect(confirmArchive).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('opens the site-statistics page and exports the selected period through the shared workbook flow', async () => {
    serverState.sites = [{ id: 'site-a', name: '一号工地', note: '', createdAt: '2026-07-01T00:00:00.000Z', archivedAt: null }]
    serverState.attendance[0].morningSiteId = 'site-a'
    const wrapper = mount(App)
    await flushPromises()

    await wrapper.findAll<HTMLButtonElement>('.view-tabs button').find((button) => button.attributes('aria-label') === '工地统计')!.trigger('click')
    expect(wrapper.get('.site-statistics-view').text()).toContain('2026年8月工地统计')
    expect(wrapper.get('.site-statistics-view').text()).toContain('一号工地')
    expect(wrapper.get('.site-statistics-view').text()).toContain('工地人次')
    await wrapper.get<HTMLButtonElement>('.site-statistics-export').trigger('click')
    await flushPromises()

    expect(mocks.exportSiteStatisticsWorkbook).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ schemaVersion: 8 }),
      period: { mode: 'month', month: '2026-08' },
      includeEmptySites: true,
    }))
    expect(mocks.downloadWorkbook).toHaveBeenCalledWith({ filename: '工地统计.xlsx', bytes: expect.any(Uint8Array) })
    expect(wrapper.text()).toContain('工地统计 Excel 导出已保存')
    wrapper.unmount()
  })

  it('requires and atomically records a default-site reassignment when archiving a site', async () => {
    serverState.sites = [
      { id: 'site-old', name: '旧工地', note: '', createdAt: '2026-07-01T00:00:00.000Z', archivedAt: null },
      { id: 'site-new', name: '新工地', note: '', createdAt: '2026-07-02T00:00:00.000Z', archivedAt: null },
    ]
    serverState.workers[0].defaultSiteId = 'site-old'
    serverState.workers[1].defaultSiteId = 'site-old'
    serverState.attendance[0].morningSiteId = 'site-old'
    const wrapper = mount(App)
    await flushPromises()

    await wrapper.findAll<HTMLButtonElement>('button').find((button) => button.text() === '设置')!.trigger('click')
    const oldSiteCard = () => wrapper.findAll('.site-card').find((card) => card.text().includes('旧工地'))!
    await oldSiteCard().findAll<HTMLButtonElement>('button').find((button) => button.text() === '归档')!.trigger('click')
    const archiveDialog = () => wrapper.get('[aria-labelledby="site-archive-title"]')
    expect(archiveDialog().text()).toContain('受影响默认工人：2 人')
    expect(archiveDialog().text()).toContain('李权、王强')

    await archiveDialog().findAll<HTMLButtonElement>('.modal-actions button').find((button) => button.text() === '确认归档')!.trigger('click')
    expect(mocks.updateSite).not.toHaveBeenCalled()
    expect(archiveDialog().get('[role="alert"]').text()).toContain('请选择新的活动工地')
    await archiveDialog().get('select').setValue('site-new')
    await archiveDialog().findAll<HTMLButtonElement>('.modal-actions button').find((button) => button.text() === '确认归档')!.trigger('click')
    await flushPromises()

    expect(mocks.updateSite).toHaveBeenCalledWith('site-old', {
      archived: true,
      replacementDefaultSiteId: 'site-new',
    }, expect.any(String))
    expect(serverState.workers.map((worker) => worker.defaultSiteId)).toEqual(['site-new', 'site-new'])
    expect(serverState.attendance[0].morningSiteId).toBe('site-old')
    expect(oldSiteCard().text()).toContain('已归档')

    await wrapper.get<HTMLButtonElement>('[aria-label="关闭设置"]').trigger('click')
    await wrapper.get<HTMLButtonElement>('button.undo-button').trigger('click')
    await vi.waitFor(() => expect(mocks.revertHistory).toHaveBeenCalledOnce())
    const target = (mocks.revertHistory.mock.calls[0][0] as HistoryRevertTarget[])[0]
    expect(target).toEqual(expect.objectContaining({
      entity: 'siteArchive',
      key: { id: 'site-old' },
      before: expect.objectContaining({
        archivedAt: null,
        workerDefaults: [
          { workerId: 'worker-li', defaultSiteId: 'site-old' },
          { workerId: 'worker-wang', defaultSiteId: 'site-old' },
        ],
      }),
      after: expect.objectContaining({
        archivedAt: '2026-08-08T05:06:07.000Z',
        workerDefaults: [
          { workerId: 'worker-li', defaultSiteId: 'site-new' },
          { workerId: 'worker-wang', defaultSiteId: 'site-new' },
        ],
      }),
    }))
    expect(serverState.workers.map((worker) => worker.defaultSiteId)).toEqual(['site-old', 'site-old'])
    expect(serverState.attendance[0].morningSiteId).toBe('site-old')
    wrapper.unmount()
  })

  it('rechecks an unknown close-time mutation once with the original operation id', async () => {
    let closeRequested: ((requestId: string) => void) | null = null
    const completeClose = vi.fn().mockResolvedValue({ accepted: true })
    window.jigongbenDesktop = makeDesktopBridge({
      onCloseRequested: vi.fn((callback) => {
        closeRequested = callback
        return () => undefined
      }),
      completeClose,
    })
    let committed = false
    mocks.setAttendanceBatch.mockImplementation(async (patches: AttendancePatch[]) => {
      if (!committed) {
        for (const patch of patches) applyAttendancePatch(serverState, patch)
        serverState.revision += 1
        committed = true
        throw new ApiError('保存响应丢失', 'MUTATION_RESULT_UNKNOWN')
      }
      return clone(serverState)
    })
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('.error-banner').text()).toContain('核对并重试'))

    closeRequested!('close-unknown-result')
    await vi.waitFor(() => expect(completeClose).toHaveBeenCalledWith({
      requestId: 'close-unknown-result',
      ok: true,
    }))
    expect(mocks.setAttendanceBatch).toHaveBeenCalledTimes(2)
    const firstOperationId = mocks.setAttendanceBatch.mock.calls[0][1].operationId
    expect(mocks.setAttendanceBatch.mock.calls[1][1].operationId).toBe(firstOperationId)
    expect(serverState.revision).toBe(5)
    wrapper.unmount()
  })

  it('retries every close-time monthly draft in order after the first response is unknown', async () => {
    let closeRequested: ((requestId: string) => void) | null = null
    const completeClose = vi.fn().mockResolvedValue({ accepted: true })
    window.jigongbenDesktop = makeDesktopBridge({
      onCloseRequested: vi.fn((callback) => {
        closeRequested = callback
        return () => undefined
      }),
      completeClose,
    })

    const applyMonthlyRecord = mocks.setMonthlyRecord.getMockImplementation()!
    const committedOperationIds = new Set<string>()
    let loseFirstResponse = true
    mocks.setMonthlyRecord.mockImplementation(async (payload, operationId: string) => {
      if (committedOperationIds.has(operationId)) return clone(serverState)
      const result = await applyMonthlyRecord(payload, operationId)
      committedOperationIds.add(operationId)
      if (loseFirstResponse) {
        loseFirstResponse = false
        throw new ApiError('保存响应丢失', 'MUTATION_RESULT_UNKNOWN')
      }
      return result
    })

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.get<HTMLInputElement>('input[aria-label="本月日薪"]').setValue('410.25')
    await wrapper.get<HTMLInputElement>('input[aria-label="本月加班倍率"]').setValue('1.5')
    await wrapper.get<HTMLTextAreaElement>('textarea[aria-label="本月备注"]').setValue('关闭前全部保存')

    closeRequested!('close-multiple-monthly-drafts')
    await vi.waitFor(() => expect(completeClose).toHaveBeenCalledWith({
      requestId: 'close-multiple-monthly-drafts',
      ok: true,
    }))

    expect(mocks.setMonthlyRecord).toHaveBeenCalledTimes(4)
    expect(mocks.setMonthlyRecord.mock.calls[1][1]).toBe(mocks.setMonthlyRecord.mock.calls[0][1])
    expect(mocks.setMonthlyRecord.mock.calls.slice(1).map(([payload]) => payload)).toEqual([
      expect.objectContaining({ dailyRateFen: 41_025 }),
      expect.objectContaining({ overtimePayPercent: 150 }),
      expect.objectContaining({ note: '关闭前全部保存' }),
    ])
    expect(serverState.monthlyRecords[0]).toEqual(expect.objectContaining({
      dailyRateFen: 41_025,
      overtimePayPercent: 150,
      note: '关闭前全部保存',
    }))
    wrapper.unmount()
  })

  it('restores editable fields immediately when the native close dialog is cancelled', async () => {
    let closeRequested: ((requestId: string) => void) | null = null
    let closeCancelled: ((requestId: string) => void) | null = null
    const completeClose = vi.fn().mockResolvedValue({ accepted: true })
    window.jigongbenDesktop = makeDesktopBridge({
      onCloseRequested: vi.fn((callback) => {
        closeRequested = callback
        return () => undefined
      }),
      onCloseCancelled: vi.fn((callback) => {
        closeCancelled = callback
        return () => undefined
      }),
      completeClose,
    })

    const applyMonthlyRecord = mocks.setMonthlyRecord.getMockImplementation()!
    let finishSave: (() => void) | null = null
    mocks.setMonthlyRecord.mockImplementation((...args) => new Promise((resolve, reject) => {
      finishSave = () => {
        Promise.resolve(applyMonthlyRecord(...args)).then(resolve, reject)
      }
    }))

    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    const rate = wrapper.get<HTMLInputElement>('input[aria-label="本月日薪"]')
    await rate.setValue('420.25')
    closeRequested!('close-cancelled-by-user')
    await vi.waitFor(() => expect(finishSave).not.toBeNull())
    expect(wrapper.get('.app-shell').classes()).toContain('is-quiescing')
    expect(rate.element.disabled).toBe(true)

    // Native retry handshakes can have a newer id while the original flush is
    // still active; cancelling either one must restore the whole app.
    closeCancelled!('close-retry-cancelled-by-user')
    await flushPromises()
    expect(wrapper.get('.app-shell').classes()).not.toContain('is-quiescing')
    expect(rate.element.disabled).toBe(false)
    rate.element.focus()
    expect(document.activeElement).toBe(rate.element)

    finishSave!()
    await flushPromises()
    expect(completeClose).not.toHaveBeenCalled()
    expect(wrapper.get('.app-shell').classes()).not.toContain('is-quiescing')
    expect(rate.element.disabled).toBe(false)
    wrapper.unmount()
  })

  it('queues a fresh close request while an expired request is still flushing', async () => {
    let closeRequested: ((requestId: string) => void) | null = null
    const completeClose = vi.fn().mockImplementation(async ({ requestId }: { requestId: string }) => ({
      accepted: requestId === 'close-retry',
    }))
    window.jigongbenDesktop = makeDesktopBridge({
      onCloseRequested: vi.fn((callback) => {
        closeRequested = callback
        return () => undefined
      }),
      completeClose,
    })

    let finishSave: (() => void) | null = null
    mocks.setAttendanceBatch.mockImplementation((patches: AttendancePatch[]) => new Promise((resolve) => {
      finishSave = () => {
        for (const patch of patches) applyAttendancePatch(serverState, patch)
        serverState.revision += 1
        resolve(clone(serverState))
      }
    }))

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]').trigger('click')
    await vi.waitFor(() => expect(finishSave).not.toBeNull())

    closeRequested!('close-expired')
    await flushPromises()
    closeRequested!('close-retry')
    finishSave!()

    await vi.waitFor(() => expect(completeClose).toHaveBeenCalledTimes(2))
    expect(completeClose.mock.calls.map(([request]) => request)).toEqual([
      { requestId: 'close-expired', ok: true },
      { requestId: 'close-retry', ok: true },
    ])
    wrapper.unmount()
  })

  it('keeps exactly the latest 50 attendance actions in the undo stack', async () => {
    const wrapper = mount(App)
    await flushPromises()
    const cell = wrapper.find<HTMLButtonElement>('button[aria-label^="2026-08-01 morning"]')

    for (let index = 0; index < 51; index += 1) {
      await cell.trigger('click')
      await flushPromises()
    }

    const undo = wrapper.find<HTMLButtonElement>('button.undo-button')
    expect(undo.element.disabled).toBe(false)
    for (let index = 0; index < 50; index += 1) {
      await undo.trigger('click')
      await flushPromises()
    }
    expect(undo.element.disabled).toBe(true)

    const callsAfterFiftyUndos = mocks.setAttendanceBatch.mock.calls.length
    await undo.trigger('click')
    await flushPromises()
    expect(mocks.setAttendanceBatch).toHaveBeenCalledTimes(callsAfterFiftyUndos)
    wrapper.unmount()
  })

  it('opens the operation guide from the sidebar', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('button.help-button[aria-label="操作说明"]').trigger('click')
    const guide = wrapper.find('[role="dialog"][aria-label="操作说明"]')
    expect(guide.exists()).toBe(true)
    expect(guide.text()).toContain('Ctrl + Z')
    expect(guide.text()).toContain('区域圈选')
    wrapper.unmount()
  })
  it('autosaves day choices and flushes the note on Done, preserving the day when opening leave options', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    wrapper.getComponent(MonthlyView).vm.$emit('open-day', 'worker-li', '2026-08-01')
    await flushPromises()
    await wrapper.get('.day-status-button[data-period="morning"][data-status="present"]').trigger('click')
    await flushPromises()
    expect(serverState.attendance.find((entry) => entry.workerId === 'worker-li' && entry.date === '2026-08-01')?.morning).toBe('present')
    await wrapper.get('textarea[aria-label="单日备注"]').setValue('手机备注不丢失')
    await wrapper.get('button[aria-label="下午请假"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.day-details-dialog').exists()).toBe(false)
    await wrapper.findAll('button').find((button) => button.attributes('aria-label') === '关闭请假设置')!.trigger('click')
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>('textarea[aria-label="单日备注"]').element.value).toBe('手机备注不丢失')
    await wrapper.get('textarea[aria-label="单日备注"]').setValue('完成时立即保存')
    await wrapper.get('.day-done button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.day-details-dialog').exists()).toBe(false)
    expect(serverState.attendance.find((entry) => entry.workerId === 'worker-li' && entry.date === '2026-08-01')?.dayNote).toBe('完成时立即保存')
    wrapper.unmount()
  })

  it('keeps a failed day note visible and retries the retained write before closing', async () => {
    const wrapper = mount(App)
    await flushPromises()
    wrapper.getComponent(MonthlyView).vm.$emit('open-day', 'worker-li', '2026-08-01')
    await flushPromises()
    mocks.setAttendanceBatch.mockRejectedValueOnce(new Error('模拟写盘失败'))
    await wrapper.get('textarea[aria-label="单日备注"]').setValue('失败后仍在的草稿')
    await wrapper.get('.day-done button').trigger('click')
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>('textarea[aria-label="单日备注"]').element.value).toBe('失败后仍在的草稿')
    expect(wrapper.get('.day-save-state').text()).toContain('保存失败')
    await wrapper.get('.day-save-state button').trigger('click')
    await flushPromises()
    await wrapper.get('.day-done button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.day-details-dialog').exists()).toBe(false)
    expect(serverState.attendance.find((entry) => entry.workerId === 'worker-li' && entry.date === '2026-08-01')?.dayNote).toBe('失败后仍在的草稿')
    wrapper.unmount()
  })

  it('uses one undoable batch for mobile date selection', async () => {
    const wrapper = mount(App)
    await flushPromises()
    wrapper.getComponent(MonthlyView).vm.$emit('mobile-batch', ['2026-08-01', '2026-08-02'], 'afternoon', 'present')
    await flushPromises()
    expect(mocks.setAttendanceBatch).toHaveBeenCalledTimes(1)
    expect(serverState.attendance.find((entry) => entry.workerId === 'worker-li' && entry.date === '2026-08-01')?.afternoon).toBe('present')
    await wrapper.get('.undo-button').trigger('click')
    await flushPromises()
    expect(mocks.revertHistory).toHaveBeenCalledTimes(1)
    expect(serverState.attendance.find((entry) => entry.workerId === 'worker-li' && entry.date === '2026-08-01')?.afternoon ?? null).toBe(null)
    wrapper.unmount()
  })

  it('freezes the day editor while Done waits for its last note to save', async () => {
    const wrapper = mount(App)
    await flushPromises()
    wrapper.getComponent(MonthlyView).vm.$emit('open-day', 'worker-li', '2026-08-01')
    await flushPromises()
    let finish: (() => void) | undefined
    mocks.setAttendanceBatch.mockImplementationOnce((patches: AttendancePatch[]) => new Promise(resolve => {
      finish = () => {
        for (const patch of patches) applyAttendancePatch(serverState, patch)
        serverState.revision += 1
        resolve(clone(serverState))
      }
    }))
    await wrapper.get('textarea[aria-label="单日备注"]').setValue('等待保存的备注')
    await wrapper.get('.day-done button').trigger('click')
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>('textarea[aria-label="单日备注"]').element.disabled).toBe(true)
    expect(wrapper.get<HTMLButtonElement>('.day-status-button').element.disabled).toBe(true)
    finish!()
    await flushPromises()
    expect(wrapper.find('.day-details-dialog').exists()).toBe(false)
    expect(serverState.attendance.find(entry => entry.workerId === 'worker-li' && entry.date === '2026-08-01')?.dayNote).toBe('等待保存的备注')
    wrapper.unmount()
  })

  it('blocks new day edits while a prior save result is unknown and resumes after reconciliation', async () => {
    const wrapper = mount(App)
    await flushPromises()
    wrapper.getComponent(MonthlyView).vm.$emit('open-day', 'worker-li', '2026-08-01')
    await flushPromises()
    mocks.setAttendanceBatch.mockRejectedValueOnce(new ApiError('请核对保存结果', 'MUTATION_RESULT_UNKNOWN'))
    await wrapper.get('textarea[aria-label="单日备注"]').setValue('结果待确认的备注')
    await wrapper.get('textarea[aria-label="单日备注"]').trigger('blur')
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>('textarea[aria-label="单日备注"]').element.disabled).toBe(true)
    expect(wrapper.get('.day-save-state').text()).toContain('保存结果待核对')
    await wrapper.get('.day-save-state button').trigger('click')
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>('textarea[aria-label="单日备注"]').element.disabled).toBe(false)
    await wrapper.get('textarea[aria-label="单日备注"]').setValue('核对后继续修改')
    await wrapper.get('.day-done button').trigger('click')
    await flushPromises()
    expect(serverState.attendance.find(entry => entry.workerId === 'worker-li' && entry.date === '2026-08-01')?.dayNote).toBe('核对后继续修改')
    wrapper.unmount()
  })

})
