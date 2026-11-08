import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { type PlanNode, type PlanStatement } from '../../../shared/plans'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { observeIntersection, observeResize, windows } from '../core/windows'
import EmptyState from '../kit/EmptyState'
import type { CanvasColors, HoveredOperator, PlanCanvas } from './PlanCanvas'
import type { Camera, PlanLayout } from './geometry'
import { loadPlanSources, type PlanSource, type SourceStatement } from './sources'
import { PlanHoverCard } from './PlanHoverCard'
import { PlanProperties } from './PlanProperties'
import { discrepancyLabel, formatPlanMetric, rankOperators, rankingValue, type OperatorRanking } from './diagnostics'
import type { QueryPlanState } from './QueryPlansService'
import { completedPlanView, planTopology, queryPlanStatements } from './live-model'

interface Content { statements: SourceStatement[]; notices: string[]; layout?: PlanLayout; error?: string; empty?: boolean }
const message = (error: unknown) => error instanceof Error ? error.message : 'The execution plan could not be opened.'

export function findOperators(statements: readonly PlanStatement[], query: string, warningsOnly: boolean): { node: PlanNode; statement: number }[] {
  const needle = query.trim().toLocaleLowerCase()
  return statements.flatMap((statement, index) => statement.nodes.filter(node => (!warningsOnly || node.warnings.length > 0)
    && (!needle || [node.physicalOp, node.logicalOp, node.object, node.nodeId, ...node.warnings].some(value => value.toLocaleLowerCase().includes(needle)))).map(node => ({ node, statement: index })))
}

