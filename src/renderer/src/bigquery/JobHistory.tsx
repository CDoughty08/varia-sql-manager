import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { formatBytes, formatDollars } from '../../../shared/bigquery/cost'
import {
  customRange, jobHistoryActiveFilters, jobHistoryProbe, parseStatements, jobHistoryRanges, jobHistoryStateLabels, jobHistoryStates, jobHistoryTitle, jobHistoryTypeLabels, jobHistoryTypes,
  type JobHistoryAction, type JobHistoryDetails
} from '../../../shared/bigquery/history'
import { liveProbes } from '../../../shared/live/catalog'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { Chip, ChipGroup } from '../kit/Chip'
import DocumentFrame from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import InlineError from '../kit/InlineError'
import { LivePill, StaleBadge } from '../kit/LivePill'
import Segmented from '../kit/Segmented'
import { LiveGridPane } from '../live/LiveGridPane'
import type { LiveSnapshot } from '../live/LiveService'
import { probePillStatus } from '../live/status'
import { useMenuTarget } from '../menus/useMenuTarget'
import { gridTarget } from '../grid/anchor'
import { useRuns } from '../search/SearchDetails'
import type { JobHistoryEnd, JobHistoryService, JobHistoryState } from './JobHistoryService'
import { isPermissionRefusal } from '../../../shared/bigquery/errors'

const probeSpec = liveProbes[jobHistoryProbe]
const noSubscribe = () => () => {}
const noLive: LiveSnapshot = { status: 'connecting', probes: {}, connectionId: '' }
const noLiveSnapshot = () => noLive
const scopes = [{ value: 'mine', label: 'My jobs' }, { value: 'all', label: 'All users' }] as const
const rangeFieldId = (documentId: string) => `${documentId}-jobs-range`
/** The details pane's actions, in the grid menu's order. */
const paneActions: readonly { readonly action: JobHistoryAction; readonly command: 'bigquery.openJobResults' | 'bigquery.reattachJob' | 'bigquery.openJobSql' | 'bigquery.rerunJob' | 'bigquery.cancelJob'; readonly label: string }[] = [
  { action: 'openResults', command: 'bigquery.openJobResults', label: 'Open Results' }, { action: 'reattach', command: 'bigquery.reattachJob', label: 'Re-attach' },
  { action: 'openSql', command: 'bigquery.openJobSql', label: 'Open SQL' }, { action: 'rerun', command: 'bigquery.rerunJob', label: 'Re-run…' },
  { action: 'cancel', command: 'bigquery.cancelJob', label: 'Cancel Job…' }
]

/** A filter field whose typing waits for Enter or leaving the field (each change lists or searches again); Escape puts back
 *  what applies. */
function CommitField({ id, label, value, onCommit, type = 'text', placeholder, maxLength = 128, wide }: {
  readonly id: string; readonly label: string; readonly value: string; readonly onCommit: (text: string) => void; readonly type?: 'text' | 'search' | 'datetime-local'
  readonly placeholder?: string; readonly maxLength?: number; readonly wide?: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); onCommit(draft) }
    else if (event.key === 'Escape' && draft !== value) { event.preventDefault(); event.stopPropagation(); setDraft(value) }
  }
  return <span className="ssis-filter-field">
    <label htmlFor={id}>{label}</label>
    <input id={id} type={type} spellCheck={false} value={draft} maxLength={maxLength} placeholder={placeholder} className={wide ? 'bq-jobs-field-wide' : undefined}
      onChange={event => setDraft(event.target.value)} onKeyDown={keyDown} onBlur={() => { if (draft !== value) onCommit(draft) }} />
  </span>
}

