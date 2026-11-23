// The Log File Viewer for job history (AG-5a, docs/sql-server-agent.md): the header (where, the live pill, Refresh and Delete
// History), Agent's banner while it cannot run jobs, Select logs (the checked jobs) beside the filters, the runs grid, the selected
// run's rows and the details pane with the whole message, and Delete History's confirmation. Both grids are LiveGridPane (the
// results grid's GridView, no React per row). LogViewerService keeps every state; this only draws it. AG-5b adds the SQL Server Agent
// error logs to Select logs, their rows' grid with the selected row's message, and Recycle's confirmation.
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { agentHistoryProbe, historyMaxStep, historyOutcomeLabels, historyOutcomes, historyUnitLabels, historyWindows, logViewerTitle, type AgentPurgeUnit, type HistoryOutcome } from '../../../shared/agent/history'
import { agentBanner } from '../../../shared/agent/jobs'
import { agentLimits } from '../../../shared/agent/catalog'
import { agentErrorLogProbe, errorLogLabel, recycleText } from '../../../shared/agent/error-log'
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
import type { HistoryStep, LogViewerState } from './LogViewerService'

const historySpec = liveProbes[agentHistoryProbe]
const noSubscribe = () => () => {}
const noLive: LiveSnapshot = { status: 'connecting', probes: {}, connectionId: '' }
const noLiveSnapshot = () => noLive
const toneWords: Partial<Record<LiveTone, string>> = { error: 'failed', running: 'in progress', warning: 'retry or unknown', muted: 'canceled' }
const toneLabel = (tone: LiveTone): string | undefined => toneWords[tone]
/** The details pane's heading: the step whose message shows (the run's first row with none selected). */
const detailsHeading = (step: HistoryStep | undefined): string => !step ? 'Message' : step.stepId === '0' ? 'Job outcome' : `Step ${step.stepId}: ${step.name}`

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
    <ErrorLogSources documentId={documentId} state={state} />
    {state.note && <p className="agent-history-note" role="status">{state.note}</p>}
  </section>
}

/** Select logs' SQL Server Agent group (AG-5b): sysadmin's alone, as SSMS shows the Error Logs folder. */
function ErrorLogSources({ documentId, state }: { readonly documentId: string; readonly state: LogViewerState }) {
  const service = useWorkbench().logViewer
  const unavailable = service.errorLogsUnavailable(documentId)
  // The role could not be read: logs View Agent Log checked stay checked, so say so and offer Retry and a way to uncheck them.
  if (unavailable && state.profile.status === 'failed' && state.logs.length) return <>
    <h3>SQL Server Agent</h3>
    <InlineError role="status" message="The SQL Server Agent error logs could not be listed: this login's role could not be read."
      actions={[{ label: 'Retry', run: () => service.refresh(documentId) }, { label: 'Uncheck the logs', run: () => service.clearLogs(documentId) }]} />
  </>
  if (unavailable) return null
  const list = state.errorLogs
  return <>
    <h3>SQL Server Agent</h3>
    {list?.state === 'failed' ? <InlineError role="status" message={list.error ?? 'The error logs could not be listed.'} actions={[{ label: 'Retry', run: () => service.retryErrorLogs(documentId) }]} />
      : !list || (list.state === 'reading' && !list.logs.length) ? <p className="agent-history-note" role="status">Reading the error logs…</p>
      : <ul aria-label="SQL Server Agent error logs">
        {list.logs.map(log => <li key={log.archive}>
          <label className="agent-history-source" title={log.bytes !== undefined ? `${formatCount(log.bytes)} bytes` : undefined}>
            <input type="checkbox" checked={service.isLogChecked(documentId, log.archive)} onChange={() => service.toggleLog(documentId, log.archive)} />
            <span>{errorLogLabel(log)}</span>
          </label>
        </li>)}
      </ul>}
    {list?.state === 'ready' && list.archives === false && <p className="agent-history-note" role="note">This server lists no archived logs, so only the current one shows.</p>}
  </>
}

/** Recycle's confirmation: what it does, and that the oldest archive goes. Cancel takes focus. */
export function RecycleDialog({ documentId, state }: { readonly documentId: string; readonly state: LogViewerState }) {
  const service = useWorkbench().logViewer
  const recycle = state.recycle
  if (!recycle) return null
  const textId = `agent-history-${documentId}-recycle-text`
  return <SubDialog title={recycleText.title} okLabel={recycle.running ? 'Recycling…' : 'Recycle'} okDisabled={recycle.running || service.role(documentId) === 'unknown'} destructive alert describedBy={textId}
    onOk={() => void service.confirmRecycle(documentId)} onCancel={() => service.cancelRecycle(documentId)}
    status={recycle.error && <span role="alert">{recycle.error.message}</span>}>
    <p id={textId}>{recycleText.question}</p>
    <p className="agent-history-delete-note">Server: {state.label}</p>
  </SubDialog>
}

