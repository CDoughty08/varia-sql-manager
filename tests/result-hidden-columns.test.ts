import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ResultColumn } from '../src/shared/contracts'
import { backendDescriptorSchema } from '../src/shared/ipc/descriptors'
import { GridData } from '../src/renderer/src/grid/data'
import { diffGutter, diffKeyFlags, gapText, toneFlagsOf } from '../src/renderer/src/grid/diff-gutter'
import { diffSuffixOf, hiddenRoles, isHiddenColumn, visibleColumnCount } from '../src/renderer/src/grid/hidden-columns'
import { tileColumnOf, tileRowOf } from '../src/renderer/src/grid/tiles'
import { diffSidesOf } from '../src/renderer/src/grid/ResultGrid'

// A comparison's marker, row numbers and tone are a hidden suffix: one predicate
// says which columns are not data, and a new `role === 'tone'` test elsewhere would treat the suffix as data again.
const walk = (root: string, pattern: RegExp): string[] => readdirSync(root).flatMap(name => {
  const path = join(root, name).replaceAll('\\', '/')
  if (name === 'bin' || name === 'obj' || name === 'node_modules') return []
  return statSync(path).isDirectory() ? walk(path, pattern) : pattern.test(name) ? [path] : []
})
const toneTest = /\brole\s*[!=]==\s*['"]tone['"]|\bRole\s*[!=]=\s*"tone"/
// The grid's tone reader (toneColumnOf) and the live readers, which keep the tone (and hidden identity columns) out of sight.
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
    expect([...hiddenRoles].sort()).toEqual(['hidden', 'leftRow', 'mark', 'old', 'rightRow', 'tone'])
    for (const role of ['old', 'mark', 'leftRow', 'rightRow', 'tone', 'hidden'] as const) expect(isHiddenColumn(column('c', role)), role).toBe(true)
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
    expect(diffSuffixOf({ kind: 'diff', columns: diffColumns })).toEqual({ old: -1, mark: 2, leftRow: 3, rightRow: 4, tone: 5 })
    expect(diffSuffixOf({ kind: 'rows', columns: diffColumns })).toBeUndefined()
    // One row per entry: each pair's previous value comes after the data, before the mark; `old` is the first of them.
    const entryColumns = [column('Id'), column('Name'), column('Id', 'old'), column('Name', 'old'), ...diffColumns.slice(2)]
    expect(diffSuffixOf({ kind: 'diff', columns: entryColumns })).toEqual({ old: 2, mark: 4, leftRow: 5, rightRow: 6, tone: 7 })
    expect(visibleColumnCount({ columns: entryColumns })).toBe(2)
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
    expect(diffGutter(' ', '3', '4', sides)).toEqual({ mark: '', number: '4', flag: '', name: 'Unchanged; row 3 in Sample Query, row 4 in Awesome Query' })
    // One row per entry: a changed entry is marked "~", numbered in the new input and named changed.
    expect(diffGutter('~', '3', '4', sides, 'changed 2')).toEqual({ mark: '~', number: '4', flag: '', name: 'Changed; row 3 in Sample Query, row 4 in Awesome Query' })
    expect(diffGutter('+', null, '7', sides)).toEqual({ mark: '+', number: '7', flag: '', name: 'Added; row 7 in Awesome Query' })
    expect(diffGutter('−', '5', null, sides)).toEqual({ mark: '−', number: '5', flag: '', name: 'Removed; row 5 in Sample Query' })
    // Both halves of a changed entry carry both rows; each draws its own side's.
    expect(diffGutter('−', '2', '9', sides)).toEqual({ mark: '−', number: '2', flag: '', name: 'Changed, old values; row 2 in Sample Query, row 9 in Awesome Query' })
    expect(diffGutter('+', '2', '9', sides)).toEqual({ mark: '+', number: '9', flag: '', name: 'Changed, new values; row 2 in Sample Query, row 9 in Awesome Query' })
    expect(diffGutter(' ', '1204', '12000').name).toBe('Unchanged; row 1,204 in the old result, row 12,000 in the new result')
  })
  it('draws ≈ for a repeated key, else ? for a possible match, and names the flags and a cut row', () => {
    expect(diffGutter('−', '3', '4', sides, 'changedOld dup 2')).toEqual({ mark: '−', number: '3', flag: '≈', name: 'Changed, old values, repeated key; row 3 in Sample Query, row 4 in Awesome Query' })
    expect(diffGutter('−', '5', null, sides, 'removed poss=12')).toEqual({ mark: '−', number: '5', flag: '?', name: 'Removed, possible match with row 12 in Awesome Query; row 5 in Sample Query' })
    expect(diffGutter('+', null, '12', sides, 'added poss=5 gap=3')).toEqual({ mark: '+', number: '12', flag: '?', name: 'Added, possible match with row 5 in Sample Query; row 12 in Awesome Query' })
    // Both: ≈ is drawn and both are named.
    expect(diffGutter('+', null, '12', sides, 'added dup poss=5')).toMatchObject({ flag: '≈', name: 'Added, repeated key, possible match with row 5 in Sample Query; row 12 in Awesome Query' })
    // A gap is named and drawn only while the gaps are shown (Changes only, no sort or filter).
    expect(diffGutter(' ', '1', '1', sides, 'same gap=312')).toEqual({ mark: '', number: '1', flag: '', name: 'Unchanged; row 1 in Sample Query, row 1 in Awesome Query' })
    expect(diffGutter('+', '2', '9', sides, 'changedNew 0 2 4 …').name).toBe('Changed, new values; row 2 in Sample Query, row 9 in Awesome Query. More changes in this row are not listed')
  })
  it('reads a tone\'s flags, ignoring unknown ones and stopping at the cells', () => {
    expect(toneFlagsOf('removed dup poss=7 gap=2')).toEqual({ repeated: true, partner: 7, gap: 2, cut: false })
    expect(toneFlagsOf('changedOld gap=312 2 4-6')).toEqual({ repeated: false, gap: 312, cut: false })
    expect(toneFlagsOf('same gap=0')).toEqual({ repeated: false, cut: false })
    expect(toneFlagsOf('same gap=-3')).toEqual({ repeated: false, cut: false })
    expect(toneFlagsOf('same gap=1.5')).toEqual({ repeated: false, cut: false })
    expect(toneFlagsOf('changedOld future=3 dup 4 5')).toEqual({ repeated: true, cut: false })
    expect(toneFlagsOf('changedOld 4 dup')).toEqual({ repeated: false, cut: false })
    expect(toneFlagsOf('added poss=0')).toEqual({ repeated: false, cut: false })
    expect(toneFlagsOf('changedNew 1 3 …')).toEqual({ repeated: false, cut: true })
    expect(toneFlagsOf(null)).toEqual({ repeated: false, cut: false })
  })
  it('names the unchanged rows Changes only hides before a row and after the last, only while the gaps are shown', () => {
    expect(gapText(312)).toBe('312 unchanged rows hidden')
    expect(gapText(1)).toBe('1 unchanged row hidden')
    expect(gapText(1204, true)).toBe('1,204 unchanged rows hidden after it')
    expect(diffGutter(' ', '1', '1', sides, 'same gap=312', { shown: true })).toEqual({ mark: '', number: '1', flag: '', name: 'Unchanged; row 1 in Sample Query, row 1 in Awesome Query. 312 unchanged rows hidden', above: 312 })
    expect(diffGutter('−', '5', null, sides, 'removed gap=1', { shown: true, trailing: 12 })).toEqual({ mark: '−', number: '5', flag: '', name: 'Removed; row 5 in Sample Query. 1 unchanged row hidden. 12 unchanged rows hidden after it', above: 1, below: 12 })
    expect(diffGutter('+', null, '7', sides, 'added', { shown: true, trailing: 3 })).toMatchObject({ name: 'Added; row 7 in Awesome Query. 3 unchanged rows hidden after it', below: 3 })
    // A sort or filter moves or drops the rows a run sits between: nothing is named or drawn.
    expect(diffGutter(' ', '1', '1', sides, 'same gap=312', { shown: false, trailing: 4 })).toEqual({ mark: '', number: '1', flag: '', name: 'Unchanged; row 1 in Sample Query, row 1 in Awesome Query' })
  })
  it('marks the key columns rows were matched by, by name ignoring case, each name its first unused column', () => {
    const names = ['Id', 'Status', 'id', 'Total']
    expect(diffKeyFlags({ mode: 'columns', columns: ['ID', 'status'] }, names)).toEqual([true, true, false, false])
    expect(diffKeyFlags({ mode: 'columns', columns: ['id', 'id'] }, names)).toEqual([true, false, true, false])
    expect(diffKeyFlags({ mode: 'auto', columns: ['Total'] }, names)).toEqual([false, false, false, true])
    expect(diffKeyFlags({ mode: 'auto', columns: [] }, names)).toEqual([false, false, false, false])
    expect(diffKeyFlags({ mode: 'rows', columns: [] }, names)).toEqual([false, false, false, false])
    expect(diffKeyFlags({ mode: 'position', columns: ['Id'] }, names)).toEqual([false, false, false, false])
    expect(diffKeyFlags(undefined, names)).toEqual([false, false, false, false])
  })
  it('names a comparison\'s inputs as they were compared, and sizes the number for the larger', () => {
    // The handles' counts, not the descriptors' (an entry keeps the one it opened with, before any row was stored).
    const set = (key: string, rows: number) => ({ key, descriptor: { rowsStored: 0 }, handle: { getSnapshot: () => ({ rowsStored: rows }) } })
    const sets = [set('a', 12), set('b', 30_000)] as never
    expect(diffSidesOf({ left: 'a', right: 'b', leftNumber: 1, rightNumber: 2, leftName: 'Open orders' }, sets)).toEqual({ old: 'Open orders', new: 'Result 2', rows: 30_000 })
    expect(diffSidesOf({ left: 'a', right: 'gone', leftNumber: 1, rightNumber: 2 }, sets).rows).toBe(12)
    // The inputs' rows when compared still size the numbers once both are closed.
    expect(diffSidesOf({ left: 'gone', right: 'also gone', leftNumber: 1, rightNumber: 2, inputRows: 50_000 }, sets).rows).toBe(50_000)
  })
  it('reads the whole suffix with each row tile, across two tile columns', () => {
    const handle = { getWindow: () => new Promise<never>(() => {}), peekWindow: () => undefined, prefetch: () => {} }
    // 62 data columns: the marker (62) and Old row (63) are in tile column 1, New row (64) and the tone (65) in 2. A view of
    // tile column 0 reads both: the tone's tile alone would leave the marker unread and the gutter blank.
    const data = new GridData({ handle, columns: 62, tone: 65, suffix: 62, clientInflight: () => 0, changed: () => {} })
    const plan = data.plan({ firstRow: 0, lastRow: 10, firstColumn: 0, lastColumn: 5 }, 1000)
    expect(plan.filter(key => tileRowOf(key) === 0).map(tileColumnOf).sort()).toEqual([0, 1, 2])
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
