import { memo, useEffect, useId, useLayoutEffect, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { outputPaneIds, type OutputPaneId } from '../../../shared/layouts'
import PaneMenuButton from '../PaneMenuButton'
import Icon from '../Icon'
import { useTicker } from '../core/useTicker'
import { observeResize } from '../core/windows'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { gridLimits as g } from '../grid/constants'
import ResultsStack, { stackNeed } from '../grid/ResultsStack'
import ResultPlans from '../plans/ResultPlans'
import EstimatedPlans from '../plans/EstimatedPlans'
import RetainedPlans from '../plans/RetainedPlans'
import type { EstimatedPlanState } from '../services/queries'
import ClientStatisticsPane from '../statistics/ClientStatisticsPane'
import EmptyState from '../kit/EmptyState'
import MessagesView from './MessagesView'
import ResultsToolbar from './ResultsToolbar'
import type { OutputViewName, ResultJob, ResultSetEntry, TabResults } from './ResultsService'
import { formatCount, messagesSummary, plural, runSummary } from './status'

/** `query` is false for a value's document (XML, JSON, plan), which has no results of its own. */
interface Props { pane: OutputPaneId; tabId: string; query: boolean; connected: boolean; hint?: string }

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
 * The output's live region for one query tab (keyed by it): it reads out what that tab announces while it is shown. A
 * sentence from before it was shown stays unread, so switching query tabs repeats nothing.
 */
function Announcer({ text, announced }: { text: string; announced: number }) {
  const [shownAt] = useState(announced)
  return <div role="status" className="visually-hidden" data-output-announcer>{announced > shownAt ? text : ''}</div>
}

/**
 * The query output's one live region, outside the dock, so that it reads out how a run, a copy or a save ended wherever
 * the output panels are and whichever of them shows.
 */
export function OutputAnnouncer({ tabId }: { tabId: string }) {
  const { results } = useWorkbench()
  const tab = useServiceSnapshot(results)[tabId]
  return <Announcer key={tabId} text={tab?.announcement ?? ''} announced={tab?.announced ?? 0} />
}

/** The run's plan sets, which the Execution plan panel lists; closed results have none. */
function plansOf(tab: TabResults | undefined): readonly ResultSetEntry[] {
  return tab && tab.status !== 'closed' ? [...tab.planSets, ...tab.sets.filter(set => set.descriptor.kind === 'executionPlan')] : []
}
/**
 * An estimate keeps its chosen output independently of ordinary runs. Otherwise show Messages until a set opens,
 * then Results unless the user picked a view; Execution plan only while the run has a plan. Undefined before either ran.
 */
export function outputViewOf(tab: TabResults | undefined, estimated?: EstimatedPlanState, livePlan = false): OutputViewName | undefined {
  if (estimated) return estimated.view ?? 'plan'
  if (!tab) return undefined
  if (tab.view === 'statistics') return 'statistics'
  const hasSets = tab.sets.length > 0 || tab.status === 'closed'
  return tab.view === 'plan' && (plansOf(tab).length > 0 || livePlan) ? 'plan' : tab.view !== 'messages' && hasSets ? 'results' : 'messages'
}

/**
 * Keeps the output panels on the active query's view: when the query or its view changes, that view's panel shows in
 * place of the output panel its group shows. A group where the output panels share tabs with another panel stays as it is.
 */
export function OutputViewSync({ tabId }: { tabId: string }) {
  const { results, panes, queries, queryPlans } = useWorkbench()
  const tab = useServiceSnapshot(results)[tabId]
  const estimated = useServiceSnapshot(queries)[tabId]?.estimated
  const view = outputViewOf(tab, estimated, !!useServiceSnapshot(queryPlans)[tabId])
  useEffect(() => { if (view) panes.select(view) }, [panes, tabId, view, estimated?.requestId])
  return null
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
    const observer = observeResize(element, () => setHeight(element.clientHeight))
    setHeight(element.clientHeight)
    return () => observer.dispose()
  }, [element])
  return [setElement, height]
}

const emptyTitles: Record<OutputPaneId, string> = { results: 'Query results', messages: 'Messages', plan: 'Execution plan', statistics: 'Client Statistics' }
const emptyIcons = { results: 'table', messages: 'output', plan: 'execution-plan', statistics: 'graph' } as const
const regionNames: Record<OutputPaneId, string> = { results: 'Query results', messages: 'Query messages', plan: 'Query execution plans', statistics: 'Query client statistics' }
const viewNames: Record<OutputPaneId, string> = { results: 'Results', messages: 'Messages', plan: 'Execution plan', statistics: 'Client Statistics' }

