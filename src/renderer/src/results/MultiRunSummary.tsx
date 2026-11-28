import { memo, useCallback, useSyncExternalStore } from 'react'
import { processedFact } from '../../../shared/bigquery/cost'
import type { MultiQueryMode, MultiQueryTargetPhase, QueryMultiStatus } from '../../../shared/contracts'
import type { IconId } from '../../../shared/icons'
import { useTicker } from '../core/useTicker'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import EnvironmentTag from '../EnvironmentTag'
import Icon from '../Icon'
import type { MultiTargetLiveState, TabResults } from './ResultsService'
import { formatCount, formatDuration, formatElapsed, plural } from './status'

export type MultiTone = 'running' | 'ok' | 'warn' | 'err' | 'muted'

/** Human-readable label for a multi-server / cross-engine execution mode. */
export function multiModeLabel(mode: MultiQueryMode): string {
  switch (mode) {
    case 'transaction': return 'Transaction'
    case 'fireAndForget': return 'Fire & Forget'
    case 'crossEngineReadOnly': return 'Cross-Engine SELECT'
  }
}

/** Overall outcome label, tone, and icon for a multi-server run (live or settled). */
export function multiOutcomeInfo(tab: Pick<TabResults, 'status' | 'closedFrom' | 'multi'>): { readonly label: string; readonly tone: MultiTone; readonly icon: IconId } {
  if (tab.status === 'running') return { label: 'Running', tone: 'running', icon: 'loading' }
  if (tab.status === 'lost' || tab.closedFrom === 'lost') return { label: 'Backend stopped', tone: 'err', icon: 'error' }
  const mode = tab.multi?.mode
  const status: QueryMultiStatus | undefined = tab.multi?.status
  switch (status) {
    case 'completed': return { label: mode === 'transaction' ? 'Committed' : 'Completed', tone: 'ok', icon: 'pass' }
    case 'completedWithErrors': return { label: 'Completed with errors', tone: 'warn', icon: 'warning' }
    case 'partialFailure': return { label: 'Partial failure', tone: 'warn', icon: 'warning' }
    case 'rolledBack': return { label: 'Rolled back', tone: 'warn', icon: 'discard' }
    case 'commitInDoubt': return { label: 'Commit in doubt', tone: 'err', icon: 'error' }
    case 'failed': return { label: 'Failed', tone: 'err', icon: 'error' }
    case 'cancelled': return { label: 'Cancelled', tone: 'warn', icon: 'debug-stop' }
    case 'timedOut': return { label: 'Timed out', tone: 'err', icon: 'watch' }
    default:
      if (tab.status === 'cancelled' || tab.closedFrom === 'cancelled') return { label: 'Cancelled', tone: 'warn', icon: 'debug-stop' }
      if (tab.status === 'timedOut' || tab.closedFrom === 'timedOut') return { label: 'Timed out', tone: 'err', icon: 'watch' }
      if (tab.status === 'failed' || tab.closedFrom === 'failed') return { label: 'Failed', tone: 'err', icon: 'error' }
      return { label: 'Completed', tone: 'ok', icon: 'pass' }
  }
}

/** Display label, semantic tone, and icon for a target's live or terminal execution phase. */
export function targetPhaseInfo(phase: MultiQueryTargetPhase): { readonly label: string; readonly tone: MultiTone; readonly icon: IconId; readonly spin?: true } {
  switch (phase) {
    case 'pending': return { label: 'Pending', tone: 'muted', icon: 'circle-outline' }
    case 'preflight': return { label: 'Pre-flight', tone: 'running', icon: 'loading', spin: true }
    case 'running': return { label: 'Running', tone: 'running', icon: 'loading', spin: true }
    case 'atBarrier': return { label: 'At barrier', tone: 'running', icon: 'watch' }
    case 'committing': return { label: 'Committing', tone: 'running', icon: 'loading', spin: true }
    case 'rollingBack': return { label: 'Rolling back', tone: 'warn', icon: 'loading', spin: true }
    case 'committed': return { label: 'Committed', tone: 'ok', icon: 'pass' }
    case 'succeeded': return { label: 'Succeeded', tone: 'ok', icon: 'pass' }
    case 'rolledBack': return { label: 'Rolled back', tone: 'warn', icon: 'discard' }
    case 'commitInDoubt': return { label: 'Commit in doubt', tone: 'err', icon: 'error' }
    case 'failed': return { label: 'Failed', tone: 'err', icon: 'error' }
    case 'cancelled': return { label: 'Cancelled', tone: 'warn', icon: 'debug-stop' }
    case 'timedOut': return { label: 'Timed out', tone: 'err', icon: 'watch' }
    case 'skipped': return { label: 'Skipped', tone: 'muted', icon: 'circle-slash' }
  }
}

