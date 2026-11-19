import { useMemo, useState } from 'react'
import { clientStatisticsHistoryLimit } from '../../../shared/client-statistics'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { LocalGrid } from '../grid/LocalGrid'
import { statisticsTable, type StatisticsRun } from './ClientStatisticsService'

const statusWords: Record<StatisticsRun['status'], string> = { completed: 'completed', completedWithErrors: 'completed with errors', failed: 'failed', cancelled: 'cancelled', timedOut: 'timed out', running: 'running', unavailable: 'unavailable' }

export default function ClientStatisticsPane({ tabId }: { tabId: string }) {
  const { queries, commands } = useWorkbench(), service = queries.statistics
  const runs = useServiceSnapshot(service)[tabId] ?? []
  const [chosen, choose] = useState('')
  const selected = runs.find(run => run.queryId === chosen) ?? runs.at(-1)
  // One table object per sample shown: a new one is a new grid (LocalGrid), so it is built only when the runs change.
  const table = useMemo(() => selected && selected.status !== 'running' ? statisticsTable(runs, selected) : undefined, [runs, selected])
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
