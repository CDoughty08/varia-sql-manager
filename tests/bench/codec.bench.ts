import { expect, it } from 'vitest'
import { decodeControl, encodeControl } from '../../src/shared/ipc/wire/msgpack'
import { FrameKind, FrameParser, encodeFrame } from '../../src/shared/ipc/wire/frames'
import { decodePage, encodePage } from '../../src/shared/ipc/wire/pages'
import { CELL_NULL, cellFlags, cellText, runText, textRun } from '../../src/shared/ipc/wire/cells'
import { limits } from '../../src/shared/ipc/wire/protocol'
import { mbPerSecond, median, rate, record, w1Row } from './harness'

// The codecs on their own, in one thread: control bodies, frame parsing, and page decoding as the results worker does it.

it('encodes and decodes a 1 KiB control map', () => {
  // A query summary's descriptor: the kind of control body main decodes most.
  const column = (name: string, dataType: string) => ({ name, dataType, wire: 'text', nullable: true, maxLength: 200, precision: 0, scale: 0 })
  const value = {
    result: {
      resultId: 12, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', rowsRead: 123_456, rowsStored: 123_456, rowsAvailable: 120_000,
      bytesStored: 27_000_000, truncatedCells: 0, state: 'open', incomplete: false,
      columns: [column('id', 'int'), column('name', 'nvarchar'), column('created', 'datetime2'), column('amount', 'decimal'), column('key', 'uniqueidentifier'),
        column('note', 'nvarchar'), column('active', 'bit'), column('score', 'int'), column('region', 'nvarchar'), column('owner', 'sysname')]
    }
  }
  const bytes = encodeControl(value)
  expect(bytes.length).toBeGreaterThan(900)
  expect(bytes.length).toBeLessThan(1150)
  expect(decodeControl(bytes)).toEqual(value)
  const ops = rate(() => decodeControl(encodeControl(value)), { batch: 50 })
  record({ id: 'node.control.opsPerSecond', value: ops, unit: 'ops/s', detail: `${bytes.length}-byte map, encode + decode` })
})

it('parses frames of mixed sizes from 64 KiB chunks', () => {
  // Responses, events and 256 KiB pages, as main receives them during a large read.
  const response = encodeFrame(FrameKind.RESPONSE, 1, 0, encodeControl({ result: { ok: true, rows: 4096 } }))
  const event = encodeFrame(FrameKind.EVENT, 2, 0, encodeControl({ type: 'messages', messages: Array.from({ length: 20 }, (_, i) => `(${i} rows affected)`.repeat(4)) }))
  const page = encodeFrame(FrameKind.DATA, 3, 1, new Uint8Array(limits.page.sealBytes).fill(7))
  const pattern = [response, event, page, response, page, event, response]
  const frames: Uint8Array[] = []
  let total = 0
  while (total < 64 * 1024 * 1024) for (const frame of pattern) { frames.push(frame); total += frame.length }
  const stream = new Uint8Array(total)
  let at = 0
  for (const frame of frames) { stream.set(frame, at); at += frame.length }
  const chunkBytes = 64 * 1024
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < stream.length; offset += chunkBytes) chunks.push(stream.subarray(offset, offset + chunkBytes))
  const parse = () => {
    const parser = new FrameParser({ maxBody: limits.responseBody, direction: 'toMain' })
    let count = 0
    const started = performance.now()
    for (const chunk of chunks) count += parser.push(chunk).length
    const elapsed = performance.now() - started
    parser.end()
    expect(count).toBe(frames.length)
    return elapsed
  }
  parse()
  const ms = median(Array.from({ length: 5 }, parse))
  record({ id: 'node.frames.mbPerSecond', value: mbPerSecond(total, ms), unit: 'MB/s', detail: `${(total / 1024 / 1024).toFixed(0)} MiB in ${chunks.length} chunks` })
})

it('decodes a W1 page and the text of every cell', () => {
  const columns = Array.from({ length: 8 }, () => ({ wire: 'text' as const }))
  // A page is sealed at 256 KiB, so a W1 page holds about 1,200 rows.
  const rows: (string | null)[][] = []
  for (let row = 0, bytes = 0; bytes < limits.page.sealBytes; row++) {
    const cells = w1Row(1_000_000 + row)
    rows.push(cells)
    bytes += cells.reduce((sum, cell) => sum + (cell === null ? 0 : Buffer.byteLength(cell)), 0) + 32
  }
  const encoded = encodePage({ resultId: 1, firstRow: 0, columns, rows })
  const body = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
  let characters = 0
  // As the results worker builds a window: each column's small ASCII cells decoded as one run.
  const decodeAll = () => {
    const view = decodePage(body, columns)
    const runs = columns.map((_, column) => textRun(view, column, 0, view.rowCount))
    characters = 0
    for (let row = 0; row < view.rowCount; row++) {
      for (let column = 0; column < columns.length; column++) {
        if ((cellFlags(view, column, row) & CELL_NULL) !== 0) continue
        const run = runs[column]
        characters += (run ? runText(run, view, column, row, 1024) : cellText(view, column, row, 1024)).text.length
      }
    }
  }
  decodeAll()
  expect(characters).toBeGreaterThan(rows.length * 150)
  const pages = rate(decodeAll, { batch: 5 })
  record({ id: 'node.page.mbPerSecond', value: pages * body.byteLength / 1e6, unit: 'MB/s', detail: `${rows.length} rows, ${(body.byteLength / 1024).toFixed(0)} KiB page, every cell decoded` })
})
