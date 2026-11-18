import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { decodePage, encodePage } from '../src/shared/ipc/wire/pages'
import { boundTable, LocalCopyTooLarge, localCopyText, localExportBytes, localPage, localSaveBytes, localSavePageChars, localSavePageRows, localTableLimits, textColumns, type LocalTableData } from '../src/shared/results/local-table'
import { exportText } from '../src/shared/results/text-writer'
import { copyText } from '../src/shared/results/text-writer'
import { localDescriptor, LocalSource, sortOrder } from '../src/renderer/src/grid/local-source'
import { beginCopy, latestCopy } from '../src/renderer/src/grid/copy-generation'
import { FLAG_CAPPED, FLAG_NULL, FLAG_TRUNCATED } from '../src/renderer/src/results/worker-protocol'
import { localSaveRequestSchema } from '../src/main/validation'
import { localSaveMode, ResultsJobHost, writeLocalSave, type JobHostDeps } from '../src/main/results-jobs'
import { BackendError } from '../src/main/backend/errors'
import { writeBytesAtomic } from '../src/main/json-file'

const table: LocalTableData = {
  columns: [{ name: 'Name' }, { name: 'Rows', kind: 'number' }, { name: 'Note' }],
  rows: [['Orders', '1,200', null], ['customers', '80', 'tab\there'], ['Order Lines', '9000', 'a,"b"'], ['order', null, 'line\r\nbreak']]
}
const all = [{ rows: [[0, Number.MAX_SAFE_INTEGER]] as [number, number][], columns: [[0, 2]] as [number, number][] }]

