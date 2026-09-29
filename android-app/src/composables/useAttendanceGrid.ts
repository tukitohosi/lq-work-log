import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import { nextAttendanceValue, periodSiteField } from '../attendance'
import {
  gridNavigationTarget,
  regionCellsBetween,
  type GridCellRef,
  type GridDirection,
} from '../grid'
import type { AttendancePatch, AttendanceValue } from '../types'

export type InteractionMode = 'single' | 'path' | 'region'

export interface PathCommitPayload {
  before: AttendancePatch[]
  after: AttendancePatch[]
  current: GridCellRef
  affectedCellKeys: ReadonlySet<string>
}

export interface PathDragSession {
  kind: 'path'
  pointerId: number
  start: GridCellRef
  current: GridCellRef
  brush: AttendanceValue
  active: boolean
  before: Map<string, AttendancePatch>
  after: Map<string, AttendancePatch>
  previewCells: Set<string>
}

export interface RegionDragSession {
  kind: 'region'
  pointerId: number
  start: GridCellRef
  current: GridCellRef
  active: boolean
  selectedCells: GridCellRef[]
}

export type AttendanceDragSession = PathDragSession | RegionDragSession

export interface RegionSelection {
  cells: GridCellRef[]
  end: GridCellRef | null
}

export interface AttendanceGridOptions {
  /**
   * Keeps DOM work outside this state composable. The renderer can inject a
   * callback that focuses the button represented by `cell` after Vue renders.
   */
  focusCell?: (cell: GridCellRef) => void
  canInteract?: () => boolean
  getCellValue?: (cell: GridCellRef) => AttendanceValue
  canPaintPath?: (cell: GridCellRef) => boolean
  snapshotDate?: (cell: GridCellRef) => AttendancePatch
  applyPathValue?: (cell: GridCellRef, value: AttendanceValue) => AttendancePatch
  rollbackPath?: (patches: readonly AttendancePatch[]) => void
  onPathCommit?: (payload: PathCommitPayload) => void
  cellFromPoint?: (clientX: number, clientY: number) => GridCellRef | null
  cellFromEventTarget?: (target: EventTarget | null) => GridCellRef | null
}

export interface SetGridCursorOptions {
  focus?: boolean
}

/** Selects the keyboard starting point without depending on document.activeElement. */
export function selectShortcutGridTarget(
  focused: GridCellRef | null | undefined,
  hovered: GridCellRef | null | undefined,
): GridCellRef | null {
  return focused ?? hovered ?? null
}

function currentCell(
  cells: readonly GridCellRef[],
  candidate: GridCellRef | null,
): GridCellRef | null {
  if (!candidate) return null
  return cells.find((cell) => cell.key === candidate.key) ?? null
}

/**
 * Owns the lightweight keyboard/hover state for the monthly attendance grid.
 * A focused cursor always wins over a hover-only starting point.
 */
