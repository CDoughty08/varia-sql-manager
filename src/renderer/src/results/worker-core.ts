// The results worker's logic, free of `self` so it runs in Node tests (tests/results-worker.test.ts). It reads pages
// from main through the results port, validates and caches them (decodePage), and answers the UI's windows and cells
// with display text decoded only for the cells asked for.
import type { BackendStatus, ResultsCloseResult, WireKind } from '../../../shared/contracts'
import type { PortEndResult, PortMessage, PortRequest } from '../../../shared/ipc/port-messages'
import { decodePage, PageFormatError, type PageView } from '../../../shared/ipc/wire/pages'
import { CELL_ERROR, CELL_NULL, cellFlags, cellSlice, cellText, displayText, runSlice, textRun, type TextRun } from '../../../shared/ipc/wire/cells'
import { limits as wire, type ErrorCode } from '../../../shared/ipc/wire/protocol'
import { gridLimits as g } from '../grid/constants'
import { displayColumns } from '../grid/measure'
import { formatJson, formatXml } from './doc-format'
import { FLAG_CAPPED, FLAG_OVER_BUDGET, type MeasureRequest, type ResultKey, type ValueFormat, type WindowRequest, type WorkerRequest, type WorkerResponse } from './worker-protocol'

/** The parts of a MessagePort the core uses. */
export interface PortLike { postMessage(message: unknown): void }
export interface WorkerLimits {
  cacheBytes: number
  cachePages: number
  windowRows: number
  windowCells: number
  windowCharacters: number
  documentCharacters: number
  readCredit: number
  readRows: number
}
export const workerLimits: WorkerLimits = {
  cacheBytes: wire.worker.cacheBytes, cachePages: wire.worker.cachePages, windowRows: wire.worker.windowRows, windowCells: wire.worker.windowCells,
  windowCharacters: wire.worker.windowCharacters, documentCharacters: wire.cell.document, readCredit: wire.credit.workerDefault, readRows: 65_536
}
export const resultUnavailable = 'These results are no longer available because the SQL backend restarted.'

interface CachedPage { readonly id: string; readonly result: string; readonly firstRow: number; readonly rowCount: number; readonly view: PageView; readonly bytes: number }
interface Read { readonly rid: number; readonly key: ResultKey; readonly result: string; readonly wires: readonly WireKind[]; readonly firstRow: number; readonly end: number; readonly waiters: Set<Waiter>; cancelled: boolean }
/** A window, cell or prefetch waiting for reads. Prefetches have no id and are never answered. */
interface Waiter {
  readonly id: number | undefined
  readonly key: ResultKey
  readonly result: string
  readonly wires: readonly WireKind[]
  readonly first: number
  readonly count: number
  readonly reads: Set<Read>
  readonly settle: () => void
}

const resultOf = (key: ResultKey): string => `${key.generation}:${key.resultId}`

/** A page's firstRow from its header (array(7) of uints: version, resultId, firstRow, …), or undefined when the
 *  header is not in that canonical form; decodePage validates everything properly. */
function pageFirstRow(body: ArrayBuffer): number | undefined {
  const bytes = new Uint8Array(body, 0, Math.min(body.byteLength, 32))
  let at = 1
  const uint = (): number | undefined => {
    const tag = bytes[at]
    if (tag === undefined) return undefined
    if (tag < 0x80) { at += 1; return tag }
    const size = tag === 0xcc ? 1 : tag === 0xcd ? 2 : tag === 0xce ? 4 : tag === 0xcf ? 8 : 0
    if (size === 0 || at + 1 + size > bytes.length) return undefined
    let value = 0
    for (let index = 1; index <= size; index++) value = value * 256 + bytes[at + index]
    at += 1 + size
    return value
  }
  if (bytes[0] !== 0x97) return undefined
  uint()
  uint()
  return uint()
}

