import { ref, watch, type ComputedRef, type Ref } from 'vue'
import { fenToInput, parseYuanToFen } from '../money'
import type { Worker } from '../types'

type PendingRate = { timer: ReturnType<typeof setTimeout>; workerId: string; month: string; fen: number }
type PendingNote = { timer: ReturnType<typeof setTimeout>; workerId: string; month: string; note: string }
type PendingOvertime = { timer: ReturnType<typeof setTimeout>; workerId: string; month: string; percent: number }

interface UseMonthlyDraftsOptions {
  worker: ComputedRef<Worker | null>
  month: Ref<string>
  dailyRateFen: ComputedRef<number | null>
  overtimePayPercent: ComputedRef<number | null>
  monthlyNote: ComputedRef<string>
  confirmRateChange?: (workerId: string, month: string) => boolean
  confirmOvertimeChange?: (workerId: string, month: string) => boolean
  saveRate: (workerId: string, month: string, fen: number) => Promise<unknown>
  saveOvertimePercent: (workerId: string, month: string, percent: number) => Promise<unknown>
  saveNote: (workerId: string, month: string, note: string) => Promise<unknown>
  delayMs?: number
}

export function monthlyDraftKey(workerId: string, month: string): string {
  return `${workerId}\u0000${month}`
}

export function overtimePercentToInput(percent: number): string {
  return (percent / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

export function parseOvertimeMultiplier(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null
  const multiplier = Number(normalized)
  if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 10) return null
  return Math.round(multiplier * 100)
}

export function useMonthlyDrafts(options: UseMonthlyDraftsOptions) {
  const delayMs = options.delayMs ?? 500
  const rateDraft = ref('')
  const rateError = ref('')
  const rateDraftKey = ref('')
  const overtimeDraft = ref('')
  const overtimeError = ref('')
  const overtimeDraftKey = ref('')
  const noteDraft = ref('')
  const noteDraftKey = ref('')
  const pendingRates = new Map<string, PendingRate>()
  const pendingOvertime = new Map<string, PendingOvertime>()
  const pendingNotes = new Map<string, PendingNote>()
  const savingRates = new Map<string, Promise<unknown>>()
  const savingOvertime = new Map<string, Promise<unknown>>()
  const savingNotes = new Map<string, Promise<unknown>>()

  watch(
    [() => options.worker.value?.id ?? null, options.month, options.dailyRateFen, options.overtimePayPercent, options.monthlyNote],
    ([workerId, month, dailyRateFen, overtimePayPercent, note]) => {
      const key = workerId ? monthlyDraftKey(workerId, month) : ''
      if (rateDraftKey.value !== key || (!pendingRates.has(key) && !savingRates.has(key))) {
        rateDraftKey.value = key
        rateDraft.value = fenToInput(dailyRateFen ?? options.worker.value?.defaultDailyRateFen ?? 0)
        rateError.value = ''
      }
      if (overtimeDraftKey.value !== key || (!pendingOvertime.has(key) && !savingOvertime.has(key))) {
        overtimeDraftKey.value = key
        overtimeDraft.value = overtimePercentToInput(overtimePayPercent ?? 100)
        overtimeError.value = ''
      }
      if (noteDraftKey.value !== key || (!pendingNotes.has(key) && !savingNotes.has(key))) {
        noteDraftKey.value = key
        noteDraft.value = note
      }
    },
    { immediate: true },
  )

  watch([() => options.worker.value?.id ?? null, options.month], ([workerId, month], [previousWorkerId, previousMonth]) => {
    if (!previousWorkerId) return
    const previousKey = monthlyDraftKey(previousWorkerId, previousMonth)
    if (previousKey === (workerId ? monthlyDraftKey(workerId, month) : '')) return
    void flushRate(previousKey)
    void flushOvertime(previousKey)
    void flushNote(previousKey)
  })

  function scheduleRate(value: string): void {
    const worker = options.worker.value
    if (!worker || worker.archivedAt) return
    const key = monthlyDraftKey(worker.id, options.month.value)
    rateDraftKey.value = key
    rateDraft.value = value
    const previous = pendingRates.get(key)
    if (previous) clearTimeout(previous.timer)
    pendingRates.delete(key)
    const fen = parseYuanToFen(value)
    if (fen === null) {
      rateError.value = '请输入正确的日薪金额。'
      return
    }
    rateError.value = ''
    if (fen === options.dailyRateFen.value) return
    if (options.confirmRateChange && !options.confirmRateChange(worker.id, options.month.value)) {
      rateDraft.value = fenToInput(options.dailyRateFen.value ?? worker.defaultDailyRateFen)
      return
    }
    pendingRates.set(key, {
      workerId: worker.id,
      month: options.month.value,
      fen,
      timer: setTimeout(() => void flushRate(key), delayMs),
    })
  }

  async function flushRate(key?: string): Promise<void> {
    const targets = key
      ? [...(pendingRates.has(key) ? [[key, pendingRates.get(key)!] as const] : [])]
      : [...pendingRates.entries()]
    for (const [pendingKey, pending] of targets) {
      clearTimeout(pending.timer)
      pendingRates.delete(pendingKey)
      const saving = options.saveRate(pending.workerId, pending.month, pending.fen).finally(() => {
        if (savingRates.get(pendingKey) === saving) savingRates.delete(pendingKey)
        if (rateDraftKey.value === pendingKey && !pendingRates.has(pendingKey)) {
          rateDraft.value = fenToInput(options.dailyRateFen.value ?? pending.fen)
        }
      })
      savingRates.set(pendingKey, saving)
    }
    await Promise.all(targets.map(([pendingKey]) => savingRates.get(pendingKey)).filter(Boolean))
  }

  function scheduleOvertime(value: string): void {
    const worker = options.worker.value
    if (!worker || worker.archivedAt) return
    const key = monthlyDraftKey(worker.id, options.month.value)
    overtimeDraftKey.value = key
    overtimeDraft.value = value
    const previous = pendingOvertime.get(key)
    if (previous) clearTimeout(previous.timer)
    pendingOvertime.delete(key)
    const percent = parseOvertimeMultiplier(value)
    if (percent === null) {
      overtimeError.value = '请输入 0–10 之间、最多两位小数的倍率。'
      return
    }
    overtimeError.value = ''
    if (percent === options.overtimePayPercent.value) return
    if (options.confirmOvertimeChange && !options.confirmOvertimeChange(worker.id, options.month.value)) {
      overtimeDraft.value = overtimePercentToInput(options.overtimePayPercent.value ?? 100)
      return
    }
    pendingOvertime.set(key, {
      workerId: worker.id,
      month: options.month.value,
      percent,
      timer: setTimeout(() => void flushOvertime(key), delayMs),
    })
  }

  async function flushOvertime(key?: string): Promise<void> {
    const targets = key
      ? [...(pendingOvertime.has(key) ? [[key, pendingOvertime.get(key)!] as const] : [])]
      : [...pendingOvertime.entries()]
    for (const [pendingKey, pending] of targets) {
      clearTimeout(pending.timer)
      pendingOvertime.delete(pendingKey)
      const saving = options.saveOvertimePercent(pending.workerId, pending.month, pending.percent).finally(() => {
        if (savingOvertime.get(pendingKey) === saving) savingOvertime.delete(pendingKey)
        if (overtimeDraftKey.value === pendingKey && !pendingOvertime.has(pendingKey)) {
          overtimeDraft.value = overtimePercentToInput(options.overtimePayPercent.value ?? pending.percent)
        }
      })
      savingOvertime.set(pendingKey, saving)
    }
    await Promise.all(targets.map(([pendingKey]) => savingOvertime.get(pendingKey)).filter(Boolean))
  }

  function scheduleNote(note: string): void {
    const worker = options.worker.value
    if (!worker || worker.archivedAt) return
    const key = monthlyDraftKey(worker.id, options.month.value)
    noteDraftKey.value = key
    noteDraft.value = note
    const previous = pendingNotes.get(key)
    if (previous) clearTimeout(previous.timer)
    pendingNotes.delete(key)
    if (note === options.monthlyNote.value) return
    pendingNotes.set(key, {
      workerId: worker.id,
      month: options.month.value,
      note,
      timer: setTimeout(() => void flushNote(key), delayMs),
    })
  }

  async function flushNote(key?: string): Promise<void> {
    const targets = key
      ? [...(pendingNotes.has(key) ? [[key, pendingNotes.get(key)!] as const] : [])]
      : [...pendingNotes.entries()]
    for (const [pendingKey, pending] of targets) {
      clearTimeout(pending.timer)
      pendingNotes.delete(pendingKey)
      const saving = options.saveNote(pending.workerId, pending.month, pending.note).finally(() => {
        if (savingNotes.get(pendingKey) === saving) savingNotes.delete(pendingKey)
      })
      savingNotes.set(pendingKey, saving)
    }
    await Promise.all(targets.map(([pendingKey]) => savingNotes.get(pendingKey)).filter(Boolean))
  }

  async function flushAll(): Promise<void> {
    while (true) {
      await Promise.all([flushRate(), flushOvertime(), flushNote()])
      const observed = [
        ...savingRates.values(),
        ...savingOvertime.values(),
        ...savingNotes.values(),
      ]
      if (observed.length) await Promise.all(observed)
      if (
        pendingRates.size === 0
        && pendingOvertime.size === 0
        && pendingNotes.size === 0
        && savingRates.size === 0
        && savingOvertime.size === 0
        && savingNotes.size === 0
      ) return
    }
  }

  function discard(): void {
    for (const pending of pendingRates.values()) clearTimeout(pending.timer)
    for (const pending of pendingOvertime.values()) clearTimeout(pending.timer)
    for (const pending of pendingNotes.values()) clearTimeout(pending.timer)
    pendingRates.clear()
    pendingOvertime.clear()
    pendingNotes.clear()
  }

  async function dispose(): Promise<void> {
    await flushAll()
    discard()
  }

  return {
    rateDraft,
    rateError,
    overtimeDraft,
    overtimeError,
    noteDraft,
    scheduleRate,
    flushRate,
    scheduleOvertime,
    flushOvertime,
    scheduleNote,
    flushNote,
    flushAll,
    discard,
    dispose,
  }
}
