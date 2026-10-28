import { memo, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from 'react'
import PaneMenuButton from '../PaneMenuButton'
import Icon from '../Icon'
import { useTicker } from '../core/useTicker'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { gridLimits as g } from '../grid/constants'
import ResultsStack, { batchText, stackNeed } from '../grid/ResultsStack'
import MessagesView from './MessagesView'
import { setKey, type OutputViewName, type ResultJob, type ResultSetEntry, type TabResults } from './ResultsService'
import { formatCount, messagesSummary, plural, runSummary } from './status'

/** `query` is false for a value's document (XML, JSON, plan), which has no results of its own. */
interface Props { tabId: string; query: boolean; connected: boolean; hint?: string }

/** Plans a plan set lists in the Execution plan view; more are opened from its grid in Results. */
const planRowsShown = 16

function jobText(job: ResultJob): string {
  const percent = job.rowsTotal > 0 ? Math.min(100, Math.floor(job.rowsDone / job.rowsTotal * 100)) : 0
  const done = `${percent}% (${formatCount(job.rowsDone)} of ${formatCount(job.rowsTotal)} rows)`
  return job.kind === 'save' ? `Saving${job.fileName ? ' ' + job.fileName : ''}… ${done}` : `Copying… ${done}`
}

/** The run summary, from the run's state; elapsed time ticks while it runs. SSMS's sentence is its tooltip. A run that ended
 *  without a summary took until it ended, not until now. */
function RunSummaryView({ tab, now }: { tab: TabResults; now: number }) {
  const elapsedMs = tab.status === 'running' ? now - tab.startedAt : tab.summary?.elapsedMs ?? Math.max(0, (tab.endedAt ?? tab.startedAt) - tab.startedAt)
  const summary = runSummary({
    status: tab.status, closedFrom: tab.closedFrom, elapsedMs, rows: tab.rowsRead, completedBatches: tab.completedBatches, totalBatches: tab.totalBatches, completedAt: tab.summary?.completedAt
  })
  return <span className="output-status" data-status={tab.status} data-tone={summary.tone} title={summary.sentence}>
    <Icon name={summary.icon} spin={summary.icon === 'loading'} /><strong>{summary.outcome}</strong>{summary.facts.map((fact, index) => <span key={index}> · {fact}</span>)}
  </span>
}

/**
 * The pane's live region for one query tab (keyed by it): it reads out what that tab announces while it is shown. A
 * sentence from before it was shown stays unread, so switching query tabs repeats nothing.
 */
function Announcer({ text, announced }: { text: string; announced: number }) {
  const [shownAt] = useState(announced)
  return <div role="status" className="visually-hidden">{announced > shownAt ? text : ''}</div>
}

/**
 * The Messages strip under the results: one line ("Messages · 2 · no errors", and the first error while it is closed) that
 * opens to the messages themselves, showing the first error. It opens itself when an error, PRINT or RAISERROR output
 * arrives, so results and messages show together, but only where the pane has room for the stack's sets at their floors and
 * a few lines of messages (`fits`); the user's open or close holds for the run. Open, it takes at most what the stack leaves
 * (and 40 % of the pane), never less than a few lines.
 */
function MessagesStrip({ tabId, tab, fits, maxHeight }: { tabId: string; tab: TabResults; fits: boolean; maxHeight?: number }) {
  const { results } = useWorkbench()
  const id = useId(), errorId = id + 'error'
  const summary = messagesSummary(tab.messages)
  const open = tab.strip && (tab.stripChosen || fits)
  const style: CSSProperties | undefined = open && maxHeight !== undefined ? { maxHeight, minHeight: g.messagesStripOpen } : undefined
  return <div className="messages-strip" data-open={open || undefined} style={style}>
    <button type="button" className="messages-strip-toggle" aria-label={summary.label} aria-describedby={!open && summary.firstError ? errorId : undefined} aria-expanded={open} aria-controls={open ? id : undefined}
      title={!open && summary.firstError ? summary.firstError : undefined} onClick={() => results.setStrip(tabId, !open)}>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} /><span className="messages-strip-name">Messages</span>
      <span className="messages-strip-facts" data-errors={summary.errors > 0 || undefined}> · {summary.text}</span>
      {!open && summary.firstError && <span id={errorId} className="messages-strip-error">{summary.firstError}</span>}
    </button>
    {open && <MessagesView id={id} tabId={tabId} tab={tab} firstError />}
  </div>
}

