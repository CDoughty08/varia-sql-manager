// A local table as a grid's source (GridSource): rows the renderer already holds, read synchronously from memory, in the
// order a header sort put them. Each sort is a new source over the same table, which the grid swaps in (GridView.swap),
// so the selection follows its rows as a live grid's does.
import type { ResultColumn, ResultDescriptor } from '../../../shared/contracts'
import { displayText } from '../../../shared/ipc/wire/cells'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import type { LocalCell, LocalTableData } from '../../../shared/results/local-table'
import type { ResultSnapshot, RowWindow, WindowOptions, WindowShape } from '../results/ResultClient'
import { FLAG_CAPPED, FLAG_NULL } from '../results/worker-protocol'
import { gridLimits as g } from './constants'
import type { GridSource } from './GridView'
import { displayColumns } from './measure'

/** A sort key of a local table: a column, descending or not. */
export interface LocalSortKey { readonly column: number; readonly descending: boolean }

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
/** A number column's value, for sorting: NaN for text that is not one (sorted after the numbers, as text). */
const numberOf = (text: string) => Number(text.replace(/,/g, ''))
/** NULL first ascending, as SQL Server orders it; numbers by value in a number column, else text by the locale, digits as numbers. */
function compare(a: LocalCell, b: LocalCell, numeric: boolean): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1
  if (numeric) {
    const x = numberOf(a), y = numberOf(b)
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y
    if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1
  }
  return collator.compare(a, b)
}

/** The table's rows in the keys' order, stable (ties keep the table's order); undefined without keys. */
export function sortOrder(table: LocalTableData, keys: readonly LocalSortKey[]): number[] | undefined {
  if (keys.length === 0) return undefined
  const order = table.rows.map((_, index) => index)
  return order.sort((x, y) => {
    for (const key of keys) {
      const result = compare(table.rows[x][key.column], table.rows[y][key.column], table.columns[key.column]?.kind === 'number')
      if (result !== 0) return key.descending ? -result : result
    }
    return x - y
  })
}

/** The descriptor a grid reads a local table's columns from: text columns of a complete result no backend holds. */
export function localDescriptor(table: LocalTableData, truncatedCells = 0): ResultDescriptor {
  const rows = table.rows.length
  const columns: ResultColumn[] = table.columns.map(column => ({ name: column.name, dataType: column.kind === 'number' ? 'decimal' : 'nvarchar', wire: 'text', nullable: true }))
  return { generation: 0, resultId: 0, index: 0, batchNumber: 0, iteration: 0, kind: 'rows', columns, rowsRead: rows, rowsStored: rows, rowsAvailable: rows, bytesStored: 0, truncatedCells, state: 'complete', incomplete: false }
}

const windowCacheSize = 64

export class LocalSource implements GridSource {
  readonly table: LocalTableData
  /** The shown row's row of the table, or undefined for the table's own order. */
  readonly order: readonly number[] | undefined
  private readonly snapshot: ResultSnapshot
  private readonly windows = new Map<string, RowWindow>()
  constructor(table: LocalTableData, order?: readonly number[], truncatedCells = 0) {
    this.table = table
    this.order = order
    const rows = table.rows.length
    this.snapshot = { rowsRead: rows, rowsStored: rows, rowsAvailable: rows, bytesStored: 0, truncatedCells, state: 'complete', incomplete: false }
  }
  /** The table's row shown at `row`. */
  rowOf(row: number): number { return this.order ? this.order[row] : row }
  getSnapshot(): ResultSnapshot { return this.snapshot }
  /** A local table never changes: a new table or order is a new source. */
  subscribe(): () => void { return () => {} }
  getWindow(first: number, count: number, o: WindowOptions = {}): Promise<RowWindow> { return Promise.resolve(this.window(first, count, o)) }
  peekWindow(first: number, count: number, o: WindowShape = {}): RowWindow { return this.window(first, count, o) }
  prefetch(): void {}
  measure(first: number, count: number, colStart: number, colEnd: number): Promise<{ rows: number; widths: Uint16Array }> {
    const columns = this.table.columns.length, start = clamp(colStart, 0, columns), end = clamp(colEnd, start, columns)
    const from = clamp(first, 0, this.snapshot.rowsAvailable), to = clamp(from + Math.max(0, count), from, this.snapshot.rowsAvailable)
    const widths = new Uint16Array(end - start), cap = g.measureCap
    for (let row = from; row < to; row++) {
      const cells = this.table.rows[this.rowOf(row)]
      for (let column = start; column < end; column++) {
        const at = column - start, value = cells[column]
        if (widths[at] >= cap) continue
        const wide = value === null ? 4 : displayColumns(displayText(value.slice(0, cap)), cap)
        if (wide > widths[at]) widths[at] = wide
      }
    }
    return Promise.resolve({ rows: to - from, widths })
  }
  /** Rows [first, first + count) of columns [colStart, colEnd), cut at `maxCellChars` (flagged as a capped cell is). */
  private window(first: number, count: number, o: WindowShape): RowWindow {
    const columns = this.table.columns.length
    const colStart = clamp(o.colStart ?? 0, 0, columns), colEnd = clamp(o.colEnd ?? columns, colStart, columns)
    const maxCellChars = Math.min(o.maxCellChars ?? wire.worker.displayCharacters, wire.cell.document), display = !!o.display
    const from = clamp(Math.floor(first), 0, this.snapshot.rowsAvailable), rows = clamp(Math.floor(count), 0, this.snapshot.rowsAvailable - from)
    const key = `${from}:${rows}:${colStart}:${colEnd}:${maxCellChars}:${display ? 1 : 0}`
    const cached = this.windows.get(key)
    if (cached) return cached
    const width = colEnd - colStart, text = new Array<string>(rows * width), flags = new Uint8Array(rows * width)
    for (let r = 0; r < rows; r++) {
      const cells = this.table.rows[this.rowOf(from + r)]
      for (let column = colStart; column < colEnd; column++) {
        const index = r * width + column - colStart, value = cells[column] ?? null
        if (value === null) { text[index] = ''; flags[index] = FLAG_NULL; continue }
        const cut = value.length > maxCellChars, shown = cut ? value.slice(0, maxCellChars) : value
        text[index] = display ? displayText(shown) : shown
        flags[index] = cut ? FLAG_CAPPED : 0
      }
    }
    const window: RowWindow = { first: from, count: rows, colStart, colEnd, text, flags }
    if (this.windows.size >= windowCacheSize) this.windows.delete(this.windows.keys().next().value!)
    this.windows.set(key, window)
    return window
  }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