/** The checked error logs' rows and the selected row's message (AG-5b). */
function ErrorLogPane({ documentId, state }: { readonly documentId: string; readonly state: LogViewerState }) {
  const service = useWorkbench().logViewer
  const handle = service.errorLogHandle(documentId)
  // Redraws on every snapshot: the failure, the table and its truncation all read from the handle.
  useSyncExternalStore(handle?.subscribe ?? noSubscribe, handle?.getSnapshot ?? noLiveSnapshot, handle?.getSnapshot ?? noLiveSnapshot)
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [state.entry?.key])
  if (!handle) return null
  const table = handle.table(agentErrorLogProbe, 0)
  const rows = table?.descriptor.rowsAvailable
  // Managed Instance's reader takes no sort argument, so a capped read keeps its oldest rows (the probe's errorLogOldestFirst status).
  const oldestFirst = state.profile.status === 'ready' && state.profile.profile.platform === 'managedInstance'
  const failed = service.errorLogFailure(documentId)
  const entry = state.entry
  const copy = () => { if (entry) void window.varia.writeClipboardText(entry.message).then(result => setCopied(result.ok), () => setCopied(false)) }
  return <section className="agent-history-errorlog" aria-label="SQL Server Agent error log">
    <div className="agent-history-grid">
      {failed ? <InlineError role="status" message={failed.message} code={failed.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />
        : <>
          <LiveGridPane live={handle} probe={agentErrorLogProbe} label="Agent log" toneLabel={toneLabel} state={service.gridState(documentId, 'log')} onGrid={grid => service.attachEntries(documentId, grid)} />
          {rows === 0 && <EmptyState className="agent-history-empty" icon="output" title={state.text.trim() ? 'No log rows match the filters' : 'No log rows'}
            detail={state.text.trim() || state.days !== undefined ? 'Widen the window or clear the message text to see more of the log.' : 'The checked logs are empty.'} />}
        </>}
    </div>
    {table?.descriptor.truncated && <p className="agent-history-note" role="note">{oldestFirst
      ? `Only the oldest ${formatCount(agentLimits.logRows)} log rows were read (Managed Instance reads its log oldest first): narrow the window or the message text to see newer rows.`
      : `Only the newest ${formatCount(agentLimits.logRows)} log rows were read: narrow the window or the message text, or check fewer logs, to see older rows.`}</p>}
    {entry && <div className="agent-history-details" role="region" aria-label="Log row details">
      <div className="agent-history-details-head">
        <strong>{entry.type || 'Message'}</strong>
        <span>{[entry.source, entry.date].filter(Boolean).join(' · ')}</span>
        <button type="button" onClick={copy} aria-label="Copy the log message" title="Copy the log message">
          <Icon name={copied ? 'check' : 'copy'} />{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="agent-history-message" tabIndex={0}>{entry.message || '(No message)'}</pre>
    </div>}
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
  const logs = state.logs.length > 0
  const verbs = [
    { command: 'agent.refreshHistory' as const, args: { tabId: documentId }, label: 'Refresh' },
    { command: 'agent.deleteHistory' as const, args: { tabId: documentId }, label: 'Delete History…' },
    // Recycle (AG-5b) is sysadmin's alone: other logins never see the error logs, so the verb is not shown to them.
    ...service.role(documentId) === 'sysadmin' ? [{ command: 'agent.recycleErrorLog' as const, args: { tabId: documentId }, label: 'Recycle…' }] : []
  ]
  const copy = () => { if (message?.state === 'ready') void window.varia.writeClipboardText(message.text ?? '').then(result => setCopied(result.ok), () => setCopied(false)) }
  return <DocumentFrame id={`agent-history-${documentId}`} title={logViewerTitle} subtitle="Job history"
    crumbs={[{ label: state.label }, { label: 'SQL Server Agent' }]}
    state={<LivePill {...probePillStatus(live, agentHistoryProbe, historySpec.intervalMs.default)} />}
    tools={stale && <StaleBadge updatedAt={probe?.lastSampleAt} stale={stale} />} verbs={verbs} attributes={{ 'data-agent-history': documentId }}>
    <div className="agent-history">
      {banner && <div className="agent-banner" role="status"><Icon name="warning" /><span>{banner.text}</span></div>}
      {state.recycled && <div className="agent-history-deleted" role="status">
        <Icon name="check" /><span>{state.recycled}</span>
        <button type="button" aria-label="Close the Recycle result" onClick={() => service.closeRecycled(documentId)}><Icon name="close" /></button>
      </div>}
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
          {!(none && logs) && <div className="agent-history-grid">
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
          </div>}
          {logs && <ErrorLogPane documentId={documentId} state={state} />}
          {!none && runs?.descriptor.truncated && <p className="agent-history-note" role="note">{state.skipped
            ? `The checked jobs read first filled the ${formatCount(agentLimits.historyRows)}-row limit, so ${formatCount(state.skipped)} checked ${state.skipped === 1 ? 'job was' : 'jobs were'} not read: check fewer jobs or narrow the window.`
            : `Only the newest ${formatCount(agentLimits.historyRows)} history rows were read: narrow the window or check fewer jobs to see older runs.`}</p>}
          {(maxRows !== undefined || perJob !== undefined) && <p className="agent-history-caps" role="note">
            SQL Server Agent keeps {maxRows === undefined || maxRows < 0 ? 'every history row' : `at most ${formatCount(maxRows)} history ${plural(maxRows, 'row')}`}{perJob !== undefined && maxRows !== undefined && maxRows >= 0 ? `, ${formatCount(perJob)} per job` : ''}.
          </p>}
          {state.run && <section className="agent-history-run" aria-label="Selected run">
            <LiveGridPane live={handle} probe={agentHistoryProbe} table={1} label="Run steps" toneLabel={toneLabel} state={service.gridState(documentId, 1)} onGrid={grid => service.attachSteps(documentId, grid)} />
            <div className="agent-history-details" role="region" aria-label="Message details">
              <div className="agent-history-details-head">
                <strong>{detailsHeading(state.selectedStep ?? state.headStep)}</strong>
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
      <RecycleDialog documentId={documentId} state={state} />
    </div>
  </DocumentFrame>
}
