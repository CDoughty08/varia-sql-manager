// Job Activity Monitor (AG-3, docs/sql-server-agent.md): the header (where, the live pill and Refresh), Agent's banner while it
// cannot run jobs, the tiles, the view chips and filter box, the live grid of jobs (LiveGridPane: the results grid's GridView,
// no React per row) with its funnels, the bulk bar, the selected job's last run in place, and the bulk verbs' result lines.
// JobActivityService keeps every state; this only draws it.
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import {
  agentBanner, agentBulkCommands, agentBulkFormVerbs, agentBulkTitles, agentBulkVerbs, agentJobFilterColumns, agentJobFilterLimits, agentJobTiles, agentJobViewSpecs, agentJobsProbe, agentServiceProbe,
  agentStatusOverride, jobActivityTitle, tileValue, viewCount
} from '../../../shared/agent/jobs'
import { liveProbes, type LiveTone } from '../../../shared/live/catalog'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { gridTarget } from '../grid/anchor'
import Icon from '../Icon'
import { Chip, ChipGroup } from '../kit/Chip'
import DocumentFrame from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import InlineError from '../kit/InlineError'
import { LivePill, StaleBadge } from '../kit/LivePill'
import Tile, { tileName } from '../kit/Tile'
import { LiveGridPane, type LiveFilters } from '../live/LiveGridPane'
import type { LiveSnapshot } from '../live/LiveService'
import { probePillStatus } from '../live/status'
import { formatCount, plural } from '../results/status'
import { activeFilters, listProblems, pillNote, type BulkLine, type JobActivityState } from './JobActivityService'
import JobBulkForm from './JobBulkForms'

const listSpec = liveProbes[agentJobsProbe]
const noSubscribe = () => () => {}
const noLive: LiveSnapshot = { status: 'connecting', probes: {}, connectionId: '' }
const noLiveSnapshot = () => noLive
/** What a screen reader hears for a toned row. */
const toneWords: Partial<Record<LiveTone, string>> = { error: 'last run failed', running: 'running', warning: 'between retries', muted: 'disabled' }
const toneLabel = (tone: LiveTone): string | undefined => toneWords[tone]
const lineWords: Readonly<Record<BulkLine['state'], string>> = { waiting: 'Waiting', running: 'Running…', done: 'Done', failed: 'Failed', skipped: 'Not sent' }

/** The filter box: sent when typing pauses, on Enter, or on leaving it; Escape puts back what was sent. */
function FilterBox({ id, value, onCommit }: { readonly id: string; readonly value: string; readonly onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value)
  const commit = useRef(onCommit)
  commit.current = onCommit
  useEffect(() => setDraft(value), [value])
  // Typing settles before a filter goes out, so each keystroke is not a live.update of its own.
  useEffect(() => {
    if (draft === value) return
    const timer = window.setTimeout(() => commit.current(draft), 300)
    return () => window.clearTimeout(timer)
  }, [draft, value])
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); onCommit(draft) }
    else if (event.key === 'Escape' && draft !== value) { event.preventDefault(); event.stopPropagation(); setDraft(value) }
  }
  const inputId = `agent-jobs-${id}-filter`
  return <span className="activity-filter-box">
    <Icon name="search" />
    <label htmlFor={inputId} className="visually-hidden">Filter jobs</label>
    <input id={inputId} type="search" spellCheck={false} placeholder="Filter jobs" value={draft} maxLength={128} onChange={event => setDraft(event.target.value)} onKeyDown={keyDown}
      onBlur={() => { if (draft !== value) onCommit(draft) }} />
  </span>
}

