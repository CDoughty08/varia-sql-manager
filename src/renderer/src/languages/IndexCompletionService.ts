import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { VariaApi } from '../../../shared/contracts'
import { isBigQueryName } from '../../../shared/bigquery/names'
import { completeFromIndex } from '../../../shared/completion/complete'
import { definitionFromIndex, IndexUnavailableError } from '../../../shared/completion/definition'
import { hoverFromIndex } from '../../../shared/completion/hover'
import { LookupCache } from '../../../shared/completion/lookup-cache'
import type { CompletionDialect, CompletionItem, CompletionKind, CompletionWord, IndexLookup } from '../../../shared/completion/model'
import type { BigQueryIndexScope, ObjectIndexStatus } from '../../../shared/explorer/search'
import { googleSqlDialect } from '../../../shared/googlesql/dialect'
import { scanGoogleSql } from '../../../shared/googlesql/lexer'
import { readGoogleSqlCompletion, readGoogleSqlHover, readGoogleSqlStatementSources } from '../../../shared/googlesql/scope'
import { languageLimits } from '../../../shared/language-service'
import type { LanguageLookupPath } from '../../../shared/language-lookup'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { documentProvider, isQueryDocument } from '../documents'
import type { ConnectionService } from '../services/connections'
import { isBigQueryConnection, isLiveConnection } from '../services/connection-availability'
import type { DocumentService } from '../services/documents'
import { definitionErrors } from './definition'
import { googleSqlLanguageId } from './googlesql'

type LookupApi = Pick<VariaApi, 'languageLookup'>
interface Snapshot {
  readonly errors: ReadonlyMap<string, string>
  readonly indexes: ReadonlyMap<string, 'none' | 'building' | 'ready'>
  readonly refreshing: ReadonlySet<string>
}
/** What Go To Definition found in a BigQuery tab: an object of the index, on the tab's connection. */
export interface FoundIndexObject { readonly connectionId: string; readonly kind: string; readonly subtype?: string; readonly project: string; readonly dataset: string; readonly name: string }
interface Target { readonly documentId: string; readonly connectionId?: string; readonly key?: string; readonly dialect: CompletionDialect }
export interface IndexStateEntry { readonly requestId?: string; readonly status?: ObjectIndexStatus; readonly error?: string }
export interface IndexStateStore {
  getSnapshot(): { readonly indexes: Readonly<Record<string, IndexStateEntry | undefined>> }
  subscribe(listener: () => void): () => void
}
export interface IndexCompletionOptions {
  /** Starts the connection's Search Objects index when it has none (and Options lets builds start on their own). */
  readonly ensureIndex: (connectionId: string) => void
  /** Refreshes the scopes a query tab reads and settles when the refresh completes. */
  readonly refreshScopes?: (connectionId: string, scopes: readonly BigQueryIndexScope[]) => Promise<boolean>
  /** Search Objects' index state store: updates `Snapshot.indexes` and clears `LookupCache` immediately on build changes. */
  readonly indexState?: IndexStateStore
}
/** Lookups in flight at once across every editor: past it, completion answers keywords and functions only, marked incomplete. */
export const indexCompletionLimits = { inFlight: 4, refreshStatements: 32, refreshScopes: 16 } as const

const kinds: Readonly<Record<CompletionKind, keyof typeof Monaco.languages.CompletionItemKind>> = {
  keyword: 'Keyword', function: 'Function', container: 'Module', table: 'Class', view: 'Interface', routine: 'Method', model: 'Value',
  column: 'Field', field: 'Property', alias: 'Variable', cte: 'Reference'
}
/** Leaf identifier kinds whose completions exit an auto-closed trailing backtick; containers stay inside for `.` chaining. */
const leafKinds: ReadonlySet<CompletionKind> = new Set(['table', 'view', 'routine', 'model', 'column', 'field', 'cte', 'alias'])

/**
 * Completion and hover for BigQuery tabs (the `googlesql` language), Varia's own from the Search Objects index (docs/language-services.md,
 * Completion from the index): the GoogleSQL scope reader reads the caret's statement, and the shared pipeline asks language.lookup for
 * the projects, datasets, tables and columns it needs. No language server is involved and nothing leaves the machine: the index is
 * in the backend's memory. SQL Server's tabs keep SqlLanguageService.
 */
