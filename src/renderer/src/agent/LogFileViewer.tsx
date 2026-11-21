// The Log File Viewer for job history (AG-5a, docs/sql-server-agent.md): the header (where, the live pill, Refresh and Delete
// History), Agent's banner while it cannot run jobs, Select logs (the checked jobs) beside the filters, the runs grid, the selected
// run's rows and the details pane with the whole message, and Delete History's confirmation. Both grids are LiveGridPane (the
// results grid's GridView, no React per row). LogViewerService keeps every state; this only draws it.
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { agentHistoryProbe, historyMaxStep, historyOutcomeLabels, historyOutcomes, historyUnitLabels, historyWindows, logViewerTitle, type AgentPurgeUnit, type HistoryOutcome } from '../../../shared/agent/history'
import { agentBanner } from '../../../shared/agent/jobs'
import { agentLimits } from '../../../shared/agent/catalog'
import { liveProbes, type LiveTone } from '../../../shared/live/catalog'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import SubDialog from '../dialogs/SubDialog'
import Icon from '../Icon'
import { Chip, ChipGroup } from '../kit/Chip'
import DocumentFrame from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import InlineError from '../kit/InlineError'
import { LivePill, StaleBadge } from '../kit/LivePill'
import { LiveGridPane } from '../live/LiveGridPane'
import type { LiveSnapshot } from '../live/LiveService'
import { probePillStatus } from '../live/status'
import { formatCount, plural } from '../results/status'
import type { LogViewerState } from './LogViewerService'

const historySpec = liveProbes[agentHistoryProbe]
const noSubscribe = () => () => {}
const noLive: LiveSnapshot = { status: 'connecting', probes: {}, connectionId: '' }
const noLiveSnapshot = () => noLive
const toneWords: Partial<Record<LiveTone, string>> = { error: 'failed', running: 'in progress', warning: 'retry or unknown', muted: 'canceled' }
const toneLabel = (tone: LiveTone): string | undefined => toneWords[tone]

/** The message filter: sent when typing pauses, on Enter, or on leaving it; Escape puts back what was sent. */
function TextBox({ id, value, onCommit }: { readonly id: string; readonly value: string; readonly onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value)
  const commit = useRef(onCommit)
  commit.current = onCommit
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (draft === value) return
    const timer = window.setTimeout(() => commit.current(draft), 300)
    return () => window.clearTimeout(timer)
  }, [draft, value])
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); onCommit(draft) }
    else if (event.key === 'Escape' && draft !== value) { event.preventDefault(); event.stopPropagation(); setDraft(value) }
  }
  const inputId = `agent-history-${id}-text`
  return <span className="activity-filter-box">
    <Icon name="search" />
    <label htmlFor={inputId} className="visually-hidden">Message contains</label>
    <input id={inputId} type="search" spellCheck={false} placeholder="Message contains" value={draft} maxLength={agentLimits.searchChars} onChange={event => setDraft(event.target.value)} onKeyDown={keyDown}
      onBlur={() => { if (draft !== value) onCommit(draft) }} />
  </span>
}

/** Select logs: All jobs (checked, unchecked or mixed) and each job the login sees. */
function Sources({ documentId, state }: { readonly documentId: string; readonly state: LogViewerState }) {
  const service = useWorkbench().logViewer
  const all = service.allChecked(documentId)
  const allBox = useRef<HTMLInputElement>(null)
  useEffect(() => { if (allBox.current) allBox.current.indeterminate = all === 'mixed' }, [all])
  return <section className="agent-history-sources" aria-label="Select logs">
    <h3>Select logs</h3>
    <label className="agent-history-source all">
      <input ref={allBox} type="checkbox" checked={all === true} aria-checked={all === 'mixed' ? 'mixed' : all} onChange={() => service.toggleJob(documentId, undefined)} />
      <span>All jobs</span>
    </label>
    <ul>
      {state.jobs.map(job => <li key={job.id}>
        <label className="agent-history-source" title={job.owner ? `Owner: ${job.owner}` : undefined}>
          <input type="checkbox" checked={service.isChecked(documentId, job.id)} onChange={() => service.toggleJob(documentId, job.id)} />
          <span>{job.name}</span>
          {job.running && <span className="agent-history-running" aria-label="running"><Icon name="loading" /></span>}
        </label>
      </li>)}
    </ul>
    {state.note && <p className="agent-history-note" role="status">{state.note}</p>}
  </section>
}