export function useAttendanceGrid(
  cells: Readonly<Ref<readonly GridCellRef[]>>,
  options: AttendanceGridOptions = {},
) {
  const cursor = shallowRef<GridCellRef | null>(null)
  const hovered = shallowRef<GridCellRef | null>(null)
  const interactionMode = ref<InteractionMode>('single')
  const dragSession = shallowRef<AttendanceDragSession | null>(null)
  const pendingRegionCells = shallowRef<GridCellRef[]>([])
  const pendingRegionEnd = shallowRef<GridCellRef | null>(null)
  const suppressNextClick = ref(false)
  const lastPointerPosition = shallowRef<{ x: number; y: number } | null>(null)
  let suppressedClickTimer: ReturnType<typeof setTimeout> | null = null

  const shortcutTarget = computed(() => selectShortcutGridTarget(cursor.value, hovered.value))
  const pendingRegionHasOrdinaryCells = computed(
    () => pendingRegionCells.value.some((cell) => cell.period !== 'overtime'),
  )
  const regionDescription = computed(() => {
    if (!pendingRegionCells.value.length) return ''
    const dates = new Set(pendingRegionCells.value.map((cell) => cell.date))
    return `已圈选 ${pendingRegionCells.value.length} 个格子，覆盖 ${dates.size} 天。`
  })
  const interactionTableClasses = computed<Record<string, boolean>>(() => ({
    'is-painting': Boolean(dragSession.value),
    'is-path-painting': dragSession.value?.kind === 'path',
    'is-region-selecting': dragSession.value?.kind === 'region',
  }))

  function setCursor(cell: GridCellRef | null, setOptions: SetGridCursorOptions = {}): void {
    cursor.value = currentCell(cells.value, cell)
    if (setOptions.focus && cursor.value) options.focusCell?.(cursor.value)
  }

  function clearCursor(): void {
    cursor.value = null
  }

  function setHovered(cell: GridCellRef | null): void {
    hovered.value = currentCell(cells.value, cell)
  }

  function clearHovered(): void {
    hovered.value = null
  }

  function clear(): void {
    clearCursor()
    clearHovered()
  }

  function isPathPreviewCell(key: string): boolean {
    return dragSession.value?.kind === 'path' && dragSession.value.previewCells.has(key)
  }

  function isRegionSelectedCell(key: string): boolean {
    if (dragSession.value?.kind === 'region') {
      return dragSession.value.selectedCells.some((cell) => cell.key === key)
    }
    return pendingRegionCells.value.some((cell) => cell.key === key)
  }

  function clearPendingRegion(): void {
    pendingRegionCells.value = []
    pendingRegionEnd.value = null
  }

  function suppressCompatibleClick(): void {
    suppressNextClick.value = true
    if (suppressedClickTimer) clearTimeout(suppressedClickTimer)
    suppressedClickTimer = setTimeout(() => {
      suppressNextClick.value = false
      suppressedClickTimer = null
    }, 400)
  }

  function clearClickSuppression(): void {
    suppressNextClick.value = false
    if (suppressedClickTimer) clearTimeout(suppressedClickTimer)
    suppressedClickTimer = null
  }

  function consumeSuppressedClick(): boolean {
    if (!suppressNextClick.value) return false
    clearClickSuppression()
    return true
  }

  function rollbackPathSession(session: PathDragSession): void {
    options.rollbackPath?.([...session.before.values()])
  }

  function abortPathSession(session: PathDragSession): void {
    rollbackPathSession(session)
    session.before.clear()
    session.after.clear()
    session.previewCells.clear()
    if (dragSession.value === session) dragSession.value = null
    lastPointerPosition.value = null
  }

  function paintPathCell(session: PathDragSession, cell: GridCellRef): boolean {
    if (cell.workerId !== session.start.workerId) return false
    if ((session.start.period === 'overtime') !== (cell.period === 'overtime')) return false
    if (options.canPaintPath?.(cell) === false) {
      abortPathSession(session)
      return false
    }
    if (!options.snapshotDate || !options.applyPathValue) return false
    const dateKey = `${cell.workerId}\u0000${cell.date}`
    if (!session.before.has(dateKey)) session.before.set(dateKey, options.snapshotDate(cell))
    session.after.set(dateKey, options.applyPathValue(cell, session.brush))
    session.previewCells.add(cell.key)
    return true
  }

  function cancelDrag(): void {
    const session = dragSession.value
    if (session?.kind === 'path') rollbackPathSession(session)
    dragSession.value = null
    lastPointerPosition.value = null
  }

  function cancelInteraction(clearGridCursor = false): void {
    cancelDrag()
    clearPendingRegion()
    clearClickSuppression()
    if (clearGridCursor) clear()
  }

  function setInteractionMode(mode: InteractionMode): void {
    cancelInteraction()
    interactionMode.value = mode
  }

  function beginPointer(event: PointerEvent, cell: GridCellRef): void {
    if (event.button !== 0 || options.canInteract?.() === false) return
    if (dragSession.value && dragSession.value.pointerId !== event.pointerId) return
    setCursor(cell, { focus: true })
    clearClickSuppression()
    lastPointerPosition.value = { x: event.clientX, y: event.clientY }
    if (interactionMode.value === 'single') return
    event.preventDefault()
    if (interactionMode.value === 'path') {
      dragSession.value = {
        kind: 'path',
        pointerId: event.pointerId,
        start: cell,
        current: cell,
        brush: nextAttendanceValue(cell.period, options.getCellValue?.(cell) ?? null),
        active: false,
        before: new Map(),
        after: new Map(),
        previewCells: new Set(),
      }
      return
    }
    clearPendingRegion()
    dragSession.value = {
      kind: 'region',
      pointerId: event.pointerId,
      start: cell,
      current: cell,
      active: false,
      selectedCells: [cell],
    }
  }

  function previewPointer(cell: GridCellRef, event?: PointerEvent): void {
    setHovered(cell)
    const session = dragSession.value
    if (!session || session.start.workerId !== cell.workerId) return
    if (event && event.pointerId !== session.pointerId) return
    if (session.kind === 'path') {
      if ((session.start.period === 'overtime') !== (cell.period === 'overtime')) return
      session.current = cell
      if (!session.active && cell.key !== session.start.key) {
        session.active = true
        paintPathCell(session, session.start)
        if (dragSession.value !== session) return
      }
      if (session.active) paintPathCell(session, cell)
      return
    }
    session.current = cell
    if (cell.key !== session.start.key) session.active = true
    session.selectedCells = regionCellsBetween(cells.value, session.start, cell)
  }

  function trackPointer(event: PointerEvent): void {
    const session = dragSession.value
    if (!session || event.pointerId !== session.pointerId || (event.buttons & 1) !== 1) return
    lastPointerPosition.value = { x: event.clientX, y: event.clientY }
    const cell = options.cellFromPoint?.(event.clientX, event.clientY)
    if (cell) previewPointer(cell)
  }

  function finishPointer(event: PointerEvent): void {
    const session = dragSession.value
    if (!session || (event.pointerId !== undefined && event.pointerId !== session.pointerId)) return
    const coordinates = event.clientX || event.clientY
      ? { x: event.clientX, y: event.clientY }
      : lastPointerPosition.value
    const releasedCell = options.cellFromEventTarget?.(event.target)
      ?? (coordinates ? options.cellFromPoint?.(coordinates.x, coordinates.y) : null)
      ?? null
    if (releasedCell) previewPointer(releasedCell, event)
    if (dragSession.value !== session) return
    dragSession.value = null
    lastPointerPosition.value = null
    if (!session.active || !releasedCell) {
      if (session.kind === 'path') rollbackPathSession(session)
      return
    }
    suppressCompatibleClick()
    setCursor(session.current)
    if (session.kind === 'region') {
      pendingRegionCells.value = session.selectedCells
      pendingRegionEnd.value = session.current
      return
    }
    const before = [...session.before.values()]
    const beforeByDate = new Map(before.map((patch) => [`${patch.workerId}\u0000${patch.date}`, patch]))
    const after = [...session.after.values()].filter((patch) => {
      const old = beforeByDate.get(`${patch.workerId}\u0000${patch.date}`)
      return JSON.stringify(old) !== JSON.stringify(patch)
    })
    if (!after.length) return
    const changedBefore = after
      .map((patch) => beforeByDate.get(`${patch.workerId}\u0000${patch.date}`))
      .filter((patch): patch is AttendancePatch => Boolean(patch))
    const afterByDate = new Map(after.map((patch) => [`${patch.workerId}\u0000${patch.date}`, patch]))
    const affectedCellKeys = new Set<string>()
    for (const cell of cells.value) {
      if (!session.previewCells.has(cell.key)) continue
      const key = `${cell.workerId}\u0000${cell.date}`
      const old = beforeByDate.get(key)
      const latest = afterByDate.get(key)
      const siteField = periodSiteField(cell.period)
      if (old && latest && (old[cell.period] !== latest[cell.period] || old[siteField] !== latest[siteField])) {
        affectedCellKeys.add(cell.key)
      }
    }
    options.onPathCommit?.({
      before: changedBefore,
      after,
      current: session.current,
      affectedCellKeys,
    })
    setCursor(session.current, { focus: true })
  }

  function takeRegionSelection(): RegionSelection {
    const selection = { cells: [...pendingRegionCells.value], end: pendingRegionEnd.value }
    clearPendingRegion()
    clearClickSuppression()
    return selection
  }

  function move(
    direction: GridDirection,
    setOptions: SetGridCursorOptions = { focus: true },
  ): GridCellRef | null {
    const source = shortcutTarget.value
    if (!source) return null
    const target = gridNavigationTarget(cells.value, source, direction) ?? null
    if (!target) return null
    setCursor(target, setOptions)
    return target
  }

  // Month/worker changes replace the cell array. Refresh matching objects and
  // discard pointers that no longer belong to the rendered grid.
  watch(cells, (nextCells) => {
    cursor.value = currentCell(nextCells, cursor.value)
    hovered.value = currentCell(nextCells, hovered.value)
  }, { flush: 'sync' })

  function dispose(): void {
    if (suppressedClickTimer) clearTimeout(suppressedClickTimer)
    suppressedClickTimer = null
  }

  return {
    cursor,
    hovered,
    shortcutTarget,
    interactionMode,
    dragSession,
    pendingRegionCells,
    pendingRegionEnd,
    pendingRegionHasOrdinaryCells,
    regionDescription,
    interactionTableClasses,
    setCursor,
    clearCursor,
    setHovered,
    clearHovered,
    clear,
    isPathPreviewCell,
    isRegionSelectedCell,
    clearPendingRegion,
    clearClickSuppression,
    consumeSuppressedClick,
    cancelDrag,
    cancelInteraction,
    setInteractionMode,
    beginPointer,
    previewPointer,
    trackPointer,
    finishPointer,
    takeRegionSelection,
    move,
    dispose,
  }
}
