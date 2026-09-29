import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { makeGridCell, type GridCellRef } from '../src/grid'
import {
  selectShortcutGridTarget,
  useAttendanceGrid,
} from '../src/composables/useAttendanceGrid'
import type { AttendancePatch, AttendanceValue } from '../src/types'

function fixture(): GridCellRef[] {
  const cells: GridCellRef[] = []
  for (let week = 0; week < 2; week += 1) {
    for (const [periodIndex, period] of (['morning', 'afternoon', 'overtime'] as const).entries()) {
      for (let col = 0; col < 7; col += 1) {
        const day = week * 7 + col + 1
        cells.push(makeGridCell(
          'worker-1',
          `2026-08-${String(day).padStart(2, '0')}`,
          period,
          week * 3 + periodIndex,
          col,
        ))
      }
    }
  }
  return cells
}

function findCell(cells: readonly GridCellRef[], date: string, period: GridCellRef['period']): GridCellRef {
  return cells.find((cell) => cell.date === date && cell.period === period)!
}

function pointerEvent(
  pointerId: number,
  overrides: Partial<PointerEvent> = {},
): PointerEvent {
  return {
    pointerId,
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 10,
    target: null,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as PointerEvent
}

function fullPatch(
  cell: GridCellRef,
  ordinary: AttendanceValue = null,
): AttendancePatch {
  return {
    workerId: cell.workerId,
    date: cell.date,
    morning: ordinary === 'present' || ordinary === 'absent' ? ordinary : null,
    afternoon: null,
    overtime: null,
    dayNote: '',
    morningSiteId: null,
    afternoonSiteId: null,
    overtimeSiteId: null,
  }
}

describe('useAttendanceGrid', () => {
  it('selects focused cell before hover and otherwise uses hover as the shortcut target', () => {
    const cells = fixture()
    const focused = findCell(cells, '2026-08-03', 'morning')
    const hovered = findCell(cells, '2026-08-04', 'afternoon')

    expect(selectShortcutGridTarget(focused, hovered)).toBe(focused)
    expect(selectShortcutGridTarget(null, hovered)).toBe(hovered)
    expect(selectShortcutGridTarget(undefined, null)).toBeNull()
  })

  it('uses a hover-only cell as the starting point and delegates DOM focus', () => {
    const cells = ref(fixture())
    const focusCell = vi.fn()
    const grid = useAttendanceGrid(cells, { focusCell })
    grid.setHovered(findCell(cells.value, '2026-08-07', 'afternoon'))

    const target = grid.move('ArrowRight')

    expect(target).toMatchObject({ date: '2026-08-08', period: 'afternoon' })
    expect(grid.cursor.value).toBe(target)
    expect(grid.shortcutTarget.value).toBe(target)
    expect(focusCell).toHaveBeenCalledOnce()
    expect(focusCell).toHaveBeenCalledWith(target)
  })

  it('uses the focused cursor ahead of a different hovered cell and follows visual rows', () => {
    const cells = ref(fixture())
    const grid = useAttendanceGrid(cells)
    grid.setCursor(findCell(cells.value, '2026-08-03', 'overtime'))
    grid.setHovered(findCell(cells.value, '2026-08-05', 'morning'))

    expect(grid.move('ArrowDown', { focus: false })).toMatchObject({
      date: '2026-08-10',
      period: 'morning',
    })
  })

  it('stops at missing visual cells without invoking the focus callback', () => {
    const original = fixture()
    const source = findCell(original, '2026-08-03', 'overtime')
    const cells = ref(original.filter((cell) => !(cell.row === source.row + 1 && cell.col === source.col)))
    const focusCell = vi.fn()
    const grid = useAttendanceGrid(cells, { focusCell })
    grid.setCursor(source)

    expect(grid.move('ArrowDown')).toBeNull()
    expect(grid.cursor.value).toEqual(source)
    expect(focusCell).not.toHaveBeenCalled()
  })

  it('refreshes matching cell objects and clears stale cursor and hover on grid replacement', () => {
    const initial = fixture()
    const cells = ref(initial)
    const grid = useAttendanceGrid(cells)
    const cursor = findCell(initial, '2026-08-03', 'morning')
    const hovered = findCell(initial, '2026-08-04', 'morning')
    grid.setCursor(cursor)
    grid.setHovered(hovered)

    const refreshedCursor = { ...cursor }
    cells.value = [refreshedCursor]
    expect(grid.cursor.value).toEqual(refreshedCursor)
    expect(grid.hovered.value).toBeNull()

    grid.clear()
    expect(grid.cursor.value).toBeNull()
    expect(grid.hovered.value).toBeNull()
  })

  it('owns reverse region drag state and returns a completed selection atomically', () => {
    const cells = ref(fixture())
    const start = cells.value.find((cell) => cell.row === 2 && cell.col === 3)!
    const end = cells.value.find((cell) => cell.row === 0 && cell.col === 2)!
    const grid = useAttendanceGrid(cells, {
      canInteract: () => true,
      cellFromEventTarget: () => end,
    })
    grid.setInteractionMode('region')

    grid.beginPointer(pointerEvent(7), start)
    grid.previewPointer(end, pointerEvent(7))
    expect(grid.dragSession.value?.kind).toBe('region')
    expect(grid.isRegionSelectedCell(end.key)).toBe(true)
    grid.finishPointer(pointerEvent(7))

    expect(grid.pendingRegionCells.value).toHaveLength(6)
    expect(grid.pendingRegionHasOrdinaryCells.value).toBe(true)
    expect(grid.regionDescription.value).toBe('已圈选 6 个格子，覆盖 2 天。')
    expect(grid.interactionTableClasses.value['is-painting']).toBe(false)
    const selection = grid.takeRegionSelection()
    expect(selection.cells).toHaveLength(6)
    expect(selection.end).toMatchObject({ row: 0, col: 2 })
    expect(grid.pendingRegionCells.value).toHaveLength(0)
    expect(grid.consumeSuppressedClick()).toBe(false)
    grid.dispose()
  })

  it('commits only changed path cells and excludes unchanged traversed cells from failure markers', () => {
    const cells = ref(fixture())
    const start = findCell(cells.value, '2026-08-01', 'morning')
    const alreadyPresent = findCell(cells.value, '2026-08-02', 'morning')
    const state = new Map<string, AttendancePatch>([
      [start.date, fullPatch(start)],
      [alreadyPresent.date, fullPatch(alreadyPresent, 'present')],
    ])
    const onPathCommit = vi.fn()
    const grid = useAttendanceGrid(cells, {
      canInteract: () => true,
      getCellValue: (cell) => state.get(cell.date)?.[cell.period] ?? null,
      snapshotDate: (cell) => structuredClone(state.get(cell.date)!),
      applyPathValue: (cell, value) => {
        const next = structuredClone(state.get(cell.date)!)
        ;(next as unknown as Record<string, unknown>)[cell.period] = value
        state.set(cell.date, next)
        return structuredClone(next)
      },
      rollbackPath: (patches) => patches.forEach((patch) => state.set(patch.date, structuredClone(patch))),
      onPathCommit,
      cellFromEventTarget: () => alreadyPresent,
    })
    grid.setInteractionMode('path')

    grid.beginPointer(pointerEvent(8), start)
    grid.previewPointer(alreadyPresent, pointerEvent(8))
    expect(grid.isPathPreviewCell(start.key)).toBe(true)
    expect(grid.isPathPreviewCell(alreadyPresent.key)).toBe(true)
    grid.finishPointer(pointerEvent(8))

    expect(onPathCommit).toHaveBeenCalledOnce()
    const payload = onPathCommit.mock.calls[0][0]
    expect(payload.before).toHaveLength(1)
    expect(payload.after).toHaveLength(1)
    expect([...payload.affectedCellKeys]).toEqual([start.key])
    expect(state.get(start.date)?.morning).toBe('present')
    expect(grid.consumeSuppressedClick()).toBe(true)
    expect(grid.consumeSuppressedClick()).toBe(false)
    grid.dispose()
  })

  it('rolls back the whole active path when a later cell fails its guard', () => {
    const cells = ref(fixture())
    const start = findCell(cells.value, '2026-08-01', 'morning')
    const blocked = findCell(cells.value, '2026-08-02', 'morning')
    const state = new Map<string, AttendancePatch>([
      [start.date, fullPatch(start)],
      [blocked.date, fullPatch(blocked)],
    ])
    const onPathCommit = vi.fn()
    const grid = useAttendanceGrid(cells, {
      canInteract: () => true,
      canPaintPath: (cell) => cell.key !== blocked.key,
      getCellValue: () => null,
      snapshotDate: (cell) => structuredClone(state.get(cell.date)!),
      applyPathValue: (cell, value) => {
        const next = structuredClone(state.get(cell.date)!)
        ;(next as unknown as Record<string, unknown>)[cell.period] = value
        state.set(cell.date, next)
        return structuredClone(next)
      },
      rollbackPath: (patches) => patches.forEach((patch) => state.set(patch.date, structuredClone(patch))),
      onPathCommit,
    })
    grid.setInteractionMode('path')

    grid.beginPointer(pointerEvent(9), start)
    grid.previewPointer(blocked, pointerEvent(9))

    expect(grid.dragSession.value).toBeNull()
    expect(state.get(start.date)?.morning).toBeNull()
    expect(state.get(blocked.date)?.morning).toBeNull()
    expect(onPathCommit).not.toHaveBeenCalled()
    grid.dispose()
  })
})