/** Whether a multi-server run has preview rows kept from a rolled-back transaction. */
export function hasRolledBackPreviewRows(tab: Pick<TabResults, 'sets' | 'multi'>): boolean {
  if (tab.sets.length === 0) return false
  return tab.sets.some(entry => entry.descriptor.rolledBackPreview === true || entry.handle?.getSnapshot().rolledBackPreview === true)
}

/** Normalizes legacy short environment labels (`prod`, `stage`, `dev`) to canonical presets before `<EnvironmentTag>`. */
export function normalizeMultiEnvironment(environment: string | undefined): string | undefined {
  const trimmed = environment?.trim()
  if (!trimmed) return undefined
  const lower = trimmed.toLowerCase()
  if (lower === 'prod') return 'Production'
  if (lower === 'stage') return 'Staging'
  if (lower === 'dev') return 'Development'
  return trimmed
}

/** Aggregate bytes processed across all targets that reported BigQuery byte counts, or undefined if none did. */
export function aggregateBytesProcessed(targets: readonly MultiTargetLiveState[]): number | undefined {
  let total = 0, any = false
  for (const target of targets) {
    if (target.bytesProcessed !== undefined) { total += target.bytesProcessed; any = true }
  }
  return any ? total : undefined
}

/** Aggregate rows affected across targets (falling back to tab.rowsRead for pure SELECT runs). */
function aggregateRows(targets: readonly MultiTargetLiveState[], rowsRead: number): number {
  const affected = targets.reduce((sum, target) => sum + Math.max(0, target.rowsAffected), 0)
  return rowsRead > 0 ? rowsRead : affected
}

/**
 * Calm Pro summary surface for multi-server and cross-engine executions: displays the run-level mode & outcome banner,
 * rolled-back preview and combine-warning notices, and per-server live/terminal status cards with jump-to-results and
 * jump-to-Messages/line actions. Uses zero left-border accent rails; receives `data-pane-focus="selected"` when active
 * so F6 focus cycling lands inside it.
 */
