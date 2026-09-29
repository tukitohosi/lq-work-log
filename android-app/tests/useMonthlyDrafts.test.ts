import { computed, effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  overtimePercentToInput,
  parseOvertimeMultiplier,
  useMonthlyDrafts,
} from '../src/composables/useMonthlyDrafts'
import type { Worker } from '../src/types'

const worker: Worker = {
  id: 'worker-1',
  name: '李权',
  avatarDataUrl: null,
  avatarEmoji: null,
  defaultDailyRateFen: 30_000,
  note: '',
  defaultSiteId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  archivedAt: null,
}

describe('useMonthlyDrafts', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('formats and parses overtime multipliers as integer percentages', () => {
    expect(overtimePercentToInput(0)).toBe('0')
    expect(overtimePercentToInput(100)).toBe('1')
    expect(overtimePercentToInput(150)).toBe('1.5')
    expect(overtimePercentToInput(125)).toBe('1.25')
    expect(overtimePercentToInput(1000)).toBe('10')

    expect(parseOvertimeMultiplier(' 1.5 ')).toBe(150)
    expect(parseOvertimeMultiplier('0')).toBe(0)
    expect(parseOvertimeMultiplier('10')).toBe(1000)
    expect(parseOvertimeMultiplier('1.25')).toBe(125)
    expect(parseOvertimeMultiplier('')).toBeNull()
    expect(parseOvertimeMultiplier('-1')).toBeNull()
    expect(parseOvertimeMultiplier('10.01')).toBeNull()
    expect(parseOvertimeMultiplier('1.234')).toBeNull()
  })

  it('debounces rate and overtime saves and flushes old keyed drafts when the month changes', async () => {
    const selectedWorker = ref<Worker | null>(worker)
    const month = ref('2026-08')
    const rates = ref<Record<string, number>>({ 'worker-1\u00002026-08': 30_000 })
    const overtimePercents = ref<Record<string, number>>({ 'worker-1\u00002026-08': 100 })
    const notes = ref<Record<string, string>>({ 'worker-1\u00002026-08': '' })
    const saveRate = vi.fn(async (workerId: string, targetMonth: string, fen: number) => {
      rates.value = { ...rates.value, [`${workerId}\u0000${targetMonth}`]: fen }
    })
    const saveNote = vi.fn(async (workerId: string, targetMonth: string, note: string) => {
      notes.value = { ...notes.value, [`${workerId}\u0000${targetMonth}`]: note }
    })
    const saveOvertimePercent = vi.fn(async (workerId: string, targetMonth: string, percent: number) => {
      overtimePercents.value = { ...overtimePercents.value, [`${workerId}\u0000${targetMonth}`]: percent }
    })
    const scope = effectScope()
    const drafts = scope.run(() => useMonthlyDrafts({
      worker: computed(() => selectedWorker.value),
      month,
      dailyRateFen: computed(() => rates.value[`${selectedWorker.value?.id}\u0000${month.value}`] ?? 30_000),
      overtimePayPercent: computed(() => overtimePercents.value[`${selectedWorker.value?.id}\u0000${month.value}`] ?? 100),
      monthlyNote: computed(() => notes.value[`${selectedWorker.value?.id}\u0000${month.value}`] ?? ''),
      saveRate,
      saveOvertimePercent,
      saveNote,
    }))!

    drafts.scheduleRate('317.25')
    await vi.advanceTimersByTimeAsync(499)
    expect(saveRate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(saveRate).toHaveBeenCalledWith('worker-1', '2026-08', 31_725)

    drafts.scheduleOvertime('1.25')
    drafts.scheduleOvertime('1.5')
    await vi.advanceTimersByTimeAsync(499)
    expect(saveOvertimePercent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(saveOvertimePercent).toHaveBeenCalledTimes(1)
    expect(saveOvertimePercent).toHaveBeenCalledWith('worker-1', '2026-08', 150)

    drafts.scheduleNote('八月结算说明')
    drafts.scheduleOvertime('2')
    month.value = '2026-09'
    await nextTick()
    expect(saveNote).toHaveBeenCalledWith('worker-1', '2026-08', '八月结算说明')
    expect(saveOvertimePercent).toHaveBeenLastCalledWith('worker-1', '2026-08', 200)
    expect(drafts.noteDraft.value).toBe('')
    expect(drafts.overtimeDraft.value).toBe('1')

    await drafts.dispose()
    scope.stop()
  })

  it('flushes all pending draft types immediately and rejects invalid rate and overtime values', async () => {
    const selectedWorker = ref<Worker | null>(worker)
    const month = ref('2026-08')
    const saveRate = vi.fn(async () => undefined)
    const saveOvertimePercent = vi.fn(async () => undefined)
    const saveNote = vi.fn(async () => undefined)
    const scope = effectScope()
    const drafts = scope.run(() => useMonthlyDrafts({
      worker: computed(() => selectedWorker.value),
      month,
      dailyRateFen: computed(() => 30_000),
      overtimePayPercent: computed(() => 100),
      monthlyNote: computed(() => ''),
      saveRate,
      saveOvertimePercent,
      saveNote,
    }))!

    drafts.scheduleRate('金额错误')
    expect(drafts.rateError.value).toBe('请输入正确的日薪金额。')
    drafts.flushRate()
    expect(saveRate).not.toHaveBeenCalled()

    drafts.scheduleOvertime('1.234')
    expect(drafts.overtimeError.value).toBe('请输入 0–10 之间、最多两位小数的倍率。')
    drafts.flushOvertime()
    expect(saveOvertimePercent).not.toHaveBeenCalled()

    drafts.scheduleRate('320.50')
    drafts.scheduleOvertime('1.75')
    drafts.scheduleNote('关闭前保存')
    drafts.flushRate()
    drafts.flushOvertime()
    drafts.flushNote()
    await Promise.resolve()
    expect(saveRate).toHaveBeenCalledWith('worker-1', '2026-08', 32_050)
    expect(saveOvertimePercent).toHaveBeenCalledWith('worker-1', '2026-08', 175)
    expect(saveNote).toHaveBeenCalledWith('worker-1', '2026-08', '关闭前保存')

    await drafts.dispose()
    scope.stop()
  })

  it('flushes a pending overtime draft against the previous worker when the worker changes', async () => {
    const nextWorker: Worker = { ...worker, id: 'worker-2', name: '王强' }
    const selectedWorker = ref<Worker | null>(worker)
    const month = ref('2026-08')
    const saveOvertimePercent = vi.fn(async () => undefined)
    const scope = effectScope()
    const drafts = scope.run(() => useMonthlyDrafts({
      worker: computed(() => selectedWorker.value),
      month,
      dailyRateFen: computed(() => selectedWorker.value?.defaultDailyRateFen ?? 0),
      overtimePayPercent: computed(() => 100),
      monthlyNote: computed(() => ''),
      saveRate: vi.fn(async () => undefined),
      saveOvertimePercent,
      saveNote: vi.fn(async () => undefined),
    }))!

    drafts.scheduleOvertime('1.5')
    selectedWorker.value = nextWorker
    await nextTick()

    expect(saveOvertimePercent).toHaveBeenCalledWith('worker-1', '2026-08', 150)
    expect(drafts.overtimeDraft.value).toBe('1')

    await drafts.dispose()
    scope.stop()
  })

  it('does not persist drafts reverted to their semantic originals and flushes real edits on dispose', async () => {
    const selectedWorker = ref<Worker | null>(worker)
    const month = ref('2026-08')
    const saveRate = vi.fn(async () => undefined)
    const saveOvertimePercent = vi.fn(async () => undefined)
    const saveNote = vi.fn(async () => undefined)
    const scope = effectScope()
    const drafts = scope.run(() => useMonthlyDrafts({
      worker: computed(() => selectedWorker.value),
      month,
      dailyRateFen: computed(() => 30_000),
      overtimePayPercent: computed(() => 100),
      monthlyNote: computed(() => ''),
      saveRate,
      saveOvertimePercent,
      saveNote,
    }))!

    drafts.scheduleRate('320')
    drafts.scheduleRate('300')
    drafts.scheduleOvertime('1.5')
    drafts.scheduleOvertime('1')
    drafts.scheduleNote('临时备注')
    drafts.scheduleNote('')
    await drafts.dispose()
    expect(saveRate).not.toHaveBeenCalled()
    expect(saveOvertimePercent).not.toHaveBeenCalled()
    expect(saveNote).not.toHaveBeenCalled()

    const second = scope.run(() => useMonthlyDrafts({
      worker: computed(() => selectedWorker.value),
      month,
      dailyRateFen: computed(() => 30_000),
      overtimePayPercent: computed(() => 100),
      monthlyNote: computed(() => ''),
      saveRate,
      saveOvertimePercent,
      saveNote,
    }))!
    second.scheduleRate('325.50')
    second.scheduleOvertime('1.25')
    second.scheduleNote('关闭时保存')
    await second.dispose()
    expect(saveRate).toHaveBeenCalledWith('worker-1', '2026-08', 32_550)
    expect(saveOvertimePercent).toHaveBeenCalledWith('worker-1', '2026-08', 125)
    expect(saveNote).toHaveBeenCalledWith('worker-1', '2026-08', '关闭时保存')
    scope.stop()
  })
})