describe('local tables', () => {
  it('hold to their bounds, keeping the first rows and cutting long cells', () => {
    const wide = boundTable({ columns: Array.from({ length: 70 }, (_, i) => ({ name: 'c'.repeat(200) + i })), rows: [Array.from({ length: 70 }, () => 'x'.repeat(5000))] })
    expect(wide.columns).toHaveLength(localTableLimits.columns)
    expect(wide.columns[0].name).toHaveLength(localTableLimits.nameChars)
    expect(wide.rows[0]).toHaveLength(localTableLimits.columns)
    expect(wide.rows[0][0]).toHaveLength(localTableLimits.cellChars)
    expect(wide.cutCells).toBe(localTableLimits.columns)
    expect(wide.droppedColumns).toBe(70 - localTableLimits.columns)
    const long = boundTable({ columns: [{ name: 'a' }], rows: Array.from({ length: localTableLimits.rows + 5 }, (_, i) => [String(i)]) })
    expect(long.rows).toHaveLength(localTableLimits.rows)
    expect(long.truncatedRows).toBe(5)
    // Short rows are filled with NULL; the text bound stops before the row that would pass it.
    expect(boundTable({ columns: [{ name: 'a' }, { name: 'b' }], rows: [['x']] }).rows).toEqual([['x', null]])
    const heavy = boundTable({ columns: [{ name: 'a' }], rows: Array.from({ length: 2000 }, () => ['y'.repeat(localTableLimits.cellChars)]) })
    expect(heavy.rows.length * localTableLimits.cellChars).toBeLessThanOrEqual(localTableLimits.textChars)
    expect(heavy.truncatedRows).toBe(2000 - heavy.rows.length)
  })

  it('copy the text a results grid copies: the page they build is the page a result would have', async () => {
    const built = localPage(table)
    const encoded = decodePage(encodePage({ resultId: 1, firstRow: 0, columns: textColumns(table.columns), rows: table.rows.map(row => [...row]) }), textColumns(table.columns))
    const request = { columns: textColumns(table.columns), available: 4, parts: all, headers: true, crlf: true }
    const fromBuilt = await copyText({ ...request, pageAt: () => built }), fromEncoded = await copyText({ ...request, pageAt: () => encoded })
    expect(fromBuilt.text).toEqual(fromEncoded.text)
    const copied = await localCopyText(table, all, { headers: true, crlf: false })
    expect(copied.text).toBe('Name\tRows\tNote\nOrders\t1,200\tNULL\ncustomers\t80\ttab here\nOrder Lines\t9000\ta,"b"\norder\tNULL\tline break')
    expect(copied.rows).toBe(4)
  })

  it('copy across pages in the order shown, encoding only the pages a copy reaches', async () => {
    const long: LocalTableData = { columns: [{ name: 'n' }], rows: Array.from({ length: localSavePageRows * 3 }, (_, i) => [String(i)]) }
    const order = long.rows.map((_, i) => long.rows.length - 1 - i)
    let yields = 0
    const copied = await localCopyText(long, [{ rows: [[localSavePageRows - 2, localSavePageRows + 1]], columns: [[0, 0]] }], { headers: false, crlf: false, order, afterPage: async () => { yields++ } })
    // A page's rows, then the next page's: a yield after each.
    expect(yields).toBe(2)
    expect(copied.text).toBe([1, 0, -1, -2].map(k => String(long.rows.length - localSavePageRows + k)).join(String.fromCharCode(10)))
  })

  it('stop a copy past its bound: overlapping parts copy their rows again, past what the table holds', async () => {
    const wide: LocalTableData = { columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], rows: Array.from({ length: 1000 }, () => ['x'.repeat(localTableLimits.cellChars), 'y', 'z']) }
    const parts = [{ rows: [[0, 999]], columns: [[0, 2]] }, { rows: [[1, 999]], columns: [[0, 1]] }, { rows: [[2, 999]], columns: [[0, 0]] }] as const
    let pages = 0
    const refused = await localCopyText(wide, parts.map(part => ({ rows: part.rows.map(range => [...range] as [number, number]), columns: part.columns.map(range => [...range] as [number, number]) })), { headers: false, crlf: false, maxBytes: 8 * 1024 * 1024, afterPage: async () => { pages++ } }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(LocalCopyTooLarge)
    // Stopped at the page that passed the bound, not after every part.
    expect(pages).toBeLessThan(6)
    expect((await localCopyText(wide, [{ rows: [[0, 999]], columns: [[0, 2]] }], { headers: false, crlf: false, maxBytes: 8 * 1024 * 1024 })).rows).toBe(1000)
  })

  it('stop a copy a later copy supersedes, at its next page', async () => {
    const long: LocalTableData = { columns: [{ name: 'n' }], rows: Array.from({ length: localSavePageRows * 4 }, (_, i) => [String(i)]) }
    const first = beginCopy()
    let pages = 0
    const stopped = await localCopyText(long, [{ rows: [[0, long.rows.length - 1]], columns: [[0, 0]] }], { headers: false, crlf: false, afterPage: async () => {
      if (++pages === 2) beginCopy()
      if (!latestCopy(first)) throw new Error('superseded')
    } }).catch((error: Error) => error.message)
    expect(stopped).toBe('superseded')
    expect(pages).toBe(2)
  })

  it('copy in the order shown, and only the parts selected', async () => {
    const order = sortOrder(table, [{ column: 1, descending: false }])!
    const copied = await localCopyText(table, [{ rows: [[0, 1]], columns: [[0, 0]] }, { rows: [[3, 3]], columns: [[1, 1]] }], { headers: false, crlf: true, order })
    // NULL first, then 80, 1,200 and 9000 by value.
    expect(order).toEqual([3, 1, 0, 2])
    expect(copied.text).toBe('order\r\ncustomers\r\n9000')
  })

  it('save as a results grid saves: a BOM and CRLF for CSV and TSV, numbers as numbers in JSON', async () => {
    const decode = (data: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(data)
    const csv = await localExportBytes(table, { format: 'csv', headers: true, nullText: 'empty' })
    expect(decode(csv.data)).toBe('﻿Name,Rows,Note\r\nOrders,"1,200",\r\ncustomers,80,tab\there\r\nOrder Lines,9000,"a,""b"""\r\norder,,"line\r\nbreak"\r\n')
    expect(csv.rows).toBe(4)
    const tsv = await localExportBytes(table, { format: 'tsv', headers: false, nullText: 'NULL' })
    expect(decode(tsv.data)).toBe('﻿Orders\t1,200\tNULL\r\ncustomers\t80\ttab here\r\nOrder Lines\t9000\ta,"b"\r\norder\tNULL\tline break\r\n')
    const json = JSON.parse(decode((await localExportBytes(table, { format: 'json', headers: true, nullText: 'NULL' })).data))
    expect(json).toEqual([{ Name: 'Orders', Rows: '1,200', Note: null }, { Name: 'customers', Rows: 80, Note: 'tab\there' }, { Name: 'Order Lines', Rows: 9000, Note: 'a,"b"' }, { Name: 'order', Rows: null, Note: 'line\r\nbreak' }])
  })

  it('save a page at a time, yielding between pages, and write what one page would', async () => {
    const long: LocalTableData = { columns: [{ name: 'Name' }, { name: 'n', kind: 'number' }], rows: Array.from({ length: localSavePageRows * 2 + 7 }, (_, i) => [i % 5 ? `row "${i}"` : null, String(i)]) }
    for (const format of ['csv', 'tsv', 'json'] as const) {
      let yields = 0
      const paged = await localExportBytes(long, { format, headers: true, nullText: 'NULL' }, async () => { yields++ })
      const page = localPage(long)
      const whole = await exportText({ columns: textColumns(long.columns), pageAt: () => page, rows: page.rowCount, format, headers: true, nullText: 'NULL' })
      expect(paged.data).toEqual(whole.out.bytes())
      expect(yields).toBe(3)
    }
    // A page of long cells ends at its character budget, not its row count.
    const heavy: LocalTableData = { columns: [{ name: 'a' }], rows: Array.from({ length: 100 }, () => ['x'.repeat(4000)]) }
    let heavyYields = 0
    await localExportBytes(heavy, { format: 'csv', headers: false, nullText: 'NULL' }, async () => { heavyYields++ })
    expect(heavyYields).toBe(Math.ceil(100 / Math.ceil(localSavePageChars / 4000)))
  })

  it('sort stably: NULL first, numbers by value, text by the locale with digits as numbers', () => {
    const names: LocalTableData = { columns: [{ name: 'Name' }, { name: 'Group' }], rows: [['Item 10', 'b'], ['item 9', 'a'], [null, 'b'], ['Item 9', 'b'], ['Ítem 1', 'a']] }
    expect(sortOrder(names, [])).toBeUndefined()
    // Base sensitivity: case and accents tie, and ties keep the table's order.
    expect(sortOrder(names, [{ column: 0, descending: false }])).toEqual([2, 4, 1, 3, 0])
    expect(sortOrder(names, [{ column: 0, descending: true }])).toEqual([0, 1, 3, 4, 2])
    expect(sortOrder(names, [{ column: 1, descending: false }, { column: 0, descending: true }])).toEqual([1, 4, 0, 3, 2])
    // A number column sorts text that is not a number after the numbers.
    expect(sortOrder({ columns: [{ name: 'n', kind: 'number' }], rows: [['n/a'], ['10'], ['9'], ['-1.5']] }, [{ column: 0, descending: false }])).toEqual([3, 2, 1, 0])
    // Empty text and what only JavaScript reads as a number (hex, Infinity) are text, not 0 or a value.
    expect(sortOrder({ columns: [{ name: 'n', kind: 'number' }], rows: [[''], ['0x10'], ['5'], [' '], ['Infinity'], ['1e3'], ['0']] }, [{ column: 0, descending: false }])).toEqual([6, 2, 5, 0, 3, 1, 4])
  })

  it('serve windows as a result does: NULL and capped cells flagged, display text, the order shown', async () => {
    const source = new LocalSource(table, [2, 0, 1, 3])
    const window = source.peekWindow(1, 3, { colStart: 1, colEnd: 3, maxCellChars: 5, display: true })
    expect(window).toMatchObject({ first: 1, count: 3, colStart: 1, colEnd: 3 })
    // Rows shown 1-3 are the table's 0, 1 and 3; "line\r\nbreak" is cut at 5 characters and drawn with its break visible.
    expect(window.text.filter((_, i) => i % 2 === 0)).toEqual(['1,200', '80', ''])
    expect(window.flags[0]).toBe(0)
    expect(window.flags[1]).toBe(FLAG_NULL)
    expect(window.flags[3]).toBe(FLAG_CAPPED)
    expect(window.flags[4]).toBe(FLAG_NULL)
    expect(window.flags[5]).toBe(FLAG_CAPPED)
    // The same window again is the cached one; past the rows it shrinks.
    expect(source.peekWindow(1, 3, { colStart: 1, colEnd: 3, maxCellChars: 5, display: true })).toBe(window)
    expect((await source.getWindow(3, 10)).count).toBe(1)
    expect(source.getSnapshot()).toMatchObject({ rowsAvailable: 4, state: 'complete', incomplete: false })
    const { widths } = await source.measure(0, 4, 0, 3)
    // The widest text of each column in the grid's monospace columns; NULL counts as its four letters.
    expect(widths[0]).toBe('Order Lines'.length)
    expect(widths[1]).toBe(5)
    expect(widths[2]).toBeGreaterThanOrEqual('line break'.length)
    expect(localDescriptor(table).columns.map(column => column.dataType)).toEqual(['nvarchar', 'decimal', 'nvarchar'])
    // A cell cut to the bound is flagged truncated wherever a sort shows it; a row past the text bound takes its cuts with it.
    const cutting = boundTable({ columns: [{ name: 'a' }, { name: 'b' }], rows: [['short', 'z'], ['x'.repeat(localTableLimits.cellChars + 1), 'y']] })
    expect([...cutting.cut]).toEqual([2])
    const sortedCut = new LocalSource(cutting, [1, 0], cutting.cutCells, cutting.cut).peekWindow(0, 2, { colStart: 0, colEnd: 2 })
    expect(Array.from(sortedCut.flags, flag => flag & FLAG_TRUNCATED)).toEqual([FLAG_TRUNCATED, 0, 0, 0])
    const dropped = boundTable({ columns: [{ name: 'a' }], rows: [...Array.from({ length: 1048 }, () => ['y'.repeat(localTableLimits.cellChars)]), ['z'.repeat(localTableLimits.cellChars + 10)]] })
    expect(dropped.truncatedRows).toBe(1)
    expect(dropped.cutCells).toBe(0)
    expect(dropped.cut.size).toBe(0)
  })
})

describe('local saves in main', () => {
  const request = { suggestedName: 'Orders-Columns', columns: [{ name: 'Name' }, { name: 'Rows', kind: 'number' as const }], rows: [['Orders', '12'], ['Lines', null]] }
  it('take only bounded, rectangular tables', () => {
    expect(localSaveRequestSchema.safeParse(request).success).toBe(true)
    for (const bad of [{ ...request, rows: [['Orders']] }, { ...request, columns: [] }, { ...request, extra: 1 }, { ...request, rows: [['x'.repeat(localTableLimits.cellChars + 1), null]] },
      { ...request, rows: Array.from({ length: localTableLimits.rows + 1 }, () => ['a', 'b']) }, { ...request, rows: Array.from({ length: 1100 }, () => ['y'.repeat(localTableLimits.cellChars), null]) }])
      expect(localSaveRequestSchema.safeParse(bad).success).toBe(false)
  })

  const realDeps = (): JobHostDeps => ({ backend: {} as JobHostDeps['backend'], owns: () => true, writeClipboard: () => {}, showSaveDialog: async () => ({ canceled: true }), documentsDir: () => tmpdir(), progress: () => {}, platform: 'linux', exportHeaders: async () => true })
  function host(patch: Partial<JobHostDeps> = {}) {
    const written: { path: string; text: string }[] = []
    const dialog = vi.fn<JobHostDeps['showSaveDialog']>(async () => ({ canceled: false, filePath: '/home/me/Documents/cols.txt' }))
    const deps = {
      backend: {} as JobHostDeps['backend'], owns: () => true, writeClipboard: () => {}, showSaveDialog: dialog, documentsDir: () => '/home/me/Documents', progress: () => {}, platform: 'linux' as const,
      exportHeaders: async () => true, writeFile: async (path: string, data: Uint8Array) => { written.push({ path, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(data) }) }, ...patch
    } satisfies JobHostDeps
    return { jobs: new ResultsJobHost(deps), written, dialog }
  }

  it('bound a save before the dialog by the most bytes any format writes', async () => {
    const tricky: LocalTableData = { columns: [{ name: 'Ünïcode "key"' }, { name: 'n', kind: 'number' }], rows: [['\u0001\u0002 "é" 日本', '1,5'], [null, null], ['a\r\nb\tc', '12']] }
    for (const format of ['csv', 'tsv', 'json'] as const) for (const headers of [true, false])
      expect(localSaveBytes(tricky)).toBeGreaterThanOrEqual((await localExportBytes(tricky, { format, headers, nullText: 'NULL' })).data.length)
    // Blank and repeated names (Column{n}, _n keys), NULL and empty cells: tables drawn from awkward parts, never under.
    const names = ['', '', 'a', 'a', '"q"', 'Ü', '\u0001'.repeat(localTableLimits.nameChars)], cells = [null, '', 'x', '\u0001', '日本', 'a,"b"', '\r\n']
    let seed = 7
    const pick = <T,>(of: readonly T[]) => of[(seed = (seed * 1103515245 + 12345) % 2147483648) % of.length]
    for (let round = 0; round < 40; round++) {
      const width = 1 + (round % 9), table: LocalTableData = { columns: Array.from({ length: width }, () => ({ name: pick(names) })), rows: Array.from({ length: round % 5 }, () => Array.from({ length: width }, () => pick(cells))) }
      for (const format of ['csv', 'tsv', 'json'] as const) for (const nullText of ['NULL', 'empty'] as const)
        expect(localSaveBytes(table)).toBeGreaterThanOrEqual((await localExportBytes(table, { format, headers: true, nullText })).data.length)
    }
    // Long names and tiny cells: a CSV writes its header once, so the estimate charges only JSON's keys per row and a
    // table whose every save fits is taken.
    const named: LocalTableData = { columns: Array.from({ length: localTableLimits.columns }, (_, i) => ({ name: `A fifty character column name for the table ${i}`.padEnd(50, '.') })), rows: Array.from({ length: localTableLimits.rows }, () => Array<string | null>(localTableLimits.columns).fill('a')) }
    expect(localSaveBytes(named)).toBeLessThanOrEqual(localTableLimits.saveBytes)
    for (const format of ['csv', 'json'] as const) expect(localSaveBytes(named)).toBeGreaterThanOrEqual((await localExportBytes(named, { format, headers: true, nullText: 'NULL' })).data.length)
    // At the bound: blank NULL columns and long control-character names, whose JSON keys repeat on every row.
    const edge: LocalTableData = { columns: [...Array.from({ length: 40 }, () => ({ name: '' })), ...Array.from({ length: 24 }, (_, i) => ({ name: `${i}`.padEnd(localTableLimits.nameChars, '\u0001') }))], rows: Array.from({ length: 3600 }, () => Array<string | null>(64).fill(null)) }
    const edgeJson = (await localExportBytes(edge, { format: 'json', headers: true, nullText: 'NULL' })).data.length
    expect(edgeJson).toBeGreaterThan(localTableLimits.saveBytes)
    expect(localSaveBytes(edge)).toBeGreaterThanOrEqual(edgeJson)
    // Within the request's own bounds (NULL counts no text) JSON repeats each long key per row, past 64 MiB: refused before any dialog.
    const heavy = { suggestedName: 'Heavy', columns: Array.from({ length: localTableLimits.columns }, (_, i) => ({ name: `${i}`.padEnd(localTableLimits.nameChars, '\u0001') })), rows: Array.from({ length: localTableLimits.rows }, () => Array<string | null>(localTableLimits.columns).fill(null)) }
    expect(localSaveRequestSchema.safeParse(heavy).success).toBe(true)
    const { jobs, dialog } = host()
    await expect(jobs.saveLocal(heavy)).rejects.toMatchObject({ code: 'TOO_LARGE', message: 'These rows are too large to save (over 64 MB).' })
    expect(dialog).not.toHaveBeenCalled()
  })

  it('refuse a second save while one is open, and never recreate a folder deleted since the dialog', async () => {
    let close!: (value: { canceled: boolean }) => void
    const waiting = host({ showSaveDialog: () => new Promise(resolve => { close = resolve }) })
    const first = waiting.jobs.saveLocal(request)
    await expect(waiting.jobs.saveLocal(request)).rejects.toMatchObject({ code: 'JOB_BUSY' })
    close({ canceled: true })
    expect(await first).toBeNull()
    const folder = await mkdtemp(join(tmpdir(), 'varia-local-save-'))
    try {
      const gone = join(folder, 'deleted')
      await expect(writeBytesAtomic(join(gone, 'cols.csv'), new Uint8Array([1]), { createFolder: false })).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(folder)).toEqual([])
      // Through the real atomic write: the save fails as the folder being gone, and nothing is created.
      const error = await new ResultsJobHost({ ...realDeps(), showSaveDialog: async () => ({ canceled: false, filePath: join(gone, 'cols.csv') }) }).saveLocal(request).catch((value: unknown) => value)
      expect(error).toMatchObject({ code: 'EXPORT_FAILED' })
      expect(await readdir(folder)).toEqual([])
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('write the format the chosen file names, through the same dialog as a results grid', async () => {
    const { jobs, written, dialog } = host()
    expect(await jobs.saveLocal(request)).toEqual({ fileName: 'cols.txt', format: 'tsv', rows: 2 })
    expect(dialog.mock.calls[0][0]).toMatchObject({ title: 'Save Grid Results', defaultPath: expect.stringMatching(/Orders-Columns\.csv$/) })
    expect(written).toEqual([{ path: '/home/me/Documents/cols.txt', text: '﻿Name\tRows\r\nOrders\t12\r\nLines\tNULL\r\n' }])
    // The next save starts in that folder with that format.
    await jobs.saveLocal(request)
    expect(dialog.mock.calls[1][0].defaultPath.replaceAll('\\', '/')).toBe('/home/me/Documents/Orders-Columns.txt')
  })

  it('answer null when the dialog is cancelled, refuse bad requests and say why a write failed', async () => {
    expect(await host({ showSaveDialog: async () => ({ canceled: true }) }).jobs.saveLocal(request)).toBeNull()
    await expect(host().jobs.saveLocal({ ...request, rows: [['x']] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const failing = host({ writeFile: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) } })
    const error = await failing.jobs.saveLocal(request).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ code: 'EXPORT_FAILED', message: 'Could not save the results: cols.txt is open in another program.' })
    // Windows refuses to rename over a file another program holds with EPERM: in use, as a results save says, not denied.
    const held = (platform: NodeJS.Platform, replacing: boolean) => host({ platform, writeFile: async () => { throw Object.assign(new Error('held'), { code: 'EPERM', ...replacing ? { replacing } : {} }) } }).jobs.saveLocal(request).catch((value: Error) => value.message)
    expect(await held('win32', true)).toBe('Could not save the results: cols.txt is open in another program.')
    expect(await held('win32', false)).toBe('Could not save the results: access to cols.txt is denied.')
    expect(await held('linux', true)).toBe('Could not save the results: access to cols.txt is denied.')
    // Refused over a read-only file it is denied, over a folder it is a folder, as a results save says.
    const refused = (found: { isDirectory(): boolean; mode: number }) => host({ platform: 'win32', statTarget: async () => found, writeFile: async () => { throw Object.assign(new Error('refused'), { code: 'EPERM', replacing: true }) } }).jobs.saveLocal(request).catch((value: Error) => value.message)
    expect(await refused({ isDirectory: () => false, mode: 0o444 })).toBe('Could not save the results: access to cols.txt is denied.')
    expect(await refused({ isDirectory: () => true, mode: 0o777 })).toBe('Could not save the results: cols.txt is a folder.')
    expect(await refused({ isDirectory: () => false, mode: 0o666 })).toBe('Could not save the results: cols.txt is open in another program.')
  })

  it('take a mode only off Windows, where a mode without write bits would make the file read-only', async () => {
    const file = { isFile: () => true, isSymbolicLink: () => false, mode: 0o100600 }, link = { isFile: () => false, isSymbolicLink: () => true, mode: 0o120777 }
    expect(localSaveMode(file, undefined)).toEqual({ mode: 0o600 })
    expect(localSaveMode(link, { isFile: () => true, mode: 0o100444 })).toEqual({ mode: 0o444, umask: true })
    expect(localSaveMode(link, { isFile: () => false, mode: 0o40755 })).toEqual({})
    expect(localSaveMode(undefined, undefined)).toEqual({})
    // On Windows the target is not read for a mode: over a read-only file the new one is writable until it replaces it.
    const folder = await mkdtemp(join(tmpdir(), 'varia-local-win-'))
    try {
      const path = join(folder, 'new.csv')
      await writeLocalSave(path, new TextEncoder().encode('new'), 'win32')
      expect((await stat(path)).mode & 0o200).toBe(0o200)
      // A folder is refused before anything is written, on every platform.
      await mkdir(join(folder, 'dir.csv'))
      await expect(writeLocalSave(join(folder, 'dir.csv'), new TextEncoder().encode('new'))).rejects.toMatchObject({ code: 'EISDIR' })
      expect((await readdir(folder)).sort()).toEqual(['dir.csv', 'new.csv'])
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('keep the permission bits of a file they replace, as a results save does', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'varia-local-mode-'))
    try {
      const path = join(folder, 'cols.csv')
      await writeFile(path, 'old')
      await chmod(path, 0o600)
      await writeLocalSave(path, new TextEncoder().encode('new'))
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      // A symlink to a private file becomes a file no wider than the linked one's bits.
      const linked = join(folder, 'private.csv'), link = join(folder, 'link.csv')
      await writeFile(linked, 'old')
      await chmod(linked, 0o600)
      await symlink(linked, link)
      await writeLocalSave(link, new TextEncoder().encode('new'))
      expect((await lstat(link)).isFile()).toBe(true)
      expect((await stat(link)).mode & 0o077).toBe(0)
      // A link to a folder stays a link: the save is refused as a folder.
      const folderLink = join(folder, 'folder-link.csv')
      await mkdir(join(folder, 'target'))
      await symlink(join(folder, 'target'), folderLink)
      await expect(writeLocalSave(folderLink, new TextEncoder().encode('new'))).rejects.toMatchObject({ code: 'EISDIR' })
      expect((await lstat(folderLink)).isSymbolicLink()).toBe(true)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
