// The MessagePack subset of protocol v2 (docs/ipc.md): nil, booleans, integers within ±(2^53 − 1), float64, str, bin
// (page bodies only), arrays and maps. c1, float32 and every ext type are rejected. Encoding is canonical (smallest
// form; non-negative integers use the unsigned family), so the C# MsgPackWriter produces identical bytes.

export interface ControlLimits { readonly maxDepth: number; readonly maxMapEntries: number; readonly maxArrayLength: number; readonly maxKeyBytes: number }
export const controlLimits: ControlLimits = Object.freeze({ maxDepth: 16, maxMapEntries: 4096, maxArrayLength: 1_048_576, maxKeyBytes: 128 })

export type DecodeErrorCode = 'TRUNCATED' | 'TRAILING' | 'TYPE' | 'DEPTH' | 'LIMIT' | 'KEY_TYPE' | 'KEY_LENGTH' | 'KEY_FORBIDDEN' | 'KEY_DUPLICATE' | 'UTF8' | 'NUMBER'
/** Carries only a code and an offset: never the bytes, which may hold SQL text or a password. */
export class DecodeError extends Error {
  readonly code: DecodeErrorCode
  readonly offset: number
  constructor(code: DecodeErrorCode, offset: number) {
    super(`MessagePack ${code} at offset ${offset}`)
    this.name = 'DecodeError'
    this.code = code
    this.offset = offset
  }
}

export type EncodeErrorCode = 'TYPE' | 'UNDEFINED' | 'NUMBER' | 'DEPTH' | 'LIMIT' | 'KEY_LENGTH' | 'KEY_FORBIDDEN'
export class EncodeError extends Error {
  readonly code: EncodeErrorCode
  constructor(code: EncodeErrorCode) {
    super(`Cannot encode value as MessagePack: ${code}`)
    this.name = 'EncodeError'
    this.code = code
  }
}

/** Keys that could reach an object's prototype chain in JavaScript consumers; rejected on both sides. */
export const forbiddenKeys: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

const encoder = new TextEncoder()
// ignoreBOM keeps a leading U+FEFF as data instead of silently dropping it.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const TWO_32 = 4294967296

export class MsgPackWriter {
  /** Zero every buffer this writer outgrows, because it holds a password. */
  sensitive = false
  private buffer: Uint8Array
  private view: DataView
  private length = 0

  constructor(initialCapacity = 256) {
    this.buffer = new Uint8Array(Math.max(16, initialCapacity))
    this.view = new DataView(this.buffer.buffer)
  }

  get size(): number { return this.length }

  /** An exact-size copy (byteOffset 0, buffer.byteLength === size). */
  finish(): Uint8Array { return this.buffer.slice(0, this.length) }

  reset(): void { this.length = 0 }

  /** Zeroes the buffer and empties the writer. */
  wipe(): void {
    this.buffer.fill(0)
    this.length = 0
  }

  private ensure(bytes: number): void {
    const needed = this.length + bytes
    if (needed <= this.buffer.length) return
    const next = new Uint8Array(Math.max(needed, this.buffer.length * 2))
    next.set(this.buffer.subarray(0, this.length))
    if (this.sensitive) this.buffer.fill(0)
    this.buffer = next
    this.view = new DataView(next.buffer)
  }

  private u8(value: number): void { this.ensure(1); this.buffer[this.length++] = value }
  private tagged(tag: number, bytes: 1 | 2 | 4, value: number): void {
    this.ensure(1 + bytes)
    this.buffer[this.length] = tag
    if (bytes === 1) this.buffer[this.length + 1] = value
    else if (bytes === 2) this.view.setUint16(this.length + 1, value)
    else this.view.setUint32(this.length + 1, value)
    this.length += 1 + bytes
  }

  nil(): void { this.u8(0xc0) }
  boolean(value: boolean): void { this.u8(value ? 0xc3 : 0xc2) }

  /** A safe integer in its smallest form; -0 is written as 0. */
  integer(value: number): void {
    if (!Number.isSafeInteger(value)) throw new EncodeError('NUMBER')
    if (value >= 0) {
      if (value < 0x80) this.u8(value)
      else if (value < 0x100) this.tagged(0xcc, 1, value)
      else if (value < 0x10000) this.tagged(0xcd, 2, value)
      else if (value < TWO_32) this.tagged(0xce, 4, value)
      else {
        this.ensure(9)
        this.buffer[this.length] = 0xcf
        this.view.setUint32(this.length + 1, Math.floor(value / TWO_32))
        this.view.setUint32(this.length + 5, value % TWO_32)
        this.length += 9
      }
    } else if (value >= -0x20) this.u8(value & 0xff)
    else if (value >= -0x80) this.tagged(0xd0, 1, value & 0xff)
    else if (value >= -0x8000) this.tagged(0xd1, 2, value & 0xffff)
    else if (value >= -0x80000000) this.tagged(0xd2, 4, value >>> 0)
    else {
      this.ensure(9)
      this.buffer[this.length] = 0xd3
      const high = Math.floor(value / TWO_32)
      this.view.setInt32(this.length + 1, high)
      this.view.setUint32(this.length + 5, value - high * TWO_32)
      this.length += 9
    }
  }

