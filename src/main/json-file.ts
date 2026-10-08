import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type JsonRead = { kind: 'missing' } | { kind: 'invalid'; tooLarge: boolean } | { kind: 'ok'; value: unknown }

/**
 * Reads a bounded UTF-8 JSON file. File-system failures (permissions, locks, a directory at the path) are thrown so
 * callers never overwrite data they could not read; only content problems are reported as `invalid`.
 */
export async function readJsonFile(path: string, limit: number): Promise<JsonRead> {
  let bytes: Buffer
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('Expected a regular file at ' + path + '.')
    if (info.size > limit) return { kind: 'invalid', tooLarge: true }
    bytes = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  if (bytes.length > limit) return { kind: 'invalid', tooLarge: true }
  try { return { kind: 'ok', value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } }
  catch { return { kind: 'invalid', tooLarge: false } }
}

/** Preserves an unreadable preferences file beside the original before defaults replace it. */
export async function quarantine(path: string): Promise<void> {
  await rename(path, path + '.invalid-' + randomUUID() + '.json')
}

export async function writeJsonAtomic(path: string, value: unknown, limit: number, tooLarge: string): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  if (bytes.length > limit) throw new Error(tooLarge)
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.varia-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx')
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
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
