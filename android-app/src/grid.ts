import type { AttendancePatch, AttendancePeriod } from './types'

export type GridDirection = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
export type RegionAction = 'full' | 'rest' | 'grind'

export interface GridCellRef {
  workerId: string
  date: string
  period: AttendancePeriod
  row: number
  col: number
  key: string
}

export function gridCellKey(workerId: string, date: string, period: AttendancePeriod): string {
  return `${workerId}|${date}|${period}`
}

export function makeGridCell(
  workerId: string,
  date: string,
  period: AttendancePeriod,
  row: number,
  col: number,
): GridCellRef {
  return { workerId, date, period, row, col, key: gridCellKey(workerId, date, period) }
}

export function regionCellsBetween(
  cells: readonly GridCellRef[],
  start: GridCellRef,
  end: GridCellRef,
): GridCellRef[] {
  if (start.workerId !== end.workerId) return []
  const minRow = Math.min(start.row, end.row)
  const maxRow = Math.max(start.row, end.row)
  const minCol = Math.min(start.col, end.col)
  const maxCol = Math.max(start.col, end.col)
  return cells.filter(
    (cell) =>
      cell.workerId === start.workerId &&
      cell.row >= minRow &&
      cell.row <= maxRow &&
      cell.col >= minCol &&
      cell.col <= maxCol,
  )
}

export function gridNavigationTarget(
  cells: readonly GridCellRef[],
  cursor: GridCellRef,
  direction: GridDirection,
): GridCellRef | undefined {
  if (direction === 'ArrowUp' || direction === 'ArrowDown') {
    const row = cursor.row + (direction === 'ArrowUp' ? -1 : 1)
    return cells.find(
      (cell) => cell.workerId === cursor.workerId && cell.row === row && cell.col === cursor.col,
    )
  }

  const dates = [...new Set(
    cells.filter((cell) => cell.workerId === cursor.workerId).map((cell) => cell.date),
  )].sort()
  const dateIndex = dates.indexOf(cursor.date)
  const targetDate = dates[dateIndex + (direction === 'ArrowLeft' ? -1 : 1)]
  if (!targetDate) return undefined
  return cells.find(
    (cell) =>
      cell.workerId === cursor.workerId &&
      cell.date === targetDate &&
      cell.period === cursor.period,
  )
}

export function regionActionPatches(action: RegionAction, cells: readonly GridCellRef[]): AttendancePatch[] {
  const patches: AttendancePatch[] = []
  for (const cell of cells) {
    if (action === 'full' && cell.period !== 'overtime') {
      patches.push({ workerId: cell.workerId, date: cell.date, [cell.period]: 'present' })
    } else if (action === 'rest') {
      patches.push({
        workerId: cell.workerId,
        date: cell.date,
        [cell.period]: cell.period === 'overtime' ? null : 'absent',
      })
    } else if (action === 'grind') {
      patches.push({
        workerId: cell.workerId,
        date: cell.date,
        [cell.period]: cell.period === 'overtime' ? 'half' : 'present',
      })
    }
  }
  return patches
}