export class IndexCompletionService extends SnapshotStore<Snapshot> implements Disposable {
  private readonly bindings: Disposable[] = []
  private readonly caches = new Map<string, LookupCache>()
  private readonly ensured = new Set<string>()
  /** The connection (and generation) each tab's error came from: it goes when the tab moves to another or reconnects. */
  private readonly errorKeys = new Map<string, string>()
  private readonly indexSignatures = new Map<string, string>()
  private readonly refreshOps = new Map<string, { readonly key: string; readonly cancel: () => void; readonly work: Promise<boolean> }>()
  private inFlight = 0
  private disposed = false

  constructor(monaco: typeof Monaco, private readonly api: LookupApi, private readonly documents: DocumentService, private readonly connections: ConnectionService,
    private readonly options: IndexCompletionOptions) {
    super({ errors: new Map(), indexes: new Map(), refreshing: new Set() })
    this.bindings.push(monaco.languages.registerCompletionItemProvider(googleSqlLanguageId, {
      triggerCharacters: ['.', '`'],
      provideCompletionItems: async (model, position, _context, token) => {
        const target = this.target(model)
        if (!target || token.isCancellationRequested) return { suggestions: [] }
        const text = model.getValue(), offset = model.getOffsetAt(position), version = model.getVersionId()
        let read: ReturnType<typeof readGoogleSqlCompletion>
        try { read = readGoogleSqlCompletion(text, offset) } catch { return { incomplete: true, suggestions: [] } }
        if (read.site.kind === 'none') return { suggestions: [] }
        // A failure is a value: an empty list the editor asks for again, never a rejection.
        const list = await completeFromIndex(read, target.dialect, this.lookup(target)).catch(() => ({ items: [], incomplete: true }))
        if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return { suggestions: [] }
        const start = model.getPositionAt(read.word.start), end = model.getPositionAt(Math.max(read.word.end, offset))
        const insert = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: position.lineNumber, endColumn: position.column }
        const replace = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }
        const canExitBacktick = read.word.quoted
          && read.word.end === offset
          && position.column < model.getLineMaxColumn(position.lineNumber)
          && model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column + 1
          }) === '`'
        // Every site that reads the index stays incomplete while building; non-empty lists stay incomplete so exact matches re-rank via LookupCache.
        const asksIndex = read.site.kind === 'object' || read.site.kind === 'member' || read.site.kind === 'expression' || read.site.kind === 'joinCondition' || read.site.kind === 'unnestArg'
        const building = target.key && asksIndex ? this.caches.get(target.key)?.index !== 'ready' : false
        return {
          incomplete: list.items.length > 0 || list.incomplete || building,
          suggestions: list.items.map(item => suggestion(monaco, item, { insert, replace }, read.word, canExitBacktick))
        }
      }
    }), monaco.languages.registerHoverProvider(googleSqlLanguageId, {
      provideHover: async (model, position, token) => {
        const target = this.target(model)
        if (!target || token.isCancellationRequested) return null
        const version = model.getVersionId()
        let read: ReturnType<typeof readGoogleSqlHover>
        try { read = readGoogleSqlHover(model.getValue(), model.getOffsetAt(position)) } catch { return null }
        if (!read) return null
        const hover = await hoverFromIndex(read, target.dialect, this.lookup(target)).catch(() => undefined)
        if (!hover || token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return null
        const start = model.getPositionAt(hover.span.start), end = model.getPositionAt(hover.span.end)
        return { contents: [{ value: hover.markdown, isTrusted: false, supportHtml: false }], range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column } }
      }
    }))
    const reconcile = () => this.reconcile()
    this.bindings.push({ dispose: connections.subscribe(reconcile) }, { dispose: documents.subscribe(reconcile) })
    if (options.indexState) {
      this.bindings.push({ dispose: options.indexState.subscribe(() => this.syncIndexes()) })
      this.syncIndexes()
    }
  }

  /**
   * Go To Definition in a BigQuery tab: the project, dataset and object the name at `position` stands for, from the connection's
   * Search Objects index, as completion resolves names (`definitionFromIndex`). Null when it names no indexed object, undefined
   * when the text changed or `wanted` turned false meanwhile; throws `definitionErrors` when it cannot ask at all or the index
   * could not answer (busy past its in-flight cap, or failed). A model that is no query tab's (Properties' read-only Definition
   * editor) has no connection to ask: null.
   */
  async definition(model: Monaco.editor.ITextModel, position: Monaco.Position, wanted: () => boolean = () => true): Promise<FoundIndexObject | null | undefined> {
    if (model.getValueLength() > languageLimits.documentCharacters) throw new Error(definitionErrors.tooLarge)
    const target = this.target(model)
    if (!target) return null
    const { connectionId } = target
    if (!connectionId) throw new Error(definitionErrors.connectBigQueryFirst)
    const version = model.getVersionId()
    let read: ReturnType<typeof readGoogleSqlHover>
    try { read = readGoogleSqlHover(model.getValue(), model.getOffsetAt(position)) } catch { return null }
    if (!read) return null
    let found
    try { found = await definitionFromIndex(read, target.dialect, this.lookup(target)) }
    catch (error) { if (error instanceof IndexUnavailableError) throw new Error(definitionErrors.indexUnavailable); throw error }
    if (!wanted() || model.isDisposed() || model.getVersionId() !== version) return undefined
    if (!found || found.path.length !== 3) return null
    const [project, dataset, name] = found.path as [string, string, string]
    return { connectionId, kind: found.kind, ...found.subtype ? { subtype: found.subtype } : {}, project, dataset, name }
  }

  /** The status bar's IntelliSense segment for a BigQuery tab, or undefined for any other document (SqlLanguageService's). */
  availability(documentId: string): { label: string; detail: string } | undefined {
    const document = this.documents.get(documentId)
    if (!document || !isQueryDocument(document) || documentProvider(document) !== 'bigquery') return
    if ((this.documents.getModel(documentId)?.getValueLength() ?? 0) > languageLimits.documentCharacters)
      return { label: 'IntelliSense paused', detail: `Language support is available for queries up to ${languageLimits.documentCharacters.toLocaleString('en-US')} characters.` }
    const connection = document.connectionId ? this.connections.get(document.connectionId) : undefined
    if (!connection || !isLiveConnection(connection) || !isBigQueryConnection(connection))
      return { label: 'IntelliSense disconnected', detail: 'Keywords and functions complete. Connect this query to BigQuery for projects, datasets, tables and columns from its Search Objects index.' }
    const snapshot = this.getSnapshot()
    if (snapshot.refreshing.has(documentId))
      return { label: 'IntelliSense refreshing', detail: 'Refreshing schema suggestions for this query’s connection and dataset.' }
    const error = snapshot.errors.get(documentId)
    if (error) return { label: 'IntelliSense unavailable', detail: error }
    const index = snapshot.indexes.get(cacheKey(connection))
    if (index === 'building') return { label: 'IntelliSense indexing', detail: 'Search Objects is reading this connection’s metadata; suggestions fill in as it reads each dataset. Ctrl+Space opens suggestions.' }
    if (index === 'none') return { label: 'IntelliSense', detail: 'Table and column suggestions come from this connection’s Search Objects index, which has not been built. Build it in Search Objects, or turn on Options › Object Explorer › Index objects when a server connects. Ctrl+Space opens suggestions.' }
    return { label: 'IntelliSense', detail: 'Completion and hover use this connection’s Search Objects index (free metadata reads; nothing runs in BigQuery). Ctrl+Space opens suggestions.' }
  }

  /**
   * Clears the connection's `LookupCache` immediately and triggers a scoped Search Objects refresh for the datasets
   * referenced by `documentId` (or its default dataset / billing project), keeping the query session and unsaved SQL intact.
   */
  async refreshCache(documentId = this.documents.getSnapshot().activeId, token?: Monaco.CancellationToken): Promise<boolean> {
    if (this.disposed || token?.isCancellationRequested) return false
    const document = documentId ? this.documents.get(documentId) : undefined
    const model = document ? this.documents.getModel(document.id) : undefined
    if (!document || !isQueryDocument(document) || !model) throw new Error('Open a SQL query to refresh IntelliSense.')
    if (model.getValueLength() > languageLimits.documentCharacters) throw new Error('This query is too large for SQL language support.')
    if (documentProvider(document) !== 'bigquery') throw new Error('The query is unavailable for SQL language support.')
    const connection = document.connectionId ? this.connections.get(document.connectionId) : undefined
    if (!connection || !isLiveConnection(connection) || !isBigQueryConnection(connection)) throw new Error('Connect this query to a live database before refreshing IntelliSense.')
    const key = cacheKey(connection)
    const existing = this.refreshOps.get(document.id)
    if (existing && existing.key === key) {
      if (!token) return existing.work
      return new Promise<boolean>(resolve => {
        const sub = token.onCancellationRequested(() => { sub.dispose(); resolve(false) })
        void existing.work.then(ok => { sub.dispose(); resolve(token.isCancellationRequested ? false : ok) }, () => { sub.dispose(); resolve(false) })
      })
    }
    if (existing) existing.cancel()
    this.caches.get(key)?.clear()
    this.failure(document.id, key, undefined)
    const dataset = /^\w{1,1024}$/.test(document.database ?? '') ? document.database : undefined
    const scopes = extractBigQueryRefreshScopes(model.getValue(), connection.server, dataset)
    if (!this.options.refreshScopes) return true
    let cancelled = false
    let settleCancel = () => {}
    const cancelledPromise = new Promise<boolean>(resolve => { settleCancel = () => resolve(false) })
    const cancel = () => { if (cancelled) return; cancelled = true; settleCancel() }
    const cancelBinding = token?.onCancellationRequested(cancel)
    const op: { readonly key: string; readonly cancel: () => void; work: Promise<boolean> } = { key, cancel, work: Promise.resolve(false) }
    const work = (async () => {
      try {
        const result = await Promise.race([
          this.options.refreshScopes!(connection.id, scopes).catch(() => false),
          cancelledPromise
        ])
        return !cancelled && !this.disposed && result
      } finally {
        cancelBinding?.dispose()
        if (this.refreshOps.get(document.id) === op) {
          this.refreshOps.delete(document.id)
          this.publishSnapshot()
        }
        this.caches.get(key)?.clear()
      }
    })()
    op.work = work
    this.refreshOps.set(document.id, op)
    this.publishSnapshot()
    return work
  }

  /** What a model's requests use: its BigQuery tab, the tab's live connection (if any) and the names it resolves unqualified names to. */
  private target(model: Monaco.editor.ITextModel): Target | undefined {
    if (this.disposed || model.getLanguageId() !== googleSqlLanguageId || model.getValueLength() > languageLimits.documentCharacters) return
    const document = this.documents.getSnapshot().documents.find(entry => this.documents.getModel(entry.id) === model)
    if (!document || !isQueryDocument(document)) return
    const connection = document.connectionId ? this.connections.get(document.connectionId) : undefined
    if (!connection || !isLiveConnection(connection) || !isBigQueryConnection(connection)) return { documentId: document.id, dialect: googleSqlDialect({ project: '' }) }
    // The tab's default dataset, as Execute sends it (a dataset id: letters, digits and underscores).
    const dataset = /^\w{1,1024}$/.test(document.database ?? '') ? document.database : undefined
    return { documentId: document.id, connectionId: connection.id, key: cacheKey(connection), dialect: googleSqlDialect({ project: connection.server, dataset }) }
  }

  /** language.lookup for a target, through its connection's cache; a tab without a live connection has no index to ask. */
  private lookup(target: Target): IndexLookup {
    const { connectionId, key, documentId } = target
    if (!connectionId || !key) return async () => undefined
    let cache = this.caches.get(key)
    if (!cache) {
      cache = new LookupCache(async (requests, caller) => this.ask(connectionId, key, caller, requests))
      this.caches.set(key, cache)
    }
    const kept = cache
    return async requests => {
      const answers = await kept.lookup(requests, documentId)
      // A connection reconcile() dropped while this lookup ran is not brought back.
      if (kept.index && this.caches.get(key) === kept && this.getSnapshot().indexes.get(key) !== kept.index) {
        const indexes = new Map(this.getSnapshot().indexes).set(key, kept.index)
        this.publish({ ...this.getSnapshot(), indexes })
      }
      if (kept.index === 'none' && !this.ensured.has(key)) { this.ensured.add(key); this.options.ensureIndex(connectionId) }
      return answers
    }
  }

  /** One language.lookup; its failure (or success) is shown on the tab that asked. */
  private async ask(connectionId: string, key: string, documentId: string | undefined, requests: LanguageLookupPath[]) {
    if (this.disposed || this.inFlight >= indexCompletionLimits.inFlight) return undefined
    this.inFlight++
    try {
      const result = await this.api.languageLookup({ connectionId, requests })
      if (this.disposed) return undefined
      this.failure(documentId, key, result.ok ? undefined : result.error)
      return result.ok ? result.value : undefined
    } catch (error) {
      this.failure(documentId, key, error instanceof Error ? error.message : 'The index could not answer.')
      return undefined
    } finally { this.inFlight-- }
  }

  private failure(documentId: string | undefined, key: string, error?: string): void {
    if (documentId && error) this.errorKeys.set(documentId, key)
    if (this.disposed || !documentId || this.getSnapshot().errors.get(documentId) === error) return
    const errors = new Map(this.getSnapshot().errors)
    if (error) errors.set(documentId, error); else errors.delete(documentId)
    this.publish({ ...this.getSnapshot(), errors })
  }

  /** Drops the caches of connections gone or reconnected (a new generation), and the errors/refreshes of closed or switched tabs. */
  private reconcile(): void {
    if (this.disposed) return
    const live = new Set(this.connections.getSnapshot().filter(connection => isLiveConnection(connection) && isBigQueryConnection(connection)).map(cacheKey))
    for (const key of [...this.caches.keys()]) if (!live.has(key)) { this.caches.delete(key); this.ensured.delete(key) }
    for (const [id, op] of [...this.refreshOps.entries()]) {
      const document = this.documents.get(id)
      const connection = document?.connectionId ? this.connections.get(document.connectionId) : undefined
      if (!document || !isQueryDocument(document) || documentProvider(document) !== 'bigquery' || !connection || !isLiveConnection(connection) || !isBigQueryConnection(connection) || cacheKey(connection) !== op.key) {
        this.refreshOps.delete(id)
        op.cancel()
      }
    }
    const snapshot = this.getSnapshot()
    const errors = new Map([...snapshot.errors].filter(([id]) => {
      const document = this.documents.get(id)
      const connection = document?.connectionId ? this.connections.get(document.connectionId) : undefined
      return !!connection && cacheKey(connection) === this.errorKeys.get(id)
    }))
    for (const id of [...this.errorKeys.keys()]) if (!errors.has(id)) this.errorKeys.delete(id)
    const indexes = new Map([...snapshot.indexes].filter(([key]) => live.has(key)))
    const refreshing = new Set(this.refreshOps.keys())
    const refreshingChanged = refreshing.size !== snapshot.refreshing.size || [...refreshing].some(id => !snapshot.refreshing.has(id))
    if (errors.size !== snapshot.errors.size || indexes.size !== snapshot.indexes.size || refreshingChanged) {
      this.publish({ errors, indexes, refreshing })
    }
    this.syncIndexes()
  }

  private syncIndexes(): void {
    if (this.disposed || !this.options.indexState) return
    const raw = this.options.indexState.getSnapshot().indexes
    const snapshot = this.getSnapshot()
    const indexes = new Map(snapshot.indexes)
    let changed = false
    const liveIds = new Set<string>()
    for (const connection of this.connections.getSnapshot()) {
      if (!isLiveConnection(connection) || !isBigQueryConnection(connection)) continue
      liveIds.add(connection.id)
      const entry = raw[connection.id]
      const sig = entry
        ? `${entry.requestId ?? ''}|${entry.status?.state ?? ''}|${entry.status?.builtAt ?? ''}|${entry.status?.objects ?? ''}|${entry.status?.databases ?? ''}|${entry.status?.indexed ?? ''}|${entry.status?.namesOnly?.length ?? 0}|${entry.status?.skipped.length ?? 0}|${entry.error ?? ''}`
        : ''
      const prevSig = this.indexSignatures.get(connection.id) ?? ''
      if (sig !== prevSig) {
        if (sig) this.indexSignatures.set(connection.id, sig); else this.indexSignatures.delete(connection.id)
        this.caches.get(cacheKey(connection))?.clear()
      }
      const state: 'none' | 'building' | 'ready' | undefined = entry?.requestId
        ? 'building'
        : entry?.status?.state === 'ready'
          ? 'ready'
          : entry?.status?.state === 'none'
            ? 'none'
            : undefined
      const key = cacheKey(connection)
      if (state) {
        if (indexes.get(key) !== state) { indexes.set(key, state); changed = true }
      } else if (indexes.has(key)) {
        indexes.delete(key); changed = true
      }
    }
    for (const id of [...this.indexSignatures.keys()]) if (!liveIds.has(id)) this.indexSignatures.delete(id)
    if (changed) this.publish({ ...snapshot, indexes })
  }

  private publishSnapshot(patch: Partial<Pick<Snapshot, 'errors' | 'indexes'>> = {}): void {
    if (this.disposed) return
    const current = this.getSnapshot()
    this.publish({
      errors: patch.errors ?? current.errors,
      indexes: patch.indexes ?? current.indexes,
      refreshing: new Set(this.refreshOps.keys())
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const op of this.refreshOps.values()) op.cancel()
    this.refreshOps.clear()
    this.indexSignatures.clear()
    this.bindings.forEach(binding => binding.dispose())
    this.caches.clear()
    this.clearListeners()
  }
}

