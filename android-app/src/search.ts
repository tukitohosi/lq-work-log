import type { AppData, PayAdjustmentKind, Worker } from './types'

export type GlobalSearchResultKind = 'worker' | 'day-note' | 'monthly-note' | 'adjustment'

export interface GlobalSearchResult {
  id: string
  kind: GlobalSearchResultKind
  title: string
  snippet: string
  workerId: string
  month: string | null
  date: string | null
  archived: boolean
}

interface SearchCandidate extends GlobalSearchResult {
  searchableText: string
  order: number
}

const KIND_ORDER: Record<GlobalSearchResultKind, number> = {
  worker: 0,
  'day-note': 1,
  'monthly-note': 2,
  adjustment: 3,
}

/**
 * Searches all user-entered text that can be navigated to from the app.
 * IDs are derived from persistent record keys and remain stable across searches.
 */
export function searchAppData(data: AppData, query: string): GlobalSearchResult[] {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return []

  const tokens = normalizedQuery.split(' ').filter(Boolean)
  const workers = new Map(data.workers.map((worker) => [worker.id, worker]))
  const candidates: SearchCandidate[] = []
  let order = 0

  for (const worker of data.workers) {
    const note = worker.note.trim()
    candidates.push({
      id: `worker:${worker.id}`,
      kind: 'worker',
      title: worker.name,
      snippet: note || '工人资料',
      workerId: worker.id,
      month: null,
      date: null,
      archived: isArchived(worker),
      searchableText: joinSearchText(worker.name, note, worker.archivedAt ? '已归档' : ''),
      order: order++,
    })
  }

  for (const entry of data.attendance) {
    const note = entry.dayNote.trim()
    if (!note) continue
    const worker = workers.get(entry.workerId)
    if (!worker) continue
    candidates.push({
      id: `day-note:${entry.workerId}:${entry.date}`,
      kind: 'day-note',
      title: `${worker.name} · ${entry.date} 日备注`,
      snippet: note,
      workerId: worker.id,
      month: entry.date.slice(0, 7),
      date: entry.date,
      archived: isArchived(worker),
      searchableText: joinSearchText(worker.name, entry.date, '日备注', note),
      order: order++,
    })
  }

  for (const record of data.monthlyRecords) {
    const note = record.note.trim()
    if (!note) continue
    const worker = workers.get(record.workerId)
    if (!worker) continue
    candidates.push({
      id: `monthly-note:${record.workerId}:${record.month}`,
      kind: 'monthly-note',
      title: `${worker.name} · ${formatMonth(record.month)}备注`,
      snippet: note,
      workerId: worker.id,
      month: record.month,
      date: null,
      archived: isArchived(worker),
      searchableText: joinSearchText(worker.name, record.month, '月备注', note),
      order: order++,
    })
  }

  for (const adjustment of data.payAdjustments) {
    const worker = workers.get(adjustment.workerId)
    if (!worker) continue
    const kindLabel = adjustmentKindLabel(adjustment.kind)
    const label = adjustment.label.trim()
    const note = adjustment.note.trim()
    candidates.push({
      id: `adjustment:${adjustment.id}`,
      kind: 'adjustment',
      title: `${worker.name} · ${kindLabel}${label ? `：${label}` : ''}`,
      snippet: note || label || kindLabel,
      workerId: worker.id,
      month: adjustment.month,
      date: adjustment.date,
      archived: isArchived(worker),
      searchableText: joinSearchText(
        worker.name,
        adjustment.month,
        adjustment.date ?? '',
        kindLabel,
        label,
        note,
      ),
      order: order++,
    })
  }

  return candidates
    .filter((candidate) => matchesAllTokens(candidate.searchableText, tokens))
    .sort((left, right) => {
      const leftScore = matchScore(left, normalizedQuery)
      const rightScore = matchScore(right, normalizedQuery)
      return rightScore - leftScore
        || KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
        || left.order - right.order
    })
    .map(({ searchableText: _searchableText, order: _order, ...result }) => result)
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/gu, ' ')
    .trim()
}

function joinSearchText(...values: string[]): string {
  return normalizeSearchText(values.join(' '))
}

function matchesAllTokens(haystack: string, tokens: readonly string[]): boolean {
  return tokens.every((token) => haystack.includes(token))
}

function matchScore(candidate: SearchCandidate, normalizedQuery: string): number {
  const normalizedTitle = normalizeSearchText(candidate.title)
  const normalizedSnippet = normalizeSearchText(candidate.snippet)
  if (normalizedTitle === normalizedQuery) return 4
  if (normalizedTitle.startsWith(normalizedQuery)) return 3
  if (normalizedSnippet.startsWith(normalizedQuery)) return 2
  return 1
}

function isArchived(worker: Worker): boolean {
  return worker.archivedAt !== null
}

function adjustmentKindLabel(kind: PayAdjustmentKind): string {
  return kind === 'allowance' ? '补贴' : '扣款'
}

function formatMonth(month: string): string {
  const [year, number] = month.split('-')
  const monthNumber = Number(number)
  return Number.isInteger(monthNumber) && monthNumber >= 1 && monthNumber <= 12
    ? `${year}年${monthNumber}月`
    : month
}
