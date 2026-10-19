import { constants, type BigIntStats } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Why a file's content was rejected; fixed values, so callers can show them without echoing file content. */
export type JsonInvalidReason = 'size' | 'encoding' | 'json'
export type JsonRead = { kind: 'missing' } | { kind: 'invalid'; tooLarge: boolean; reason?: JsonInvalidReason } | { kind: 'ok'; value: unknown }

const posix = process.platform !== 'win32'
export interface RegularFileOptions {
  /** Refuse a symbolic link at the path itself (POSIX); Windows relies on `expect`. */
  followLinks?: boolean
  /** The file an earlier lstat saw: a file replaced since then, or a link it pointed at, is not read. */
  expect?: Pick<BigIntStats, 'dev' | 'ino'>
}

/**
 * Reads at most `limit` + 1 bytes of a regular file, or returns undefined when the path holds anything else. The
 * check runs on the opened handle, and O_NONBLOCK keeps a FIFO swapped in after an earlier check from hanging the read.
 */
export async function readRegularFile(path: string, limit: number, options: RegularFileOptions = {}): Promise<Buffer | undefined> {
  const flags = constants.O_RDONLY | (posix ? constants.O_NONBLOCK | (options.followLinks === false ? constants.O_NOFOLLOW : 0) : 0)
  const file = await open(path, flags)
  try {
    const info = await file.stat({ bigint: true })
    if (!info.isFile() || (options.expect && (info.dev !== options.expect.dev || info.ino !== options.expect.ino))) return undefined
    const capacity = Number(info.size < BigInt(limit) ? info.size : BigInt(limit)) + 1, buffer = Buffer.alloc(capacity)
    let length = 0
    while (length < capacity) {
      const { bytesRead } = await file.read(buffer, length, capacity - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    return buffer.subarray(0, length)
  } finally { await file.close() }
}

/**
 * Reads a bounded UTF-8 JSON file. File-system failures (permissions, locks, a directory at the path) are thrown so
 * callers never overwrite data they could not read; only content problems are reported as `invalid`.
 */
export async function readJsonFile(path: string, limit: number): Promise<JsonRead> {
  let bytes: Buffer | undefined
  try { bytes = await readRegularFile(path, limit) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  if (!bytes) throw new Error('Expected a regular file at ' + path + '.')
  if (bytes.length > limit) return { kind: 'invalid', tooLarge: true, reason: 'size' }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return { kind: 'invalid', tooLarge: false, reason: 'encoding' } }
  try { return { kind: 'ok', value: JSON.parse(text) } }
  catch { return { kind: 'invalid', tooLarge: false, reason: 'json' } }
}

/** Preserves an unreadable preferences file beside the original before defaults replace it. */
export async function quarantine(path: string): Promise<void> {
  await rename(path, path + '.invalid-' + randomUUID() + '.json')
}

export interface AtomicWriteOptions {
  /** POSIX permissions of the new file, set on the temporary file before it is synced and renamed into place, so its
   *  content is never readable under the umask's default. Windows ignores it. */
  readonly mode?: number
}
export async function writeJsonAtomic(path: string, value: unknown, limit: number, tooLarge: string, options: AtomicWriteOptions = {}): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  if (bytes.length > limit) throw new Error(tooLarge)
  await writeBytesAtomic(path, bytes, options)
}

/** Writes a temporary file beside `path` and renames it over `path`, so a failed write leaves the old file as it was. */
export async function writeBytesAtomic(path: string, bytes: Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.varia-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', options.mode ?? 0o666)
    try {
      // Before any content: open's mode is masked by the umask, chmod's is not.
      if (options.mode !== undefined && posix) await file.chmod(options.mode)
      await file.writeFile(bytes)
      await file.sync()
    } finally { await file.close() }
    await replaceFile(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

const replaceAttempts = 8
/**
 * Windows refuses to replace a file while another process has it open (a reader, an antivirus or indexer scan) and
 * reports EPERM, EACCES, or EBUSY. Those holds are brief, so the rename is retried for about two seconds first.
 */
export async function replaceFile(from: string, to: string, platform: NodeJS.Platform = process.platform, move: typeof rename = rename): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { return await move(from, to) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (platform !== 'win32' || attempt === replaceAttempts || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(25 * 2 ** attempt, 500)))
    }
  }
}