function MultiRunSummary({ tabId, tab, active = false, compact = false, onSelectTarget }: {
  readonly tabId: string
  readonly tab: TabResults
  /** True when Summary is the active tab view (or solo view in Stacked layout), so F6 lands inside it. */
  readonly active?: boolean
  /** Compact mode when mounted inside Stacked layout's collapsible top band. */
  readonly compact?: boolean
  /** Jumps to the given server's first result set. */
  readonly onSelectTarget?: (targetKey: string) => void
}) {
  const { results, panes, queries, documents, settings } = useWorkbench()
  const prices = useServiceSnapshot(settings).values['queryExecution.bigQuery.showCost'] !== 'bytes'
  const now = useTicker(tab.status === 'running')
  const subscribe = useCallback((listener: () => void) => {
    const content = documents.onDidChangeContent?.(tabId, listener) ?? documents.getModel?.(tabId)?.onDidChangeContent(listener)
    const changed = documents.subscribe?.(listener)
    return () => { content?.dispose(); changed?.() }
  }, [documents, tabId])
  const revision = () => documents.revision?.(tabId) ?? 0
  useSyncExternalStore(subscribe, revision, revision)
  const multi = tab.multi
  if (!multi || multi.targets.length === 0) return null

  const outcome = multiOutcomeInfo(tab)
  const modeText = multiModeLabel(multi.mode)
  const elapsedMs = tab.status === 'running'
    ? Math.max(0, now - tab.startedAt)
    : tab.multiSummary?.elapsedMs ?? Math.max(0, (tab.endedAt ?? tab.startedAt) - tab.startedAt)
  const elapsedText = tab.status === 'running' ? formatElapsed(elapsedMs) : formatDuration(elapsedMs)
  const bytesProcessed = aggregateBytesProcessed(multi.targets)
  const totalRows = aggregateRows(multi.targets, tab.rowsRead)
  const succeededCount = multi.targets.filter(target => target.phase === 'committed' || target.phase === 'succeeded').length
  const rolledBackPreview = hasRolledBackPreviewRows(tab)
  const hasCommittedOrInDoubt = multi.status === 'partialFailure'
    || multi.status === 'commitInDoubt'
    || multi.targets.some(target => target.phase === 'committed' || target.phase === 'succeeded' || target.phase === 'commitInDoubt')
  const allRolledBack = tab.status !== 'running' && tab.status !== 'lost' && !hasCommittedOrInDoubt
  const warnings = multi.combineWarnings ?? []
  const runError = tab.error && (tab.status === 'lost' || !multi.targets.some(target => target.errorMessage)) ? tab.error : undefined
  const discarded = tab.discard ? (tab.summary?.discardedResultSets ?? tab.multiSummary?.discardedResultSets ?? 0) : 0

  const setsByTarget = new Map<string, number>()
  const firstEntryByTarget = new Map<string, string>()
  for (const entry of tab.sets) {
    const key = entry.descriptor.targetKey
    if (!key || entry.descriptor.kind === 'pivot' || entry.descriptor.kind === 'diff') continue
    setsByTarget.set(key, (setsByTarget.get(key) ?? 0) + 1)
    if (!firstEntryByTarget.has(key)) firstEntryByTarget.set(key, entry.key)
  }

  const jumpToTarget = (targetKey: string) => {
    if (onSelectTarget) { onSelectTarget(targetKey); return }
    const entryKey = firstEntryByTarget.get(targetKey)
    if (entryKey) results.focusEntry(tabId, entryKey)
  }
  const jumpToMessages = () => {
    results.setView(tabId, 'messages')
    panes.select('messages')
  }
  const jumpToLine = (target: MultiTargetLiveState) => {
    if (target.errorLine === undefined) return
    const line = queries.sourceLine(tabId, tab.queryId, target.errorLine, target.provider)
    if (line !== undefined) documents.revealLine(tabId, line, documents.revision(tabId), target.provider)
  }

  return <div className={compact ? 'multi-summary multi-summary-compact' : 'multi-summary'} role="region" aria-label="Multi-server execution summary"
    tabIndex={active ? 0 : -1} data-pane-focus={active ? 'selected' : undefined} data-multi-summary="" data-tab-id={tabId}>
    <div className="multi-summary-banner" data-tone={outcome.tone}>
      <span className="multi-mode-pill" data-mode={multi.mode}>{modeText}</span>
      <span className="multi-outcome-badge" data-tone={outcome.tone}>
        <Icon name={outcome.icon} spin={outcome.icon === 'loading'} />
        <strong>{outcome.label}</strong>
      </span>
      <span className="multi-banner-facts">
        <span>{formatCount(succeededCount)} of {formatCount(multi.targets.length)} {plural(multi.targets.length, 'server')}</span>
        <span> · {elapsedText}</span>
        <span> · {formatCount(totalRows)} {plural(totalRows, 'row')}</span>
        {bytesProcessed !== undefined && <span> · {processedFact(bytesProcessed, prices)}</span>}
      </span>
    </div>

    {runError && <div className="multi-notice multi-notice-err" role="status" data-notice-kind="runError">
      <Icon name="error" />
      <span className="multi-notice-text">{runError}</span>
      <button type="button" className="multi-target-link multi-notice-action" onClick={jumpToMessages}>
        <Icon name="output" /><span>Messages</span>
      </button>
    </div>}

    {rolledBackPreview && <div className="multi-notice multi-notice-warn" role="status">
      <Icon name="warning" />
      <span><strong>Rolled back — preview only (not committed).</strong> {tab.status === 'running'
        ? 'Preview rows from rolled-back servers remain inspectable below while remaining servers finish settling.'
        : allRolledBack
          ? 'Result rows remain inspectable below, but every server transaction was rolled back.'
          : 'Preview rows from rolled-back servers remain inspectable below, but one or more server transactions were committed or are in doubt — check each server card before retrying.'}</span>
    </div>}

    {discarded > 0 && <div className="multi-notice multi-notice-info" role="status" data-notice-kind="discarded">
      <Icon name="circle-slash" />
      <span><strong>Results were not kept.</strong> {formatCount(discarded)} {plural(discarded, 'result set')} {discarded === 1 ? 'was' : 'were'} read and not kept because Discard results after execution was on.</span>
    </div>}

    {warnings.length > 0 && <div className="multi-notice multi-notice-info" role="status">
      <Icon name="info" />
      <div className="multi-notice-list">
        {warnings.map((warning, index) => <span key={index}>{warning}</span>)}
      </div>
    </div>}

    <div className="multi-summary-cards" role="list" aria-label="Server execution status">
      {multi.targets.map((target, index) => {
        const phase = targetPhaseInfo(target.phase)
        const normalizedEnv = normalizeMultiEnvironment(target.environment)
        const setCount = setsByTarget.get(target.targetKey) ?? 0
        const canJumpLine = target.errorLine !== undefined && queries.sourceLine(tabId, tab.queryId, target.errorLine, target.provider) !== undefined
        const facts: string[] = []
        if (target.batchesTotal > 0) facts.push(`${formatCount(target.batchesCompleted)}/${formatCount(target.batchesTotal)} ${plural(target.batchesTotal, 'batch').replace(/batchs$/, 'batches')}`)
        if (target.rowsAffected > 0) facts.push(`${formatCount(target.rowsAffected)} ${plural(target.rowsAffected, 'row')} affected`)
        if (setCount > 0) facts.push(`${formatCount(setCount)} ${plural(setCount, 'result set')}`)
        if (target.elapsedMs > 0 || tab.status !== 'running') facts.push(formatDuration(target.elapsedMs))
        if (target.bytesProcessed !== undefined) facts.push(processedFact(target.bytesProcessed, prices))

        return <article key={target.targetKey} className="multi-target-card" role="listitem" data-phase={target.phase} data-tone={phase.tone} data-target-key={target.targetKey}>
          <div className="multi-target-head">
            <span className="multi-target-dot" data-target-color={index % 6} aria-hidden="true" />
            <strong className="multi-target-label" title={target.label}>{target.label}</strong>
            <span className="multi-provider-badge" data-provider={target.provider}>
              <Icon name={target.provider === 'bigquery' ? 'bigquery' : 'server'} />
              <span>{target.provider === 'bigquery' ? 'BigQuery' : 'SQL Server'}</span>
            </span>
            <EnvironmentTag environment={normalizedEnv} place="list" about={target.label} />
            <span className="multi-phase-pill" data-phase={target.phase} data-tone={phase.tone}>
              <Icon name={phase.icon} spin={phase.spin} />
              <span>{phase.label}</span>
            </span>
          </div>

          <div className="multi-target-meta">
            {target.database && <span className="multi-target-db">{target.database}</span>}
            {facts.length > 0 && <span className="multi-target-facts">{facts.join(' · ')}</span>}
            {setCount > 0 && <button type="button" className="multi-target-jump" onClick={() => jumpToTarget(target.targetKey)}>
              <Icon name="table" /><span>View {setCount === 1 ? 'result' : `${formatCount(setCount)} results`}</span>
            </button>}
          </div>

          {target.errorMessage && <div className="multi-target-error">
            <Icon name="error" />
            <span className="multi-target-error-text">{target.errorCode ? `${target.errorCode}: ` : ''}{target.errorMessage}</span>
            <div className="multi-target-error-actions">
              {target.errorLine !== undefined && <button type="button" className="multi-target-link" disabled={!canJumpLine}
                title={canJumpLine ? `Go to line ${target.errorLine}` : 'The query text has changed since execution.'}
                onClick={() => jumpToLine(target)}>
                <Icon name="go-to-file" /><span>Line {target.errorLine}</span>
              </button>}
              <button type="button" className="multi-target-link" onClick={jumpToMessages}>
                <Icon name="output" /><span>Messages</span>
              </button>
            </div>
          </div>}
        </article>
      })}
    </div>
  </div>
}

export default memo(MultiRunSummary)
