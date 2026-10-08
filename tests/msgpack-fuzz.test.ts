import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { DecodeError, decodeControl } from '../src/shared/ipc/wire/msgpack.ts'
import { FrameParser, ProtocolError, type FrameDirection } from '../src/shared/ipc/wire/frames.ts'
import { PageFormatError, decodePage, type WireKind } from '../src/shared/ipc/wire/pages.ts'
import { cellText } from '../src/shared/ipc/wire/cells.ts'
import { fuzzIterations, fuzzSeed, mulberry32, mutate, randomInt } from './fuzz/prng.ts'

const vectors = JSON.parse(readFileSync('tests/fixtures/ipc-vectors.json', 'utf8')) as { control: { hex: string }[]; frames: { hex: string; direction: FrameDirection }[]; pages: { hex: string; wires: WireKind[]; error?: string }[] }
const bytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'))
const controls = vectors.control.map(vector => bytes(vector.hex))
const frames = vectors.frames.map(vector => ({ input: bytes(vector.hex), direction: vector.direction }))
const pages = vectors.pages.filter(vector => vector.error === undefined).map(vector => ({ input: bytes(vector.hex), columns: vector.wires.map(wire => ({ wire })) }))

/** Runs `decode`, allowing only the expected error types, and returns its duration in milliseconds. */
function timed(decode: () => void, allowed: (error: unknown) => boolean): number {
  const start = performance.now()
  try { decode() } catch (error) { if (!allowed(error)) throw error }
  return performance.now() - start
}

/** Fails only an input that stays slow on re-runs, so a GC pause or JIT on a busy runner is not a failure. */
function withinBudget(decode: () => void, allowed: (error: unknown) => boolean): boolean {
  if (timed(decode, allowed) <= 10) return true
  return Math.min(timed(decode, allowed), timed(decode, allowed), timed(decode, allowed)) <= 10
}

const isDecodeError = (error: unknown): boolean => error instanceof DecodeError
const isProtocolError = (error: unknown): boolean => error instanceof ProtocolError
const isPageError = (error: unknown): boolean => error instanceof PageFormatError

function parseStream(input: Uint8Array, direction: FrameDirection, chunk: number): void {
  const parser = new FrameParser({ maxBody: 4096, direction })
  for (let at = 0; at < input.length; at += chunk) parser.push(input.subarray(at, at + chunk))
  parser.end()
}

describe('wire fuzzing', () => {
  it('decodes every truncation of every vector with only DecodeError, ProtocolError, or PageFormatError', () => {
    for (const input of controls) for (let end = 0; end < input.length; end++) expect(withinBudget(() => decodeControl(input.subarray(0, end)), isDecodeError)).toBe(true)
    for (const { input, direction } of frames) for (let end = 0; end < input.length; end++) expect(withinBudget(() => parseStream(input.subarray(0, end), direction, 7), isProtocolError)).toBe(true)
    for (const { input, columns } of pages) for (let end = 0; end < input.length; end++) expect(() => decodePage(input.subarray(0, end), columns)).toThrow(PageFormatError)
  })
  it('survives seeded mutations: bit flips, insertions, deletions, inflated lengths, and nesting bombs', () => {
    const seed = fuzzSeed()
    const random = mulberry32(seed)
    const iterations = fuzzIterations(20_000)
    const replay = `replay with VARIA_FUZZ_SEED=${seed}`
    for (let i = 0; i < iterations; i++) {
      const control = mutate(random, controls[randomInt(random, controls.length)])
      expect(withinBudget(() => decodeControl(control), isDecodeError), `${replay}: slow control input ${Buffer.from(control).toString('hex')}`).toBe(true)
      const frame = frames[randomInt(random, frames.length)]
      const stream = mutate(random, frame.input)
      expect(withinBudget(() => parseStream(stream, frame.direction, 1 + randomInt(random, 64)), isProtocolError), `${replay}: slow frame input`).toBe(true)
      const page = pages[randomInt(random, pages.length)]
      const body = mutate(random, page.input)
      expect(withinBudget(() => {
        const view = decodePage(body, page.columns)
        for (let row = 0; row < view.rowCount; row++) for (let column = 0; column < page.columns.length; column++) cellText(view, column, row, 32)
      }, isPageError), `${replay}: slow page input`).toBe(true)
    }
  }, Math.max(20_000, 2 * fuzzIterations(20_000)))
  it('rejects depth and size bombs quickly', () => {
    const bombs = [
      new Uint8Array(4_000_000).fill(0x91),
      new Uint8Array(4_000_000).fill(0xdc),
      Uint8Array.from([0xdd, 0x00, 0x10, 0x00, 0x00, ...new Array<number>(1_048_575).fill(0xc0)]),
      Uint8Array.from([0xdb, 0xff, 0xff, 0xff, 0xff]),
      Uint8Array.from([0xdf, 0x00, 0x00, 0x10, 0x00])
    ]
    for (const bomb of bombs) expect(withinBudget(() => decodeControl(bomb), isDecodeError)).toBe(true)
  })
})
