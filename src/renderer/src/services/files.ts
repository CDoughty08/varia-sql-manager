import type { ApiResult, OpenSqlFile, SqlFile, VariaApi } from '../../../shared/contracts'
import { lineEndingLabel } from '../../../shared/files/encoding'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { DocumentService } from './documents'
import type { QueryService } from './queries'

type FileApi = Pick<VariaApi, 'openSqlFiles' | 'saveSqlFile' | 'releaseSqlFile' | 'confirmClose' | 'closeWindow' | 'closeWindowCancelled'>
/** The file banner: an error, or a warning that changes nothing (a file whose line endings were mixed). */
export interface FileSnapshot { readonly error: string; readonly kind: 'error' | 'warning' }
const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
/** What a document keeps of an opened file: everything but its text and line endings, which the model holds. */
export const registeredFile = ({ id, name, path, encoding, codePage, readOnly }: OpenSqlFile | SqlFile): SqlFile => ({ id, name, path, encoding, ...codePage ? { codePage } : {}, readOnly })
/** Queries that were running when the prompt opened, and finished since with a transaction: they were not asked about,
 *  so they stay (`open` or `connected`) rather than have it rolled back without asking. */
export const unfinished = (count: number, stayed: 'open' | 'connected'): string => !count ? ''
  : count === 1 ? `1 query finished with an open transaction while this ran and stayed ${stayed}; run it again to be asked about it.`
    : `${count} queries finished with open transactions while this ran and stayed ${stayed}; run it again to be asked about them.`

