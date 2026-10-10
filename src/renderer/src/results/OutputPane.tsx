import { memo, useEffect, useState } from 'react'
import { browserTimers } from '../core/timers'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import ResultsStack from '../grid/ResultsStack'
import MessagesView from './MessagesView'
import type { ResultJob, TabResults } from './ResultsService'
import { formatCount, statusSentence } from './status'

interface Props { tabId: string; connected: boolean; hint?: string }

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
 * Query Output for the active query: Results (stacked grids, once a set exists) and Messages tabs, the status line, the
 * copy and save strips (and how the last save ended), and one live region for the pane. Results switch automatically
 * (Messages until a set opens, Messages again when the run fails) until the user picks a tab.
 */
function OutputPane({ tabId, connected, hint }: Props) {
  const { results } = useWorkbench()
  const all = useServiceSnapshot(results)
  const tab = tabId ? all[tabId] : undefined
  const now = useTicker(tab?.status === 'running')
  const hasSets = !!tab && (tab.sets.length > 0 || tab.status === 'closed')
  const view = tab ? (tab.view === 'results' && hasSets ? 'results' : 'messages') : undefined
  const errors = !!tab?.messages.some(entry => entry.kind === 'error')
  const jobs = tab?.jobs.filter(job => job.visible) ?? []
  return <section className="output-panel" aria-label="Query output">
    <div className="output-toolbar">
      <div role="tablist" aria-label="Query output views">
        {hasSets && <button role="tab" aria-selected={view === 'results'} className={view === 'results' ? 'active' : ''} onClick={() => results.setView(tabId, 'results')}>Results<span>{tab!.sets.length}</span></button>}
        {tab && <button role="tab" aria-selected={view === 'messages'} className={view === 'messages' ? 'active' : ''} onClick={() => results.setView(tabId, 'messages')}>Messages{errors ? <span className="error-count">!</span> : tab.messages.length > 0 && <span>{tab.messages.length}</span>}</button>}
      </div>
      {tab && <small className="output-status" data-status={tab.status}>{statusLine(tab, now)}</small>}
      {jobs.map(job => <div key={job.jobId} className="job-strip" role="status"><span>{jobText(job)}</span><button onClick={() => results.cancelJob(job.jobId)}>Cancel</button></div>)}
      {/* The live region below announces it; this is the visible copy. */}
      {tab?.jobNotice && <div className="job-strip job-notice">{tab.jobNotice}</div>}
    </div>
    {!tab ? <div className="output-empty"><strong>Query results</strong><p>{hint ?? (connected ? 'Execute a query to view results and messages.' : 'Connect this query to a server to execute it.')}</p></div>
      : view === 'results' ? tab.status === 'closed' ? <div className="output-empty"><p>Results were closed to free memory. Execute the query again to see them.</p></div> : <ResultsStack key={tab.queryId} tabId={tabId} tab={tab} />
        : <MessagesView tabId={tabId} tab={tab} />}
    <div role="status" className="visually-hidden">{tab?.announcement ?? ''}</div>
  </section>
}

export default memo(OutputPane)
