import { randomUUID } from 'node:crypto'
import { lstat, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { z } from 'zod'
import type { ResultsCopyParams, ResultsExportParams, ResultsFormat, ResultsJobProgress, ResultsJobResult, SavedLocalResults, SavedResults } from '../shared/contracts'
import type { JobProgressEvent } from '../shared/ipc/port-messages'
import { cancelReasons, limits as wire, type CancelReason } from '../shared/ipc/wire/protocol'
import type { StreamSink } from './backend/connection'
import { BackendError, sentences } from './backend/errors'
import type { BackendSupervisor } from './backend/supervisor'
import { sanitizeFileName } from './file-names'
import { localExportBytes, localSaveBytes, localTableLimits } from '../shared/results/local-table'
import { writeBytesAtomic } from './json-file'
import { localSaveRequestSchema, resultsCopyRequestSchema, resultsSaveRequestSchema } from './validation'

/** How Save Results As writes NULL: CSV as an empty field (an empty string is ""), tab-delimited text as NULL; JSON always
 *  writes null. Copy keeps SSMS's NULL. The header row follows Tools › Options (`exportHeaders`). */
export const exportDefaults = { nullText: { csv: 'empty', tsv: 'NULL', json: 'NULL' } } as const satisfies { nullText: Record<ResultsFormat, ResultsExportParams['nullText']> }

const extensions: Record<ResultsFormat, string> = { csv: 'csv', tsv: 'txt', json: 'json' }
const filters: Record<ResultsFormat, { name: string; extensions: string[] }> = {
  csv: { name: 'CSV (Comma delimited)', extensions: ['csv'] },
  tsv: { name: 'Text (Tab delimited)', extensions: ['txt', 'tsv'] },
  json: { name: 'JSON', extensions: ['json'] }
}
const formatsByExtension: Record<string, ResultsFormat> = { '.csv': 'csv', '.txt': 'tsv', '.tsv': 'tsv', '.tab': 'tsv', '.json': 'json' }

export const jobSentences = {
  busy: 'Another Save Results As is in progress. Wait for it to finish or cancel it.',
  closedBeforeSave: 'These results were closed before they could be saved.',
  invalid: 'The results request was invalid.',
  copyTooLarge: `The selection is too large to copy (more than ${wire.jobs.copyBytes / 1024 / 1024} MB). Use Save Results As instead.`,
  copyCancelled: 'The copy was cancelled.',
  saveTooLarge: `These rows are too large to save (over ${localTableLimits.saveBytes / 1024 / 1024} MB).`,
  /** EXPORT_FAILED tokens; the backend never sends a path or an OS message, so the sentence names only the file. */
  exportFailed: (token: string, fileName: string): string => 'Could not save the results: ' + (({
    ACCESS: `access to ${fileName} is denied.`,
    DISK_FULL: 'the disk is full.',
    IN_USE: `${fileName} is open in another program.`,
    NOT_FOUND: 'the folder no longer exists.',
    IS_DIRECTORY: `${fileName} is a folder.`
  } as Partial<Record<string, string>>)[token] ?? `${fileName} could not be written.`)
} as const

/** The format an extension chooses; any other extension, or none, keeps the requested format. */
export function formatFromPath(path: string): ResultsFormat | undefined { return formatsByExtension[extname(path).toLowerCase()] }

/**
 * Removes what an export the backend never finished left beside its target: the temporary file, and the backup of the
 * replaced file (Windows) once the target exists again (otherwise it is the only copy of the old file). A backend killed
 * mid-save cannot clean up, and one that is still exiting may hold the file open (Windows refuses the delete then), so
 * this runs again after the stop grace period.
 */
export function removeExportLeftovers(target: string, temporaryId: string, retryMs: number = wire.timers.stopGraceMs + 1000): Promise<void> {
  const prefix = join(dirname(target), `.varia-${temporaryId}`)
  const sweep = async () => {
    await rm(prefix + '.tmp', { force: true }).catch(() => {})
    if (await stat(target).then(() => true, () => false)) await rm(prefix + '.bak', { force: true }).catch(() => {})
  }
  setTimeout(() => { void sweep() }, retryMs).unref?.()
  return sweep()
}

export interface SaveDialog {
  (options: { title: string; defaultPath: string; filters: { name: string; extensions: string[] }[]; properties: ('showOverwriteConfirmation' | 'createDirectory')[] }): Promise<{ canceled: boolean; filePath?: string }>
}
/** The backend side of the jobs; supervisorJobs adapts BackendSupervisor. */
export interface JobsBackend {
  readyGeneration(): number | undefined
  copy(generation: number, params: ResultsCopyParams, o: { sink: StreamSink; credit: number; onProgress(progress: JobProgressEvent): void; onSent(id: number): void }): Promise<ResultsJobResult>
  export(generation: number, params: ResultsExportParams, o: { onProgress(progress: JobProgressEvent): void; onSent(id: number): void }): Promise<ResultsJobResult>
  credit(generation: number, id: number, bytes: number): void
  cancel(generation: number, id: number, reason: CancelReason): void
}
export interface JobHostDeps {
  backend: JobsBackend
  /** ResultsPortHost.owns: the current generation holds the result for this renderer. */
  owns(generation: number, resultId: number): boolean
  /** ResultsPortHost.liveNewest: for a live snapshot table's revision, what names the table's newest revision later. */
  liveNewest?(generation: number, resultId: number): (() => number | undefined) | undefined
  writeClipboard(text: string): void
  showSaveDialog: SaveDialog
  documentsDir(): string
  /** Pushes progress to the renderer (varia:results-job). */
  progress(progress: ResultsJobProgress): void
  /** Include column headers when copying or saving the results (Tools › Options › Query Results › Results to Grid). */
  exportHeaders(): Promise<boolean>
  platform: NodeJS.Platform
  now?: () => number
  /** stat of a local save's target after a refused replace, replaced in tests. */
  statTarget?: (path: string) => Promise<{ isDirectory(): boolean; mode: number }>
  /** writeBytesAtomic (a local table's save), replaced in tests. */
  writeFile?: (path: string, data: Uint8Array) => Promise<void>
  /** removeExportLeftovers, replaced in tests. */
  removeLeftovers?: (target: string, temporaryId: string) => Promise<void>
}

/** A failed local save's error code as the backend's EXPORT_FAILED tokens name it. */
const errnoTokens: Partial<Record<string, string>> = { EACCES: 'ACCESS', EPERM: 'ACCESS', ENOSPC: 'DISK_FULL', EBUSY: 'IN_USE', ENOENT: 'NOT_FOUND', EISDIR: 'IS_DIRECTORY' }

/**
 * A local save's write: into the folder the dialog chose, never one recreated (a folder deleted since says so), and a
 * replaced file keeps its permission bits, as a results save's does (Unix; Windows keeps no attributes, docs/ipc.md).
 */
export async function writeLocalSave(path: string, data: Uint8Array, platform: NodeJS.Platform = process.platform): Promise<void> {
  // A folder, or a link to one, is refused before anything is written, as ResultJobs' Directory.Exists check refuses it:
  // a rename would replace the link with the file.
  const followed = await stat(path).catch(() => undefined)
  if (followed?.isDirectory()) throw Object.assign(new Error('The target is a folder.'), { code: 'EISDIR' })
  const target = platform === 'win32' ? undefined : await lstat(path).catch(() => undefined)
  const linked = target?.isSymbolicLink() ? followed : undefined
  await writeBytesAtomic(path, data, { createFolder: false, ...localSaveMode(target, linked) })
}
/**
 * The mode a local save's file takes, off Windows only, as ResultJobs': a file keeps its bits exactly; a symlink to a
 * file is replaced by a file with the linked file's read and write bits, narrowed by the umask (LinkedMode). Windows
 * gets none: a mode without write bits would create a read-only file there.
 */
export function localSaveMode(target: { isFile(): boolean; isSymbolicLink(): boolean; mode: number } | undefined, linked: { isFile(): boolean; mode: number } | undefined): { mode?: number; umask?: boolean } {
  if (target?.isFile()) return { mode: target.mode & 0o777 }
  if (target?.isSymbolicLink() && linked?.isFile()) return { mode: linked.mode & 0o666, umask: true }
  return {}
}

/** What a request of a grid drawn transposed adds to the backend's parameters. */
const turnedParams = (request: { transposed?: boolean; headerColumn?: number }): { transposed?: true; headerColumn?: number } =>
  request.transposed ? { transposed: true, ...request.headerColumn === undefined ? {} : { headerColumn: request.headerColumn } } : {}

/** One running copy or save: CANCEL reaches it once its request is written. */
class Job {
  private id = 0
  private reason: CancelReason | undefined
  private lastProgress = Number.NEGATIVE_INFINITY
  constructor(readonly jobId: string, readonly kind: 'copy' | 'save', private readonly generation: number, private readonly host: JobHostDeps, private readonly fileName?: string) {
    // A save's strip names its file from the start, which only main knows once the dialog has closed.
    if (fileName !== undefined) this.report({ rowsDone: 0, rowsTotal: 0, bytes: 0 })
  }
  get cancelled(): boolean { return this.reason !== undefined }
  sent(id: number): void {
    this.id = id
    if (this.reason !== undefined) this.host.backend.cancel(this.generation, id, this.reason)
  }
  cancel(reason: CancelReason): void {
    if (this.reason !== undefined) return
    this.reason = reason
    if (this.id) this.host.backend.cancel(this.generation, this.id, reason)
  }
  credit(bytes: number): void { if (this.id && this.reason === undefined) this.host.backend.credit(this.generation, this.id, bytes) }
  /** At most 4 a second; the latest wins. */
  progress(event: Omit<JobProgressEvent, 'type'>): void {
    if ((this.host.now ?? Date.now)() - this.lastProgress < 1000 / wire.jobs.progressPerSecond) return
    this.report(event)
  }
  private report(event: Omit<JobProgressEvent, 'type'>): void {
    this.lastProgress = (this.host.now ?? Date.now)()
    this.host.progress({ jobId: this.jobId, kind: this.kind, rowsDone: event.rowsDone, rowsTotal: event.rowsTotal, bytes: event.bytes, ...this.fileName !== undefined ? { fileName: this.fileName } : {} })
  }
}

/**
 * Copy and Save Results As for the window: one of each at a time. The renderer names a result it owns and never a path;
 * the backend formats the text (ResultTextWriter). A copy streams UTF-8 here, is decoded chunk by chunk under a hard
 * cap, and goes to the clipboard once complete; a save writes the file main's dialog returned, and only its name comes
 * back. A new copy cancels the running one.
 */
export class ResultsJobHost {
  private readonly deps: JobHostDeps
  private copying: Job | undefined
  private saving: Job | undefined
  private saveBusy = false
  private lastDir: string | undefined
  private lastFormat: ResultsFormat | undefined

  constructor(deps: JobHostDeps) { this.deps = deps }

  private check(generation: number, resultId: number, message: string = sentences.resultUnavailable): void {
    if (!this.deps.owns(generation, resultId) || this.deps.backend.readyGeneration() !== generation) throw new BackendError('RESULT_UNAVAILABLE', message)
  }

  async copy(value: unknown): Promise<ResultsJobResult> {
    const parsed = resultsCopyRequestSchema.safeParse(value)
    if (!parsed.success) throw new BackendError('INVALID_REQUEST', jobSentences.invalid)
    const request = parsed.data
    this.check(request.generation, request.resultId)
    this.copying?.cancel(cancelReasons.user)
    const job = this.copying = new Job(request.jobId, 'copy', request.generation, this.deps)
    const maxBytes = wire.jobs.copyBytes
    // The BOM of a value at the very start is text, not a byte order mark.
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    const parts: string[] = []
    let received = 0, overflow = false
    const sink: StreamSink = {
      data: (_seq, body) => {
        if (job.cancelled) return
        received += body.byteLength
        // The backend checks its estimate first; this is the hard cap if the text still runs over.
        if (received > maxBytes + wire.jobs.chunkBytes) { overflow = true; parts.length = 0; job.cancel(cancelReasons.consumerGone); return }
        parts.push(decoder.decode(new Uint8Array(body), { stream: true }))
        job.credit(body.byteLength)
      }
    }
    try {
      const result = await this.deps.backend.copy(request.generation, { resultId: request.resultId, parts: request.parts, headers: request.headers, eol: this.deps.platform === 'win32' ? 'crlf' : 'lf', maxBytes, ...(request.viewId === undefined ? {} : { viewId: request.viewId }), ...turnedParams(request) },
        { sink, credit: wire.jobs.copyCredit, onProgress: event => job.progress(event), onSent: id => job.sent(id) })
      if (overflow) throw new BackendError('TOO_LARGE', jobSentences.copyTooLarge)
      // The backend may finish a copy cancelled late (its credit covered the rest), but the chunks after the cancel were
      // dropped: the clipboard keeps its text rather than take a cut-off selection.
      if (job.cancelled) throw new BackendError('CANCELLED', jobSentences.copyCancelled)
      parts.push(decoder.decode())
      this.deps.writeClipboard(parts.join(''))
      return result
    } catch (error) {
      throw overflow ? new BackendError('TOO_LARGE', jobSentences.copyTooLarge) : error
    } finally {
      if (this.copying === job) this.copying = undefined
    }
  }

  /**
   * A later clipboard write from the renderer (a local grid's copy, Copy Column Name, a selection's text) supersedes a
   * results copy still running: cancelled, it never writes its older selection over the newer one.
   */
  supersedeCopy(): void { this.copying?.cancel(cancelReasons.user) }

  async save(value: unknown): Promise<SavedResults | null> {
    const parsed = resultsSaveRequestSchema.safeParse(value)
    if (!parsed.success) throw new BackendError('INVALID_REQUEST', jobSentences.invalid)
    const request = parsed.data
    if (this.saveBusy) throw new BackendError('JOB_BUSY', jobSentences.busy)
    this.saveBusy = true
    let fileName = ''
    // The export's files, from the moment the backend may write them.
    let writing: { path: string; temporaryId: string } | undefined
    try {
      this.check(request.generation, request.resultId)
      // A view is of one result: a live table's newer revision has none of its views.
      const newest = request.viewId === undefined ? this.deps.liveNewest?.(request.generation, request.resultId) : undefined
      // '{tab}-Result{n}-Pivot', '{tab}-Open orders' (save-names.ts): a long name gives way, never the suffix that tells
      // results apart. A request without one keeps a '-Result{n}' it ends in, as before suffixes were sent.
      const suffix = request.suggestedSuffix ?? /-Result\d+$/.exec(request.suggestedName)?.[0] ?? ''
      const chosen = await this.chooseFile(request.suggestedName, suffix, request.format)
      if (!chosen) return null
      const { path, format } = chosen
      fileName = basename(path)
      const headers = await this.deps.exportHeaders()
      // A live table retires each revision two samples on, sooner than most dialogs close: its newest revision is saved,
      // the one the grid shows now. Any other result must still be there.
      const resultId = newest?.() ?? request.resultId
      this.check(request.generation, resultId, jobSentences.closedBeforeSave)
      const job = this.saving = new Job(request.jobId, 'save', request.generation, this.deps, fileName)
      writing = { path, temporaryId: randomUUID().replaceAll('-', '') }
      const result = await this.deps.backend.export(request.generation, { resultId, path, format, headers, nullText: exportDefaults.nullText[format], temporaryId: writing.temporaryId, ...(request.viewId === undefined ? {} : { viewId: request.viewId }), ...turnedParams(request) },
        { onProgress: event => job.progress(event), onSent: id => job.sent(id) })
      this.lastDir = dirname(path)
      this.lastFormat = format
      return { ...result, fileName, format }
    } catch (error) {
      if (error instanceof BackendError && error.code === 'EXPORT_FAILED') throw new BackendError('EXPORT_FAILED', jobSentences.exportFailed(error.message, fileName))
      // The backend stopped (crashed, killed, or restarted) before it could remove its own files.
      if (writing && error instanceof BackendError && (error.code === 'BACKEND_LOST' || error.code === 'BACKEND_UNAVAILABLE')) void (this.deps.removeLeftovers ?? removeExportLeftovers)(writing.path, writing.temporaryId).catch(() => {})
      throw error
    } finally {
      this.saving = undefined
      this.saveBusy = false
    }
  }

  /**
   * Why a local save's write failed, as a results save says it: Windows refuses to replace a file another program holds,
   * a read-only file or a folder with EPERM, EACCES or EBUSY at the rename (writeBytesAtomic marks it), where the backend
   * says IN_USE, ACCESS or IS_DIRECTORY.
   */
  private async writeFailure(error: unknown, path: string): Promise<string> {
    const { code, replacing } = error as NodeJS.ErrnoException & { replacing?: boolean }
    if (replacing && this.deps.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
      const found = await (this.deps.statTarget ?? stat)(path).catch(() => undefined)
      // Node reports Windows' read-only attribute as a mode without the owner's write bit.
      return found?.isDirectory() ? 'IS_DIRECTORY' : found && (found.mode & 0o200) === 0 ? 'ACCESS' : 'IN_USE'
    }
    return errnoTokens[code ?? ''] ?? 'IO'
  }
  /**
   * Save Results As of a local table (a Peek list, a Properties table): the same dialog, folder and format memory as a
   * results grid's save, and the same text, written here by the TypeScript twin of ResultTextWriter from the rows the
   * renderer holds; a temporary file renamed over the target, so a failed write leaves no partial file.
   */
  async saveLocal(value: unknown): Promise<SavedLocalResults | null> {
    const parsed = localSaveRequestSchema.safeParse(value)
    if (!parsed.success) throw new BackendError('INVALID_REQUEST', jobSentences.invalid)
    const request = parsed.data
    // Before the dialog when no format could fit; after it, the format chosen. Either way the file is never built.
    if (Math.min(localSaveBytes(request, 'csv'), localSaveBytes(request, 'json')) > localTableLimits.saveBytes) throw new BackendError('TOO_LARGE', jobSentences.saveTooLarge)
    if (this.saveBusy) throw new BackendError('JOB_BUSY', jobSentences.busy)
    this.saveBusy = true
    let fileName = ''
    try {
      const chosen = await this.chooseFile(request.suggestedName, '')
      if (!chosen) return null
      const { path, format } = chosen
      fileName = basename(path)
      if (localSaveBytes(request, format) > localTableLimits.saveBytes) throw new BackendError('TOO_LARGE', jobSentences.saveTooLarge)
      const { data, rows } = await localExportBytes(request, { format, headers: await this.deps.exportHeaders(), nullText: exportDefaults.nullText[format] }, () => new Promise(resolve => setImmediate(resolve)))
      try { await (this.deps.writeFile ?? writeLocalSave)(path, data) } catch (error) {
        throw new BackendError('EXPORT_FAILED', jobSentences.exportFailed(await this.writeFailure(error, path), fileName))
      }
      this.lastDir = dirname(path)
      this.lastFormat = format
      return { fileName, format, rows }
    } finally {
      this.saveBusy = false
    }
  }

  /** Save Results As's dialog: the last folder and format first, the name cut to fit without losing `suffix`. The format
   *  is the chosen file's extension's, else the one asked for. */
  private async chooseFile(suggestedName: string, suffix: string, format?: ResultsFormat): Promise<{ path: string; format: ResultsFormat } | undefined> {
    const requested = format ?? this.lastFormat ?? 'csv'
    const name = sanitizeFileName(suggestedName.slice(0, suggestedName.length - suffix.length) + '.' + extensions[requested], suffix)
    const order: ResultsFormat[] = [requested, ...(['csv', 'tsv', 'json'] as const).filter(item => item !== requested)]
    const selection = await this.deps.showSaveDialog({
      title: 'Save Grid Results', defaultPath: join(this.lastDir ?? this.deps.documentsDir(), name),
      filters: [...order.map(item => filters[item]), { name: 'All Files', extensions: ['*'] }], properties: ['showOverwriteConfirmation', 'createDirectory']
    })
    if (selection.canceled || !selection.filePath) return undefined
    // No extension is appended: the dialog's overwrite confirmation was for exactly this path.
    return { path: selection.filePath, format: formatFromPath(selection.filePath) ?? requested }
  }

  /** Cancels the copy or save with this job id (CANCEL reason 1); it then fails with CANCELLED. */
  cancel(value: unknown): { cancelled: boolean } {
    const jobId = z.uuid().parse(value)
    const job = [this.copying, this.saving].find(item => item?.jobId === jobId)
    job?.cancel(cancelReasons.user)
    return { cancelled: !!job }
  }

  /** The page that started the jobs is gone (reload, crash, window closed). */
  reset(): void {
    this.copying?.cancel(cancelReasons.consumerGone)
    this.saving?.cancel(cancelReasons.consumerGone)
  }
}

/** The supervisor as the jobs' backend: both requests are bound to the generation that holds the result. */
export function supervisorJobs(supervisor: BackendSupervisor): JobsBackend {
  return {
    readyGeneration: () => supervisor.readyGeneration,
    copy: (generation, params, o) => supervisor.request('results.copy', params, { generation, stream: o.sink, credit: o.credit, onProgress: o.onProgress, onSent: id => o.onSent(id) }),
    export: (generation, params, o) => supervisor.request('results.export', params, { generation, onProgress: o.onProgress, onSent: id => o.onSent(id) }),
    credit: (generation, id, bytes) => supervisor.credit(generation, id, bytes),
    cancel: (generation, id, reason) => supervisor.cancel(generation, id, reason)
  }
}
