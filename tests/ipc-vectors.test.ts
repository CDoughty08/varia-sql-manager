import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { DecodeError, decodeControl, encodeControl } from '../src/shared/ipc/wire/msgpack.ts'
import { FrameParser, ProtocolError, type FrameDirection } from '../src/shared/ipc/wire/frames.ts'
import { PageFormatError, decodePage, type WireKind } from '../src/shared/ipc/wire/pages.ts'
import { CELL_NULL, cellFlags, cellText } from '../src/shared/ipc/wire/cells.ts'

interface ControlVector { name: string; hex: string; value?: unknown; reencoded?: string; error?: string }
interface FrameVector { name: string; direction: FrameDirection; hex: string; kind?: number; id?: number; arg?: number; length?: number; error?: string }
interface PageVector { name: string; hex: string; wires: WireKind[]; resultId?: number; firstRow?: number; rows?: [string | null, number][][]; error?: string }
const vectors = JSON.parse(readFileSync('tests/fixtures/ipc-vectors.json', 'utf8')) as { control: ControlVector[]; frames: FrameVector[]; pages: PageVector[] }
const bytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'))
const hexOf = (value: Uint8Array): string => Buffer.from(value).toString('hex')
const codeOf = (action: () => unknown): string | undefined => {
  try { action() } catch (error) {
    if (error instanceof DecodeError || error instanceof ProtocolError || error instanceof PageFormatError) return error.code
    throw error
  }
  return undefined
}

describe('shared IPC vectors', () => {
  it('has a broad set of control, frame, and page vectors', () => {
    expect(vectors.control.length + vectors.frames.length + vectors.pages.length).toBeGreaterThanOrEqual(120)
    expect(new Set([...vectors.control, ...vectors.frames, ...vectors.pages].map(vector => vector.name)).size).toBe(vectors.control.length + vectors.frames.length + vectors.pages.length)
  })
  it.each(vectors.control.filter(vector => vector.error === undefined).map(vector => [vector.name, vector] as const))('decodes and canonically re-encodes control vector: %s', (_, vector) => {
    const value = decodeControl(bytes(vector.hex))
    expect(value).toEqual(vector.value)
    expect(hexOf(encodeControl(value))).toBe(vector.reencoded ?? vector.hex)
  })
  it.each(vectors.control.filter(vector => vector.error !== undefined).map(vector => [vector.name, vector] as const))('rejects control vector: %s', (_, vector) => {
    expect(codeOf(() => decodeControl(bytes(vector.hex)))).toBe(vector.error)
  })
  it.each(vectors.frames.map(vector => [vector.name, vector] as const))('parses frame vector: %s', (_, vector) => {
    const parser = new FrameParser({ maxBody: 16 * 1024 * 1024, direction: vector.direction })
    const code = codeOf(() => {
      const frames = parser.push(bytes(vector.hex))
      parser.end()
      expect(frames).toHaveLength(1)
      const [frame] = frames
      expect(frame.oversize).toBeFalsy()
      if (frame.oversize) return
      expect({ kind: frame.kind, id: frame.id, arg: frame.arg, length: frame.body.length }).toEqual({ kind: vector.kind, id: vector.id, arg: vector.arg, length: vector.length })
      expect(hexOf(frame.body)).toBe(vector.hex.slice(32))
    })
    expect(code).toBe(vector.error)
  })
  it.each(vectors.pages.map(vector => [vector.name, vector] as const))('decodes page vector: %s', (_, vector) => {
    const code = codeOf(() => {
      const view = decodePage(bytes(vector.hex), vector.wires.map(wire => ({ wire })))
      expect({ resultId: view.resultId, firstRow: view.firstRow }).toEqual({ resultId: vector.resultId, firstRow: vector.firstRow })
      const rows = Array.from({ length: view.rowCount }, (_, row) => vector.wires.map((__, column) => {
        const flags = cellFlags(view, column, row)
        return [flags & CELL_NULL ? null : cellText(view, column, row).text, flags]
      }))
      expect(rows).toEqual(vector.rows)
    })
    expect(code).toBe(vector.error)
  })
})
