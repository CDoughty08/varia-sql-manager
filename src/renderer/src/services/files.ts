import type { ApiResult, OpenedFiles, OpenSqlFile, SqlFile, VariaApi } from '../../../shared/contracts'
import { lineEndingLabel } from '../../../shared/files/encoding'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { QueryDocument } from '../documents'
import { DocumentService } from './documents'
import type { QueryService } from './queries'

type FileApi = Pick<VariaApi, 'openSqlFiles' | 'saveSqlFile' | 'releaseSqlFile' | 'confirmClose' | 'closeWindow' | 'closeWindowCancelled'>
  & Partial<Pick<VariaApi, 'openRecentFile' | 'checkSqlFiles' | 'reloadSqlFile' | 'confirmReload'>>
export interface FileServiceOptions {
  /** Tools › Options › Environment › Documents › Reload modified files unless there are unsaved changes. */
  readonly autoReload?: () => boolean
}
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
  private checking: Promise<void> | undefined
  /** True once the exit flow has confirmed all documents and asked main to close the window. */
  exiting = false
  constructor(private documents: DocumentService, private queries: Pick<QueryService, 'isRunning' | 'mayHaveTransaction' | 'confirmSessions'>, private api: FileApi, private readonly options: FileServiceOptions = {}) {
    super({ error: '', kind: 'error' })
  }
  canRun(): boolean { return !this.disposed && !this.documents.getSnapshot().busy }
  canSave(id = this.documents.getSnapshot().activeId): boolean { return this.canRun() && !!this.documents.get(id) }
  /** A query still executing can close too: main asks to cancel it first. */
  canClose(id = this.documents.getSnapshot().activeId): boolean { return this.canSave(id) }
  reportError(error: string, kind: FileSnapshot['kind'] = 'error'): void {
    const current = this.getSnapshot()
    if (!this.disposed && (error !== current.error || kind !== current.kind)) this.publish({ error, kind })
  }
  /** Save All: a document task, and some document it saves has unsaved changes. */
  canSaveAll(): boolean { return this.canRun() && this.documents.getSnapshot().documents.some(document => document.dirty && this.documents.inSaveAll(document.id)) }
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
  /**
   * Opens files main read into tabs, on `target`'s connection and database (the query active when the open began): a
   * file already open activates its tab, and ids no tab claims are released. What could not be opened is reported, and
   * mixed line endings get a notice.
   */
  private async openFiles({ files, errors }: OpenedFiles, target: QueryDocument | undefined): Promise<void> {
    const mixed: string[] = []
    try {
      if (this.disposed) return
      for (const file of files) {
        // Main gives a file one id, however its path was spelled or linked.
        const existing = this.documents.getSnapshot().documents.find(document => document.file?.id === file.id)
        if (existing) { this.documents.activate(existing.id); continue }
        this.documents.create(file.name, file.content, target?.database || 'master', target?.connectionId, false, registeredFile(file), file.eol)
        if (file.mixedEol) mixed.push(`Line endings in ${file.name} were mixed; it will be saved with ${lineEndingLabel(file.eol)} line endings.`)
      }
    } finally { await this.releaseUnclaimed(files) }
    if (errors.length) throw new Error([...errors, ...mixed].join(' '))
    // Visual Studio asks; this is a notice, and the text opens with one kind of line ending, which Save writes.
    if (mixed.length) this.reportError(mixed.join(' '), 'warning')
  }
  async open(): Promise<void> {
    const target = this.documents.active
    await this.perform(async () => { await this.openFiles({ files: unwrap(await this.api.openSqlFiles()), errors: [] }, target) })
  }
  /** File › Recent Files: one entry, by the id main gave its path. */
  async openRecent(id: string): Promise<void> {
    const target = this.documents.active, openRecentFile = this.api.openRecentFile
    if (!openRecentFile) return
    await this.perform(async () => { await this.openFiles(unwrap(await openRecentFile(id)), target) })
  }
  /**
   * Files main opened by itself (the command line, a second instance, macOS, a drop, the macOS menu's Recent Files).
   * They arrive whenever main has read them, so behind another file task they wait their turn.
   */
  async adopt(opened: OpenedFiles): Promise<void> {
    await this.later(target => this.openFiles(opened, target))
  }
  /**
   * Runs `action` as a file task once no other one runs (an open or save dialog, a close prompt), with the query active
   * then; a failure goes to the file banner. AutoRecover's Recover opens its queries this way.
   */
  async later(action: (target: QueryDocument | undefined) => Promise<void>): Promise<void> {
    while (!this.disposed && this.documents.getSnapshot().busy) await this.idle()
    if (this.disposed) return
    const target = this.documents.active
    await this.perform(() => action(target))
  }
  /** Releases main's registrations of `files` that no tab holds. */
  release(files: readonly SqlFile[]): Promise<void> { return this.releaseUnclaimed(files) }
  /**
   * Visual Studio's check for files changed outside the environment, run when the window gets focus while Tools ›
   * Options says to. In tab order: a changed file asks whether to reload it (Yes to All and No to All answer for the
   * rest of this check), or reloads without asking when it has no unsaved changes and Reload modified files unless
   * there are unsaved changes is on; a deleted file's query becomes unsaved, with a notice, so Save writes it again. A
   * file not reloaded is asked about again when it next changes, and its next Save asks first (main's File changed).
   * One check runs at a time, after any other file task.
   */
  checkExternalChanges(): Promise<void> {
    if (this.checking) return this.checking
    const checking = this.checking = (async () => {
      while (!this.disposed && this.documents.getSnapshot().busy) await this.idle()
      if (this.disposed || !this.documents.getSnapshot().documents.some(document => document.file)) return
      await this.perform(() => this.reviewChanges())
    })()
    // Cleared once it is the one held: a check with nothing to do ends before it is assigned.
    void checking.finally(() => { if (this.checking === checking) this.checking = undefined })
    return checking
  }
  private async reviewChanges(): Promise<void> {
    const { checkSqlFiles, confirmReload } = this.api
    if (!checkSqlFiles || !confirmReload) return
    const changes = new Map(unwrap(await checkSqlFiles()).map(change => [change.fileId, change.change]))
    const changeOf = (document: QueryDocument | undefined) => document?.file ? changes.get(document.file.id) : undefined
    const silent = (document: QueryDocument) => !document.dirty && !!this.options.autoReload?.()
    const ids = this.documents.getSnapshot().documents.filter(document => changeOf(document)).map(document => document.id)
    const deleted: string[] = [], failed: string[] = []
    let all: 'yes' | 'no' | undefined
    for (const [index, id] of ids.entries()) {
      const document = this.documents.get(id), change = changeOf(document)
      if (this.disposed) return
      if (!document?.file || !change) continue
      if (change === 'deleted') {
        this.documents.markUnsaved(id)
        deleted.push(`${document.name} was deleted or moved outside Varia SQL Manager. Save it to keep it.`)
        continue
      }
      // Main has moved every reported file's stamp, so a file left out here is not reported again: one that fails is
      // reported and the rest are still asked about.
      try {
        let reload = silent(document) || all === 'yes'
        if (!reload && !all) {
          const later = ids.slice(index + 1).map(other => this.documents.get(other)).some(other => !!other && changeOf(other) === 'modified' && !silent(other))
          const answer = unwrap(await confirmReload({ fileId: document.file.id, dirty: document.dirty, more: later }))
          if (answer === 'yesToAll') all = 'yes'
          if (answer === 'noToAll') all = 'no'
          reload = answer === 'yes' || answer === 'yesToAll'
        }
        if (reload) await this.reload(id)
      } catch (error) { failed.push(`${document.name} was not reloaded: ${error instanceof Error ? error.message : 'The file could not be read.'}`) }
    }
    if (failed.length) throw new Error([...failed, ...deleted].join(' '))
    if (deleted.length) this.reportError(deleted.join(' '), 'warning')
  }
  /** Reads the query's file again into it, as one undoable edit that leaves it clean. */
  private async reload(id: string): Promise<void> {
    const file = this.documents.get(id)?.file, reloadSqlFile = this.api.reloadSqlFile
    if (!file || !reloadSqlFile) return
    const opened = unwrap(await reloadSqlFile(file.id))
    if (this.disposed || this.documents.get(id)?.file?.id !== opened.id) return
    this.documents.reload(id, opened.content, opened.eol, registeredFile(opened))
  }
  async save(id = this.documents.getSnapshot().activeId, saveAs = false): Promise<void> {
    if (!this.canSave(id)) return
    // A table designer's save is DDL that can wait on locks: it must not hold the document task, which would block every
    // other file operation until it ends. Its provider allows one save at a time and reports its own failures.
    if (this.documents.isCustom(id)) {
      this.clearError()
      try { await this.documents.save(id, saveAs) } catch (error) { this.reportError(error instanceof Error ? error.message : 'The save failed.') }
      return
    }
    await this.perform(async () => { await this.documents.save(id, saveAs) })
  }
  /**
   * File › Save All: the queries with unsaved changes, in tab order, as one task. A query never saved asks for its file
   * in turn, as SSMS does; cancelling that dialog stops the rest, and so does a save that fails. Database Properties is
   * left out: its Apply is DDL that can wait on locks, which would hold the task (and every file command) with its Stop
   * in a tab nobody is looking at.
   */
  async saveAll(): Promise<void> {
    if (!this.canSaveAll()) return
    await this.perform(async () => {
      for (const { id } of this.documents.getSnapshot().documents) {
        if (this.disposed) return
        if (!this.documents.get(id)?.dirty || !this.documents.inSaveAll(id)) continue
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
    const document = this.documents.get(id), refusal = this.documents.closeRefusal(id)
    // A table designer that is saving cannot close until its save ends or is stopped.
    if (refusal) throw new Error(refusal)
    if (!document?.dirty) return true
    const revision = this.documents.revision(id), noun = document.kind === 'tableDesigner' ? 'table' : document.kind === 'databaseProperties' ? 'database properties' : 'query'
    const decision = unwrap(await this.api.confirmClose(document.name))
    if (this.disposed || decision === 'cancel') return false
    if (!this.documents.get(id)) return true
    if (decision === 'save') {
      if (!await this.documents.save(id)) return false
      if (this.documents.get(id)?.dirty) throw new Error(`The ${noun} changed while saving. Review the latest changes before closing it.`)
      return true
    }
    if (this.documents.revision(id) !== revision) throw new Error(`The ${noun} changed while confirming close. Review the latest changes before closing it.`)
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
      // Each document's revision as approved: a text document's model version, a designer's own revision.
      const approved = new Map<string, number>()
      for (const document of this.documents.getSnapshot().documents) {
        if (!await this.confirmClose(document.id) || this.disposed) return
        if (this.documents.get(document.id)) approved.set(document.id, this.documents.revision(document.id))
      }
      const plan = await this.queries.confirmSessions('exit', [...approved.keys()])
      if (!plan || this.disposed) return
      await beforeClose()
      if (this.disposed) return
      const current = this.documents.getSnapshot().documents
      if (current.length !== approved.size || current.some(document => approved.get(document.id) !== this.documents.revision(document.id)))
        throw new Error('A query changed while closing the window. Review the latest changes before closing it.')
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