const cacheKey = (connection: { readonly id: string; readonly generation: number }) => `${connection.id}:${connection.generation}`

/** Extracts validated `{ project, dataset }` scopes from a query's statements and default dataset. */
export function extractBigQueryRefreshScopes(text: string, billingProject: string, defaultDataset?: string): BigQueryIndexScope[] {
  const scopes: BigQueryIndexScope[] = []
  const seen = new Set<string>()
  const addScope = (project: string, dataset?: string) => {
    if (scopes.length >= indexCompletionLimits.refreshScopes) return
    if (!isBigQueryName('project', project)) return
    if (dataset !== undefined) {
      if (dataset.toUpperCase() === 'INFORMATION_SCHEMA' || !isBigQueryName('dataset', dataset)) return
    }
    const key = `${project}\u0000${dataset ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    scopes.push(dataset !== undefined ? { project, dataset } : { project })
  }
  if (defaultDataset) addScope(billingProject, defaultDataset)
  const dialect = googleSqlDialect({ project: billingProject, dataset: defaultDataset })
  const offsets: number[] = []
  try {
    for (const token of scanGoogleSql(text)) {
      if (token.kind === 'punctuation' && text[token.start] === ';') {
        offsets.push(token.start)
        if (offsets.length >= indexCompletionLimits.refreshStatements) break
      }
    }
  } catch { /* fall through to whole text / billing project */ }
  if (offsets.length < indexCompletionLimits.refreshStatements) offsets.push(text.length)
  for (const offset of offsets) {
    if (scopes.length >= indexCompletionLimits.refreshScopes) break
    let sources: ReturnType<typeof readGoogleSqlStatementSources>
    try { sources = readGoogleSqlStatementSources(text, offset) } catch { continue }
    for (const source of sources) {
      if (source.kind !== 'object') continue
      const path = dialect.objectPath(source.parts)
      if (path && path.length === 3) addScope(path[0], path[1])
    }
    try {
      const read = readGoogleSqlCompletion(text, offset)
      if (read.site.kind === 'object') {
        const { qualifier } = read.site
        if (qualifier.length === 2) addScope(qualifier[0], qualifier[1])
        else if (qualifier.length === 1) {
          if (isBigQueryName('dataset', qualifier[0]) && qualifier[0].toUpperCase() !== 'INFORMATION_SCHEMA') addScope(billingProject, qualifier[0])
          else if (isBigQueryName('project', qualifier[0])) addScope(qualifier[0])
        }
      }
    } catch { /* trailing incomplete qualifier fallback is optional */ }
  }
  if (!scopes.length) addScope(billingProject)
  return scopes
}

function unquoteGoogleSqlName(value: string, quoted = false): string {
  if (!quoted) return value
  const body = value.startsWith('`')
    ? (value.length > 1 && value.endsWith('`') ? value.slice(1, -1) : value.slice(1))
    : value
  return body.replace(/\\(.)/g, '$1')
}

/** A pipeline item as Monaco shows it: structured label, icon, exact-match boost, typed word ranges, and backtick exit on leaves. */
function suggestion(
  monaco: typeof Monaco,
  item: CompletionItem,
  range: { insert: Monaco.IRange; replace: Monaco.IRange },
  word: Pick<CompletionWord, 'typed' | 'quoted'>,
  canExitBacktick: boolean
): Monaco.languages.CompletionItem {
  const typed = word.typed
  const name = item.filterText ?? item.label
  const exact = typed.length > 0 && name.toLowerCase() === unquoteGoogleSqlName(typed, word.quoted).toLowerCase()
  const description = item.detail?.trim() || undefined
  const exitBacktick = canExitBacktick && leafKinds.has(item.kind)
  const itemRange = exitBacktick
    ? {
        insert: { ...range.insert, endColumn: range.insert.endColumn + 1 },
        replace: { ...range.replace, endColumn: range.replace.endColumn + 1 }
      }
    : range
  return {
    label: description ? { label: item.label, description } : { label: item.label },
    kind: monaco.languages.CompletionItemKind[kinds[item.kind]],
    insertText: exitBacktick ? `${item.insertText}\`` : item.insertText,
    detail: item.detail,
    documentation: item.documentation,
    sortText: `${exact ? '0' : '1'}:${item.sortText}`,
    filterText: exact ? typed : word.quoted ? name.replace(/[\\`]/g, '\\$&') : item.filterText,
    range: itemRange
  }
}
