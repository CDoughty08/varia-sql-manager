// @vitest-environment happy-dom
// GridView numeric alignment: precomputed `is-num` class bit on numeric cells and `rg-ch-num` on numeric column headers
// in table view, while transposed view keeps cells and headers left-aligned where rows mix types.
import { afterEach, describe, expect, it } from 'vitest'
import type { ResultColumn, ResultDescriptor } from '../src/shared/contracts'
import { GridView, isNumericColumn, type GridSource } from '../src/renderer/src/grid/GridView'
import { FLAG_NULL } from '../src/renderer/src/results/worker-protocol'

const created: GridView[] = []
afterEach(() => {
  for (const view of created.splice(0)) view.dispose()
  document.body.replaceChildren()
})

function makeGrid(columns: ResultColumn[], transposed = false) {
  const root = document.body.appendChild(document.createElement('div'))
  const scroller = root.appendChild(document.createElement('div'))
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 900 })
  Object.defineProperty(scroller, 'offsetWidth', { configurable: true, value: 900 })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 })
  Object.defineProperty(scroller, 'offsetHeight', { configurable: true, value: 300 })
  const rows = 2
  const text = ['101', 'Widget', '42.50', '1', 'NULL', 'Gadget', '99.95', '0']
  const flags = new Uint8Array([0, 0, 0, 0, FLAG_NULL, 0, 0, 0])
  const window = { first: 0, count: rows, colStart: 0, colEnd: columns.length, text, flags }
  const descriptor: ResultDescriptor = {
    generation: 1, resultId: 1, batchNumber: 1, iteration: 1, index: 0,
    columns, rowsRead: rows, rowsStored: rows, rowsAvailable: rows, bytesStored: 0, truncatedCells: 0, incomplete: false, state: 'complete', kind: 'rows'
  }
  const handle: GridSource = {
    getSnapshot: () => ({ state: 'complete', rowsRead: rows, rowsStored: rows, rowsAvailable: rows, bytesStored: 0, truncatedCells: 0, incomplete: false }),
    subscribe: () => () => {},
    getWindow: async () => window,
    peekWindow: () => window,
    prefetch: () => {},
    measure: async () => ({ rows, widths: new Uint16Array(columns.length).fill(10) })
  }
  const view = new GridView({
    root, scroller, handle, client: { windowsInFlight: 0 }, descriptor,
    state: { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: true },
    entry: 'e1', resultNumber: 1, resultCount: 1, platform: 'win32', transposed,
    onSelection: () => {}, onCopy: () => {}, onEscape: () => false, onStatus: () => {}, onError: error => { throw error }
  })
  created.push(view)
  return { root, view }
}

describe('isNumericColumn', () => {
  it('classifies SQL Server and BigQuery numeric types as numeric, and text/date/bit/binary as non-numeric', () => {
    for (const dataType of ['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'decimal(18,2)', 'numeric', 'numeric(10,4)', 'money', 'smallmoney', 'float', 'real', 'INT64', 'NUMERIC', 'BIGNUMERIC', 'FLOAT64']) {
      expect(isNumericColumn({ dataType }), dataType).toBe(true)
    }
    for (const sortKind of ['integer', 'decimal', 'float'] as const) {
      expect(isNumericColumn({ dataType: 'custom', sortKind }), sortKind).toBe(true)
    }
    for (const dataType of ['bit', 'varchar(50)', 'nvarchar(max)', 'char(4)', 'date', 'time(7)', 'datetime', 'datetime2(3)', 'datetimeoffset(7)', 'uniqueidentifier', 'varbinary(16)', 'xml', 'json']) {
      expect(isNumericColumn({ dataType }), dataType).toBe(false)
    }
    // Explicit non-numeric sortKind takes precedence.
    expect(isNumericColumn({ dataType: 'INT64', sortKind: 'text' })).toBe(false)
  })
})

describe('GridView numeric alignment', () => {
  const columns: ResultColumn[] = [
    { name: 'OrderId', dataType: 'int', wire: 'text', nullable: false, sortKind: 'integer' },
    { name: 'Name', dataType: 'nvarchar(50)', wire: 'text', nullable: true, sortKind: 'text' },
    { name: 'Amount', dataType: 'decimal(18,2)', wire: 'text', nullable: true, sortKind: 'decimal' },
    { name: 'Active', dataType: 'bit', wire: 'text', nullable: false, sortKind: 'boolean' }
  ]

  it('adds is-num to numeric cells and rg-ch-num to numeric column headers in table view', () => {
    const { root } = makeGrid(columns, false)
    const headers = [...root.querySelectorAll<HTMLElement>('.rg-ch')].filter(el => el.style.display !== 'none')
      .sort((a, b) => Number(a.getAttribute('aria-colindex')) - Number(b.getAttribute('aria-colindex')))
    expect(headers.map(h => h.classList.contains('rg-ch-num'))).toEqual([true, false, true, false])

    const rows = [...root.querySelectorAll<HTMLElement>('.rg-row')].filter(el => el.style.display !== 'none')
      .sort((a, b) => Number(a.getAttribute('aria-rowindex')) - Number(b.getAttribute('aria-rowindex')))
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const cells = [...row.querySelectorAll<HTMLElement>('.rg-c')].filter(el => el.style.display !== 'none')
        .sort((a, b) => Number(a.getAttribute('aria-colindex')) - Number(b.getAttribute('aria-colindex')))
      expect(cells.map(c => c.classList.contains('is-num'))).toEqual([true, false, true, false])
    }
    // Row 2 column 1 is a numeric NULL: keeps both is-null and is-num.
    const row2Col0 = [...rows[1].querySelectorAll<HTMLElement>('.rg-c')].find(c => c.getAttribute('aria-colindex') === '2')!
    expect(row2Col0.classList.contains('is-null')).toBe(true)
    expect(row2Col0.classList.contains('is-num')).toBe(true)
  })

  it('keeps cells and headers left-aligned in transposed view where rows mix types', () => {
    const { root } = makeGrid(columns, true)
    const headers = [...root.querySelectorAll<HTMLElement>('.rg-ch')].filter(el => el.style.display !== 'none')
    expect(headers.every(h => !h.classList.contains('rg-ch-num'))).toBe(true)
    const cells = [...root.querySelectorAll<HTMLElement>('.rg-c')].filter(el => el.style.display !== 'none')
    expect(cells.length).toBeGreaterThan(0)
    expect(cells.every(c => !c.classList.contains('is-num'))).toBe(true)
  })
})
