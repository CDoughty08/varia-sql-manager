import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { formatBytes, formatDollars } from '../../../shared/bigquery/cost'
import { dryRunLimits, incompleteText, pricedBytes, type BigQueryDryRunResult } from '../../../shared/bigquery/dry-run'
import { environmentPreset } from '../../../shared/environments'
import { classifyStatements, type StatementClassification } from '../../../shared/multi-query'
import type { ProviderId } from '../../../shared/providers'
import { focusToReturn, isElement, returnFocusTo } from '../core/focus'
import EnvironmentTag from '../EnvironmentTag'
import Icon from '../Icon'
import DialogFooter from '../kit/DialogFooter'
import StatusPill from '../kit/StatusPill'
import { useDialogWindow } from '../popouts/DialogWindow'
import {
  runBoundedPool,
  type BigQueryDryRunEstimator,
  type MultiExecuteChoice,
  type MultiExecuteDialogRequest,
  type MultiExecutePromptService,
  type MultiExecuteTargetItem
} from '../services/multi-execute'
import { trapFocus } from '../trap-focus'

export const maxVisibleTargetChips = 6
const dryRunConcurrency = 4

export interface MultiExecuteDialogProps {
  readonly service: MultiExecutePromptService
  /** Injected dry-run estimator for testing; defaults to `window.varia.bigQueryDryRun`. */
  readonly estimateBigQuery?: BigQueryDryRunEstimator
}

export interface MultiExecuteDialogModalProps {
  readonly request: MultiExecuteDialogRequest
  readonly onConfirm: (choice: MultiExecuteChoice) => void
  readonly onCancel: () => void
  /** Injected dry-run estimator for testing; defaults to `window.varia.bigQueryDryRun`. */
  readonly estimateBigQuery?: BigQueryDryRunEstimator
}

type TargetEstimateState =
  | { readonly status: 'estimating' }
  | { readonly status: 'done'; readonly result: BigQueryDryRunResult }
  | { readonly status: 'error'; readonly message: string; readonly code?: string }
  | { readonly status: 'unavailable'; readonly message: string }

/** Formats the primary submit button label with execution scope, target count, and PROD count. */
export function multiExecuteSubmitLabel(
  mode: 'transaction' | 'fireAndForget',
  provider: ProviderId,
  targetCount: number,
  prodCount: number
): string {
  const noun = provider === 'bigquery'
    ? targetCount === 1 ? 'Project' : 'Projects'
    : targetCount === 1 ? 'Server' : 'Servers'
  const prefix = mode === 'transaction' ? 'Run Transaction on' : 'Run on'
  const prodSuffix = prodCount > 0 ? ` (${prodCount} PROD)` : ''
  return `${prefix} ${targetCount} ${noun}${prodSuffix}`
}

/** Computes whether Coordinated Transaction is disabled and why, given classification and emulator state. */
export function transactionDisableReason(
  provider: ProviderId,
  classification: StatementClassification,
  hasEmulator: boolean
): string | undefined {
  const blocker = classification.firstBlockingStatement
  const location = blocker ? `Line ${blocker.line}: ${blocker.keyword}` : undefined
  if (provider === 'sqlserver') {
    if (!classification.hasNonTransactionalTSql) return undefined
    return location
      ? `Script contains non-transactional T-SQL (${location}). SQL Server does not allow this statement inside a transaction.`
      : 'Script contains non-transactional T-SQL. SQL Server does not allow these statements inside a transaction.'
  }
  if (hasEmulator) {
    return 'BigQuery emulator connections do not support multi-statement session transactions.'
  }
  if (classification.hasBigQueryPermanentDdl) {
    return location
      ? `Script contains permanent BigQuery DDL (${location}). BigQuery prohibits permanent DDL inside multi-statement transactions. Pre-flight Dry Run (free) and Sequential rollout are pre-selected below.`
      : 'Script contains permanent BigQuery DDL. BigQuery prohibits permanent DDL inside multi-statement transactions. Pre-flight Dry Run (free) and Sequential rollout are pre-selected below.'
  }
  if (classification.blocksBigQueryTransaction) {
    return location
      ? `Script contains a statement (${location}) that cannot run inside a Coordinated Session Transaction in BigQuery.`
      : 'Script contains a statement that cannot run inside a Coordinated Session Transaction in BigQuery.'
  }
  return undefined
}

