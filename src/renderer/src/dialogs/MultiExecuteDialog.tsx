import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { formatBytes, formatDollars } from '../../../shared/bigquery/cost'
import { dryRunLimits, gibibytes, incompleteText, pricedBytes, type BigQueryDryRunResult } from '../../../shared/bigquery/dry-run'
import { environmentPreset } from '../../../shared/environments'
import { classifyStatements, type StatementClassification } from '../../../shared/multi-query'
import type { ProviderId } from '../../../shared/providers'
import { focusToReturn, isElement, returnFocusTo } from '../core/focus'
import { useOptionalWorkbench } from '../core/WorkbenchContext'
import EnvironmentTag from '../EnvironmentTag'
import Icon from '../Icon'
import DialogFooter from '../kit/DialogFooter'
import StatusPill from '../kit/StatusPill'
import { useDialogWindow } from '../popouts/DialogWindow'
import { isIncompleteWarningEnabled, promptTurnLockFor } from '../services/bigquery-cost-prompt'
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
  /** When false, suppresses per-instance focus capture/return (managed by an outer modal queue wrapper). */
  readonly manageReturnFocus?: boolean
  /** Invoked on mount right before initial focus is placed (after any closing modal's cleanup has restored focus). */
  readonly onBeforeInitialFocus?: () => void
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
  hasEmulator: boolean,
  startLine?: number
): string | undefined {
  const lineOffset = Math.max(0, (startLine ?? 1) - 1)
  const formatLocation = (statement: StatementClassification['firstBlockingStatement']) =>
    statement ? `Line ${statement.line + lineOffset}: ${statement.keyword}` : undefined
  const blocker = classification.firstBlockingStatement
  const location = formatLocation(blocker)
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
    const ddlLocation = formatLocation(classification.statements.find(s => s.permanentDdl) ?? blocker)
    return ddlLocation
      ? `Script contains permanent BigQuery DDL (${ddlLocation}). BigQuery prohibits permanent DDL inside multi-statement transactions. Pre-flight Dry Run (free) and Sequential rollout are pre-selected below.`
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
const noopSubscribe = () => () => {}
const noopSnapshot = () => undefined

function focusCandidate(): HTMLElement | null {
  const candidate = focusToReturn()
  return candidate && candidate !== candidate.ownerDocument.body && !candidate.closest('[aria-modal="true"]') ? candidate : null
}

/**
 * Connected Run Mode Prompt modal mounted once in App.tsx's modal layer. Subscribes to `MultiExecutePromptService`
 * and renders `MultiExecuteDialogModal` whenever a same-engine multi-target execution (`>= 2` targets) awaits confirmation.
 */
export default function MultiExecuteDialog({ service, estimateBigQuery }: MultiExecuteDialogProps) {
  const { pending } = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)
  const costPrompts = useOptionalWorkbench()?.costPrompts
  const turnLock = costPrompts ? promptTurnLockFor(costPrompts) : undefined
  const turnOwner = useSyncExternalStore(
    turnLock?.subscribe ?? noopSubscribe,
    turnLock?.getSnapshot ?? noopSnapshot,
    turnLock?.getSnapshot ?? noopSnapshot
  )
  const hasPending = !!pending
  const returnFocus = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  const needsRevalidate = !wasOpen.current && hasPending && (!turnLock || turnOwner === 'multi') && !service.headStillValid()
  const isOpen = hasPending && (!turnLock || turnOwner === 'multi') && !needsRevalidate
  if (isOpen && !wasOpen.current) {
    // Ignore elements inside a closing modal (e.g. BigQueryCostPrompt unmounting in the same render);
    // MultiExecuteDialogModal re-captures focus via onBeforeInitialFocus once the closing modal's cleanup restores it.
    returnFocus.current = focusCandidate()
  }
  wasOpen.current = isOpen

  useLayoutEffect(() => {
    if (needsRevalidate) service.revalidate()
  }, [service, needsRevalidate, pending?.id])

  useEffect(() => {
    if (!isOpen) return
    return () => {
      const target = returnFocus.current
      returnFocus.current = null
      returnFocusTo(target)
    }
  }, [isOpen])

  // Declared after returnFocus cleanup so focus returns to the underlying surface before handing the turn to a waiting peer.
  useEffect(() => {
    if (!turnLock) return
    if (hasPending) {
      turnLock.claim('multi')
      return () => { turnLock.release('multi') }
    }
    turnLock.release('multi')
    return undefined
  }, [turnLock, hasPending])

  if (!isOpen || !pending) return null
  return (
    <MultiExecuteDialogModal
      key={pending.id}
      request={pending.request}
      estimateBigQuery={estimateBigQuery}
      manageReturnFocus={false}
      onBeforeInitialFocus={() => {
        if (!returnFocus.current?.isConnected) {
          const candidate = focusCandidate()
          if (candidate) returnFocus.current = candidate
        }
      }}
      onConfirm={choice => service.answer(pending.id, choice)}
      onCancel={() => service.cancel(pending.id)}
    />
  )
}