/**
 * Pages are cached per (generation, resultId, firstRow) in an LRU bounded at 64 MiB and 512 pages; pages that a pending
 * window still needs are never evicted, so once those alone pass 64 MiB, windows that already have rows answer with
 * them (a shorter window, as when rows are not sealed yet). Missing rows are fetched with one read per contiguous gap
 * (4 MiB of credit); rows a read in flight will bring are not read again, and a read nobody waits for any more is
 * cancelled. Credit is granted only after a page is decoded and cached, so a slow UI slows the stream, never the query.
 * A page that fails validation ends its read with PAGE_INVALID and is not cached; the worker keeps going. A new backend
 * generation fails everything pending with RESULT_UNAVAILABLE and drops the older generations' pages.
 */
export class ResultsWorkerCore {
  private readonly post: (message: WorkerResponse, transfer?: Transferable[]) => void
  private readonly limits: WorkerLimits
  private readonly cache = new Map<string, CachedPage>()
  private readonly indexes = new Map<string, CachedPage[]>()
  private readonly reads = new Map<number, Read>()
  private readonly waiters = new Map<number, Waiter>()
  private readonly prefetches = new Set<Waiter>()
  private readonly closes = new Map<number, number>()
  private port: PortLike | undefined
  private generation = 0
  private cacheBytes = 0
  private nextRid = 1

  constructor(o: { post: (message: WorkerResponse, transfer?: Transferable[]) => void; limits?: Partial<WorkerLimits> }) {
    this.post = o.post
    this.limits = { ...workerLimits, ...o.limits }
  }

  get cachedPages(): number { return this.cache.size }
  get cachedBytes(): number { return this.cacheBytes }
  get pendingReads(): number { return this.reads.size }

  /** The port main sent; a new one replaces the old (after a worker restart, the page reopens it). */
  attach(port: PortLike): void { this.port = port }

  handle(request: WorkerRequest): void {
    switch (request.type) {
      case 'attach': return
      case 'window': return this.window(request)
      case 'cell': return this.cell(request.id, request.key, request.wires, request.row, request.col, request.format)
      case 'prefetch': return this.prefetch(request.key, request.wires, request.first, request.count)
      case 'cancel': return this.cancel(request.id)
      case 'close': return this.close(request.id, request.generation, request.resultIds)
      case 'measure': return this.measure(request)
      case 'stats': this.post({ type: 'stats', id: request.id, bytes: this.cacheBytes, pages: this.cache.size }); return
    }
  }

  /** A message from main on the results port. */
  receive(message: PortMessage): void {
    switch (message.t) {
      case 'backend': return this.backend(message.generation, message.status)
      case 'page': return this.page(message.rid, message.body)
      case 'end': return message.ok ? this.ended(message.rid, message.result) : this.failed(message.rid, message.code, message.message)
      case 'query': this.post({ type: 'query', queryId: message.queryId, event: message.event }); return
      case 'memory': this.post({ type: 'memory', usedBytes: message.usedBytes, globalBytes: message.globalBytes, generation: message.generation, seq: message.seq }); return
    }
  }

  private send(request: PortRequest): void { this.port?.postMessage(request) }

  private error(id: number | undefined, code: ErrorCode, message: string): void {
    if (id !== undefined) this.post({ type: 'error', id, code, message })
  }

  /** Requests for another generation than the current one can never be served. Before the first backend message the
   *  generation is unknown, and main checks it. */
  private stale(key: ResultKey): boolean { return this.generation !== 0 && key.generation !== this.generation }

  private window(request: WindowRequest): void {
    const columns = request.wires.length
    const colStart = Math.max(0, Math.min(columns, request.colStart))
    const colEnd = Math.max(colStart, Math.min(columns, request.colEnd))
    const width = Math.max(1, colEnd - colStart)
    const count = Math.max(0, Math.min(request.count, this.limits.windowRows, Math.floor(this.limits.windowCells / width)))
    const bounded: WindowRequest = { ...request, colStart, colEnd, count, first: Math.max(0, request.first),
      textBudget: Math.max(0, Math.min(request.textBudget, this.limits.windowCharacters)), maxCellChars: Math.max(0, Math.min(request.maxCellChars, this.limits.documentCharacters)) }
    this.wait(request.id, request.key, request.wires, bounded.first, count, () => {
      const rows = this.covered(resultOf(request.key), bounded.first, count)
      const { text, flags } = this.build(bounded, rows)
      this.post({ type: 'window', id: request.id, first: bounded.first, count: rows, colStart, colEnd, text, flags }, [flags.buffer])
    })
  }

