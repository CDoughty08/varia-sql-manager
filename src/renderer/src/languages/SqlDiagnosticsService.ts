import type * as Monaco from 'monaco-editor'
import { languageLimits, type LanguageDiagnostic } from '../../../shared/language-service'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { isQueryDocument } from '../documents'
import type { DocumentService } from '../services/documents'
import type { ConnectionService } from '../services/connections'
import type { BackendStateService } from '../services/backend'
import type { SqlLanguageService } from './SqlLanguageService'

export const sqlDiagnosticOwner = 'varia.sql.diagnostics'
export const sqlDiagnosticDebounceMs = 500
interface IssueState {
  readonly phase: 'checking' | 'ready' | 'paused' | 'unavailable'
  readonly errors: number
  readonly warnings: number
  readonly isIncomplete?: boolean
  readonly detail?: string
}
interface Snapshot { readonly documents: ReadonlyMap<string, IssueState> }
type Language = Pick<SqlLanguageService, 'diagnostics' | 'diagnosticsEpoch' | 'subscribe' | 'getSnapshot' | 'availability'>
type Settings = { enabled(): boolean; subscribe(listener: () => void): () => void }
type MarkerMonaco = Pick<typeof Monaco, 'MarkerSeverity'> & { editor: Pick<typeof Monaco.editor, 'setModelMarkers'> }
interface Entry {
  readonly id: string
  readonly model: Monaco.editor.ITextModel
  readonly content: Disposable
  key: string
  revision: number
  timer?: ReturnType<typeof setTimeout>
  controller?: AbortController
  running?: Promise<void>
}

