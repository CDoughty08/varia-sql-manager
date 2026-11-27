import type { ApiResult, MultiQueryMode, MultiQueryTarget, VariaApi } from '../../../shared/contracts'
import { costPrompt, dryRunLimits, gibibytes, type BigQueryDryRunResult } from '../../../shared/bigquery/dry-run'
import { checkCrossEngineReadOnly, hasExecutableSql, type StatementClassification } from '../../../shared/multi-query'
import type { ProviderId } from '../../../shared/providers'
import type { SettingKey, SettingValue } from '../../../shared/settings/catalog'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { isQueryDocument } from '../documents'
import type { CostOptOut } from './bigquery-cost'
import { disableIncompleteWarning, isIncompleteWarningEnabled, type CostPromptService, type MultiProjectCostEntry } from './bigquery-cost-prompt'
import type { ConnectionService, LiveConnection } from './connections'
import type { DocumentService } from './documents'
import type { MultiExecuteRequest, ReadOnlyRefusalItem } from './queries'

/** Free BigQuery dry-run estimator (omits `sessionId` because multi-server runs use ephemeral per-run sessions). */
export type BigQueryDryRunEstimator = (request: {
  readonly connectionId: string
  readonly sql: string
  readonly dataset?: string
}) => Promise<ApiResult<BigQueryDryRunResult>>

/** Per-target display and cost metadata rendered inside MultiExecuteDialog. */
export interface MultiExecuteTargetItem {
  readonly targetKey: string
  readonly connectionId: string
  readonly provider: ProviderId
  readonly label: string
  readonly database?: string
  readonly dataset?: string
  readonly environment?: string
  readonly color?: string
  /** True when connected to the BigQuery emulator (sessions/transactions unavailable and dry runs are faked). */
  readonly emulator?: boolean
  /** Whether cost threshold warnings are active for this target (global setting && per-connection costPrompt !== false). */
  readonly costPrompt?: boolean
  /** Effective threshold in bytes (connection's own costThreshold if set, else global Options threshold). */
  readonly costThresholdBytes?: number
  /** True when `costThresholdBytes` came from the connection's Advanced Properties. */
  readonly ownCostThreshold?: boolean
  /** Effective maximumBytesBilled cap in bytes (connection's own, else global Options cap). */
  readonly maximumBytesBilled?: number
}

/** Input passed to MultiExecuteDialog for a same-engine multi-target run (`>= 2` enabled live targets). */
export interface MultiExecuteDialogRequest {
  readonly tabId: string
  readonly provider: ProviderId
  readonly sql: string
  /** 1-based starting line in the editor when executing a selection (offsets blocker line numbers in the dialog). */
  readonly startLine?: number
  readonly targets: readonly MultiExecuteTargetItem[]
  /** True when estimated on-demand dollars should be shown alongside bytes. */
  readonly prices: boolean
  /** Default state for SQL Server "Stop on first batch error per server" checkbox. */
  readonly defaultStopOnError?: boolean
  /** Whether incomplete BigQuery dry-run estimates should display a warning. */
  readonly warnIncomplete?: boolean
  /** Optional pre-computed classification; MultiExecuteDialog computes via classifyStatements when omitted. */
  readonly classification?: StatementClassification
}

/** User confirmation returned by MultiExecuteDialog. */
export interface MultiExecuteChoice {
  readonly mode: 'transaction' | 'fireAndForget'
  readonly sequential: boolean
  readonly preflightDryRun: boolean
  readonly stopOnError: boolean
  readonly autoCombine: boolean
}

export interface PendingMultiExecutePrompt {
  readonly id: number
  readonly request: MultiExecuteDialogRequest
}

interface QueuedMultiExecutePrompt extends PendingMultiExecutePrompt {
  readonly resolve: (choice: MultiExecuteChoice | undefined) => void
}

/**
 * FIFO modal queue for the same-engine Run Mode Prompt (`MultiExecuteDialog`), matching `CostPromptService` and
 * `DisconnectPromptService` so prompts from multiple tabs or popouts never overwrite one another.
 */
export class MultiExecutePromptService extends SnapshotStore<{ readonly pending?: PendingMultiExecutePrompt }> implements Disposable {
  private readonly queue: QueuedMultiExecutePrompt[] = []
  private next = 0
  private disposed = false