  /** The widest display text per column over the rows asked for (those cached once the reads end), in monospace
   *  columns up to 512; NULL counts as its 4 letters. The grid sizes columns from it. */
  private measure(request: MeasureRequest): void {
    const columns = request.wires.length
    const colStart = Math.max(0, Math.min(columns, request.colStart)), colEnd = Math.max(colStart, Math.min(columns, request.colEnd))
    const width = Math.max(1, colEnd - colStart)
    const first = Math.max(0, request.first), count = Math.max(0, Math.min(request.count, this.limits.windowRows, Math.floor(this.limits.windowCells / width)))
    this.wait(request.id, request.key, request.wires, first, count, () => {
      const result = resultOf(request.key), rows = this.covered(result, first, count), cap = g.measureCap
      const widths = new Uint16Array(colEnd - colStart)
      const bounds: WindowRequest = { type: 'window', id: request.id, key: request.key, wires: request.wires, first, count: rows, colStart, colEnd, maxCellChars: cap, textBudget: Number.POSITIVE_INFINITY }
      let page: CachedPage | undefined
      let runs: (TextRun | undefined)[] = []
      for (let r = 0; r < rows; r++) {
        const row = first + r
        if (!page || row >= page.firstRow + page.rowCount) {
          page = this.pageAt(result, row)!
          this.touch(page)
          runs = this.runs(page.view, row - page.firstRow, Math.min(page.rowCount, row - page.firstRow + rows - r), bounds, Number.POSITIVE_INFINITY)
        }
        const local = row - page.firstRow
        for (let column = colStart; column < colEnd; column++) {
          const at = column - colStart
          if (widths[at] >= cap) continue
          if ((cellFlags(page.view, column, local) & CELL_NULL) !== 0) { if (widths[at] < 4) widths[at] = 4; continue }
          const run = runs[at]
          const text = (run ? runSlice(run, page.view, column, local, cap) : cellSlice(page.view, column, local, cap)).text
          const columnsWide = displayColumns(displayText(text), cap)
          if (columnsWide > widths[at]) widths[at] = columnsWide
        }
      }
      this.post({ type: 'measure', id: request.id, rows, widths }, [widths.buffer])
    })
  }

  /** A whole stored value. Formatting runs here, off the UI thread; a value stored as a prefix is never formatted. */
  private cell(id: number, key: ResultKey, wires: readonly WireKind[], row: number, col: number, format?: ValueFormat): void {
    this.wait(id, key, wires, row, 1, () => {
      const page = this.pageAt(resultOf(key), row)
      if (!page || col < 0 || col >= wires.length) return this.error(id, 'RESULT_UNAVAILABLE', 'That row is not available.')
      this.touch(page)
      const flags = cellFlags(page.view, col, row - page.firstRow)
      const isNull = (flags & CELL_NULL) !== 0, error = (flags & CELL_ERROR) !== 0
      const value = isNull || error ? { text: '', truncated: false } : cellText(page.view, col, row - page.firstRow)
      const shown = format && value.text && !value.truncated ? (format === 'json' ? formatJson : formatXml)(value.text) : { text: value.text, formatted: false }
      this.post({ type: 'cell', id, text: shown.text, isNull, truncated: value.truncated, error, formatted: shown.formatted })
    })
  }

  private prefetch(key: ResultKey, wires: readonly WireKind[], first: number, count: number): void {
    this.wait(undefined, key, wires, Math.max(0, first), Math.max(0, Math.min(count, this.limits.readRows)), () => {})
  }

