import type { editor } from 'monaco-editor'
import type { DocumentKind, LineEnding, RestoredDocument, VariaApi } from '../../../shared/contracts'
import { cleanTabName, type KeptDocumentKind } from '../../../shared/files/session'
import { isKeptAgentKind } from '../../../shared/agent/kept'
import { parseCrossEngineSql, serializeCrossEngineSql, type ParseCrossEngineResult } from '../../../shared/multi-query'
import { bigQueryCommitTimeout, type SessionCloseNote, type SessionEnd, type SessionPlanEntry } from '../../../shared/sessions'
import type { SettingsValues } from '../../../shared/settings/catalog'
import type { ProviderId } from '../../../shared/providers'
import { afterClose, documentInfo, isCustomKind, isQueryDocument, queryLanguages, type CustomDocumentKind, type MultiDocumentTarget, type QueryDocument } from '../documents'
import { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { gridLimits } from '../grid/constants'

export const documentUri = (id: string): string => `varia-sql://query/${id}`
export const secondaryDocumentUri = (id: string): string => `varia-sql://query/${id}/secondary`
/** The query a first launch opens. It names its result with a `#Name` marker, so the first run shows a named result
 *  (docs/named-result-sets-scope.md, The default query). */
export const welcomeQueryText = '-- Connect this query to a server and press F5 to execute.\n-- A #Name comment names the result that follows it.\n\n/* #Name="Sample Query" */\nSELECT\n    @@SERVERNAME AS server_name,\n    DB_NAME() AS database_name,\n    SYSDATETIME() AS server_time;\n'
/** The welcome query before it named its result. A session that hot exit kept with it keeps that text, as it keeps every
 *  restored tab's text, and it is still recognised as untouched, so analysing it is still skipped. */
export const previousWelcomeQueryText = '-- Connect this query to a server and press F5 to execute.\n\nSELECT\n    @@SERVERNAME AS server_name,\n    DB_NAME() AS database_name,\n    SYSDATETIME() AS server_time;\n'
const welcomeTexts = [welcomeQueryText, previousWelcomeQueryText].map(text => ({ text, lines: text.split('\n').length - 1 }))
const welcomeLength = (welcome: (typeof welcomeTexts)[number], length: number) => length >= welcome.text.length && length <= welcome.text.length + welcome.lines
/** Whether a text of `length` characters could be that query, with LF or CRLF line ends: a caller holding a model reads
 *  its text to compare only then. */
export const mayBeWelcomeQuery = (length: number): boolean => welcomeTexts.some(welcome => welcomeLength(welcome, length))
/** Whether `text` is still that query (or the one before it), whatever its line endings. Only a text whose length one of
 *  them could have is compared. */
export const isWelcomeQuery = (text: string): boolean => welcomeTexts.some(welcome => welcomeLength(welcome, text.length) && text.replace(/\r\n/g, '\n') === welcome.text)
/** A Monaco model for a document's text in its language ('sql', 'xml' or 'json'). */
export type ModelFactory = (text: string, uri: string, language: string) => editor.ITextModel
/** A large text still being appended, one chunk a frame; edits the user makes meanwhile keep the document dirty. */
interface Fill { appending: boolean; userEdited: boolean; done: Promise<void>; finish: () => void }
/** `plain`: a large value document, shown without bracket matching and colours. */
interface DocumentEntry {
  model: editor.ITextModel
  subscription: Disposable
  secondaryModel?: editor.ITextModel
  secondarySubscription?: Disposable
  savedSecondaryVersionId?: number | null
  retiredSecondaryVersions: number
  viewState?: editor.ICodeEditorViewState | null
  secondaryViewState?: editor.ICodeEditorViewState | null
  fill?: Fill
  plain?: boolean
  edits: number
  syncing?: boolean
}
/** A text document opened from a value: its tab name, its text, and what it holds. */
export interface TextDocument { readonly name: string; readonly text: string; readonly kind: Exclude<DocumentKind, 'sql'>; readonly file?: QueryDocument['file']; readonly eol?: LineEnding }
export interface OpenMultiQueryOptions {
  readonly mode: 'same' | 'cross'
  readonly targets: readonly MultiDocumentTarget[]
  readonly name?: string
  readonly baseName?: string
  readonly sql?: string
  readonly bigQuerySql?: string
  readonly crossView?: 'split' | 'file'
  readonly unsaved?: boolean
  readonly file?: QueryDocument['file']
  readonly eol?: LineEnding
  readonly pinned?: boolean
  readonly provider?: ProviderId
}
export interface ModelLanguageContext {
  readonly documentId: string
  readonly provider: ProviderId
  readonly connectionId?: string
  readonly database: string
  readonly suspended?: boolean
}
export type CrossViewSwitchResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }
export interface DocumentSnapshot { readonly documents: readonly QueryDocument[]; readonly activeId: string; readonly busy: boolean; readonly unsavedFill?: boolean }
export const closedQueryLimits = { count: 20, characters: 4_000_000 } as const
interface ClosedQuery {
  readonly name: string
  readonly baseName?: string
  readonly text: string
  readonly database: string
  readonly lastServer?: string
  readonly provider?: ProviderId
  readonly eol: LineEnding
  readonly viewState?: editor.ICodeEditorViewState
  readonly secondaryViewState?: editor.ICodeEditorViewState
  readonly multiMode?: 'same' | 'cross'
  readonly multiTargets?: readonly MultiDocumentTarget[]
  readonly crossView?: 'split' | 'file'
}
type DocumentPatch = Partial<Pick<QueryDocument, 'name' | 'connectionId' | 'targetId' | 'attachWanted' | 'database' | 'file' | 'sessionNotice' | 'lastServer' | 'includeActualPlan' | 'includeLivePlan' | 'includeClientStatistics' | 'jobKey'>>
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
  /** False for a document with nothing to save (an Activity Monitor): File › Save is not offered on it. */
  readonly saves?: boolean
  save(id: string, saveAs: boolean): Promise<boolean>
  canClose(id: string): string | undefined
  revision(id: string): number
  focus(id: string): void
  closed(id: string): void
  /** Whether the document moves with a reconnect to a connection on `server`. */
  follows(id: string, server: string): boolean
  canFollowTarget?(id: string, targetId: string): boolean
  /** Main proved these target identities equivalent; migrate only this provider's existing binding. */
  coalesceTarget?(id: string, fromTargetId: string, toTargetId: string): boolean
  /** Hot exit and AutoRecover (AG-6g, a SQL Server Agent document): its unsaved state as bounded JSON with no secret in it, or undefined
   *  when there is nothing it can keep (the tab is then asked about on close, as before hot exit). */
  keep?(id: string): string | undefined
  /** Reopens a kept state, disconnected, on its kept connection target (DocumentService.openKeptCustom). Throws when the state is unreadable. */
  reopenKept?(kept: KeptCustomDocument): QueryDocument
  /** A reopened document that has not read its object since: it follows its target when that reconnects on its own, as a query that
   *  wants to attach does (TargetService.attachTarget). */
  attachesOnReconnect?(id: string): boolean
}
/** A kept custom document as hot exit or AutoRecover give it back: its tab name, state, target and database. */
export interface KeptCustomDocument { readonly name: string; readonly state: string; readonly targetId?: string; readonly database?: string }
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
  /** A closed query remembers its server's name, never its live connection or SQL session. */
  readonly server?: (connectionId: string) => string | undefined
  /** Resolves only an exact current backend handle, never a server-name match. */
  readonly target?: (connectionId: string) => string | undefined
  /** A live connection's engine, which a query on it takes (with its language); undefined for an unknown handle. */
  readonly provider?: (connectionId: string) => ProviderId | undefined
  /** Whether a backend connection handle is currently live (used by `languageContext` when resolving multi-server targets). */
  readonly isLive?: (connectionId: string) => boolean
  /** Puts a model in another language and clears its markers, which belonged to the old one. */
  readonly setLanguage?: (model: editor.ITextModel, language: string) => void
  /** A query with text changed engine with its connection: the editor says so, since its SQL is unlikely to run as is. */
  readonly providerChanged?: (document: QueryDocument) => void
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
  /**
   * The editors showing documents, and the document + pane each shows ('' for none). Each editor group has one (`showIn`);
   * `bindEditor` / `bindSecondaryEditor` instead follow the active document (`follower` / `secondaryFollower`).
   */
  private readonly shown = new Map<editor.IStandaloneCodeEditor, { readonly id: string; readonly pane: 'primary' | 'secondary' }>()
  private follower?: editor.IStandaloneCodeEditor
  private secondaryFollower?: editor.IStandaloneCodeEditor
  /** Tab-level content change listeners surviving File <-> Split transitions (`onDidChangeContent`). */
  private readonly contentListeners = new Map<string, Set<() => void>>()
  /**
   * A text document focus was asked for before an editor showed it (its group's editor moves in as React renders the
   * panel). It lapses when focus moves elsewhere first (`dropPendingFocus`), so an editor area shown later takes no focus.
   */
  private pendingFocus = ''
  private pendingReveal?: { readonly id: string; readonly line: number; readonly revision: number; readonly dialect?: ProviderId }
  private textFocus?: (id: string) => boolean
  /** The document a closing active one hands over to: the next in its own editor group (`useCloseSuccessor`). */
  private successor?: (closing: string) => string | undefined
  /** Whether bracket matching is on in each editor, so it changes only when it must. */
  private readonly matching = new Map<editor.IStandaloneCodeEditor, boolean>()
  private disposed = false
  private queryCounter = 1
  private readonly closedQueries: ClosedQuery[] = []
  private closedCharacters = 0
  /** `frame` schedules the next chunk of a large text document: an animation frame in the app. */
  constructor(private createModel: ModelFactory, private api: DocumentApi, private events: EventBus, private frame: (callback: () => void) => void = callback => { requestAnimationFrame(() => callback()) },
    private readonly options: DocumentOptions = {}) {
    super({ documents: [], activeId: '', busy: false })
  }
  get(id: string): QueryDocument | undefined { return this.getSnapshot().documents.find(document => document.id === id) }
  get active(): QueryDocument | undefined { return this.get(this.getSnapshot().activeId) }
  getModel(id: string): editor.ITextModel | undefined { return this.entries.get(id)?.model }
  getSecondaryModel(id: string): editor.ITextModel | undefined { return this.entries.get(id)?.secondaryModel }
  ownsModel(id: string, model: editor.ITextModel | null | undefined): boolean {
    if (!model) return false
    const entry = this.entries.get(id)
    return !!entry && (entry.model === model || entry.secondaryModel === model)
  }
  activeModel(id: string): editor.ITextModel | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    const document = this.get(id)
    if (document?.multiMode === 'cross' && document.crossView !== 'file' && document.activePane === 'secondary' && entry.secondaryModel) return entry.secondaryModel
    return entry.model
  }
  modelFor(id: string, dialect?: ProviderId): editor.ITextModel | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    const document = this.get(id)
    if (dialect === 'bigquery' && document?.multiMode === 'cross' && document.crossView !== 'file' && entry.secondaryModel) return entry.secondaryModel
    if (dialect === 'sqlserver') return entry.model
    return this.activeModel(id)
  }
  /** Canonical serialized text: single-model text, or `-- #Dialect` combined text for Cross-Engine Split tabs. */
  getText(id: string): string {
    const document = this.get(id), entry = this.entries.get(id)
    if (!document || !entry) return ''
    if (document.multiMode === 'cross' && document.crossView !== 'file' && entry.secondaryModel) {
      const eol = entry.model.getEOL() === '\r\n' ? '\r\n' : '\n'
      return serializeCrossEngineSql(entry.model.getValue(), entry.secondaryModel.getValue(), eol)
    }
    return entry.model.getValue()
  }
  /** Extracts T-SQL and GoogleSQL scripts (and 1-based start lines) for a Cross-Engine tab in either Split or File mode. */
  getCrossEngineScripts(id: string): ParseCrossEngineResult {
    const document = this.get(id), entry = this.entries.get(id)
    if (!document || !entry || document.multiMode !== 'cross') return { ok: false, reason: 'Not a Cross-Engine query tab.' }
    if (document.crossView !== 'file' && entry.secondaryModel) {
      return { ok: true, sqlserver: entry.model.getValue(), bigquery: entry.secondaryModel.getValue(), sqlServerStartLine: 1, bigQueryStartLine: 1 }
    }
    return parseCrossEngineSql(entry.model.getValue())
  }
  /** Resolves `{ documentId, provider, connectionId, database }` for any query model (single-server, multi-server, or Cross-Engine pane). */
  languageContext(model: editor.ITextModel, isLive: (connectionId: string) => boolean = this.options.isLive ?? (() => true)): ModelLanguageContext | undefined {
    for (const document of this.getSnapshot().documents) {
      const entry = this.entries.get(document.id)
      if (!entry || (entry.model !== model && entry.secondaryModel !== model)) continue
      if (!isQueryDocument(document)) return undefined
      if (document.multiMode === 'cross' && document.crossView === 'file') {
        return { documentId: document.id, provider: 'sqlserver', database: '', suspended: true }
      }
      const provider: ProviderId = entry.secondaryModel === model
        ? 'bigquery'
        : document.multiMode === 'cross'
          ? 'sqlserver'
          : document.provider ?? 'sqlserver'
      if (document.multiMode) {
        const targets = document.multiTargets ?? []
        const liveTarget = targets.find(target => target.enabled && target.provider === provider && !!target.connectionId && isLive(target.connectionId))
        const fallbackTarget = liveTarget ?? targets.find(target => target.enabled && target.provider === provider)
        return {
          documentId: document.id,
          provider,
          ...liveTarget?.connectionId ? { connectionId: liveTarget.connectionId } : {},
          database: fallbackTarget?.database ?? (provider === 'bigquery' ? '' : 'master')
        }
      }
      return {
        documentId: document.id,
        provider,
        ...document.connectionId ? { connectionId: document.connectionId } : {},
        database: document.database
      }
    }
    return undefined
  }
  /** Subscribes to content changes across primary and secondary models, surviving File <-> Split transitions. */
  onDidChangeContent(tabId: string, listener: () => void): Disposable {
    let set = this.contentListeners.get(tabId)
    if (!set) { set = new Set(); this.contentListeners.set(tabId, set) }
    set.add(listener)
    return { dispose: () => {
      const current = this.contentListeners.get(tabId)
      if (!current) return
      current.delete(listener)
      if (!current.size) this.contentListeners.delete(tabId)
    } }
  }
  private notifyContentChanged(tabId: string): void {
    const listeners = this.contentListeners.get(tabId)
    if (!listeners?.size) return
    for (const listener of [...listeners]) listener()
  }
  /** Updates the focused pane of a Cross-Engine Split tab synchronously so ContextKeyService recomputes activeDocumentProvider immediately. */
  setActivePane(id: string, pane: 'primary' | 'secondary'): void {
    const document = this.get(id)
    if (this.disposed || !document || document.multiMode !== 'cross' || document.crossView === 'file') return
    if ((document.activePane ?? 'primary') === pane) return
    this.replace(id, { activePane: pane })
  }
  /** Switches a Cross-Engine tab between dual-dialect Split mode and canonical single-file `-- #Dialect` mode via undoable edits. */
  setCrossView(id: string, view: 'split' | 'file'): CrossViewSwitchResult {
    const document = this.get(id), entry = this.entries.get(id)
    if (this.disposed || !document || !entry || document.multiMode !== 'cross') return { ok: false, reason: 'Not a Cross-Engine query tab.' }
    if (this.getSnapshot().busy) return { ok: false, reason: 'Wait for the current document operation to finish before switching views.' }
    const currentView = document.crossView ?? 'split'
    if (currentView === view) return { ok: true }
    const wasDirty = document.dirty
    const eol: LineEnding = entry.model.getEOL() === '\r\n' ? 'crlf' : 'lf'
    if (view === 'file') {
      const combined = serializeCrossEngineSql(entry.model.getValue(), entry.secondaryModel?.getValue() ?? '', eol === 'crlf' ? '\r\n' : '\n')
      this.disposeSecondaryModel(id, entry)
      entry.syncing = true
      try { this.applyTextEdit(entry.model, combined, eol) }
      finally { entry.syncing = false }
      const savedVersionId = wasDirty ? null : entry.model.getAlternativeVersionId()
      const dirty = this.isEntryDirty({ ...document, savedVersionId }, entry)
      this.replace(id, { crossView: 'file', activePane: 'primary', savedVersionId, dirty })
      this.notifyContentChanged(id)
      return { ok: true }
    }
    const parsed = parseCrossEngineSql(entry.model.getValue())
    if (!parsed.ok) return parsed
    const secondary = this.createSecondaryModel(id, parsed.bigquery, eol)
    entry.secondaryModel = secondary.model
    entry.secondarySubscription = secondary.subscription
    entry.savedSecondaryVersionId = wasDirty ? null : secondary.model.getAlternativeVersionId()
    entry.syncing = true
    try { this.applyTextEdit(entry.model, parsed.sqlserver, eol) }
    finally { entry.syncing = false }
    const savedVersionId = wasDirty ? null : entry.model.getAlternativeVersionId()
    const dirty = this.isEntryDirty({ ...document, savedVersionId }, entry)
    this.replace(id, { crossView: 'split', activePane: 'primary', savedVersionId, dirty })
    if (this.secondaryFollower && this.getSnapshot().activeId === id) this.showModel(this.secondaryFollower, id, 'secondary')
    this.notifyContentChanged(id)
    return { ok: true }
  }
  setMultiTargets(id: string, targets: readonly MultiDocumentTarget[]): void {
    const document = this.get(id)
    if (this.disposed || !document || !document.multiMode) return
    this.replace(id, { multiTargets: targets.map(target => ({ ...target })) })
  }
  updateMultiTarget(id: string, match: number | ((target: MultiDocumentTarget, index: number) => boolean),
    patch: Partial<MultiDocumentTarget> | ((target: MultiDocumentTarget) => MultiDocumentTarget)): void {
    const document = this.get(id)
    if (this.disposed || !document || !document.multiMode || !document.multiTargets) return
    let changed = false
    const next = document.multiTargets.map((target, index) => {
      const hit = typeof match === 'number' ? index === match : match(target, index)
      if (!hit) return target
      changed = true
      return typeof patch === 'function' ? patch(target) : { ...target, ...patch }
    })
    if (changed) this.replace(id, { multiTargets: next })
  }
  canReopenClosed(): boolean { return !this.disposed && this.closedQueries.length > 0 }
  /** Reopens a safe unsaved copy: no file registration, connection, results, or previous SQL session follows it. */
  reopenClosed(): QueryDocument | undefined {
    if (this.disposed || this.getSnapshot().busy) return
    const closed = this.closedQueries.pop()
    if (!closed) return
    this.closedCharacters -= closed.text.length
    const { name, text, database, eol, viewState, secondaryViewState, baseName, lastServer, provider, multiMode, multiTargets, crossView } = closed
    const document = multiMode
      ? this.openMultiQuery({
        mode: multiMode,
        targets: multiTargets ?? [],
        name,
        ...baseName !== undefined ? { baseName } : {},
        sql: text,
        ...crossView ? { crossView } : {},
        unsaved: true,
        eol,
        ...provider ? { provider } : {}
      }, viewState, secondaryViewState)
      : this.add(name, text, database, undefined, true, undefined, undefined, false, eol,
        { ...baseName !== undefined ? { baseName } : {}, ...lastServer ? { lastServer } : {}, ...provider ? { provider } : {} }, viewState)
    this.focusActive()
    return document
  }
  private keepClosed(id: string, entry: DocumentEntry): void {
    const document = this.get(id)
    if (!isQueryDocument(document) || !document) return
    const text = this.getText(id)
    if (text.length > closedQueryLimits.characters) return
    const primaryView = this.editorOf(id, 'primary') ?? (this.follower?.getModel() === entry.model ? this.follower : undefined)
    if (primaryView) this.rememberView(primaryView)
    const secondaryView = entry.secondaryModel ? this.editorOf(id, 'secondary') ?? (this.secondaryFollower?.getModel() === entry.secondaryModel ? this.secondaryFollower : undefined) : undefined
    if (secondaryView) this.rememberView(secondaryView)
    const trimState = (state: editor.ICodeEditorViewState | null | undefined) => state ? { ...state, cursorState: state.cursorState.slice(0, 1), contributionsState: {} } : undefined
    // Only the first caret and viewport: contributions can retain large folding or extension state.
    const viewState = trimState(entry.viewState), secondaryViewState = trimState(entry.secondaryViewState)
    const lastServer = document.connectionId ? this.options.server?.(document.connectionId) : document.lastServer
    const multiTargets = document.multiMode ? (document.multiTargets ?? []).map((target): MultiDocumentTarget => {
      const server = target.connectionId ? this.options.server?.(target.connectionId) ?? target.lastServer : target.lastServer
      return { provider: target.provider, database: target.database, enabled: target.enabled, ...server ? { lastServer: server } : {} }
    }) : undefined
    this.closedQueries.push({
      name: document.name, ...document.baseName !== undefined ? { baseName: document.baseName } : {}, text, database: document.database,
      ...lastServer ? { lastServer } : {}, ...document.provider ? { provider: document.provider } : {},
      ...document.multiMode ? { multiMode: document.multiMode, multiTargets, ...document.crossView ? { crossView: document.crossView } : {} } : {},
      eol: entry.model.getEOL() === '\r\n' ? 'crlf' : 'lf', viewState, ...secondaryViewState ? { secondaryViewState } : {}
    })
    this.closedCharacters += text.length
    while (this.closedQueries.length > closedQueryLimits.count || this.closedCharacters > closedQueryLimits.characters) this.closedCharacters -= this.closedQueries.shift()!.text.length
  }
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
    const targetId = connectionId ? this.options.target?.(connectionId) : undefined
    const document: QueryDocument = { id: crypto.randomUUID(), name, database, connectionId, ...targetId ? { targetId } : {}, dirty: false, savedVersionId: null, kind }
    this.customs.set(document.id, kind)
    this.changed({ ...this.getSnapshot(), documents: [...this.getSnapshot().documents, document] })
    this.activate(document.id)
    return document
  }
  /** A kept custom document reopened (AG-6g): active, unsaved, on its connection target with no live connection until that target connects. */
  openKeptCustom(kind: CustomDocumentKind, name: string, database: string, targetId: string | undefined): QueryDocument {
    if (this.disposed) throw new Error('The document service is disposed.')
    if (!this.providers.has(kind)) throw new Error(`No ${kind} provider is registered.`)
    const document: QueryDocument = { id: crypto.randomUUID(), name, database, ...targetId ? { targetId } : {}, dirty: true, savedVersionId: null, kind }
    this.customs.set(document.id, kind)
    this.changed({ ...this.getSnapshot(), documents: [...this.getSnapshot().documents, document] })
    this.activate(document.id)
    return document
  }
  /** What hot exit and AutoRecover keep of a custom document: its provider's state, if it keeps one. */
  keepCustom(id: string): string | undefined { return this.provider(id)?.keep?.(id) }
  /** Reopens a kept custom document through its kind's provider; throws when none keeps that kind or the state is unreadable. */
  reopenKept(kind: CustomDocumentKind, kept: KeptCustomDocument): QueryDocument {
    const provider = this.providers.get(kind)
    if (!provider?.reopenKept) throw new Error(`${kept.name} could not be reopened.`)
    return provider.reopenKept(kept)
  }
  /** Whether a reopened custom document follows its target's automatic reconnect. */
  attachesOnReconnect(id: string): boolean { return this.provider(id)?.attachesOnReconnect?.(id) ?? false }
  /** A custom document's unsaved state, as its provider says. */
  setDirty(id: string, dirty: boolean): void { if (this.customs.has(id) && this.get(id)?.dirty !== dirty) this.replace(id, { dirty }) }
  /** What changes with every edit: strictly monotonic across primary, secondary, and retired secondary models (equal to model.getVersionId() for single-model tabs). */
  revision(id: string): number {
    const entry = this.entries.get(id)
    if (entry) return entry.model.getVersionId() + (entry.secondaryModel?.getVersionId() ?? 0) + entry.retiredSecondaryVersions
    return this.provider(id)?.revision(id) ?? 0
  }
  /** What changes with every edit to a text document but not with its fill's chunks: an edit someone made since it was taken. */
  editRevision(id: string): number { return this.entries.get(id)?.edits ?? this.revision(id) }
  /** Whether a document has changes Save would keep, counting typing during its fill, which marks it dirty only once the fill ends. */
  hasUnsavedEdits(id: string): boolean { return !!this.get(id)?.dirty || !!this.entries.get(id)?.fill?.userEdited }
  /** Whether a custom document moves to a reconnected connection on `server` (a designer only to its own server). */
  follows(id: string, server: string): boolean { return this.provider(id)?.follows(id, server) ?? false }
  canFollowTarget(id: string, targetId: string): boolean { return this.provider(id)?.canFollowTarget?.(id, targetId) ?? false }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.provider(id)?.coalesceTarget?.(id, fromTargetId, toTargetId) ?? false }
  /** Whether File › Save All saves the document: every text document, and the custom ones whose provider says so. */
  inSaveAll(id: string): boolean { return this.provider(id)?.inSaveAll ?? true }
  /** Whether File › Save means anything for the document: every text document does, a custom one unless its provider says not. */
  savable(id: string): boolean { return !this.isFilling(id) && this.provider(id)?.saves !== false }
  /** Why the document cannot close now (a custom document saving), or undefined. */
  closeRefusal(id: string): string | undefined { return this.provider(id)?.canClose(id) }
  /**
   * Why a connection cannot be disconnected now: a custom document on it is running DDL (an Apply or a Save), which a
   * disconnect would cancel partway without asking. Undefined when none is.
   */
  connectionBusy(connectionId: string): string | undefined {
    for (const document of this.getSnapshot().documents) {
      const refusal = document.connectionId === connectionId ? this.closeRefusal(document.id) : undefined
      if (refusal) return refusal
    }
    return undefined
  }
  /** The editor area focuses a text document's visible view, which may be a plan graph. False defers until it renders. */
  useTextFocus(focus: (id: string) => boolean): Disposable {
    this.textFocus = focus
    return { dispose: () => { if (this.textFocus === focus) this.textFocus = undefined } }
  }
  /** Focus to the active document's visible view, or wait until its editor group renders it. */
  focusActive(): void {
    const id = this.getSnapshot().activeId, provider = this.provider(id)
    if (provider) { provider.focus(id); return }
    if (this.textFocus) { this.pendingFocus = this.textFocus(id) ? '' : id; return }
    const editor = this.boundEditor, targetModel = this.activeModel(id)
    if (editor && targetModel && editor.getModel() === targetModel && (this.follower === editor || this.secondaryFollower === editor || this.shown.get(editor)?.id === id)) {
      this.pendingFocus = ''
      editor.focus()
    } else this.pendingFocus = id
  }
  /** Focus went somewhere other than the editor area (Object Explorer, a toast): a focus still waiting for an editor lapses. */
  dropPendingFocus(): void { this.pendingFocus = ''; this.pendingReveal = undefined }
  /** Reveals an execution's source only while its revision still matches; a hidden group's or sibling pane's editor can arrive later. */
  revealLine(id: string, line: number, revision: number, dialect?: ProviderId): boolean {
    const entry = this.entries.get(id), document = this.get(id)
    if (this.disposed || !entry || !document || this.revision(id) !== revision) return false
    const model = this.modelFor(id, dialect)
    if (!model || !Number.isInteger(line) || line < 1 || line > model.getLineCount()) return false
    if (document.multiMode === 'cross' && document.crossView !== 'file' && dialect) {
      this.setActivePane(id, dialect === 'bigquery' ? 'secondary' : 'primary')
    }
    this.pendingReveal = { id, line, revision, ...dialect ? { dialect } : {} }
    this.pendingFocus = id
    this.activate(id)
    const view = this.editorOf(id) ?? (this.follower?.getModel() === model ? this.follower : this.secondaryFollower?.getModel() === model ? this.secondaryFollower : undefined)
    if (view) this.applyPendingReveal(view, id)
    this.focusActive()
    return true
  }
  private applyPendingReveal(instance: editor.IStandaloneCodeEditor, id: string): void {
    const pending = this.pendingReveal
    if (!pending || pending.id !== id) return
    if (this.revision(id) !== pending.revision) {
      this.pendingReveal = undefined
      if (this.pendingFocus === id) this.pendingFocus = ''
      return
    }
    const targetModel = this.modelFor(id, pending.dialect)
    if (!targetModel || instance.getModel() !== targetModel) return
    this.pendingReveal = undefined
    instance.setPosition({ lineNumber: pending.line, column: 1 })
    instance.revealLineInCenter(pending.line)
  }
  /** Which document shows after the active one closes; without one (or when it names none open), the next in order. */
  useCloseSuccessor(successor: (closing: string) => string | undefined): Disposable {
    this.successor = successor
    return { dispose: () => { if (this.successor === successor) this.successor = undefined } }
  }
  /** The tabs and active document once `id` closes: `afterClose`'s, with the active one handed to the successor. */
  private closing(id: string): { tabs: QueryDocument[]; activeId: string } {
    const current = this.getSnapshot(), next = afterClose(current.documents, current.activeId, id)
    if (current.activeId !== id) return next
    const preferred = this.successor?.(id)
    return preferred && preferred !== id && next.tabs.some(document => document.id === preferred) ? { ...next, activeId: preferred } : next
  }
  private hasUnsavedFill(): boolean {
    for (const entry of this.entries.values()) if (entry.fill?.userEdited) return true
    return false
  }
  private changed(snapshot: DocumentSnapshot): void {
    const unsavedFill = this.hasUnsavedFill()
    const { unsavedFill: _previous, ...base } = snapshot
    this.publish(unsavedFill ? { ...base, unsavedFill: true } : base)
    this.events.emit({ type: 'documents.changed' })
  }
  private replace(id: string, patch: Partial<Omit<QueryDocument, 'id'>>): void {
    if (!this.get(id) || this.disposed) return
    const current = this.getSnapshot()
    this.changed({ ...current, documents: current.documents.map(document => document.id === id ? { ...document, ...patch } : document) })
  }
  /** A name change from the document's owner (a save, a designer's table name) goes under the user's rename, if any. */
  update(id: string, patch: DocumentPatch): void {
    const { name, ...rest } = patch
    const switched = patch.connectionId ? this.switchProvider(id, patch.connectionId) : undefined
    this.replace(id, { ...rest, ...name === undefined ? {} : this.named(id, name), ...switched ? { provider: switched === 'sqlserver' ? undefined : switched } : {} })
    const document = switched && this.get(id)
    if (document && (this.entries.get(id)?.model.getValueLength() ?? 0) > 0) this.options.providerChanged?.(document)
  }
  /**
   * A query that moves to a connection of another engine takes that engine and its language, and its markers go; it
   * keeps both when it disconnects. Returns the new engine, or undefined when it did not change.
   */
  private switchProvider(id: string, connectionId: string): ProviderId | undefined {
    const document = this.get(id), model = this.entries.get(id)?.model, provider = this.options.provider?.(connectionId)
    if (this.disposed || !document || document.multiMode || !model || !provider || !isQueryDocument(document) || provider === (document.provider ?? 'sqlserver')) return undefined
    this.options.setLanguage?.(model, queryLanguages[provider])
    return provider
  }
  private named(id: string, name: string): Pick<QueryDocument, 'name'> | Pick<QueryDocument, 'baseName'> {
    return this.get(id)?.baseName !== undefined ? { baseName: name } : { name }
  }
  /**
   * Rename Tab: the tab shows `value` (trimmed, without control characters, at most 128 characters) until it is renamed
   * again; an empty name, or the name it would have anyway, takes the rename away. Returns whether the name changed.
   */
  rename(id: string, value: string): boolean {
    const document = this.get(id)
    if (!document || this.disposed) return false
    const name = cleanTabName(value), base = document.baseName ?? document.name
    if (!name || name === base) {
      if (document.baseName === undefined) return false
      this.replace(id, { name: base, baseName: undefined })
      return true
    }
    if (name === document.name && document.baseName !== undefined) return false
    this.replace(id, { name, baseName: base })
    return true
  }
  /** Moves a text tab to the boundary between the shelves, keeping the rest in their current order. */
  setPinned(id: string, pinned: boolean): boolean {
    const current = this.getSnapshot(), document = this.get(id)
    if (!document || !this.entries.has(id) || this.disposed || (pinned && this.isFilling(id)) || !!document.pinned === pinned) return false
    const documents = current.documents.filter(tab => tab.id !== id)
    const firstUnpinned = documents.findIndex(tab => !tab.pinned)
    documents.splice(firstUnpinned < 0 ? documents.length : firstUnpinned, 0, { ...document, pinned })
    this.changed({ ...current, documents })
    return true
  }
  /** Where a new tab on `connectionId` starts when nothing names a database: SQL Server's in master, BigQuery's with no
   *  default dataset. */
  defaultDatabase(connectionId: string | undefined): string { return connectionId && this.options.provider?.(connectionId) === 'bigquery' ? '' : 'master' }
  newQuery(sql = '', name?: string, connectionId = this.active?.connectionId, database?: string, unsaved = false): QueryDocument {
    return this.create(name ?? `SQLQuery${++this.queryCounter}.sql`, sql, database ?? (this.active?.database || this.defaultDatabase(connectionId)), connectionId, unsaved)
  }
  /** `eol` is an opened file's line ending: the model takes it, normalizing a file whose line endings were mixed. */
  create(name: string, sql: string, database: string, connectionId?: string, unsaved = false, file?: QueryDocument['file'], eol?: LineEnding): QueryDocument {
    return this.add(name, sql, database, connectionId, unsaved, file, undefined, false, eol ?? this.options.newLineEnding)
  }
  /** Opens a Same-Engine Multi-Server or Cross-Engine SELECT query tab. */
  openMultiQuery(o: OpenMultiQueryOptions, viewState?: editor.ICodeEditorViewState, secondaryViewState?: editor.ICodeEditorViewState): QueryDocument {
    if (this.disposed) throw new Error('The document service is disposed.')
    const id = crypto.randomUUID()
    const name = o.name ?? `SQLQuery${++this.queryCounter}.sql`
    const eol = o.eol ?? this.options.newLineEnding
    const targets = o.targets.map(target => ({ ...target }))
    if (o.mode === 'same') {
      const resolvedProvider: ProviderId = o.provider ?? targets[0]?.provider ?? 'sqlserver'
      const provider = resolvedProvider === 'sqlserver' ? undefined : resolvedProvider
      const text = o.sql ?? ''
      const model = this.createModel(text, documentUri(id), queryLanguages[resolvedProvider])
      if (this.options.modelOptions) model.updateOptions(this.options.modelOptions())
      if (eol) model.setEOL(eol === 'crlf' ? 1 : 0)
      const dirty = !!o.unsaved && (!!o.file || text.length > 0)
      const document: QueryDocument = {
        id, name, ...o.baseName !== undefined ? { baseName: o.baseName } : {}, database: '', file: o.file,
        dirty, savedVersionId: dirty ? null : model.getAlternativeVersionId(),
        ...provider ? { provider } : {}, ...o.pinned ? { pinned: true } : {},
        multiMode: 'same', multiTargets: targets
      }
      const subscription = model.onDidChangeContent(() => this.handleModelContentChange(id, model))
      this.entries.set(id, { model, subscription, retiredSecondaryVersions: 0, viewState, edits: model.getVersionId() })
      this.insertDocument(document)
      return document
    }
    let crossView: 'split' | 'file' = o.crossView ?? 'split'
    let primaryText = o.sql ?? ''
    let secondaryText: string | undefined = o.bigQuerySql
    if (crossView === 'split') {
      if (secondaryText === undefined) {
        if (primaryText.length > 0) {
          const parsed = parseCrossEngineSql(primaryText)
          if (parsed.ok) {
            primaryText = parsed.sqlserver
            secondaryText = parsed.bigquery
          } else {
            crossView = 'file'
          }
        } else {
          secondaryText = ''
        }
      }
    } else if (secondaryText !== undefined) {
      primaryText = serializeCrossEngineSql(primaryText, secondaryText, eol === 'crlf' ? '\r\n' : '\n')
    }
    const model = this.createModel(primaryText, documentUri(id), queryLanguages.sqlserver)
    if (this.options.modelOptions) model.updateOptions(this.options.modelOptions())
    if (eol) model.setEOL(eol === 'crlf' ? 1 : 0)
    const secondary = crossView === 'split' ? this.createSecondaryModel(id, secondaryText ?? '', eol) : undefined
    const hasText = primaryText.length > 0 || (secondary?.model.getValueLength() ?? 0) > 0
    const dirty = !!o.unsaved && (!!o.file || hasText)
    const document: QueryDocument = {
      id, name, ...o.baseName !== undefined ? { baseName: o.baseName } : {}, database: '', file: o.file,
      dirty, savedVersionId: dirty ? null : model.getAlternativeVersionId(),
      ...o.pinned ? { pinned: true } : {},
      multiMode: 'cross', multiTargets: targets, crossView, activePane: 'primary'
    }
    const subscription = model.onDidChangeContent(() => this.handleModelContentChange(id, model))
    this.entries.set(id, {
      model, subscription,
      ...secondary ? { secondaryModel: secondary.model, secondarySubscription: secondary.subscription, savedSecondaryVersionId: dirty ? null : secondary.model.getAlternativeVersionId() } : {},
      retiredSecondaryVersions: 0, viewState, ...secondaryViewState ? { secondaryViewState } : {}, edits: model.getVersionId() + (secondary?.model.getVersionId() ?? 0)
    })
    this.insertDocument(document)
    return document
  }
  /**
   * Opens a query AutoRecover kept: its text, unsaved, with no connection, its line ending, and its original file when
   * main registered it again. A large value has no bracket matching or colours, as `openText` opens it.
   */
  restore(name: string, text: string, kind: KeptDocumentKind, eol: LineEnding, file?: QueryDocument['file'], provider?: ProviderId, jobKey?: string,
    multi?: { readonly multiMode: 'same' | 'cross'; readonly multiTargets: readonly MultiDocumentTarget[]; readonly crossView?: 'split' | 'file' }): QueryDocument {
    // A SQL Server Agent document's copy is its state, which its service reopens (reopenKept), never as text.
    if (isKeptAgentKind(kind)) throw new Error(`${name} could not be reopened.`)
    if (kind === 'sql' && multi) {
      return this.openMultiQuery({
        mode: multi.multiMode,
        targets: multi.multiTargets,
        name,
        sql: text,
        ...multi.crossView ? { crossView: multi.crossView } : {},
        unsaved: true,
        file,
        eol,
        ...provider ? { provider } : {}
      })
    }
    const value = kind === 'sql' ? undefined : kind
    return this.add(name, text, value || provider === 'bigquery' ? '' : 'master', undefined, true, file, value, !!value && text.length > gridLimits.documentBracketChars, eol, { ...provider ? { provider } : {}, ...!value && jobKey ? { jobKey } : {} })
  }
  /**
   * Opens a value from the results as a text document: no connection, not dirty, in its language. A long text opens
   * with its first 16,384 characters and appends 131,072 a frame without undo stops, so a 4 MB value never blocks the
   * window; the document counts as saved once the last chunk is in. A value over 65,536 characters has no bracket
   * matching or bracket colours, which Monaco would compute over all of it at once.
   */
  openText(o: TextDocument): QueryDocument {
    const first = chunkEnd(o.text, 0, gridLimits.documentFirstChunk)
    const document = this.add(o.name, o.text.slice(0, first), '', undefined, false, o.file, o.kind, o.text.length > gridLimits.documentBracketChars, o.eol)
    if (first < o.text.length) this.fill(document.id, o.text, first)
    return document
  }
  /**
   * Opens a tab hot exit kept: its name (and the user's rename), text, line ending, file, unsaved state and database,
   * with no connection; `lastServer` remembers its server. New queries are numbered after the reopened ones.
   */
  reopen(o: RestoredDocument): QueryDocument {
    if (isKeptAgentKind(o.kind)) throw new Error(`${o.name} could not be reopened.`)
    const kind = o.kind === 'sql' ? undefined : o.kind
    const number = /^SQLQuery(\d+)\.sql$/i.exec(o.baseName ?? o.name)?.[1]
    if (number && Number(number) < 1_000_000) this.queryCounter = Math.max(this.queryCounter, Number(number))
    if (!kind && o.multiMode) {
      const targets: MultiDocumentTarget[] = (o.multiTargets ?? []).map(target => ({
        ...target.targetId !== undefined ? { targetId: target.targetId, attachWanted: target.attachWanted ?? false } : {},
        provider: target.provider,
        database: target.database,
        enabled: target.enabled,
        ...target.lastServer ? { lastServer: target.lastServer } : {}
      }))
      return this.openMultiQuery({
        mode: o.multiMode,
        targets,
        name: o.name,
        ...o.baseName ? { baseName: o.baseName } : {},
        sql: o.text,
        ...o.crossView ? { crossView: o.crossView } : {},
        unsaved: o.dirty,
        file: o.file,
        eol: o.eol,
        ...o.pinned ? { pinned: true } : {},
        ...o.provider ? { provider: o.provider } : {}
      })
    }
    const extra = { ...o.baseName ? { baseName: o.baseName } : {}, ...!kind && o.server ? { lastServer: o.server } : {}, ...o.provider ? { provider: o.provider } : {}, ...!kind && o.jobKey ? { jobKey: o.jobKey } : {}, ...!kind && o.targetId ? { targetId: o.targetId, attachWanted: o.attachWanted ?? false, sessionNotice: 'restarted' as const } : {}, ...o.pinned ? { pinned: true } : {} }
    return this.add(o.name, o.text, kind ? '' : o.database ?? (o.provider === 'bigquery' ? '' : 'master'), undefined, o.dirty, o.file, kind, !!kind && o.text.length > gridLimits.documentBracketChars, o.eol, extra)
  }
  /** Whether a large value is still being appended to the document: its text is not all there yet. */
  isFilling(id: string): boolean { return !!this.entries.get(id)?.fill }
  private isEntryDirty(document: QueryDocument, entry: DocumentEntry): boolean {
    const primaryDirty = document.savedVersionId === null
      ? !!document.file || entry.model.getValueLength() > 0 || (entry.secondaryModel?.getValueLength() ?? 0) > 0
      : entry.model.getAlternativeVersionId() !== document.savedVersionId
    if (primaryDirty) return true
    if (!entry.secondaryModel) return false
    return entry.savedSecondaryVersionId === null || entry.savedSecondaryVersionId === undefined
      ? !!document.file || entry.model.getValueLength() > 0 || entry.secondaryModel.getValueLength() > 0
      : entry.secondaryModel.getAlternativeVersionId() !== entry.savedSecondaryVersionId
  }
  private handleModelContentChange(id: string, model: editor.ITextModel): void {
    const entry = this.entries.get(id)
    if (!entry || (entry.model !== model && entry.secondaryModel !== model)) return
    if (entry.syncing) return
    if (this.pendingReveal?.id === id) this.dropPendingFocus()
    const fill = entry.fill
    if (!fill?.appending) entry.edits++
    this.notifyContentChanged(id)
    const current = this.get(id)
    if (!current) return
    if (fill) {
      if (!fill.appending && !fill.userEdited) {
        fill.userEdited = true
        this.changed(this.getSnapshot())
      }
      return
    }
    const dirty = this.isEntryDirty(current, entry)
    // SQL never enters a React snapshot; ordinary typing only publishes a dirty transition.
    if (dirty !== current.dirty) this.replace(id, { dirty })
  }
  private createSecondaryModel(id: string, text: string, eol?: LineEnding): { model: editor.ITextModel; subscription: Disposable } {
    const model = this.createModel(text, secondaryDocumentUri(id), queryLanguages.bigquery)
    if (this.options.modelOptions) model.updateOptions(this.options.modelOptions())
    if (eol) model.setEOL(eol === 'crlf' ? 1 : 0)
    const subscription = model.onDidChangeContent(() => this.handleModelContentChange(id, model))
    return { model, subscription }
  }
  private disposeSecondaryModel(id: string, entry: DocumentEntry): void {
    if (!entry.secondaryModel) return
    const secondary = entry.secondaryModel
    entry.retiredSecondaryVersions += secondary.getVersionId()
    for (const [instance, shown] of this.shown) {
      if (shown.id === id && shown.pane === 'secondary') {
        this.rememberView(instance)
        instance.setModel(null)
        this.shown.set(instance, { id: '', pane: 'secondary' })
      }
    }
    entry.secondarySubscription?.dispose()
    secondary.dispose()
    entry.secondaryModel = undefined
    entry.secondarySubscription = undefined
    entry.savedSecondaryVersionId = undefined
    entry.secondaryViewState = undefined
  }
  private insertDocument(document: QueryDocument): void {
    const current = this.getSnapshot(), documents = [...current.documents]
    const firstUnpinned = document.pinned ? documents.findIndex(tab => !tab.pinned) : -1
    documents.splice(firstUnpinned < 0 ? documents.length : firstUnpinned, 0, document)
    this.changed({ ...current, documents })
    this.activate(document.id)
  }
  private add(name: string, text: string, database: string, connectionId: string | undefined, unsaved: boolean, file: QueryDocument['file'], kind?: Exclude<DocumentKind, 'sql'>, plain = false, eol?: LineEnding,
    extra: Pick<QueryDocument, 'baseName' | 'lastServer' | 'pinned' | 'targetId' | 'attachWanted' | 'sessionNotice' | 'provider' | 'jobKey'> = {}, viewState?: editor.ICodeEditorViewState): QueryDocument {
    if (this.disposed) throw new Error('The document service is disposed.')
    const id = crypto.randomUUID()
    // A query opened on a connection takes its engine; one without keeps the engine it was given. SQL Server is the
    // absence of one, so only a value or a SQL Server query carries none.
    const { provider: given, ...rest } = extra
    const provider = kind ? undefined : (connectionId ? this.options.provider?.(connectionId) : undefined) ?? given
    extra = provider && provider !== 'sqlserver' ? { ...rest, provider } : rest
    const model = this.createModel(text, documentUri(id), documentInfo({ kind, provider: extra.provider }).language)
    if (this.options.modelOptions) model.updateOptions(this.options.modelOptions())
    if (plain) model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } })
    // Before the saved version is read: setting the line ending is a change, though not one Undo reverts.
    if (eol) model.setEOL(eol === 'crlf' ? 1 : 0)
    const targetId = !kind && connectionId ? this.options.target?.(connectionId) : undefined
    // A recovered file can have an unsaved deletion of its entire contents.
    const dirty = unsaved && (!!file || text.length > 0)
    const document: QueryDocument = { id, name, database, connectionId, file, dirty, savedVersionId: dirty ? null : model.getAlternativeVersionId(), ...kind ? { kind } : {}, ...targetId ? { targetId, attachWanted: true } : {}, ...extra }
    const subscription = model.onDidChangeContent(() => this.handleModelContentChange(id, model))
    this.entries.set(id, { model, subscription, retiredSecondaryVersions: 0, plain, viewState, edits: model.getVersionId() })
    this.insertDocument(document)
    return document
  }
  /** Appends `text` from `at`, a chunk a frame, until the end or until the document closes. */
  private fill(id: string, text: string, at: number): void {
    const entry = this.entries.get(id)
    if (!entry) return
    let finish = () => {}
    const done = new Promise<void>(resolve => { finish = resolve })
    const fill: Fill = entry.fill = { appending: false, userEdited: false, done, finish }
    const step = () => {
      if (this.disposed || this.entries.get(id) !== entry || entry.fill !== fill) { fill.finish(); return }
      const { model } = entry, end = chunkEnd(text, at), line = model.getLineCount(), column = model.getLineMaxColumn(line)
      fill.appending = true
      try { model.applyEdits([{ range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column }, text: text.slice(at, end) }]) }
      finally { fill.appending = false }
      at = end
      if (at < text.length) { this.frame(step); return }
      entry.fill = undefined
      // Typing during the fill is not part of the value, so it leaves the document dirty.
      this.replace(id, { savedVersionId: fill.userEdited ? null : model.getAlternativeVersionId(), dirty: fill.userEdited })
      fill.finish()
    }
    this.frame(step)
  }
  /** Keeps where `instance` was in the document it shows (caret, selection, scroll), for when it shows it again. */
  private rememberView(instance: editor.IStandaloneCodeEditor): void {
    const shown = this.shown.get(instance)
    if (!shown) return
    const entry = this.entries.get(shown.id)
    if (!entry) return
    if (shown.pane === 'secondary') {
      if (entry.secondaryModel && instance.getModel() === entry.secondaryModel) entry.secondaryViewState = instance.saveViewState()
    } else if (instance.getModel() === entry.model) {
      entry.viewState = instance.saveViewState()
    }
  }
  /** Matching is an editor option: on while the setting is and the document is not a large value. It changes before the
   *  model does, so it never runs over a large value. */
  private matchBrackets(instance: editor.IStandaloneCodeEditor, entry: DocumentEntry | undefined): void {
    const matching = !entry?.plain && (this.options.matchBrackets?.() ?? true)
    if (matching !== (this.matching.get(instance) ?? true)) { this.matching.set(instance, matching); instance.updateOptions({ matchBrackets: matching ? 'always' : 'never' }) }
  }
  private showModel(instance: editor.IStandaloneCodeEditor, id: string, pane: 'primary' | 'secondary' = 'primary'): void {
    const entry = this.entries.get(id)
    const model = pane === 'secondary' ? entry?.secondaryModel : entry?.model
    this.matchBrackets(instance, entry)
    this.shown.set(instance, model ? { id, pane } : { id: '', pane })
    instance.setModel(model ?? null)
    const viewState = pane === 'secondary' ? entry?.secondaryViewState : entry?.viewState
    if (model && viewState) instance.restoreViewState(viewState)
    if (model) this.applyPendingReveal(instance, id)
  }
  activate(id: string): void {
    if (id && !this.entries.has(id) && !this.customs.has(id)) return
    if (this.pendingReveal && this.pendingReveal.id !== id) this.dropPendingFocus()
    if (id === this.getSnapshot().activeId) {
      this.events.emit({ type: 'documents.activated', tabId: id })
      return
    }
    if (this.pendingFocus !== id) this.pendingFocus = ''
    if (this.follower) { this.rememberView(this.follower); this.showModel(this.follower, id, 'primary') }
    if (this.secondaryFollower) { this.rememberView(this.secondaryFollower); this.showModel(this.secondaryFollower, id, 'secondary') }
    this.changed({ ...this.getSnapshot(), activeId: id })
    this.events.emit({ type: 'documents.activated', tabId: id })
  }
  /**
   * Puts the documents in `ids`' order (documents it leaves out keep theirs, after it), as the editor groups show them:
   * each group's tabs in turn. Returns whether anything moved.
   */
  reorder(ids: readonly string[]): boolean {
    if (this.disposed) return false
    const current = this.getSnapshot(), place = new Map(ids.map((id, index) => [id, index]))
    const documents = [...current.documents].sort((a, b) => (place.get(a.id) ?? ids.length) - (place.get(b.id) ?? ids.length))
    if (documents.every((document, index) => document === current.documents[index])) return false
    this.changed({ ...current, documents })
    return true
  }
  /**
   * Moves a tab to `index` in the strip (clamped to its ends), as dragging it or Move Left/Right does; the order is what
   * Next and Previous Query follow. Returns whether anything moved.
   */
  move(id: string, index: number): boolean {
    const current = this.getSnapshot(), from = current.documents.findIndex(document => document.id === id)
    if (from < 0 || this.disposed || !Number.isFinite(index)) return false
    const to = Math.min(current.documents.length - 1, Math.max(0, Math.trunc(index)))
    if (to === from || !!current.documents[to].pinned !== !!current.documents[from].pinned) return false
    const documents = current.documents.filter(document => document.id !== id)
    documents.splice(to, 0, current.documents[from])
    this.changed({ ...current, documents })
    return true
  }
  /** Applies changed settings: indentation to every open model, and bracket matching to the editor. */
  refreshOptions(): void {
    const options = this.options.modelOptions?.()
    if (options) {
      for (const entry of this.entries.values()) {
        entry.model.updateOptions(options)
        entry.secondaryModel?.updateOptions(options)
      }
    }
    for (const [instance, shown] of this.shown) this.matchBrackets(instance, this.entries.get(shown.id))
  }
  /** One editor that shows whichever document is active (the single-editor workbench, and tests). */
  bindEditor(instance: editor.IStandaloneCodeEditor): Disposable {
    if (this.follower) throw new Error('A query editor is already bound.')
    this.follower = instance
    this.matching.set(instance, true)
    this.showModel(instance, this.getSnapshot().activeId, 'primary')
    return { dispose: () => {
      if (this.follower !== instance) return
      this.releaseEditor(instance)
      this.follower = undefined
    } }
  }
  /** Binds a secondary-pane editor (either pinned to `id`, or following the active Cross-Engine Split tab when `id` is omitted). */
  bindSecondaryEditor(instance: editor.IStandaloneCodeEditor, id?: string): Disposable {
    if (id !== undefined) {
      this.showIn(instance, id, 'secondary')
      return { dispose: () => { this.unbindSecondaryEditor(instance) } }
    }
    if (this.secondaryFollower) throw new Error('A secondary query editor is already bound.')
    this.secondaryFollower = instance
    this.matching.set(instance, true)
    this.showModel(instance, this.getSnapshot().activeId, 'secondary')
    return { dispose: () => { this.unbindSecondaryEditor(instance) } }
  }
  unbindSecondaryEditor(instance: editor.IStandaloneCodeEditor): void {
    if (this.secondaryFollower === instance) this.secondaryFollower = undefined
    this.releaseEditor(instance)
  }
  /** An editor group's editor shows `id` (a text document; anything else shows nothing), keeping where it was in the last one. */
  showIn(instance: editor.IStandaloneCodeEditor, id: string, pane: 'primary' | 'secondary' = 'primary'): void {
    if (this.disposed) return
    if (!this.matching.has(instance)) this.matching.set(instance, true)
    const entry = this.entries.get(id)
    const targetModel = (pane === 'secondary' ? entry?.secondaryModel : entry?.model) ?? null
    const previous = this.shown.get(instance)
    if (previous?.id !== id || previous.pane !== pane || instance.getModel() !== targetModel) {
      this.rememberView(instance)
      this.showModel(instance, id, pane)
    }
    this.applyPendingReveal(instance, id)
    if (this.pendingFocus === id && instance.getModel() === this.activeModel(id)) this.focusActive()
  }
  /** The editor no longer shows documents (its group closed): where it was is kept, and it lets go of the model. */
  releaseEditor(instance: editor.IStandaloneCodeEditor): void {
    if (!this.shown.has(instance)) return
    this.rememberView(instance)
    instance.setModel(null)
    this.shown.delete(instance)
    this.matching.delete(instance)
  }
  /** The editor showing document `id` (matching the active pane's model when `pane` is omitted), if one does. */
  editorOf(id: string, pane?: 'primary' | 'secondary'): editor.IStandaloneCodeEditor | undefined {
    if (!id) return undefined
    const entry = this.entries.get(id)
    const targetModel = pane === 'secondary' ? entry?.secondaryModel : pane === 'primary' ? entry?.model : this.activeModel(id)
    if (!targetModel) return undefined
    for (const [instance, shown] of this.shown) {
      if (shown.id === id && instance.getModel() === targetModel) return instance
    }
    return undefined
  }
  /** All mounted editors currently showing document `id` (primary and secondary panes). */
  activeEditors(id = this.getSnapshot().activeId): readonly editor.IStandaloneCodeEditor[] {
    if (!id) return this.follower ? [this.follower] : []
    const editors: editor.IStandaloneCodeEditor[] = []
    for (const [instance, shown] of this.shown) if (shown.id === id) editors.push(instance)
    return editors
  }
  /** Finds the mounted query editor whose container or hosted widgets contain `element`. */
  editorContaining(element: Element | null): { readonly editor: editor.IStandaloneCodeEditor; readonly tabId: string; readonly pane: 'primary' | 'secondary' } | undefined {
    if (!element) return undefined
    const editorId = typeof element.closest === 'function' ? element.closest('[data-query-editor-id]')?.getAttribute('data-query-editor-id') : null
    for (const [instance, shown] of this.shown) {
      const dom = instance.getContainerDomNode?.()
      if ((dom && dom.contains(element)) || (editorId && instance.getId?.() === editorId)) {
        return { editor: instance, tabId: shown.id, pane: shown.pane }
      }
    }
    return undefined
  }
  /** The active document's focused-pane editor: the follower showing its active model, else the group editor showing it. */
  get boundEditor(): editor.IStandaloneCodeEditor | undefined {
    const activeId = this.getSnapshot().activeId
    if (!activeId) return this.follower
    const targetModel = this.activeModel(activeId)
    if (!targetModel) return this.follower
    if (this.secondaryFollower && this.secondaryFollower.getModel() === targetModel) return this.secondaryFollower
    if (this.follower && this.follower.getModel() === targetModel) return this.follower
    return this.editorOf(activeId)
  }
  getExecuteText(id = this.getSnapshot().activeId): { sql: string; startLine: number; startColumn: number } {
    const document = this.get(id), entry = this.entries.get(id)
    if (!document || !entry) return { sql: '', startLine: 1, startColumn: 1 }
    if (document.multiMode === 'cross') return { sql: this.getText(id), startLine: 1, startColumn: 1 }
    const model = entry.model
    const view = this.editorOf(id, 'primary') ?? this.follower
    const selection = view?.getModel() === model ? view.getSelection() : null
    // Any non-empty selection wins, even whitespace: an accidental one-character selection must not run the whole document.
    return selection && !selection.isEmpty() ? { sql: model.getValueInRange(selection), startLine: selection.startLineNumber, startColumn: selection.startColumn } : { sql: model.getValue(), startLine: 1, startColumn: 1 }
  }
  async runTask(action: () => Promise<unknown>): Promise<void> {
    if (this.disposed || this.getSnapshot().busy) return
    this.changed({ ...this.getSnapshot(), busy: true })
    try { await action() }
    finally { if (!this.disposed) this.changed({ ...this.getSnapshot(), busy: false }) }
  }
  /** Replaces `model`'s text with one minimal undoable edit (`pushEditOperations` with explicit undo stops, never `setValue`). */
  private applyTextEdit(model: editor.ITextModel, text: string, eol: LineEnding): void {
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
  }
  /**
   * Puts a file's text, as read again, in its document (File changed's Yes): one undoable edit of only the part that
   * changed, so the caret stays where it can, with the file's line ending; the document is clean afterwards.
   * For a Cross-Engine Split tab whose reloaded file is no longer well-formed `-- #Dialect`, transitions cleanly to File view.
   */
  reload(id: string, text: string, eol: LineEnding, file: NonNullable<QueryDocument['file']>): void {
    const document = this.get(id), entry = this.entries.get(id), model = entry?.model
    if (!document || !model || this.disposed) return
    if (entry) { entry.fill?.finish(); entry.fill = undefined }
    if (this.pendingReveal?.id === id) this.dropPendingFocus()
    if (document.multiMode === 'cross' && document.crossView !== 'file' && entry.secondaryModel) {
      const parsed = parseCrossEngineSql(text)
      if (parsed.ok) {
        entry.syncing = true
        try {
          this.applyTextEdit(model, parsed.sqlserver, eol)
          this.applyTextEdit(entry.secondaryModel, parsed.bigquery, eol)
        } finally { entry.syncing = false }
        entry.edits++
        entry.savedSecondaryVersionId = entry.secondaryModel.getAlternativeVersionId()
        this.replace(id, { file, ...this.named(id, file.name), savedVersionId: model.getAlternativeVersionId(), dirty: false })
        this.notifyContentChanged(id)
        return
      }
      this.disposeSecondaryModel(id, entry)
      entry.syncing = true
      try { this.applyTextEdit(model, text, eol) }
      finally { entry.syncing = false }
      entry.edits++
      this.replace(id, { file, ...this.named(id, file.name), crossView: 'file', activePane: 'primary', savedVersionId: model.getAlternativeVersionId(), dirty: false })
      this.notifyContentChanged(id)
      return
    }
    this.applyTextEdit(model, text, eol)
    this.replace(id, { file, ...this.named(id, file.name), savedVersionId: model.getAlternativeVersionId(), dirty: false })
  }
  /** The document's file was deleted outside: it has unsaved changes until Save writes the file again. */
  markUnsaved(id: string): void {
    const entry = this.entries.get(id)
    if (entry?.secondaryModel) entry.savedSecondaryVersionId = null
    this.replace(id, { savedVersionId: null, dirty: true })
  }
  async save(id: string, saveAs = false): Promise<boolean> {
    const provider = this.provider(id)
    if (provider) return provider.save(id, saveAs)
    // A value still filling is not all there: Save waits for its last chunk, so it never writes part of it and marks it saved.
    const fill = this.entries.get(id)?.fill
    if (fill) await fill.done
    const document = this.get(id), entry = this.entries.get(id), model = entry?.model
    if (!document || !entry || !model) return false
    model.pushStackElement()
    entry.secondaryModel?.pushStackElement()
    const secondaryModel = entry.secondaryModel, crossView = document.crossView
    const content = this.getText(id), savedVersionId = model.getAlternativeVersionId(), savedSecondaryVersionId = secondaryModel?.getAlternativeVersionId() ?? null
    const kind = isCustomKind(document.kind) ? undefined : document.kind
    const result = await this.api.saveSqlFile({ fileId: document.file?.id, name: document.name, content, saveAs, ...kind ? { kind } : {} })
    if (!result.ok) throw new Error(result.error)
    if (!result.value || this.disposed || this.entries.get(id)?.model !== model) return false
    model.pushStackElement()
    entry.secondaryModel?.pushStackElement()
    const sameView = this.get(id)?.crossView === crossView && entry.secondaryModel === secondaryModel
    if (entry.secondaryModel) entry.savedSecondaryVersionId = sameView ? savedSecondaryVersionId : null
    const nextSavedVersionId = sameView ? savedVersionId : null
    const dirty = !sameView || model.getAlternativeVersionId() !== savedVersionId || (!!entry.secondaryModel && entry.secondaryModel.getAlternativeVersionId() !== savedSecondaryVersionId)
    this.replace(id, { file: result.value, ...this.named(id, result.value.name), savedVersionId: nextSavedVersionId, dirty })
    return true
  }
  /**
   * Ends a query's session, committing or rolling back its open transaction first (`transaction`). A commit that fails
   * throws and leaves the session open with its transaction. A session found lost has ended all the same: SQL Server
   * rolled its transaction back. Resolves to a BigQuery close's note (docs/bigquery.md, Sessions), which the caller shows.
   * A BigQuery close refused with JOB_RUNNING also leaves a Messages line in the query, saying the answer was not carried
   * out; a BigQuery commit cut off by main's deadline says its outcome is unknown.
   */
  async endSession(id: string, entry?: SessionPlanEntry, options: { readonly abortOnRefusedCommit?: boolean } = {}): Promise<SessionCloseNote | undefined> {
    // Multi-server and cross-engine queries use ephemeral per-run sessions only: never call query.session.close.
    if (this.get(id)?.multiMode) return undefined
    // A BigQuery job is left running (keepJob: the session is not aborted) or cancelled and waited for (cancelJob).
    const transaction: SessionEnd | undefined = entry === 'commit' || entry === 'leaveCommit' ? 'commit' : entry === 'rollback' || entry === 'leaveRollback' ? 'rollback' : undefined
    const params = { ...transaction ? { transaction } : {}, ...entry === 'leave' ? { keepJob: true as const } : entry === 'cancelJob' ? { cancelJob: true as const } : {},
      ...options.abortOnRefusedCommit === undefined ? {} : { abortOnRefusedCommit: options.abortOnRefusedCommit } }
    const result = Object.keys(params).length ? await this.api.closeQuerySession(id, params) : await this.api.closeQuerySession(id)
    if (result.ok) this.sessionHooks?.ended?.(id, entry)
    if (result.ok || result.code === 'SESSION_LOST') this.events.emit({ type: 'session.ended', tabId: id })
    if (!result.ok) {
      if (result.code === 'JOB_RUNNING') this.sessionHooks?.message(id, result.error, 'error')
      if (result.code === 'TIMEOUT' && transaction === 'commit' && this.sessionHooks?.bigQuery(id)) throw new Error(bigQueryCommitTimeout)
      throw new Error(result.error)
    }
    return result.value.note
  }
  /** What ending a BigQuery session needs from the rest of the workbench: a Messages line for a query that stays, and
   *  whether a query is on BigQuery. Set once the workbench is built. */
  sessionHooks?: {
    readonly message: (id: string, text: string, kind?: 'info' | 'error') => void; readonly bigQuery: (id: string) => boolean; readonly note?: (id: string, note: SessionCloseNote) => void
    /** The session ended as planned: a BigQuery job left running is reported with its id (QueryService.sessionClosed). */
    readonly ended?: (id: string, entry: SessionPlanEntry | undefined) => void
  }
  // The caller holds runTask and has confirmed dirty state, open transactions (`transaction`) and running queries.
  /** Resolves to the BigQuery close's note, for the caller to show once the query has closed. */
  async close(id: string, transaction?: SessionPlanEntry, options: { readonly abortOnRefusedCommit?: boolean } = {}): Promise<SessionCloseNote | undefined> {
    if (this.customs.has(id)) { this.closeCustom(id); return }
    const entry = this.entries.get(id)
    if (!entry) return
    const version = entry.edits
    const document = this.get(id)
    // Only a single-server query has a persistent session to end.
    const note = isQueryDocument(document) && !document?.multiMode ? await this.endSession(id, transaction, options) : undefined
    if (this.disposed || this.entries.get(id) !== entry) return note
    if (version !== entry.edits) {
      // The session has ended all the same, so what became of it shows in the query that stays.
      if (note) this.sessionHooks?.note?.(id, note)
      throw new Error('The query changed while closing. Close it again to review the latest changes.')
    }
    this.closeText(id, entry)
    return note
  }
  /** Sessions and the transport have ended. Validate the complete reviewed query set before the first local close. */
  closeDisconnectedQueries(approved: readonly { readonly id: string; readonly revision: number }[]): void {
    if (this.disposed || !this.getSnapshot().busy || new Set(approved.map(item => item.id)).size !== approved.length || approved.some(({ id, revision }) =>
      !isQueryDocument(this.get(id)) || !this.entries.has(id) || this.editRevision(id) !== revision))
      throw new Error('The approved queries changed before local close. All tabs stayed open.')
    for (const { id } of approved) this.closeText(id, this.entries.get(id)!)
  }
  private closeText(id: string, entry: DocumentEntry): void {
    this.keepClosed(id, entry)
    const current = this.getSnapshot(), next = this.closing(id)
    this.unshow(id, current.activeId === id ? next.activeId : undefined)
    entry.fill?.finish()
    entry.fill = undefined
    entry.subscription.dispose()
    entry.model.dispose()
    entry.secondarySubscription?.dispose()
    entry.secondaryModel?.dispose()
    this.entries.delete(id)
    this.contentListeners.delete(id)
    this.changed({ ...current, documents: next.tabs, activeId: next.activeId })
    this.events.emit({ type: 'documents.closed', tabId: id })
    if (current.activeId !== next.activeId) this.events.emit({ type: 'documents.activated', tabId: next.activeId })
  }
  /** A custom document has no session to end and no model to dispose; its provider forgets it. */
  private closeCustom(id: string): void {
    const provider = this.provider(id), current = this.getSnapshot(), next = this.closing(id)
    this.customs.delete(id)
    this.unshow(id, current.activeId === id ? next.activeId : undefined)
    this.changed({ ...current, documents: next.tabs, activeId: next.activeId })
    provider?.closed(id)
    this.events.emit({ type: 'documents.closed', tabId: id })
    if (current.activeId !== next.activeId) this.events.emit({ type: 'documents.activated', tabId: next.activeId })
  }
  /** A closing document leaves the editors: the following one moves to `next`, a group's shows nothing until its group shows another. */
  private unshow(id: string, next: string | undefined): void {
    if (this.pendingReveal?.id === id) this.dropPendingFocus()
    for (const [instance, shown] of this.shown) {
      if (instance === this.follower) { if (next !== undefined) this.showModel(instance, next, 'primary') }
      else if (instance === this.secondaryFollower) { if (next !== undefined) this.showModel(instance, next, 'secondary') }
      else if (shown.id === id) this.showModel(instance, '', shown.pane)
    }
  }
  dispose(): void {
    this.disposed = true
    this.pendingReveal = undefined
    this.closedQueries.length = 0
    this.closedCharacters = 0
    this.textFocus = undefined
    this.customs.clear()
    this.contentListeners.clear()
    for (const instance of this.shown.keys()) instance.setModel(null)
    this.shown.clear()
    this.follower = undefined
    this.secondaryFollower = undefined
    for (const entry of this.entries.values()) {
      entry.fill?.finish()
      entry.fill = undefined
      entry.subscription.dispose()
      entry.model.dispose()
      entry.secondarySubscription?.dispose()
      entry.secondaryModel?.dispose()
    }
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