/** One shared world, a virtual operator outline and a text inspector. No statement owns a nested graph scroller. */
export default function PlanViewer({ sources, identity, scope = identity, visible = true, openDocument, live }: { sources: readonly PlanSource[]; identity: string; scope?: string; visible?: boolean; openDocument?(sourceKey: string): void; live?: QueryPlanState }) {
  const { theme, planPreparation, resultClient, documents } = useWorkbench()
  const [generation, setGeneration] = useState(resultClient.backendGeneration)
  useEffect(() => {
    const subscription = resultClient.onGeneration(setGeneration)
    return () => subscription.dispose()
  }, [resultClient])
  const colors = useServiceSnapshot(theme).active.colors
  const [parsed, setParsed] = useState<Content>({ statements: [], notices: [] })
  const [layoutState, setLayoutState] = useState<{ topology?: string; layout?: PlanLayout; error?: string }>({})
  const [mode, setMode] = useState<'live' | 'actual'>(live?.running ? 'live' : 'actual')
  const actual = useMemo(() => live ? queryPlanStatements(parsed.statements) : parsed.statements, [parsed.statements, !!live])
  const display = useMemo(() => live ? mode === 'live' ? { statements: live.model.statements, omitted: 0 } : completedPlanView(live.model.statements, actual) : { statements: actual, omitted: 0 }, [live?.model.statements, actual, mode])
  const statements = display.statements
  const topology = useMemo(() => planTopology(statements), [statements])
  const statementsRef = useRef(statements)
  statementsRef.current = statements
  const content: Content = { ...parsed, ...layoutState.topology === topology ? layoutState : {}, statements: statements as SourceStatement[], notices: [...parsed.notices, ...parsed.error && statements.length ? [parsed.error] : [],
    ...display.omitted ? ['Some partial snapshots were omitted to stay within the combined viewer limits. Captured actual plans take priority; use Live mode to inspect retained snapshots.'] : [], ...live?.note ? [live.note] : []] }
  useEffect(() => { if (live && !live.running) setMode('actual') }, [live?.running])
  const saved = planPreparation.view(identity)
  const [selected, setSelected] = useState(saved?.selected ?? '')
  const [statement, setStatement] = useState(saved?.statement)
  const [xmlSource, setXmlSource] = useState(saved?.xmlSource)
  const [query, setQuery] = useState(saved?.query ?? '')
  const [warningsOnly, setWarningsOnly] = useState(false)
  const [ranking, setRanking] = useState<OperatorRanking>('plan')
  const [outline, setOutline] = useState(true)
  const [gpuFailed, setGpuFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [inspector, setInspector] = useState(true)
  const [zoom, setZoom] = useState(saved?.camera?.scale ?? 1)
  const [hovered, setHovered] = useState<HoveredOperator>()
  const viewer = useRef<HTMLElement>(null)
  const root = useRef<HTMLDivElement>(null), canvas = useRef<PlanCanvas | undefined>(undefined), tree = useRef<HTMLDivElement>(null)
  const [onScreen, setOnScreen] = useState(false)
  const [canvasOnScreen, setCanvasOnScreen] = useState(false)
  useEffect(() => {
    const element = viewer.current, surface = root.current
    if (!element || !surface) return
    let intersecting = false, owner = element.ownerDocument
    const changed = () => setOnScreen(intersecting && !owner.hidden)
    const visibility = observeIntersection(element, entries => { intersecting = entries.some(entry => entry.isIntersecting); changed() })
    const surfaceVisibility = observeIntersection(surface, entries => setCanvasOnScreen(entries.some(entry => entry.isIntersecting)))
    owner.addEventListener('visibilitychange', changed)
    const adoption = windows.onDidAdopt(() => {
      owner.removeEventListener('visibilitychange', changed); owner = element.ownerDocument
      owner.addEventListener('visibilitychange', changed); changed()
    })
    return () => { visibility.dispose(); surfaceVisibility.dispose(); adoption.dispose(); owner.removeEventListener('visibilitychange', changed) }
  }, [])
  const active = visible && onScreen
  const graphActive = active && canvasOnScreen
  const [scroll, setScroll] = useState(0), [height, setHeight] = useState(400)
  const camera = useRef<Camera | undefined>(saved?.camera)
  const selection = useRef<(id: string) => void>(() => {})
  const latest = useRef({ selected, statement, xmlSource, query })
  latest.current = { selected, statement, xmlSource, query }
  const sourceRef = useRef(sources)
  sourceRef.current = sources
  const preparedSources = useRef<{ generation: number; sources: readonly PlanSource[] } | undefined>(undefined)
  const sourceKey = useMemo(() => JSON.stringify(sources.map(({ key, revision }) => [key, revision])), [sources])
  const labelId = useId()
  useEffect(() => () => {
    if (scope === identity || documents.get(scope)) planPreparation.rememberView(scope, identity, { ...latest.current, camera: camera.current })
  }, [identity, scope, planPreparation, documents])
  useEffect(() => {
    if (!active) return
    const stop = new AbortController()
    const input = sourceRef.current, previous = preparedSources.current
    // Keep already prepared statements while streaming adds or reorders immutable sources.
    if (!previous || previous.generation !== generation || !previous.sources.every(old => input.some(source => source.key === old.key && source.revision === old.revision)))
      setParsed({ statements: [], notices: [] })
    const parse = (xml: string) => window.varia.parsePlan(xml)
    void loadPlanSources(sourceRef.current, parse, stop.signal, (source, signal, remaining) => planPreparation.prepare(scope, source, parse, signal, remaining)).then(
      value => { if (!stop.signal.aborted) { preparedSources.current = { generation, sources: input }; setParsed({ ...value, empty: !value.statements.length }) } },
      error => { if (!stop.signal.aborted) setParsed({ statements: [], notices: [], error: message(error) }) })
    return () => stop.abort()
  }, [identity, scope, sourceKey, retry, active, generation, planPreparation])
  useEffect(() => {
    if (!graphActive) return
    const cached = planPreparation.layout(scope, topology)
    setLayoutState(cached ? { topology, layout: cached } : {})
    setGpuFailed(false)
    if (cached || !statementsRef.current.length) return
    const epoch = planPreparation.epoch
    let worker: Worker
    try { worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' }) }
    catch {
      setLayoutState({ topology, error: 'The plan layout worker could not be started. Its operator outline and XML source are available.' })
      return
    }
    let stopped = false
    const failed = () => {
      if (stopped) return
      stopped = true; clearTimeout(timer); worker.terminate()
      setLayoutState({ topology, error: 'The plan could not be laid out within 20 seconds. Its operator outline and XML source are available.' })
    }
    const timer = setTimeout(failed, 20_000)
    worker.onerror = failed
    worker.onmessageerror = failed
    worker.onmessage = (event: MessageEvent<{ ok: boolean; layout: PlanLayout; error?: string }>) => {
      clearTimeout(timer)
      worker.terminate()
      if (!stopped) {
        if (event.data.ok) planPreparation.rememberLayout(scope, topology, event.data.layout, sourceRef.current, epoch)
        setLayoutState(event.data.ok ? { topology, layout: event.data.layout } : { topology, error: event.data.error })
      }
    }
    worker.postMessage(statementsRef.current.map(entry => ({ id: entry.id, nodes: entry.nodes.map(node => ({ id: node.id, parentId: node.parentId })) })))
    return () => { stopped = true; clearTimeout(timer); worker.terminate() }
  }, [identity, scope, topology, retry, graphActive, planPreparation])
  const palette: CanvasColors = useMemo(() => ({ background: colors['panel.background'], card: colors['input.background'], text: colors.foreground,
    muted: colors.descriptionForeground, border: colors['panel.border'], accent: colors.focusBorder, warning: colors.warningForeground }), [colors])
  const paletteRef = useRef(palette)
  paletteRef.current = palette
  useEffect(() => {
    const element = root.current, layout = content.layout
    if (!graphActive || !element || !layout) return
    let disposed = false
    void import('./PlanCanvas').then(({ PlanCanvas }) => {
      if (disposed) return
      canvas.current = new PlanCanvas({ root: element, statements: statementsRef.current, layout, colors: paletteRef.current, camera: camera.current,
        select: id => selection.current(id), hover: setHovered,
        cameraChanged: value => { camera.current = value; setZoom(current => current === value.scale ? current : value.scale) }, failed: () => setGpuFailed(true) })
      canvas.current.select(latest.current.selected)
    }).catch(() => { if (!disposed) setGpuFailed(true) })
    return () => { disposed = true; canvas.current?.dispose(); canvas.current = undefined }
  }, [content.layout, graphActive, retry])
  useEffect(() => { canvas.current?.update(content.statements) }, [content.statements])
  useEffect(() => { canvas.current?.colors(palette) }, [palette])
  useEffect(() => { canvas.current?.select(selected, true) }, [selected])
  useLayoutEffect(() => {
    const element = tree.current
    if (!element) return
    // The outline is recreated when shown again, while its virtual offset survives.
    element.scrollTop = scroll
    setScroll(element.scrollTop)
    const observer = observeResize(element, () => setHeight(element.clientHeight))
    return () => observer.dispose()
  }, [outline, topology])
  const matches = useMemo(() => findOperators(content.statements, query, warningsOnly), [content.statements, query, warningsOnly])
  const allNodes = useMemo(() => new Map(content.statements.flatMap((entry, s) => entry.nodes.map(node => [node.id, { node, statement: s }] as const))), [content.statements])
  const hoveredNode = !gpuFailed && content.layout && hovered ? allNodes.get(hovered.id)?.node : undefined
  const selectedMatch = allNodes.get(selected)
  const selectedNode = selectedMatch?.node
  const activeStatement = selectedMatch?.statement ?? Math.max(0, content.statements.findIndex(entry => entry.id === statement?.id))
  const current = content.statements[activeStatement]
  const shown = useMemo(() => rankOperators(query.trim() || warningsOnly ? matches : matches.filter(match => match.statement === activeStatement), ranking), [matches, query, warningsOnly, activeStatement, ranking])
  const rowHeight = 32, first = Math.max(0, Math.floor(scroll / rowHeight) - 3), last = Math.min(shown.length, Math.ceil((scroll + height) / rowHeight) + 3)
  const choose = (id: string) => {
    setSelected(id)
    const match = allNodes.get(id)
    if (match) {
      const { id, sourceKey } = content.statements[match.statement]
      setStatement({ id, sourceKey })
    }
    const index = shown.findIndex(match => match.node.id === id)
    const element = tree.current
    if (element && index >= 0) {
      if (index * rowHeight < element.scrollTop) element.scrollTop = index * rowHeight
      else if ((index + 1) * rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = (index + 1) * rowHeight - element.clientHeight
    }
  }
  selection.current = choose
  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !shown.length) return
    const selectedIndex = shown.findIndex(match => match.node.id === selected)
    const at = Math.max(0, selectedIndex)
    let next: string | undefined
    if (event.key === 'ArrowDown') next = shown[Math.min(selectedIndex + 1, shown.length - 1)].node.id
    else if (event.key === 'ArrowUp') next = shown[selectedIndex < 0 ? shown.length - 1 : Math.max(0, at - 1)].node.id
    else if (event.key === 'Home') next = shown[0].node.id
    else if (event.key === 'End') next = shown.at(-1)!.node.id
    else if (event.key === 'ArrowLeft') next = shown[at].node.parentId ?? undefined
    else if (event.key === 'ArrowRight') next = shown.find(match => match.node.parentId === shown[at].node.id)?.node.id
    if (next && shown.some(match => match.node.id === next)) { event.preventDefault(); choose(next) }
  }
  const selectStatement = (id: string) => {
    const index = content.statements.findIndex(entry => entry.id === id)
    if (index < 0) return
    setStatement({ id, sourceKey: content.statements[index].sourceKey })
    setXmlSource(undefined)
    setSelected('')
    setScroll(0)
    if (tree.current) tree.current.scrollTop = 0
    canvas.current?.fit(index)
  }
  const preferredSource = xmlSource ?? current?.sourceKey ?? statement?.sourceKey ?? sources[0]?.key
  const selectedSource = sources.find(source => source.key === preferredSource)
  const warnings = useMemo(() => [...allNodes.values()].filter(({ node }) => node.warnings.length).length, [allNodes])
  return <section ref={viewer} className="plan-viewer" aria-label="Execution plan viewer" onKeyDownCapture={event => {
    if (event.key !== 'Escape' || !hovered) return
    canvas.current?.dismissHover()
    event.preventDefault()
    event.stopPropagation()
  }}>
    <div className="plan-tools" role="toolbar" aria-label="Plan navigation">
      {live && <>
        <button type="button" aria-pressed={mode === 'live'} onClick={() => setMode('live')}>Live</button>
        <button type="button" aria-pressed={mode === 'actual'} onClick={() => setMode('actual')} disabled={live.running && !sources.length}>Actual</button>
        <span className="plan-tools-fact">{live.running ? 'Query running' : 'Query ended'}</span>
      </>}
      <button type="button" aria-pressed={outline} onClick={() => setOutline(!outline)}>Outline</button>
      <button type="button" aria-pressed={inspector} onClick={() => setInspector(!inspector)}>Properties</button>
      {openDocument && (sources.length > 1 || !selectedSource && sources.length > 0) && <label>XML source <select aria-label="Plan XML source" value={selectedSource?.key ?? ''} onChange={event => setXmlSource(event.target.value)}>
        {!selectedSource && <option value="" disabled>Selected plan is unavailable</option>}
        {sources.map(source => <option key={source.key} value={source.key}>{source.label}</option>)}
      </select></label>}
      {openDocument && <button type="button" onClick={() => { if (selectedSource) openDocument(selectedSource.key) }} disabled={!selectedSource}>Open plan document</button>}
      <label>Statement <select aria-label="Plan statement" value={current?.id ?? ''} onChange={event => selectStatement(event.target.value)} disabled={!content.statements.length}>
        {content.statements.map((entry, index) => <option key={entry.id} value={entry.id}>{index + 1}. {entry.text.trim().slice(0, 72) || [entry.type || 'Statement', entry.batchLabel].filter(Boolean).join(' · ')}</option>)}
      </select></label>
      <button type="button" onClick={() => canvas.current?.fit(activeStatement)} disabled={!content.layout}>Fit statement</button>
      <button type="button" onClick={() => canvas.current?.fit()} disabled={!content.layout}>Fit batch</button>
      <button type="button" aria-label="Zoom out plan" onClick={() => canvas.current?.zoom(1 / 1.2)} disabled={!content.layout}>Zoom out</button>
      <button type="button" aria-label="Reset plan zoom to 100%" onClick={() => canvas.current?.actualSize()} disabled={!content.layout}>{(zoom * 100).toLocaleString(undefined, { maximumFractionDigits: zoom < 0.01 ? 3 : 0 })}%</button>
      <button type="button" aria-label="Zoom in plan" onClick={() => canvas.current?.zoom(1.2)} disabled={!content.layout}>Zoom in</button>
      <span className="plan-tools-fact">{content.statements.length} statements · {allNodes.size} operators</span>
    </div>
    {content.notices.map((notice, index) => <div className="plan-notice" role="status" key={index}>{notice}</div>)}
    <div className="plan-body">
      {outline && <aside className="plan-outline" aria-label="Plan outline">
        <input type="search" aria-label="Find plan operators" placeholder="Find operators or objects" maxLength={256} value={query} onChange={event => { setQuery(event.target.value); setScroll(0); if (tree.current) tree.current.scrollTop = 0 }} />
        <label className="plan-warning-filter"><input type="checkbox" checked={warningsOnly} onChange={event => { setWarningsOnly(event.target.checked); setScroll(0); if (tree.current) tree.current.scrollTop = 0 }} />Warnings only ({warnings})</label>
        <div className="plan-outline-actions"><span className="plan-outline-summary" role="status">{shown.length} {query.trim() || warningsOnly ? 'matching' : ''} operators{ranking !== 'plan' ? ' available' : ''}</span>
          <select className="plan-ranking" aria-label="Operator ranking" aria-description="Descending available values, including measured zero. CPU sums threads; elapsed is the maximum thread in milliseconds. Operator times may overlap. Row discrepancy compares total rows to all estimated executions. Live totals are partial." value={ranking} onChange={event => { setRanking(event.target.value as OperatorRanking); setScroll(0); if (tree.current) tree.current.scrollTop = 0 }}>
            <option value="plan">Plan order</option><option value="cpu">CPU · summed threads</option><option value="elapsed">Elapsed · max thread</option><option value="rows">Row-estimate discrepancy</option>
          </select></div>
        <div className="plan-operator-tree" ref={tree} role="tree" aria-label="Plan operators" tabIndex={0} onKeyDown={navigate} onScroll={event => setScroll(event.currentTarget.scrollTop)}
          aria-activedescendant={shown.slice(first, last).some(match => match.node.id === selected) ? labelId + selected : undefined}>
          <div style={{ height: shown.length * rowHeight, position: 'relative' }}>{shown.slice(first, last).map(({ node }, offset) => <div key={node.id} id={labelId + node.id}
            role="treeitem" aria-selected={selected === node.id} aria-level={1} aria-setsize={shown.length} aria-posinset={first + offset + 1}
            className="plan-operator-item" style={{ top: (first + offset) * rowHeight, height: rowHeight }} onClick={() => { choose(node.id); tree.current?.focus() }} title={[node.physicalOp, node.object, ...node.warnings].filter(Boolean).join(' · ')}>
            <span>{node.physicalOp}{ranking !== 'plan' ? ` · ${ranking === 'rows' ? discrepancyLabel(node) : formatPlanMetric(rankingValue(node, ranking)) + ' ms'}` : ''}</span><small>{node.warnings.length ? 'Warning · ' : ''}{node.object || `Node ${node.nodeId}`}</small>
          </div>)}</div>
        </div>
      </aside>}
      <div className="plan-canvas-shell">
        <div className="plan-canvas" ref={root} tabIndex={0} role="region" aria-label="Query plan canvas" aria-description="Drag or scroll to pan. Pinch or Control-scroll to zoom. Hover over an operator for statistics, or use the outline or arrow keys to select it." aria-describedby={hoveredNode ? labelId + 'stats' : undefined} onKeyDown={navigate} />
        {hovered && hoveredNode && root.current && <PlanHoverCard node={hoveredNode} anchor={hovered.anchor} owner={root.current.ownerDocument} id={labelId + 'stats'}
          hold={() => canvas.current?.holdHover()} leave={() => canvas.current?.leaveHover()} />}
        {(!content.layout || gpuFailed) && <div className="plan-canvas-state"><EmptyState icon="execution-plan" detail={gpuFailed ? 'GPU rendering is unavailable. Use the operator outline and properties, or open the XML source.' : content.error ?? (content.empty ? 'This plan contains no statements to display. Its XML source is available.' : sources.length ? 'Preparing execution plans…' : 'Plans appear here when the query returns them.')}
          actions={content.error || gpuFailed ? [{ label: 'Retry plan viewer', run: () => setRetry(value => value + 1) }] : undefined} /></div>}
      </div>
      {inspector && <aside className="plan-inspector" aria-label="Plan properties">
        <PlanProperties statement={current} node={selectedNode} liveRunning={live?.running && mode === 'live'} />
      </aside>}
    </div>
  </section>
}