  private wait(id: number | undefined, key: ResultKey, wires: readonly WireKind[], first: number, count: number, answer: () => void): void {
    if (this.stale(key)) return this.error(id, 'RESULT_UNAVAILABLE', resultUnavailable)
    const result = resultOf(key)
    const waiter: Waiter = { id, key, result, wires, first, count, reads: new Set(), settle: () => { this.forget(waiter); answer() } }
    const gaps = this.missing(result, first, first + count)
    if (gaps.length === 0) return waiter.settle()
    if (!this.port) return this.error(id, 'PORT_CLOSED', 'The results connection is not open. Reload the workbench.')
    if (id === undefined) this.prefetches.add(waiter)
    else this.waiters.set(id, waiter)
    // Rows a read in flight covers come with it, so they are not read (and sent through main) a second time.
    const flying = [...this.reads.values()].filter(item => !item.cancelled && item.result === result).sort((a, b) => a.firstRow - b.firstRow)
    for (const [start, end] of gaps) {
      let from = start
      while (from < end) {
        const covering = flying.find(item => item.firstRow <= from && item.end > from)
        if (covering) {
          covering.waiters.add(waiter)
          waiter.reads.add(covering)
          from = covering.end
          continue
        }
        const next = flying.find(item => item.firstRow > from)
        const to = Math.min(end, from + this.limits.readRows, next ? next.firstRow : end)
        const read = this.read(key, wires, from, to)
        read.waiters.add(waiter)
        waiter.reads.add(read)
        from = to
      }
    }
  }

  private forget(waiter: Waiter): void {
    if (waiter.id !== undefined && this.waiters.get(waiter.id) === waiter) this.waiters.delete(waiter.id)
    this.prefetches.delete(waiter)
    for (const read of waiter.reads) read.waiters.delete(waiter)
    waiter.reads.clear()
  }

  private read(key: ResultKey, wires: readonly WireKind[], firstRow: number, end: number): Read {
    const rid = this.nextRid
    this.nextRid = this.nextRid >= 2 ** 31 - 1 ? 1 : this.nextRid + 1
    const read: Read = { rid, key, result: resultOf(key), wires, firstRow, end, waiters: new Set(), cancelled: false }
    this.reads.set(rid, read)
    this.send({ t: 'read', rid, generation: key.generation, resultId: key.resultId, firstRow, maxRows: end - firstRow, credit: this.limits.readCredit })
    return read
  }

  /** The UI no longer needs a request; reads nobody else waits for are cancelled. */
  private cancel(id: number): void {
    const waiter = this.waiters.get(id)
    if (!waiter) return
    const reads = [...waiter.reads]
    this.forget(waiter)
    for (const read of reads) this.abandon(read)
  }

  private abandon(read: Read): void {
    if (read.waiters.size > 0 || read.cancelled) return
    read.cancelled = true
    this.send({ t: 'cancel', rid: read.rid })
  }

  private close(id: number, generation: number, resultIds: readonly number[]): void {
    for (const resultId of resultIds) this.drop(resultOf({ generation, resultId }))
    if (!this.port) return this.error(id, 'PORT_CLOSED', 'The results connection is not open. Reload the workbench.')
    const rid = this.nextRid
    this.nextRid = this.nextRid >= 2 ** 31 - 1 ? 1 : this.nextRid + 1
    this.closes.set(rid, id)
    this.send({ t: 'close', rid, generation, resultIds: [...resultIds] })
  }

  private backend(generation: number, status: BackendStatus): void {
    if (generation !== this.generation) {
      this.generation = generation
      for (const waiter of [...this.waiters.values(), ...this.prefetches]) {
        if (waiter.key.generation === generation) continue
        this.forget(waiter)
        this.error(waiter.id, 'RESULT_UNAVAILABLE', resultUnavailable)
      }
      for (const read of this.reads.values()) if (read.key.generation !== generation) read.cancelled = true
      for (const result of [...this.indexes.keys()]) if (!result.startsWith(generation + ':')) this.drop(result)
    }
    this.post({ type: 'backend', generation, status })
  }

  private page(rid: number, body: ArrayBuffer): void {
    const read = this.reads.get(rid)
    if (!read || read.cancelled) return
    // A page another read already brought is credited but not decoded again.
    const firstRow = pageFirstRow(body)
    if (firstRow !== undefined && this.cache.has(`${read.result}:${firstRow}`)) {
      this.send({ t: 'credit', rid, bytes: body.byteLength })
      return
    }
    let view: PageView
    try {
      view = decodePage(body, read.wires.map(kind => ({ wire: kind })))
      if (view.resultId !== read.key.resultId) throw new PageFormatError('HEADER')
    } catch (error) {
      // The page is not cached and its read ends here; nothing else is affected.
      const detail = error instanceof PageFormatError ? error.message : 'Invalid result page.'
      this.abandonRead(read, 'PAGE_INVALID', detail)
      return
    }
    this.store(read, view, body.byteLength)
    this.send({ t: 'credit', rid, bytes: body.byteLength })
    if (this.cacheBytes > this.limits.cacheBytes) this.shorten()
  }

