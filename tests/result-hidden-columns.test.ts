import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ResultColumn } from '../src/shared/contracts'
import { backendDescriptorSchema } from '../src/shared/ipc/descriptors'
import { GridData } from '../src/renderer/src/grid/data'
import { diffGutter } from '../src/renderer/src/grid/diff-gutter'
import { diffSuffixOf, hiddenRoles, isHiddenColumn, visibleColumnCount } from '../src/renderer/src/grid/hidden-columns'
import { tileColumnOf, tileRowOf } from '../src/renderer/src/grid/tiles'
import { diffSidesOf } from '../src/renderer/src/grid/ResultGrid'

// A comparison's marker, row numbers and tone are a hidden suffix (docs/result-comparison-ux-plan.md, D6): one predicate
// says which columns are not data, and a new `role === 'tone'` test elsewhere would treat the suffix as data again.
const walk = (root: string, pattern: RegExp): string[] => readdirSync(root).flatMap(name => {
  const path = join(root, name).replaceAll('\\', '/')
  if (name === 'bin' || name === 'obj' || name === 'node_modules') return []
  return statSync(path).isDirectory() ? walk(path, pattern) : pattern.test(name) ? [path] : []
})
const toneTest = /\brole\s*[!=]==\s*['"]tone['"]|\bRole\s*[!=]=\s*"tone"/
// The grid's tone reader (toneColumnOf) and the live readers, whose tables have only the tone hidden.
const allowed = ['src/renderer/src/grid/GridView.ts', 'src/renderer/src/live/LiveGrid.ts', 'src/shared/live/docs.ts', 'src/shared/live/schema.ts', 'backend/Varia.Backend/Live/LiveCatalog.cs']
const column = (name: string, role?: ResultColumn['role']): ResultColumn => ({ name, dataType: 'nvarchar', wire: 'text', nullable: true, ...role ? { role } : {} })
const diffColumns = [column('Id'), column('Name'), column('Change', 'mark'), column('Old row', 'leftRow'), column('New row', 'rightRow'), column('', 'tone')]

describe('hidden result columns', () => {
  it('tests a tone role only in the tone reader and the live readers', () => {
    const files = [...walk('src', /\.(ts|tsx)$/), ...walk('backend/Varia.Backend', /\.cs$/)]
    const offenders = files.filter(file => !allowed.includes(file)).flatMap(file => readFileSync(file, 'utf8').split('\n').flatMap((line, at) => toneTest.test(line) ? [`${file}:${at + 1}`] : []))
    expect(offenders).toEqual([])
    // The allow-list stays honest: each entry still reads a tone.
    for (const file of allowed) expect(toneTest.test(readFileSync(file, 'utf8')), file).toBe(true)
  })
  it('uses toneColumnOf only to read the tone, never as a hidden-column test', () => {
    const offenders = walk('src', /\.(ts|tsx)$/).filter(file => file !== 'src/renderer/src/grid/GridView.ts' && /\btoneColumnOf\b/.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })
  it('hides exactly the tone and a comparison\'s suffix roles; documents, UDTs and vectors are data', () => {
    expect([...hiddenRoles].sort()).toEqual(['leftRow', 'mark', 'old', 'rightRow', 'tone'])
    for (const role of ['old', 'mark', 'leftRow', 'rightRow', 'tone'] as const) expect(isHiddenColumn(column('c', role)), role).toBe(true)
    for (const role of ['xml', 'json', 'plan', 'udt', 'vector', undefined] as const) expect(isHiddenColumn(column('c', role)), String(role)).toBe(false)
    expect(isHiddenColumn(undefined)).toBe(false)
  })
  it('counts the visible columns up to the hidden suffix', () => {
    expect(visibleColumnCount({ columns: diffColumns })).toBe(2)
    expect(visibleColumnCount({ columns: [column('a'), column('b'), column('tone', 'tone')] })).toBe(2)
    expect(visibleColumnCount({ columns: [column('a'), column('doc', 'xml'), column('v', 'vector')] })).toBe(3)
    // Only a suffix is hidden; a result of hidden columns alone shows them rather than nothing.
    expect(visibleColumnCount({ columns: [column('t', 'tone')] })).toBe(1)
  })
  it('finds a comparison\'s suffix by role, and none on another kind', () => {
    expect(diffSuffixOf({ kind: 'diff', columns: diffColumns })).toEqual({ mark: 2, leftRow: 3, rightRow: 4, tone: 5 })
    expect(diffSuffixOf({ kind: 'rows', columns: diffColumns })).toBeUndefined()
    expect(diffSuffixOf({ kind: 'diff', columns: [column('a'), column('', 'tone')] })).toBeUndefined()
  })
  it('accepts the hidden roles and a previous value\'s pair in the strict descriptor schema', () => {
    const descriptor = (columns: unknown[]) => ({ resultId: 1, index: 0, batchNumber: 1, iteration: 1, kind: 'diff', columns, rowsRead: 0, rowsStored: 0, rowsAvailable: 0, bytesStored: 0, truncatedCells: 0, state: 'complete', incomplete: false })
    expect(backendDescriptorSchema.safeParse(descriptor([...diffColumns, { ...column('Id (old)', 'old'), of: 0 }])).success).toBe(true)
    expect(backendDescriptorSchema.safeParse(descriptor([{ ...column('x'), role: 'gutter' }])).success).toBe(false)
    expect(backendDescriptorSchema.safeParse(descriptor([{ ...column('x', 'old'), of: -1 }])).success).toBe(false)
  })
})

describe('comparison gutter', () => {
  const sides = { old: 'Sample Query', new: 'Awesome Query' }
  it('draws each row\'s mark and its number in its own input, and names both rows', () => {
    expect(diffGutter(' ', '3', '4', sides)).toEqual({ mark: '', number: '4', name: 'Unchanged; row 3 in Sample Query, row 4 in Awesome Query' })
    expect(diffGutter('+', null, '7', sides)).toEqual({ mark: '+', number: '7', name: 'Added; row 7 in Awesome Query' })
    expect(diffGutter('−', '5', null, sides)).toEqual({ mark: '−', number: '5', name: 'Removed; row 5 in Sample Query' })
    // Both halves of a changed entry carry both rows; each draws its own side's.
    expect(diffGutter('−', '2', '9', sides)).toEqual({ mark: '−', number: '2', name: 'Changed, old values; row 2 in Sample Query, row 9 in Awesome Query' })
    expect(diffGutter('+', '2', '9', sides)).toEqual({ mark: '+', number: '9', name: 'Changed, new values; row 2 in Sample Query, row 9 in Awesome Query' })
    expect(diffGutter(' ', '1204', '12000').name).toBe('Unchanged; row 1,204 in the old result, row 12,000 in the new result')
  })
  it('names a comparison\'s inputs as they were compared, and sizes the number for the larger', () => {
    const sets = [{ key: 'a', descriptor: { rowsStored: 12 } }, { key: 'b', descriptor: { rowsStored: 30_000 } }] as never
    expect(diffSidesOf({ left: 'a', right: 'b', leftNumber: 1, rightNumber: 2, leftName: 'Open orders' }, sets)).toEqual({ old: 'Open orders', new: 'Result 2', rows: 30_000 })
    expect(diffSidesOf({ left: 'a', right: 'gone', leftNumber: 1, rightNumber: 2 }, sets).rows).toBe(12)
  })
  it('reads the whole suffix with each row tile, across two tile columns', () => {
    const handle = { getWindow: () => new Promise<never>(() => {}), peekWindow: () => undefined, prefetch: () => {} }
    // 40 data columns, then the marker (40), row numbers and tone (43): the suffix spans tile columns 1 only; at 30 data
    // columns it spans 0 (30, 31) and 1 (32, 33).
    for (const [columns, expected] of [[40, [1]], [30, [0, 1]]] as const) {
      const data = new GridData({ handle, columns, tone: columns + 3, suffix: columns, clientInflight: () => 0, changed: () => {} })
      const plan = data.plan({ firstRow: 0, lastRow: 10, firstColumn: 0, lastColumn: 5 }, 1000)
      expect(plan.filter(key => tileRowOf(key) === 0).map(tileColumnOf).sort(), String(columns)).toEqual([...new Set([0, ...expected])].sort())
    }
  })
  it("reads the active row's suffix with its cell when the row is out of view, so its pinned header names it", () => {
    const reads: [number, number][] = []
    const handle = { getWindow: (first: number, _count: number, o: { colStart: number }) => { reads.push([first, o.colStart]); return new Promise<never>(() => {}) }, peekWindow: () => undefined, prefetch: () => {} }
    const data = new GridData({ handle: handle as never, columns: 40, tone: 43, suffix: 40, clientInflight: () => 0, changed: () => {} })
    data.ensure({ firstRow: 0, lastRow: 10, firstColumn: 0, lastColumn: 5 }, 100_000, 0, 10, { row: 50_000, column: 2 })
    const tileRows = 128
    expect(reads.filter(([first]) => first === Math.floor(50_000 / tileRows) * tileRows).map(([, column]) => column).sort((a, b) => a - b)).toEqual([0, 32])
  })
})