/** Delete History's confirmation: the jobs, all or only older rows, and that it cannot be undone. Cancel takes focus. */
function DeleteDialog({ documentId, state }: { readonly documentId: string; readonly state: LogViewerState }) {
  const service = useWorkbench().logViewer
  const confirm = state.confirm
  if (!confirm) return null
  const jobs = service.checkedJobs(documentId)
  const textId = `agent-history-${documentId}-delete-text`
  const shown = jobs.slice(0, 8)
  return <SubDialog title="Delete History" okLabel={confirm.running ? 'Deleting…' : 'Delete'} okDisabled={confirm.running} destructive alert describedBy={textId}
    onOk={() => void service.confirmDelete(documentId)} onCancel={() => service.cancelDelete(documentId)}
    status={confirm.error && <span role="alert">{confirm.error.message}</span>}>
    <p id={textId}>Delete the job history of {jobs.length === 1 ? 'this job' : `these ${formatCount(jobs.length)} jobs`} on {state.label}? This cannot be undone.</p>
    <ul className="agent-history-delete-jobs">
      {shown.map(job => <li key={job.id}>{job.name}</li>)}
      {jobs.length > shown.length && <li>and {formatCount(jobs.length - shown.length)} more</li>}
    </ul>
    <fieldset className="agent-history-delete-scope" disabled={confirm.running}>
      <legend>Delete</legend>
      <label><input type="radio" name={`${textId}-scope`} checked={confirm.scope === 'all'} onChange={() => service.setConfirm(documentId, { scope: 'all' })} /> All of their history</label>
      <label><input type="radio" name={`${textId}-scope`} checked={confirm.scope === 'older'} onChange={() => service.setConfirm(documentId, { scope: 'older' })} /> Only history older than</label>
      <span className="agent-history-delete-older">
        <input type="number" aria-label="Older than" min={1} max={agentLimits.purgeCount} value={confirm.count} disabled={confirm.scope !== 'older'}
          onChange={event => service.setConfirm(documentId, { count: Number(event.target.value) })} />
        <select aria-label="Unit" value={confirm.unit} disabled={confirm.scope !== 'older'} onChange={event => service.setConfirm(documentId, { unit: Number(event.target.value) as AgentPurgeUnit })}>
          {([1, 2, 3] as const).map(unit => <option key={unit} value={unit}>{historyUnitLabels[unit]}</option>)}
        </select>
      </span>
    </fieldset>
    <p className="agent-history-delete-note">The cut-off is counted back from the server's clock, as SQL Server Agent Properties' Delete old history does.</p>
  </SubDialog>
}