/** The output view's height, followed while it is mounted. */
function useHeight(): [(element: HTMLDivElement | null) => void, number] {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(() => setHeight(element.clientHeight))
    observer.observe(element)
    setHeight(element.clientHeight)
    return () => observer.disconnect()
  }, [element])
  return [setElement, height]
}

/** One plan set in the Execution plan view: where it came from, and Open for each plan it holds (its rows). */
function PlanItem({ tabId, entry, number, totalBatches }: { tabId: string; entry: ResultSetEntry; number: number; totalBatches: number }) {
  const { commands } = useWorkbench()
  const snapshot = useSyncExternalStore(entry.handle.subscribe, entry.handle.getSnapshot)
  const rows = snapshot.state === 'lost' || snapshot.state === 'released' ? 0 : snapshot.rowsAvailable, shown = Math.min(rows, planRowsShown)
  const batch = batchText(entry.descriptor.batchNumber, entry.descriptor.iteration, totalBatches)
  const name = `Execution plan ${number}`
  const open = (row: number) => { void commands.execute('output.openValue', { tabId, cell: { resultIndex: entry.index, row, column: 0 } }, 'toolbar') }
  return <li className="plan-item">
    <Icon name="execution-plan" /><span className="plan-name">{name}</span>
    <span className="plan-facts">{[batch, `Result ${entry.index + 1}`].filter(Boolean).join(' · ')}</span>
    <span className="plan-actions">
      {Array.from({ length: shown }, (_, row) => <button key={row} type="button" onClick={() => open(row)} aria-label={shown > 1 ? `Open ${name}, statement ${row + 1}` : `Open ${name}`}>{shown > 1 ? `Open ${row + 1}` : 'Open'}</button>)}
      {rows > shown && <span className="plan-more">{formatCount(rows - shown)} more in Results</span>}
    </span>
  </li>
}

/** The Execution plan view: the run's showplan result sets (SET SHOWPLAN_XML, SET STATISTICS XML), each opened as a .sqlplan document. */
function PlanView({ tabId, tab, plans }: { tabId: string; tab: TabResults; plans: readonly ResultSetEntry[] }) {
  return <ul className="plan-list" aria-label="Execution plans">
    {plans.map((entry, index) => <PlanItem key={setKey(entry.descriptor)} tabId={tabId} entry={entry} number={index + 1} totalBatches={tab.totalBatches} />)}
  </ul>
}

/**
 * Query Output for the active query: a segmented Results (stacked grids, once a set exists), Messages and Execution plan
 * (once the run returned a plan) control, the run summary, the copy and save strips (and how the last save ended), and
 * one live region for the pane. Results switch automatically (Messages until a set opens; a run without sets ends on
 * Messages) until the user picks a view; under Results, the Messages strip shows the messages too. The views follow the
 * ARIA tabs pattern: one Tab stop, arrow keys, Home and End move between them and show the one they reach.
 */