export class FileService extends SnapshotStore<FileSnapshot> implements Disposable {
  private disposed = false
  private readonly waiters = new Set<() => void>()
  private closing: Promise<void> | undefined
  /** True once the exit flow has confirmed all documents and asked main to close the window. */
  exiting = false
  constructor(private documents: DocumentService, private queries: Pick<QueryService, 'isRunning' | 'mayHaveTransaction' | 'confirmSessions'>, private api: FileApi) { super({ error: '', kind: 'error' }) }
  canRun(): boolean { return !this.disposed && !this.documents.getSnapshot().busy }
  canSave(id = this.documents.getSnapshot().activeId): boolean { return this.canRun() && !!this.documents.get(id) }
  /** A query still executing can close too: main asks to cancel it first. */
  canClose(id = this.documents.getSnapshot().activeId): boolean { return this.canSave(id) }
  reportError(error: string, kind: FileSnapshot['kind'] = 'error'): void {
    const current = this.getSnapshot()
    if (!this.disposed && (error !== current.error || kind !== current.kind)) this.publish({ error, kind })
  }
  /** Save All: a document task, and some query has unsaved changes. */
  canSaveAll(): boolean { return this.canRun() && this.documents.getSnapshot().documents.some(document => document.dirty) }
  clearError(): void { this.reportError('') }
  /** Resolves once no file task runs, or on disposal. */
  private idle(): Promise<void> {
    return new Promise(resolve => {
      const done = () => { unsubscribe(); this.waiters.delete(done); resolve() }
      const unsubscribe = this.documents.subscribe(() => { if (!this.documents.getSnapshot().busy) done() })
      this.waiters.add(done)
    })
  }
  private async perform(action: () => Promise<void>): Promise<void> {
    if (!this.canRun()) return
    this.clearError()
    try { await this.documents.runTask(action) }
    catch (error) { this.reportError(error instanceof Error ? error.message : 'The file operation failed.') }
  }
  /** A new query on the active query's connection, or on `connectionId` and `database`. */
  newFile(connectionId?: string, database?: string): void {
    if (!this.canRun()) return
    this.clearError()
    this.documents.newQuery('', undefined, connectionId, database)
  }
  private async releaseUnclaimed(files: readonly SqlFile[]): Promise<void> {
    const owned = new Set(this.documents.getSnapshot().documents.map(document => document.file?.id))
    for (const id of new Set(files.map(file => file.id))) if (!owned.has(id)) unwrap(await this.api.releaseSqlFile(id))
  }
  async open(): Promise<void> {
    const target = this.documents.active
    await this.perform(async () => {
      const opened = unwrap(await this.api.openSqlFiles())
      const mixed: string[] = []
      try {
        if (this.disposed) return
        for (const file of opened) {
          // Main gives a file one id, however its path was spelled or linked.
          const existing = this.documents.getSnapshot().documents.find(document => document.file?.id === file.id)
          if (existing) { this.documents.activate(existing.id); continue }
          this.documents.create(file.name, file.content, target?.database || 'master', target?.connectionId, false, registeredFile(file), file.eol)
          if (file.mixedEol) mixed.push(`Line endings in ${file.name} were mixed; it will be saved with ${lineEndingLabel(file.eol)} line endings.`)
        }
      } finally { await this.releaseUnclaimed(opened) }
      // Visual Studio asks; this is a notice, and the text opens with one kind of line ending, which Save writes.
      if (mixed.length) this.reportError(mixed.join(' '), 'warning')
    })
  }
  async save(id = this.documents.getSnapshot().activeId, saveAs = false): Promise<void> {
    if (!this.canSave(id)) return
    await this.perform(async () => { await this.documents.save(id, saveAs) })
  }
  /**
   * File › Save All: the queries with unsaved changes, in tab order, as one task. A query never saved asks for its file
   * in turn, as SSMS does; cancelling that dialog stops the rest, and so does a save that fails.
   */
  async saveAll(): Promise<void> {
    if (!this.canSaveAll()) return
    await this.perform(async () => {
      for (const { id } of this.documents.getSnapshot().documents) {
        if (this.disposed) return
        if (!this.documents.get(id)?.dirty) continue
        if (!await this.documents.save(id)) return
      }
    })
  }
  /**
   * Saves text to a file the user picks (Script … to File…), without opening it as a query. Resolves with the saved
   * file, or undefined when the user cancelled or the save failed (reported like any file error). A script arrives
   * whenever its request ends, so behind another file task (a Save dialog, Open, a close prompt) it waits its turn.
   */
  async saveCopy(name: string, content: string): Promise<SqlFile | undefined> {
    while (!this.disposed && this.documents.getSnapshot().busy) await this.idle()
    let saved: SqlFile | undefined
    await this.perform(async () => {
      const file = unwrap(await this.api.saveSqlFile({ name, content, saveAs: true }))
      if (file) { unwrap(await this.api.releaseSqlFile(file.id)); saved = file }
    })
    return saved
  }
  private async confirmClose(id: string): Promise<boolean> {
    const document = this.documents.get(id), model = this.documents.getModel(id)
    if (!document?.dirty || !model) return true
    const version = model.getVersionId()
    const decision = unwrap(await this.api.confirmClose(document.name))
    if (this.disposed || decision === 'cancel') return false
    if (!this.documents.get(id)) return true
    if (decision === 'save') {
      if (!await this.documents.save(id)) return false
      if (this.documents.get(id)?.dirty) throw new Error('The query changed while saving. Review the latest changes before closing it.')
      return true
    }
    if (this.documents.getModel(id) !== model || model.getVersionId() !== version) throw new Error('The query changed while confirming close. Review the latest changes before closing it.')
    return true
  }
  /**
   * Asks about unsaved changes, then about an open transaction (SSMS's Yes, No, Cancel) or a query still executing
   * (cancel it, or keep it running), and closes the query. Saving first means a later Cancel leaves nothing undone but a
   * saved file. A commit that fails is reported and the query stays open, with its transaction.
   */
  async close(id = this.documents.getSnapshot().activeId): Promise<void> {
    if (!this.canClose(id)) return
    await this.perform(async () => {
      if (!await this.confirmClose(id) || this.disposed) return
      const plan = await this.queries.confirmSessions('close', [id])
      if (!plan || this.disposed || !this.documents.get(id)) return
      const file = this.documents.get(id)?.file
      await this.documents.close(id, plan.get(id))
      if (!this.documents.get(id) && file) await this.releaseUnclaimed([file])
    })
  }
  /**
   * Closes the queries in tab order as one task, asking about each unsaved one; Cancel stops the rest, as in Visual
   * Studio. Open transactions are asked about once, first, and each is committed or rolled back as its query closes.
   * Running queries stay open and are reported once the others are closed, and so does one that was running when the
   * prompt opened and has finished since with a transaction nobody was asked about.
   */
  async closeMany(ids: readonly string[]): Promise<void> {
    const wanted = new Set(ids)
    await this.perform(async () => {
      const asked = new Set(ids.filter(id => !this.queries.isRunning(id)))
      const plan = await this.queries.confirmSessions('closeAll', [...asked])
      if (!plan || this.disposed) return
      let running = 0, unasked = 0
      for (const { id } of this.documents.getSnapshot().documents.filter(document => wanted.has(document.id))) {
        if (!this.documents.get(id)) continue
        if (this.queries.isRunning(id)) { running++; continue }
        if (!asked.has(id) && await this.queries.mayHaveTransaction(id)) { unasked++; continue }
        if (!await this.confirmClose(id) || this.disposed) return
        const file = this.documents.get(id)?.file
        await this.documents.close(id, plan.get(id))
        if (!this.documents.get(id) && file) await this.releaseUnclaimed([file])
      }
      const kept = [running ? (running === 1 ? '1 query is still running and stayed open.' : `${running} queries are still running and stayed open.`) : '', unfinished(unasked, 'open')]
      if (running || unasked) throw new Error(kept.filter(Boolean).join(' '))
    })
  }
  /**
   * Asks about each unsaved query, then once about every open transaction and running query, then closes the window. A close or quit that arrives while a file task runs (a Script
   * As File… waiting behind another dialog) waits for it rather than being dropped, so the app exits once the dialogs
   * are answered; requests made meanwhile are the same close. A close that ends without closing tells main, which
   * otherwise hands a close it asked for to the next page if this one reloads or crashes first.
   */
  closeWindow(beforeClose: () => Promise<void>): Promise<void> {
    this.closing ??= (async () => {
      try {
        while (!this.disposed && this.documents.getSnapshot().busy) await this.idle()
        await this.closeDocuments(beforeClose)
      } finally {
        this.closing = undefined
        if (!this.exiting && !this.disposed) this.api.closeWindowCancelled()
      }
    })()
    return this.closing
  }
  private async closeDocuments(beforeClose: () => Promise<void>): Promise<void> {
    await this.perform(async () => {
      const approved = new Map<string, { model: NonNullable<ReturnType<DocumentService['getModel']>>; version: number }>()
      for (const document of this.documents.getSnapshot().documents) {
        if (!await this.confirmClose(document.id) || this.disposed) return
        const model = this.documents.getModel(document.id)
        if (model) approved.set(document.id, { model, version: model.getVersionId() })
      }
      const plan = await this.queries.confirmSessions('exit', [...approved.keys()])
      if (!plan || this.disposed) return
      await beforeClose()
      if (this.disposed) return
      const current = this.documents.getSnapshot().documents
      if (current.length !== approved.size || current.some(document => {
        const approval = approved.get(document.id), model = this.documents.getModel(document.id)
        return !approval || model !== approval.model || model.getVersionId() !== approval.version
      })) throw new Error('A query changed while closing the window. Review the latest changes before closing it.')
      // Each transaction ends in its own session as the user chose; a commit that fails is reported and the window stays.
      for (const [id, transaction] of plan) if (this.documents.get(id)) await this.documents.endSession(id, transaction)
      // The user has confirmed every document, so unloading must no longer be blocked.
      this.exiting = true
      try { await this.api.closeWindow() } catch (error) { this.exiting = false; throw error }
    })
  }
  dispose(): void {
    this.disposed = true
    for (const done of [...this.waiters]) done()
    this.clearListeners()
    this.publish({ error: '', kind: 'error' })
  }
}