/** A Log File Viewer document. */
export default function LogFileViewer({ documentId }: { readonly documentId: string }) {
  const workbench = useWorkbench()
  const service = workbench.logViewer
  const { documents } = useServiceSnapshot(service)
  const state = documents[documentId]
  const handle = service.handle(documentId)
  const live = useSyncExternalStore(handle?.subscribe ?? noSubscribe, handle?.getSnapshot ?? noLiveSnapshot, handle?.getSnapshot ?? noLiveSnapshot)
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [state?.message?.key])
  if (!state || !handle) return <EmptyState className="workspace-empty" icon="history" title={logViewerTitle} detail="This document has closed." />
  const probe = live.probes[agentHistoryProbe]
  const runs = handle.table(agentHistoryProbe, 0)
  const rows = runs?.descriptor.rowsAvailable
  const end = service.ended(documentId)
  const banner = agentBanner(service.availability(documentId), state.service, false, false)
  const historyError = probe?.error?.tables?.includes(0) ? probe.error : undefined
  const failure = !end && probe?.error && !probe.error.tables && probe.error.code !== 'AGENT_DISABLED' && (probe.state === 'failing' || probe.state === 'stale') ? probe.error : undefined
  const unavailable = probe?.state === 'unavailable' ? probe.note ?? 'The Log File Viewer is not available on this server.' : undefined
  const stale = !end && (probe?.state === 'stale' || (probe?.state === 'failing' && !probe.error?.tables)) ? { since: probe?.lastSampleAt ?? Date.now() } : undefined
  const filtersOn = service.activeFilters(documentId)
  const none = state.checked?.length === 0
  const maxRows = state.caps?.maxRows, perJob = state.caps?.perJob
  const message = state.message
  const verbs = [
    { command: 'agent.refreshHistory' as const, args: { tabId: documentId }, label: 'Refresh' },
    { command: 'agent.deleteHistory' as const, args: { tabId: documentId }, label: 'Delete History…' }
  ]
  const copy = () => { if (message?.state === 'ready') void window.varia.writeClipboardText(message.text ?? '').then(result => setCopied(result.ok), () => setCopied(false)) }
  return <DocumentFrame id={`agent-history-${documentId}`} title={logViewerTitle} subtitle="Job history"
    crumbs={[{ label: state.label }, { label: 'SQL Server Agent' }]}
    state={<LivePill {...probePillStatus(live, agentHistoryProbe, historySpec.intervalMs.default)} />}
    tools={stale && <StaleBadge updatedAt={probe?.lastSampleAt} stale={stale} />} verbs={verbs} attributes={{ 'data-agent-history': documentId }}>
    <div className="agent-history">
      {banner && <div className="agent-banner" role="status"><Icon name="warning" /><span>{banner.text}</span></div>}
      {state.deleted && <div className="agent-history-deleted" role="status">
        <Icon name="check" /><span>{state.deleted}</span>
        <button type="button" aria-label="Close the Delete History result" onClick={() => service.closeDeleted(documentId)}><Icon name="close" /></button>
      </div>}
      {end ? <div className="agent-history-ended">
        {end.denied ? <div role="status"><EmptyState icon="lock" title="No access to SQL Server Agent" detail={end.message} /></div>
          : <InlineError role="status" message={end.message} code={end.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />}
      </div> : <div className="agent-history-body">
        <Sources documentId={documentId} state={state} />
        <div className="agent-history-main">
          {failure && <InlineError role="status" message={failure.message} code={failure.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />}
          <div className="activity-pane-tools one-row agent-history-tools" role="toolbar" aria-label="History filters">
            <ChipGroup label="Window" dense>
              {historyWindows.map(window => <Chip key={window.label} label={window.label} pressed={state.days === window.days} onToggle={() => service.setDays(documentId, window.days)} />)}
            </ChipGroup>
            <label className="agent-history-select">
              <span>Outcome</span>
              <select aria-label="Outcome" value={state.outcome ?? ''} onChange={event => service.setOutcome(documentId, (event.target.value || undefined) as HistoryOutcome | undefined)}>
                <option value="">All</option>
                {historyOutcomes.map(outcome => <option key={outcome} value={outcome}>{historyOutcomeLabels[outcome]}</option>)}
              </select>
            </label>
            <TextBox id={documentId} value={state.text} onCommit={text => service.setText(documentId, text)} />
            <label className="agent-history-select">
              <span>Step</span>
              <input type="number" aria-label="Step" min={0} max={historyMaxStep} placeholder="Any" value={state.step ?? ''} className="agent-history-step"
                onChange={event => { const value = event.target.value === '' ? undefined : Math.trunc(Number(event.target.value)); service.setStep(documentId, value !== undefined && value >= 0 && value <= historyMaxStep ? value : undefined) }} />
            </label>
            <button type="button" className="activity-tool icon-only" disabled={filtersOn === 0} onClick={() => service.clearFilters(documentId)}
              aria-label="Clear filters" title="Clear filters: the window, the outcome, the message text and the step"><Icon name="clear-all" /></button>
          </div>
          <div className="agent-history-grid">
            {unavailable ? <EmptyState icon="history" title="The Log File Viewer is not available" detail={unavailable} />
              : none ? <EmptyState icon="history" title="No job checked" detail="Check one or more jobs in Select logs to see their history." />
              : historyError ? <InlineError role="status" message={historyError.message} code={historyError.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />
              : <>
                <LiveGridPane live={handle} probe={agentHistoryProbe} label="Runs" toneLabel={toneLabel} state={service.gridState(documentId, 0)} onGrid={grid => service.attachRuns(documentId, grid)} />
                {rows === 0 && <EmptyState className="agent-history-empty" icon="history"
                  title={filtersOn ? 'No runs match the filters' : 'No runs'}
                  detail={filtersOn ? 'Clear the filters to see every run in the history.' : 'The checked jobs have no history in this window.'}
                  actions={filtersOn ? [{ label: 'Clear filters', run: () => service.clearFilters(documentId), primary: true }] : []} />}
              </>}
          </div>
          {runs?.descriptor.truncated && <p className="agent-history-note" role="note">Only the newest {formatCount(agentLimits.historyRows)} history rows were read: narrow the window or check fewer jobs to see older runs.</p>}
          {(maxRows !== undefined || perJob !== undefined) && <p className="agent-history-caps" role="note">
            SQL Server Agent keeps {maxRows === undefined || maxRows < 0 ? 'every history row' : `at most ${formatCount(maxRows)} history ${plural(maxRows, 'row')}`}{perJob !== undefined && maxRows !== undefined && maxRows >= 0 ? `, ${formatCount(perJob)} per job` : ''}.
          </p>}
          {state.run && <section className="agent-history-run" aria-label="Selected run">
            <LiveGridPane live={handle} probe={agentHistoryProbe} table={1} label="Run steps" toneLabel={toneLabel} state={service.gridState(documentId, 1)} onGrid={grid => service.attachSteps(documentId, grid)} />
            <div className="agent-history-details" role="region" aria-label="Message details">
              <div className="agent-history-details-head">
                <strong>{state.selectedStep ? `Step ${state.selectedStep.stepId}: ${state.selectedStep.name}` : 'Job outcome'}</strong>
                {state.selectedStep && <span>{[state.selectedStep.outcome, state.selectedStep.started, state.selectedStep.duration].filter(Boolean).join(' · ')}</span>}
                <button type="button" disabled={message?.state !== 'ready'} onClick={copy} aria-label="Copy the message" title="Copy the message">
                  <Icon name={copied ? 'check' : 'copy'} />{copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              {message?.state === 'failed' ? <InlineError role="status" message={message.text ?? 'The message could not be read.'} actions={[{ label: 'Retry', run: () => service.retryMessage(documentId) }]} />
                : message?.state === 'ready' ? <pre className="agent-history-message" tabIndex={0}>{message.text || '(No message)'}</pre>
                : <p className="agent-history-message-empty" role="status">Reading the message…</p>}
            </div>
          </section>}
        </div>
      </div>}
      <DeleteDialog documentId={documentId} state={state} />
    </div>
  </DocumentFrame>
}