  constructor() { super({}) }

  ask(request: MultiExecuteDialogRequest, signal?: AbortSignal): Promise<MultiExecuteChoice | undefined> {
    if (this.disposed || signal?.aborted) return Promise.resolve(undefined)
    return new Promise(resolve => {
      const item: QueuedMultiExecutePrompt = { id: ++this.next, request, resolve }
      signal?.addEventListener('abort', () => this.settle(item, undefined), { once: true })
      this.queue.push(item)
      if (this.queue.length === 1) this.publish({ pending: { id: item.id, request: item.request } })
    })
  }

  answer(id: number, choice: MultiExecuteChoice | undefined): boolean {
    const head = this.queue[0]
    if (!head || head.id !== id) return false
    this.settle(head, choice)
    return true
  }

  cancel(id: number): boolean {
    return this.answer(id, undefined)
  }

  private settle(item: QueuedMultiExecutePrompt, choice: MultiExecuteChoice | undefined): void {
    const index = this.queue.indexOf(item)
    if (index < 0) return
    this.queue.splice(index, 1)
    const next = this.queue[0]
    this.publish(next ? { pending: { id: next.id, request: next.request } } : {})
    item.resolve(choice)
  }

  dispose(): void {
    this.disposed = true
    const items = this.queue.splice(0)
    this.publish({})
    for (const item of items) item.resolve(undefined)
    this.clearListeners()
  }
}

/** Whether a live BigQuery connection is running against the local emulator (anonymous principal). */
export function isBigQueryEmulatorConnection(connection: Pick<LiveConnection, 'providerId' | 'principalId'>): boolean {
  return connection.providerId === 'bigquery' && !!connection.principalId?.startsWith('bigquery:anonymous:')
}

/** Runs `worker` over `items` with bounded concurrency, short-circuiting new work if `signal` aborts. */
export async function runBoundedPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<(R | undefined)[]> {
  const results = new Array<R | undefined>(items.length)
  if (!items.length) return results
  let cursor = 0
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const run = async () => {
    while (!signal?.aborted) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: limit }, run))
  return results
}

const dryRunConcurrency = 4
const maxMultiTargets = 32

export interface MultiExecuteDeps {
  readonly documents: Pick<DocumentService, 'get' | 'getExecuteText' | 'getCrossEngineScripts' | 'getSnapshot'> & Partial<Pick<DocumentService, 'revision'>>
  readonly connections: Pick<ConnectionService, 'get' | 'isLive'>
  readonly queries: {
    isRunning(id: string): boolean
    isGated?(id: string): boolean
    executeMulti(tabId: string, request: MultiExecuteRequest & { readonly stopOnError?: boolean }): Promise<void>
    refuseReadOnly(tabId: string, violations: readonly ReadOnlyRefusalItem[]): void
  }
  readonly settings: { get<K extends SettingKey>(key: K): SettingValue<K> }
  readonly api: Pick<VariaApi, 'bigQueryDryRun'>
  readonly optOut: Pick<CostOptOut, 'asks' | 'refresh' | 'dontAsk' | 'threshold'>
  readonly costPrompts: Pick<CostPromptService, 'ask' | 'askMulti'>
  readonly multiExecutePrompts: Pick<MultiExecutePromptService, 'ask'>
  readonly notify: (message: string, severity?: 'info' | 'warning' | 'error') => void
  /** Persists "Don't warn me about incomplete estimates again" when checked in a cost prompt. */
  readonly disableIncompleteWarning?: () => Promise<void>
}

export type MultiExecuteOutcome =
  | { readonly status: 'executed'; readonly mode: MultiQueryMode; readonly targetCount: number; readonly skippedDialog?: true }
  | { readonly status: 'cancelled' }
  | { readonly status: 'refused'; readonly reason: 'notMultiTab' | 'busy' | 'noTargets' | 'tooManyTargets' | 'missingCrossEngineTarget' | 'malformedCrossFile' | 'emptySql' | 'readOnlyViolation' | 'targetsChanged' | 'sqlChanged' }

interface ResolvedTarget {
  readonly connection: LiveConnection
  readonly item: MultiExecuteTargetItem
  readonly queryTarget: MultiQueryTarget
}

