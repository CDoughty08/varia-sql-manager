import { useEffect, useMemo, useRef, useState } from 'react'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { comparisonChoices, snapshotInput, documentInput, type ComparisonInput } from './comparison-inputs'
import type { ComparisonIndex } from './comparison.worker'
import ComparisonDetails from './ComparisonDetails'
import PlanViewer from './PlanViewer'
import type { Camera } from './geometry'
import { loadPlanSources, type SourceStatement } from './sources'
import './comparison.css'

type Prepared = { statements: SourceStatement[]; notices: string[] }
interface Comparison { prepared: [Prepared, Prepared]; pairs: ComparisonIndex[] }
const pageSize = 50
const sideNames = ['Left', 'Right'] as const
const inputLabels = ['Left comparison input', 'Right comparison input'] as const
const mark = (operator: ComparisonIndex['operators'][number]) => operator.status !== 'paired' ? operator.status : [operator.structural ? 'Structure changed' : operator.structureUnknown ? 'Parent relationship unavailable' : '', operator.propertiesChanged ? 'Properties changed' : operator.propertiesUnverified ? 'Property equality unverified (shortened fields)' : ''].filter(Boolean).join(' · ') || 'Paired'

/** Owns exactly two immutable inputs. Each frozen input keeps one preparation scope for as long as it is held, so a swap
 * (a new matching generation, `run.id`) reuses its parse, pending or finished, and its layouts. Replacing the inputs,
 * hiding or unmounting drops the scopes; every generation change terminates matching and rejects late results. */
