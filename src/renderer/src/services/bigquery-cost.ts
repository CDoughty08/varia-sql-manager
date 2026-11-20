import type * as Monaco from 'monaco-editor'
import type { ApiResult, BigQueryConnectionOptions, VariaApi } from '../../../shared/contracts'
import { connectionKey } from '../../../shared/connections'
import { costPrompt, dryRunLimits, errorPosition, gibibytes, type BigQueryDryRunResult, type CostPrompt, type IncompleteReason } from '../../../shared/bigquery/dry-run'
import type { SettingKey, SettingValue } from '../../../shared/settings/catalog'
import { SnapshotStore } from '../core/store'
import type { EventBus } from '../core/events'
import type { Disposable } from '../core/types'
import { isQueryDocument } from '../documents'
import type { DocumentService } from './documents'
import type { ConnectionService, LiveConnection } from './connections'
import { isBigQueryConnection } from './connection-availability'

export const dryRunMarkerOwner = 'varia.googlesql.dryRun'
/** The editing pause before a diagnostics dry run (docs/bigquery-plan.md, IntelliSense from the index). */
export const dryRunDebounceMs = 1000

/**
 * A BigQuery tab's estimate as the chip beside Execute shows it: being worked out, a dry run's figure (with why it may be
 * low), what the last run processed, a query BigQuery refused (its error is marked in the editor), or no estimate and why.
 */
export type EstimateState =
  | { readonly phase: 'checking' }
  | { readonly phase: 'estimate'; readonly bytes: number; readonly incomplete?: IncompleteReason; readonly faked?: true }
  | { readonly phase: 'ran'; readonly bytes: number }
  | { readonly phase: 'refused'; readonly message: string }
  | { readonly phase: 'unavailable'; readonly message: string }
export type EstimateSnapshot = ReadonlyMap<string, EstimateState>

/** What a cost prompt shows, and how the user answered. */
export interface CostPromptRequest {
  readonly prompt: CostPrompt
  /** The connection's name, for "Don't ask again for this connection". */
  readonly connection: string
  /** The cap the job will carry (the connection's, else Options'), in bytes. */
  readonly cap?: number
  readonly thresholdBytes: number
  readonly prices: boolean
}
export interface CostPromptAnswer { readonly run: boolean; readonly dontAskAgain?: boolean }

/** Where "Don't ask again for this connection" is kept. */
export interface CostOptOut {
  /** Whether the threshold prompt asks on this connection, as last read. */
  asks(connection: LiveConnection): boolean
  /** Reads the connection's saved choice again. */
  refresh(connection: LiveConnection): Promise<void>
  dontAsk(connection: LiveConnection): Promise<void>
}

/**
 * "Don't ask again for this connection" as `costPrompt: false` on the saved BigQuery connection (bigquery-connections.json),
 * found by its entry key, so a reconnect or restart keeps it; the connection's Advanced Properties turn the prompt back on.
 * `changed` runs when a choice is read or made, so the chip can follow it.
 */
export function costOptOut(api: Pick<VariaApi, 'loadConnectionLibrary' | 'setBigQueryCostPrompt'>, changed: () => void = () => {}): CostOptOut {
  const declined = new Map<string, boolean>()
  // Choices made here whose write has not landed, or failed: a read of the saved entries does not undo them this session.
  const local = new Set<string>()
  const key = (connection: LiveConnection) => {
    try { return connection.options.provider === 'bigquery' ? connectionKey(connection.options) : undefined } catch { return undefined }
  }
  const set = (entry: string, value: boolean) => { if (declined.get(entry) !== value) { declined.set(entry, value); changed() } }
  return {
    asks: connection => { const entry = key(connection); return entry === undefined || !declined.get(entry) },
    async refresh(connection) {
      const entry = key(connection)
      if (entry === undefined) return
      try {
        const loaded = await api.loadConnectionLibrary()
        if (!loaded.ok) return
        // Entries with the same settings are one connection: the choice applies to them all (the store writes them alike).
        const profiles = loaded.value.bigQuery.profiles.filter(item => { try { return connectionKey(item.options) === entry } catch { return false } })
        if (!local.has(entry)) set(entry, profiles.some(item => item.options.costPrompt === false))
      } catch { /* The last choice read stands. */ }
    },
    async dontAsk(connection) {
      const entry = key(connection)
      if (entry === undefined || connection.options.provider !== 'bigquery') return
      set(entry, true)
      local.add(entry)
      const options: BigQueryConnectionOptions = connection.options
      // Saved where a reconnect finds it; if the write fails, the choice still holds until the app closes.
      let saved = false
      try { const result = await api.setBigQueryCostPrompt({ options, costPrompt: false }); saved = result.ok && result.value } catch { /* As above. */ }
      if (saved) local.delete(entry)
    }
  }
}

