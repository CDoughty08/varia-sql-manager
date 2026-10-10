import { memo, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { browserTimers } from '../core/timers'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import ResultsStack from '../grid/ResultsStack'
import MessagesView from './MessagesView'
import type { ResultJob, TabResults } from './ResultsService'
import { formatCount, plural, statusSentence } from './status'

/** `query` is false for a value's document (XML, JSON, plan), which has no results of its own. */
interface Props { tabId: string; query: boolean; connected: boolean; hint?: string }

/** Re-renders once a second while `running`, for the elapsed time. */
function useTicker(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    let handle: unknown
    const tick = () => { setNow(Date.now()); handle = browserTimers.setTimeout(tick, 1000) }
    handle = browserTimers.setTimeout(tick, 1000)
    return () => browserTimers.clearTimeout(handle)
  }, [running])
  return now
}

function jobText(job: ResultJob): string {
  const percent = job.rowsTotal > 0 ? Math.min(100, Math.floor(job.rowsDone / job.rowsTotal * 100)) : 0
  const done = `${percent}% (${formatCount(job.rowsDone)} of ${formatCount(job.rowsTotal)} rows)`
  return job.kind === 'save' ? `Saving${job.fileName ? ' ' + job.fileName : ''}… ${done}` : `Copying… ${done}`
}

/** The status line, from the run's state; elapsed time ticks while it runs. */
function statusLine(tab: TabResults, now: number): string {
  const status = tab.status === 'closed' ? tab.summary?.status ?? 'completed' : tab.status
  const elapsedMs = tab.status === 'running' ? now - tab.startedAt : tab.summary?.elapsedMs ?? Math.max(0, now - tab.startedAt)
  return statusSentence({ status, elapsedMs, rows: tab.rowsRead, completedBatches: tab.completedBatches, totalBatches: tab.totalBatches })
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
 * Query Output for the active query: Results (stacked grids, once a set exists) and Messages tabs, the status line, the
 * copy and save strips (and how the last save ended), and one live region for the pane. Results switch automatically
 * (Messages until a set opens, Messages again when the run fails) until the user picks a tab. The two tabs follow the
 * ARIA tabs pattern: one Tab stop, arrow keys, Home and End move between them and show the one they reach.
 */
function OutputPane({ tabId, query, connected, hint }: Props) {
  const { results } = useWorkbench()
  const all = useServiceSnapshot(results)
  const tab = tabId ? all[tabId] : undefined
  const now = useTicker(tab?.status === 'running')
  const hasSets = !!tab && (tab.sets.length > 0 || tab.status === 'closed')
  const view = tab ? (tab.view === 'results' && hasSets ? 'results' : 'messages') : undefined
  const errors = !!tab?.messages.some(entry => entry.kind === 'error')
  // Closed results keep the tab, without a count of sets that are gone.
  const sets = tab && tab.status !== 'closed' ? tab.sets.length : 0, messages = tab?.messages.length ?? 0
  const jobs = tab?.jobs.filter(job => job.visible) ?? []
  const id = useId(), panelId = id + 'panel', tabIds = { results: id + 'results', messages: id + 'messages' }
  const tabRefs = useRef<Record<'results' | 'messages', HTMLButtonElement | null>>({ results: null, messages: null })
  const views: ('results' | 'messages')[] = hasSets ? ['results', 'messages'] : ['messages']
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
  const tabProps = (name: 'results' | 'messages') => ({
    ref: (element: HTMLButtonElement | null) => { tabRefs.current[name] = element }, id: tabIds[name], role: 'tab', 'aria-selected': view === name, 'aria-controls': panelId,
    tabIndex: view === name ? 0 : -1, className: view === name ? 'active' : '', onClick: () => results.setView(tabId, name)
  })
  return <section className="output-panel" aria-label="Query output">
    <div className="output-toolbar">
      <div role="tablist" aria-label="Query output views" onKeyDown={tabKey}>
        {/* The badges are drawn; the names say what they mean ("!" alone is not spoken). */}
        {hasSets && <button {...tabProps('results')} aria-label={sets > 0 ? `Results, ${formatCount(sets)} ${plural(sets, 'result set')}` : 'Results'}>Results{sets > 0 && <span className="badge">{sets}</span>}</button>}
        {tab && <button {...tabProps('messages')} aria-label={errors ? 'Messages, contains errors' : messages > 0 ? `Messages, ${formatCount(messages)} ${plural(messages, 'message')}` : 'Messages'}>Messages{errors ? <span className="badge error-count">!</span> : messages > 0 && <span className="badge">{messages}</span>}</button>}
      </div>
      {tab && <small className="output-status" data-status={tab.status}>{statusLine(tab, now)}</small>}
      {/* Visual progress only: the pane's live region announces how a copy or save ended. */}
      {jobs.map(job => <div key={job.jobId} className="job-strip"><span>{jobText(job)}</span><button onClick={() => results.cancelJob(job.jobId)}>Cancel</button></div>)}
      {/* The live region below announces it; this is the visible copy. */}
      {tab?.jobNotice && <div className="job-strip job-notice">{tab.jobNotice}</div>}
    </div>
    {!tab ? <div className="output-empty"><strong>Query results</strong><p>{!query ? 'Query results appear here for query tabs.' : hint ?? (connected ? 'Execute a query to view results and messages.' : 'Connect this query to a server to execute it.')}</p></div>
      : <div className="output-view" role="tabpanel" id={panelId} aria-labelledby={tabIds[view ?? 'messages']}>
        {view === 'results' ? tab.status === 'closed' ? <div className="output-empty"><p>Results were closed to free memory. Execute the query again to see them.</p></div> : <ResultsStack key={tab.queryId} tabId={tabId} tab={tab} />
          : <MessagesView tabId={tabId} tab={tab} />}
      </div>}
    <Announcer key={tabId} text={tab?.announcement ?? ''} announced={tab?.announced ?? 0} />
  </section>
}

export default memo(OutputPane)
