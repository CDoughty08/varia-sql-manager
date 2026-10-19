import { constants } from 'node:fs'
import { access, chmod, lstat, open, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { documentKinds, type DocumentKind, type FileChange, type FileEncoding, type OpenSqlFile, type SaveSqlFile, type SqlFile } from '../shared/contracts'
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
/** varia:confirm-reload: main names the file from its own registration. */
export const reloadPromptSchema = z.object({ fileId: z.uuid(), dirty: z.boolean(), more: z.boolean() }).strict()
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
// A file system that cannot change a file's group (or a user outside the group) leaves the saver's.
const ownershipCodes = new Set(['EPERM', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])

/** What the last read or save saw of a registered file, so a change by another program is noticed, and reported once.
 *  `missing` keeps the last content's hash: a file deleted and then written back unchanged is no change. */
interface Stamp { readonly size: number; readonly mtimeMs: number; readonly sha256: string; readonly missing?: true }
type Comparison = { readonly change?: FileChange['change']; readonly stamp: Stamp } | undefined
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
/**
 * Comparisons running at once, counting those a check gave up on that have not settled, and how long one may take: a
 * slow network share counts as unchanged instead of stalling. A comparison that hangs holds one of libuv's four threads
 * (every fs call in main shares them), so at most two can ever be held, and a file whose comparison has not settled is
 * not compared again.
 */
export const fileCheckLimits = { concurrency: 2, timeoutMs: 2000 } as const
/** The largest file any document kind saves: a change check hashes up to this, so a large saved value is not misread. */
const maxStampBytes = Math.max(...Object.values(fileKinds).map(kind => kind.maxBytes))

export interface SqlFileStoreOptions {
  /** The ANSI code page's WHATWG label for files that are neither UTF-8 nor UTF-16 (`legacyCodePage`); read when needed. */
  readonly legacyLabel?: () => string
  readonly decoder?: DecoderFactory
  readonly platform?: NodeJS.Platform
  /** The rename that replaces a file; tests watch it. */
  readonly replace?: typeof replaceFile
  /** Resolves symbolic links; tests make it fail as it does on some volumes. */
  readonly realpath?: (path: string) => Promise<string>
  /** Looks at a registered file for a change check; tests make it slow, as a network share can be. */
  readonly stat?: (path: string) => Promise<{ isFile(): boolean; size: number; mtimeMs: number }>
}
export interface SaveOptions {
  /** Overrides the file's own encoding: Save files with a specific encoding, or a legacy file the user agreed to convert. */
  readonly encoding?: Exclude<FileEncoding, 'legacy'>
  /** Overwrite in Save of Read-Only File: a read-only file gets write permission just before it is replaced (which clears
   *  Windows' read-only attribute), and its mode back if the save fails. */
  readonly overwriteReadOnly?: boolean
}

/** Paths are granted by native dialogs, never accepted from renderer requests. */
export class SqlFileStore {
  private files = new Map<string, SqlFile>()
  private stamps = new Map<string, Stamp>()
  /** Files a check reported changed that were not reloaded since: their next Save asks before replacing that change. */
  private conflicts = new Set<string>()
  /** Change-check comparisons not settled yet, including ones a check stopped waiting for. */
  private comparing = new Map<string, Promise<Comparison>>()
  constructor(private readonly options: SqlFileStoreOptions = {}) {}

  /**
   * Reads and registers the file at `path`. A file already registered keeps its id, and keeps what it was last read as:
   * an Open that finds its tab must not hide a change the tab has not seen (`reload` is the read that does show it).
   */
  async read(path: string, reload = false): Promise<OpenSqlFile> {
    const absolutePath = resolve(path)
    // A FIFO or device is refused without blocking; only a regular file is read, and at most one byte past the limit.
    const bytes = await readRegularFile(absolutePath, maxSqlFileBytes)
    if (!bytes) throw new Error(`${basename(absolutePath)} is not a file.`)
    if (bytes.length > maxSqlFileBytes) throw new Error('SQL files must be smaller than 5 MB.')
    const decoded = detectAndDecode(bytes, this.options.legacyLabel?.() ?? 'windows-1252', this.options.decoder)
    const { eol, mixed } = detectEol(decoded.text, this.platform)
    // One file keeps one registration, path and name, whatever case or link it is reached through, so the page finds
    // its tab instead of opening a second one that would save over the first.
    const existing = await this.owner(absolutePath)
    // The tab of a file opened again keeps the text it has, so its Save must keep writing what that text was read as.
    const file: SqlFile = existing && !reload ? existing : {
      id: existing?.id ?? randomUUID(), name: existing?.name ?? basename(absolutePath), path: existing?.path ?? absolutePath, encoding: decoded.encoding,
      ...decoded.codePage ? { codePage: decoded.codePage } : {}, readOnly: await isReadOnly(absolutePath)
    }
    this.files.set(file.id, file)
    if (reload) this.conflicts.delete(file.id)
    if (!existing || reload || !this.stamps.has(file.id)) {
      const info = await stat(absolutePath)
      this.stamps.set(file.id, { size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(bytes) })
    }
    return { ...file, content: decoded.text, eol, mixedEol: mixed }
  }

  get(fileId: string): SqlFile {
    const entry = this.files.get(fileId)
    if (!entry) throw new Error('This SQL file is no longer open. Use Save As to select a file.')
    return entry
  }

  /** Whether the registered file cannot be written now: its attribute may have changed since it was read. */
  async readOnly(fileId: string): Promise<boolean> {
    return isReadOnly(await this.writeTarget(this.get(fileId).path))
  }

  /**
   * Writes `content` to a temporary file beside the real target (a symbolic link's target, so the link survives), with
   * the existing file's permissions and group on POSIX, then replaces the target with it: a failed save leaves the file
   * as it was. A read-only target is refused without `overwriteReadOnly`, since POSIX's rename would replace it regardless.
   */
  async save(content: string, fileId?: string, selectedPath?: string, kind: DocumentKind = 'sql', options: SaveOptions = {}): Promise<SqlFile> {
    const existing = fileId ? this.files.get(fileId) : undefined
    if (fileId && !existing) throw new Error('Unknown SQL file.')
    if (!selectedPath && !existing) throw new Error('Select a file using Save As first.')
    const path = resolve(selectedPath ?? existing!.path)
    const owner = await this.owner(path, existing?.id)
    if (owner) throw new Error(`${owner.name} is open in another query tab. Close that tab before saving over it.`)
    const encoding = options.encoding ?? existing?.encoding ?? 'utf8'
    if (encoding === 'legacy') throw new Error(`${existing?.name ?? basename(path)} was read as ${existing?.codePage ?? 'ANSI'}, which Varia SQL Manager does not write. Save it as Unicode.`)
    const bytes = encodeText(content, encoding)
    if (bytes.length > fileKinds[kind].maxBytes) throw new Error(fileKinds[kind].tooLarge)
    const target = await this.writeTarget(path)
    let current: { mode: number; uid: number; gid: number } | undefined
    try {
      const info = await stat(target)
      if (!info.isFile()) throw new Error(`${basename(path)} is not a file.`)
      current = { mode: info.mode & 0o7777, uid: info.uid, gid: info.gid }
    } catch (error) { if (!missing(error)) throw error }
    let restore: number | undefined
    if (current && await isReadOnly(target)) {
      if (!options.overwriteReadOnly) throw new Error(`${basename(path)} is read-only.`)
      restore = current.mode
      current.mode |= 0o200
      await chmod(target, current.mode)
    }
    const temporaryPath = join(dirname(target), `.varia-${randomUUID()}.tmp`)
    let replaced = false
    try {
      const temporaryFile = await open(temporaryPath, 'wx')
      try {
        await temporaryFile.writeFile(bytes)
        if (posix && current) {
          // The new file is the saver's: a group-shared file keeps its group, and root keeps the owner too. Before chmod,
          // since a change of owner clears set-user-ID and set-group-ID.
          await temporaryFile.chown(process.getuid?.() === 0 ? current.uid : -1, current.gid).catch((error: NodeJS.ErrnoException) => { if (!ownershipCodes.has(error.code ?? '')) throw error })
          // A 0600 file must not become 0644 (the umask's default) when it is replaced.
          await temporaryFile.chmod(current.mode)
        }
        await temporaryFile.sync()
      } finally { await temporaryFile.close() }
      // Retries Windows' brief holds (antivirus, indexer, OneDrive) instead of failing the save.
      await (this.options.replace ?? replaceFile)(temporaryPath, target)
      replaced = true
    } finally {
      await rm(temporaryPath, { force: true })
      if (!replaced && restore !== undefined) await chmod(target, restore).catch(() => {})
    }
    const file: SqlFile = { id: existing?.id ?? randomUUID(), name: basename(path), path, encoding, readOnly: false }
    this.files.set(file.id, file)
    const info = await stat(target)
    this.stamps.set(file.id, { size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(bytes) })
    this.conflicts.delete(file.id)
    return file
  }

  /** Reads a registered file again (Yes in File changed), keeping its id; what it sees becomes the file's stamp. */
  async reload(fileId: string): Promise<OpenSqlFile> {
    const opened = await this.read(this.get(fileId).path, true)
    if (opened.id !== fileId) throw new Error('This SQL file is no longer open. Use Save As to select a file.')
    return opened
  }

  /**
   * The registered files another program changed or deleted since they were last read, saved or checked, each reported
   * once: the stamp moves as the change is reported. Only different content counts (a touched file is no change), and
   * a file that cannot be read in time counts as unchanged and is checked again next time.
   */
  async check(limits: { concurrency: number; timeoutMs: number } = fileCheckLimits): Promise<FileChange[]> {
    // A file still being compared (its share has not answered) counts as unchanged; it is compared once that settles.
    const ids = [...this.files.keys()].filter(id => !this.comparing.has(id)), found = new Map<string, FileChange['change']>()
    let next = 0
    const worker = async () => {
      // Past the limit, the rest count as unchanged until a later check, rather than queue behind a hung call.
      while (next < ids.length && this.comparing.size < limits.concurrency) {
        const id = ids[next++]
        const comparing = this.compare(id).catch(() => undefined).finally(() => { if (this.comparing.get(id) === comparing) this.comparing.delete(id) })
        this.comparing.set(id, comparing)
        let timer: NodeJS.Timeout | undefined
        const late = new Promise<undefined>(resolve => { timer = setTimeout(resolve, limits.timeoutMs, undefined) })
        const result = await Promise.race([comparing, late])
        clearTimeout(timer)
        // A comparison that finishes after its time is dropped with its stamp, so the change is reported next time.
        if (!result || !this.files.has(id)) continue
        this.stamps.set(id, result.stamp)
        if (result.change) found.set(id, result.change)
        if (result.change === 'modified') this.conflicts.add(id)
        // A deleted file has nothing left to replace: Save writes it again without asking.
        else if (result.change === 'deleted') this.conflicts.delete(id)
      }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(0, limits.concurrency - this.comparing.size), ids.length) }, worker))
    return ids.flatMap(fileId => { const change = found.get(fileId); return change ? [{ fileId, change }] : [] })
  }

  /** Whether another program changed the registered file's content since it was last read or saved (a change a check
   *  reported and the user did not reload counts): Save asks before replacing that. A deleted file is no change here,
   *  since Save writes it again. */
  async changedOnDisk(fileId: string): Promise<boolean> {
    this.get(fileId)
    return this.conflicts.has(fileId) || (await this.compare(fileId).catch(() => undefined))?.change === 'modified'
  }

  /** How the file differs from its stamp, and the stamp that records what was seen; undefined when it cannot tell. */
  private async compare(fileId: string): Promise<Comparison> {
    const file = this.files.get(fileId), stamp = this.stamps.get(fileId)
    if (!file || !stamp) return undefined
    let info
    try { info = await (this.options.stat ?? stat)(file.path) }
    catch (error) {
      if (!missing(error)) return undefined
      return stamp.missing ? undefined : { change: 'deleted', stamp: { ...stamp, missing: true } }
    }
    if (!info.isFile()) return undefined
    if (!stamp.missing && info.size === stamp.size && info.mtimeMs === stamp.mtimeMs) return undefined
    // Hashed up to the largest file a save writes: a 6 MB XML document touched by another program is no change.
    const bytes = await readRegularFile(file.path, maxStampBytes)
    if (!bytes) return undefined
    const seen: Stamp = { size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(bytes) }
    return seen.sha256 === stamp.sha256 ? { stamp: seen } : { change: 'modified', stamp: seen }
  }

  release(fileId: string): void { this.files.delete(fileId); this.stamps.delete(fileId); this.conflicts.delete(fileId) }
  clear(): void { this.files.clear(); this.stamps.clear(); this.conflicts.clear() }
  private get platform(): NodeJS.Platform { return this.options.platform ?? process.platform }
  /** Where a save writes: a symbolic link's target, so the link stays a link; the path itself for a new file. */
  private async writeTarget(path: string): Promise<string> {
    try { return await (this.options.realpath ?? realpath)(path) }
    catch (error) {
      if (missing(error)) return path
      // Windows' realpath fails on some volumes (RAM disks, some virtual drives); only a link needs resolving.
      if (!(await lstat(path)).isSymbolicLink()) return path
      throw error
    }
  }
  /**
   * The registration, other than `except`, of the file at `path`: the same path (in any case on Windows), or the same
   * file reached through a symbolic link, which a save would write too.
   */
  private async owner(path: string, except?: string): Promise<SqlFile | undefined> {
    const others = [...this.files.values()].filter(entry => entry.id !== except)
    const literal = others.find(entry => samePath(entry.path, path, this.platform))
    if (literal || !others.length) return literal
    const resolved = async (candidate: string) => this.writeTarget(candidate).catch(() => candidate)
    const target = await resolved(path)
    for (const entry of others) if (samePath(await resolved(entry.path), target, this.platform)) return entry
    return undefined
  }
}

