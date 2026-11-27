import type {
  BigQueryJobSummary,
  MessageEntry,
  MultiQueryMode,
  MultiQueryTargetPhase,
  MultiTargetOutcome,
  QueryEvent,
  QueryMultiResult,
  QueryMultiStatus,
  QueryResult
} from '../../../shared/contracts'
import type { ErrorCode } from '../../../shared/ipc/wire/protocol'
import type { ProviderId } from '../../../shared/providers'
import type { PlanExecutionContext } from '../plans/RetainedPlansService'

/** Target identity supplied at multi-server run start so Summary cards and Messages render labels/environments immediately. */
export interface MultiTargetIdentity {
  readonly targetKey: string
  readonly connectionId: string
  readonly provider: ProviderId
  readonly label: string
  readonly environment?: string
  readonly database?: string
}

/** Live and terminal state of one target inside a multi-server or cross-engine execution. */
export interface MultiTargetLiveState {
  readonly targetKey: string
  readonly connectionId: string
  readonly provider: ProviderId
  readonly label: string
  readonly environment?: string
  readonly database?: string
  readonly phase: MultiQueryTargetPhase
  readonly batchesCompleted: number
  readonly batchesTotal: number
  readonly rowsAffected: number
  readonly resultSetCount: number
  readonly elapsedMs: number
  readonly bytesProcessed?: number
  readonly spid?: number
  readonly login?: string
  readonly job?: BigQueryJobSummary
  readonly resultSetIds: readonly number[]
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly errorLine?: number
}

/** Aggregate state for a multi-server or cross-engine run, shared between QueryService (Wave 2a) and ResultsService (Wave 2b). */
export interface MultiRunState {
  readonly mode: MultiQueryMode
  readonly status?: QueryMultiStatus
  readonly targets: readonly MultiTargetLiveState[]
  readonly combineWarnings?: readonly string[]
}

/** Options passed to `ResultsService.begin` (superset of single-server begin options). */
export interface BeginRunOptions {
  readonly bare?: boolean
  readonly discard?: boolean
  readonly onJob?: (job: Extract<QueryEvent, { type: 'query.job' }>) => void
  readonly multi?: {
    readonly mode: MultiQueryMode
    readonly targets: readonly MultiTargetIdentity[]
  }
  readonly onTargetState?: (event: Extract<QueryEvent, { type: 'multiQuery.targetState' }>) => void
  readonly onResultMeta?: (event: Extract<QueryEvent, { type: 'resultSet.meta' }>) => void
}

/** Extended `RunEnd` contract consumed by Wave 2a (`queries.ts`) and Wave 2b (`ResultsService.ts`). */
export interface MultiRunEnd {
  readonly summary?: QueryResult
  readonly multiSummary?: QueryMultiResult
  readonly error?: string
  readonly code?: ErrorCode
  readonly notice?: string
  /** Local messages written without IPC (e.g. Cross-Engine pre-execute `READ_ONLY_VIOLATION` refusals with line + dialect). */
  readonly messages?: readonly MessageEntry[]
  readonly planContext?: PlanExecutionContext
}

/** Results sink interface used by `QueryService` for both single-server and multi-server runs. */
export interface MultiResultsSink {
  begin(
    tabId: string,
    queryId: string,
    onSession?: (session: Extract<QueryEvent, { type: 'session.opened' }>) => void,
    options?: BeginRunOptions
  ): void
  finish(tabId: string, queryId: string, end: MultiRunEnd): void | Promise<void>
  addMessage?(tabId: string, text: string, kind?: 'info' | 'error'): void
  updateMultiTargetState?(tabId: string, queryId: string, event: Extract<QueryEvent, { type: 'multiQuery.targetState' }>): void
  updateResultMeta?(tabId: string, queryId: string, event: Extract<QueryEvent, { type: 'resultSet.meta' }>): void
}

/** Builds initial `pending` live states for every participating target of a multi-server run. */
export function initialMultiTargetStates(targets: readonly MultiTargetIdentity[]): MultiTargetLiveState[] {
  return targets.map(target => ({
    targetKey: target.targetKey,
    connectionId: target.connectionId,
    provider: target.provider,
    label: target.label,
    ...target.environment ? { environment: target.environment } : {},
    ...target.database !== undefined ? { database: target.database } : {},
    phase: 'pending',
    batchesCompleted: 0,
    batchesTotal: 0,
    rowsAffected: 0,
    resultSetCount: 0,
    elapsedMs: 0,
    resultSetIds: []
  }))
}

/** Applies a streaming `multiQuery.targetState` event to the target list (preserving order and identity fields). */
export function applyTargetStateEvent(
  targets: readonly MultiTargetLiveState[],
  event: Extract<QueryEvent, { type: 'multiQuery.targetState' }>
): MultiTargetLiveState[] {
  let matched = false
  const next = targets.map(target => {
    if (target.targetKey !== event.targetKey) return target
    matched = true
    return {
      ...target,
      phase: event.phase,
      batchesCompleted: event.batchesCompleted,
      batchesTotal: event.batchesTotal,
      rowsAffected: event.rowsAffected,
      resultSetCount: event.resultSetCount,
      elapsedMs: event.elapsedMs,
      ...event.bytesProcessed !== undefined ? { bytesProcessed: event.bytesProcessed } : {},
      ...event.errorCode !== undefined ? { errorCode: event.errorCode } : {},
      ...event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}
    }
  })
  return matched ? next : [...targets]
}

/** Reconciles the authoritative `QueryMultiResult.targets[]` onto the live target states when the run settles. */
export function applyMultiOutcomes(
  targets: readonly MultiTargetLiveState[],
  outcomes: readonly MultiTargetOutcome[]
): MultiTargetLiveState[] {
  const byKey = new Map(targets.map(target => [target.targetKey, target]))
  return outcomes.map(outcome => {
    const existing = byKey.get(outcome.targetKey)
    return {
      targetKey: outcome.targetKey,
      connectionId: existing?.connectionId ?? '',
      provider: outcome.provider,
      label: outcome.label,
      ...outcome.environment ? { environment: outcome.environment } : existing?.environment ? { environment: existing.environment } : {},
      ...existing?.database !== undefined ? { database: existing.database } : {},
      phase: outcome.status,
      batchesCompleted: outcome.batchesCompleted,
      batchesTotal: outcome.batchesTotal,
      rowsAffected: outcome.rowsAffected,
      resultSetCount: outcome.resultSetIds.length,
      elapsedMs: outcome.elapsedMs,
      ...outcome.bytesProcessed !== undefined ? { bytesProcessed: outcome.bytesProcessed } : {},
      ...outcome.spid !== undefined ? { spid: outcome.spid } : {},
      ...outcome.login !== undefined ? { login: outcome.login } : {},
      ...outcome.job ? { job: outcome.job } : {},
      resultSetIds: [...outcome.resultSetIds],
      ...outcome.error ? { errorCode: outcome.error.code, errorMessage: outcome.error.message, ...outcome.error.line !== undefined ? { errorLine: outcome.error.line } : {} } : {}
    }
  })
}
