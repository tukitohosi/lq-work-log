import type { WeekStartsOn } from './types'

export interface MonthCell {
  iso: string | null
  day: number | null
  isToday: boolean
  isFuture: boolean
  isWeekend: boolean
}

export interface MonthWeek {
  key: string
  days: MonthCell[]
}

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'] as const

export function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function monthLabel(month: string): string {
  const [year, monthNumber] = parseMonth(month)
  return `${year}年${monthNumber}月`
}

export function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = parseMonth(month)
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function weekdayLabels(weekStartsOn: WeekStartsOn): string[] {
  return Array.from({ length: 7 }, (_, index) => WEEKDAY_NAMES[(weekStartsOn + index) % 7])
}

export function monthWeeks(month: string, weekStartsOn: WeekStartsOn, today = todayIso()): MonthWeek[] {
  const [year, monthNumber] = parseMonth(month)
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay()
  const leading = (firstWeekday - weekStartsOn + 7) % 7
  const cellCount = Math.ceil((leading + daysInMonth) / 7) * 7
  const cells: MonthCell[] = Array.from({ length: cellCount }, (_, index) => {
    const day = index - leading + 1
    if (day < 1 || day > daysInMonth) {
      return { iso: null, day: null, isToday: false, isFuture: false, isWeekend: false }
    }
    const iso = `${year}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const weekday = new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay()
    return { iso, day, isToday: iso === today, isFuture: iso > today, isWeekend: weekday === 0 || weekday === 6 }
  })

  return Array.from({ length: cellCount / 7 }, (_, index) => ({
    key: `${month}-week-${index + 1}`,
    days: cells.slice(index * 7, index * 7 + 7),
  }))
}

export function isValidMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function isFutureIsoDate(value: string, today = todayIso()): boolean {
  return isValidIsoDate(value) && value > today
}

function parseMonth(month: string): [number, number] {
  if (!isValidMonth(month)) throw new Error(`无效月份：${month}`)
  const [year, monthNumber] = month.split('-').map(Number)
  return [year, monthNumber]
}