function OutputPane({ tabId, query, connected, hint }: Props) {
  const { results } = useWorkbench()
  const all = useServiceSnapshot(results)
  const tab = tabId ? all[tabId] : undefined
  const now = useTicker(tab?.status === 'running')
  const hasSets = !!tab && (tab.sets.length > 0 || tab.status === 'closed')
  const plans = tab && tab.status !== 'closed' ? tab.sets.filter(set => set.descriptor.kind === 'executionPlan') : []
  const view: OutputViewName | undefined = !tab ? undefined : tab.view === 'plan' && plans.length > 0 ? 'plan' : tab.view !== 'messages' && hasSets ? 'results' : 'messages'
  const errors = !!tab?.messages.some(entry => entry.kind === 'error')
  // Closed results keep the tab, without a count of sets that are gone.
  const sets = tab && tab.status !== 'closed' ? tab.sets.length : 0, messages = tab?.messages.length ?? 0
  const jobs = tab?.jobs.filter(job => job.visible) ?? []
  const id = useId(), panelId = id + 'panel', tabIds: Record<OutputViewName, string> = { results: id + 'results', messages: id + 'messages', plan: id + 'plan' }
  const tabRefs = useRef<Record<OutputViewName, HTMLButtonElement | null>>({ results: null, messages: null, plan: null })
  const [viewRef, viewHeight] = useHeight()
  // The strip line shows once there is something to read beyond row counts (or the user opened the strip); it opens itself
  // only when the stack keeps room for its sets at their floors.
  const stripSummary = tab ? messagesSummary(tab.messages) : undefined
  const showStrip = !!tab && view === 'results' && messages > 0 && (stripSummary!.readable || tab.strip)
  const need = tab && showStrip && tab.status !== 'closed' ? stackNeed(tab, results.viewState(tabId).collapsed) : 0
  const stripFits = viewHeight > 0 && viewHeight >= need + g.messagesStripOpen
  const stripMax = viewHeight > 0 ? Math.max(g.messagesStripOpen, Math.min(Math.floor(viewHeight * 0.4), viewHeight - need)) : undefined
  const views: OutputViewName[] = [...hasSets ? ['results' as const] : [], 'messages', ...plans.length > 0 ? ['plan' as const] : []]
  const tabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!view || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const at = views.indexOf(view)
    const next = event.key === 'ArrowRight' ? views[(at + 1) % views.length] : event.key === 'ArrowLeft' ? views[(at + views.length - 1) % views.length]
      : event.key === 'Home' ? views[0] : event.key === 'End' ? views[views.length - 1] : undefined
    if (!next) return
    event.preventDefault()
    if (next !== view) results.setView(tabId, next)
    tabRefs.current[next]?.focus()
  }
  const tabProps = (name: OutputViewName) => ({
    ref: (element: HTMLButtonElement | null) => { tabRefs.current[name] = element }, id: tabIds[name], role: 'tab', 'data-output-tab': name, 'aria-selected': view === name, 'aria-controls': panelId,
    tabIndex: view === name ? 0 : -1, className: view === name ? 'active' : '', onClick: () => results.setView(tabId, name)
  })
  return <section className="output-panel" aria-label="Query output">
    <div className="output-toolbar">
      <div className="output-views" role="tablist" aria-label="Query output views" onKeyDown={tabKey}>
        {/* The badges are drawn; the names say what they mean ("!" alone is not spoken). */}
        {hasSets && <button {...tabProps('results')} aria-label={sets > 0 ? `Results, ${formatCount(sets)} ${plural(sets, 'result set')}` : 'Results'}>Results{sets > 0 && <span className="badge">{sets}</span>}</button>}
        {tab && <button {...tabProps('messages')} aria-label={errors ? 'Messages, contains errors' : messages > 0 ? `Messages, ${formatCount(messages)} ${plural(messages, 'message')}` : 'Messages'}>Messages{errors ? <span className="badge error-count">!</span> : messages > 0 && <span className="badge">{messages}</span>}</button>}
        {plans.length > 0 && <button {...tabProps('plan')} aria-label={`Execution plan, ${formatCount(plans.length)} ${plural(plans.length, 'plan')}`}>Execution plan<span className="badge">{plans.length}</span></button>}
      </div>
      {tab ? <RunSummaryView tab={tab} now={now} /> : <span className="output-spacer" />}
      {/* Visual progress only: the pane's live region announces how a copy or save ended. */}
      {jobs.map(job => <div key={job.jobId} className="job-strip"><span>{jobText(job)}</span><button onClick={() => results.cancelJob(job.jobId)}>Cancel</button></div>)}
      {/* The live region below announces it; this is the visible copy. */}
      {tab?.jobNotice && <div className="job-strip job-notice">{tab.jobNotice}</div>}
      <PaneMenuButton pane="output" />
    </div>
    {!tab ? <div className="output-empty"><strong>Query results</strong><p>{!query ? 'Query results appear here for query tabs.' : hint ?? (connected ? 'Execute a query to view results and messages.' : 'Connect this query to a server to execute it.')}</p></div>
      : <div ref={viewRef} className="output-view" role="tabpanel" id={panelId} aria-labelledby={tabIds[view ?? 'messages']}>
        {view === 'results' ? <>
          {tab.status === 'closed' ? <div className="output-empty"><p>Results were closed to free memory. Execute the query again to see them.</p></div> : <ResultsStack key={tab.queryId} tabId={tabId} tab={tab} />}
          {showStrip && <MessagesStrip tabId={tabId} tab={tab} fits={stripFits} maxHeight={stripMax} />}
        </> : view === 'plan' ? <PlanView tabId={tabId} tab={tab} plans={plans} /> : <MessagesView tabId={tabId} tab={tab} />}
      </div>}
    <Announcer key={tabId} text={tab?.announcement ?? ''} announced={tab?.announced ?? 0} />
  </section>
}

export default memo(OutputPane)
