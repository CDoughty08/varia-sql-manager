// Protocol v2 framing: a 16-byte little-endian header (magic 56 0A, kind, flags, length, id, arg), then the body.
// The magic includes LF so a v1 backend, which reads lines, answers at once with a JSON line starting with '{'.

export const HEADER_BYTES = 16
export const MAGIC: readonly [number, number] = [0x56, 0x0a]

export const FrameKind = { HELLO: 1, REQUEST: 2, RESPONSE: 3, EVENT: 4, DATA: 5, CANCEL: 6, CREDIT: 7, PING: 8, PONG: 9, GOAWAY: 10 } as const
export type FrameKind = typeof FrameKind[keyof typeof FrameKind]

/** Which way the frames being parsed travel. */
export type FrameDirection = 'toBackend' | 'toMain'
const toBackend: ReadonlySet<number> = new Set([FrameKind.HELLO, FrameKind.REQUEST, FrameKind.CANCEL, FrameKind.CREDIT, FrameKind.PING])
const toMain: ReadonlySet<number> = new Set([FrameKind.HELLO, FrameKind.RESPONSE, FrameKind.EVENT, FrameKind.DATA, FrameKind.PONG, FrameKind.GOAWAY])
/** Kinds whose information is all in the header; every other kind has a non-empty body. */
const emptyKinds: ReadonlySet<number> = new Set([FrameKind.CANCEL, FrameKind.CREDIT, FrameKind.PING, FrameKind.PONG])

export function isFrameKind(value: number): value is FrameKind { return Number.isInteger(value) && value >= FrameKind.HELLO && value <= FrameKind.GOAWAY }
export function hasEmptyBody(kind: FrameKind): boolean { return emptyKinds.has(kind) }
export function isDirectionKind(kind: FrameKind, direction: FrameDirection): boolean { return (direction === 'toBackend' ? toBackend : toMain).has(kind) }

/** Every body is its own exact-size buffer: `body.byteOffset === 0 && body.buffer.byteLength === body.length`. */
export interface Frame { readonly oversize?: false; readonly kind: FrameKind; readonly id: number; readonly arg: number; readonly body: Uint8Array }
/** A frame whose body exceeded the parser's maximum; the body was skipped, so the stream stays in sync. */
export interface OversizeFrame { readonly oversize: true; readonly kind: FrameKind; readonly id: number; readonly arg: number; readonly length: number }
export type ParsedFrame = Frame | OversizeFrame

export type ProtocolErrorCode = 'BAD_MAGIC' | 'LEGACY' | 'BAD_KIND' | 'BAD_DIRECTION' | 'BAD_FLAGS' | 'BAD_LENGTH' | 'TRUNCATED'
/** A fatal framing violation. Carries only a code and the stream offset of the offending frame, never its bytes. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode
  readonly offset: number
  constructor(code: ProtocolErrorCode, offset: number) {
    super(`Protocol ${code} at stream offset ${offset}`)
    this.name = 'ProtocolError'
    this.code = code
    this.offset = offset
  }
}

const U32 = 0xffffffff
function isU32(value: number): boolean { return Number.isInteger(value) && value >= 0 && value <= U32 }

/** One exact-size buffer holding the header and body, ready for a single stream write. */
export function encodeFrame(kind: FrameKind, id: number, arg: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (!isFrameKind(kind) || !isU32(id) || !isU32(arg) || !isU32(body.length)) throw new RangeError('Invalid frame header field.')
  if ((body.length === 0) !== emptyKinds.has(kind)) throw new RangeError('Invalid frame body length for its kind.')
  const frame = new Uint8Array(HEADER_BYTES + body.length)
  const view = new DataView(frame.buffer)
  frame[0] = MAGIC[0]
  frame[1] = MAGIC[1]
  frame[2] = kind
  view.setUint32(4, body.length, true)
  view.setUint32(8, id, true)
  view.setUint32(12, arg, true)
  frame.set(body, HEADER_BYTES)
  return frame
}

/**
 * Incremental parser. The header is validated (magic, kind, direction, flags, length) before anything is allocated;
 * an oversized body is skipped and reported. After a ProtocolError the parser is dead and rethrows it.
 */
