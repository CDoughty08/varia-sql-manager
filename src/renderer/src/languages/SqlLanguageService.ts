import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { VariaApi } from '../../../shared/contracts'
import { languageLimits, type DatabaseProviderId, type LanguageContext, type LanguageRange, type LanguageRequest, type LanguageStatus } from '../../../shared/language-service'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { isQueryDocument } from '../documents'
import type { DocumentService } from '../services/documents'
import type { ConnectionService } from '../services/connections'
import type { BackendStateService } from '../services/backend'

type LanguageApi = Pick<VariaApi, 'languageStatus' | 'languageComplete' | 'languageHover' | 'languageClose' | 'languageRefresh'>
type CloseResult = Awaited<ReturnType<LanguageApi['languageClose']>>
type ActivityPhase = 'loading' | 'refreshing'
interface Snapshot { readonly status?: LanguageStatus; readonly checking: boolean; readonly error?: string; readonly cleanupError?: string; readonly documentErrors: ReadonlyMap<string, string>; readonly activities: ReadonlyMap<string, ActivityPhase> }
interface Capture { readonly request: LanguageRequest; readonly key: string; readonly epoch: number; readonly model: Monaco.editor.ITextModel }
interface PendingRequest { readonly token: Monaco.CancellationToken; readonly settled: Promise<void> }
interface RefreshWork { capture: Capture; readonly token: Monaco.CancellationToken; readonly cancel: () => void; work: Promise<boolean>; settled: Promise<void> }
const noCancellation: Monaco.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
const cleanupLimits = { requests: 4, attempts: 16, deadlineMs: 30_000, retryMs: 250, maxRetryMs: 2000 }
// LSP's CompletionItemKind numbering differs from Monaco's numbering.
const kindNames = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'] as const

