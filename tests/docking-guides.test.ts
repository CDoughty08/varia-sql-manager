import { describe, expect, it } from 'vitest'
import { contains, guideCells, landingRect } from '../src/renderer/src/docking-guides'

describe('SSMS docking guide geometry', () => {
  it('has a center tab target, four local splits, and four whole-workspace targets', () => {
    const cells = guideCells({ x: 250, y: 100, width: 800, height: 600 })
    expect(cells).toHaveLength(9)
    expect(cells.filter(cell => cell.edge)).toHaveLength(4)
    const center = cells.find(cell => cell.position === 'center')!
    expect(contains(center, 650, 400)).toBe(true)
    expect(contains(center, 690, 400)).toBe(false)
    const right = cells.find(cell => !cell.edge && cell.position === 'right')!
    expect(contains(right, 686, 400)).toBe(true)
  })
  it('fits guides inside small panels and previews the selected half or full tab group', () => {
    const rect = { x: 50, y: 80, width: 200, height: 100 }
    for (const cell of guideCells(rect)) { expect(contains(rect, cell.x, cell.y)).toBe(true); expect(contains(rect, cell.x + cell.width, cell.y + cell.height)).toBe(true) }
    expect(landingRect(rect, 'right')).toEqual({ x: 150, y: 80, width: 100, height: 100 })
    expect(landingRect(rect, 'bottom')).toEqual({ x: 50, y: 130, width: 200, height: 50 })
    expect(landingRect(rect, 'center')).toEqual(rect)
  })
})
