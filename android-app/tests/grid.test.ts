import { describe, expect, it } from 'vitest'
import {
  gridNavigationTarget,
  makeGridCell,
  regionActionPatches,
  regionCellsBetween,
  type GridCellRef,
} from '../src/grid'

function fixture(): GridCellRef[] {
  const cells: GridCellRef[] = []
  for (let week = 0; week < 2; week += 1) {
    for (const [periodIndex, period] of (['morning', 'afternoon', 'overtime'] as const).entries()) {
      for (let col = 0; col < 7; col += 1) {
        const day = week * 7 + col + 1
        cells.push(makeGridCell('worker', `2026-08-${String(day).padStart(2, '0')}`, period, week * 3 + periodIndex, col))
      }
    }
  }
  return cells
}

describe('attendance grid pure logic', () => {
  it('moves vertically through visual rows and crosses into the next week', () => {
    const cells = fixture()
    const morning = cells.find((cell) => cell.date === '2026-08-03' && cell.period === 'morning')!
    const afternoon = gridNavigationTarget(cells, morning, 'ArrowDown')!
    const overtime = gridNavigationTarget(cells, afternoon, 'ArrowDown')!
    const nextWeekMorning = gridNavigationTarget(cells, overtime, 'ArrowDown')!

    expect(afternoon).toMatchObject({ date: '2026-08-03', period: 'afternoon' })
    expect(overtime).toMatchObject({ date: '2026-08-03', period: 'overtime' })
    expect(nextWeekMorning).toMatchObject({ date: '2026-08-10', period: 'morning' })
    expect(gridNavigationTarget(cells, nextWeekMorning, 'ArrowUp')).toEqual(overtime)
  })

  it('keeps horizontal movement on adjacent dates in the same period', () => {
    const cells = fixture()
    const source = cells.find((cell) => cell.date === '2026-08-07' && cell.period === 'afternoon')!
    expect(gridNavigationTarget(cells, source, 'ArrowRight')).toMatchObject({
      date: '2026-08-08',
      period: 'afternoon',
    })
  })

  it('stops at visual gaps instead of skipping them', () => {
    const cells = fixture().filter((cell) => !(cell.row === 3 && cell.col === 2))
    const source = cells.find((cell) => cell.row === 2 && cell.col === 2)!
    expect(gridNavigationTarget(cells, source, 'ArrowDown')).toBeUndefined()
  })

  it('selects reverse rectangles for one worker only', () => {
    const cells = fixture()
    const start = cells.find((cell) => cell.row === 2 && cell.col === 3)!
    const end = cells.find((cell) => cell.row === 0 && cell.col === 2)!
    expect(regionCellsBetween(cells, start, end)).toHaveLength(6)
    expect(regionCellsBetween(cells, start, { ...end, workerId: 'other' })).toEqual([])
  })

  it('keeps overtime for full and clears it for rest', () => {
    const cells = fixture().filter((cell) => cell.date === '2026-08-01')
    expect(regionActionPatches('full', cells)).toEqual([
      expect.objectContaining({ morning: 'present' }),
      expect.objectContaining({ afternoon: 'present' }),
    ])
    expect(regionActionPatches('grind', cells)).toEqual(expect.arrayContaining([
      expect.objectContaining({ morning: 'present' }),
      expect.objectContaining({ afternoon: 'present' }),
      expect.objectContaining({ overtime: 'half' }),
    ]))
    expect(regionActionPatches('rest', cells)).toEqual(expect.arrayContaining([
      expect.objectContaining({ morning: 'absent' }),
      expect.objectContaining({ afternoon: 'absent' }),
      expect.objectContaining({ overtime: null }),
    ]))
    expect(regionActionPatches('rest', cells.filter((cell) => cell.period === 'overtime'))).toEqual([
      expect.objectContaining({ overtime: null }),
    ])
  })
})