function resolveLiveTargets(
  tabId: string,
  deps: Pick<MultiExecuteDeps, 'documents' | 'connections' | 'settings' | 'optOut'>
): ResolvedTarget[] {
  const document = deps.documents.get(tabId)
  if (!document || !isQueryDocument(document) || !document.multiMode) return []
  const defaultCap = gibibytes(deps.settings.get('queryExecution.bigQuery.maximumBytesBilled'))
  const globalCostPrompt = deps.settings.get('queryExecution.bigQuery.costPrompt')
  const globalThresholdGiB = deps.settings.get('queryExecution.bigQuery.costThreshold')
  const seenConnections = new Set<string>()
  const seenKeys = new Set<string>()
  const resolved: ResolvedTarget[] = []

  for (const target of document.multiTargets ?? []) {
    if (!target.enabled || !target.connectionId || seenConnections.has(target.connectionId)) continue
    if (!deps.connections.isLive(target.connectionId)) continue
    const connection = deps.connections.get(target.connectionId)
    if (!connection) continue
    seenConnections.add(connection.id)
    const provider: ProviderId = connection.providerId === 'bigquery' ? 'bigquery' : 'sqlserver'
    let targetKey = target.targetId ?? connection.id
    if (seenKeys.has(targetKey)) targetKey = connection.id
    seenKeys.add(targetKey)
    const label = connection.displayName || connection.server
    const environment = connection.environment ?? connection.options.environment
    const database = provider === 'sqlserver' ? (target.database || connection.database || 'master') : undefined
    const dataset = provider === 'bigquery' && /^\w{1,1024}$/.test(target.database) ? target.database : undefined
    const ownCap = connection.options.provider === 'bigquery' ? connection.options.maximumBytesBilled : undefined
    const cap = provider === 'bigquery' ? (ownCap ?? defaultCap) : undefined
    const ownThresholdGiB = provider === 'bigquery' ? deps.optOut.threshold(connection) : undefined
    const costThresholdBytes = provider === 'bigquery' ? (gibibytes(ownThresholdGiB ?? globalThresholdGiB) ?? 0) : undefined
    const asks = provider === 'bigquery' ? (globalCostPrompt && deps.optOut.asks(connection)) : undefined
    const emulator = isBigQueryEmulatorConnection(connection)

    const item: MultiExecuteTargetItem = {
      targetKey,
      connectionId: connection.id,
      provider,
      label,
      ...database ? { database } : {},
      ...dataset ? { dataset } : {},
      ...environment ? { environment } : {},
      ...connection.color ? { color: connection.color } : {},
      ...emulator ? { emulator: true } : {},
      ...asks !== undefined ? { costPrompt: asks } : {},
      ...costThresholdBytes !== undefined ? { costThresholdBytes } : {},
      ...ownThresholdGiB !== undefined ? { ownCostThreshold: true } : {},
      ...cap !== undefined ? { maximumBytesBilled: cap } : {}
    }

    const queryTarget: MultiQueryTarget = {
      targetKey,
      connectionId: connection.id,
      label,
      ...environment ? { environment } : {},
      ...database ? { database } : {},
      ...dataset ? { dataset } : {},
      ...cap !== undefined ? { maximumBytesBilled: cap } : {}
    }

    resolved.push({ connection, item, queryTarget })
  }

  return resolved
}

async function refreshBigQueryOptOut(targets: readonly ResolvedTarget[], optOut: Pick<CostOptOut, 'refresh'>): Promise<void> {
  const bq = targets.filter(target => target.item.provider === 'bigquery')
  if (!bq.length) return
  await Promise.all(bq.map(target => optOut.refresh(target.connection).catch(() => {})))
}

async function dryRunTarget(
  api: Pick<VariaApi, 'bigQueryDryRun'>,
  target: ResolvedTarget,
  sql: string
): Promise<BigQueryDryRunResult | undefined> {
  if (sql.length > dryRunLimits.characters) return undefined
  try {
    const response = await api.bigQueryDryRun({
      connectionId: target.connection.id,
      sql,
      ...target.item.dataset ? { dataset: target.item.dataset } : {}
    })
    return response.ok ? response.value : undefined
  } catch {
    return undefined
  }
}