/**
 * One output panel for the active query: Results (stacked grids, and the Messages strip under them), Messages, or
 * Execution plan (the run's showplan sets). Each docks, floats and tabs on its own. Its toolbar's tabs are the output
 * panels in its group (Results once a set exists, Execution plan once the run returned a plan), and choosing one shows it
 * as the group's dock tab would. The views follow the ARIA tabs pattern: one Tab stop, arrow keys, Home and End move
 * between them and show the one they reach. The first output panel showing (Results, else Messages, else Execution plan)
 * also holds the run summary and the copy and save strips, so they show once, wherever the panels are.
 */
function OutputPane({ pane, tabId, query, connected, hint }: Props) {
  const { results, panes, queries, queryPlans, retainedPlans } = useWorkbench()
  const history = useServiceSnapshot(retainedPlans)
  const [historyOpen, setHistoryOpen] = useState(false)
  const livePlan = useServiceSnapshot(queryPlans)[tabId]
  const all = useServiceSnapshot(results)
  const estimated = useServiceSnapshot(queries)[tabId]?.estimated
  const statistics = useServiceSnapshot(queries.statistics)[tabId] ?? []
  const visible = useServiceSnapshot(panes)
  const peers = useServiceSnapshot(panes.peers)[pane]
  const tab = tabId ? all[tabId] : undefined
  const leader = outputPaneIds.find(id => visible[id]) === pane
  const now = useTicker(leader && tab?.status === 'running')
  const hasSets = !!tab && (tab.sets.length > 0 || tab.status === 'closed')
  const plans = plansOf(tab)
  const planCount = estimated ? estimated.result?.plans.length ?? 0 : plans.length
  const errors = !!tab?.messages.some(entry => entry.kind === 'error')
  // Closed results keep the tab, without a count of sets that are gone.
  const sets = tab && tab.status !== 'closed' ? tab.sets.length : 0, messages = tab?.messages.length ?? 0
  const jobs = tab?.jobs.filter(job => job.visible) ?? []
  const id = useId(), panelId = id + 'panel', tabIds: Record<OutputPaneId, string> = { results: id + 'results', messages: id + 'messages', plan: id + 'plan', statistics: id + 'statistics' }
  const [viewRef, viewHeight] = useHeight()
  const available: Record<OutputPaneId, boolean> = { results: hasSets, messages: !!tab, plan: plans.length > 0 || !!estimated || !!livePlan, statistics: statistics.length > 0 }
  // Only the panel its group shows lists the tabs: a hidden panel's tabs are gone, not merely out of sight.
  const views = (!tab && !estimated) || !visible[pane] ? [] : (peers.length ? peers : [pane]).filter(view => view === pane || available[view])
  // The strip line shows once there is something to read beyond row counts (or the user opened the strip); it opens itself
  // only when the stack keeps room for its sets at their floors.
  const stripSummary = tab ? messagesSummary(tab.messages) : undefined
  const showStrip = !!tab && pane === 'results' && hasSets && messages > 0 && (stripSummary!.readable || tab.strip)
  const need = tab && showStrip && tab.status !== 'closed' ? stackNeed(tab, results.viewState(tabId).collapsed) : 0
  const stripFits = viewHeight > 0 && viewHeight >= need + g.messagesStripOpen
  const stripMax = viewHeight > 0 ? Math.max(g.messagesStripOpen, Math.min(Math.floor(viewHeight * 0.4), viewHeight - need)) : undefined
  // The results tools sit in the head beside the views, taking no rows from the grids: results panes are often short.
  const showTools = !!tab && pane === 'results' && visible[pane] && hasSets && tab.status !== 'closed'
  /** Shows another output panel of this group; with `focus` (a click or a key on these tabs), focus moves to its tab, since the one pressed leaves with its panel. */
  const select = (view: OutputPaneId, focus = false) => {
    if (view === pane) return
    results.setView(tabId, view)
    panes.select(view)
    if (!focus) return
    const attempt = () => {
      const target = document.querySelector<HTMLElement>('[data-pane="' + view + '"] [data-output-tab="' + view + '"]')
      target?.focus()
      return !!target && document.activeElement === target
    }
    if (!attempt()) requestAnimationFrame(() => { attempt() })
  }
  const tabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!views.length || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const at = Math.max(0, views.indexOf(pane))
    const next = event.key === 'ArrowRight' ? views[(at + 1) % views.length] : event.key === 'ArrowLeft' ? views[(at + views.length - 1) % views.length]
      : event.key === 'Home' ? views[0] : event.key === 'End' ? views[views.length - 1] : undefined
    if (!next) return
    event.preventDefault()
    select(next, true)
  }
  const tabProps = (name: OutputPaneId) => ({
    id: tabIds[name], role: 'tab', 'data-output-tab': name, 'aria-selected': name === pane, ...name === pane ? { 'aria-controls': panelId } : {},
    tabIndex: name === pane ? 0 : -1, className: name === pane ? 'active' : '', onClick: () => select(name, true)
  })
  const labels: Record<OutputPaneId, string> = {
    results: sets > 0 ? `Results, ${formatCount(sets)} ${plural(sets, 'result set')}` : 'Results',
    messages: errors ? 'Messages, contains errors' : messages > 0 ? `Messages, ${formatCount(messages)} ${plural(messages, 'message')}` : 'Messages',
    plan: estimated ? 'Execution plan, Estimated' : plans.length > 0 ? `Execution plan, ${formatCount(plans.length)} ${plural(plans.length, 'plan')}` : 'Execution plan',
    statistics: 'Client Statistics'
  }
  const badges: Record<OutputPaneId, ReactNode> = {
    results: sets > 0 && <span className="badge">{sets}</span>,
    messages: errors ? <span className="badge error-count">!</span> : messages > 0 && <span className="badge">{messages}</span>,
    plan: planCount > 0 && <span className="badge">{planCount}</span>,
    statistics: statistics.length > 0 && <span className="badge">{statistics.length}</span>
  }
  return <section className="output-panel" aria-label={regionNames[pane]} data-output-panel={pane}>
    <div className="output-toolbar">
      <div className="output-views" role="tablist" aria-label="Query output views" onKeyDown={tabKey}>
        {/* The badges are drawn; the names say what they mean ("!" alone is not spoken). */}
        {views.map(view => <button key={view} {...tabProps(view)} aria-label={labels[view]}>{viewNames[view]}{badges[view]}</button>)}
      </div>
      {showTools && <ResultsToolbar tabId={tabId} />}
      {pane === 'plan' && <button type="button" aria-pressed={historyOpen} onClick={() => setHistoryOpen(value => !value)}>Plan history ({history.entries.length})</button>}
      {pane === 'plan' && estimated ? <span className="output-status">Estimated{estimated.loading ? ' · Compiling…' : estimated.error ? ' · Unavailable' : ''}</span>
        : leader && tab ? <RunSummaryView tab={tab} now={now} /> : <span className="output-spacer" />}
      {/* Visual progress only: the output's live region announces how a copy or save ended. */}
      {leader && jobs.map(job => <div key={job.jobId} className="job-strip"><span>{jobText(job)}</span><button onClick={() => results.cancelJob(job.jobId)}>Cancel</button></div>)}
      {/* The live region announces it; this is the visible copy. */}
      {leader && tab?.jobNotice && <div className="job-strip job-notice">{tab.jobNotice}</div>}
      <PaneMenuButton pane={pane} />
    </div>
    {pane === 'plan' && historyOpen ? <div className="output-view" role="tabpanel" id={panelId} aria-labelledby={views.length ? tabIds[pane] : undefined} aria-label={views.length ? undefined : 'Plan history'}><RetainedPlans active={visible.plan} /></div>
      : pane === 'plan' && estimated ? <div ref={viewRef} className="output-view" role="tabpanel" id={panelId} aria-labelledby={tabIds[pane]}>{visible.plan && <EstimatedPlans state={estimated} tabId={tabId} visible={visible.plan} />}</div>
      : pane === 'statistics' ? <div ref={viewRef} className="output-view" role="tabpanel" id={panelId} aria-labelledby={views.length ? tabIds[pane] : undefined} aria-label={views.length ? undefined : 'Client Statistics'}><ClientStatisticsPane tabId={tabId} /></div>
      : !tab ? <EmptyState className="output-empty" icon={emptyIcons[pane]} title={emptyTitles[pane]} detail={!query ? 'Query results appear here for query tabs.' : hint ?? (connected ? 'Execute a query to view results and messages.' : 'Connect this query to a server to execute it.')} />
      : <div ref={viewRef} className="output-view" role="tabpanel" id={panelId} aria-labelledby={tabIds[pane]}>
        {pane === 'results' ? <>
          {tab.status === 'closed' ? <EmptyState className="output-empty" detail="Results were closed to free memory. Execute the query again to see them." />
            : hasSets ? <ResultsStack key={tab.queryId} tabId={tabId} tab={tab} />
            : <EmptyState className="output-empty" icon="table" detail={tab.status === 'running' ? 'Result sets appear here as the query returns them.' : 'The query returned no result sets.'} />}
          {showStrip && <MessagesStrip tabId={tabId} tab={tab} fits={stripFits} maxHeight={stripMax} />}
        </> : pane === 'plan' ? plans.length > 0 || livePlan ? visible.plan && <ResultPlans tabId={tabId} queryId={tab.queryId} plans={plans} visible={visible.plan} order={tab.summary?.planOrder} live={livePlan} />
          : <EmptyState className="output-empty" icon="execution-plan" detail="A plan appears here when the query returns one, as SET SHOWPLAN_XML ON and SET STATISTICS XML ON do." />
          : <MessagesView tabId={tabId} tab={tab} />}
      </div>}
  </section>
}

export default memo(OutputPane)
