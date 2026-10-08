import type { ApiResult, SqlFile, VariaApi } from '../../../shared/contracts'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { DocumentService } from './documents'
import type { QueryService } from './queries'

type FileApi = Pick<VariaApi, 'openSqlFiles' | 'releaseSqlFile' | 'confirmClose' | 'closeWindow'>
export interface FileSnapshot { readonly error: string }
const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }

export class FileService extends SnapshotStore<FileSnapshot> implements Disposable {
  private disposed = false
  /** True once the exit flow has confirmed all documents and asked main to close the window. */
  exiting = false
  constructor(private documents: DocumentService, private queries: Pick<QueryService, 'isRunning'>, private api: FileApi) { super({ error: '' }) }
  canRun(): boolean { return !this.disposed && !this.documents.getSnapshot().busy }
  canSave(id = this.documents.getSnapshot().activeId): boolean { return this.canRun() && !!this.documents.get(id) }
  canClose(id = this.documents.getSnapshot().activeId): boolean { return this.canSave(id) && !this.queries.isRunning(id) }
  reportError(error: string): void {
    if (!this.disposed && error !== this.getSnapshot().error) this.publish({ error })
  }
  clearError(): void { this.reportError('') }
  private async perform(action: () => Promise<void>): Promise<void> {
    if (!this.canRun()) return
    this.clearError()
    try { await this.documents.runTask(action) }
    catch (error) { this.reportError(error instanceof Error ? error.message : 'The file operation failed.') }
  }
  newFile(): void {
    if (!this.canRun()) return
    this.clearError()
    this.documents.newQuery()
  }
  private async releaseUnclaimed(files: readonly SqlFile[]): Promise<void> {
    const owned = new Set(this.documents.getSnapshot().documents.map(document => document.file?.id))
    for (const id of new Set(files.map(file => file.id))) if (!owned.has(id)) unwrap(await this.api.releaseSqlFile(id))
  }
  async open(): Promise<void> {
    const target = this.documents.active
    await this.perform(async () => {
      const opened = unwrap(await this.api.openSqlFiles())
      try {
        if (this.disposed) return
        for (const file of opened) {
          const existing = this.documents.getSnapshot().documents.find(document => document.file?.path === file.path)
          if (existing) { this.documents.activate(existing.id); continue }
          this.documents.create(file.name, file.content, target?.database ?? 'master', target?.connectionId, false, { id: file.id, name: file.name, path: file.path })
        }
      } finally { await this.releaseUnclaimed(opened) }
    })
  }
  async save(id = this.documents.getSnapshot().activeId, saveAs = false): Promise<void> {
    if (!this.canSave(id)) return
    await this.perform(async () => { await this.documents.save(id, saveAs) })
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
  async close(id = this.documents.getSnapshot().activeId): Promise<void> {
    if (!this.canClose(id)) return
    await this.perform(async () => {
      if (!await this.confirmClose(id) || this.disposed) return
      const file = this.documents.get(id)?.file
      await this.documents.close(id)
      if (!this.documents.get(id) && file) await this.releaseUnclaimed([file])
    })
  }
  async closeWindow(beforeClose: () => Promise<void>): Promise<void> {
    await this.perform(async () => {
      const approved = new Map<string, { model: NonNullable<ReturnType<DocumentService['getModel']>>; version: number }>()
      for (const document of this.documents.getSnapshot().documents) {
        if (!await this.confirmClose(document.id) || this.disposed) return
        const model = this.documents.getModel(document.id)
        if (model) approved.set(document.id, { model, version: model.getVersionId() })
      }
      await beforeClose()
      if (this.disposed) return
      const current = this.documents.getSnapshot().documents
      if (current.length !== approved.size || current.some(document => {
        const approval = approved.get(document.id), model = this.documents.getModel(document.id)
        return !approval || model !== approval.model || model.getVersionId() !== approval.version
      })) throw new Error('A query changed while closing the window. Review the latest changes before closing it.')
      // The user has confirmed every document, so unloading must no longer be blocked.
      this.exiting = true
      try { await this.api.closeWindow() } catch (error) { this.exiting = false; throw error }
    })
  }
  dispose(): void { this.disposed = true; this.clearListeners(); this.publish({ error: '' }) }
}