/**
 * Orchestrates Execute (`F5` / Execute button) for both Same-Engine Multi-Server and Cross-Engine SELECT tabs.
 * Called by `contributions/query.ts` when `tab.multiMode` is set:
 * - Same-Engine (`multiMode === 'same'`):
 *   - 0 enabled live targets -> clear notice, zero IPC.
 *   - 1 enabled live target -> skips Run Mode Prompt (§1.3), applies single-project BigQuery cost prompt if applicable,
 *     and executes ephemerally via `queries.executeMulti`.
 *   - >= 2 enabled live targets -> opens `MultiExecuteDialog` (with unified inline BigQuery dry-run cost breakdown)
 *     and dispatches `queries.executeMulti` with the chosen mode & options.
 * - Cross-Engine (`multiMode === 'cross'`):
 *   - Verifies >= 1 enabled live SQL Server target and >= 1 enabled live BigQuery target.
 *   - Checks both dialect scripts via `hasExecutableSql` (refuses empty/comment-only pane with zero IPC).
 *   - Runs `checkCrossEngineReadOnly` on both scripts; any violation calls `queries.refuseReadOnly` (zero IPC).
 *   - Runs free dry runs across BigQuery targets and, if any project exceeds its own `costThreshold` (with `costPrompt !== false`)
 *     or has an incomplete estimate warning, opens one aggregated multi-project `BigQueryCostPrompt`.
 *   - Dispatches `queries.executeMulti` with `mode: 'crossEngineReadOnly'`.
 */
type DispatchValidation =
  | { readonly ok: true; readonly targets: readonly ResolvedTarget[] }
  | { readonly ok: false; readonly outcome: MultiExecuteOutcome }

function liveBigQueryCap(connection: LiveConnection, settings: MultiExecuteDeps['settings']): number | undefined {
  if (connection.providerId !== 'bigquery') return undefined
  const ownCap = connection.options.provider === 'bigquery' ? connection.options.maximumBytesBilled : undefined
  return ownCap ?? gibibytes(settings.get('queryExecution.bigQuery.maximumBytesBilled'))
}

/** Re-verifies abort state, busy/running state, unchanged multiMode, unchanged SQL revision, and exact live enabled target set before dispatch. */
function validateBeforeDispatch(
  tabId: string,
  expectedMode: 'same' | 'cross',
  targets: readonly ResolvedTarget[],
  deps: Pick<MultiExecuteDeps, 'documents' | 'connections' | 'queries' | 'settings' | 'optOut' | 'notify'>,
  options: { readonly signal?: AbortSignal; readonly expectedProvider?: ProviderId; readonly capturedRevision?: number } = {}
): DispatchValidation {
  if (options.signal?.aborted) return { ok: false, outcome: { status: 'cancelled' } }
  const current = deps.documents.get(tabId)
  if (!current || !isQueryDocument(current) || current.multiMode !== expectedMode) return { ok: false, outcome: { status: 'cancelled' } }
  const runningNonGated = deps.queries.isRunning(tabId) && !deps.queries.isGated?.(tabId)
  if (deps.documents.getSnapshot().busy || runningNonGated) return { ok: false, outcome: { status: 'refused', reason: 'busy' } }
  if (options.capturedRevision !== undefined && deps.documents.revision?.(tabId) !== options.capturedRevision) {
    deps.notify('Execution cancelled because the query text changed before dispatch. Review the query and try again.', 'warning')
    return { ok: false, outcome: { status: 'refused', reason: 'sqlChanged' } }
  }
  const allLive = resolveLiveTargets(tabId, deps)
  const currentResolved = expectedMode === 'cross'
    ? [...allLive.filter(target => target.item.provider === 'sqlserver'), ...allLive.filter(target => target.item.provider === 'bigquery')]
    : allLive.filter(target => !options.expectedProvider || target.item.provider === options.expectedProvider)
  const dropped = targets.filter(planned => !currentResolved.some(live => live.connection.id === planned.connection.id))
  if (dropped.length) {
    const names = dropped.slice(0, 3).map(target => target.item.label).join(', ')
    const suffix = dropped.length > 3 ? ` and ${dropped.length - 3} more` : ''
    deps.notify(`Execution cancelled because target state changed (${names}${suffix} disconnected or disabled). Review the selected targets and try again.`, 'warning')
    return { ok: false, outcome: { status: 'refused', reason: 'targetsChanged' } }
  }
  const unchanged = currentResolved.length === targets.length && currentResolved.every((live, index) => {
    const planned = targets[index]!
    return live.connection.id === planned.connection.id
      && live.item.database === planned.item.database
      && live.item.dataset === planned.item.dataset
  })
  if (!unchanged) {
    deps.notify('Execution cancelled because the selected targets, databases, or datasets changed before dispatch. Review the selected targets and try again.', 'warning')
    return { ok: false, outcome: { status: 'refused', reason: 'targetsChanged' } }
  }
  return { ok: true, targets: currentResolved }
}

