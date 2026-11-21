// The results worker's page cache keeps no page another page holds whole, so a windowed block fetched again, its pages
// broken at other rows, never counts the same rows twice.
import { describe, expect, it } from 'vitest'
import { ResultsWorkerCore } from '../src/renderer/src/results/worker-core'
import type { WorkerResponse } from '../src/renderer/src/results/worker-protocol'
import type { WireKind } from '../src/shared/contracts'
import type { PortRequest } from '../src/shared/ipc/port-messages'
import { encodePage, type PageCell } from '../src/shared/ipc/wire/pages'

const wires: WireKind[] = ['text', 'text', 'binary']
const key = { generation: 1, resultId: 5 }
const cells = (row: number): PageCell[] => [String(row), row % 4 === 3 ? null : 'name ' + row, new Uint8Array([row & 0xff, 0xab])]
const page = (firstRow: number, rows: number): ArrayBuffer => {
  const bytes = encodePage({ resultId: 5, firstRow, columns: wires.map(wire => ({ wire })), rows: Array.from({ length: rows }, (_, index) => cells(firstRow + index)) })
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
function fixture() {
  const posted: WorkerResponse[] = []
  const sent: PortRequest[] = []
  const core = new ResultsWorkerCore({ post: message => { posted.push(message) } })
  core.attach({ postMessage: message => { sent.push(message as PortRequest) } })
  core.receive({ t: 'backend', generation: 1, status: 'ready' })
  let id = 1
  const window = (first: number, count: number) => {
    const request = { type: 'window' as const, id: id++, key, wires, first, count, colStart: 0, colEnd: 3, maxCellChars: 1024, textBudget: 1_000_000 }
    core.handle(request)
    return request.id
  }
  const reads = () => sent.filter((request): request is Extract<PortRequest, { t: 'read' }> => request.t === 'read')
  const end = (rid: number, nextRow: number) => core.receive({ t: 'end', rid, ok: true, result: { nextRow, rowsAvailable: 10_000, complete: false, pages: 1, rows: 1 } })
  return { core, posted, sent, window, reads, end }
}

describe('the results worker page cache', () => {
  it('drops a cached page that a longer page from an earlier row holds whole, ending at the same row', () => {
    const { window, reads, core, end } = fixture()
    // A windowed block's page [100,200) is cached; the block fetched again breaks its pages at row 50: [50,200).
    window(100, 50)
    core.receive({ t: 'page', rid: 1, seq: 1, body: page(100, 100) })
    end(1, 200)
    window(50, 10)
    const read = reads().at(-1)!
    core.receive({ t: 'page', rid: read.rid, seq: 1, body: page(50, 150) })
    end(read.rid, 200)
    // [100,200) lies wholly inside [50,200), so it goes: one page, counted once.
    const alone = fixture()
    alone.window(50, 150)
    alone.core.receive({ t: 'page', rid: 1, seq: 1, body: page(50, 150) })
    alone.end(1, 200)
    expect(core.cachedPages).toBe(1)
    expect(core.cachedBytes).toBe(alone.core.cachedBytes)
  })
})