const pad = (value: number) => String(value).padStart(2, '0')
/** Epoch ms as a datetime-local field's text, in local time. */
const localText = (ms: number) => { const date = new Date(ms); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}` }
const dayMs = 24 * 60 * 60 * 1000

/** The filter bar: states and types as chips, the range, Started from Varia, the filter box and Clear filters. */
function Filters({ state, service }: { readonly state: JobHistoryState; readonly service: JobHistoryService }) {
  const { filters, id } = state
  const toggle = <T extends string>(list: readonly T[], value: T): T[] => list.includes(value) ? list.filter(item => item !== value) : [...list, value]
  const rangeValue = filters.custom ? 'custom' : String(filters.hours ?? 24)
  return <div className="ssis-filters" role="group" aria-label="Filters">
    <div className="ssis-filter-row">
      <span className="ssis-filter-label" aria-hidden="true">State</span>
      <ChipGroup label="State">
        {jobHistoryStates.map(value => <Chip key={value} label={jobHistoryStateLabels[value]} pressed={filters.states.includes(value)} onToggle={() => service.update(id, current => ({ ...current, states: toggle(current.states, value) }))} />)}
      </ChipGroup>
    </div>
    <div className="ssis-filter-row">
      <span className="ssis-filter-label" aria-hidden="true">Type</span>
      <ChipGroup label="Type">
        {jobHistoryTypes.map(value => <Chip key={value} label={jobHistoryTypeLabels[value]} pressed={filters.types.includes(value)} onToggle={() => service.update(id, current => ({ ...current, types: toggle(current.types, value) }))} />)}
      </ChipGroup>
    </div>
    <div className="ssis-filter-fields">
      <span className="ssis-filter-field">
        <label htmlFor={rangeFieldId(id)}>Range</label>
        <select id={rangeFieldId(id)} value={rangeValue} onChange={event => {
          if (event.target.value === 'custom') {
            // Custom starts as the last 24 hours, which the From and To fields then change.
            const now = Date.now(), custom = customRange(now - dayMs, now, now)!
            service.update(id, ({ hours: _hours, ...current }) => ({ ...current, custom }))
            return
          }
          const hours = Number(event.target.value) as 1 | 24 | 168 | 720
          service.update(id, ({ custom: _custom, ...current }) => ({ ...current, hours }))
        }}>
          {jobHistoryRanges.map(range => <option key={range.hours} value={range.hours}>{range.label}</option>)}
          <option value="custom">Custom…</option>
        </select>
      </span>
      {filters.custom && <>
        <CommitField id={`${id}-jobs-from`} label="From" type="datetime-local" value={localText(filters.custom.from)} onCommit={text => {
          const custom = filters.custom && customRange(new Date(text).getTime(), filters.custom.to, Date.now())
          if (custom) service.update(id, current => ({ ...current, custom }))
        }} />
        <CommitField id={`${id}-jobs-to`} label="To" type="datetime-local" value={localText(filters.custom.to)} onCommit={text => {
          const custom = filters.custom && customRange(filters.custom.from, new Date(text).getTime(), Date.now())
          if (custom) service.update(id, current => ({ ...current, custom }))
        }} />
      </>}
      <CommitField id={`${id}-jobs-statements`} label="Statements" value={filters.statements.join(', ')} placeholder="SELECT, MERGE" maxLength={2048}
        onCommit={text => { const statements = parseStatements(text); service.update(id, current => ({ ...current, statements })) }} />
      <label className="checkbox-label"><input type="checkbox" checked={filters.varia} onChange={event => { const varia = event.target.checked; service.update(id, current => ({ ...current, varia })) }} />Started from Varia</label>
      <CommitField id={`${id}-jobs-search`} label="Search" type="search" value={state.text} placeholder="Job ID, user, destination, SQL" wide onCommit={text => service.setText(id, text)} />
      {filters.jobs?.length ? <span className="bq-jobs-pinned">{filters.jobs.length === 1 ? `Job ${filters.jobs[0].jobId}` : `${filters.jobs.length} jobs`}
        <button type="button" aria-label="Show every job" onClick={() => service.update(id, ({ jobs: _jobs, ...current }) => current)}><Icon name="close" /></button></span> : null}
      <button type="button" className="ssis-filter-clear" disabled={jobHistoryActiveFilters(filters) === 0} onClick={() => service.clearFilters(id)}><Icon name="clear-all" />Clear filters</button>
    </div>
  </div>
}

/** Cancel Job's or Re-run's question, in the document: Escape or the safe answer (Keep running, Don't Re-run) does
 *  nothing; the safe answer has focus. */
function JobConfirm({ state, onAnswer }: { readonly state: JobHistoryState; readonly onAnswer: (proceed: boolean) => void }) {
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => keep.current?.focus(), [state.confirm?.job.jobId, state.confirm?.action])
  if (!state.confirm) return null
  const cancel = state.confirm.action === 'cancel'
  const textId = `${state.id}-${state.confirm.action}-question`
  return <div className="ssis-confirm" role="alertdialog" aria-label={cancel ? 'Cancel Job' : 'Re-run Job'} aria-describedby={textId}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onAnswer(false) } }}>
    <Icon name="warning" />
    <p id={textId}>{state.confirm.question}</p>
    <button type="button" {...cancel ? { className: 'danger' } : {}} onClick={() => onAnswer(true)}>{cancel ? 'Cancel Job' : 'Re-run'}</button>
    <button type="button" ref={keep} onClick={() => onAnswer(false)}>{cancel ? 'Keep running' : "Don't Re-run"}</button>
  </div>
}

/** The grid row under the element a menu was asked for, from the grid that drew it (undefined outside a row). */
function pressedRow(container: Element, from: Element): number | undefined {
  for (let node: Element | null = from; node && container.contains(node); node = node.parentElement) {
    const hit = gridTarget(node, from)
    if (hit.registered) return hit.target?.row
  }
  return undefined
}

/** The status line: how many jobs, whether more exist, whether the list is still loading, the locations not read. */
function StatusLine({ state }: { readonly state: JobHistoryState }) {
  const status = state.status
  if (!status) return null
  const parts = [`${status.held.toLocaleString('en-US')} ${status.held === 1 ? 'job' : 'jobs'}`]
  if (status.open) parts.push(`${status.open} running or pending`)
  if (status.more) parts.push('more exist in this range: choose a narrower one')
  if (status.loading) parts.push('still loading')
  if (status.unreachable) parts.push(`not read from ${status.unreachable}`)
  return <p className="bq-jobs-status" role="status">{parts.join(' · ')}</p>
}

function SqlText({ sql }: { readonly sql: string }) {
  const runs = useRuns(sql, 'googlesql')
  return <pre className="peek-definition bq-jobs-sql" tabIndex={0} aria-label="SQL">
    {runs.map((run, index) => run.style
      ? <span key={index} style={{ color: run.style.foreground, fontStyle: run.style.fontStyle.includes('italic') ? 'italic' : undefined, fontWeight: run.style.fontStyle.includes('bold') ? 'bold' : undefined }}>{run.text}</span>
      : run.text)}</pre>
}

const time = (ms?: number) => ms === undefined ? undefined : new Date(ms).toLocaleString()
function Facts({ details, prices }: { readonly details: JobHistoryDetails; readonly prices: boolean }) {
  const job = details.job
  const bytes = (value?: number) => value === undefined ? undefined : prices ? `${formatBytes(value)} (${formatDollars(value)})` : formatBytes(value)
  const rows: [string, string | undefined][] = [
    ['Job ID', job.jobId], ['Location', job.location], ['State', jobHistoryStateLabels[job.state]], ['Statement', job.statement], ['User', job.user],
    ['Created', time(job.created)], ['Started', time(job.started)], ['Ended', time(job.ended)],
    // On-demand cost is from bytes billed; bytes processed carry no price.
    ['Bytes processed', job.processed === undefined ? undefined : formatBytes(job.processed)], ['Bytes billed', bytes(job.billed)], ['Slot time', job.slotMs === undefined ? undefined : `${(job.slotMs / 1000).toFixed(1)} s`],
    ['Cache hit', job.cacheHit === undefined ? undefined : job.cacheHit ? 'Yes' : 'No'], ['Rows affected', job.rowsAffected?.toLocaleString('en-US')],
    ['Default dataset', job.dataset], ['Destination', job.destination], ['Maximum bytes billed', job.maximumBytesBilled === undefined ? undefined : formatBytes(job.maximumBytesBilled)],
    ['Session', job.session ? 'Ran in a session' : undefined], ['Labels', job.labels.length ? job.labels.map(label => `${label.key}=${label.value}`).join(', ') : undefined], ['Parent script', job.parentJobId]
  ]
  return <dl className="bq-jobs-facts">{rows.filter(([, value]) => value !== undefined && value !== '').map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
}

/** The details pane: the job's facts, its error, its full SQL and a script's statements, read with bigquery.jobs.get. */
function Details({ state, service, prices }: { readonly state: JobHistoryState; readonly service: JobHistoryService; readonly prices: boolean }) {
  const { commands } = useWorkbench()
  const selected = state.selected, details = state.details
  return <section className="bq-jobs-details" aria-label="Job details">
    <div className="bq-jobs-details-head">
      <strong>{selected ? selected.jobId : 'No job selected'}</strong>
      <button type="button" aria-label="Close details" onClick={() => service.closeDetails(state.id)}><Icon name="close" /></button>
    </div>
    {selected && <div className="bq-jobs-actions" role="group" aria-label="Job actions">
      {paneActions.map(({ action, command, label }) => {
        const allowed = service.actionState(state.id, action)
        return <button key={action} type="button" className={action === 'cancel' ? 'danger' : undefined} disabled={!allowed.enabled} title={allowed.reason}
          onClick={() => void commands.execute(command, { tabId: state.id }, 'toolbar')}>{label}</button>
      })}
      {selected.children > 0 && <button type="button" aria-pressed={service.expanded(state.id, selected.jobId)}
        onClick={() => service.toggleExpanded(state.id, { jobId: selected.jobId, ...selected.location ? { location: selected.location } : {} })}>
        {service.expanded(state.id, selected.jobId) ? 'Hide statements in grid' : 'Show statements in grid'}</button>}
    </div>}
    <div className="bq-jobs-details-body">
      {!selected ? <p className="peek-note">Select a job to see its details.</p>
        : !details || details.loading || details.jobId !== selected.jobId ? <p className="peek-note">Loading the job…</p>
          : details.error ? <p className="peek-note error" role="alert">{selected.hidden || isPermissionRefusal(details.error.code, details.error.message) ? `Details hidden by BigQuery. ${details.error.message}` : details.error.message}</p>
            : details.value && <>
              {details.value.job.hidden && <p className="peek-note">Details hidden by BigQuery: only the listed fields came back.</p>}
              <Facts details={details.value} prices={prices} />
              {details.value.job.error && <p className="peek-note error">{details.value.job.error.reason ? `${details.value.job.error.reason}: ` : ''}{details.value.job.error.message}{details.value.job.error.location ? ` (${details.value.job.error.location})` : ''}</p>}
              {details.value.job.sql && <SqlText sql={details.value.job.sql} />}
              {details.value.job.sqlTruncated && <p className="peek-note">The SQL is longer than this pane shows. Open SQL in New Tab shows its first part.</p>}
              {details.value.children.length > 0 && <>
                <h3 className="bq-jobs-children-title">Statements ({details.value.children.length.toLocaleString('en-US')}{details.value.childrenMore ? '+' : ''})</h3>
                <ol className="bq-jobs-children">{details.value.children.map(child => <li key={child.jobId}>
                  <span>{jobHistoryStateLabels[child.state]}</span> <span>{child.statement ?? ''}</span> <code>{child.jobId}</code>{child.sql ? <span className="bq-jobs-child-sql"> {child.sql}</span> : null}
                </li>)}</ol>
              </>}
              {details.value.childrenError && <p className="peek-note error">{details.value.childrenError}</p>}
            </>}
    </div>
  </section>
}

function Ended({ end, onRetry }: { readonly end: JobHistoryEnd; readonly onRetry: () => void }) {
  return <div className="agent-jobs-ended"><InlineError role="status" message={end.message} code={end.code} actions={[{ label: 'Retry', run: onRetry }]} /></div>
}

/**
 * A BigQuery Job History document: the header (where, the live pill and the verbs), My jobs or All users, the filter bar, the
 * status line, the live grid of jobs (newest first, a script's statements under it once shown) and the details pane. Its
 * service keeps every state; this only draws it.
 */
export default function JobHistory({ documentId }: { readonly documentId: string }) {
  const workbench = useWorkbench()
  const service = workbench.jobHistory
  const { documents } = useServiceSnapshot(service)
  useServiceSnapshot(service.context)
  const { values } = useServiceSnapshot(workbench.settings)
  const state = documents[documentId]
  const handle = service.handle(documentId)
  const live = useSyncExternalStore(handle?.subscribe ?? noSubscribe, handle?.getSnapshot ?? noLiveSnapshot, handle?.getSnapshot ?? noLiveSnapshot)
  // A row pressed outside the active row (inside a multi-row selection) rides in the target: the menu acts on its job.
  const menuTarget = useMenuTarget<HTMLDivElement>((element, from) => {
    const row = pressedRow(element, from), active = service.grid(documentId)?.getSnapshot().selection?.active.row
    if (row === undefined || row === active) return { kind: 'jobHistory', tabId: documentId }
    service.pressRow(documentId, row)
    return { kind: 'jobHistory', tabId: documentId, row }
  })
  if (!state || !handle) return <EmptyState className="workspace-empty" icon="history" title={jobHistoryTitle} detail="This document has closed." />
  const probe = live.probes[jobHistoryProbe]
  const rows = handle.table(jobHistoryProbe, 0)?.descriptor.rowsAvailable
  const end = service.ended(documentId)
  const failure = !end && probe?.state === 'failing' ? probe.error : undefined
  const refusedAll = service.refused(documentId).all
  const prices = values['queryExecution.bigQuery.showCost'] !== 'bytes'
  const verbs = [
    { command: 'bigquery.cancelJob' as const, args: { tabId: documentId }, emphasis: 'danger' as const, label: 'Cancel Job' },
    { command: 'bigquery.jobDetails' as const, args: { tabId: documentId }, label: 'Details' },
    { command: 'bigquery.refreshJobs' as const, args: { tabId: documentId }, label: 'Refresh' },
    { command: 'bigquery.pauseJobs' as const, args: { tabId: documentId }, label: 'Pause' }
  ]
  const stale = !end && (probe?.state === 'stale' || probe?.state === 'failing') ? { since: probe.lastSampleAt ?? Date.now() } : undefined
  const filtered = jobHistoryActiveFilters(state.filters) > 0 || !!state.text
  const scopeLabel = `${documentId}-jobs-scope`
  return <DocumentFrame id={`bq-jobs-${documentId}`} title={jobHistoryTitle} subtitle={state.filters.scope === 'all' ? 'All users' : 'My jobs'}
    crumbs={[{ label: state.label }, { label: state.project, title: `${state.project}, the billing project` }]}
    state={<LivePill {...probePillStatus(live, jobHistoryProbe, probeSpec.intervalMs.default)} />}
    tools={<>
      <span id={scopeLabel} className="visually-hidden">Scope</span>
      <Segmented id={`${documentId}-jobs-scope-group`} labelledBy={scopeLabel} segments={scopes} value={state.filters.scope} onChange={value => service.setScope(documentId, value as 'mine' | 'all')}
        {...refusedAll ? { 'aria-describedby': `${documentId}-jobs-refused` } : {}} />
      {refusedAll && <span id={`${documentId}-jobs-refused`} className="visually-hidden">{refusedAll}</span>}
      {stale && <StaleBadge updatedAt={probe?.lastSampleAt} stale={stale} />}
    </>} verbs={verbs} attributes={{ 'data-bq-jobs': documentId }}>
    <div className="agent-jobs bq-jobs">
      <JobConfirm state={state} onAnswer={proceed => service.answerConfirm(documentId, proceed)} />
      {state.notice && (state.notice.tone === 'error'
        ? <InlineError message={state.notice.text} code={state.notice.code} actions={[{ label: 'Dismiss', run: () => service.dismissNotice(documentId) }]} />
        : <div className="ssis-notice" role="status"><Icon name="info" /><span className="ssis-notice-text">{state.notice.text}</span><button type="button" aria-label="Dismiss notice" onClick={() => service.dismissNotice(documentId)}><Icon name="close" /></button></div>)}
      {end ? <Ended end={end} onRetry={() => service.refresh(documentId)} /> : <>
        {failure && <InlineError role="status" message={failure.message} code={failure.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />}
        <Filters state={state} service={service} />
        <StatusLine state={state} />
        <div className="bq-jobs-body">
          <div className="agent-jobs-grid" ref={menuTarget}>
            <LiveGridPane live={handle} probe={jobHistoryProbe} label="Jobs" contextMenu={false} state={service.gridState(documentId)} onGrid={grid => service.attachGrid(documentId, grid)}
              toneLabel={tone => tone === 'running' ? 'running' : tone === 'error' ? 'failed' : tone === 'muted' ? 'cancelled' : undefined} />
            {rows === 0 && <EmptyState className="agent-jobs-empty" icon="history"
              title={filtered ? 'No jobs match the filters' : state.filters.scope === 'all' ? 'No jobs in this range' : 'You ran no jobs in this range'}
              detail="Job History lists the billing project's jobs from BigQuery's own job history, which keeps 180 days."
              actions={filtered ? [{ label: 'Clear filters', run: () => { service.clearFilters(documentId); service.setText(documentId, '') }, primary: true }]
                : [{ label: 'Choose range', run: () => document.getElementById(rangeFieldId(documentId))?.focus() }]} />}
          </div>
          {state.detailsOpen && <Details state={state} service={service} prices={prices} />}
        </div>
      </>}
    </div>
  </DocumentFrame>
}