export async function executeMultiTab(tabId: string, deps: MultiExecuteDeps, signal?: AbortSignal): Promise<MultiExecuteOutcome> {
  if (signal?.aborted) return { status: 'cancelled' }
  const document = deps.documents.get(tabId)
  if (!document || !isQueryDocument(document) || !document.multiMode) return { status: 'refused', reason: 'notMultiTab' }
  const runningNonGated = deps.queries.isRunning(tabId) && !deps.queries.isGated?.(tabId)
  if (deps.documents.getSnapshot().busy || runningNonGated) return { status: 'refused', reason: 'busy' }

  if (document.multiMode === 'cross') return executeCrossEngine(tabId, deps, signal)
  return executeSameEngine(tabId, deps, signal)
}

async function executeSameEngine(tabId: string, deps: MultiExecuteDeps, signal?: AbortSignal): Promise<MultiExecuteOutcome> {
  const document = deps.documents.get(tabId)!
  const initialTargets = resolveLiveTargets(tabId, deps)
  const provider: ProviderId = document.provider
    ?? initialTargets[0]?.item.provider
    ?? document.multiTargets?.[0]?.provider
    ?? 'sqlserver'
  const engineTargets = initialTargets.filter(target => target.item.provider === provider)

  if (!engineTargets.length) {
    const noun = provider === 'bigquery' ? 'BigQuery project' : 'SQL Server'
    deps.notify(`No connected ${noun} targets are enabled. Connect or enable at least one target before executing.`, 'warning')
    return { status: 'refused', reason: 'noTargets' }
  }
  if (engineTargets.length > maxMultiTargets) {
    deps.notify(`Multi-Server queries support at most ${maxMultiTargets} enabled targets (${engineTargets.length} enabled). Disable extra targets before executing.`, 'warning')
    return { status: 'refused', reason: 'tooManyTargets' }
  }

  const capturedRevision = deps.documents.revision?.(tabId)
  const { sql, startLine, startColumn } = deps.documents.getExecuteText(tabId)
  if (!sql.trim()) {
    deps.notify('There is no SQL to execute.', 'warning')
    return { status: 'refused', reason: 'emptySql' }
  }

  // Refresh saved BigQuery per-connection cost preferences before checking thresholds or opening the dialog.
  if (provider === 'bigquery') {
    await refreshBigQueryOptOut(engineTargets, deps.optOut)
    const afterRefresh = validateBeforeDispatch(tabId, 'same', engineTargets, deps, { signal, expectedProvider: provider, capturedRevision })
    if (!afterRefresh.ok) return afterRefresh.outcome
  }
  const targets = resolveLiveTargets(tabId, deps).filter(target => target.item.provider === provider)
  if (!targets.length) {
    deps.notify('No connected targets remain enabled for execution.', 'warning')
    return { status: 'refused', reason: 'noTargets' }
  }

  const prices = deps.settings.get('queryExecution.bigQuery.showCost') !== 'bytes'
  const warnIncomplete = isIncompleteWarningEnabled(deps.settings)

  // Single-enabled-target shortcut (§1.3): skip MultiExecuteDialog; still apply BigQuery cost prompt if applicable.
  if (targets.length === 1) {
    const only = targets[0]!
    if (provider === 'bigquery') {
      const estimate = await dryRunTarget(deps.api, only, sql)
      const afterDryRun = validateBeforeDispatch(tabId, 'same', [only], deps, { signal, expectedProvider: provider, capturedRevision })
      if (!afterDryRun.ok) return afterDryRun.outcome
      if (estimate) {
        const thresholdBytes = () => gibibytes(deps.optOut.threshold(only.connection) ?? deps.settings.get('queryExecution.bigQuery.costThreshold')) ?? 0
        const currentPrompt = () => costPrompt(estimate, {
          askAboveThreshold: deps.settings.get('queryExecution.bigQuery.costPrompt') && deps.optOut.asks(only.connection),
          thresholdBytes: thresholdBytes(),
          warnIncomplete: isIncompleteWarningEnabled(deps.settings)
        })
        let prompt = currentPrompt()
        for (let turns = 0; prompt && turns < 16; turns++) {
          const kind = prompt.kind
          const threshold = thresholdBytes()
          const ownThreshold = deps.optOut.threshold(only.connection) !== undefined
          const cap = liveBigQueryCap(only.connection, deps.settings)
          const showPrices = deps.settings.get('queryExecution.bigQuery.showCost') !== 'bytes'
          let applied: Promise<unknown> | undefined
          const answer = await deps.costPrompts.ask({
            prompt,
            connection: only.item.label,
            thresholdBytes: threshold,
            ...ownThreshold ? { ownThreshold: true as const } : {},
            prices: showPrices,
            ...cap !== undefined ? { cap } : {}
          }, signal, () => currentPrompt()?.kind === kind
            && thresholdBytes() === threshold
            && (deps.optOut.threshold(only.connection) !== undefined) === ownThreshold
            && liveBigQueryCap(only.connection, deps.settings) === cap
            && (deps.settings.get('queryExecution.bigQuery.showCost') !== 'bytes') === showPrices,
          given => {
            if (signal?.aborted || !given.dontAskAgain) return
            if (kind === 'threshold') applied = deps.optOut.dontAsk(only.connection)
            else if (deps.disableIncompleteWarning) applied = disableIncompleteWarning(deps.settings, deps.disableIncompleteWarning)
          })
          await applied?.catch(() => {})
          if (signal?.aborted) return { status: 'cancelled' }
          if (answer.moot) { prompt = currentPrompt(); continue }
          if (!answer.run) return { status: 'cancelled' }
          prompt = undefined
          break
        }
        if (prompt) return { status: 'cancelled' }
      }
    }

    const validated = validateBeforeDispatch(tabId, 'same', [only], deps, { signal, expectedProvider: provider, capturedRevision })
    if (!validated.ok) return validated.outcome
    await deps.queries.executeMulti(tabId, {
      mode: 'fireAndForget',
      autoCombine: false,
      sql,
      ...startLine > 1 ? { startLine } : {},
      ...startColumn > 1 ? { startColumn } : {},
      targets: validated.targets.map(target => target.queryTarget)
    })
    return { status: 'executed', mode: 'fireAndForget', targetCount: 1, skippedDialog: true }
  }

  // >= 2 enabled live targets: open MultiExecuteDialog (which handles unified BigQuery cost estimation inline).
  const choice = await deps.multiExecutePrompts.ask({
    tabId,
    provider,
    sql,
    ...startLine > 1 ? { startLine } : {},
    targets: targets.map(target => target.item),
    prices,
    defaultStopOnError: deps.settings.get('queryExecution.stopOnError'),
    warnIncomplete
  }, signal)
  if (!choice || signal?.aborted) return { status: 'cancelled' }
  const validated = validateBeforeDispatch(tabId, 'same', targets, deps, { signal, expectedProvider: provider, capturedRevision })
  if (!validated.ok) return validated.outcome

  await deps.queries.executeMulti(tabId, {
    mode: choice.mode,
    ...choice.mode === 'fireAndForget' && choice.sequential ? { sequential: true } : {},
    ...provider === 'bigquery' && choice.preflightDryRun ? { preflightDryRun: true } : {},
    ...choice.mode === 'fireAndForget' && provider === 'sqlserver' ? { stopOnError: choice.stopOnError } : {},
    autoCombine: choice.autoCombine,
    sql,
    ...startLine > 1 ? { startLine } : {},
    ...startColumn > 1 ? { startColumn } : {},
    targets: validated.targets.map(target => target.queryTarget)
  })
  return { status: 'executed', mode: choice.mode, targetCount: validated.targets.length }
}

