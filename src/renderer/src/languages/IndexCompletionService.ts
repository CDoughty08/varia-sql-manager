import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { VariaApi } from '../../../shared/contracts'
import { completeFromIndex } from '../../../shared/completion/complete'
import { hoverFromIndex } from '../../../shared/completion/hover'
import { LookupCache } from '../../../shared/completion/lookup-cache'
import type { CompletionDialect, CompletionItem, CompletionKind, IndexLookup } from '../../../shared/completion/model'
import { googleSqlDialect } from '../../../shared/googlesql/dialect'
import { readGoogleSqlCompletion, readGoogleSqlHover } from '../../../shared/googlesql/scope'
import { languageLimits } from '../../../shared/language-service'
import type { LanguageLookupPath } from '../../../shared/language-lookup'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { documentProvider, isQueryDocument } from '../documents'
import type { ConnectionService } from '../services/connections'
import { isBigQueryConnection, isLiveConnection } from '../services/connection-availability'
import type { DocumentService } from '../services/documents'
import { googleSqlLanguageId } from './googlesql'

type LookupApi = Pick<VariaApi, 'languageLookup'>
interface Snapshot { readonly errors: ReadonlyMap<string, string>; readonly indexes: ReadonlyMap<string, 'none' | 'building' | 'ready'> }
interface Target { readonly documentId: string; readonly connectionId?: string; readonly key?: string; readonly dialect: CompletionDialect }
export interface IndexCompletionOptions {
  /** Starts the connection's Search Objects index when it has none (and Options lets builds start on their own). */
  readonly ensureIndex: (connectionId: string) => void
}
/** Lookups in flight at once across every editor: past it, completion answers keywords and functions only, marked incomplete. */
export const indexCompletionLimits = { inFlight: 4 } as const