/** One debounced analysis per model, bounded concurrency, and markers owned only by this workbench's queries. */
export class SqlDiagnosticsService extends SnapshotStore<Snapshot> implements Disposable {
  private readonly entries = new Map<string, Entry>()
  private readonly subscriptions: (() => void)[] = []
  private readonly queue: Entry[] = []
  private active = 0
  private disposed = false
  constructor(private readonly monaco: MarkerMonaco, private readonly language: Language,
    private readonly documents: DocumentService, private readonly connections: ConnectionService,
    private readonly settings: Settings, private readonly backend?: Pick<BackendStateService, 'getSnapshot' | 'subscribe'>) {
    super({ documents: new Map() })
    const reconcile = () => this.reconcile()
    this.subscriptions.push(documents.subscribe(reconcile), connections.subscribe(reconcile), language.subscribe(reconcile), settings.subscribe(reconcile))
    if (backend) this.subscriptions.push(backend.subscribe(reconcile))
    this.reconcile()
  }
  private reconcile(): void {
    if (this.disposed) return
    const open = new Set<string>()
    const snapshot = this.documents.getSnapshot()
    const candidates = [...snapshot.documents].sort((a, b) => Number(b.id === snapshot.activeId) - Number(a.id === snapshot.activeId))
    for (const document of candidates) {
      const model = this.documents.getModel(document.id)
      if (!isQueryDocument(document) || !model || model.isDisposed() || model.getLanguageId() !== 'sql') continue
      if (open.size >= 128) continue
      open.add(document.id)
      let entry = this.entries.get(document.id)
      if (entry?.model !== model) {
        if (entry) this.remove(entry)
        const id = document.id
        entry = { id, model, key: '', revision: 0, content: model.onDidChangeContent(() => {
          const current = this.entries.get(id)
          if (current?.model === model) this.invalidate(current, true)
        }) }
        this.entries.set(id, entry)
      }
      const connection = document.connectionId ? this.connections.get(document.connectionId) : undefined
      const backend = this.backend?.getSnapshot().state
      const key = JSON.stringify([document.connectionId, document.database, connection?.providerId, connection?.generation, connection?.lost,
        this.settings.enabled(), backend?.status, backend && 'generation' in backend ? backend.generation : undefined, this.language.diagnosticsEpoch(document.id),
        this.language.getSnapshot().activities.get(document.id) === 'refreshing',
        this.language.getSnapshot().status?.providers.find(provider => provider.id === (connection?.providerId ?? 'sqlserver'))])
      if (entry.key !== key) { entry.key = key; this.invalidate(entry, false) }
    }
    for (const entry of this.entries.values()) if (!open.has(entry.id)) this.remove(entry)
  }
  private paused(entry: Entry): string | undefined {
    if (!this.settings.enabled()) return 'SQL error checking is disabled in Options.'
    if (entry.model.getValueLength() > languageLimits.documentCharacters) return `SQL analysis is limited to ${languageLimits.documentCharacters.toLocaleString()} characters.`
    const document = this.documents.get(entry.id)
    if (!document) return 'This query has closed.'
    if (document.connectionId && !this.connections.isLive(document.connectionId)) return 'Reconnect this query to restore SQL analysis.'
    if (this.backend && this.backend.getSnapshot().state.status !== 'ready') return 'SQL analysis will resume when the backend is ready.'
    if (this.language.getSnapshot().activities.get(entry.id) === 'refreshing') return 'SQL analysis will resume after the IntelliSense cache refresh.'
    const connection = document.connectionId ? this.connections.get(document.connectionId) : undefined
    const provider = this.language.getSnapshot().status?.providers.find(value => value.id === (connection?.providerId ?? 'sqlserver'))
    if (provider && (!provider.configured || !provider.diagnostics)) return provider.reason ?? 'This language provider does not support SQL analysis.'
    return
  }
  private invalidate(entry: Entry, edited: boolean): void {
    entry.revision++
    entry.controller?.abort()
    clearTimeout(entry.timer)
    entry.timer = undefined
    this.dequeue(entry)
    this.clearMarkers(entry)
    const detail = this.paused(entry)
    this.put(entry.id, { phase: detail ? 'paused' : 'checking', errors: 0, warnings: 0, ...detail ? { detail } : {} })
    if (detail || !entry.model.getValue().trim()) {
      if (!detail) this.put(entry.id, { phase: 'ready', errors: 0, warnings: 0 })
      return
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (this.disposed || this.entries.get(entry.id) !== entry) return
      if (edited || this.documents.getSnapshot().activeId === entry.id) this.queue.unshift(entry)
      else this.queue.push(entry)
      this.pump()
    }, sqlDiagnosticDebounceMs)
  }
  private pump(): void {
    if (this.disposed) return
    for (let at = 0; at < this.queue.length && this.active < 2;) {
      const entry = this.queue[at]
      if (entry.running) { at++; continue }
      this.queue.splice(at, 1)
      if (this.entries.get(entry.id) !== entry || entry.model.isDisposed()) continue
      const revision = entry.revision, version = entry.model.getVersionId(), key = entry.key
      const controller = new AbortController()
      entry.controller = controller
      const token: Monaco.CancellationToken = {
        get isCancellationRequested() { return controller.signal.aborted },
        onCancellationRequested: listener => {
          const cancel = () => listener(undefined)
          controller.signal.addEventListener('abort', cancel, { once: true })
          return { dispose: () => controller.signal.removeEventListener('abort', cancel) }
        }
      }
      this.active++
      const current = () => !this.disposed && !controller.signal.aborted && this.entries.get(entry.id) === entry &&
        !entry.model.isDisposed() && entry.revision === revision && entry.key === key && entry.model.getVersionId() === version
      entry.running = Promise.resolve().then(async () => {
        try {
          const result = await this.language.diagnostics(entry.model, token)
          if (!current()) return
          if (!result || result.version !== version) {
            this.put(entry.id, { phase: 'unavailable', errors: 0, warnings: 0, detail: this.language.availability(entry.id).detail })
            return
          }
          const markers = result.items.flatMap(item => marker(this.monaco, entry.model, item, version))
          this.monaco.editor.setModelMarkers(entry.model, sqlDiagnosticOwner, markers)
          this.put(entry.id, { phase: 'ready', errors: markers.filter(value => value.severity === this.monaco.MarkerSeverity.Error).length,
            warnings: markers.filter(value => value.severity === this.monaco.MarkerSeverity.Warning).length,
            isIncomplete: result.isIncomplete || markers.length !== result.items.length })
        } catch (error) {
          if (current()) this.put(entry.id, { phase: 'unavailable', errors: 0, warnings: 0,
            detail: error instanceof Error ? error.message : 'SQL analysis could not complete. Edit the query or refresh IntelliSense to try again.' })
        }
      }).finally(() => {
        if (entry.controller === controller) entry.controller = undefined
        entry.running = undefined
        this.active--
        this.pump()
      })
    }
  }
  private put(id: string, value: IssueState): void {
    const documents = new Map(this.getSnapshot().documents)
    documents.set(id, value)
    this.publish({ documents })
  }
  private clearMarkers(entry: Entry): void { if (!entry.model.isDisposed()) this.monaco.editor.setModelMarkers(entry.model, sqlDiagnosticOwner, []) }
  private dequeue(entry: Entry): void { for (let at = this.queue.length - 1; at >= 0; at--) if (this.queue[at] === entry) this.queue.splice(at, 1) }
  private remove(entry: Entry): void {
    this.entries.delete(entry.id)
    clearTimeout(entry.timer)
    entry.controller?.abort()
    entry.content.dispose()
    this.dequeue(entry)
    this.clearMarkers(entry)
    const documents = new Map(this.getSnapshot().documents)
    documents.delete(entry.id)
    this.publish({ documents })
  }
  status(id: string): { label: string; detail: string } | undefined {
    const value = this.getSnapshot().documents.get(id)
    if (!value) return
    if (value.phase === 'paused') return { label: 'SQL analysis paused', detail: value.detail ?? '' }
    if (value.phase === 'unavailable') return { label: 'SQL analysis unavailable', detail: value.detail ?? '' }
    if (value.phase === 'checking') return { label: 'Checking SQL', detail: 'Checking this query for syntax and database object issues.' }
    const labels = [value.errors ? `${value.errors} error${value.errors === 1 ? '' : 's'}` : '', value.warnings ? `${value.warnings} warning${value.warnings === 1 ? '' : 's'}` : ''].filter(Boolean)
    return { label: labels.length ? `SQL: ${labels.join(', ')}` : value.isIncomplete ? 'SQL analysis incomplete' : 'SQL: no issues',
      detail: `${value.isIncomplete ? 'Some SQL issues could not be shown. ' : ''}Alt+F8 goes to the next issue; Alt+Shift+F8 goes to the previous issue. Analysis does not execute the query.` }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.subscriptions.forEach(unsubscribe => unsubscribe())
    for (const entry of this.entries.values()) this.remove(entry)
    this.queue.length = 0
    this.clearListeners()
  }
}

function marker(monaco: MarkerMonaco, model: Monaco.editor.ITextModel, item: LanguageDiagnostic, version: number): Monaco.editor.IMarkerData[] {
  const { start, end } = item.range
  if (start.line < 0 || end.line < start.line || end.line >= model.getLineCount() || start.character < 0 || end.character < 0 ||
    start.character > model.getLineMaxColumn(start.line + 1) - 1 || end.character > model.getLineMaxColumn(end.line + 1) - 1 ||
    start.line === end.line && end.character < start.character) return []
  const severity = [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint][item.severity - 1]
  if (!severity) return []
  return [{ startLineNumber: start.line + 1, startColumn: start.character + 1, endLineNumber: end.line + 1, endColumn: end.character + 1,
    message: item.message, severity, modelVersionId: version, ...item.code ? { code: item.code } : {}, source: item.source }]
}