/** The bulk verbs' result lines: one per job, each with its own outcome; Stop sends no more, Close hides them once done. */
function BulkResults({ state, onStop, onClose }: { readonly state: JobActivityState; readonly onStop: () => void; readonly onClose: () => void }) {
  const bulk = state.bulk
  if (!bulk) return null
  const done = bulk.lines.filter(line => line.state === 'done').length
  const failed = bulk.lines.filter(line => line.state === 'failed').length
  const title = agentBulkTitles[bulk.verb].dialog
  return <section className="agent-bulk" aria-label={title}>
    <div className="agent-bulk-head">
      <strong>{title}</strong>
      <span>{bulk.running ? `${done + failed} of ${bulk.lines.length}` : `${done} done${failed ? `, ${failed} failed` : ''}`}</span>
      {bulk.running && <button type="button" disabled={bulk.stopping} onClick={onStop}>{bulk.stopping ? 'Stopping…' : 'Stop'}</button>}
      <button type="button" onClick={onClose} disabled={bulk.running && bulk.stopping}>Close</button>
    </div>
    <ol className="agent-bulk-lines" role="log" aria-label={`${title} results`}>
      {bulk.lines.map(line => <li key={line.id} data-state={line.state}>
        <span className="agent-bulk-name">{line.name}</span>
        <span className="agent-bulk-state">{lineWords[line.state]}</span>
        {line.message && <span className="agent-bulk-message">{line.message}</span>}
      </li>)}
    </ol>
  </section>
}

