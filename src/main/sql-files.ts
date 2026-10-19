import { constants } from 'node:fs'
import { access, chmod, open, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { documentKinds, type DocumentKind, type FileEncoding, type OpenSqlFile, type SqlFile } from '../shared/contracts'
import { readRegularFile, replaceFile } from './json-file'
import { detectAndDecode, detectEol, encodeText, type DecoderFactory } from './text-encoding'

export const maxSqlFileBytes = 5_000_000
interface FileKind { readonly title: string; readonly filters: { name: string; extensions: string[] }[]; readonly maxChars: number; readonly maxBytes: number; readonly tooLarge: string }
const valueFile = (title: string, filters: FileKind['filters']): FileKind => ({ title, filters, maxChars: 4_194_304, maxBytes: 16 * 1024 * 1024, tooLarge: 'Files must be smaller than 16 MB.' })
/** Each document kind's save dialog and limits. A value opened from the results is at most 4,194,304 characters formatted. */
export const fileKinds: Readonly<Record<DocumentKind, FileKind>> = {
  sql: { title: 'Save SQL query', filters: [{ name: 'SQL files', extensions: ['sql'] }], maxChars: maxSqlFileBytes, maxBytes: maxSqlFileBytes, tooLarge: 'SQL files must be smaller than 5 MB.' },
  xml: valueFile('Save XML document', [{ name: 'XML files', extensions: ['xml'] }]),
  json: valueFile('Save JSON document', [{ name: 'JSON files', extensions: ['json'] }]),
  sqlplan: valueFile('Save execution plan', [{ name: 'Execution plans', extensions: ['sqlplan'] }, { name: 'XML files', extensions: ['xml'] }])
}
/** varia:files-save: the content's limit depends on the kind (a query by default). */
export const saveFileSchema = z.object({ fileId: z.uuid().optional(), name: z.string().min(1).max(512), content: z.string().max(maxSqlFileBytes), saveAs: z.boolean(), kind: z.enum(documentKinds).optional() }).strict()
  .refine(value => value.content.length <= fileKinds[value.kind ?? 'sql'].maxChars, 'The document is too large to save.')
// Windows paths are case-insensitive; one file must map to one registration and one tab.
export const samePath = (left: string, right: string, platform: NodeJS.Platform = process.platform) => platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right

const posix = process.platform !== 'win32'
const readOnlyCodes = new Set(['EACCES', 'EPERM', 'EROFS'])
/** Whether the file at `path` exists and cannot be written: a read-only attribute on Windows, no write permission or a
 *  read-only file system elsewhere. A missing file is not read-only. */
export async function isReadOnly(path: string): Promise<boolean> {
  try { await access(path, constants.W_OK); return false }
  catch (error) { return readOnlyCodes.has((error as NodeJS.ErrnoException).code ?? '') }
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
/** Where a save writes: a symbolic link's target, so the link stays a link; the path itself for a new file. */
async function writeTarget(path: string): Promise<string> {
  try { return await realpath(path) } catch (error) { if (missing(error)) return path; throw error }
}

export interface SqlFileStoreOptions {
  /** The ANSI code page's WHATWG label for files that are neither UTF-8 nor UTF-16 (`legacyCodePage`); read when needed. */
  readonly legacyLabel?: () => string
  readonly decoder?: DecoderFactory
  readonly platform?: NodeJS.Platform
  /** The rename that replaces a file; tests watch it. */
  readonly replace?: typeof replaceFile
}
export interface SaveOptions {
  /** Overrides the file's own encoding: Save files with a specific encoding, or a legacy file the user agreed to convert. */
  readonly encoding?: Exclude<FileEncoding, 'legacy'>
}

/** Paths are granted by native dialogs, never accepted from renderer requests. */
export class SqlFileStore {
  private files = new Map<string, SqlFile>()
  constructor(private readonly options: SqlFileStoreOptions = {}) {}

  async read(path: string): Promise<OpenSqlFile> {
    const absolutePath = resolve(path)
    // A FIFO or device is refused without blocking; only a regular file is read, and at most one byte past the limit.
    const bytes = await readRegularFile(absolutePath, maxSqlFileBytes)
    if (!bytes) throw new Error(`${basename(absolutePath)} is not a file.`)
    if (bytes.length > maxSqlFileBytes) throw new Error('SQL files must be smaller than 5 MB.')
    const decoded = detectAndDecode(bytes, this.options.legacyLabel?.() ?? 'windows-1252', this.options.decoder)
    const { eol, mixed } = detectEol(decoded.text, this.platform)
    const existing = this.find(absolutePath)
    const file: SqlFile = {
      id: existing?.id ?? randomUUID(), name: basename(absolutePath), path: absolutePath, encoding: decoded.encoding,
      ...decoded.codePage ? { codePage: decoded.codePage } : {}, readOnly: await isReadOnly(absolutePath)
    }
    this.files.set(file.id, file)
    return { ...file, content: decoded.text, eol, mixedEol: mixed }
  }

  get(fileId: string): SqlFile {
    const entry = this.files.get(fileId)
    if (!entry) throw new Error('This SQL file is no longer open. Use Save As to select a file.')
    return entry
  }

  /** Whether the registered file cannot be written now: its attribute may have changed since it was read. */
  async readOnly(fileId: string): Promise<boolean> {
    return isReadOnly(await writeTarget(this.get(fileId).path))
  }
  /** Overwrite in Save of Read-Only File: gives the owner write permission, which clears Windows' read-only attribute. */
  async makeWritable(fileId: string): Promise<void> {
    const target = await writeTarget(this.get(fileId).path)
    await chmod(target, ((await stat(target)).mode & 0o7777) | 0o200)
  }

  /**
   * Writes `content` to a temporary file beside the real target (a symbolic link's target, so the link survives), with
   * the existing file's permissions on POSIX, then replaces the target with it: a failed save leaves the file as it was.
   * A read-only target is refused, since POSIX's rename would replace it regardless.
   */
  async save(content: string, fileId?: string, selectedPath?: string, kind: DocumentKind = 'sql', options: SaveOptions = {}): Promise<SqlFile> {
    const existing = fileId ? this.files.get(fileId) : undefined
    if (fileId && !existing) throw new Error('Unknown SQL file.')
    if (!selectedPath && !existing) throw new Error('Select a file using Save As first.')
    const path = resolve(selectedPath ?? existing!.path)
    const owner = this.find(path)
    if (owner && owner.id !== existing?.id) throw new Error(`${owner.name} is open in another query tab. Close that tab before saving over it.`)
    const encoding = options.encoding ?? existing?.encoding ?? 'utf8'
    if (encoding === 'legacy') throw new Error(`${existing?.name ?? basename(path)} was read as ${existing?.codePage ?? 'ANSI'}, which Varia SQL Manager does not write. Save it as Unicode.`)
    const bytes = encodeText(content, encoding)
    if (bytes.length > fileKinds[kind].maxBytes) throw new Error(fileKinds[kind].tooLarge)
    const target = await writeTarget(path)
    let mode: number | undefined
    try {
      const info = await stat(target)
      if (!info.isFile()) throw new Error(`${basename(path)} is not a file.`)
      mode = info.mode & 0o7777
    } catch (error) { if (!missing(error)) throw error }
    if (mode !== undefined && await isReadOnly(target)) throw new Error(`${basename(path)} is read-only.`)
    const temporaryPath = join(dirname(target), `.varia-${randomUUID()}.tmp`)
    try {
      const temporaryFile = await open(temporaryPath, 'wx')
      try {
        await temporaryFile.writeFile(bytes)
        // A 0600 file must not become 0644 (the umask's default) when it is replaced.
        if (posix && mode !== undefined) await temporaryFile.chmod(mode)
        await temporaryFile.sync()
      } finally { await temporaryFile.close() }
      // Retries Windows' brief holds (antivirus, indexer, OneDrive) instead of failing the save.
      await (this.options.replace ?? replaceFile)(temporaryPath, target)
    } finally { await rm(temporaryPath, { force: true }) }
    const file: SqlFile = { id: existing?.id ?? randomUUID(), name: basename(path), path, encoding, readOnly: false }
    this.files.set(file.id, file)
    return file
  }

  release(fileId: string): void { this.files.delete(fileId) }
  clear(): void { this.files.clear() }
  private get platform(): NodeJS.Platform { return this.options.platform ?? process.platform }
  private find(path: string): SqlFile | undefined { return [...this.files.values()].find(entry => samePath(entry.path, path, this.platform)) }
}