type Settings = { get<K extends SettingKey>(key: K): SettingValue<K>; subscribe(listener: () => void): () => void; choose<K extends SettingKey>(key: K, value: SettingValue<K>): Promise<void> }
type MarkerMonaco = Pick<typeof Monaco, 'MarkerSeverity'> & { editor: Pick<typeof Monaco.editor, 'setModelMarkers'> }
interface Entry {
  readonly id: string
  readonly model: Monaco.editor.ITextModel
  readonly content: Disposable
  /** The connection and dataset the tab had when last seen: a change clears its estimate and markers. */
  key: string
  timer?: ReturnType<typeof setTimeout>
  /** The dry run in flight (one per document); `again` asks for another once it settles, since the text changed. */
  running?: Promise<void>
  again?: boolean
  /** Bumped by every edit, context change and execution: a dry run's answer for an older revision is dropped. */
  revision: number
  /** The text and dataset the current estimate is for, so Execute reuses it instead of dry-running the same text again. */
  estimated?: { readonly sql: string; readonly dataset?: string; readonly result: BigQueryDryRunResult }
  /** The incomplete-estimate prompt asks once per tab (decision 22). */
  warnedIncomplete?: boolean
  /** The revision Execute last ran: a run that finishes after an edit leaves the newer state alone. */
  executed?: number
  /** The connection (id and generation) whose saved prompt choice was read. */
  read?: string
}

export interface BigQueryCostDeps {
  readonly api: Pick<VariaApi, 'bigQueryDryRun'>
  readonly documents: Pick<DocumentService, 'get' | 'getModel' | 'getSnapshot' | 'subscribe'>
  readonly connections: Pick<ConnectionService, 'get' | 'isLive' | 'subscribe'>
  readonly settings: Settings
  readonly events: Pick<EventBus, 'subscribe'>
  readonly monaco: MarkerMonaco
  /** Shows a cost prompt (BigQueryCostPrompt) and resolves with the answer. */
  readonly ask: (request: CostPromptRequest, signal?: AbortSignal) => Promise<CostPromptAnswer>
  readonly optOut: CostOptOut
  readonly schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
}

/**
 * BigQuery's estimate and cost rules in the renderer (docs/bigquery.md, Cost): dry-run diagnostics after an editing pause
 * (markers at BigQuery's `[line:column]`, and the estimate beside Execute), the dry run before Execute, and its two prompts.
 * A dry run sends the editor's text to Google, so it runs only for a connected BigQuery tab, only after the user edits or
 * executes (decision 44: never by itself after a restore or a provider switch), and the diagnostics one only while Text
 * Editor › GoogleSQL turns it on. Nothing blocks by default: a dry run that fails leaves Execute to run and report the
 * query's own error, and the cap is the hard guard.
 */
export class BigQueryCostService extends SnapshotStore<EstimateSnapshot> implements Disposable {
  private readonly entries = new Map<string, Entry>()
  private readonly subscriptions: (() => void)[] = []
  private disposed = false
  constructor(private readonly deps: BigQueryCostDeps) {
    super(new Map())
    const reconcile = () => this.reconcile()
    this.subscriptions.push(deps.documents.subscribe(reconcile), deps.connections.subscribe(reconcile), deps.settings.subscribe(reconcile))
    const events = deps.events.subscribe(event => {
      if (event.type === 'query.finished') this.finished(event.tabId, event.summary?.job?.bytesProcessed)
    })
    this.subscriptions.push(() => events.dispose())
    this.reconcile()
  }