  float64(value: number): void {
    if (!Number.isFinite(value)) throw new EncodeError('NUMBER')
    this.ensure(9)
    this.buffer[this.length] = 0xcb
    this.view.setFloat64(this.length + 1, value)
    this.length += 9
  }

  /** JSON semantics: safe integers as integers, other finite numbers as float64. */
  number(value: number): void {
    if (Number.isSafeInteger(value)) this.integer(value)
    else this.float64(value)
  }

  /** Writes a str and returns its UTF-8 byte length. Lone surrogates become U+FFFD, as in the C# writer. */
  string(value: string): number {
    const units = value.length
    if (units < 32) {
      let ascii = true
      for (let i = 0; i < units; i++) if (value.charCodeAt(i) >= 0x80) { ascii = false; break }
      if (ascii) {
        this.ensure(1 + units)
        this.buffer[this.length++] = 0xa0 | units
        for (let i = 0; i < units; i++) this.buffer[this.length++] = value.charCodeAt(i)
        return units
      }
    }
    // Encode after the largest header the string could need, then move it left if a smaller header is canonical.
    const reserve = strHeaderBytes(units * 3)
    this.ensure(reserve + units * 3)
    const start = this.length
    const written = encoder.encodeInto(value, this.buffer.subarray(start + reserve)).written
    const header = strHeaderBytes(written)
    if (header !== reserve) this.buffer.copyWithin(start + header, start + reserve, start + reserve + written)
    this.writeLengthHeader(start, header, written, 0xa0, 0xd9)
    this.length = start + header + written
    return written
  }

  binary(bytes: Uint8Array): void {
    this.binHeader(bytes.length)
    this.raw(bytes)
  }

  /** A bin header; `bin32` forces the 5-byte form (page data, so its payload offset is computable). */
  binHeader(length: number, bin32 = false): void {
    if (bin32 || length >= 0x10000) this.tagged(0xc6, 4, length)
    else if (length >= 0x100) this.tagged(0xc5, 2, length)
    else this.tagged(0xc4, 1, length)
  }

  arrayHeader(count: number): void {
    if (count < 16) this.u8(0x90 | count)
    else if (count < 0x10000) this.tagged(0xdc, 2, count)
    else this.tagged(0xdd, 4, count)
  }

  mapHeader(count: number): void {
    if (count < 16) this.u8(0x80 | count)
    else if (count < 0x10000) this.tagged(0xde, 2, count)
    else this.tagged(0xdf, 4, count)
  }

  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length)
    this.buffer.set(bytes, this.length)
    this.length += bytes.length
  }

  private writeLengthHeader(at: number, header: number, length: number, fix: number, tag8: number): void {
    if (header === 1) this.buffer[at] = fix | length
    else if (header === 2) { this.buffer[at] = tag8; this.buffer[at + 1] = length }
    else if (header === 3) { this.buffer[at] = tag8 + 1; this.view.setUint16(at + 1, length) }
    else { this.buffer[at] = tag8 + 2; this.view.setUint32(at + 1, length) }
  }
}

function strHeaderBytes(length: number): number { return length < 32 ? 1 : length < 0x100 ? 2 : length < 0x10000 ? 3 : 5 }

/** Encodes a JSON-shaped value (null, booleans, numbers, strings, arrays, plain objects) canonically. */
export function encodeControl(value: unknown, limits: ControlLimits = controlLimits): Uint8Array {
  const writer = new MsgPackWriter()
  writeControl(writer, value, limits, 0)
  return writer.finish()
}

/** encodeControl for a body that holds a password: the writer's own buffers are zeroed, so the returned array is the
 *  only copy, and the caller zeroes it once written. (The JavaScript strings it came from cannot be zeroed.) */
export function encodeSensitiveControl(value: unknown, limits: ControlLimits = controlLimits): Uint8Array {
  const writer = new MsgPackWriter(4096)
  writer.sensitive = true
  try {
    writeControl(writer, value, limits, 0)
    return writer.finish()
  } finally { writer.wipe() }
}