const defaultEstimator: BigQueryDryRunEstimator = request => window.varia.bigQueryDryRun(request)

/**
 * Connected Run Mode Prompt modal mounted once in App.tsx's modal layer. Subscribes to `MultiExecutePromptService`
 * and renders `MultiExecuteDialogModal` whenever a same-engine multi-target execution (`>= 2` targets) awaits confirmation.
 */
export default function MultiExecuteDialog({ service, estimateBigQuery }: MultiExecuteDialogProps) {
  const { pending } = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)
  if (!pending) return null
  return (
    <MultiExecuteDialogModal
      key={pending.id}
      request={pending.request}
      estimateBigQuery={estimateBigQuery}
      onConfirm={choice => service.answer(pending.id, choice)}
      onCancel={() => service.cancel(pending.id)}
    />
  )
}

/**
 * Run Mode Prompt dialog (`docs/multi-server-query-plan.md` §2.4) for same-engine multi-target runs (`>= 2` targets).
 * - Shows first 6 target chips with environment badges + expandable `"+N more"` toggle (fits up to 32 targets in 1024×700).
 * - Classifies SQL via `classifyStatements(sql, provider)` and disables Coordinated Transaction with explanation when blocked.
 * - On BigQuery runs, runs free per-target dry runs inline (omitting `sessionId`, cancellable on cancel/unmount) and renders
 *   per-project bytes/cost breakdown and per-project `costThreshold` / `maximumBytesBilled` warnings without double-modal stacking.
 * - Places initial focus on the active radio card (never on Execute when PROD + mutation is present).
 */