/** One registration per workbench. Requests belong to models, never to the active editor or window. */
export class SqlLanguageService extends SnapshotStore<Snapshot> implements Disposable {
  private readonly bindings: Disposable[] = []
  private readonly used = new Set<string>()
  private readonly epochs = new Map<string, number>()
  private readonly contexts = new Map<string, string>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly inFlight = new Map<string, Set<Promise<unknown>>>()
  private readonly waiters = new Set<() => void>()
  private readonly closing = new Map<string, Promise<void>>()
  private readonly closeQueue: (() => void)[] = []
  private readonly urgentCloses: (() => void)[] = []
  private closeRequests = 0
  private readonly refreshing = new Map<string, RefreshWork>()
  private readonly activities = new Map<symbol, { capture: Capture; token: Monaco.CancellationToken; phase: ActivityPhase; visible: boolean }>()
  private disposed = false
  private statusSequence = 0
  private statusRequest?: Promise<void>
  private statusRetryAt = 0
  private statusWake?: () => void
  private backendEpoch = 0
  private backendState = ''
  private backendGeneration?: number
  constructor(monaco: typeof Monaco, private readonly api: LanguageApi,
    private readonly documents: DocumentService, private readonly connections: ConnectionService, backend?: BackendStateService) {
    super({ checking: false, documentErrors: new Map(), activities: new Map() })
    this.bindings.push(monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.'],
      provideCompletionItems: async (model, position, _context, token) => {
        const capture = this.capture(model, position)
        if (!capture || token.isCancellationRequested) return { suggestions: [] }
        if (!this.getSnapshot().status && !await this.waitFor(this.readStatus(), token)) return { suggestions: [] }
        if (!this.current(capture, token) || !this.supports(capture, 'completion')) return { suggestions: [] }
        const pending = this.begin(`${capture.request.documentId}:completion`, token)
        if (!pending) return { suggestions: [], incomplete: true }
        const activity = this.activity(capture, token, 'loading')
        try {
          if (pending.previous && !await this.waitFor(pending.previous, token)) return { suggestions: [] }
          const closing = this.closing.get(capture.request.documentId)
          if (closing && !await this.waitFor(closing, token)) return { suggestions: [] }
          const refreshing = this.refreshing.get(capture.request.documentId)
          if (refreshing && !await this.waitFor(refreshing.settled, token)) return { suggestions: [] }
          if (!this.current(capture, token)) return { suggestions: [] }
          this.used.add(capture.request.documentId)
          const result = await this.track(capture.request.documentId, api.languageComplete(capture.request))
          if (!this.current(capture, token)) return { suggestions: [] }
          if (!result.ok) { this.failure(capture.request.documentId, result.error); return { suggestions: [] } }
          this.failure(capture.request.documentId)
          const word = model.getWordUntilPosition(position)
          const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
          return {
            incomplete: result.value.isIncomplete,
            suggestions: result.value.items.flatMap(item => {
              const edit = item.textEdit
              if (edit && (!validRange(model, edit.range) || edit.range.start.line !== position.lineNumber - 1 ||
                edit.range.end.line !== position.lineNumber - 1 || edit.range.start.character > position.column - 1 || edit.range.end.character < position.column - 1)) return []
              return [{ label: item.label, kind: monaco.languages.CompletionItemKind[kindNames[(item.kind ?? 1) - 1] ?? 'Text'],
                detail: item.detail, documentation: item.documentation,
                insertText: edit?.newText ?? item.insertText ?? item.label,
                insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
                range: edit ? toMonacoRange(edit.range) : range }]
            })
          }
        } catch (error) {
          if (this.current(capture, token)) this.failure(capture.request.documentId, message(error))
          return { suggestions: [] }
        } finally { activity.dispose(); pending.finish() }
      }
    }), monaco.languages.registerHoverProvider('sql', {
      provideHover: async (model, position, token) => {
        const capture = this.capture(model, position)
        if (!capture || token.isCancellationRequested) return null
        if (!this.getSnapshot().status && !await this.waitFor(this.readStatus(), token)) return null
        if (!this.current(capture, token) || !this.supports(capture, 'hover')) return null
        const pending = this.begin(`${capture.request.documentId}:hover`, token)
        if (!pending) return null
        const activity = this.activity(capture, token, 'loading')
        try {
          if (pending.previous && !await this.waitFor(pending.previous, token)) return null
          const closing = this.closing.get(capture.request.documentId)
          if (closing && !await this.waitFor(closing, token)) return null
          const refreshing = this.refreshing.get(capture.request.documentId)
          if (refreshing && !await this.waitFor(refreshing.settled, token)) return null
          if (!this.current(capture, token)) return null
          this.used.add(capture.request.documentId)
          const result = await this.track(capture.request.documentId, api.languageHover(capture.request))
          if (!this.current(capture, token)) return null
          if (!result.ok) { this.failure(capture.request.documentId, result.error); return null }
          this.failure(capture.request.documentId)
          const hover = result.value
          if (!hover || (hover.range && !validRange(model, hover.range))) return null
          return { contents: [{ value: hover.contents, isTrusted: false, supportHtml: false }], range: hover.range ? toMonacoRange(hover.range) : undefined }
        } catch (error) {
          if (this.current(capture, token)) this.failure(capture.request.documentId, message(error))
          return null
        } finally { activity.dispose(); pending.finish() }
      }
    }))
    const reconcile = () => this.reconcile()
    this.bindings.push({ dispose: documents.subscribe(reconcile) }, { dispose: connections.subscribe(reconcile) })
    if (backend) {
      const changed = () => {
        const state = backend.getSnapshot().state, key = `${state.status}:${'generation' in state ? state.generation : ''}`
        if (key === this.backendState) return
        this.backendState = key
        const generation = 'generation' in state ? state.generation : state.status === 'failed' ? state.lost?.generation : undefined
        if (generation !== undefined) {
          if (this.backendGeneration !== undefined && generation !== this.backendGeneration && this.getSnapshot().cleanupError)
            this.publish({ ...this.getSnapshot(), cleanupError: undefined })
          this.backendGeneration = generation
        }
        this.backendEpoch++
        this.statusSequence++
        this.statusRequest = undefined
        this.statusRetryAt = 0
        this.statusWake?.()
        for (const refresh of this.refreshing.values()) refresh.cancel()
        for (const id of this.contexts.keys()) this.syncActivity(id)
        if (state.status === 'ready') void this.refresh()
      }
      this.bindings.push({ dispose: backend.subscribe(changed) })
      changed()
    }
    void this.refresh()
  }
  /** Configuration is read by the backend. Paths and credentials never cross to Monaco. */
  refresh(): Promise<void> { return this.readStatus(true) }
  private readStatus(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.statusRequest) { if (force) this.statusWake?.(); return this.statusRequest }
    const sequence = ++this.statusSequence
    this.publish({ ...this.getSnapshot(), checking: true })
    const delay = force ? 0 : Math.max(0, this.statusRetryAt - Date.now())
    const ready = delay ? new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); if (this.statusWake === wake) this.statusWake = undefined; resolve() }
      const timer = setTimeout(wake, delay)
      this.statusWake = wake
    }) : Promise.resolve()
    const request = ready.then(async () => {
      if (this.disposed || sequence !== this.statusSequence) return
      try {
        const result = await this.api.languageStatus()
        if (this.disposed || sequence !== this.statusSequence) return
        this.statusRetryAt = result.ok ? 0 : Date.now() + 1000
        this.publish({ ...this.getSnapshot(), checking: false, status: result.ok ? result.value : undefined, error: result.ok ? undefined : result.error })
      } catch (error) {
        if (!this.disposed && sequence === this.statusSequence) {
          this.statusRetryAt = Date.now() + 1000
          this.publish({ ...this.getSnapshot(), checking: false, status: undefined, error: message(error) })
        }
      }
    })
    this.statusRequest = request
    void request.then(() => { if (this.statusRequest === request) this.statusRequest = undefined })
    return request
  }
  /** Refresh metadata for one query, without changing its SQL or execution session. Repeated invocations share the work. */
  async refreshCache(documentId = this.documents.getSnapshot().activeId, token: Monaco.CancellationToken = noCancellation): Promise<boolean> {
    if (this.disposed || token.isCancellationRequested) return false
    const document = this.documents.get(documentId), model = this.documents.getModel(documentId)
    if (!document || !isQueryDocument(document) || !model) throw new Error('Open a SQL query to refresh IntelliSense.')
    if (model.getValueLength() > languageLimits.documentCharacters) throw new Error('This query is too large for SQL language support.')
    if (!document.connectionId || !this.connections.isLive(document.connectionId)) throw new Error('Connect this query to a live database before refreshing IntelliSense.')
    const capture = this.capture(model, { lineNumber: 1, column: 1 } as Monaco.Position)
    if (!capture) throw new Error('The query is unavailable for SQL language support.')
    const previous = this.refreshing.get(documentId)
    if (previous && this.current(previous.capture, previous.token)) {
      if (!await this.waitFor(previous.settled, token)) return false
      return previous.work
    }
    const controller = new AbortController(), actionToken = cancellationToken(controller.signal)
    const external = token.onCancellationRequested(() => controller.abort())
    const content = model.onDidChangeContent(() => controller.abort())
    const cleanup = () => { external.dispose(); content.dispose(); controller.signal.removeEventListener('abort', cleanup) }
    controller.signal.addEventListener('abort', cleanup, { once: true })
    if (token.isCancellationRequested) controller.abort()
    const pending = this.begin(`${documentId}:refresh`, actionToken)
    if (!pending) { cleanup(); throw new Error('IntelliSense is busy. Try refreshing again when the current requests finish.') }
    const refresh: RefreshWork = { capture, token: actionToken, cancel: () => controller.abort(), work: Promise.resolve(false), settled: Promise.resolve() }
    this.refreshing.set(documentId, refresh)
    refresh.work = Promise.resolve().then(async () => {
      let activity: Disposable | undefined
      try {
        if (pending.previous && !await this.waitFor(pending.previous, actionToken)) return false
        if (!this.getSnapshot().status && !await this.waitFor(this.refresh(), actionToken)) return false
        if (!this.current(refresh.capture, actionToken)) return false
        if (!this.supports(refresh.capture, 'refresh')) {
          const snapshot = this.getSnapshot(), provider = snapshot.status?.providers.find(provider => provider.id === capture.request.context.providerId)
          throw new Error(snapshot.error ?? provider?.reason ?? 'This language provider does not support refreshing its local cache.')
        }
        this.epochs.set(documentId, (this.epochs.get(documentId) ?? 0) + 1)
        refresh.capture = { ...capture, epoch: this.backendEpoch + (this.epochs.get(documentId) ?? 0) }
        this.failure(documentId)
        activity = this.activity(refresh.capture, actionToken, 'refreshing')
        const closing = this.closing.get(documentId)
        if (closing && !await this.waitFor(closing, actionToken)) return false
        if (!this.current(refresh.capture, actionToken)) return false
        const { version, text, context } = refresh.capture.request
        this.used.add(documentId)
        const result = await this.track(documentId, this.api.languageRefresh({ documentId, version, text, context }))
        if (!this.current(refresh.capture, actionToken)) return false
        if (!result.ok) throw new Error(result.error)
        this.failure(documentId)
        return result.value.refreshed
      } catch (error) {
        if (!this.current(refresh.capture, actionToken)) return false
        this.failure(documentId, message(error))
        throw error
      } finally {
        activity?.dispose(); pending.finish(); cleanup()
        if (this.refreshing.get(documentId) === refresh) this.refreshing.delete(documentId)
      }
    })
    // Keep the serialization barrier until actual IPC settles, even when the user or document cancels its wait early.
    refresh.settled = refresh.work.then(() => {}, () => {})
    if (!await this.waitFor(refresh.settled, actionToken)) return false
    return refresh.work
  }
  /** A small status-bar label with an actionable explanation in its tooltip. */
  availability(documentId: string): { label: string; detail: string } {
    const document = this.documents.get(documentId), connection = document?.connectionId ? this.connections.get(document.connectionId) : undefined
    const id: DatabaseProviderId = connection?.providerId ?? 'sqlserver', snapshot = this.getSnapshot()
    const activity = snapshot.activities.get(documentId)
    if (activity === 'refreshing') return { label: 'IntelliSense refreshing', detail: 'Refreshing schema suggestions for this query’s connection and database.' }
    if (activity === 'loading') return { label: 'IntelliSense loading', detail: 'Loading SQL language information for this query.' }
    if (snapshot.checking && !snapshot.status) return { label: 'IntelliSense starting', detail: 'Checking the SQL language provider.' }
    const error = snapshot.cleanupError ?? snapshot.documentErrors.get(documentId) ?? snapshot.error
    if (error) return { label: 'IntelliSense unavailable', detail: error }
    const provider = snapshot.status?.providers.find(provider => provider.id === id)
    if (!snapshot.status) return { label: 'IntelliSense starting', detail: 'Checking the SQL language provider.' }
    if (!provider?.configured) return { label: 'IntelliSense off', detail: provider?.reason ?? `The ${id} language provider is not configured.` }
    if ((this.documents.getModel(documentId)?.getValueLength() ?? 0) > languageLimits.documentCharacters)
      return { label: 'IntelliSense paused', detail: `Language support is available for queries up to ${languageLimits.documentCharacters.toLocaleString()} characters.` }
    if (connection?.lost) return { label: 'IntelliSense disconnected', detail: 'Reconnect this query to restore schema suggestions.' }
    return { label: 'IntelliSense', detail: document?.connectionId ? 'SQL completion and hover use this query’s connection and database. Ctrl+Space opens suggestions.' : 'SQL completion and hover are available. Connect this query for schema suggestions. Ctrl+Space opens suggestions.' }
  }
  private context(documentId: string): { context: LanguageContext; key: string } | undefined {
    const document = this.documents.get(documentId)
    if (!isQueryDocument(document) || !document) return
    const connection = document.connectionId ? this.connections.get(document.connectionId) : undefined
    if (document.connectionId && (!connection || connection.lost)) return
    const context: LanguageContext = { providerId: connection?.providerId ?? 'sqlserver',
      ...connection ? { connectionId: connection.id } : {}, ...document.database ? { database: document.database } : {} }
    return { context, key: JSON.stringify([context, connection?.generation ?? 0]) }
  }
  private capture(model: Monaco.editor.ITextModel, position: Monaco.Position): Capture | undefined {
    if (this.disposed || model.getLanguageId() !== 'sql' || model.getValueLength() > languageLimits.documentCharacters) return
    const document = this.documents.getSnapshot().documents.find(document => this.documents.getModel(document.id) === model)
    if (!document) return
    const context = this.context(document.id)
    if (!context) return
    this.contexts.set(document.id, context.key)
    return { model, key: context.key, epoch: this.backendEpoch + (this.epochs.get(document.id) ?? 0), request: {
      documentId: document.id, version: model.getVersionId(), text: model.getValue(), context: context.context,
      position: { line: position.lineNumber - 1, character: position.column - 1 }
    } }
  }
  private supports(capture: Capture, feature: 'completion' | 'hover' | 'refresh'): boolean {
    const provider = this.getSnapshot().status?.providers.find(provider => provider.id === capture.request.context.providerId)
    return !!provider?.configured && !!provider[feature]
  }
  private activity(capture: Capture, token: Monaco.CancellationToken, phase: ActivityPhase): Disposable {
    const id = Symbol(), documentId = capture.request.documentId
    const activity = { capture, token, phase, visible: phase === 'refreshing' }
    this.activities.set(id, activity)
    const show = () => { activity.visible = true; this.syncActivity(documentId) }
    const timer = phase === 'loading' ? setTimeout(show, 150) : undefined
    const cancellation = token.onCancellationRequested(() => this.syncActivity(documentId))
    if (activity.visible) this.syncActivity(documentId)
    return { dispose: () => { clearTimeout(timer); cancellation.dispose(); this.activities.delete(id); this.syncActivity(documentId) } }
  }
  private syncActivity(documentId: string): void {
    if (this.disposed) return
    const active = [...this.activities.values()].filter(activity => activity.capture.request.documentId === documentId && activity.visible && this.current(activity.capture, activity.token))
    const phase = active.some(activity => activity.phase === 'refreshing') ? 'refreshing' : active.length ? 'loading' : undefined
    if (this.getSnapshot().activities.get(documentId) === phase) return
    const activities = new Map(this.getSnapshot().activities)
    if (phase) activities.set(documentId, phase); else activities.delete(documentId)
    this.publish({ ...this.getSnapshot(), activities })
  }
  private current(capture: Capture, token: Monaco.CancellationToken): boolean {
    const id = capture.request.documentId
    return !this.disposed && !token.isCancellationRequested && this.documents.getModel(id) === capture.model &&
      capture.model.getVersionId() === capture.request.version && this.context(id)?.key === capture.key &&
      this.backendEpoch + (this.epochs.get(id) ?? 0) === capture.epoch
  }
  /** Keep canceled IPC work in the barrier until it really settles, so only its latest successor reaches the backend. */
  private begin(key: string, token: Monaco.CancellationToken): { previous?: Promise<void>; finish: () => void } | undefined {
    const previous = this.pending.get(key)
    if (previous ? !previous.token.isCancellationRequested : this.pending.size >= 8) return
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const settled = previous ? Promise.all([previous.settled, done]).then(() => {}) : done
    const request: PendingRequest = { token, settled }
    this.pending.set(key, request)
    void settled.then(() => { if (this.pending.get(key) === request) this.pending.delete(key) })
    return { previous: previous?.settled, finish }
  }
  /** Cancellation ends the editor's wait without removing the predecessor's actual in-flight work from its barrier. */
  private waitFor(work: Promise<void>, token: Monaco.CancellationToken): Promise<boolean> {
    if (this.disposed || token.isCancellationRequested) return Promise.resolve(false)
    return new Promise(resolve => {
      let finished = false, subscription: Disposable | undefined
      const finish = (ready: boolean) => {
        if (finished) return
        finished = true
        subscription?.dispose()
        this.waiters.delete(cancel)
        resolve(ready && !this.disposed && !token.isCancellationRequested)
      }
      const cancel = () => finish(false)
      this.waiters.add(cancel)
      subscription = token.onCancellationRequested(cancel)
      if (finished) subscription.dispose()
      if (this.disposed || token.isCancellationRequested) cancel()
      void work.then(() => finish(true), () => finish(false))
    })
  }
  private reconcile(): void {
    for (const [id, key] of this.contexts) {
      const next = this.context(id)?.key ?? ''
      if (next === key && this.documents.get(id)) continue
      this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
      this.refreshing.get(id)?.cancel()
      this.syncActivity(id)
      if (this.documents.get(id)) this.contexts.set(id, next)
      else this.contexts.delete(id)
      this.failure(id)
      if (this.used.delete(id)) this.close(id)
      if (!this.documents.get(id)) {
        this.epochs.delete(id)
      }
    }
  }
  private close(id: string): void {
    const previous = this.closing.get(id)
    const inFlight = [...this.inFlight.get(id) ?? []]
    const generation = this.backendGeneration
    const cleanup = async () => {
      await this.closeRemote(id, generation, inFlight.length > 0)
      if (inFlight.length) {
        // Control-lane close may pass a language request still waiting for metadata dispatch. Close again after it
        // settles, keeping new-context requests behind this barrier so cleanup cannot close their replacement binding.
        await Promise.allSettled(inFlight)
        await this.closeRemote(id, generation)
      }
    }
    const pending = previous ? previous.then(cleanup) : cleanup()
    this.closing.set(id, pending)
    void pending.finally(() => { if (this.closing.get(id) === pending) this.closing.delete(id) })
  }
  private async closeRemote(id: string, generation: number | undefined, urgent = false): Promise<void> {
    const deadline = Date.now() + cleanupLimits.deadlineMs
    const exhausted = () => this.publish({ ...this.getSnapshot(), cleanupError: 'Some IntelliSense connections could not close because the SQL backend stayed busy. Restart SQL Backend when it is safe to stop queries and end their sessions.' })
    for (let attempt = 0; ; attempt++) {
      if (generation !== this.backendGeneration) return
      const result = await this.closeAttempt(id, generation, urgent && attempt === 0, attempt ? deadline : undefined)
      if (generation !== this.backendGeneration) return
      if (result === 'expired') { exhausted(); return }
      // Only this main-process refusal proves the request was never dispatched. A timeout may already be cleaning up.
      if (!result || result.ok || result.code !== 'TOO_MANY_REQUESTS') return
      const delay = Math.min(cleanupLimits.retryMs * 2 ** attempt, cleanupLimits.maxRetryMs, deadline - Date.now())
      if (attempt + 1 >= cleanupLimits.attempts || delay <= 0) {
        exhausted()
        return
      }
      await new Promise<void>(resolve => { setTimeout(resolve, delay) })
    }
  }
  private closeAttempt(id: string, generation: number | undefined, urgent: boolean, deadline?: number): Promise<CloseResult | 'expired' | undefined> {
    return new Promise(resolve => {
      const finish = (result?: CloseResult | 'expired') => { this.closeRequests--; resolve(result); this.drainCloseQueue() }
      const run = () => {
        this.closeRequests++
        if (generation !== this.backendGeneration) { finish(); return }
        if (deadline !== undefined && Date.now() >= deadline) { finish('expired'); return }
        try { void this.api.languageClose(id).then(finish, () => finish()) }
        catch { finish() }
      }
      const queue = urgent ? this.urgentCloses : this.closeQueue
      queue.push(run)
      this.drainCloseQueue()
    })
  }
  private drainCloseQueue(): void {
    while (this.closeRequests < cleanupLimits.requests) {
      const next = this.urgentCloses.shift() ?? this.closeQueue.shift()
      if (!next) break
      next()
    }
  }
  private track<T>(id: string, work: Promise<T>): Promise<T> {
    let inFlight = this.inFlight.get(id)
    if (!inFlight) this.inFlight.set(id, inFlight = new Set())
    inFlight.add(work)
    const settled = () => { inFlight.delete(work); if (!inFlight.size) this.inFlight.delete(id) }
    void work.then(settled, settled)
    return work
  }
  private failure(id: string, error?: string): void {
    if (this.disposed || this.getSnapshot().documentErrors.get(id) === error) return
    const errors = new Map(this.getSnapshot().documentErrors)
    if (error) errors.set(id, error); else errors.delete(id)
    this.publish({ ...this.getSnapshot(), documentErrors: errors })
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.statusSequence++
    this.statusWake?.()
    this.statusRequest = undefined
    for (const refresh of this.refreshing.values()) refresh.cancel()
    for (const cancel of this.waiters) cancel()
    this.refreshing.clear(); this.activities.clear()
    this.pending.clear()
    this.bindings.forEach(binding => binding.dispose())
    for (const id of this.used) this.close(id)
    this.used.clear(); this.contexts.clear(); this.epochs.clear(); this.clearListeners()
    this.publish({ ...this.getSnapshot(), checking: false, activities: new Map() })
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : 'The SQL language provider could not answer.' }
function cancellationToken(signal: AbortSignal): Monaco.CancellationToken {
  return { get isCancellationRequested() { return signal.aborted }, onCancellationRequested: listener => {
    const cancel = () => listener(undefined)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    return { dispose: () => { signal.removeEventListener('abort', cancel) } }
  } }
}
function validRange(model: Monaco.editor.ITextModel, range: LanguageRange): boolean {
  const { start, end } = range
  return start.line <= end.line && (start.line !== end.line || start.character <= end.character) &&
    start.line >= 0 && end.line < model.getLineCount() && start.character >= 0 && end.character >= 0 &&
    start.character < model.getLineMaxColumn(start.line + 1) && end.character < model.getLineMaxColumn(end.line + 1)
}
function toMonacoRange(range: LanguageRange): Monaco.IRange {
  return { startLineNumber: range.start.line + 1, startColumn: range.start.character + 1, endLineNumber: range.end.line + 1, endColumn: range.end.character + 1 }
}
