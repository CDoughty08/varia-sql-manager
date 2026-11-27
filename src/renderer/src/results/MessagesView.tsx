import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { qualifiedJobId } from '../../../shared/bigquery/history'
import type { BigQueryJobSummary, MessageEntry } from '../../../shared/contracts'
import { hasMultiSummary, type TabResults } from './ResultsService'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { bigQueryProject } from '../bigquery/JobHistoryService'
import type { Workbench } from '../core/workbench'
import Icon from '../Icon'

const coordinatorFilter = '__coordinator__'

/** One message as SSMS prints it; errors in red. Entries never change once shown, so each renders once. */
const Message = memo(function Message({ entry, tabId, queryId, index, targetLabel, canReveal, commands, gestures }: {
  entry: MessageEntry; tabId: string; queryId: string; index: number; targetLabel?: string; canReveal: boolean
} & Pick<Workbench, 'commands' | 'gestures'>) {
  const args = entry.line === undefined ? undefined : { tabId, message: { queryId, index, line: entry.line } }
  const reveal = () => { if (canReveal) void commands.execute('output.revealError', args, 'toolbar') }
  return <div className="message-entry" data-target-key={entry.targetKey} onDoubleClick={event => {
    if (!(event.target as Element).closest('button') && gestures.matches('messages.revealError', event)) reveal()
  }}>
    {targetLabel && <span className="message-target-tag">[{targetLabel}]</span>}
    <pre className={entry.kind === 'error' ? 'msg error' : 'msg'}>{entry.text}</pre>
    {entry.kind === 'error' && entry.line !== undefined && <button type="button" className="message-source-link" disabled={!canReveal}
      title={canReveal ? `Go to line ${entry.line}` : 'The query text has changed since execution, or this source is no longer open.'} onClick={reveal}>
      <Icon name="go-to-file" /><span>Go to line {entry.line}</span>
    </button>}
  </div>
})

/** The connection Show in Job History opens on: the tab's (or multi-server target's), only while it is still on the job's
 *  project (Change Connection keeps the results), since another project's Job History would not list the job. */
export function jobLinkConnection(project: string, connectionId: string | undefined, connections: readonly Parameters<typeof bigQueryProject>[0][]): string | undefined {
  return connectionId && bigQueryProject(connections.find(item => item?.id === connectionId)) === project ? connectionId : undefined
}

/** A BigQuery query's job (its summary's or target outcome's), named after the messages with a link that opens Job History filtered to it. */
function JobLine({ job, connectionId, targetLabel, commands }: { readonly job: BigQueryJobSummary; readonly connectionId?: string; readonly targetLabel?: string } & Pick<Workbench, 'commands'>) {
  const id = qualifiedJobId(job.project, job.jobId, job.location)
  const { connections } = useWorkbench()
  const linked = jobLinkConnection(job.project, connectionId, useServiceSnapshot(connections))
  return <div className="message-entry message-job-line">
    {targetLabel && <span className="message-target-tag">[{targetLabel}]</span>}
    <pre className="msg">Job ID: {id}</pre>
    {linked && <button type="button" className="message-source-link" title="Open Job History filtered to this job"
      onClick={() => void commands.execute('bigquery.jobHistory', { bigQueryJobs: { connectionId: linked, jobs: [{ jobId: job.jobId, ...job.location ? { location: job.location } : {} }] } }, 'toolbar')}>
      <Icon name="history" /><span>Show in Job History</span>
    </button>}
  </div>
}

/** What Messages show after the last message: SSMS's line when SQL Server sent nothing (Varia's own notices do not
 *  count), then the completion time. */
export function messageTail(tab: Pick<TabResults, 'status' | 'messages' | 'notices' | 'summary'> & Partial<Pick<TabResults, 'multiSummary'>>): string[] {
  if (tab.status === 'running') return []
  const lines = tab.messages.length - tab.notices === 0 && (tab.status === 'completed' || tab.status === 'closed') ? ['Commands completed successfully.'] : []
  const completedAt = tab.summary?.completedAt ?? tab.multiSummary?.completedAt
  if (completedAt) lines.push('', 'Completion time: ' + completedAt)
  return lines
}

/**
 * The Messages view, and the Messages strip's open part: messages stream in as the script runs, SQL errors inline in SSMS's
 * two-line form and in red, then BigQuery job lines and the tail. On multi-server runs a server filter bar mounts as a
 * sibling OUTSIDE `[data-output-view="messages"]` so `Ctrl+A` selects only messages; `<Message index={originalIndex} />`
 * preserves each entry's unfiltered index in `tab.messages`, while `firstError` scrolls using the filtered array index.
 */