export default function PlanComparison({ initialSnapshot, initialDocument, active = true, close }: { initialSnapshot?: string; initialDocument?: string; active?: boolean; close(): void }) {
  const { retainedPlans, documents, planPreparation, files } = useWorkbench()
  const history = useServiceSnapshot(retainedPlans), docs = useServiceSnapshot(documents)
  const choices = useMemo(() => comparisonChoices(history.entries, docs.documents), [history.entries, docs.documents])
  const initial = initialSnapshot ? 'snapshot:' + initialSnapshot : initialDocument ? 'document:' + initialDocument : choices[0]?.id ?? ''
  const [picks, setPicks] = useState<[string, string]>([initial, choices.find(choice => choice.id !== initial)?.id ?? initial])
  const [run, setRun] = useState<{ id: string; owner: string; inputs: [ComparisonInput, ComparisonInput]; scopes: [string, string] }>()
  const [comparison, setComparison] = useState<Comparison>()
  const [error, setError] = useState('')
  const [linked, setLinked] = useState(true)
  const [selected, setSelected] = useState<[string, string]>(['', ''])
  const [cameras, setCameras] = useState<[Camera | undefined, Camera | undefined]>([undefined, undefined])
  const [pairIndex, setPairIndex] = useState(0), [operatorIndex, setOperatorIndex] = useState(-1), [page, setPage] = useState(0)
  const [details, setDetails] = useState(false), [pairing, setPairing] = useState(false)
  const linkedRef = useRef(linked)
  const lastSide = useRef(0)
  linkedRef.current = linked
  const capture = (id: string): ComparisonInput => {
    if (id.startsWith('snapshot:')) {
      const entry = history.entries.find(entry => 'snapshot:' + entry.id === id)
      if (entry) return snapshotInput(entry)
    } else {
      const document = docs.documents.find(document => 'document:' + document.id === id), model = document && documents.getModel(document.id)
      if (document && model && !documents.isFilling(document.id)) return documentInput(document, model)
    }
    throw new Error('The selected input is unavailable or still loading. Select a retained snapshot or an open plan document.')
  }
  const start = () => {
    setComparison(undefined); setError('')
    try {
      const id = 'comparison:' + crypto.randomUUID()
      setRun({ id, owner: id, inputs: [capture(picks[0]), capture(picks[1])], scopes: [id + ':input:0', id + ':input:1'] })
    }
    catch (error) { setRun(undefined); setError(error instanceof Error ? error.message : 'The inputs could not be acquired.') }
  }
  const owner = run?.owner
  useEffect(() => {
    if (!owner || !active) return
    return () => { for (const side of [0, 1]) planPreparation.close(`${owner}:input:${side}`) }
  }, [owner, active, planPreparation])
  useEffect(() => {
    setComparison(undefined); setSelected(['', '']); setCameras([undefined, undefined]); setPairIndex(0); setOperatorIndex(-1); setPage(0)
    if (!run || !active) return
    setError('')
    const stop = new AbortController(), scopes = run.scopes
    let worker: Worker | undefined
    // Leaving a generation only detaches from the shared preparations; a failure also drops them so a retry starts clean.
    const detach = () => { stop.abort(); worker?.terminate() }
    const release = () => { detach(); for (const scope of scopes) planPreparation.close(scope) }
    const timer = setTimeout(() => { release(); setError('Comparison preparation exceeded 35 seconds. Choose inputs and compare again.') }, 35_000)
    const parse = (xml: string) => window.varia.parsePlan(xml)
    void Promise.all(run.inputs.map((input, side) => loadPlanSources([input.source], parse, stop.signal,
      (source, signal, remaining) => planPreparation.prepare(scopes[side], source, parse, signal, remaining)).then(prepared => ({ ...prepared,
        statements: prepared.statements.map(statement => ({ ...statement, captureLabel: input.provenance })) })))).then(prepared => {
      if (stop.signal.aborted) return
      worker = new Worker(new URL('./comparison.worker.ts', import.meta.url), { type: 'module' })
      const failed = () => { if (!stop.signal.aborted) { clearTimeout(timer); release(); setError('The comparison worker could not match these plans. Choose inputs and compare again.') } }
      worker.onerror = failed; worker.onmessageerror = failed
      worker.onmessage = (event: MessageEvent<{ ok: boolean; pairs: ComparisonIndex[]; error?: string }>) => {
        worker?.terminate(); clearTimeout(timer)
        if (stop.signal.aborted) return
        if (event.data.ok) setComparison({ prepared: prepared as [Prepared, Prepared], pairs: event.data.pairs })
        else { release(); setError(event.data.error ?? 'The plans could not be compared.') }
      }
      worker.postMessage({ left: prepared[0].statements, right: prepared[1].statements })
    }).catch(error => { if (!stop.signal.aborted) { clearTimeout(timer); release(); setError(error instanceof Error ? error.message : 'Comparison preparation failed.') } })
    return () => { clearTimeout(timer); detach() }
  }, [run, active, planPreparation])
  const indexes = useMemo(() => comparison?.prepared.map(prepared => ({ statements: new Map(prepared.statements.map(s => [s.id, s])),
    nodes: new Map(prepared.statements.flatMap(s => s.nodes.map(node => [node.id, node] as const))) })), [comparison])
  const lookup = useMemo(() => {
    const result = [new Map<string, { statement: number; operator: number }>(), new Map<string, { statement: number; operator: number }>()]
    comparison?.pairs.forEach((pair, statement) => pair.operators.forEach((operator, index) => {
      if (operator.left) result[0].set(operator.left, { statement, operator: index })
      if (operator.right) result[1].set(operator.right, { statement, operator: index })
    }))
    return result
  }, [comparison])
  const marks = useMemo(() => {
    const result = [new Map<string, string>(), new Map<string, string>()]
    comparison?.pairs.forEach(pair => pair.operators.forEach(operator => {
      if (operator.left) result[0].set(operator.left, mark(operator))
      if (operator.right) result[1].set(operator.right, mark(operator))
    }))
    return result
  }, [comparison])
  const select = (side: number, id: string) => {
    lastSide.current = side
    const found = lookup[side].get(id)
    if (!found || !comparison) return
    setPairIndex(found.statement); setOperatorIndex(found.operator); setPage(Math.floor(found.operator / pageSize))
    const operator = comparison.pairs[found.statement].operators[found.operator]
    setSelected(previous => linked ? [operator.left ?? '', operator.right ?? ''] : side === 0 ? [id, previous[1]] : [previous[0], id])
  }
  const selectStatement = (index: number) => { setPairIndex(index); setOperatorIndex(-1); setPage(0); if (linked) setSelected(['', '']) }
  const pair = comparison?.pairs[pairIndex], operator = pair?.operators[operatorIndex]
  const counts = useMemo(() => {
    const operators = comparison?.pairs.flatMap(pair => pair.operators) ?? []
    return `${comparison?.pairs.filter(pair => pair.status === 'paired').length ?? 0} paired statements · ${operators.filter(op => op.status === 'paired').length} paired operators · ${operators.filter(op => op.status === 'ambiguous').length} ambiguous entries · ${operators.filter(op => op.status === 'left-only' || op.status === 'right-only').length} unmatched entries`
  }, [comparison])
  return <section className="plan-comparison" aria-label="Plan comparison">
    <div className="comparison-controls">
      {sideNames.map((side, index) => <label key={side}>{side} plan <select aria-label={inputLabels[index]} value={picks[index]} title={choices.find(choice => choice.id === picks[index])?.detail}
        aria-description={choices.find(choice => choice.id === picks[index])?.detail} onChange={event => {
        setRun(undefined); setComparison(undefined); setError(''); setPicks(previous => index === 0 ? [event.target.value, previous[1]] : [previous[0], event.target.value])
      }}>
        {!choices.some(choice => choice.id === picks[index]) && <option value={picks[index]}>Input unavailable</option>}
        {choices.map(choice => <option key={choice.id} value={choice.id} title={choice.detail}>{choice.label}</option>)}
      </select></label>)}
      <button type="button" onClick={start} disabled={!picks.every(pick => choices.some(choice => choice.id === pick))}>Compare selected plans</button>
      <button type="button" onClick={() => {
        setPicks([picks[1], picks[0]]); setError(''); setComparison(undefined)
        if (run) setRun({ id: 'comparison:' + crypto.randomUUID(), owner: run.owner, inputs: [run.inputs[1], run.inputs[0]], scopes: [run.scopes[1], run.scopes[0]] })
      }}>Swap plans</button>
      <button type="button" onClick={() => { void files.open() }} disabled={docs.busy}>Open saved plan…</button>
      <button type="button" onClick={close}>Close comparison</button>
      <label><input type="checkbox" checked={linked} onChange={event => {
        setLinked(event.target.checked)
        if (event.target.checked) {
          const side = lastSide.current, found = lookup[side].get(selected[side])
          const operator = found && comparison?.pairs[found.statement].operators[found.operator]
          setSelected([operator?.left ?? '', operator?.right ?? ''])
          setCameras(previous => previous[side] ? [previous[side], previous[side]] : previous)
        }
      }} />Link selection, zoom and pan</label>
      <button type="button" aria-pressed={details} onClick={() => setDetails(!details)}>Differences</button>
      <button type="button" aria-pressed={pairing} onClick={() => setPairing(!pairing)}>Pairing list</button>
    </div>
    {!run && <p className="comparison-note">Choose two retained snapshots or open .sqlplan documents. Compare freezes the current XML, including unsaved edits. Later edits, saves, source closure and history removal do not alter these inputs. Compare again to use new contents. Saved XML has no retained capture provenance.</p>}
    {error && <p className="comparison-note" role="alert">{error}</p>}
    {run && <div className="comparison-provenance">{run.inputs.map((input, side) => <details key={side}><summary title={input.provenance}>{sideNames[side]} · {input.snapshot
      ? `${input.snapshot.captureType === 'actual' ? 'Actual' : input.snapshot.captureType === 'estimated' ? 'Estimated' : 'SQL-returned (unspecified)'} · ${input.snapshot.context.estimateMode ?? 'Mode unavailable'} · ${input.snapshot.outcome.status}${input.snapshot.partialExecution ? ' · Partial execution' : ''}`
      : `${input.label} · revision ${input.document?.revision} · Capture provenance unavailable`}</summary>
      <p>{input.provenance}</p>
      {input.snapshot && <dl><dt>Execution</dt><dd>{input.snapshot.context.executionId} · {input.snapshot.outcome.status}</dd><dt>Estimation mode</dt><dd>{input.snapshot.context.estimateMode ?? 'Unavailable'}</dd>
        <dt>Session</dt><dd>{input.snapshot.outcome.spid ?? 'Unavailable'} · {input.snapshot.outcome.login ?? 'Login unavailable'}</dd>
        <dt>Ended</dt><dd>{new Date(input.snapshot.outcome.endedAt).toLocaleString()} · {input.snapshot.outcome.elapsedMs === undefined ? 'Elapsed unavailable' : `${input.snapshot.outcome.elapsedMs} ms`}</dd>
        <dt>SQL context</dt><dd>{input.snapshot.context.sqlScope}, line {input.snapshot.context.startLine} · requested database {input.snapshot.context.database} · final database {input.snapshot.outcome.database ?? 'Unavailable'}</dd>
        <dt>Execution error</dt><dd>{input.snapshot.outcome.error ?? 'None reported'}</dd></dl>}
      <button type="button" aria-label={`Open ${sideNames[side].toLowerCase()} comparison XML`} onClick={() => {
        documents.openText({ name: `${sideNames[side]} comparison.sqlplan`, text: input.xml, kind: 'sqlplan' }); documents.focusActive()
      }}>Open frozen XML</button>
      <p>Frozen comparison input. Capture outcome and XML completeness are independent. Diagnostic omissions and parser notices remain visible in each viewer.</p>
    </details>)}</div>}
    {run && !comparison && !error && <p className="comparison-note" role="status">Preparing comparison…</p>}
    {comparison && run && <>
      <div className="comparison-controls"><span role="status">{counts}</span>
        <label>Statement pair <select aria-label="Comparison statement pair" value={pairIndex} onChange={event => selectStatement(Number(event.target.value))}>
          {comparison.pairs.map((pair, index) => <option key={index} value={index}>{index + 1}. {pair.status} · {(indexes?.[0].statements.get(pair.left ?? '')?.text ?? indexes?.[1].statements.get(pair.right ?? '')?.text)?.slice(0, 72)}</option>)}
        </select></label>
      </div>
      {pairing && pair && <div className="comparison-pairing" role="region" aria-label="Operator pairing list">
        <div className="comparison-controls"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous operators</button>
          <span>{pair.operators.length ? page * pageSize + 1 : 0}–{Math.min((page + 1) * pageSize, pair.operators.length)} of {pair.operators.length} entries</span>
          <button type="button" disabled={(page + 1) * pageSize >= pair.operators.length} onClick={() => setPage(page + 1)}>Next operators</button></div>
        {pair.operators.slice(page * pageSize, (page + 1) * pageSize).map((op, offset) => <button type="button" key={page * pageSize + offset} aria-pressed={operatorIndex === page * pageSize + offset}
          onClick={() => select(op.left ? 0 : 1, op.left ?? op.right!)}>{mark(op)} · L: {op.left ? indexes?.[0].nodes.get(op.left)?.physicalOp : 'Unmatched'} · R: {op.right ? indexes?.[1].nodes.get(op.right)?.physicalOp : 'Unmatched'} · {op.reason}</button>)}
      </div>}
      <div className="comparison-viewers">{sideNames.map((side, index) => <section key={side} aria-label={side + ' plan view'}>
        <div className="comparison-side-note">{side} · {(index === 0 ? pair?.left : pair?.right) ? 'Statement in selected pair' : 'No statement counterpart; the input remains available to inspect'}</div>
        <PlanViewer key={run.id + side} sources={[run.inputs[index].source]} identity={run.id + ':' + side} scope={run.scopes[index]} visible={active} compact transient
          prepared={comparison.prepared[index]} marks={marks[index]} navigation={{ selected: selected[index], statement: linked ? (index === 0 ? pair?.left : pair?.right) ?? '' : undefined,
            camera: cameras[index], select: id => select(index, id), selectStatement: id => {
              lastSide.current = index
              const next = comparison.pairs.findIndex(pair => (index === 0 ? pair.left : pair.right) === id)
              if (next >= 0) { setPairIndex(next); setOperatorIndex(-1); setPage(0); setSelected(previous => linked ? ['', ''] : index === 0 ? ['', previous[1]] : [previous[0], '']) }
            }, cameraChanged: camera => {
              lastSide.current = index
              if (linkedRef.current) setCameras([camera, camera])
              else setCameras(previous => index === 0 ? [camera, previous[1]] : [previous[0], camera])
            } }} />
      </section>)}</div>
      {details && <ComparisonDetails left={indexes?.[0].nodes.get(operator?.left ?? '')} right={indexes?.[1].nodes.get(operator?.right ?? '')}
        leftStatement={indexes?.[0].statements.get(pair?.left ?? '')} rightStatement={indexes?.[1].statements.get(pair?.right ?? '')}
        reason={operator ? `${mark(operator)} · ${operator.reason}` : pair?.reason} />}
    </>}
  </section>
}
