import { randomUUID } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { z } from 'zod'
import type { ResultsCopyParams, ResultsExportParams, ResultsFormat, ResultsJobProgress, ResultsJobResult, SavedResults } from '../shared/contracts'
import type { JobProgressEvent } from '../shared/ipc/port-messages'
import { cancelReasons, limits as wire, type CancelReason } from '../shared/ipc/wire/protocol'
import type { StreamSink } from './backend/connection'
import { BackendError, sentences } from './backend/errors'
import type { BackendSupervisor } from './backend/supervisor'
import { sanitizeFileName } from './file-names'
import { resultsCopyRequestSchema, resultsSaveRequestSchema } from './validation'

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
  writeClipboard(text: string): void
  showSaveDialog: SaveDialog
  documentsDir(): string
  /** Pushes progress to the renderer (varia:results-job). */
  progress(progress: ResultsJobProgress): void
  /** Include column headers when copying or saving the results (Tools › Options › Query Results › Results to Grid). */
  exportHeaders(): Promise<boolean>
  platform: NodeJS.Platform
  now?: () => number
  /** removeExportLeftovers, replaced in tests. */
  removeLeftovers?: (target: string, temporaryId: string) => Promise<void>
}

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
      const result = await this.deps.backend.copy(request.generation, { resultId: request.resultId, parts: request.parts, headers: request.headers, eol: this.deps.platform === 'win32' ? 'crlf' : 'lf', maxBytes },
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
      const requested = request.format ?? this.lastFormat ?? 'csv'
      // '{tab}-Result{n}' (ResultsService.suggestedName): a long tab name gives way, never the number that tells sets apart.
      const [, base, suffix] = /^([\s\S]*?)(-Result\d+)?$/.exec(request.suggestedName)!
      const name = sanitizeFileName(base + '.' + extensions[requested], suffix)
      const order: ResultsFormat[] = [requested, ...(['csv', 'tsv', 'json'] as const).filter(format => format !== requested)]
      const selection = await this.deps.showSaveDialog({
        title: 'Save Grid Results', defaultPath: join(this.lastDir ?? this.deps.documentsDir(), name),
        filters: [...order.map(format => filters[format]), { name: 'All Files', extensions: ['*'] }], properties: ['showOverwriteConfirmation', 'createDirectory']
      })
      if (selection.canceled || !selection.filePath) return null
      // No extension is appended: the dialog's overwrite confirmation was for exactly this path.
      const path = selection.filePath
      fileName = basename(path)
      const format = formatFromPath(path) ?? requested, headers = await this.deps.exportHeaders()
      this.check(request.generation, request.resultId, jobSentences.closedBeforeSave)
      const job = this.saving = new Job(request.jobId, 'save', request.generation, this.deps, fileName)
      writing = { path, temporaryId: randomUUID().replaceAll('-', '') }
      const result = await this.deps.backend.export(request.generation, { resultId: request.resultId, path, format, headers, nullText: exportDefaults.nullText[format], temporaryId: writing.temporaryId },
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
