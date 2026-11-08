import { useMemo, useState } from 'react'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import EmptyState from '../kit/EmptyState'
import PlanViewer from './PlanViewer'
import { retainedPlanLimits, type RetainedPlan } from './RetainedPlansService'

const types = { actual: 'Actual', estimated: 'Estimated', 'query-returned': 'SQL-returned (capture type unspecified)' } as const
const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`
const position = (entry: RetainedPlan) => `${entry.batchNumber ? `Batch ${entry.batchNumber}` : 'Batch unavailable'}, repetition ${entry.iteration}`
const description = (entry: RetainedPlan) => `${entry.label} · ${position(entry)} · ${entry.context.name} · ${new Date(entry.context.startedAt).toLocaleString()}${entry.pinned ? ' · Pinned' : ''}`

/** A window-wide XML history, available from Execution Plan even after all originating tabs close. */
export default function RetainedPlans({ active }: { active: boolean }) {
  const { retainedPlans, documents, files } = useWorkbench()
  const history = useServiceSnapshot(retainedPlans), busy = useServiceSnapshot(documents).busy
  const [selected, setSelected] = useState(history.entries[0]?.id ?? '')
  const entry = history.entries.find(entry => entry.id === selected) ?? history.entries[0]
  const sources = useMemo(() => entry ? [{ key: entry.sourceKey, label: entry.label, batchNumber: entry.batchNumber, iteration: entry.iteration,
    batchLabel: `${types[entry.captureType]} · ${position(entry)}`, read: async () => entry.xml }] : [], [entry?.id])
  const open = (save = false) => {
    if (!entry) return
    const name = `${types[entry.captureType].split(' ')[0]} Plan.sqlplan`
    if (save) { void files.saveCopy(name, entry.xml, 'sqlplan'); return }
    documents.openText({ name, text: entry.xml, kind: 'sqlplan' })
    documents.focusActive()
  }
  return <section className="retained-plans" aria-label="Retained plans" data-retained-plans="">
    <div className="retained-plan-controls">
      <label>Snapshot <select aria-label="Retained plan" value={entry?.id ?? ''} disabled={!entry} onChange={event => setSelected(event.target.value)}>
        {!entry && <option value="">No retained plans</option>}
        {history.entries.map(item => <option key={item.id} value={item.id}>{description(item)}</option>)}
      </select></label>
      <button type="button" disabled={!entry} aria-label={entry?.pinned ? 'Unpin snapshot' : 'Pin snapshot'} aria-pressed={entry?.pinned ?? false} onClick={() => entry && retainedPlans.pin(entry.id, !entry.pinned)}>{entry?.pinned ? 'Unpin' : 'Pin'}</button>
      <button type="button" disabled={!entry || busy} aria-label="Open snapshot document" onClick={() => open()}>Open</button>
      <button type="button" disabled={!entry || busy} aria-label="Save plan as…" onClick={() => open(true)}>Save as…</button>
      <button type="button" disabled={!entry} aria-label="Remove snapshot" onClick={() => entry && retainedPlans.remove(entry.id)}>Remove</button>
      <button type="button" disabled={!history.pending && !history.entries.some(entry => !entry.pinned)} onClick={() => retainedPlans.clear()}>Clear unpinned</button>
      <button type="button" disabled={!history.pending && !history.entries.length} onClick={() => retainedPlans.clear(true)}>Clear all snapshots</button>
    </div>
    <div className="retained-plan-budget">{history.entries.length} / {retainedPlanLimits.entries} snapshots · {size(history.bytes)} / {size(retainedPlanLimits.bytes)} · In memory for this window; save XML to persist.
      {history.pending > 0 && <span> · Copying {history.pending} execution(s)…</span>}</div>
    {history.notice && <div className="retained-plan-notice" role="status">{history.notice}</div>}
    {entry ? <>
      <details className="retained-plan-metadata" key={'metadata:' + entry.id}>
        <summary>{types[entry.captureType]}{entry.context.estimateMode ? ` · ${entry.context.estimateMode === 'session' ? 'Query session' : 'Isolated'}` : ''} · {entry.outcome.status}{entry.partialExecution ? ' · Partial execution' : ''}{entry.incomplete ? ' · Incomplete document' : ''}{entry.xmlTruncated ? ' · Truncated XML' : ''} · {entry.context.server ?? 'Server unavailable'} / {entry.context.database}</summary>
        <dl>
          <dt>Source</dt><dd>{entry.context.file ?? entry.context.name}</dd>
          <dt>Execution</dt><dd>{entry.context.executionId} · {new Date(entry.context.startedAt).toLocaleString()} → {new Date(entry.outcome.endedAt).toLocaleString()}{entry.outcome.elapsedMs !== undefined ? ` · ${entry.outcome.elapsedMs} ms` : ''}</dd>
          <dt>SQL context</dt><dd>{entry.context.sqlScope === 'selection' ? 'Selected SQL' : 'SQL document'}, starting at line {entry.context.startLine}; requested database {entry.context.database}{entry.outcome.database ? `; final database ${entry.outcome.database}` : ''}</dd>
          <dt>Plan source</dt><dd>{entry.sourceKey} · {position(entry)}{entry.row !== undefined ? `, row ${entry.row + 1}` : ''}</dd>
          <dt>Session</dt><dd>{entry.outcome.spid !== undefined ? `SPID ${entry.outcome.spid}` : 'SPID unavailable'}{entry.outcome.login ? ` · ${entry.outcome.login}` : ''}</dd>
          <dt>Capture</dt><dd>{entry.captureType === 'actual' ? 'Completed Extended Events capture' : entry.captureType === 'estimated' ? 'Estimated plan request (SQL was compiled without execution)' : 'SQL-returned Showplan XML; capture type was not supplied by SQL Server'}{entry.context.includeLivePlan ? ' · Live capture requested' : ''}</dd>
          {entry.outcome.error && <><dt>Execution error</dt><dd>{entry.outcome.error}</dd></>}
        </dl>
        <pre aria-label="Captured SQL context">{entry.context.sql}</pre>
      </details>
      {active && <PlanViewer key={'viewer:' + entry.id} sources={sources} identity={'retained:' + entry.id} />}
    </> : <EmptyState icon="execution-plan" title="No retained plans" detail="Completed actual and estimated plan documents are copied here automatically. Pin a snapshot to protect it from history eviction. Closing results or query tabs keeps this history." />}
  </section>
}
