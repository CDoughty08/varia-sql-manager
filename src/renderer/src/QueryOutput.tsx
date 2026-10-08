import { memo, useState } from 'react'
import type { QueryResult } from '../../shared/contracts'

interface Props { tabId: string; result?: QueryResult; error?: string; running: boolean; connected: boolean }
type View = 'results' | 'messages'
const initialView = (result?: QueryResult, error?: string): View => error || result?.error || result?.resultSets.length === 0 ? 'messages' : 'results'

function QueryOutput({ tabId, result, error, running, connected }: Props) {
  const [view, setView] = useState<View>(() => initialView(result, error))
  const [index, setIndex] = useState(0)
  // Reset while rendering (not in an effect) so a new result never paints with the previous selection first.
  const [shown, setShown] = useState({ tabId, result, error })
  if (shown.tabId !== tabId || shown.result !== result || shown.error !== error) {
    setShown({ tabId, result, error })
    setIndex(0)
    setView(initialView(result, error))
  }
  const failure = error ?? result?.error?.message
  const set = result?.resultSets[index]
  const status = result?.status ?? 'completed'
  const statusText = status === 'failed' ? 'Failed' : status === 'cancelled' ? 'Cancelled' : status === 'timedOut' ? 'Timed out' : 'Completed'
  const resultLabel = (position: number) => {
    const item = result!.resultSets[position]
    const name = item.kind === 'executionPlan' ? 'XML plan' : 'Result ' + (position + 1)
    return item.batchNumber ? name + ' · Batch ' + item.batchNumber + (item.iteration && item.iteration > 1 ? ' / repeat ' + item.iteration : '') : name
  }
  return <section className="output-panel" aria-label="Query output">
    <div className="output-toolbar">
      <div>
        <button className={view === 'results' ? 'active' : ''} onClick={() => setView('results')}>Results{result && <span>{result.resultSets.length}</span>}</button>
        <button className={view === 'messages' ? 'active' : ''} onClick={() => setView('messages')}>Messages{failure ? <span className="error-count">!</span> : !!result?.messages.length && <span>{result.messages.length}</span>}</button>
      </div>
      {result && <small>{statusText} · {result.elapsedMs} ms · {result.resultSets.reduce((sum, item) => sum + item.rows.length, 0)} rows{result.totalBatches > 1 ? ' · ' + result.completedBatches + '/' + result.totalBatches + ' batches' : ''}</small>}
    </div>
    {view === 'messages' && (result || failure) ? <div className="messages">
      {!!result?.messages.length && <pre>{result.messages.join('\n')}</pre>}
      {failure && <pre role="alert" className="query-error">{result?.error?.batchNumber ? 'Batch ' + result.error.batchNumber + ', repetition ' + result.error.iteration + '\n' : ''}{failure}</pre>}
      {result && <pre>{!result.messages.length && !failure ? 'Command completed successfully.\n' : ''}{result.recordsAffected >= 0 ? result.recordsAffected + ' total rows affected.\n' : ''}{statusText} in {result.elapsedMs} ms.</pre>}
    </div> : view === 'results' && result ? <>
      {result.resultSets.length > 1 && <div className="result-selector">{result.resultSets.map((_, position) => <button key={position} className={index === position ? 'active' : ''} onClick={() => setIndex(position)}>{resultLabel(position)}</button>)}</div>}
      {set ? <>
        {set.kind === 'executionPlan' ? <div className="plan-output"><pre className="plan-xml">{set.rows.map(row => String(row[0] ?? '')).join('\n')}</pre></div>
          : <div className="grid-scroll"><table className="results-grid"><thead><tr><th className="row-number">#</th>{set.columns.map((column, position) => <th key={position}>{column.name || '(unnamed)'}<small>{column.dataType}</small></th>)}</tr></thead><tbody>{set.rows.map((row, position) => <tr key={position}><td className="row-number">{position + 1}</td>{row.map((value, column) => <td key={column} title={value === null ? 'NULL' : String(value)}>{value === null ? <span className="null-value">NULL</span> : String(value)}</td>)}</tr>)}</tbody></table></div>}
        {set.truncated && <div className="truncation">Output truncated by display limits. See Messages.</div>}
        {set.incomplete && <div className="truncation">This result is incomplete because an error, cancellation, or timeout stopped it. See Messages.</div>}
      </> : <div className="output-empty">{statusText}.{result.recordsAffected >= 0 ? ' ' + result.recordsAffected + ' rows affected.' : ''}</div>}
    </> : <div className="output-empty"><strong>{running ? 'Your query is running…' : 'Query results'}</strong><p>{connected ? 'Execute a query to view results and messages.' : 'Connect this query to a server to execute it.'}</p></div>}
  </section>
}

export default memo(QueryOutput)