  /** The cache is over its bound with pages that pending windows pin: windows that have rows answer with those now
   *  (shorter windows), their other reads are cancelled, and their pages may then be evicted. */
  private shorten(): void {
    for (const waiter of [...this.waiters.values()]) {
      if (this.cacheBytes <= this.limits.cacheBytes) return
      if (this.covered(waiter.result, waiter.first, waiter.count) === 0) continue
      const reads = [...waiter.reads]
      waiter.settle()
      for (const read of reads) this.abandon(read)
      this.evict()
    }
  }

  private abandonRead(read: Read, code: ErrorCode, message: string): void {
    this.reads.delete(read.rid)
    read.cancelled = true
    this.send({ t: 'cancel', rid: read.rid })
    for (const waiter of [...read.waiters]) {
      const others = [...waiter.reads].filter(item => item !== read)
      this.forget(waiter)
      this.error(waiter.id, code, message)
      for (const other of others) this.abandon(other)
    }
  }

  /** Live subscriptions' ends are not this worker's yet: it never starts one (the live relay comes later). */
  private ended(rid: number, result: PortEndResult): void {
    const close = this.closes.get(rid)
    if (close !== undefined) {
      this.closes.delete(rid)
      const closed = result as ResultsCloseResult
      this.post({ type: 'closed', id: close, closed: closed.closed, usedBytes: closed.usedBytes })
      return
    }
    const read = this.reads.get(rid)
    if (!read) return
    this.reads.delete(rid)
    for (const waiter of [...read.waiters]) {
      waiter.reads.delete(read)
      if (waiter.reads.size === 0) waiter.settle()
    }
  }

  private failed(rid: number, code: ErrorCode, message: string): void {
    const close = this.closes.get(rid)
    if (close !== undefined) {
      this.closes.delete(rid)
      return this.error(close, code, message)
    }
    const read = this.reads.get(rid)
    if (!read) return
    this.reads.delete(rid)
    if (read.cancelled) return
    for (const waiter of [...read.waiters]) {
      const others = [...waiter.reads].filter(item => item !== read)
      this.forget(waiter)
      this.error(waiter.id, code, message)
      for (const other of others) this.abandon(other)
    }
  }

  private store(read: Read, view: PageView, bytes: number): void {
    if (read.key.generation !== this.generation && this.generation !== 0) return
    const id = `${read.result}:${view.firstRow}`
    if (this.cache.has(id)) return
    const page: CachedPage = { id, result: read.result, firstRow: view.firstRow, rowCount: view.rowCount, view, bytes }
    this.cache.set(id, page)
    this.cacheBytes += bytes
    const index = this.indexes.get(read.result) ?? []
    let at = index.length
    while (at > 0 && index[at - 1].firstRow > page.firstRow) at--
    index.splice(at, 0, page)
    this.indexes.set(read.result, index)
    this.evict()
  }

  /** Least recently used pages go first; pages a pending window covers stay. */
  private evict(): void {
    if (this.cacheBytes <= this.limits.cacheBytes && this.cache.size <= this.limits.cachePages) return
    const pending = [...this.waiters.values()]
    for (const page of [...this.cache.values()]) {
      if (this.cacheBytes <= this.limits.cacheBytes && this.cache.size <= this.limits.cachePages) return
      if (pending.some(waiter => waiter.result === page.result && waiter.first < page.firstRow + page.rowCount && waiter.first + waiter.count > page.firstRow)) continue
      this.remove(page)
    }
  }