/** The questions a save may ask, as main's native dialogs. */
export interface SavePrompts {
  /** Save of Read-Only File, for the registered file at `path`. */
  readOnly(path: string): Promise<'saveAs' | 'overwrite' | 'cancel'>
  /** File changed: another program changed the registered file since it was read; true saves over that change. */
  changed(path: string): Promise<boolean>
  /** Save as Unicode, for a file read in the ANSI code page. */
  unicode(name: string, codePage: string): Promise<boolean>
  /** The Save dialog, at the registered file's path (undefined for a document never saved); undefined when cancelled. */
  saveDialog(registeredPath: string | undefined): Promise<string | undefined>
}

/**
 * varia:files-save once validated: Save of Read-Only File, File changed (while `detectChanges`, Tools › Options' Detect
 * when file is changed outside the environment), Save as Unicode and the Save dialog, in that order, then the write. A Cancel at any of them writes and changes nothing, so Overwrite's write permission waits for the save itself.
 * `specificEncoding` is Save files with a specific encoding's Save encoding while that is on: every file is converted
 * without asking, a legacy one too.
 */
export async function saveDocument(files: SqlFileStore, request: SaveSqlFile, specificEncoding: SaveOptions['encoding'], prompts: SavePrompts, detectChanges = false): Promise<SqlFile | null> {
  let saveAs = !request.fileId || request.saveAs, overwriteReadOnly = false
  if (!saveAs && request.fileId && await files.readOnly(request.fileId)) {
    const answer = await prompts.readOnly(files.get(request.fileId).path)
    if (answer === 'cancel') return null
    if (answer === 'saveAs') saveAs = true
    else overwriteReadOnly = true
  }
  if (!saveAs && detectChanges && request.fileId && await files.changedOnDisk(request.fileId) && !await prompts.changed(files.get(request.fileId).path)) return null
  const registered = request.fileId ? files.get(request.fileId) : undefined
  let encoding = specificEncoding
  if (!encoding && registered?.encoding === 'legacy') {
    if (!await prompts.unicode(registered.name, registered.codePage ?? 'ANSI')) return null
    encoding = 'utf8bom'
  }
  let selectedPath: string | undefined
  if (saveAs) {
    selectedPath = await prompts.saveDialog(registered?.path)
    if (!selectedPath) return null
  }
  return files.save(request.content, request.fileId, selectedPath, request.kind, { ...encoding ? { encoding } : {}, ...overwriteReadOnly ? { overwriteReadOnly } : {} })
}