function writeControl(writer: MsgPackWriter, value: unknown, limits: ControlLimits, depth: number): void {
  switch (typeof value) {
    case 'string': writer.string(value); return
    case 'number': writer.number(value); return
    case 'boolean': writer.boolean(value); return
    case 'undefined': throw new EncodeError('UNDEFINED')
    case 'object': break
    default: throw new EncodeError('TYPE')
  }
  if (value === null) { writer.nil(); return }
  if (depth >= limits.maxDepth) throw new EncodeError('DEPTH')
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) throw new EncodeError('LIMIT')
    writer.arrayHeader(value.length)
    for (let i = 0; i < value.length; i++) writeControl(writer, value[i], limits, depth + 1)
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new EncodeError('TYPE')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter(key => record[key] !== undefined)
  if (keys.length > limits.maxMapEntries) throw new EncodeError('LIMIT')
  writer.mapHeader(keys.length)
  for (const key of keys) {
    if (forbiddenKeys.has(key)) throw new EncodeError('KEY_FORBIDDEN')
    if (writer.string(key) > limits.maxKeyBytes) throw new EncodeError('KEY_LENGTH')
    writeControl(writer, record[key], limits, depth + 1)
  }
}

/** A bounds-checked reader. Every length is checked against the remaining bytes before anything is allocated. */
export class MsgPackCursor {
  readonly bytes: Uint8Array
  private readonly view: DataView
  offset: number

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.offset = offset
  }

  get remaining(): number { return this.bytes.length - this.offset }

  need(bytes: number, at = this.offset): void { if (bytes > this.bytes.length - this.offset) throw new DecodeError('TRUNCATED', at) }

  byte(): number {
    this.need(1)
    return this.bytes[this.offset++]
  }

  u16(): number {
    this.need(2)
    const value = this.view.getUint16(this.offset)
    this.offset += 2
    return value
  }

  u32(): number {
    this.need(4)
    const value = this.view.getUint32(this.offset)
    this.offset += 4
    return value
  }

  float64(): number {
    this.need(8)
    const value = this.view.getFloat64(this.offset)
    this.offset += 8
    return value
  }

  /** The 8-byte payload of uint64 (signed = false) or int64, rejected outside ±(2^53 − 1). */
  int64(signed: boolean, at: number): number {
    this.need(8, at)
    const high = signed ? this.view.getInt32(this.offset) : this.view.getUint32(this.offset)
    const low = this.view.getUint32(this.offset + 4)
    this.offset += 8
    const value = high * TWO_32 + low
    if (!Number.isSafeInteger(value)) throw new DecodeError('NUMBER', at)
    return value
  }

  /** Strict UTF-8 (overlong forms, surrogates and truncated sequences are rejected). */
  utf8(length: number, at: number): string {
    this.need(length, at)
    const start = this.offset
    const end = start + length
    this.offset = end
    if (length < 32) {
      let text = ''
      let i = start
      for (; i < end && this.bytes[i] < 0x80; i++) text += String.fromCharCode(this.bytes[i])
      if (i === end) return text
    }
    try { return strictUtf8.decode(this.bytes.subarray(start, end)) } catch { throw new DecodeError('UTF8', at) }
  }

  /** Any integer format; the value must be a safe integer. */
  integer(): number {
    const at = this.offset
    const tag = this.byte()
    if (tag < 0x80) return tag
    if (tag >= 0xe0) return tag - 0x100
    switch (tag) {
      case 0xcc: return this.byte()
      case 0xcd: return this.u16()
      case 0xce: return this.u32()
      case 0xcf: return this.int64(false, at)
      case 0xd0: { const value = this.byte(); return value < 0x80 ? value : value - 0x100 }
      case 0xd1: { const value = this.u16(); return value < 0x8000 ? value : value - 0x10000 }
      case 0xd2: { const value = this.u32(); return value < 0x80000000 ? value : value - TWO_32 }
      case 0xd3: return this.int64(true, at)
      default: throw new DecodeError('TYPE', at)
    }
  }

  /** Any integer format holding a non-negative safe integer. */
  uint(): number {
    const at = this.offset
    const value = this.integer()
    if (value < 0) throw new DecodeError('NUMBER', at)
    return value
  }

  arrayHeader(): number {
    const at = this.offset
    const tag = this.byte()
    if (tag >= 0x90 && tag <= 0x9f) return tag & 0x0f
    if (tag === 0xdc) return this.u16()
    if (tag === 0xdd) return this.u32()
    throw new DecodeError('TYPE', at)
  }

  /** A bin header of any width; the payload must fit in the remaining bytes. */
  binHeader(): number {
    const at = this.offset
    const tag = this.byte()
    const length = tag === 0xc4 ? this.byte() : tag === 0xc5 ? this.u16() : tag === 0xc6 ? this.u32() : -1
    if (length < 0) throw new DecodeError('TYPE', at)
    this.need(length, at)
    return length
  }
}

