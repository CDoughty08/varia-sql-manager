import { open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { OpenSqlFile, SqlFile } from '../shared/contracts'

export const maxSqlFileBytes = 5_000_000
type Encoding = 'utf8' | 'utf8-bom' | 'utf16le'
interface RegisteredFile { file: SqlFile; encoding: Encoding }
// Windows paths are case-insensitive; one file must map to one registration and one tab.
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right

/** Paths are granted by native dialogs, never accepted from renderer requests. */
export class SqlFileStore {
  private files = new Map<string, RegisteredFile>()

  async read(path: string): Promise<OpenSqlFile> {
    if ((await stat(path)).size > maxSqlFileBytes) throw new Error('SQL files must be smaller than 5 MB.')
    const bytes = await readFile(path)
    if (bytes.length > maxSqlFileBytes) throw new Error('SQL files must be smaller than 5 MB.')
    let content: string
    let encoding: Encoding = 'utf8'
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      content = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2))
      encoding = 'utf16le'
    } else {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = 'utf8-bom'
    }
    if (content.includes('\0')) throw new Error('This file is not a supported SQL text file. Use UTF-8 or UTF-16 LE.')
    const absolutePath = resolve(path)
    const existing = this.find(absolutePath)
    const file = existing?.file ?? { id: randomUUID(), name: basename(absolutePath), path: absolutePath }
    this.files.set(file.id, { file, encoding })
    return { ...file, content }
  }

  get(fileId: string): SqlFile {
    const entry = this.files.get(fileId)
    if (!entry) throw new Error('This SQL file is no longer open. Use Save As to select a file.')
    return entry.file
  }

  async save(content: string, fileId?: string, selectedPath?: string): Promise<SqlFile> {
    const existing = fileId ? this.files.get(fileId) : undefined
    if (fileId && !existing) throw new Error('Unknown SQL file.')
    if (!selectedPath && !existing) throw new Error('Select a file using Save As first.')
    const path = resolve(selectedPath ?? existing!.file.path)
    const owner = this.find(path)
    if (owner && owner.file.id !== existing?.file.id) throw new Error(`${owner.file.name} is open in another query tab. Close that tab before saving over it.`)
    const encoding = existing?.encoding ?? 'utf8'
    const bytes = encoding === 'utf16le'
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
      : Buffer.concat([encoding === 'utf8-bom' ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(content, 'utf8')])
    if (bytes.length > maxSqlFileBytes) throw new Error('SQL files must be smaller than 5 MB.')
    const temporaryPath = join(dirname(path), `.varia-${randomUUID()}.tmp`)
    try {
      const temporaryFile = await open(temporaryPath, 'wx')
      try { await temporaryFile.writeFile(bytes); await temporaryFile.sync() }
      finally { await temporaryFile.close() }
      await rename(temporaryPath, path)
    } finally { await rm(temporaryPath, { force: true }) }
    const file = { id: existing?.file.id ?? randomUUID(), name: basename(path), path }
    this.files.set(file.id, { file, encoding })
    return file
  }

  release(fileId: string): void { this.files.delete(fileId) }
  clear(): void { this.files.clear() }
  private find(path: string): RegisteredFile | undefined { return [...this.files.values()].find(entry => samePath(entry.file.path, path)) }
}
