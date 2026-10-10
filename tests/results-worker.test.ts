import { describe, expect, it } from 'vitest'
import { ResultsWorkerCore, type WorkerLimits } from '../src/renderer/src/results/worker-core'
import type { WorkerResponse } from '../src/renderer/src/results/worker-protocol'
import type { WireKind } from '../src/shared/contracts'
import type { PortRequest } from '../src/shared/ipc/port-messages'
import { encodePage, type PageCell } from '../src/shared/ipc/wire/pages'

const wires: WireKind[] = ['text', 'text', 'binary']
const key = { generation: 1, resultId: 5 }
/** Row r: its number, a NULL every 4th row, and two bytes. */
const cells = (row: number): PageCell[] => [String(row), row % 4 === 3 ? null : 'name ' + row, new Uint8Array([row & 0xff, 0xab])]
const page = (firstRow: number, rows: number, resultId = 5): ArrayBuffer => {
  const bytes = encodePage({ resultId, firstRow, columns: wires.map(wire => ({ wire })), rows: Array.from({ length: rows }, (_, index) => cells(firstRow + index)) })
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function fixture(limits: Partial<WorkerLimits> = {}) {
  const posted: WorkerResponse[] = []
  const sent: PortRequest[] = []
  const core = new ResultsWorkerCore({ post: message => { posted.push(message) }, limits })
  core.attach({ postMessage: message => { sent.push(message as PortRequest) } })
  core.receive({ t: 'backend', generation: 1, status: 'ready' })
  let id = 1
  const window = (first: number, count: number, patch: Record<string, unknown> = {}) => {
    const request = { type: 'window' as const, id: id++, key, wires, first, count, colStart: 0, colEnd: 3, maxCellChars: 1024, textBudget: 1_000_000, ...patch }
    core.handle(request)
    return request.id
  }
  const reads = () => sent.filter((request): request is Extract<PortRequest, { t: 'read' }> => request.t === 'read')
  /** Answers a read with 64-row pages covering it, up to `available` rows, then ends it. */
  const serve = (rid: number, available = Number.POSITIVE_INFINITY) => {
    const read = reads().find(item => item.rid === rid)!
    let row = Math.floor(read.firstRow / 64) * 64, seq = 0
    const end = Math.min(read.firstRow + read.maxRows, available)
    for (; row < end; row += 64) core.receive({ t: 'page', rid, seq: ++seq, body: page(row, Math.min(64, available - row)) })
    core.receive({ t: 'end', rid, ok: true, result: { nextRow: Math.min(row, available), rowsAvailable: available, complete: row >= available, pages: seq, rows: Math.min(row, available) - read.firstRow } })
  }
  const answer = (requestId: number) => posted.find(message => 'id' in message && message.id === requestId)
  return { core, posted, sent, window, reads, serve, answer }
}

describe('results worker core', () => {
  it('reads the missing rows once, grants credit after caching each page, and answers with display text and flags', () => {
    const { window, reads, serve, answer, sent, core } = fixture()
    const id = window(0, 100)
    expect(reads()).toEqual([{ t: 'read', rid: 1, generation: 1, resultId: 5, firstRow: 0, maxRows: 100, credit: 4 * 1024 * 1024 }])
    serve(1)
    expect(sent.filter(request => request.t === 'credit').map(request => request.t === 'credit' && request.rid)).toEqual([1, 1])
    const result = answer(id)
    if (result?.type !== 'window') throw new Error('No window: ' + JSON.stringify(result))
    expect([result.first, result.count, result.colStart, result.colEnd, result.text.length]).toEqual([0, 100, 0, 3, 300])
    expect(result.text.slice(0, 12)).toEqual(['0', 'name 0', '0x00AB', '1', 'name 1', '0x01AB', '2', 'name 2', '0x02AB', '3', '', '0x03AB'])
    expect([...result.flags.slice(9, 12)]).toEqual([0, 1, 0])
    expect(core.cachedPages).toBe(2)
    // Cached rows are answered without another read.
    const again = window(10, 20, { colStart: 1, colEnd: 2 })
    expect(reads()).toHaveLength(1)
    const narrow = answer(again)
    expect(narrow?.type === 'window' && narrow.text).toEqual(Array.from({ length: 20 }, (_, index) => (10 + index) % 4 === 3 ? '' : 'name ' + (10 + index)))
  })

  it('caps cells and the window text budget, and marks what they cut', () => {
    const { window, serve, answer } = fixture()
    const id = window(0, 2, { maxCellChars: 3, textBudget: 7 })
    serve(1)
    const result = answer(id)
    if (result?.type !== 'window') throw new Error('No window')
    // Row 0: '0', 'nam' (the cell cap), '0x' (no whole byte fits in 3 characters); row 1: '1', then the budget is spent.
    expect(result.text).toEqual(['0', 'nam', '0x', '1', '', ''])
    expect([...result.flags]).toEqual([0, 16, 16, 0, 8, 8])
  })

  it('gives the same text and flags whether cells are decoded in runs or one by one', () => {
    const mixed: WireKind[] = ['text', 'text', 'text', 'binary']
    const rows: PageCell[][] = [0, 1, 2].map(row => ['r' + row, 'é' + row, row === 1 ? 'x'.repeat(5000) : 'long ' + row, new Uint8Array([row, 0xab])])
    const posted: WorkerResponse[] = []
    const core = new ResultsWorkerCore({ post: message => { posted.push(message) } })
    core.attach({ postMessage: () => {} })
    core.receive({ t: 'backend', generation: 1, status: 'ready' })
    const window = (id: number, maxCellChars: number, textBudget: number) => {
      core.handle({ type: 'window', id, key, wires: mixed, first: 0, count: 3, colStart: 0, colEnd: 4, maxCellChars, textBudget })
      const answer = posted.find(message => 'id' in message && message.id === id)
      if (answer?.type !== 'window') throw new Error('No window: ' + JSON.stringify(answer))
      return { text: answer.text, flags: [...answer.flags] }
    }
    // The first window reads the page; the others are answered from the cache.
    core.handle({ type: 'window', id: 1, key, wires: mixed, first: 0, count: 3, colStart: 0, colEnd: 4, maxCellChars: 8, textBudget: 1_000_000 })
    const bytes = encodePage({ resultId: 5, firstRow: 0, columns: mixed.map(wire => ({ wire })), rows })
    core.receive({ t: 'page', rid: 1, seq: 1, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })
    core.receive({ t: 'end', rid: 1, ok: true, result: { nextRow: 3, rowsAvailable: 3, complete: true, pages: 1, rows: 3 } })
    // A small cell cap: the short ASCII column is one run; the long column is decoded cell by cell, only up to the cap.
    expect(window(2, 8, 1_000_000)).toEqual({
      text: ['r0', 'é0', 'long 0', '0x00AB', 'r1', 'é1', 'xxxxxxxx', '0x01AB', 'r2', 'é2', 'long 2', '0x02AB'],
      flags: [0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0]
    })
    // A cap the long cell fits: that column is a run too.
    expect(window(3, 10_000, 1_000_000).text[6]).toBe('x'.repeat(5000))
    // The window's text budget runs out in row order, as before.
    expect(window(4, 10_000, 12)).toEqual({
      text: ['r0', 'é0', 'long 0', '0x', '', '', '', '', '', '', '', ''],
      flags: [0, 0, 0, 8, 8, 8, 8, 8, 8, 8, 8, 8]
    })
  })

  it('shares reads between windows and cancels a read only when nobody waits for it', () => {
    const { window, reads, sent, core, serve, answer } = fixture()
    const first = window(0, 64)
    const second = window(0, 64)
    expect(reads()).toHaveLength(1)
    core.handle({ type: 'cancel', id: first })
    expect(sent.some(request => request.t === 'cancel')).toBe(false)
    core.handle({ type: 'cancel', id: second })
    expect(sent.filter(request => request.t === 'cancel')).toEqual([{ t: 'cancel', rid: 1 }])
    // Pages of a cancelled read are neither cached nor credited.
    serve(1)
    expect(core.cachedPages).toBe(0)
    expect(sent.some(request => request.t === 'credit')).toBe(false)
    expect(answer(first)).toBeUndefined()
    expect(answer(second)).toBeUndefined()
  })

  it('shrinks a window to the rows the backend has sealed so far', () => {
    const { window, serve, answer } = fixture()
    const id = window(0, 200)
    serve(1, 70)
    const result = answer(id)
    expect(result?.type === 'window' && [result.count, result.text.length]).toEqual([70, 210])
  })

  it('bounds the cache but keeps the pages a pending window covers', () => {
    const { window, serve, core, reads, answer } = fixture({ cachePages: 2 })
    window(0, 64)
    serve(1)
    window(64, 64)
    serve(2)
    window(128, 64)
    serve(3)
    expect(core.cachedPages).toBe(2)
    // The oldest page went first: rows 0–63 must be read again.
    const id = window(0, 192)
    expect(reads().at(-1)).toMatchObject({ firstRow: 0, maxRows: 64 })
    serve(4)
    expect(answer(id)?.type === 'window' && (answer(id) as { count: number }).count).toBe(192)
    expect(core.cachedPages).toBe(3)
  })

  it('answers a window whose pages outgrow the cache with the rows it has, instead of holding them all', () => {
    const pageBytes = page(64, 64).byteLength
    const { window, serve, core, reads, sent, answer } = fixture({ cacheBytes: Math.floor(pageBytes * 2.5) })
    const id = window(0, 640)
    serve(reads()[0].rid)
    const result = answer(id)
    expect(result?.type === 'window' && result.count).toBe(192)
    expect(sent).toContainEqual({ t: 'cancel', rid: 1 })
    expect(core.cachedBytes).toBeLessThanOrEqual(Math.floor(pageBytes * 2.5))
    // The rest is read by the next window, as for rows not sealed yet.
    const next = window(192, 448)
    expect(reads().at(-1)).toMatchObject({ firstRow: 192 })
    expect(answer(next)).toBeUndefined()
  })

  it('waits for rows a read in flight brings instead of reading them again, and decodes a repeated page once', () => {
    const { window, reads, core, sent, answer } = fixture()
    const first = window(0, 128)
    const second = window(64, 128)
    expect(reads().map(read => [read.firstRow, read.maxRows])).toEqual([[0, 128], [128, 64]])
    const body = page(0, 64)
    core.receive({ t: 'page', rid: 1, seq: 1, body })
    core.receive({ t: 'page', rid: 1, seq: 2, body: page(64, 64) })
    core.receive({ t: 'end', rid: 1, ok: true, result: { nextRow: 128, rowsAvailable: 192, complete: false, pages: 2, rows: 128 } })
    // A page that arrives again (a boundary page of an adjacent read) is credited but not cached twice.
    core.receive({ t: 'page', rid: 2, seq: 1, body: page(64, 64) })
    core.receive({ t: 'page', rid: 2, seq: 2, body: page(128, 64) })
    core.receive({ t: 'end', rid: 2, ok: true, result: { nextRow: 192, rowsAvailable: 192, complete: true, pages: 2, rows: 128 } })
    expect(core.cachedPages).toBe(3)
    expect(sent.filter(request => request.t === 'credit')).toHaveLength(4)
    expect([answer(first), answer(second)].map(result => result?.type === 'window' && result.count)).toEqual([128, 128])
  })

  it('fails pending work when the backend generation changes, and refuses the old generation afterwards', () => {
    const { window, core, posted, serve, answer } = fixture()
    window(0, 64)
    serve(1)
    const pending = window(64, 64)
    core.receive({ t: 'backend', generation: 2, status: 'starting' })
    expect(answer(pending)).toEqual({ type: 'error', id: pending, code: 'RESULT_UNAVAILABLE', message: 'These results are no longer available because the SQL backend restarted.' })
    expect(core.cachedPages).toBe(0)
    const later = window(0, 10)
    expect(answer(later)).toMatchObject({ type: 'error', code: 'RESULT_UNAVAILABLE' })
    expect(posted.filter(message => message.type === 'backend').map(message => message.type === 'backend' && message.generation)).toEqual([1, 2])
  })

  it('contains an invalid page: the read ends with PAGE_INVALID, nothing is cached, and the worker keeps serving', () => {
    const { window, core, sent, answer, serve } = fixture()
    const id = window(0, 64)
    const corrupt = new Uint8Array(page(0, 64))
    corrupt[corrupt.length - 1] ^= 0xff
    corrupt[20] = 0xff
    core.receive({ t: 'page', rid: 1, seq: 1, body: corrupt.buffer })
    expect(answer(id)).toMatchObject({ type: 'error', code: 'PAGE_INVALID' })
    expect(sent.filter(request => request.t === 'cancel')).toEqual([{ t: 'cancel', rid: 1 }])
    expect(core.cachedPages).toBe(0)
    // A page of another result is just as invalid for this read.
    const other = window(0, 64)
    core.receive({ t: 'page', rid: 2, seq: 1, body: page(0, 64, 6) })
    expect(answer(other)).toMatchObject({ type: 'error', code: 'PAGE_INVALID' })
    const good = window(0, 64)
    serve(3)
    expect(answer(good)).toMatchObject({ type: 'window', count: 64 })
  })

  it('reads a full cell, closes results, forwards query events, and reports a missing port', () => {
    const { core, window, serve, sent, posted } = fixture()
    window(0, 64)
    serve(1)
    core.handle({ type: 'cell', id: 50, key, wires, row: 5, col: 1 })
    expect(posted.at(-1)).toEqual({ type: 'cell', id: 50, text: 'name 5', isNull: false, truncated: false, error: false, formatted: false })
    core.handle({ type: 'close', id: 51, generation: 1, resultIds: [5] })
    expect(sent.at(-1)).toEqual({ t: 'close', rid: 2, generation: 1, resultIds: [5] })
    expect(core.cachedPages).toBe(0)
    core.receive({ t: 'end', rid: 2, ok: true, result: { closed: 1, usedBytes: 0 } })
    expect(posted.at(-1)).toEqual({ type: 'closed', id: 51, closed: 1, usedBytes: 0 })
    core.receive({ t: 'query', queryId: 'q', event: { type: 'messages', messages: [{ text: 'hello', kind: 'info' }] } })
    core.receive({ t: 'memory', usedBytes: 1, globalBytes: 2 })
    expect(posted.slice(-2)).toEqual([{ type: 'query', queryId: 'q', event: { type: 'messages', messages: [{ text: 'hello', kind: 'info' }] } }, { type: 'memory', usedBytes: 1, globalBytes: 2 }])
    const detached = new ResultsWorkerCore({ post: message => { posted.push(message) } })
    detached.handle({ type: 'window', id: 60, key, wires, first: 0, count: 1, colStart: 0, colEnd: 3, maxCellChars: 10, textBudget: 10 })
    expect(posted.at(-1)).toMatchObject({ type: 'error', id: 60, code: 'PORT_CLOSED' })
  })

  it('formats a whole XML or JSON value in the worker, but never a stored prefix, a NULL, a read error, or malformed text', () => {
    const documentWires: WireKind[] = ['text']
    const values: PageCell[] = ['<a><b>1</b><b>x</b></a>', '{"a":[1,2.50,{"b":null}]}', { value: '<a><b>', truncated: true }, null, { error: true }, '<a><b></a>', 'x'.repeat(70_000)]
    const posted: WorkerResponse[] = [], sent: PortRequest[] = []
    const core = new ResultsWorkerCore({ post: message => { posted.push(message) } })
    core.attach({ postMessage: message => { sent.push(message as PortRequest) } })
    core.receive({ t: 'backend', generation: 1, status: 'ready' })
    const cell = (row: number, format?: 'xml' | 'json') => {
      core.handle({ type: 'cell', id: 100 + row, key, wires: documentWires, row, col: 0, ...format ? { format } : {} })
      const read = sent.findLast(request => request.t === 'read')
      if (read?.t === 'read' && !posted.some(message => 'id' in message && message.id === 100 + row)) {
        const bytes = encodePage({ resultId: 5, firstRow: 0, columns: [{ wire: 'text' }], rows: values.map(value => [value]) })
        core.receive({ t: 'page', rid: read.rid, seq: 1, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })
        core.receive({ t: 'end', rid: read.rid, ok: true, result: { nextRow: values.length, rowsAvailable: values.length, complete: true, pages: 1, rows: values.length } })
      }
      return posted.find(message => 'id' in message && message.id === 100 + row)
    }
    expect(cell(0, 'xml')).toEqual({ type: 'cell', id: 100, text: '<a>\n  <b>1</b>\n  <b>x</b>\n</a>', isNull: false, truncated: false, error: false, formatted: true })
    expect(cell(1, 'json')).toMatchObject({ text: '{\n  "a": [\n    1,\n    2.50,\n    {\n      "b": null\n    }\n  ]\n}', formatted: true })
    expect(cell(2, 'xml')).toMatchObject({ text: '<a><b>', truncated: true, formatted: false })
    expect(cell(3, 'xml')).toMatchObject({ text: '', isNull: true, error: false, formatted: false })
    expect(cell(4, 'xml')).toMatchObject({ text: '', isNull: true, error: true, formatted: false })
    expect(cell(5, 'xml')).toMatchObject({ text: '<a><b></a>', formatted: false })
    // Without a format the whole value comes back as stored, beyond any display cap.
    expect(cell(6)).toMatchObject({ formatted: false, truncated: false })
    expect((cell(6) as { text: string }).text).toHaveLength(70_000)
  })

  it('bounds windows to 4,096 rows and 262,144 cells', () => {
    const { window, reads } = fixture()
    window(0, 100_000)
    expect(reads()[0].maxRows).toBe(4096)
    const wide = Array.from({ length: 200 }, () => 'text' as const)
    const { core, reads: wideReads } = fixture()
    core.handle({ type: 'window', id: 1, key, wires: wide, first: 0, count: 4096, colStart: 0, colEnd: 200, maxCellChars: 10, textBudget: 10 })
    expect(wideReads()[0].maxRows).toBe(Math.floor(262_144 / 200))
  })
  it('gives grid text in display mode: one space for each line break or tab, U+FFFD for other control characters', () => {
    const posted: WorkerResponse[] = []
    const core = new ResultsWorkerCore({ post: message => { posted.push(message) } })
    core.attach({ postMessage: () => {} })
    core.receive({ t: 'backend', generation: 1, status: 'ready' })
    const texts = ['a\r\nb\rc\nd\te', 'bell\x07del\x7f', 'line para ', 'plain', 'x'.repeat(20)]
    const body = encodePage({ resultId: 5, firstRow: 0, columns: [{ wire: 'text' }], rows: texts.map(text => [text]) })
    for (const [id, display] of [[1, true], [2, false]] as const) {
      core.handle({ type: 'window', id, key, wires: ['text'], first: 0, count: 5, colStart: 0, colEnd: 1, maxCellChars: 10, textBudget: 1000, display })
      if (id === 1) {
        core.receive({ t: 'page', rid: 1, seq: 1, body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer })
        core.receive({ t: 'end', rid: 1, ok: true, result: { nextRow: 5, rowsAvailable: 5, complete: true, pages: 1, rows: 5 } })
      }
    }
    const [shown, raw] = [1, 2].map(id => posted.find(message => 'id' in message && message.id === id)) as Extract<WorkerResponse, { type: 'window' }>[]
    expect(shown.text).toEqual(['a b c d e', 'bell�del�', 'line�para�', 'plain', 'x'.repeat(10)])
    // Cut at maxCellChars is its own flag (16); 2 means the backend stored a prefix.
    expect([...shown.flags]).toEqual([0, 0, 0, 0, 16])
    expect(raw.text[0]).toBe('a\r\nb\rc\nd\te')
  })

  it('measures the widest display text of each column, NULL as its 4 letters and wide characters as 2', () => {
    const posted: WorkerResponse[] = []
    const core = new ResultsWorkerCore({ post: message => { posted.push(message) } })
    core.attach({ postMessage: () => {} })
    core.receive({ t: 'backend', generation: 1, status: 'ready' })
    const mixed: WireKind[] = ['text', 'text', 'binary']
    const rows: PageCell[][] = [['ab', '日本', null], [null, 'é', new Uint8Array([1, 2])], ['x'.repeat(600), null, null]]
    core.handle({ type: 'measure', id: 7, key, wires: mixed, first: 0, count: 3, colStart: 0, colEnd: 3 })
    const body = encodePage({ resultId: 5, firstRow: 0, columns: mixed.map(wire => ({ wire })), rows })
    core.receive({ t: 'page', rid: 1, seq: 1, body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer })
    core.receive({ t: 'end', rid: 1, ok: true, result: { nextRow: 3, rowsAvailable: 3, complete: true, pages: 1, rows: 3 } })
    const answer = posted.find(message => message.type === 'measure')
    expect(answer).toEqual({ type: 'measure', id: 7, rows: 3, widths: Uint16Array.of(512, 4, 6) })
    core.handle({ type: 'stats', id: 8 })
    expect(posted.at(-1)).toEqual({ type: 'stats', id: 8, bytes: core.cachedBytes, pages: 1 })
  })
})