export class FrameParser {
  private readonly maxBody: number
  private readonly direction: FrameDirection
  private readonly header = new Uint8Array(HEADER_BYTES)
  private readonly headerView = new DataView(this.header.buffer)
  private headerFill = 0
  private kind: FrameKind = FrameKind.HELLO
  private id = 0
  private arg = 0
  private length = 0
  /** Body bytes still expected for the current frame; `body` is allocated only when the body spans chunks. */
  private bodyRemaining = 0
  private body: Uint8Array | undefined
  private skipping = 0
  private frameStart = 0
  private consumed = 0
  private failure: ProtocolError | undefined

  constructor(o: { maxBody: number; direction: FrameDirection }) {
    this.maxBody = o.maxBody
    this.direction = o.direction
  }

  /** Bytes consumed so far. */
  get offset(): number { return this.consumed }

  push(chunk: Uint8Array): ParsedFrame[] {
    if (this.failure) throw this.failure
    const frames: ParsedFrame[] = []
    let i = 0
    try {
      while (i < chunk.length) {
        if (this.bodyRemaining > 0) {
          if (this.body === undefined && chunk.length - i >= this.length) {
            // The whole body is in this chunk: one exact-size copy. (Buffer#slice would return a view of Node's pool.)
            const body = new Uint8Array(this.length)
            body.set(chunk.subarray(i, i + this.length))
            frames.push(this.complete(body))
            i += this.length
            continue
          }
          this.body ??= new Uint8Array(this.length)
          const take = Math.min(this.bodyRemaining, chunk.length - i)
          this.body.set(chunk.subarray(i, i + take), this.length - this.bodyRemaining)
          this.bodyRemaining -= take
          i += take
          if (this.bodyRemaining === 0) frames.push(this.complete(this.body))
          continue
        }
        if (this.skipping > 0) {
          const take = Math.min(this.skipping, chunk.length - i)
          this.skipping -= take
          i += take
          if (this.skipping === 0) frames.push({ oversize: true, kind: this.kind, id: this.id, arg: this.arg, length: this.length })
          continue
        }
        if (this.headerFill === 0) this.frameStart = this.consumed + i
        const take = Math.min(HEADER_BYTES - this.headerFill, chunk.length - i)
        this.header.set(chunk.subarray(i, i + take), this.headerFill)
        // Check the magic as soon as it arrives, so a stray byte or a v1 backend fails without waiting for 16 bytes.
        if (this.headerFill === 0 && this.header[0] !== MAGIC[0]) throw this.badMagic()
        if (this.headerFill < 2 && this.headerFill + take >= 2 && this.header[1] !== MAGIC[1]) throw this.badMagic()
        this.headerFill += take
        i += take
        if (this.headerFill < HEADER_BYTES) continue
        this.headerFill = 0
        const frame = this.startFrame()
        if (frame) frames.push(frame)
      }
    } catch (error) {
      if (error instanceof ProtocolError) this.failure = error
      throw error
    } finally {
      this.consumed += i
    }
    return frames
  }

  private complete(body: Uint8Array): Frame {
    this.body = undefined
    this.bodyRemaining = 0
    return { kind: this.kind, id: this.id, arg: this.arg, body }
  }

  /** The stream ended; throws TRUNCATED if it ended inside a frame. */
  end(): void {
    if (this.failure) throw this.failure
    if (this.headerFill > 0 || this.bodyRemaining > 0 || this.skipping > 0) throw (this.failure = new ProtocolError('TRUNCATED', this.frameStart))
  }

  private badMagic(): ProtocolError {
    return new ProtocolError(this.frameStart === 0 && this.header[0] === 0x7b ? 'LEGACY' : 'BAD_MAGIC', this.frameStart)
  }

  /** Validates the completed header; returns a frame when it has no body. */
  private startFrame(): ParsedFrame | undefined {
    const kind = this.header[2]
    if (!isFrameKind(kind)) throw new ProtocolError('BAD_KIND', this.frameStart)
    if (!isDirectionKind(kind, this.direction)) throw new ProtocolError('BAD_DIRECTION', this.frameStart)
    if (this.header[3] !== 0) throw new ProtocolError('BAD_FLAGS', this.frameStart)
    const length = this.headerView.getUint32(4, true)
    if ((length === 0) !== emptyKinds.has(kind)) throw new ProtocolError('BAD_LENGTH', this.frameStart)
    this.kind = kind
    this.id = this.headerView.getUint32(8, true)
    this.arg = this.headerView.getUint32(12, true)
    this.length = length
    if (length === 0) return { kind, id: this.id, arg: this.arg, body: new Uint8Array(0) }
    if (length > this.maxBody) this.skipping = length
    else this.bodyRemaining = length
    return undefined
  }
}
