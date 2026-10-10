import { describe, expect, it } from 'vitest'
import { FrameKind, FrameParser, HEADER_BYTES, ProtocolError, encodeFrame, type FrameDirection, type ParsedFrame } from '../src/shared/ipc/wire/frames.ts'
import { encodeControl } from '../src/shared/ipc/wire/msgpack.ts'
import { mulberry32, randomInt } from './fuzz/prng.ts'

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}
const header = (kind: number, length: number, id = 1, arg = 0, flags = 0): Uint8Array => {
  const bytes = new Uint8Array(HEADER_BYTES)
  const view = new DataView(bytes.buffer)
  bytes.set([0x56, 0x0a, kind, flags])
  view.setUint32(4, length, true)
  view.setUint32(8, id, true)
  view.setUint32(12, arg, true)
  return bytes
}
const parseAll = (stream: Uint8Array, chunks: number[], direction: FrameDirection = 'toMain', maxBody = 1024): ParsedFrame[] => {
  const parser = new FrameParser({ maxBody, direction })
  const frames: ParsedFrame[] = []
  let at = 0
  for (const size of chunks) { frames.push(...parser.push(stream.subarray(at, at + size))); at += size }
  frames.push(...parser.push(stream.subarray(at)))
  parser.end()
  return frames
}
const errorCode = (action: () => unknown): string | undefined => {
  try { action() } catch (error) { if (error instanceof ProtocolError) return error.code; throw error }
  return undefined
}
const describeFrames = (frames: ParsedFrame[]): unknown[] => frames.map(frame => frame.oversize ? { ...frame } : { kind: frame.kind, id: frame.id, arg: frame.arg, body: Buffer.from(frame.body).toString('hex') })

const stream = concat([
  encodeFrame(FrameKind.HELLO, 0, 0, encodeControl({ version: 2, generation: 1 })),
  encodeFrame(FrameKind.RESPONSE, 1, 0, encodeControl({ result: { ok: true } })),
  encodeFrame(FrameKind.PONG, 0, 0xdeadbeef),
  encodeFrame(FrameKind.DATA, 2, 1, new Uint8Array(300).map((_, i) => i)),
  encodeFrame(FrameKind.EVENT, 3, 0, encodeControl({ type: 'messages', messages: ['a'] })),
  encodeFrame(FrameKind.GOAWAY, 0, 0, encodeControl({ code: 'BACKEND_CRASH', message: 'x' }))
])

