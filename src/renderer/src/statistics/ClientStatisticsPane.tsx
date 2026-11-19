import { useMemo, useRef, useState } from 'react'
import { clientStatisticsHistoryLimit } from '../../../shared/client-statistics'
import type { LocalTableData } from '../../../shared/results/local-table'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { LocalGrid } from '../grid/LocalGrid'
import { statisticsStatusWords as statusWords, statisticsTable } from './ClientStatisticsService'

export default function ClientStatisticsPane({ tabId }: { tabId: string }) {
  const { queries, commands } = useWorkbench(), service = queries.statistics
  const runs = useServiceSnapshot(service)[tabId] ?? []
  const [chosen, choose] = useState('')
  const selected = runs.find(run => run.queryId === chosen) ?? runs.at(-1)
  // One table object per report shown: a new one is a new grid (LocalGrid), so the last object stays while its text is the same
  // (another run starting while an older one is chosen leaves the report as it was, and its selection and scroll with it).
  const shown = useRef<{ table: LocalTableData; text: string }>(undefined)
  const table = useMemo(() => {
    const built = selected && selected.status !== 'running' ? statisticsTable(runs, selected) : undefined
    if (!built) return undefined
    const text = JSON.stringify(built)
    if (shown.current?.text !== text) shown.current = { table: built, text }
    return shown.current.table
  }, [runs, selected])
  return <div className="client-statistics">
    <div className="client-statistics-tools">
      <label>Execution <select aria-label="Statistics execution" value={selected?.queryId ?? ''} disabled={!runs.length} onChange={event => choose(event.target.value)}>
        {!runs.length && <option value="">No samples</option>}
        {runs.map(run => <option key={run.queryId} value={run.queryId}>Run {run.sequence} · {statusWords[run.status]} · {run.server ? run.server + ' / ' : ''}{run.database} · context {run.scope}{run.livePlan ? ' · live plan' : run.actualPlan ? ' · actual plan' : ''}</option>)}
      </select></label>
      <button type="button" disabled={queries.isRunning(tabId) || !runs.length} onClick={() => void commands.execute('query.resetClientStatistics', undefined, 'toolbar')}>Reset Statistics</button>
    </div>
    {!selected ? <p>Turn on Include Client Statistics in the Query menu or toolbar, then execute a query.</p>
      : selected.status === 'running' ? <p role="status">Collecting statistics. The sample appears when execution ends.</p> : <>
        <p role="status">Run {selected.sequence}: {statusWords[selected.status]}. {selected.status !== 'completed' && 'Partial sample; counters may omit unfinished statements. '}{selected.sample?.unavailable}</p>
        {/* The results grid, unsorted: the rows are an ordered report, and Copy with Headers takes it as a table. */}
        {table && <LocalGrid table={table} label="Client statistics comparison" preset="page" sortable={false} suggestedName={`Client statistics run ${selected.sequence}`} />}
      </>}
    <details><summary>Measurement scope, comparison rules and unavailable timings</summary>
      <p>Microsoft.Data.SqlClient measurements for this query connection only. Login, session setup, background monitoring and plan observer traffic are excluded. User SQL and its plan output are included.</p>
      <p>History keeps the last {clientStatisticsHistoryLimit} included executions in this query tab. Previous compares the preceding attempt in the selected connection, session, database and plan-capture context, separating live sampling from actual capture alone. Average uses successful runs in that context, where the measurement is available; failed, cancelled, timed-out and unavailable runs are excluded.</p>
      <p>Server CPU, pure server execution time and renderer time: unavailable here. Provider timers include server waits and have millisecond resolution. Use execution plans or server statistics for server measurements; these timings do not measure painting the grid.</p>
    </details>
  </div>
}