async function executeCrossEngine(tabId: string, deps: MultiExecuteDeps, signal?: AbortSignal): Promise<MultiExecuteOutcome> {
  const initialTargets = resolveLiveTargets(tabId, deps)
  const initialSqlTargets = initialTargets.filter(target => target.item.provider === 'sqlserver')
  const initialBqTargets = initialTargets.filter(target => target.item.provider === 'bigquery')

  if (!initialSqlTargets.length || !initialBqTargets.length) {
    const message = !initialSqlTargets.length && !initialBqTargets.length
      ? 'Cross-Engine SELECT requires at least one connected SQL Server target and one connected BigQuery target.'
      : !initialSqlTargets.length
        ? 'Cross-Engine SELECT requires at least one enabled, connected SQL Server target.'
        : 'Cross-Engine SELECT requires at least one enabled, connected BigQuery target.'
    deps.notify(message, 'warning')
    return { status: 'refused', reason: 'missingCrossEngineTarget' }
  }
  const totalCrossTargets = initialSqlTargets.length + initialBqTargets.length
  if (totalCrossTargets > maxMultiTargets) {
    deps.notify(`Cross-Engine queries support at most ${maxMultiTargets} enabled targets (${totalCrossTargets} enabled). Disable extra targets before executing.`, 'warning')
    return { status: 'refused', reason: 'tooManyTargets' }
  }

  const capturedRevision = deps.documents.revision?.(tabId)
  const parsed = deps.documents.getCrossEngineScripts(tabId)
  if (!parsed.ok) {
    deps.notify(parsed.reason, 'warning')
    return { status: 'refused', reason: 'malformedCrossFile' }
  }

  const hasSql = hasExecutableSql(parsed.sqlserver, 'sqlserver')
  const hasBq = hasExecutableSql(parsed.bigquery, 'bigquery')
  if (!hasSql || !hasBq) {
    const message = !hasSql && !hasBq
      ? 'Both the Transact-SQL and GoogleSQL panes are empty. Enter a SELECT query in each pane before executing.'
      : !hasSql
        ? 'The Transact-SQL pane has no executable SQL. Enter a SELECT query in both dialect panes before executing.'
        : 'The GoogleSQL pane has no executable SQL. Enter a SELECT query in both dialect panes before executing.'
    deps.notify(message, 'warning')
    return { status: 'refused', reason: 'emptySql' }
  }

  // Layer 2 pre-execute read-only guard on BOTH scripts (zero IPC).
  const sqlViolations = checkCrossEngineReadOnly(parsed.sqlserver, 'sqlserver')
  const bqViolations = checkCrossEngineReadOnly(parsed.bigquery, 'bigquery')
  const refusals: ReadOnlyRefusalItem[] = [
    ...sqlViolations.map(violation => ({
      line: violation.line + parsed.sqlServerStartLine - 1,
      column: violation.column,
      message: violation.message,
      dialect: 'sqlserver' as const
    })),
    ...bqViolations.map(violation => ({
      line: violation.line + parsed.bigQueryStartLine - 1,
      column: violation.column,
      message: violation.message,
      dialect: 'bigquery' as const
    }))
  ]
  if (refusals.length) {
    deps.queries.refuseReadOnly(tabId, refusals)
    return { status: 'refused', reason: 'readOnlyViolation' }
  }

  // Refresh BigQuery per-connection cost settings and run free dry runs across BigQuery targets.
  await refreshBigQueryOptOut(initialBqTargets, deps.optOut)
  const afterRefresh = validateBeforeDispatch(tabId, 'cross', [...initialSqlTargets, ...initialBqTargets], deps, { signal, capturedRevision })
  if (!afterRefresh.ok) return afterRefresh.outcome

  const refreshedTargets = afterRefresh.targets
  const sqlTargets = refreshedTargets.filter(target => target.item.provider === 'sqlserver')
  const bqTargets = refreshedTargets.filter(target => target.item.provider === 'bigquery')
  if (!sqlTargets.length || !bqTargets.length) {
    deps.notify('Cross-Engine SELECT requires at least one connected SQL Server target and one connected BigQuery target.', 'warning')
    return { status: 'refused', reason: 'missingCrossEngineTarget' }
  }

  const estimates = await runBoundedPool(bqTargets, dryRunConcurrency, target => dryRunTarget(deps.api, target, parsed.bigquery), signal)
  const plannedTargets = [...sqlTargets, ...bqTargets]
  const afterDryRun = validateBeforeDispatch(tabId, 'cross', plannedTargets, deps, { signal, capturedRevision })
  if (!afterDryRun.ok) return afterDryRun.outcome

  const buildFlagged = () => {
    const warnIncompleteNow = isIncompleteWarningEnabled(deps.settings)
    const globalCostPrompt = deps.settings.get('queryExecution.bigQuery.costPrompt')
    const globalThresholdGiB = deps.settings.get('queryExecution.bigQuery.costThreshold')
    const list: { readonly target: ResolvedTarget; readonly entry: MultiProjectCostEntry }[] = []
    for (let index = 0; index < bqTargets.length; index++) {
      const target = bqTargets[index]!
      const estimate = estimates[index]
      if (!estimate) continue
      const ownThresholdGiB = deps.optOut.threshold(target.connection)
      const thresholdBytes = gibibytes(ownThresholdGiB ?? globalThresholdGiB) ?? 0
      const prompt = costPrompt(estimate, {
        askAboveThreshold: globalCostPrompt && deps.optOut.asks(target.connection),
        thresholdBytes,
        warnIncomplete: warnIncompleteNow
      })
      if (!prompt) continue
      const cap = liveBigQueryCap(target.connection, deps.settings)
      list.push({
        target,
        entry: {
          connectionId: target.connection.id,
          label: target.item.label,
          ...target.item.dataset ? { dataset: target.item.dataset } : {},
          ...target.item.environment ? { environment: target.item.environment } : {},
          prompt,
          thresholdBytes,
          ...ownThresholdGiB !== undefined ? { ownThreshold: true as const } : {},
          ...cap !== undefined ? { cap } : {}
        }
      })
    }
    return list
  }

  let flagged = buildFlagged()
  for (let turns = 0; flagged.length > 0 && turns < 16; turns++) {
    const snapshotFlagged = flagged
    const showPrices = deps.settings.get('queryExecution.bigQuery.showCost') !== 'bytes'
    const totalBytes = snapshotFlagged.reduce((sum, item) => sum + item.entry.prompt.bytes, 0)
    let applied: Promise<unknown> | undefined
    const answer = await deps.costPrompts.askMulti({
      kind: 'multi',
      projects: snapshotFlagged.map(item => item.entry),
      prices: showPrices,
      totalBytes,
      totalProjectCount: bqTargets.length
    }, signal, () => {
      if ((deps.settings.get('queryExecution.bigQuery.showCost') !== 'bytes') !== showPrices) return false
      const latest = buildFlagged()
      return latest.length === snapshotFlagged.length && latest.every((item, index) => {
        const snapshot = snapshotFlagged[index]!
        return item.entry.connectionId === snapshot.entry.connectionId
          && item.entry.prompt.kind === snapshot.entry.prompt.kind
          && item.entry.thresholdBytes === snapshot.entry.thresholdBytes
          && item.entry.cap === snapshot.entry.cap
      })
    },
    given => {
      if (signal?.aborted || !given.dontAskAgain) return
      const thresholdTargets = snapshotFlagged.filter(item => item.entry.prompt.kind === 'threshold')
      if (thresholdTargets.length) {
        applied = Promise.all(thresholdTargets.map(item => deps.optOut.dontAsk(item.target.connection)))
      } else if (deps.disableIncompleteWarning) {
        applied = disableIncompleteWarning(deps.settings, deps.disableIncompleteWarning)
      }
    })
    await applied?.catch(() => {})
    if (signal?.aborted) return { status: 'cancelled' }
    if (answer.moot) { flagged = buildFlagged(); continue }
    if (!answer.run) return { status: 'cancelled' }
    flagged = []
    break
  }
  if (flagged.length > 0) return { status: 'cancelled' }

  const validated = validateBeforeDispatch(tabId, 'cross', plannedTargets, deps, { signal, capturedRevision })
  if (!validated.ok) return validated.outcome
  const combinedTargets = validated.targets.map(target => target.queryTarget)
  await deps.queries.executeMulti(tabId, {
    mode: 'crossEngineReadOnly',
    scripts: { sqlserver: parsed.sqlserver, bigquery: parsed.bigquery },
    ...parsed.sqlServerStartLine > 1 || parsed.bigQueryStartLine > 1
      ? { startLines: { sqlserver: parsed.sqlServerStartLine, bigquery: parsed.bigQueryStartLine } } : {},
    targets: combinedTargets,
    autoCombine: true
  })
  return { status: 'executed', mode: 'crossEngineReadOnly', targetCount: combinedTargets.length }
}