  /** The tab's live BigQuery connection, if it has one. */
  private connection(id: string): LiveConnection | undefined {
    const document = this.deps.documents.get(id)
    if (!isQueryDocument(document) || !document?.connectionId || !this.deps.connections.isLive(document.connectionId)) return undefined
    const connection = this.deps.connections.get(document.connectionId)
    return connection && isBigQueryConnection(connection) ? connection : undefined
  }
  /** The tab's default dataset, as Execute sends it. */
  private dataset(id: string): string | undefined {
    const database = this.deps.documents.get(id)?.database ?? ''
    return /^\w{1,1024}$/.test(database) ? database : undefined
  }

  private reconcile(): void {
    if (this.disposed) return
    const open = new Set<string>()
    for (const document of this.deps.documents.getSnapshot().documents) {
      const model = this.deps.documents.getModel(document.id)
      const connection = this.connection(document.id)
      if (!connection || !model || model.isDisposed()) continue
      open.add(document.id)
      let entry = this.entries.get(document.id)
      if (entry?.model !== model) {
        if (entry) this.remove(entry)
        const id = document.id
        entry = { id, model, key: '', revision: 0, content: model.onDidChangeContent(() => { const current = this.entries.get(id); if (current?.model === model) this.edited(current) }) }
        this.entries.set(id, entry)
      }
      const key = JSON.stringify([connection.id, connection.generation, this.dataset(document.id)])
      if (entry.key !== key) {
        // Another connection or dataset: the old figure and markers no longer apply, and nothing dry-runs until an edit.
        const first = entry.key === ''
        entry.key = key
        if (!first) this.reset(entry)
      }
      if (entry.read !== `${connection.id}:${connection.generation}`) { entry.read = `${connection.id}:${connection.generation}`; void this.deps.optOut.refresh(connection) }
      if (!this.deps.settings.get('textEditor.googleSql.dryRunDiagnostics')) { clearTimeout(entry.timer); entry.timer = undefined; entry.again = false }
    }
    for (const entry of [...this.entries.values()]) if (!open.has(entry.id)) this.remove(entry)
  }

  private reset(entry: Entry): void {
    entry.revision++
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.again = false
    entry.estimated = undefined
    this.clearMarkers(entry)
    this.put(entry.id, undefined)
  }

  private edited(entry: Entry): void {
    entry.revision++
    entry.estimated = undefined
    clearTimeout(entry.timer)
    entry.timer = undefined
    if (!this.deps.settings.get('textEditor.googleSql.dryRunDiagnostics')) return
    const schedule = this.deps.schedule ?? ((callback, ms) => setTimeout(callback, ms))
    // A timer cleared since (Execute went first, another edit) does nothing, whatever the scheduler.
    const timer: ReturnType<typeof setTimeout> = schedule(() => { if (entry.timer !== timer) return; entry.timer = undefined; this.diagnose(entry) }, dryRunDebounceMs)
    entry.timer = timer
  }

  /** The diagnostics dry run: one in flight per document; an edit while it runs asks for another when it settles. */
  private diagnose(entry: Entry): void {
    if (this.disposed || this.entries.get(entry.id) !== entry || entry.model.isDisposed()) return
    if (entry.running) { entry.again = true; return }
    const sql = entry.model.getValue()
    if (!sql.trim()) { this.clearMarkers(entry); this.put(entry.id, undefined); return }
    if (sql.length > dryRunLimits.characters) { this.put(entry.id, { phase: 'unavailable', message: `Dry runs are limited to ${dryRunLimits.characters.toLocaleString()} characters.` }); return }
    entry.running = this.dryRun(entry, sql, { line: 1, column: 1 }).then(() => undefined).finally(() => {
      entry.running = undefined
      if (!entry.again || this.disposed || this.entries.get(entry.id) !== entry) return
      entry.again = false
      if (this.deps.settings.get('textEditor.googleSql.dryRunDiagnostics')) this.diagnose(entry)
    })
  }