export function MultiExecuteDialogModal({
  request,
  onConfirm,
  onCancel,
  estimateBigQuery = defaultEstimator
}: MultiExecuteDialogModalProps) {
  const { ownerDocument } = useDialogWindow()
  const titleId = useId()
  const descId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const txRadioRef = useRef<HTMLInputElement>(null)
  const fafRadioRef = useRef<HTMLInputElement>(null)
  const returnFocus = useRef(focusToReturn())

  const isBigQuery = request.provider === 'bigquery'
  const classification = useMemo(
    () => request.classification ?? classifyStatements(request.sql, request.provider),
    [request.classification, request.sql, request.provider]
  )
  const isMutation = useMemo(
    () => classification.statements.some(statement => statement.category !== 'select'),
    [classification]
  )
  const prodCount = useMemo(
    () => request.targets.filter(target => environmentPreset(target.environment) === 'Production').length,
    [request.targets]
  )
  const hasProd = prodCount > 0

  const [estimates, setEstimates] = useState<Readonly<Record<string, TargetEstimateState>>>(() => {
    if (!isBigQuery) return {}
    if (request.sql.length > dryRunLimits.characters) {
      const message = `Dry runs are limited to ${dryRunLimits.characters.toLocaleString()} characters.`
      return Object.fromEntries(request.targets.map(target => [target.targetKey, { status: 'unavailable', message } as const]))
    }
    return Object.fromEntries(request.targets.map(target => [target.targetKey, { status: 'estimating' } as const]))
  })

  // Detect BigQuery emulator from connection metadata or dynamically if any dry run reports `faked: true`.
  const hasEmulator = useMemo(() => {
    if (!isBigQuery) return false
    if (request.targets.some(target => target.emulator)) return true
    return Object.values(estimates).some(state => state.status === 'done' && state.result.faked === true)
  }, [isBigQuery, request.targets, estimates])

  const txBlockReason = useMemo(
    () => transactionDisableReason(request.provider, classification, hasEmulator),
    [request.provider, classification, hasEmulator]
  )
  const txDisabled = txBlockReason !== undefined

  const [mode, setMode] = useState<'transaction' | 'fireAndForget'>(() => {
    if (txDisabled) return 'fireAndForget'
    return isMutation ? 'transaction' : 'fireAndForget'
  })
  const [sequential, setSequential] = useState<boolean>(() => isBigQuery && classification.hasBigQueryPermanentDdl)
  const [preflightDryRun, setPreflightDryRun] = useState<boolean>(() => isBigQuery && !hasEmulator)
  const [stopOnError, setStopOnError] = useState<boolean>(() => !isBigQuery && !!request.defaultStopOnError)
  const [showAllTargets, setShowAllTargets] = useState(false)

  // If dry run dynamically discovers BigQuery emulator mode, disable pre-flight dry run and fall back to Fire and Forget.
  useEffect(() => {
    if (hasEmulator) setPreflightDryRun(false)
    if (txDisabled && mode === 'transaction') setMode('fireAndForget')
  }, [txDisabled, mode, hasEmulator])

  // When Coordinated Transaction becomes disabled while focused, move focus to Fire and Forget so Escape/Tab never break.
  useEffect(() => {
    if (!txDisabled) return
    const active = ownerDocument.activeElement
    if (!active || active === ownerDocument.body || active === txRadioRef.current) {
      fafRadioRef.current?.focus()
    }
  }, [txDisabled, ownerDocument])

  // Initial focus lands on the active radio input (never on Execute); focus returns on unmount.
  useEffect(() => {
    const initialRadio = mode === 'transaction' && !txDisabled ? txRadioRef.current : fafRadioRef.current
    initialRadio?.focus()
    const previous = returnFocus.current
    return () => returnFocusTo(previous)
    // Intentionally run once on dialog mount so initial focus is placed without stealing focus on later state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Free per-target BigQuery dry runs (omits sessionId; aborted immediately on dialog cancel or unmount).
  useEffect(() => {
    if (!isBigQuery) return
    if (request.sql.length > dryRunLimits.characters) return
    const abort = new AbortController()
    const runEstimates = async () => {
      await runBoundedPool(request.targets, dryRunConcurrency, async target => {
        if (abort.signal.aborted) return
        let nextState: TargetEstimateState
        try {
          const response = await estimateBigQuery({
            connectionId: target.connectionId,
            sql: request.sql,
            ...target.dataset ? { dataset: target.dataset } : {}
          })
          if (abort.signal.aborted) return
          if (response.ok) nextState = { status: 'done', result: response.value }
          else nextState = { status: 'error', message: response.error, ...response.code ? { code: response.code } : {} }
        } catch (error) {
          if (abort.signal.aborted) return
          nextState = { status: 'error', message: error instanceof Error ? error.message : 'Dry run failed.' }
        }
        if (!abort.signal.aborted) {
          setEstimates(current => ({ ...current, [target.targetKey]: nextState }))
        }
      }, abort.signal)
    }
    void runEstimates()
    return () => { abort.abort() }
  }, [isBigQuery, request.sql, request.targets, estimateBigQuery])

  const submitChoice = () => {
    const effectiveMode = txDisabled ? 'fireAndForget' : mode
    onConfirm({
      mode: effectiveMode,
      sequential: effectiveMode === 'fireAndForget' ? sequential : false,
      preflightDryRun: isBigQuery && !hasEmulator ? preflightDryRun : false,
      stopOnError: !isBigQuery && effectiveMode === 'fireAndForget' ? stopOnError : false,
      autoCombine: true
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    event.stopPropagation()
    trapFocus(event)
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    // Keyboard safety: when PROD + mutation is present, a stray Enter on a radio/checkbox must not submit immediately.
    if (event.key === 'Enter' && hasProd && isMutation && isElement(event.target) && event.target.tagName === 'INPUT') {
      event.preventDefault()
    }
  }

  const visibleTargets = showAllTargets ? request.targets : request.targets.slice(0, maxVisibleTargetChips)
  const hiddenTargetCount = Math.max(0, request.targets.length - maxVisibleTargetChips)
  const engineNoun = isBigQuery
    ? request.targets.length === 1 ? 'BigQuery Project' : 'BigQuery Projects'
    : request.targets.length === 1 ? 'SQL Server' : 'SQL Servers'

  const effectiveMode = txDisabled ? 'fireAndForget' : mode
  const submitLabel = multiExecuteSubmitLabel(effectiveMode, request.provider, request.targets.length, prodCount)

  const txDescription = isBigQuery
    ? 'Opens an ephemeral BigQuery session with BEGIN TRANSACTION on each project. Waits at the commit barrier and commits all only if every project succeeds — otherwise rolls back and aborts sessions.'
    : 'Opens a local transaction (SET XACT_ABORT ON; BEGIN TRANSACTION) on each SQL Server in parallel (no MSDTC). Waits at the commit barrier and commits all only if every server succeeds — otherwise rolls back all peers.'

  const txCaveat = isBigQuery
    ? 'BigQuery still bills bytes processed on rolled-back jobs. A drop during the final COMMIT step itself is reported as CommitInDoubt.'
    : 'Cross-platform coordinated local transactions (no MSDTC required). Holds locks until the slowest peer finishes; a drop during final COMMIT is reported as CommitInDoubt.'

  const costSummary = useMemo(() => {
    if (!isBigQuery) return undefined
    let estimating = 0
    let doneCount = 0
    let totalBytes = 0
    let thresholdWarnings = 0
    let capWarnings = 0
    for (const target of request.targets) {
      const state = estimates[target.targetKey]
      if (!state || state.status === 'estimating') { estimating++; continue }
      if (state.status !== 'done') continue
      doneCount++
      if (state.result.faked) continue
      totalBytes += state.result.bytesProcessed
      if (target.maximumBytesBilled !== undefined && state.result.bytesProcessed > target.maximumBytesBilled) capWarnings++
      if (target.costPrompt !== false && target.costThresholdBytes !== undefined && state.result.bytesProcessed > target.costThresholdBytes) thresholdWarnings++
    }
    return { estimating, doneCount, totalBytes, thresholdWarnings, capWarnings }
  }, [isBigQuery, request.targets, estimates])

  const dialog = (
    <div className="modal-backdrop">
      <form
        ref={formRef}
        className="connection-modal multi-execute-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        noValidate
        tabIndex={-1}
        onSubmit={event => {
          event.preventDefault()
          event.stopPropagation()
          submitChoice()
        }}
        onKeyDown={handleKeyDown}
      >
        <div className="connection-heading multi-exec-heading">
          <div className="multi-exec-title-group">
            <Icon name={isBigQuery ? 'bigquery' : 'server'} className="multi-exec-engine-icon" />
            <h2 id={titleId}>Execute across {request.targets.length} {engineNoun}</h2>
            {hasProd && (
              <StatusPill
                variant="tag"
                size="small"
                tone="critical"
                label={prodCount === 1 ? 'Includes PROD' : `${prodCount} PROD`}
              />
            )}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close Execute Dialog"
            onClick={onCancel}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="connection-scroll multi-exec-scroll" id={descId}>
          <div className="multi-exec-targets" aria-label="Target connections">
            {visibleTargets.map(target => (
              <TargetChip key={target.targetKey} target={target} />
            ))}
            {hiddenTargetCount > 0 && (
              <button
                type="button"
                className="multi-exec-more-toggle"
                aria-expanded={showAllTargets}
                onClick={() => setShowAllTargets(current => !current)}
              >
                {showAllTargets ? 'Show fewer' : `+${hiddenTargetCount} more`}
              </button>
            )}
          </div>

          {(classification.tags.length > 0 || (!isBigQuery && classification.batchCount > 1)) && (
            <div className="multi-exec-detected" aria-label="Detected statements">
              <span className="multi-exec-detected-label">Detected:</span>
              {!isBigQuery && classification.batchCount > 1 && (
                <span className="multi-exec-stmt-tag">{classification.batchCount} batches</span>
              )}
              {classification.tags.map(tag => (
                <span key={tag} className="multi-exec-stmt-tag">{tag}</span>
              ))}
            </div>
          )}

          {txBlockReason && (
            <div className="multi-exec-banner" data-tone="warning" role="status">
              <Icon name="warning" />
              <span>{txBlockReason}</span>
            </div>
          )}

          <fieldset className="multi-exec-modes">
            <legend className="visually-hidden">Execution mode</legend>

            <label className={`multi-exec-mode-card${txDisabled ? ' is-disabled' : effectiveMode === 'transaction' ? ' is-picked' : ''}`}>
              <input
                ref={txRadioRef}
                type="radio"
                name="multiExecuteMode"
                value="transaction"
                disabled={txDisabled}
                checked={effectiveMode === 'transaction'}
                onChange={() => setMode('transaction')}
              />
              <div className="multi-exec-mode-body">
                <div className="multi-exec-mode-head">
                  <strong>{isBigQuery ? 'Coordinated Transaction (Session DML)' : 'Coordinated Transaction'}</strong>
                  <StatusPill
                    variant="tag"
                    size="small"
                    tone={txDisabled ? 'warning' : 'success'}
                    label={txDisabled ? 'Unavailable' : 'All succeed or all roll back'}
                  />
                </div>
                <p className="multi-exec-mode-desc">{txDescription}</p>
                <p className="multi-exec-mode-caveat field-note">{txCaveat}</p>
              </div>
            </label>

            <label className={`multi-exec-mode-card${effectiveMode === 'fireAndForget' ? ' is-picked' : ''}`}>
              <input
                ref={fafRadioRef}
                type="radio"
                name="multiExecuteMode"
                value="fireAndForget"
                checked={effectiveMode === 'fireAndForget'}
                onChange={() => setMode('fireAndForget')}
              />
              <div className="multi-exec-mode-body">
                <div className="multi-exec-mode-head">
                  <strong>Fire and Forget</strong>
                  <StatusPill
                    variant="tag"
                    size="small"
                    tone="neutral"
                    label={effectiveMode === 'fireAndForget' && sequential ? 'Sequential' : 'Independent execution, no rollback'}
                  />
                </div>
                <p className="multi-exec-mode-desc">
                  Runs independently on each target and reports per-target results and messages. Failures on one target never roll back peers.
                </p>
              </div>
            </label>
          </fieldset>

          {(effectiveMode === 'fireAndForget' || isBigQuery) && (
            <div className="multi-exec-options">
              {effectiveMode === 'fireAndForget' && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={sequential}
                    onChange={event => setSequential(event.target.checked)}
                  />
                  <span>Sequential rollout (stop on first error)</span>
                </label>
              )}
              {isBigQuery && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    disabled={hasEmulator}
                    checked={!hasEmulator && preflightDryRun}
                    onChange={event => setPreflightDryRun(event.target.checked)}
                  />
                  <span>Pre-flight Dry Run (free)</span>
                </label>
              )}
              {!isBigQuery && effectiveMode === 'fireAndForget' && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={stopOnError}
                    onChange={event => setStopOnError(event.target.checked)}
                  />
                  <span>Stop on first batch error per server</span>
                </label>
              )}
            </div>
          )}

          {isBigQuery && costSummary && (
            <section className="multi-exec-cost" aria-label="Estimated BigQuery Cost">
              <div className="multi-exec-cost-head">
                <strong>Estimated BigQuery Cost</strong>
                <span className="multi-exec-cost-summary">
                  {costSummary.estimating > 0
                    ? `Estimating ${request.targets.length - costSummary.estimating} of ${request.targets.length} projects…`
                    : costSummary.doneCount > 0
                      ? request.prices
                        ? `Total: ${formatBytes(costSummary.totalBytes)} (about ${formatDollars(costSummary.totalBytes)} on demand)`
                        : `Total: ${formatBytes(costSummary.totalBytes)}`
                      : 'Estimates unavailable'}
                </span>
              </div>

              <ul className="multi-exec-cost-list">
                {request.targets.map(target => (
                  <CostTargetRow
                    key={target.targetKey}
                    target={target}
                    state={estimates[target.targetKey] ?? { status: 'estimating' }}
                    prices={request.prices}
                    warnIncomplete={request.warnIncomplete !== false}
                  />
                ))}
              </ul>

              <p className="field-note multi-exec-cost-note">
                Free dry runs bill $0.{request.prices ? ' Projects using reserved capacity are not billed per byte.' : ''}
              </p>
            </section>
          )}
        </div>

        <DialogFooter
          status={<span className="sub-dialog-status">Prompted on every multi-target execute.</span>}
          trailing={
            <>
              <button type="submit" className={hasProd && isMutation ? 'primary multi-exec-submit-prod' : 'primary'}>
                <Icon name="play" />
                <span>{submitLabel}</span>
              </button>
              <button type="button" onClick={onCancel}>Cancel</button>
            </>
          }
        />
      </form>
    </div>
  )

  return createPortal(dialog, ownerDocument.body)
}

function TargetChip({ target }: { readonly target: MultiExecuteTargetItem }) {
  const scope = target.provider === 'bigquery' ? target.dataset : target.database
  return (
    <span className="multi-exec-target-chip">
      {target.color && <span className="multi-exec-target-dot" style={{ backgroundColor: target.color }} aria-hidden="true" />}
      <strong className="multi-exec-target-label">{target.label}</strong>
      {scope && <span className="multi-exec-target-scope">({scope})</span>}
      {target.environment && <EnvironmentTag environment={target.environment} place="list" about={target.label} />}
    </span>
  )
}

function CostTargetRow({
  target,
  state,
  prices,
  warnIncomplete
}: {
  readonly target: MultiExecuteTargetItem
  readonly state: TargetEstimateState
  readonly prices: boolean
  readonly warnIncomplete: boolean
}) {
  const exceedsCap = state.status === 'done'
    && !state.result.faked
    && target.maximumBytesBilled !== undefined
    && state.result.bytesProcessed > target.maximumBytesBilled

  const exceedsThreshold = state.status === 'done'
    && !state.result.faked
    && target.costPrompt !== false
    && target.costThresholdBytes !== undefined
    && state.result.bytesProcessed > target.costThresholdBytes

  const incomplete = state.status === 'done' && !state.result.faked && warnIncomplete
    ? state.result.incomplete
    : undefined

  return (
    <li className="multi-exec-cost-row">
      <div className="multi-exec-cost-row-head">
        <span className="multi-exec-cost-project">
          <strong>{target.label}</strong>
          {target.dataset && <span className="multi-exec-target-scope"> ({target.dataset})</span>}
          {target.environment && <EnvironmentTag environment={target.environment} place="list" about={target.label} />}
        </span>
        <span className="multi-exec-cost-value">
          {state.status === 'estimating' && 'Estimating…'}
          {state.status === 'done' && (state.result.faked ? 'Emulator (0 B)' : pricedBytes(state.result.bytesProcessed, prices))}
          {state.status === 'error' && 'Dry run error'}
          {state.status === 'unavailable' && 'Unavailable'}
        </span>
      </div>

      {state.status === 'error' && (
        <div className="multi-exec-cost-warning" data-tone="critical" role="status">
          <Icon name="error" />
          <span>{state.message}</span>
        </div>
      )}

      {state.status === 'unavailable' && (
        <div className="field-note">{state.message}</div>
      )}

      {exceedsCap && target.maximumBytesBilled !== undefined && (
        <div className="multi-exec-cost-warning" data-tone="critical" role="status">
          <Icon name="error" />
          <span>Exceeds maximum bytes billed ({formatBytes(target.maximumBytesBilled)}). BigQuery will refuse this job.</span>
        </div>
      )}

      {exceedsThreshold && target.costThresholdBytes !== undefined && (
        <div className="multi-exec-cost-warning" data-tone="warning" role="status">
          <Icon name="warning" />
          <span>
            Exceeds {target.ownCostThreshold ? 'connection ' : 'cost '}threshold ({formatBytes(target.costThresholdBytes)}).
          </span>
        </div>
      )}

      {incomplete && (
        <div className="multi-exec-cost-warning" data-tone="info" role="status">
          <Icon name="info" />
          <span>{incompleteText[incomplete]}</span>
        </div>
      )}
    </li>
  )
}