describe('frame codec', () => {
  it('encodes the documented REQUEST example byte for byte', () => {
    const frame = encodeFrame(FrameKind.REQUEST, 1, 10_000, encodeControl({ method: 'system.health', params: {} }))
    expect(Buffer.from(frame).toString('hex')).toBe('560a02001e000000010000001027000082a66d6574686f64ad73797374656d2e6865616c7468a6706172616d7380')
  })
  it('refuses headers the parser would reject', () => {
    expect(() => encodeFrame(FrameKind.CANCEL, 1, 1, new Uint8Array(1))).toThrow(RangeError)
    expect(() => encodeFrame(FrameKind.REQUEST, 1, 0)).toThrow(RangeError)
    expect(() => encodeFrame(FrameKind.PING, -1, 0)).toThrow(RangeError)
    expect(() => encodeFrame(FrameKind.PING, 0, 2 ** 32)).toThrow(RangeError)
    expect(() => encodeFrame(11 as FrameKind, 0, 0, new Uint8Array(1))).toThrow(RangeError)
  })
  it('parses the same frames however the stream is split', () => {
    const expected = describeFrames(parseAll(stream, []))
    expect(expected).toHaveLength(6)
    expect(describeFrames(parseAll(stream, Array.from({ length: stream.length }, () => 1)))).toEqual(expected)
    const random = mulberry32(0x5eed)
    for (let run = 0; run < 200; run++) {
      const chunks: number[] = []
      for (let total = 0; total < stream.length;) { const size = 1 + randomInt(random, 64); chunks.push(size); total += size }
      expect(describeFrames(parseAll(stream, chunks))).toEqual(expected)
    }
  })
  it('gives every body its own exact-size buffer', () => {
    for (const chunks of [[], Array.from({ length: stream.length }, () => 1), [20, 7, 400]]) {
      for (const frame of parseAll(stream, chunks)) {
        if (frame.oversize) continue
        expect(frame.body.byteOffset).toBe(0)
        expect(frame.body.buffer.byteLength).toBe(frame.body.length)
      }
    }
  })
  it('copies bodies out of Node Buffer chunks instead of keeping views of their pool', () => {
    const shifted = Buffer.concat([Buffer.alloc(5), Buffer.from(stream)]).subarray(5)
    for (const chunks of [[], [40, 3]]) {
      const parser = new FrameParser({ maxBody: 1024, direction: 'toMain' })
      const frames: ParsedFrame[] = []
      let at = 0
      for (const size of [...chunks, shifted.length]) { frames.push(...parser.push(shifted.subarray(at, at + size))); at += size }
      expect(describeFrames(frames)).toEqual(describeFrames(parseAll(stream, [])))
      for (const frame of frames) {
        if (frame.oversize) continue
        expect(Buffer.isBuffer(frame.body)).toBe(false)
        expect(frame.body.buffer.byteLength).toBe(frame.body.length)
      }
    }
  })
  it('skips an oversized body, reports it, and stays in sync', () => {
    const big = concat([encodeFrame(FrameKind.REQUEST, 9, 0, new Uint8Array(5000).fill(0x61)), encodeFrame(FrameKind.PING, 0, 7)])
    for (const chunks of [[], [3, 4000, 17], Array.from({ length: 50 }, () => 101)]) {
      const frames = parseAll(big, chunks, 'toBackend', 4096)
      expect(frames).toEqual([{ oversize: true, kind: FrameKind.REQUEST, id: 9, arg: 0, length: 5000 }, { kind: FrameKind.PING, id: 0, arg: 7, body: new Uint8Array(0) }])
    }
  })
  it('rejects a bad magic, kind, direction, flags, or length as soon as the header shows it', () => {
    const cases: [Uint8Array, FrameDirection, string][] = [
      [header(3, 1).fill(0x57, 0, 1), 'toMain', 'BAD_MAGIC'],
      [header(3, 1).fill(0x00, 1, 2), 'toMain', 'BAD_MAGIC'],
      [new TextEncoder().encode('{"id":null}\n'), 'toMain', 'LEGACY'],
      [header(0, 1), 'toMain', 'BAD_KIND'],
      [header(11, 1), 'toBackend', 'BAD_KIND'],
      [header(FrameKind.REQUEST, 1), 'toMain', 'BAD_DIRECTION'],
      [header(FrameKind.RESPONSE, 1), 'toBackend', 'BAD_DIRECTION'],
      [header(FrameKind.REQUEST, 1, 1, 0, 0x80), 'toBackend', 'BAD_FLAGS'],
      [header(FrameKind.CANCEL, 2), 'toBackend', 'BAD_LENGTH'],
      [header(FrameKind.EVENT, 0), 'toMain', 'BAD_LENGTH']
    ]
    for (const [bytes, direction, code] of cases) expect(errorCode(() => new FrameParser({ maxBody: 1024, direction }).push(bytes)), code).toBe(code)
    // The magic is checked per byte, so a v1 backend's first byte is enough.
    expect(errorCode(() => new FrameParser({ maxBody: 1024, direction: 'toMain' }).push(new Uint8Array([0x7b])))).toBe('LEGACY')
    // A brace after a valid frame is a desync, not a v1 backend.
    expect(errorCode(() => new FrameParser({ maxBody: 1024, direction: 'toMain' }).push(concat([encodeFrame(FrameKind.PONG, 0, 0), new Uint8Array([0x7b])])))).toBe('BAD_MAGIC')
  })
  it('reports the stream offset of the bad frame and then stays dead', () => {
    const parser = new FrameParser({ maxBody: 1024, direction: 'toMain' })
    expect(parser.push(encodeFrame(FrameKind.PONG, 0, 1))).toHaveLength(1)
    let failure: unknown
    try { parser.push(header(FrameKind.REQUEST, 1)) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(ProtocolError)
    expect((failure as ProtocolError).offset).toBe(16)
    expect(() => parser.push(encodeFrame(FrameKind.PONG, 0, 1))).toThrow(failure as Error)
    expect(() => parser.end()).toThrow(failure as Error)
  })
  it('throws TRUNCATED when the stream ends inside a header, body, or skipped body', () => {
    for (const [bytes, maxBody] of [[header(FrameKind.RESPONSE, 4).subarray(0, 9), 1024], [concat([header(FrameKind.RESPONSE, 4), new Uint8Array(2)]), 1024], [concat([header(FrameKind.RESPONSE, 4000), new Uint8Array(2)]), 1024]] as const) {
      const parser = new FrameParser({ maxBody, direction: 'toMain' })
      expect(parser.push(bytes)).toEqual([])
      expect(errorCode(() => parser.end())).toBe('TRUNCATED')
    }
    const parser = new FrameParser({ maxBody: 1024, direction: 'toMain' })
    parser.push(encodeFrame(FrameKind.PONG, 0, 0))
    expect(() => parser.end()).not.toThrow()
  })
  it('skips a body declared larger than the maximum without allocating it', () => {
    const parser = new FrameParser({ maxBody: 1024, direction: 'toMain' })
    expect(parser.push(header(FrameKind.DATA, 0xffffffff, 1, 1))).toEqual([])
    expect(parser.offset).toBe(16)
  })
})
