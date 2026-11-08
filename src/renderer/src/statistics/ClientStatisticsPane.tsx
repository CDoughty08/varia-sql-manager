import { useState } from 'react'
import { clientStatisticsHistoryLimit, providerMetricDefinitions, type ClientStatisticsSample } from '../../../shared/client-statistics'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { metricAverage, statisticsPeers, type StatisticsRun } from './ClientStatisticsService'

const number = (value: number | undefined) => value === undefined ? 'Unavailable' : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
const statusWords: Record<StatisticsRun['status'], string> = { completed: 'completed', completedWithErrors: 'completed with errors', failed: 'failed', cancelled: 'cancelled', timedOut: 'timed out', running: 'running', unavailable: 'unavailable' }

export default function ClientStatisticsPane({ tabId }: { tabId: string }) {
  const { queries, commands } = useWorkbench(), service = queries.statistics
  const runs = useServiceSnapshot(service)[tabId] ?? []
  const [chosen, choose] = useState('')
  const selected = runs.find(run => run.queryId === chosen) ?? runs.at(-1)
  const peers = selected ? statisticsPeers(runs, selected) : []
  const previous = selected ? runs.filter(run => run.scope === selected.scope && run.sequence < selected.sequence && run.status !== 'running').at(-1) : undefined
  const rows: { key: string; label: string; definition: string; value: (sample: ClientStatisticsSample) => number | undefined }[] = [
    ...providerMetricDefinitions.map(([key, label, definition]) => ({ key, label, definition, value: (sample: ClientStatisticsSample) => sample.counters[key] })),
    { key: 'collectionElapsedMs', label: 'Collection wall time (ms)', definition: 'Backend wall time from just before the first batch to after all readers close. Includes server waits, provider calls, value formatting and result storage; excludes login, setup, observer collection, IPC delivery and rendering.', value: sample => sample.collectionElapsedMs }
  ]
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
        <table aria-label="Client statistics comparison">
          <thead><tr><th scope="col">Measurement</th><th scope="col">Run {selected.sequence}</th><th scope="col" title={previous ? statusWords[previous.status] : undefined}>{previous ? `Previous (run ${previous.sequence})` : 'Previous'}</th><th scope="col">Change</th><th scope="col">Average ({peers.length} runs)</th><th scope="col">Definition</th></tr></thead>
          <tbody>{rows.map(row => {
            const current = selected.sample && row.value(selected.sample), before = previous?.sample && row.value(previous.sample)
            const change = current === undefined || before === undefined ? undefined : current - before
            return <tr key={row.key}><th scope="row">{row.label}</th><td>{number(current)}</td><td>{number(before)}</td><td>{change === undefined ? 'Unavailable' : `${change > 0 ? '+' : ''}${number(change)}`}</td>
              <td title="Only runs where this metric is available contribute to this mean.">{number(metricAverage(peers, row.value))}</td><td>{row.definition}</td></tr>
          })}</tbody>
        </table>
      </>}
    <details><summary>Measurement scope, comparison rules and unavailable timings</summary>
      <p>Microsoft.Data.SqlClient measurements for this query connection only. Login, session setup, background monitoring and plan observer traffic are excluded. User SQL and its plan output are included.</p>
      <p>History keeps the last {clientStatisticsHistoryLimit} included executions in this query tab. Previous compares the preceding attempt in the selected connection, session, database and plan-capture context, separating live sampling from actual capture alone. Average uses successful runs in that context; failed, cancelled, timed-out and unavailable runs are excluded.</p>
      <p>Server CPU, pure server execution time and renderer time: unavailable here. Provider timers include server waits and have millisecond resolution. Use execution plans or server statistics for server measurements; these timings do not measure painting the grid.</p>
    </details>
  </div>
}