const kinds: Readonly<Record<CompletionKind, keyof typeof Monaco.languages.CompletionItemKind>> = {
  keyword: 'Keyword', function: 'Function', container: 'Module', table: 'Class', view: 'Interface', routine: 'Method', model: 'Value',
  column: 'Field', field: 'Property', alias: 'Variable', cte: 'Reference'
}

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
  private inFlight = 0
  private disposed = false

  constructor(monaco: typeof Monaco, private readonly api: LookupApi, private readonly documents: DocumentService, private readonly connections: ConnectionService,
    private readonly options: IndexCompletionOptions) {
    super({ errors: new Map(), indexes: new Map() })
    this.bindings.push(monaco.languages.registerCompletionItemProvider(googleSqlLanguageId, {
      triggerCharacters: ['.', '`'],
      provideCompletionItems: async (model, position, _context, token) => {
        const target = this.target(model)
        if (!target || token.isCancellationRequested) return { suggestions: [] }
        const text = model.getValue(), offset = model.getOffsetAt(position), version = model.getVersionId()
        const read = readGoogleSqlCompletion(text, offset)
        if (read.site.kind === 'none') return { suggestions: [] }
        const list = await completeFromIndex(read, target.dialect, this.lookup(target))
        if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return { suggestions: [] }
        const start = model.getPositionAt(read.word.start), end = model.getPositionAt(Math.max(read.word.end, offset))
        const insert = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: position.lineNumber, endColumn: position.column }
        const replace = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }
        // Every list is incomplete while the index builds, so names it reads later still show as the word grows.
        const building = target.key ? this.caches.get(target.key)?.index !== 'ready' : false
        return { incomplete: list.incomplete || building, suggestions: list.items.map(item => suggestion(monaco, item, { insert, replace })) }
      }
    }), monaco.languages.registerHoverProvider(googleSqlLanguageId, {
      provideHover: async (model, position, token) => {
        const target = this.target(model)
        if (!target || token.isCancellationRequested) return null
        const read = readGoogleSqlHover(model.getValue(), model.getOffsetAt(position))
        if (!read) return null
        const hover = await hoverFromIndex(read, target.dialect, this.lookup(target))
        if (!hover || token.isCancellationRequested || model.isDisposed()) return null
        const start = model.getPositionAt(hover.span.start), end = model.getPositionAt(hover.span.end)
        return { contents: [{ value: hover.markdown, isTrusted: false, supportHtml: false }], range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column } }
      }
    }))
    const reconcile = () => this.reconcile()
    this.bindings.push({ dispose: connections.subscribe(reconcile) }, { dispose: documents.subscribe(reconcile) })
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
    const error = this.getSnapshot().errors.get(documentId)
    if (error) return { label: 'IntelliSense unavailable', detail: error }
    const index = this.getSnapshot().indexes.get(cacheKey(connection))
    if (index === 'building') return { label: 'IntelliSense indexing', detail: 'Search Objects is reading this connection’s metadata; suggestions fill in as it reads each dataset. Ctrl+Space opens suggestions.' }
    if (index === 'none') return { label: 'IntelliSense', detail: 'Table and column suggestions come from this connection’s Search Objects index, which has not been built. Build it in Search Objects, or turn on Options › Object Explorer › Index objects when a server connects. Ctrl+Space opens suggestions.' }
    return { label: 'IntelliSense', detail: 'Completion and hover use this connection’s Search Objects index (free metadata reads; nothing runs in BigQuery). Ctrl+Space opens suggestions.' }
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
      cache = new LookupCache(async requests => this.ask(connectionId, documentId, requests))
      this.caches.set(key, cache)
    }
    const kept = cache
    return async requests => {
      const answers = await kept.lookup(requests)
      if (kept.index && this.getSnapshot().indexes.get(key) !== kept.index) {
        const indexes = new Map(this.getSnapshot().indexes).set(key, kept.index)
        this.publish({ ...this.getSnapshot(), indexes })
      }
      if (kept.index === 'none' && !this.ensured.has(key)) { this.ensured.add(key); this.options.ensureIndex(connectionId) }
      return answers
    }
  }

  private async ask(connectionId: string, documentId: string, requests: LanguageLookupPath[]) {
    if (this.disposed || this.inFlight >= indexCompletionLimits.inFlight) return undefined
    this.inFlight++
    try {
      const result = await this.api.languageLookup({ connectionId, requests })
      if (this.disposed) return undefined
      this.failure(documentId, result.ok ? undefined : result.error)
      return result.ok ? result.value : undefined
    } catch (error) {
      this.failure(documentId, error instanceof Error ? error.message : 'The index could not answer.')
      return undefined
    } finally { this.inFlight-- }
  }

  private failure(documentId: string, error?: string): void {
    if (this.disposed || this.getSnapshot().errors.get(documentId) === error) return
    const errors = new Map(this.getSnapshot().errors)
    if (error) errors.set(documentId, error); else errors.delete(documentId)
    this.publish({ ...this.getSnapshot(), errors })
  }

  /** Drops the caches of connections gone or reconnected (a new generation), and the errors of closed tabs. */
  private reconcile(): void {
    if (this.disposed) return
    const live = new Set(this.connections.getSnapshot().filter(connection => isLiveConnection(connection) && isBigQueryConnection(connection)).map(cacheKey))
    for (const key of [...this.caches.keys()]) if (!live.has(key)) { this.caches.delete(key); this.ensured.delete(key) }
    const snapshot = this.getSnapshot()
    const errors = new Map([...snapshot.errors].filter(([id]) => this.documents.get(id)))
    const indexes = new Map([...snapshot.indexes].filter(([key]) => live.has(key)))
    if (errors.size !== snapshot.errors.size || indexes.size !== snapshot.indexes.size) this.publish({ errors, indexes })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.bindings.forEach(binding => binding.dispose())
    this.caches.clear()
    this.clearListeners()
  }
}

const cacheKey = (connection: { readonly id: string; readonly generation: number }) => `${connection.id}:${connection.generation}`

/** A pipeline item as Monaco shows it: its kind's icon and the typed word's ranges (insert up to the caret, replace the whole part). */
function suggestion(monaco: typeof Monaco, item: CompletionItem, range: { insert: Monaco.IRange; replace: Monaco.IRange }): Monaco.languages.CompletionItem {
  return {
    label: item.label, kind: monaco.languages.CompletionItemKind[kinds[item.kind]], insertText: item.insertText, detail: item.detail,
    documentation: item.documentation, sortText: item.sortText, filterText: item.filterText, range
  }
}