/**
 * Run Mode Prompt dialog (`docs/multi-server-query.md`) for same-engine multi-target runs (`>= 2` targets).
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
  estimateBigQuery = defaultEstimator,
  manageReturnFocus = true,
  onBeforeInitialFocus
}: MultiExecuteDialogModalProps) {
  const { ownerDocument } = useDialogWindow()
  const workbench = useOptionalWorkbench()
  const settingsSnap = useSyncExternalStore(
    workbench?.settings?.subscribe ?? noopSubscribe,
    workbench?.settings ? () => workbench.settings.getSnapshot() : noopSnapshot,
    workbench?.settings ? () => workbench.settings.getSnapshot() : noopSnapshot
  )
  const connectionsSnap = useSyncExternalStore(
    workbench?.connections?.subscribe ?? noopSubscribe,
    workbench?.connections ? () => workbench.connections.getSnapshot() : noopSnapshot,
    workbench?.connections ? () => workbench.connections.getSnapshot() : noopSnapshot
  )
  const costSnap = useSyncExternalStore(
    workbench?.bigQueryCost?.subscribe ?? noopSubscribe,
    workbench?.bigQueryCost ? () => workbench.bigQueryCost.getSnapshot() : noopSnapshot,
    workbench?.bigQueryCost ? () => workbench.bigQueryCost.getSnapshot() : noopSnapshot
  )
  const titleId = useId()
  const descId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const txRadioRef = useRef<HTMLInputElement>(null)
  const fafRadioRef = useRef<HTMLInputElement>(null)
  const preflightCheckboxRef = useRef<HTMLInputElement>(null)
  const returnFocus = useRef(manageReturnFocus ? focusToReturn() : null)

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
    () => transactionDisableReason(request.provider, classification, hasEmulator, request.startLine),
    [request.provider, classification, hasEmulator, request.startLine]
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

  // When Coordinated Transaction or Pre-flight Dry Run becomes disabled while focused, move focus to Fire and Forget so Escape/Tab never break.
  useEffect(() => {
    if (!txDisabled && !hasEmulator) return
    const active = ownerDocument.activeElement
    if (!active || active === ownerDocument.body || (txDisabled && active === txRadioRef.current) || (hasEmulator && active === preflightCheckboxRef.current)) {
      fafRadioRef.current?.focus()
    }
  }, [txDisabled, hasEmulator, ownerDocument])

  // Initial focus lands on the active radio input (never on Execute); focus returns on unmount when managed locally.
  useEffect(() => {
    onBeforeInitialFocus?.()
    const initialRadio = mode === 'transaction' && !txDisabled ? txRadioRef.current : fafRadioRef.current
    initialRadio?.focus()
    if (!manageReturnFocus) return
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
            ...target.dataset ? { dataset: target.dataset } : { noDefaultDataset: true as const }
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

  const livePrices = settingsSnap ? settingsSnap.values['queryExecution.bigQuery.showCost'] !== 'bytes' : request.prices
  const liveWarnIncomplete = workbench?.settings
    ? isIncompleteWarningEnabled(workbench.settings)
    : (request.warnIncomplete !== false)
  const liveTargets = useMemo(() => {
    if (!isBigQuery || !settingsSnap) return request.targets
    const defaultCap = gibibytes(settingsSnap.values['queryExecution.bigQuery.maximumBytesBilled'])
    const globalCostPrompt = settingsSnap.values['queryExecution.bigQuery.costPrompt']
    const globalThresholdGiB = settingsSnap.values['queryExecution.bigQuery.costThreshold']
    return request.targets.map(target => {
      const connection = workbench?.connections?.get(target.connectionId)
      const ownCap = connection?.options.provider === 'bigquery' ? connection.options.maximumBytesBilled : undefined
      const cap = ownCap ?? defaultCap
      const ownThresholdGiB = connection && workbench?.costOptOut ? workbench.costOptOut.threshold(connection) : undefined
      const ownCostThreshold = connection ? ownThresholdGiB !== undefined : !!target.ownCostThreshold
      const costThresholdBytes = connection
        ? (gibibytes(ownThresholdGiB ?? globalThresholdGiB) ?? 0)
        : (target.ownCostThreshold ? target.costThresholdBytes : (gibibytes(globalThresholdGiB) ?? target.costThresholdBytes))
      const asks = connection && workbench?.costOptOut
        ? (globalCostPrompt && workbench.costOptOut.asks(connection))
        : (target.costPrompt === false ? false : globalCostPrompt)
      return {
        ...target,
        costPrompt: asks,
        costThresholdBytes,
        ownCostThreshold,
        ...cap !== undefined ? { maximumBytesBilled: cap } : { maximumBytesBilled: undefined }
      }
    })
  }, [isBigQuery, request.targets, settingsSnap, connectionsSnap, costSnap, workbench?.connections, workbench?.costOptOut])

  const costSummary = useMemo(() => {
    if (!isBigQuery) return undefined
    let estimating = 0
    let doneCount = 0
    let fakedCount = 0
    let errorCount = 0
    let totalBytes = 0
    let thresholdWarnings = 0
    let capWarnings = 0
    let incompleteWarnings = 0
    for (const target of liveTargets) {
      const state = estimates[target.targetKey]
      if (!state || state.status === 'estimating') { estimating++; continue }
      if (state.status === 'error') { errorCount++; continue }
      if (state.status !== 'done') continue
      if (state.result.faked) { fakedCount++; continue }
      doneCount++
      totalBytes += state.result.bytesProcessed
      if (target.maximumBytesBilled !== undefined && state.result.bytesProcessed > target.maximumBytesBilled) capWarnings++
      if (target.costPrompt !== false && target.costThresholdBytes !== undefined && state.result.bytesProcessed > target.costThresholdBytes) thresholdWarnings++
      if (liveWarnIncomplete && state.result.incomplete !== undefined) incompleteWarnings++
    }
    return { estimating, doneCount, fakedCount, errorCount, totalBytes, thresholdWarnings, capWarnings, incompleteWarnings }
  }, [isBigQuery, liveTargets, liveWarnIncomplete, estimates])

  const estimatingBigQuery = isBigQuery && (costSummary?.estimating ?? 0) > 0
  const hasCostWarning = (costSummary?.thresholdWarnings ?? 0) > 0
    || (costSummary?.capWarnings ?? 0) > 0
    || (costSummary?.incompleteWarnings ?? 0) > 0
    || (costSummary?.errorCount ?? 0) > 0

  const submitChoice = () => {
    if (estimatingBigQuery) return
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
    // Keyboard safety: when PROD + mutation, cost warnings, or in-flight BigQuery dry runs are present, a stray Enter on a radio/checkbox must not submit immediately.
    if (event.key === 'Enter' && ((hasProd && isMutation) || hasCostWarning || estimatingBigQuery) && isElement(event.target) && event.target.tagName === 'INPUT') {
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

  const batchTag = !isBigQuery && classification.batchCount > 1 ? `${classification.batchCount} batches` : undefined
  const detectedTags = batchTag && !classification.tags.includes(batchTag)
    ? [batchTag, ...classification.tags]
    : classification.tags

  const txDescription = isBigQuery
    ? 'Opens an ephemeral BigQuery session with BEGIN TRANSACTION on each project. Waits at the commit barrier and commits all only if every project succeeds — otherwise rolls back and aborts sessions.'
    : 'Opens a local transaction (SET XACT_ABORT ON; BEGIN TRANSACTION) on each SQL Server in parallel (no MSDTC). Waits at the commit barrier and commits all only if every server succeeds — otherwise rolls back all peers.'

  const txCaveat = isBigQuery
    ? 'BigQuery still bills bytes processed on rolled-back jobs. A drop during the final COMMIT step itself is reported as CommitInDoubt.'
    : 'Cross-platform coordinated local transactions (no MSDTC required). Holds locks until the slowest peer finishes; a drop during final COMMIT is reported as CommitInDoubt.'

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

        <div className="connection-scroll multi-exec-scroll">
          <div className="multi-exec-targets" role="group" aria-label="Target connections">
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

          {detectedTags.length > 0 && (
            <div className="multi-exec-detected" role="group" aria-label="Detected statements">
              <span className="multi-exec-detected-label">Detected:</span>
              {detectedTags.map(tag => (
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
                <label className="checkbox-label" title={hasEmulator ? 'BigQuery emulator connections do not support dry-run estimation.' : undefined}>
                  <input
                    ref={preflightCheckboxRef}
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
                      ? `${costSummary.doneCount < liveTargets.length ? `Total (${costSummary.doneCount} of ${liveTargets.length} estimated)` : 'Total'}: ${formatBytes(costSummary.totalBytes)}${livePrices ? ` (about ${formatDollars(costSummary.totalBytes)} on demand)` : ''}`
                      : costSummary.fakedCount > 0
                        ? 'Emulator (estimates unavailable)'
                        : 'Estimates unavailable'}
                </span>
              </div>

              <ul className="multi-exec-cost-list">
                {liveTargets.map(target => (
                  <CostTargetRow
                    key={target.targetKey}
                    target={target}
                    state={estimates[target.targetKey] ?? { status: 'estimating' }}
                    prices={livePrices}
                    warnIncomplete={liveWarnIncomplete}
                  />
                ))}
              </ul>

              <p className="field-note multi-exec-cost-note">
                Free dry runs bill $0.{livePrices ? ' Projects using reserved capacity are not billed per byte.' : ''}
              </p>
            </section>
          )}
        </div>

        <DialogFooter
          status={<span id={descId} className="sub-dialog-status">Prompted on every multi-target execute.</span>}
          trailing={
            <>
              <button type="submit" disabled={estimatingBigQuery} title={estimatingBigQuery ? 'Waiting for BigQuery dry-run cost estimates to finish.' : undefined} className={hasProd && isMutation ? 'primary multi-exec-submit-prod' : 'primary'}>
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
  const theme = useOptionalWorkbench()?.theme
  useSyncExternalStore(theme?.subscribe ?? noopSubscribe, theme?.getSnapshot ?? noopSnapshot, theme?.getSnapshot ?? noopSnapshot)
  const color = theme?.accent(target.color) ?? target.color
  const scope = target.provider === 'bigquery' ? target.dataset : target.database
  return (
    <span className="multi-exec-target-chip">
      {color && <span className="multi-exec-target-dot" style={{ backgroundColor: color }} aria-hidden="true" />}
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