export default function MessagesView({ id, tabId, tab, firstError }: { id?: string; tabId: string; tab: TabResults; firstError?: boolean }) {
  const { commands, documents, queries, gestures } = useWorkbench()
  const subscribe = useCallback((listener: () => void) => {
    const content = documents.onDidChangeContent?.(tabId, listener) ?? documents.getModel(tabId)?.onDidChangeContent(listener)
    const changed = documents.subscribe(listener)
    return () => { content?.dispose(); changed() }
  }, [documents, tabId])
  const revision = () => documents.revision(tabId)
  useSyncExternalStore(subscribe, revision, revision)

  const multi = hasMultiSummary(tab)
  const targets = multi ? tab.multi!.targets : []
  const runKey = `${tabId}\u0000${tab.queryId}`
  const [filterState, setFilterState] = useState<{ readonly runKey: string; readonly value: string }>({ runKey, value: 'all' })
  const setFilter = useCallback((value: string) => setFilterState({ runKey, value }), [runKey])
  const filter = filterState.runKey === runKey ? filterState.value : 'all'
  const hasCoordinatorLines = useMemo(() => multi && tab.messages.some(entry => entry.targetKey === undefined), [multi, tab.messages])
  const validFilter = filter === 'all'
    || (filter === coordinatorFilter && hasCoordinatorLines)
    || targets.some(target => target.targetKey === filter)
    ? filter
    : 'all'

  const targetLabels = useMemo(() => new Map(targets.map(target => [target.targetKey, target.label])), [targets])
  const errorCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of tab.messages) {
      if (entry.kind !== 'error') continue
      const key = entry.targetKey ?? coordinatorFilter
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [tab.messages])
  const filtered = useMemo(() => {
    const indexed = tab.messages.map((entry, originalIndex) => ({ entry, originalIndex }))
    if (!multi || validFilter === 'all') return indexed
    if (validFilter === coordinatorFilter) return indexed.filter(item => item.entry.targetKey === undefined)
    return indexed.filter(item => item.entry.targetKey === validFilter)
  }, [tab.messages, multi, validFilter])

  const multiJobs = useMemo(() => {
    if (!multi || tab.status === 'running') return []
    return targets.filter(target => target.job && (validFilter === 'all' || validFilter === target.targetKey))
  }, [multi, tab.status, targets, validFilter])

  const ref = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const shownError = useRef(-1)
  const lastRun = useRef(runKey)
  const lastFilter = useRef(validFilter)
  const tail = messageTail(tab)
  useLayoutEffect(() => {
    if (lastRun.current !== runKey) {
      lastRun.current = runKey
      shownError.current = -1
      atBottom.current = true
    }
    if (lastFilter.current !== validFilter) {
      lastFilter.current = validFilter
      shownError.current = -1
    }
    const element = ref.current
    if (!element) return
    const error = firstError ? filtered.findIndex(item => item.entry.kind === 'error') : -1
    if (error >= 0) {
      if (shownError.current === error) return
      shownError.current = error
      const line = element.children[error]
      if (line) element.scrollTop += line.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientTop
      return
    }
    if (atBottom.current) element.scrollTop = element.scrollHeight
  }, [filtered, tail.length, firstError, runKey, validFilter])

  const log = <div ref={ref} id={id} className="messages" role="log" aria-label="Messages" tabIndex={0} data-output-view="messages" data-tab-id={tabId} data-pane-focus="messages"
    onScroll={event => { const element = event.currentTarget; atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 4 }}>
    {filtered.map(({ entry, originalIndex }) => <Message key={originalIndex} entry={entry} index={originalIndex} tabId={tabId} queryId={tab.queryId}
      targetLabel={multi && validFilter === 'all' && entry.targetKey ? targetLabels.get(entry.targetKey) ?? entry.targetKey : undefined}
      commands={commands} gestures={gestures}
      canReveal={entry.kind === 'error' && queries.sourceLine(tabId, tab.queryId, entry.line, entry.dialect) !== undefined} />)}
    {tab.status !== 'running' && tab.summary?.job && <JobLine job={tab.summary.job} connectionId={documents.get(tabId)?.connectionId} commands={commands} />}
    {multiJobs.map(target => <JobLine key={target.targetKey} job={target.job!} connectionId={target.connectionId || undefined}
      targetLabel={validFilter === 'all' ? target.label : undefined} commands={commands} />)}
    {tail.map((line, index) => <pre key={'tail' + index} className="msg">{line || ' '}</pre>)}
  </div>

  if (!multi) return log

  // Compact <select> when targets > 6 or inside MessagesStrip (`firstError`) so pills never wrap and crowd the strip.
  const useSelect = targets.length > 6 || !!firstError
  return <div className="messages-container" data-compact={firstError || undefined}>
    <div className="messages-filter-bar" role="region" aria-label="Filter messages by server">
      {useSelect
        ? <select className="messages-filter-select" aria-label="Filter messages by server" value={validFilter} onChange={event => setFilter(event.target.value)}>
            <option value="all">All servers ({tab.messages.length})</option>
            {hasCoordinatorLines && <option value={coordinatorFilter}>Coordinator</option>}
            {targets.map(target => {
              const errs = errorCounts.get(target.targetKey) ?? 0
              return <option key={target.targetKey} value={target.targetKey}>{target.label}{errs > 0 ? ` (${errs} ${errs === 1 ? 'error' : 'errors'})` : ''}</option>
            })}
          </select>
        : <div className="messages-filter-pills" role="group" aria-label="Filter messages by server">
            <button type="button" className="messages-filter-pill" aria-pressed={validFilter === 'all'} onClick={() => setFilter('all')}>All</button>
            {hasCoordinatorLines && <button type="button" className="messages-filter-pill" aria-pressed={validFilter === coordinatorFilter} onClick={() => setFilter(coordinatorFilter)}>Coordinator</button>}
            {targets.map(target => {
              const errs = errorCounts.get(target.targetKey) ?? 0
              return <button key={target.targetKey} type="button" className="messages-filter-pill" aria-pressed={validFilter === target.targetKey} data-has-error={errs > 0 || undefined}
                onClick={() => setFilter(target.targetKey)}>
                <span>{target.label}</span>
                {errs > 0 && <span className="messages-filter-err" aria-label={`${errs} ${errs === 1 ? 'error' : 'errors'}`}>!</span>}
              </button>
            })}
          </div>}
    </div>
    {log}
  </div>
}