  private remove(page: CachedPage): void {
    this.cache.delete(page.id)
    this.cacheBytes -= page.bytes
    const index = this.indexes.get(page.result)
    if (!index) return
    const at = index.indexOf(page)
    if (at >= 0) index.splice(at, 1)
    if (index.length === 0) this.indexes.delete(page.result)
  }

  private drop(result: string): void {
    for (const page of [...this.indexes.get(result) ?? []]) this.remove(page)
  }

  private touch(page: CachedPage): void {
    this.cache.delete(page.id)
    this.cache.set(page.id, page)
  }

  /** The cached page holding `row`. */
  private pageAt(result: string, row: number): CachedPage | undefined {
    const index = this.indexes.get(result)
    if (!index) return undefined
    let low = 0, high = index.length - 1
    while (low <= high) {
      const middle = (low + high) >>> 1
      const page = index[middle]
      if (row < page.firstRow) high = middle - 1
      else if (row >= page.firstRow + page.rowCount) low = middle + 1
      else return page
    }
    return undefined
  }

  /** Row ranges in [first, end) that no cached page holds. */
  private missing(result: string, first: number, end: number): [number, number][] {
    const gaps: [number, number][] = []
    const index = this.indexes.get(result) ?? []
    let row = first
    while (row < end) {
      const page = this.pageAt(result, row)
      if (page) { row = page.firstRow + page.rowCount; continue }
      const next = index.find(item => item.firstRow > row)
      const gapEnd = Math.min(end, next ? next.firstRow : end)
      gaps.push([row, gapEnd])
      row = gapEnd
    }
    return gaps
  }

  /** How many rows from `first` are cached without a gap (fewer than asked when the backend had no more rows yet). */
  private covered(result: string, first: number, count: number): number {
    let row = first
    while (row < first + count) {
      const page = this.pageAt(result, row)
      if (!page) break
      row = page.firstRow + page.rowCount
    }
    return Math.min(count, row - first)
  }

  private build(request: WindowRequest, count: number): { text: string[]; flags: Uint8Array } {
    const result = resultOf(request.key)
    const width = request.colEnd - request.colStart
    const text = new Array<string>(count * width)
    const flags = new Uint8Array(count * width)
    let budget = request.textBudget
    let page: CachedPage | undefined
    let runs: (TextRun | undefined)[] = []
    for (let r = 0; r < count; r++) {
      const row = request.first + r
      if (!page || row >= page.firstRow + page.rowCount) {
        page = this.pageAt(result, row)!
        this.touch(page)
        runs = this.runs(page.view, row - page.firstRow, Math.min(page.rowCount, row - page.firstRow + count - r), request, budget)
      }
      const local = row - page.firstRow
      for (let column = request.colStart; column < request.colEnd; column++) {
        const index = r * width + column - request.colStart
        let flag = cellFlags(page.view, column, local)
        if ((flag & CELL_NULL) !== 0) { text[index] = ''; flags[index] = flag; continue }
        if (budget <= 0) { text[index] = ''; flags[index] = flag | FLAG_OVER_BUDGET; continue }
        const cap = Math.min(request.maxCellChars, budget)
        const run = runs[column - request.colStart]
        const cell = run ? runSlice(run, page.view, column, local, cap) : cellSlice(page.view, column, local, cap)
        if (cell.cut) flag |= cap < request.maxCellChars ? FLAG_OVER_BUDGET : FLAG_CAPPED
        text[index] = request.display ? displayText(cell.text) : cell.text
        flags[index] = flag
        budget -= cell.text.length
      }
    }
    return { text, flags }
  }

  /** Text runs for the window's rows [from, to) of one page, per requested column. A run is decoded only when that
   *  costs no more than decoding its cells one by one could (within the cell cap and the remaining text budget). */
  private runs(view: PageView, from: number, to: number, request: WindowRequest, budget: number): (TextRun | undefined)[] {
    const runs: (TextRun | undefined)[] = []
    for (let column = request.colStart; column < request.colEnd; column++) {
      const offsets = view.columns[column].offsets
      const bytes = offsets[to] - offsets[from]
      runs.push(bytes > 0 && bytes <= Math.min((to - from) * request.maxCellChars, budget) ? textRun(view, column, from, to) : undefined)
    }
    return runs
  }
}