/** A Job Activity Monitor document. */
export default function JobActivityMonitor({ documentId }: { readonly documentId: string }) {
  const workbench = useWorkbench()
  const service = workbench.jobActivity
  const { documents } = useServiceSnapshot(service)
  const state = documents[documentId]
  const handle = service.handle(documentId)
  const live = useSyncExternalStore(handle?.subscribe ?? noSubscribe, handle?.getSnapshot ?? noLiveSnapshot, handle?.getSnapshot ?? noLiveSnapshot)
  if (!state || !handle) return <EmptyState className="workspace-empty" icon="agent-activity" title={jobActivityTitle} detail="This document has closed." />
  const probe = live.probes[agentJobsProbe]
  const table = handle.table(agentJobsProbe, 0)
  const lastRun = handle.table(agentJobsProbe, 1)
  const rows = table?.descriptor.rowsAvailable
  const end = service.ended(documentId)
  // Tiles, chips and the Status note keep the last reading while lost (it is what the grid shows); the banner and pill wait.
  const availability = service.availability(documentId), shown = service.shownAvailability(documentId)
  const banner = agentBanner(shown, state.service, false, state.linux)
  const override = agentStatusOverride(availability)
  const problems = listProblems(probe)
  const waiting = service.lastRunWaiting(documentId)
  const failure = !end ? problems.failure : undefined
  const unavailable = probe?.state === 'unavailable' ? probe.note ?? 'Job Activity Monitor is not available on this server.' : undefined
  const stale = !end && problems.stale ? { since: probe?.lastSampleAt ?? Date.now() } : undefined
  const filtersOn = activeFilters(state)
  const selected = state.selected
  const bulkWhy = service.bulkUnavailable(documentId)
  const one = selected.length === 1 ? selected[0] : undefined
  const expandedHere = !!one && state.expanded?.id === one.id
  const filters: LiveFilters = {
    columns: agentJobFilterColumns,
    filters: state.columnFilters,
    facet: column => state.facets[column],
    apply: (column, next) => service.setColumnFilter(documentId, column as typeof agentJobFilterColumns[number], next),
    clear: () => { for (const column of agentJobFilterColumns) service.setColumnFilter(documentId, column, undefined) },
    maxValues: agentJobFilterLimits.values
  }
  const verbs = [{ command: 'agent.refreshJobs' as const, args: { tabId: documentId }, label: 'Refresh' }]
  const pillProbe = live.probes[agentJobsProbe] ? agentJobsProbe : agentServiceProbe
  // While Agent cannot run jobs the pill says so in place of the interval: the list's rows are msdb's last reading.
  const note = pillNote(shown, end)
  const pill = note ? <span className="live-pill" data-state="paused"><Icon name={end?.denied ? 'lock' : 'warning'} /><span>{note}</span></span>
    : <LivePill {...probePillStatus(live, pillProbe, listSpec.intervalMs.default)} />
  return <DocumentFrame id={`agent-jobs-${documentId}`} title={jobActivityTitle} subtitle="SQL Server Agent"
    crumbs={[{ label: state.label }, { label: 'SQL Server Agent' }]}
    state={pill}
    tools={stale && <StaleBadge updatedAt={probe?.lastSampleAt} stale={stale} />} verbs={verbs} attributes={{ 'data-agent-jobs': documentId }}>
    <div className="agent-jobs">
      {banner && <div className="agent-banner" role="status"><Icon name="warning" /><span>{banner.text}</span></div>}
      {end ? <div className="agent-jobs-ended">
        {end.denied ? <div role="status"><EmptyState icon="lock" title="No access to SQL Server Agent" detail={end.message} /></div>
          : <InlineError role="status" message={end.message} code={end.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />}
      </div> : <>
        {failure && <InlineError role="status" message={failure.message} code={failure.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />}
        <div className="agent-tiles" role="group" aria-label="Job counts">
          {agentJobTiles.map(tile => {
            const raw = tileValue(tile, state.counts?.[tile.series], availability)
            const value = raw === undefined ? undefined : raw === '—' ? '—' : formatCount(raw)
            const pressed = service.tilePressed(documentId, tile.applies)
            return <button key={tile.id} type="button" className="agent-tile" data-tone={tile.tone} aria-pressed={pressed} aria-label={tileName({ caption: tile.label, value })}
              title={pressed ? 'Show every job' : `Show only ${tile.label.toLowerCase()} jobs`} onClick={() => service.applyTile(documentId, tile.applies)}>
              <Tile caption={tile.label} value={value} />
            </button>
          })}
        </div>
        <div className="activity-pane-tools one-row agent-jobs-tools" role="toolbar" aria-label="Job filters">
          <ChipGroup label="View" dense>
            {agentJobViewSpecs.map(view => <Chip key={view.id} label={view.label} pressed={state.view === view.id}
              count={viewCount(view.series, state.counts, availability)}
              onToggle={() => service.setView(documentId, view.id)} />)}
          </ChipGroup>
          <FilterBox id={documentId} value={state.text} onCommit={text => service.setText(documentId, text)} />
          <button type="button" className="activity-tool icon-only" disabled={filtersOn === 0} onClick={() => service.clearFilters(documentId)}
            aria-label="Clear filters" title="Clear filters: the view, the filter box and the column filters"><Icon name="clear-all" /></button>
        </div>
        <div className="agent-bulk-bar" role="toolbar" aria-label="Selected jobs">
          <span className="agent-bulk-count">{state.overCap ? `More than ${formatCount(selected.length)} jobs selected: select at most ${formatCount(selected.length)}` : selected.length ? `${formatCount(selected.length)} ${plural(selected.length, 'job')} selected` : 'No job selected'}</span>
          {agentBulkVerbs.map(verb => <button key={verb} type="button" disabled={!!bulkWhy} title={bulkWhy ?? agentBulkTitles[verb].dialog}
            onClick={() => void workbench.commands.execute(agentBulkCommands[verb], { tabId: documentId }, 'toolbar')}>{agentBulkTitles[verb].button}</button>)}
          {agentBulkFormVerbs.map(verb => <button key={verb} type="button" disabled={!!bulkWhy} title={bulkWhy ?? agentBulkTitles[verb].dialog} aria-expanded={state.form?.verb === verb}
            onClick={() => void workbench.commands.execute(agentBulkCommands[verb], { tabId: documentId }, 'toolbar')}><Icon name={verb === 'changeOwner' ? 'person' : 'agent-schedule'} />{agentBulkTitles[verb].button}</button>)}
          <button type="button" disabled={!one} title={one ? `Open ${one.name} (Enter)` : 'Select one job to open it'}
            onClick={() => void workbench.commands.execute('agent.openJob', { tabId: documentId }, 'toolbar')}>Open</button>
          <button type="button" className="agent-chevron" aria-expanded={expandedHere} disabled={!one} title={one ? 'Show the last run of the selected job below the list' : 'Select one job to see its last run'}
            onClick={() => service.toggleExpanded(documentId, one)}><Icon name={expandedHere ? 'chevron-down' : 'chevron-right'} />Last run</button>
          <button type="button" disabled={!selected.length || state.overCap} title={selected.length ? 'Open the Log File Viewer with the selected jobs checked' : 'Select one or more jobs to view their history'}
            onClick={() => void workbench.commands.execute('agent.viewHistory', { tabId: documentId }, 'toolbar')}><Icon name="history" />View history</button>
          <button type="button" disabled={!one} title={one ? `Create a job like ${one.name}` : 'Select one job to create a job like it'}
            onClick={() => void workbench.commands.execute('agent.createJobLike', { tabId: documentId }, 'toolbar')}><Icon name="copy" />Create Job Like This…</button>
        </div>
        <JobBulkForm id={documentId} service={service} form={state.form} />
        <div className="agent-jobs-grid" onDoubleClick={event => {
          // Only on a job's row (GridView's own hit test): a header's border fits its column, and the area below the rows is no job.
          // The grid's pointer layer lies over its rows, so every element under the pointer is asked, not just the event's target.
          const root = (event.target as Element).closest('[role="grid"]')
          const onRow = !!root && root.ownerDocument.elementsFromPoint(event.clientX, event.clientY).some(element => root.contains(element) && gridTarget(root, element).target?.row !== undefined)
          if (onRow) void workbench.commands.execute('agent.openJob', { tabId: documentId }, 'toolbar')
        }}>
          {unavailable ? <EmptyState icon="agent-activity" title="Job Activity Monitor is not available" detail={unavailable} />
            : <>
              <LiveGridPane live={handle} probe={agentJobsProbe} label="Jobs" toneLabel={toneLabel} filters={filters} state={service.gridState(documentId)} onGrid={grid => service.attachGrid(documentId, grid)} />
              {rows === 0 && <EmptyState className="agent-jobs-empty" icon="agent-activity"
                title={filtersOn ? 'No jobs match the filters' : 'No jobs'}
                detail={filtersOn ? 'Clear the filters to see every job this login can see.' : 'msdb shows this login no SQL Server Agent jobs: a SQLAgentUserRole member sees only the jobs it owns.'}
                actions={filtersOn ? [{ label: 'Clear filters', run: () => service.clearFilters(documentId), primary: true }] : []} />}
            </>}
        </div>
        {override && <p className="agent-jobs-note" role="note">Status: {override}. The Status column shows msdb's last reading.</p>}
        {state.expanded && <section className="agent-last-run" aria-label={`Last run of ${state.expanded.name}`}>
          <div className="agent-last-run-head">
            <strong>Last run: {state.expanded.name}</strong>
            <button type="button" aria-label="Hide the last run" onClick={() => service.toggleExpanded(documentId, undefined)}><Icon name="close" /></button>
          </div>
          {problems.lastRun ? <InlineError role="status" message={problems.lastRun} code={probe?.error?.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />
            : waiting?.failed ? <InlineError role="status" message={waiting.text} code={probe?.error?.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />
            : waiting ? <p className="agent-last-run-empty" role="status">{waiting.text}</p>
            : lastRun && lastRun.descriptor.rowsAvailable === 0 ? <p className="agent-last-run-empty">{lastRun.descriptor.truncated
              ? 'The newest history rows hold no finished run (the run in progress wrote them all), so the last run is not shown.'
              : 'This job has no finished run in its history.'}</p>
            : <>{lastRun?.descriptor.truncated && <p className="agent-last-run-empty" role="note">Only this run's newest steps are shown: the rest are past what one read keeps.</p>}
              <LiveGridPane live={handle} probe={agentJobsProbe} table={1} label={`Last run of ${state.expanded.name}`} toneLabel={tone => tone === 'error' ? 'failed' : tone === 'running' ? 'in progress' : undefined} /></>}
        </section>}
      </>}
      <BulkResults state={state} onStop={() => service.stopBulk(documentId)} onClose={() => service.closeBulk(documentId)} />
    </div>
  </DocumentFrame>
}