  /** Dry-runs `sql` for the tab and records the outcome when it is still current: the estimate, or BigQuery's error marked
   *  at its position (`origin` is where `sql` starts in the document: a selection's start). Resolves with the estimate,
   *  or undefined when there is none. */
  private async dryRun(entry: Entry, sql: string, origin: { readonly line: number; readonly column: number }): Promise<BigQueryDryRunResult | undefined> {
    const connection = this.connection(entry.id)
    if (!connection) return undefined
    const revision = entry.revision, version = entry.model.getVersionId(), dataset = this.dataset(entry.id)
    const checking: EstimateState = { phase: 'checking' }
    this.put(entry.id, checking)
    let response: ApiResult<BigQueryDryRunResult>
    try { response = await this.deps.api.bigQueryDryRun({ connectionId: connection.id, sql, ...dataset ? { dataset } : {} }) }
    catch (error) { response = { ok: false, error: error instanceof Error ? error.message : 'The dry run failed.' } as ApiResult<BigQueryDryRunResult> }
    const current = !this.disposed && this.entries.get(entry.id) === entry && !entry.model.isDisposed() && entry.revision === revision
    if (!current) {
      // Nothing newer replaced "checking" (an edit with diagnostics off schedules no dry run): no estimate stands.
      if (!this.disposed && this.getSnapshot().get(entry.id) === checking) this.put(entry.id, undefined)
      return response.ok ? response.value : undefined
    }
    if (response.ok) {
      entry.estimated = { sql, dataset, result: response.value }
      this.clearMarkers(entry)
      this.put(entry.id, { phase: 'estimate', bytes: response.value.bytesProcessed, ...response.value.incomplete ? { incomplete: response.value.incomplete } : {}, ...response.value.faked ? { faked: true } : {} })
      return response.value
    }
    if (response.code === 'SQL_ERROR') {
      this.mark(entry, response.error, version, origin)
      this.put(entry.id, { phase: 'refused', message: response.error })
    } else {
      this.clearMarkers(entry)
      this.put(entry.id, { phase: 'unavailable', message: response.error })
    }
    return undefined
  }

  private mark(entry: Entry, message: string, version: number, origin: { readonly line: number; readonly column: number }): void {
    const model = entry.model, found = errorPosition(message)
    // BigQuery counts from the start of the text it was sent: a selection's first line starts at its column.
    const position = found && { line: origin.line + found.line - 1, column: found.line === 1 ? origin.column + found.column - 1 : found.column }
    const line = position && position.line <= model.getLineCount() ? position.line : origin.line <= model.getLineCount() ? origin.line : 1
    const max = model.getLineMaxColumn(line), column = position && position.line === line ? Math.min(position.column, max) : 1
    // The word at the position, or one character, so the marker shows even where BigQuery points past a token.
    const word = model.getWordAtPosition?.({ lineNumber: line, column })
    const endColumn = word && word.startColumn <= column ? word.endColumn : Math.min(column + 1, max)
    const startColumn = word && word.startColumn <= column ? word.startColumn : column
    this.deps.monaco.editor.setModelMarkers(model, dryRunMarkerOwner, [{
      startLineNumber: line, startColumn, endLineNumber: line, endColumn: Math.max(endColumn, startColumn + (startColumn < max ? 1 : 0)),
      message, severity: this.deps.monaco.MarkerSeverity.Error, source: 'BigQuery dry run', modelVersionId: version
    }])
  }

