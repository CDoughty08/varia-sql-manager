import type { editor } from 'monaco-editor'
import type { DocumentKind, LineEnding, VariaApi } from '../../../shared/contracts'
import type { SessionEnd } from '../../../shared/sessions'
import type { SettingsValues } from '../../../shared/settings/catalog'
import { afterClose, isCustomKind, isQueryDocument, kindInfo, type CustomDocumentKind, type QueryDocument } from '../documents'
import { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { gridLimits } from '../grid/constants'

export const documentUri = (id: string): string => `varia-sql://query/${id}`
/** A Monaco model for a document's text in its language ('sql', 'xml' or 'json'). */
export type ModelFactory = (text: string, uri: string, language: string) => editor.ITextModel
/** A large text still being appended, one chunk a frame; edits the user makes meanwhile keep the document dirty. */
interface Fill { appending: boolean; userEdited: boolean }
/** `plain`: a large value document, shown without bracket matching and colours. */
interface DocumentEntry { model: editor.ITextModel; subscription: Disposable; viewState?: editor.ICodeEditorViewState | null; fill?: Fill; plain?: boolean }
/** A text document opened from a value: its tab name, its text, and what it holds. */
export interface TextDocument { readonly name: string; readonly text: string; readonly kind: Exclude<DocumentKind, 'sql'> }
export interface DocumentSnapshot { readonly documents: readonly QueryDocument[]; readonly activeId: string; readonly busy: boolean }
type DocumentPatch = Partial<Pick<QueryDocument, 'name' | 'connectionId' | 'database' | 'file' | 'sessionNotice'>>
type DocumentApi = Pick<VariaApi, 'saveSqlFile' | 'closeQuerySession'>
/**
 * What a document without text in the editor (a table designer) needs from its owner: Save (true when it saved), why it
 * cannot close now (a save running), a revision that moves with every change (the close prompt's "changed while
 * confirming"), focus, and notice that it closed. The provider owns the document's content; DocumentService owns its tab.
 */
export interface CustomDocumentProvider {
  readonly kind: CustomDocumentKind
  /** Whether File › Save All saves it too (a table designer), or only its own Save does (Database Properties' Apply). */
  readonly inSaveAll: boolean
  save(id: string, saveAs: boolean): Promise<boolean>
  canClose(id: string): string | undefined
  revision(id: string): number
  focus(id: string): void
  closed(id: string): void
  /** Whether the document moves with a reconnect to a connection on `server`. */
  follows(id: string, server: string): boolean
}
/** A model's indentation, from Tools › Options › Text Editor › Transact-SQL › Tabs. */
export interface ModelOptions { readonly tabSize: number; readonly indentSize: number; readonly insertSpaces: boolean }
/** Options from settings; `refreshOptions` applies them again after they change. */
export interface DocumentOptions {
  /** Applied to every model when it is created, so Monaco's indentation detection never decides, as in SSMS. */
  readonly modelOptions?: () => ModelOptions
  /** Automatic delimiter highlighting; large values never match brackets, whatever it says. */
  readonly matchBrackets?: () => boolean
  /** A new query's line ending (the platform's); without it, Monaco's default (LF). */
  readonly newLineEnding?: LineEnding
}
/** The document options Tools › Options sets. Keep tabs (SSMS's default) inserts tab characters. */
export function settingsDocumentOptions(values: () => SettingsValues): Required<Pick<DocumentOptions, 'modelOptions' | 'matchBrackets'>> {
  return {
    modelOptions: () => {
      const current = values()
      return { tabSize: current['textEditor.sql.tabSize'], indentSize: current['textEditor.sql.indentSize'], insertSpaces: current['textEditor.sql.tabs'] === 'spaces' }
    },
    matchBrackets: () => values()['textEditor.delimiterHighlighting']
  }
}

export class DocumentService extends SnapshotStore<DocumentSnapshot> implements Disposable {
  private entries = new Map<string, DocumentEntry>()
  /** Custom documents' ids, by kind; they have no model. */
  private readonly customs = new Map<string, CustomDocumentKind>()
  private readonly providers = new Map<CustomDocumentKind, CustomDocumentProvider>()
  private editor?: editor.IStandaloneCodeEditor
  private disposed = false
  private queryCounter = 1
  private matchingBrackets = true
  /** `frame` schedules the next chunk of a large text document: an animation frame in the app. */
  constructor(private createModel: ModelFactory, private api: DocumentApi, private events: EventBus, private frame: (callback: () => void) => void = callback => { requestAnimationFrame(() => callback()) },
    private readonly options: DocumentOptions = {}) {
    super({ documents: [], activeId: '', busy: false })
  }
  get(id: string): QueryDocument | undefined { return this.getSnapshot().documents.find(document => document.id === id) }
  get active(): QueryDocument | undefined { return this.get(this.getSnapshot().activeId) }
  getModel(id: string): editor.ITextModel | undefined { return this.entries.get(id)?.model }
  /** Whether the document is a custom one (a table designer): no model, and its provider saves and closes it. */
  isCustom(id: string): boolean { return this.customs.has(id) }
  private provider(id: string): CustomDocumentProvider | undefined { const kind = this.customs.get(id); return kind ? this.providers.get(kind) : undefined }
  registerProvider(provider: CustomDocumentProvider): Disposable {
    if (this.providers.has(provider.kind)) throw new Error(`A ${provider.kind} provider is already registered.`)
    this.providers.set(provider.kind, provider)
    return { dispose: () => { if (this.providers.get(provider.kind) === provider) this.providers.delete(provider.kind) } }
  }
  /** Opens a custom document's tab at once, active, clean, with no model: the editor shows nothing while it is active. */
  openCustom(kind: CustomDocumentKind, name: string, connectionId: string | undefined, database: string): QueryDocument {
    if (this.disposed) throw new Error('The document service is disposed.')
    if (!this.providers.has(kind)) throw new Error(`No ${kind} provider is registered.`)
    const document: QueryDocument = { id: crypto.randomUUID(), name, database, connectionId, dirty: false, savedVersionId: null, kind }
    this.customs.set(document.id, kind)
    this.changed({ ...this.getSnapshot(), documents: [...this.getSnapshot().documents, document] })
    this.activate(document.id)
    return document
  }
  /** A custom document's unsaved state, as its provider says. */
  setDirty(id: string, dirty: boolean): void { if (this.customs.has(id) && this.get(id)?.dirty !== dirty) this.replace(id, { dirty }) }
  /** What changes with every edit: the model's version for text, the provider's revision for a custom document. */
  revision(id: string): number { return this.entries.get(id)?.model.getVersionId() ?? this.provider(id)?.revision(id) ?? 0 }
  /** Whether a custom document moves to a reconnected connection on `server` (a designer only to its own server). */
  follows(id: string, server: string): boolean { return this.provider(id)?.follows(id, server) ?? false }
  /** Whether File › Save All saves the document: every text document, and the custom ones whose provider says so. */
  inSaveAll(id: string): boolean { return this.provider(id)?.inSaveAll ?? true }
  /** Why the document cannot close now (a custom document saving), or undefined. */
  closeRefusal(id: string): string | undefined { return this.provider(id)?.canClose(id) }
  /** Focus to the active document: the editor's text, or the custom document's own element. */
  focusActive(): void {
    const id = this.getSnapshot().activeId, provider = this.provider(id)
    if (provider) provider.focus(id)
    else this.editor?.focus()
  }
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
  newQuery(sql = '', name?: string, connectionId = this.active?.connectionId, database = this.active?.database || 'master', unsaved = false): QueryDocument {
    return this.create(name ?? `SQLQuery${++this.queryCounter}.sql`, sql, database, connectionId, unsaved)
  }
  /** `eol` is an opened file's line ending: the model takes it, normalizing a file whose line endings were mixed. */
  create(name: string, sql: string, database: string, connectionId?: string, unsaved = false, file?: QueryDocument['file'], eol?: LineEnding): QueryDocument {
    return this.add(name, sql, database, connectionId, unsaved, file, undefined, false, eol ?? this.options.newLineEnding)
  }
  /**
   * Opens a query AutoRecover kept: its text, unsaved, with no connection, its line ending, and its original file when
   * main registered it again. A large value has no bracket matching or colours, as `openText` opens it.
   */
  restore(name: string, text: string, kind: DocumentKind, eol: LineEnding, file?: QueryDocument['file']): QueryDocument {
    const value = kind === 'sql' ? undefined : kind
    return this.add(name, text, value ? '' : 'master', undefined, true, file, value, !!value && text.length > gridLimits.documentBracketChars, eol)
  }
  /**
   * Opens a value from the results as a text document: no connection, not dirty, in its language. A long text opens
   * with its first 16,384 characters and appends 131,072 a frame without undo stops, so a 4 MB value never blocks the
   * window; the document counts as saved once the last chunk is in. A value over 65,536 characters has no bracket
   * matching or bracket colours, which Monaco would compute over all of it at once.
   */
  openText(o: TextDocument): QueryDocument {
    const first = chunkEnd(o.text, 0, gridLimits.documentFirstChunk)
    const document = this.add(o.name, o.text.slice(0, first), '', undefined, false, undefined, o.kind, o.text.length > gridLimits.documentBracketChars)
    if (first < o.text.length) this.fill(document.id, o.text, first)
    return document
  }
  private add(name: string, text: string, database: string, connectionId: string | undefined, unsaved: boolean, file: QueryDocument['file'], kind?: Exclude<DocumentKind, 'sql'>, plain = false, eol?: LineEnding): QueryDocument {
    if (this.disposed) throw new Error('The document service is disposed.')
    const id = crypto.randomUUID()
    const model = this.createModel(text, documentUri(id), kindInfo[kind ?? 'sql'].language)
    if (this.options.modelOptions) model.updateOptions(this.options.modelOptions())
    if (plain) model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } })
    // Before the saved version is read: setting the line ending is a change, though not one Undo reverts.
    if (eol) model.setEOL(eol === 'crlf' ? 1 : 0)
    const document: QueryDocument = { id, name, database, connectionId, file, dirty: unsaved && !!text, savedVersionId: unsaved && text ? null : model.getAlternativeVersionId(), ...kind ? { kind } : {} }
    const subscription = model.onDidChangeContent(() => {
      const current = this.get(id), fill = this.entries.get(id)?.fill
      if (!current) return
      if (fill) { if (!fill.appending) fill.userEdited = true; return }
      const dirty = current.savedVersionId === null ? model.getValueLength() > 0 : model.getAlternativeVersionId() !== current.savedVersionId
      // SQL never enters a React snapshot; ordinary typing only publishes a dirty transition.
      if (dirty !== current.dirty) this.replace(id, { dirty })
    })
    this.entries.set(id, { model, subscription, plain })
    this.changed({ ...this.getSnapshot(), documents: [...this.getSnapshot().documents, document] })
    this.activate(id)
    return document
  }
  /** Appends `text` from `at`, a chunk a frame, until the end or until the document closes. */
  private fill(id: string, text: string, at: number): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const fill: Fill = entry.fill = { appending: false, userEdited: false }
    const step = () => {
      if (this.disposed || this.entries.get(id) !== entry) return
      const { model } = entry, end = chunkEnd(text, at), line = model.getLineCount(), column = model.getLineMaxColumn(line)
      fill.appending = true
      try { model.applyEdits([{ range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column }, text: text.slice(at, end) }]) }
      finally { fill.appending = false }
      at = end
      if (at < text.length) { this.frame(step); return }
      entry.fill = undefined
      // Typing during the fill is not part of the value, so it leaves the document dirty.
      this.replace(id, { savedVersionId: fill.userEdited ? null : model.getAlternativeVersionId(), dirty: fill.userEdited })
    }
    this.frame(step)
  }
  private rememberView(): void {
    const entry = this.entries.get(this.getSnapshot().activeId)
    if (entry && this.editor?.getModel() === entry.model) entry.viewState = this.editor.saveViewState()
  }
  /** Matching is an editor option: on while the setting is and the document is not a large value. It changes before the
   *  model does, so it never runs over a large value. */
  private matchBrackets(entry: DocumentEntry | undefined): void {
    const matching = !entry?.plain && (this.options.matchBrackets?.() ?? true)
    if (this.editor && matching !== this.matchingBrackets) { this.matchingBrackets = matching; this.editor.updateOptions({ matchBrackets: matching ? 'always' : 'never' }) }
  }
  private showModel(id: string): void {
    const entry = this.entries.get(id)
    this.matchBrackets(entry)
    this.editor?.setModel(entry?.model ?? null)
    if (entry?.viewState) this.editor?.restoreViewState(entry.viewState)
  }
  activate(id: string): void {
    if (id && !this.entries.has(id) && !this.customs.has(id)) return
    if (id === this.getSnapshot().activeId) {
      this.events.emit({ type: 'documents.activated', tabId: id })
      return
    }
    this.rememberView()
    this.showModel(id)
    this.changed({ ...this.getSnapshot(), activeId: id })
    this.events.emit({ type: 'documents.activated', tabId: id })
  }
  /** Applies changed settings: indentation to every open model, and bracket matching to the editor. */
  refreshOptions(): void {
    const options = this.options.modelOptions?.()
    if (options) for (const entry of this.entries.values()) entry.model.updateOptions(options)
    this.matchBrackets(this.entries.get(this.getSnapshot().activeId))
  }
  bindEditor(instance: editor.IStandaloneCodeEditor): Disposable {
    if (this.editor) throw new Error('A query editor is already bound.')
    this.editor = instance
    this.matchingBrackets = true
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
  /**
   * Puts a file's text, as read again, in its document (File changed's Yes): one undoable edit of only the part that
   * changed, so the caret stays where it can, with the file's line ending; the document is clean afterwards.
   */
  reload(id: string, text: string, eol: LineEnding, file: NonNullable<QueryDocument['file']>): void {
    const model = this.entries.get(id)?.model
    if (!model || this.disposed) return
    const sequence = eol === 'crlf' ? '\r\n' : '\n'
    model.pushStackElement()
    if (model.getEOL() !== sequence) model.pushEOL(eol === 'crlf' ? 1 : 0)
    const current = model.getValue(), next = text.replace(/\r\n|\r|\n/g, sequence)
    if (current !== next) {
      let start = 0, end = 0
      while (start < current.length && start < next.length && current[start] === next[start]) start++
      while (end < current.length - start && end < next.length - start && current[current.length - 1 - end] === next[next.length - 1 - end]) end++
      // Never inside a line break or a surrogate pair, which the model would split.
      while (start > 0 && (current[start - 1] === '\r' || (current.charCodeAt(start - 1) & 0xfc00) === 0xd800)) start--
      while (end > 0 && (current[current.length - end - 1] === '\r' || (current.charCodeAt(current.length - end) & 0xfc00) === 0xdc00)) end--
      const from = model.getPositionAt(start), to = model.getPositionAt(current.length - end)
      model.pushEditOperations([], [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: next.slice(start, next.length - end) }], () => null)
    }
    model.pushStackElement()
    this.replace(id, { file, name: file.name, savedVersionId: model.getAlternativeVersionId(), dirty: false })
  }
  /** The document's file was deleted outside: it has unsaved changes until Save writes the file again. */
  markUnsaved(id: string): void { this.replace(id, { savedVersionId: null, dirty: true }) }
  async save(id: string, saveAs = false): Promise<boolean> {
    const provider = this.provider(id)
    if (provider) return provider.save(id, saveAs)
    const document = this.get(id), model = this.entries.get(id)?.model
    if (!document || !model) return false
    model.pushStackElement()
    const content = model.getValue(), savedVersionId = model.getAlternativeVersionId()
    const kind = isCustomKind(document.kind) ? undefined : document.kind
    const result = await this.api.saveSqlFile({ fileId: document.file?.id, name: document.name, content, saveAs, ...kind ? { kind } : {} })
    if (!result.ok) throw new Error(result.error)
    if (!result.value || this.disposed || this.entries.get(id)?.model !== model) return false
    model.pushStackElement()
    this.replace(id, { file: result.value, name: result.value.name, savedVersionId, dirty: model.getAlternativeVersionId() !== savedVersionId })
    return true
  }
  /**
   * Ends a query's SQL session, committing or rolling back its open transaction first (`transaction`). A commit that fails
   * throws and leaves the session open with its transaction. A session found lost has ended all the same: SQL Server
   * rolled its transaction back.
   */
  async endSession(id: string, transaction?: SessionEnd): Promise<void> {
    const result = transaction ? await this.api.closeQuerySession(id, transaction) : await this.api.closeQuerySession(id)
    if (result.ok || result.code === 'SESSION_LOST') this.events.emit({ type: 'session.ended', tabId: id })
    if (!result.ok) throw new Error(result.error)
  }
  // The caller holds runTask and has confirmed dirty state, open transactions (`transaction`) and running queries.
  async close(id: string, transaction?: SessionEnd): Promise<void> {
    if (this.customs.has(id)) { this.closeCustom(id); return }
    const entry = this.entries.get(id)
    if (!entry) return
    const version = entry.model.getVersionId()
    // Only a query has a SQL session to end.
    if (isQueryDocument(this.get(id))) await this.endSession(id, transaction)
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
  /** A custom document has no session to end and no model to dispose; its provider forgets it. */
  private closeCustom(id: string): void {
    const provider = this.provider(id), current = this.getSnapshot(), next = afterClose(current.documents, current.activeId, id)
    this.customs.delete(id)
    if (current.activeId === id) this.showModel(next.activeId)
    this.changed({ ...current, documents: next.tabs, activeId: next.activeId })
    provider?.closed(id)
    this.events.emit({ type: 'documents.closed', tabId: id })
    if (current.activeId !== next.activeId) this.events.emit({ type: 'documents.activated', tabId: next.activeId })
  }
  dispose(): void {
    this.disposed = true
    this.customs.clear()
    this.editor?.setModel(null)
    this.editor = undefined
    for (const entry of this.entries.values()) { entry.subscription.dispose(); entry.model.dispose() }
    this.entries.clear()
    this.clearListeners()
    this.publish({ documents: [], activeId: '', busy: false })
  }
}

/** Where the chunk of `text` that starts at `at` ends: never inside a surrogate pair or a CRLF, which the model would split. */
function chunkEnd(text: string, at: number, size: number = gridLimits.documentChunk): number {
  let end = Math.min(text.length, at + size)
  if (end < text.length && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--
  if (end < text.length && text.charCodeAt(end - 1) === 13 && text.charCodeAt(end) === 10) end--
  return end
}