interface Level { array: unknown[] | undefined; map: Record<string, unknown> | undefined; key: string | undefined; remaining: number }

/**
 * Decodes a JSON-shaped control body: string keys only, no bin, no duplicate or prototype keys, finite numbers,
 * strict UTF-8, bounded depth, sizes and keys, and the whole body consumed. Iterative, so nesting cannot overflow
 * the stack. Throws only DecodeError.
 */
export function decodeControl(bytes: Uint8Array, limits: ControlLimits = controlLimits): unknown {
  const c = new MsgPackCursor(bytes)
  const stack: Level[] = []
  for (;;) {
    const top = stack.length > 0 ? stack[stack.length - 1] : undefined
    if (top?.map !== undefined && top.key === undefined) { top.key = readKey(c, limits, top.map); continue }
    const at = c.offset
    const tag = c.byte()
    let value: unknown
    let count = -1
    let isMap = false
    if (tag < 0x80) value = tag
    else if (tag >= 0xe0) value = tag - 0x100
    else if (tag >= 0xa0 && tag <= 0xbf) value = c.utf8(tag & 0x1f, at)
    else if (tag >= 0x90 && tag <= 0x9f) count = tag & 0x0f
    else if (tag <= 0x8f) { count = tag & 0x0f; isMap = true }
    else switch (tag) {
      case 0xc0: value = null; break
      case 0xc2: value = false; break
      case 0xc3: value = true; break
      case 0xcb: {
        const number = c.float64()
        if (!Number.isFinite(number)) throw new DecodeError('NUMBER', at)
        // JSON semantics, like the encoder: -0 is 0.
        value = number === 0 ? 0 : number
        break
      }
      case 0xcc: case 0xcd: case 0xce: case 0xcf: case 0xd0: case 0xd1: case 0xd2: case 0xd3:
        c.offset = at
        value = c.integer()
        break
      case 0xd9: value = c.utf8(c.byte(), at); break
      case 0xda: value = c.utf8(c.u16(), at); break
      case 0xdb: value = c.utf8(c.u32(), at); break
      case 0xdc: count = c.u16(); break
      case 0xdd: count = c.u32(); break
      case 0xde: count = c.u16(); isMap = true; break
      case 0xdf: count = c.u32(); isMap = true; break
      default: throw new DecodeError('TYPE', at)
    }
    if (count >= 0) {
      if (stack.length >= limits.maxDepth) throw new DecodeError('DEPTH', at)
      if (count > (isMap ? limits.maxMapEntries : limits.maxArrayLength)) throw new DecodeError('LIMIT', at)
      // Every element takes at least one byte, every map entry at least two.
      c.need(isMap ? count * 2 : count, at)
      const container = isMap ? {} : []
      if (count > 0) {
        stack.push(isMap ? { array: undefined, map: container as Record<string, unknown>, key: undefined, remaining: count } : { array: container as unknown[], map: undefined, key: undefined, remaining: count })
        continue
      }
      value = container
    }
    for (;;) {
      const level = stack.length > 0 ? stack[stack.length - 1] : undefined
      if (level === undefined) {
        if (c.remaining > 0) throw new DecodeError('TRAILING', c.offset)
        return value
      }
      if (level.array !== undefined) level.array.push(value)
      else { level.map![level.key!] = value; level.key = undefined }
      if (--level.remaining > 0) break
      stack.pop()
      value = level.array ?? level.map
    }
  }
}

function readKey(c: MsgPackCursor, limits: ControlLimits, map: Record<string, unknown>): string {
  const at = c.offset
  const tag = c.byte()
  const length = tag >= 0xa0 && tag <= 0xbf ? tag & 0x1f : tag === 0xd9 ? c.byte() : tag === 0xda ? c.u16() : tag === 0xdb ? c.u32() : -1
  if (length < 0) throw new DecodeError('KEY_TYPE', at)
  if (length > limits.maxKeyBytes) throw new DecodeError('KEY_LENGTH', at)
  const key = c.utf8(length, at)
  if (forbiddenKeys.has(key)) throw new DecodeError('KEY_FORBIDDEN', at)
  if (Object.hasOwn(map, key)) throw new DecodeError('KEY_DUPLICATE', at)
  return key
}