  /**
   * Before Execute runs `sql` on a BigQuery tab: the estimate (the diagnostics one when it is for the same text and
   * dataset, else a new dry run, which goes first: a pending diagnostics run is dropped), then the prompts. Resolves
   * whether to run.
   */
  async beforeExecute(tabId: string, sql: string, origin: { readonly line: number; readonly column: number } = { line: 1, column: 1 }, signal?: AbortSignal): Promise<boolean> {
    const connection = this.connection(tabId), entry = this.entries.get(tabId)
    if (!connection || !entry) return true
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.again = false
    const dataset = this.dataset(tabId)
    let estimate = entry.estimated && entry.estimated.sql === sql && entry.estimated.dataset === dataset ? entry.estimated.result : undefined
    if (!estimate) {
      if (sql.length > dryRunLimits.characters) return true
      entry.revision++
    }
    // The revision of the text Execute runs, read before any await: an edit while the dry run is out is newer.
    entry.executed = entry.revision
    if (!estimate) estimate = await this.dryRun(entry, sql, origin)
    if (signal?.aborted) return false
    if (!estimate) return true
    await this.deps.optOut.refresh(connection)
    if (signal?.aborted || this.disposed) return false
    const settings = this.deps.settings, thresholdBytes = gibibytes(settings.get('queryExecution.bigQuery.costThreshold')) ?? 0
    const prompt = costPrompt(estimate, {
      askAboveThreshold: settings.get('queryExecution.bigQuery.costPrompt') && this.deps.optOut.asks(connection), thresholdBytes,
      warnIncomplete: settings.get('queryExecution.bigQuery.incompleteEstimateWarning') && !entry.warnedIncomplete
    })
    if (!prompt) return true
    const answer = await this.deps.ask({
      prompt, connection: connection.displayName ?? connection.server, thresholdBytes, prices: settings.get('queryExecution.bigQuery.showCost') !== 'bytes',
      ...this.cap(connection) ? { cap: this.cap(connection) } : {}
    }, signal)
    if (signal?.aborted) return false
    if (prompt.kind === 'incomplete' && answer.run) entry.warnedIncomplete = true
    if (answer.dontAskAgain) {
      if (prompt.kind === 'threshold') await this.deps.optOut.dontAsk(connection)
      else await this.deps.settings.choose('queryExecution.bigQuery.incompleteEstimateWarning', false).catch(() => {})
    }
    return answer.run && !this.disposed
  }

  /** The cap a job on this connection carries: its own, else Options' (undefined: none). */
  cap(connection: LiveConnection): number | undefined {
    const own = connection.options.provider === 'bigquery' ? connection.options.maximumBytesBilled : undefined
    return own ?? gibibytes(this.deps.settings.get('queryExecution.bigQuery.maximumBytesBilled'))
  }

  /** Whether Execute asks above the threshold on this tab: the setting, and not turned off for its connection. */
  asksAboveThreshold(tabId: string): boolean {
    const connection = this.connection(tabId)
    return this.deps.settings.get('queryExecution.bigQuery.costPrompt') && (!connection || this.deps.optOut.asks(connection))
  }

  /** The prompt choice for a connection changed: the chips re-render. */
  optOutChanged(): void { if (!this.disposed) this.publish(new Map(this.getSnapshot())) }

  /** A run finished: the chip shows what it processed (or keeps the estimate when BigQuery reported no bytes), unless the
   *  text changed while it ran, when the newer estimate or error stands. */
  private finished(tabId: string, bytes: number | undefined): void {
    const entry = this.entries.get(tabId)
    if (!entry || bytes === undefined || entry.executed !== entry.revision) return
    this.put(tabId, { phase: 'ran', bytes })
  }

  /** Text for the editor status bar's issues segment, as SQL Server's analysis shows it. */
  status(id: string): { label: string; detail: string } | undefined {
    const state = this.getSnapshot().get(id)
    if (!state) return undefined
    if (state.phase === 'checking') return { label: 'Checking with BigQuery', detail: 'A free dry run is checking this query. It sends the query text to Google; nothing runs.' }
    if (state.phase === 'refused') return { label: 'BigQuery: 1 error', detail: 'From a free dry run. Alt+F8 goes to the error.' }
    if (state.phase === 'unavailable') return { label: 'Dry run unavailable', detail: state.message }
    return { label: 'BigQuery: no issues', detail: 'From a free dry run, which runs nothing and bills nothing.' }
  }

  private put(id: string, state: EstimateState | undefined): void {
    const current = this.getSnapshot()
    if (current.get(id) === state) return
    const next = new Map(current)
    if (state) next.set(id, state)
    else next.delete(id)
    this.publish(next)
  }
  private clearMarkers(entry: Entry): void { if (!entry.model.isDisposed()) this.deps.monaco.editor.setModelMarkers(entry.model, dryRunMarkerOwner, []) }
  private remove(entry: Entry): void {
    this.entries.delete(entry.id)
    clearTimeout(entry.timer)
    entry.content.dispose()
    this.clearMarkers(entry)
    this.put(entry.id, undefined)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.subscriptions.forEach(unsubscribe => unsubscribe())
    for (const entry of [...this.entries.values()]) this.remove(entry)
    this.clearListeners()
  }
}
