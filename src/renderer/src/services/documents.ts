import type { editor } from 'monaco-editor'
import type { VariaApi } from '../../../shared/contracts'
import { afterClose, type QueryDocument } from '../documents'
import { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

export const documentUri = (id: string): string => `varia-sql://query/${id}`
export type ModelFactory = (sql: string, uri: string) => editor.ITextModel
interface DocumentEntry { model: editor.ITextModel; subscription: Disposable; viewState?: editor.ICodeEditorViewState | null }
export interface DocumentSnapshot { readonly documents: readonly QueryDocument[]; readonly activeId: string; readonly busy: boolean }
type DocumentPatch = Partial<Pick<QueryDocument, 'name' | 'connectionId' | 'database' | 'file'>>
type DocumentApi = Pick<VariaApi, 'saveSqlFile' | 'closeQuerySession'>

export class DocumentService extends SnapshotStore<DocumentSnapshot> implements Disposable {
  private entries = new Map<string, DocumentEntry>()
  private editor?: editor.IStandaloneCodeEditor
  private disposed = false
  private queryCounter = 1
  constructor(private createModel: ModelFactory, private api: DocumentApi, private events: EventBus) {
    super({ documents: [], activeId: '', busy: false })
  }
  get(id: string): QueryDocument | undefined { return this.getSnapshot().documents.find(document => document.id === id) }
  get active(): QueryDocument | undefined { return this.get(this.getSnapshot().activeId) }
  getModel(id: string): editor.ITextModel | undefined { return this.entries.get(id)?.model }
  private changed(snapshot: DocumentSnapshot): void {
    this.publish(snapshot)
    this.events.emit({ type: 'documents.changed' })
  }
  private replace(id: string, patch: Partial<Omit<QueryDocument, 'id'>>): void {
    if (!this.get(id) || this.disposed) return
    const current = this.getSnapshot()
    this.changed({ ...current, documents: current.documents.map(document => document.id === id ? { ...document, ...patch } : document) })
  }
  update(id: string, patch: DocumentPatch): void { this.replace(id, patch) }
  newQuery(sql = '', name?: string, connectionId = this.active?.connectionId, database = this.active?.database ?? 'master', unsaved = false): QueryDocument {
    return this.create(name ?? `SQLQuery${++this.queryCounter}.sql`, sql, database, connectionId, unsaved)
  }
  create(name: string, sql: string, database: string, connectionId?: string, unsaved = false, file?: QueryDocument['file']): QueryDocument {
    if (this.disposed) throw new Error('The document service is disposed.')
    const id = crypto.randomUUID()
    const model = this.createModel(sql, documentUri(id))
    const document: QueryDocument = { id, name, database, connectionId, file, dirty: unsaved && !!sql, savedVersionId: unsaved && sql ? null : model.getAlternativeVersionId() }
    const subscription = model.onDidChangeContent(() => {
      const current = this.get(id)
      if (!current) return
      const dirty = current.savedVersionId === null ? model.getValueLength() > 0 : model.getAlternativeVersionId() !== current.savedVersionId
      // SQL never enters a React snapshot; ordinary typing only publishes a dirty transition.
      if (dirty !== current.dirty) this.replace(id, { dirty })
    })
    this.entries.set(id, { model, subscription })
    this.changed({ ...this.getSnapshot(), documents: [...this.getSnapshot().documents, document] })
    this.activate(id)
    return document
  }
  private rememberView(): void {
    const entry = this.entries.get(this.getSnapshot().activeId)
    if (entry && this.editor?.getModel() === entry.model) entry.viewState = this.editor.saveViewState()
  }
  private showModel(id: string): void {
    const entry = this.entries.get(id)
    this.editor?.setModel(entry?.model ?? null)
    if (entry?.viewState) this.editor?.restoreViewState(entry.viewState)
  }
  activate(id: string): void {
    if (id && !this.entries.has(id)) return
    if (id === this.getSnapshot().activeId) {
      this.events.emit({ type: 'documents.activated', tabId: id })
      return
    }
    this.rememberView()
    this.showModel(id)
    this.changed({ ...this.getSnapshot(), activeId: id })
    this.events.emit({ type: 'documents.activated', tabId: id })
  }
  bindEditor(instance: editor.IStandaloneCodeEditor): Disposable {
    if (this.editor) throw new Error('A query editor is already bound.')
    this.editor = instance
    this.showModel(this.getSnapshot().activeId)
    return { dispose: () => {
      if (this.editor !== instance) return
      this.rememberView()
      instance.setModel(null)
      this.editor = undefined
    } }
  }
  get boundEditor(): editor.IStandaloneCodeEditor | undefined { return this.editor }
  getExecuteText(id = this.getSnapshot().activeId): { sql: string; startLine: number } {
    const model = this.entries.get(id)?.model
    if (!model) return { sql: '', startLine: 1 }
    const selection = this.editor?.getModel() === model ? this.editor.getSelection() : null
    // Any non-empty selection wins, even whitespace: an accidental one-character selection must not run the whole document.
    return selection && !selection.isEmpty() ? { sql: model.getValueInRange(selection), startLine: selection.startLineNumber } : { sql: model.getValue(), startLine: 1 }
  }
  async runTask(action: () => Promise<void>): Promise<void> {
    if (this.disposed || this.getSnapshot().busy) return
    this.changed({ ...this.getSnapshot(), busy: true })
    try { await action() }
    finally { if (!this.disposed) this.changed({ ...this.getSnapshot(), busy: false }) }
  }
  async save(id: string, saveAs = false): Promise<boolean> {
    const document = this.get(id), model = this.entries.get(id)?.model
    if (!document || !model) return false
    model.pushStackElement()
    const content = model.getValue(), savedVersionId = model.getAlternativeVersionId()
    const result = await this.api.saveSqlFile({ fileId: document.file?.id, name: document.name, content, saveAs })
    if (!result.ok) throw new Error(result.error)
    if (!result.value || this.disposed || this.entries.get(id)?.model !== model) return false
    model.pushStackElement()
    this.replace(id, { file: result.value, name: result.value.name, savedVersionId, dirty: model.getAlternativeVersionId() !== savedVersionId })
    return true
  }
  // The caller holds runTask and has confirmed dirty state and checked running queries.
  async close(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    const version = entry.model.getVersionId()
    const result = await this.api.closeQuerySession(id)
    if (!result.ok) throw new Error(result.error)
    if (this.disposed || this.entries.get(id) !== entry) return
    if (version !== entry.model.getVersionId()) throw new Error('The query changed while closing. Close it again to review the latest changes.')
    const current = this.getSnapshot(), next = afterClose(current.documents, current.activeId, id)
    if (current.activeId === id) this.showModel(next.activeId)
    entry.subscription.dispose()
    entry.model.dispose()
    this.entries.delete(id)
    this.changed({ ...current, documents: next.tabs, activeId: next.activeId })
    this.events.emit({ type: 'documents.closed', tabId: id })
    if (current.activeId !== next.activeId) this.events.emit({ type: 'documents.activated', tabId: next.activeId })
  }
  dispose(): void {
    this.disposed = true
    this.editor?.setModel(null)
    this.editor = undefined
    for (const entry of this.entries.values()) { entry.subscription.dispose(); entry.model.dispose() }
    this.entries.clear()
    this.clearListeners()
    this.publish({ documents: [], activeId: '', busy: false })
  }
}
