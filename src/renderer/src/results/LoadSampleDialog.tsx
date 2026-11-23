import { useEffect, useId, useState } from 'react'
import type { SampleMethod } from '../../../shared/bigquery/remote-view'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import SubDialog from '../dialogs/SubDialog'
import type { SampleRequest } from './sample-dialog'
import { defaultSampleRows, maxSampleRows, parseSampleRows, sampleNote, sampleStatus, sampleTooLarge, type SampleEstimate } from './sample'
import { formatCount } from './status'

/** How long the dialog waits after the rows or method change before it asks BigQuery for a random sample's estimate (a free
 *  dry run), so typing a figure asks once. */
const estimateDelayMs = 400

/**
 * Load Sample (docs/bigquery.md, Load a sample): how many rows of a windowed BigQuery result to read into a new result in
 * memory, and how to pick them. The first rows are free (tabledata.list); a random sample (TABLESAMPLE SYSTEM) bills the
 * blocks it reads, so its estimate shows here and Load goes through the cost prompts. The note also says what memory the
 * sample needs.
 */
export default function LoadSampleDialog() {
  const { sampleDialog } = useWorkbench()
  const { request } = useServiceSnapshot(sampleDialog)
  return request ? <Dialog key={`${request.tabId}|${request.key}|${request.generation}:${request.resultId}`} request={request} /> : null
}

function Dialog({ request }: { readonly request: SampleRequest }) {
  const { sampleDialog, results, bigQueryCost, settings } = useWorkbench()
  const rowsId = useId(), methodId = useId(), noteId = useId(), hintId = useId(), warningId = useId(), sourceId = useId()
  const [text, setText] = useState(() => formatCount(defaultSampleRows(request.total, request.rowBytes, request.freeBytes)))
  const [method, setMethod] = useState<SampleMethod>('first')
  const [estimate, setEstimate] = useState<SampleEstimate | undefined>()
  const rows = parseSampleRows(text, request.total)
  const { tabId, resultId, generation } = request
  useEffect(() => {
    if (method !== 'random' || rows === undefined) { setEstimate(undefined); return }
    const abort = new AbortController()
    setEstimate({ state: 'estimating' })
    const timer = window.setTimeout(() => {
      bigQueryCost.estimateRemote(tabId, { resultId, generation, kind: 'sample', rows, method: 'random' }, abort.signal).then(value => {
        if (value && !abort.signal.aborted) setEstimate({ state: 'done', bytes: value.bytesProcessed, incomplete: value.incomplete !== undefined })
      }, (error: unknown) => {
        if (!abort.signal.aborted) setEstimate({ state: 'failed', reason: error instanceof Error ? error.message : String(error) })
      })
    }, estimateDelayMs)
    return () => { abort.abort(); window.clearTimeout(timer) }
  }, [bigQueryCost, tabId, resultId, generation, method, rows])
  const prices = settings.get('queryExecution.bigQuery.showCost') !== 'bytes'
  const note = sampleNote({ method, rows, rowBytes: request.rowBytes, freeBytes: request.freeBytes, prices, ...estimate ? { estimate } : {} })
  const tooLarge = sampleTooLarge(rows, request.rowBytes, request.freeBytes)
  const ok = () => {
    if (rows === undefined) return
    sampleDialog.close()
    void results.loadSample(tabId, request.key, rows, method).then(refused => { if (refused) results.announce(tabId, refused) })
  }
  return <SubDialog title="Load Sample" okLabel="Load" okDisabled={rows === undefined} onOk={ok} onCancel={() => sampleDialog.close()} className="load-sample-dialog"
    describedBy={tooLarge ? `${sourceId} ${noteId} ${warningId}` : `${sourceId} ${noteId}`} status={rows === undefined ? undefined : sampleStatus(method, rows, request.total)}>
    <div className="property-grid">
      {/* Which result it samples: several windowed results may be stacked. */}
      <div className="property-row"><span className="load-sample-label">Result</span><span className="load-sample-source" id={sourceId}>{request.name}</span></div>
      <div className="property-row"><label htmlFor={rowsId}>Rows</label>
        <span className="load-sample-rows">
          <input className="ui-field" id={rowsId} type="text" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={12} value={text}
            aria-invalid={rows === undefined || undefined} aria-describedby={rows === undefined ? hintId : undefined} onFocus={event => event.currentTarget.select()} onChange={event => setText(event.target.value)} />
          <span>of {formatCount(request.total)}</span>
        </span>
      </div>
      {rows === undefined && <p className="field-note" id={hintId} data-tone="warning">{`Enter a number from 1 to ${formatCount(maxSampleRows(request.total))}.`}</p>}
      <div className="property-row"><label htmlFor={methodId}>Sample</label>
        <select className="ui-field" id={methodId} value={method} onChange={event => setMethod(event.target.value as SampleMethod)}>
          <option value="first">First rows (free)</option>
          <option value="random">Random sample (bills the blocks read)</option>
        </select>
      </div>
      <p className="field-note" id={noteId}>{note}</p>
      {/* Only a settled estimate is announced: the note itself changes with every figure typed. */}
      <span className="visually-hidden" aria-live="polite">{estimate?.state === 'done' || estimate?.state === 'failed' ? sampleNote({ method, rows, rowBytes: undefined, freeBytes: undefined, prices, estimate }) : ''}</span>
      {tooLarge && <p className="field-note" id={warningId} data-tone="warning" role="status">The sample is larger than the result memory free, so it would stop early. Ask for fewer rows, or close other results first.</p>}
    </div>
  </SubDialog>
}
