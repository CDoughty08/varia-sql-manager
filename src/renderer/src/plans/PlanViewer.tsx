import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
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
import { revealAncestors, rowFlow, visibleOperators, operatorIcon } from './presentation'
import { PlanPaneSizer } from './PlanPaneSizer'
import Icon from '../Icon'
import type { PlanXmlTarget } from './navigation'

export interface PlanViewerHandle { getCamera(): Camera | undefined; setCamera(camera: Camera): void; getSelectedOperator(): string; selectOperator(id: string): void }
export interface PlanViewerProps {
  sources: readonly PlanSource[]; identity: string; scope?: string; visible?: boolean; live?: QueryPlanState
  openDocument?(sourceKey: string, target?: PlanXmlTarget): void
  navigateXml?(target: PlanXmlTarget): void; navigation?: PlanXmlTarget
  onXmlTargetChanged?(target: PlanXmlTarget | undefined): void
  controllerRef?: Ref<PlanViewerHandle>; onSelectionChanged?(id: string): void; onCameraChanged?(camera: Camera): void
}

interface Content { statements: SourceStatement[]; notices: string[]; layout?: PlanLayout; error?: string; empty?: boolean }
const message = (error: unknown) => error instanceof Error ? error.message : 'The execution plan could not be opened.'

export function findOperators(statements: readonly PlanStatement[], query: string, warningsOnly: boolean): { node: PlanNode; statement: number }[] {
  const needle = query.trim().toLocaleLowerCase()
  return statements.flatMap((statement, index) => statement.nodes.filter(node => (!warningsOnly || node.warnings.length > 0)
    && (!needle || [node.physicalOp, node.logicalOp, node.object, node.nodeId, ...node.warnings].some(value => value.toLocaleLowerCase().includes(needle)))).map(node => ({ node, statement: index })))
}

/** One shared world, a virtual operator outline and a text inspector. No statement owns a nested graph scroller. */
export default function PlanViewer({ sources, identity, scope = identity, visible = true, openDocument, live, controllerRef, onSelectionChanged, onCameraChanged, navigateXml, navigation, onXmlTargetChanged }: PlanViewerProps) {
  const { theme, planPreparation, resultClient, documents, settings } = useWorkbench()
  const preferences = useServiceSnapshot(settings).values
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
  const fullTopology = useMemo(() => planTopology(statements), [statements])
  const statementsRef = useRef(statements)
  statementsRef.current = statements
  useEffect(() => { if (live && !live.running) setMode('actual') }, [live?.running])
  const saved = planPreparation.view(identity)
  const [collapsed, setCollapsed] = useState(() => new Set(saved?.collapsed ?? []))
  useEffect(() => {
    if (!statementsRef.current.length) return
    const ids = new Set(statementsRef.current.flatMap(s => s.nodes.map(n => n.id)))
    setCollapsed(previous => {
      const next = new Set([...previous].filter(id => ids.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [fullTopology])
  const projection = useMemo(() => {
    const visible = visibleOperators(statementsRef.current, collapsed)
    return statementsRef.current.map(entry => ({ id: entry.id, nodes: entry.nodes.map((node, index) => ({ id: node.id, parentId: node.parentId, index })).filter(node => visible.has(node.id)) }))
  }, [fullTopology, collapsed])
  const topology = useMemo(() => JSON.stringify(projection), [projection])
  const content: Content = { ...parsed, ...layoutState.topology === topology ? layoutState : {}, statements: statements as SourceStatement[], notices: [...parsed.notices, ...parsed.error && statements.length ? [parsed.error] : [],
    ...display.omitted ? ['Some partial snapshots were omitted to stay within the combined viewer limits. Captured actual plans take priority; use Live mode to inspect retained snapshots.'] : [], ...live?.note ? [live.note] : []] }
  const [selected, setSelected] = useState(saved?.selected ?? '')
  const [statement, setStatement] = useState(saved?.statement)
  const [xmlSource, setXmlSource] = useState(saved?.xmlSource)
  const [query, setQuery] = useState(saved?.query ?? '')
  const [warningsOnly, setWarningsOnly] = useState(false)
  const [ranking, setRanking] = useState<OperatorRanking>('plan')
  const outline = preferences['queryResults.plan.outline'], inspector = preferences['queryResults.plan.properties']
  const minimap = preferences['queryResults.plan.minimap'], flow = preferences['queryResults.plan.rowFlow']
  const [outlineWidth, setOutlineWidth] = useState(preferences['queryResults.plan.outlineWidth'])
  const [propertiesWidth, setPropertiesWidth] = useState(preferences['queryResults.plan.propertiesWidth'])
  useEffect(() => setOutlineWidth(preferences['queryResults.plan.outlineWidth']), [preferences['queryResults.plan.outlineWidth']])
  useEffect(() => setPropertiesWidth(preferences['queryResults.plan.propertiesWidth']), [preferences['queryResults.plan.propertiesWidth']])
  const [gpuFailed, setGpuFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [zoom, setZoom] = useState(saved?.camera?.scale ?? 1)
  const [hovered, setHovered] = useState<HoveredOperator>()
  const [showSql, setShowSql] = useState(false)
  const returnToGraph = useRef(false)
  const viewer = useRef<HTMLElement>(null)
  const root = useRef<HTMLDivElement>(null), canvas = useRef<PlanCanvas | undefined>(undefined), tree = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!showSql && returnToGraph.current) { returnToGraph.current = false; (root.current?.getClientRects().length ? root.current : tree.current)?.focus() }
  }, [showSql])
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
  const revealPending = useRef(false)
  const latest = useRef({ selected, statement, xmlSource, query, collapsed: [...collapsed] })
  latest.current = { selected, statement, xmlSource, query, collapsed: [...collapsed] }
  const events = useRef({ onCameraChanged, onSelectionChanged })
  events.current = { onCameraChanged, onSelectionChanged }
  useImperativeHandle(controllerRef, () => ({ getCamera: () => camera.current ? { ...camera.current } : undefined,
    getSelectedOperator: () => latest.current.selected,
    setCamera: value => { if (canvas.current) canvas.current.setCamera(value); else if ([value.x, value.y, value.scale].every(Number.isFinite) && value.scale > 0) camera.current = { ...value, scale: Math.max(0.00001, Math.min(3, value.scale)) } },
    selectOperator: id => selection.current(id) }), [])
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
    worker.postMessage(projection)
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
        minimap, rowFlow: flow, collapsed,
        cameraChanged: value => { camera.current = value; setZoom(current => current === value.scale ? current : value.scale); events.current.onCameraChanged?.(value) }, failed: () => setGpuFailed(true) })
      canvas.current.select(latest.current.selected, revealPending.current)
      revealPending.current = false
    }).catch(() => { if (!disposed) setGpuFailed(true) })
    return () => { disposed = true; canvas.current?.dispose(); canvas.current = undefined }
  }, [content.layout, graphActive, retry])
  useEffect(() => { canvas.current?.update(content.statements) }, [content.statements])
  useEffect(() => { canvas.current?.colors(palette) }, [palette])
  useEffect(() => { canvas.current?.preferences(minimap, flow, collapsed) }, [minimap, flow, collapsed])
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
  const parents = useMemo(() => new Map(statements.flatMap(s => s.nodes.map(n => [n.id, n.parentId] as const))), [fullTopology])
  const branches = useMemo(() => new Set(statements.flatMap(s => s.nodes.flatMap(n => n.parentId ? [n.parentId] : []))), [fullTopology])
  const hoveredNode = !gpuFailed && content.layout && hovered ? allNodes.get(hovered.id)?.node : undefined
  const selectedMatch = allNodes.get(selected)
  const selectedNode = selectedMatch?.node
  const activeStatement = selectedMatch?.statement ?? Math.max(0, content.statements.findIndex(entry => entry.id === statement?.id))
  const current = content.statements[activeStatement]
  const shown = useMemo(() => rankOperators(query.trim() || warningsOnly ? matches : matches.filter(match => match.statement === activeStatement), ranking), [matches, query, warningsOnly, activeStatement, ranking])
  const rowHeight = 32, first = Math.max(0, Math.floor(scroll / rowHeight) - 3), last = Math.min(shown.length, Math.ceil((scroll + height) / rowHeight) + 3)
  const choose = (id: string) => {
    if (!allNodes.has(id)) return
    setShowSql(false)
    const revealed = revealAncestors(id, parents, collapsed)
    if (revealed.size !== collapsed.size) { revealPending.current = true; setCollapsed(revealed) }
    const changed = latest.current.selected !== id
    latest.current.selected = id
    setSelected(id)
    if (changed) events.current.onSelectionChanged?.(id)
    canvas.current?.select(id, true)
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
  useEffect(() => {
    if (!navigation) return
    const statement = statementsRef.current.find(s => s.sourceStatementIndex === navigation.statement)
    const node = statement?.nodes[navigation.operator ?? 0]
    if (node && (navigation.nodeId === undefined || navigation.nodeId === node.nodeId)) selection.current(node.id)
  }, [navigation, fullTopology])
  const toggleBranch = (id: string) => {
    if (!branches.has(id)) return
    // A collapsed branch owns the selection, so properties never point into an invisible subtree.
    choose(id)
    revealPending.current = true
    setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !shown.length) return
    const selectedIndex = shown.findIndex(match => match.node.id === selected)
    const at = Math.max(0, selectedIndex)
    let next: string | undefined
    if (event.key === 'ArrowDown') next = shown[Math.min(selectedIndex + 1, shown.length - 1)].node.id
    else if (event.key === 'ArrowUp') next = shown[selectedIndex < 0 ? shown.length - 1 : Math.max(0, at - 1)].node.id
    else if (event.key === 'Home') next = shown[0].node.id
    else if (event.key === 'End') next = shown.at(-1)!.node.id
    else if (event.key === 'ArrowLeft') {
      const id = shown[at].node.id
      if (branches.has(id) && !collapsed.has(id)) { event.preventDefault(); toggleBranch(id); return }
      next = shown[at].node.parentId ?? undefined
    } else if (event.key === 'ArrowRight') {
      const id = shown[at].node.id
      if (collapsed.has(id)) { event.preventDefault(); toggleBranch(id); return }
      next = shown.find(match => match.node.parentId === id)?.node.id
    }
    if (next && shown.some(match => match.node.id === next)) { event.preventDefault(); choose(next) }
  }
  const selectStatement = (id: string) => {
    const index = content.statements.findIndex(entry => entry.id === id)
    if (index < 0) return
    setStatement({ id, sourceKey: content.statements[index].sourceKey })
    setXmlSource(undefined)
    setSelected('')
    if (selected) events.current.onSelectionChanged?.('')
    setScroll(0)
    if (tree.current) tree.current.scrollTop = 0
    canvas.current?.fit(index)
  }
  const preferredSource = xmlSource ?? current?.sourceKey ?? statement?.sourceKey ?? sources[0]?.key
  const selectedSource = sources.find(source => source.key === preferredSource)
  const xmlTarget: PlanXmlTarget | undefined = current?.sourceStatementIndex === undefined || !sources.some(source => source.key === current.sourceKey) ? undefined
    : { statement: current.sourceStatementIndex, revision: current.sourceRevision, ...selectedNode ? { operator: current.nodes.indexOf(selectedNode), nodeId: selectedNode.nodeId } : {} }
  const xmlTargetChanged = useRef(onXmlTargetChanged)
  xmlTargetChanged.current = onXmlTargetChanged
  useEffect(() => { xmlTargetChanged.current?.(xmlTarget) }, [xmlTarget?.statement, xmlTarget?.operator, xmlTarget?.nodeId, xmlTarget?.revision])
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
      <button type="button" aria-pressed={outline} onClick={() => void settings.toggle('queryResults.plan.outline')}>Outline</button>
      <button type="button" aria-pressed={inspector} onClick={() => void settings.toggle('queryResults.plan.properties')}>Properties</button>
      <button type="button" aria-pressed={minimap} onClick={() => void settings.toggle('queryResults.plan.minimap')}>Minimap</button>
      <button type="button" aria-pressed={flow} aria-description="Edge width uses logarithmic row counts. Actual is measured, Est. is estimated, Live partial is incomplete, and unavailable is unknown. Estimates without execution counts are per execution." onClick={() => void settings.toggle('queryResults.plan.rowFlow')}>Row flow</button>
      <button type="button" disabled={!selectedNode || !branches.has(selected)} onClick={() => toggleBranch(selected)}>{collapsed.has(selected) ? 'Expand inputs' : 'Collapse inputs'}</button>
      <button type="button" disabled={!collapsed.size} onClick={() => setCollapsed(new Set())}>Expand all</button>
      {openDocument && (sources.length > 1 || !selectedSource && sources.length > 0) && <label>XML source <select aria-label="Plan XML source" value={selectedSource?.key ?? ''} onChange={event => setXmlSource(event.target.value)}>
        {!selectedSource && <option value="" disabled>Selected plan is unavailable</option>}
        {sources.map(source => <option key={source.key} value={source.key}>{source.label}</option>)}
      </select></label>}
      {openDocument && <button type="button" onClick={() => { if (selectedSource) openDocument(selectedSource.key) }} disabled={!selectedSource}>Open plan document</button>}
      {(navigateXml || openDocument) && <button type="button" disabled={!xmlTarget} onClick={() => { if (xmlTarget) { if (navigateXml) navigateXml(xmlTarget); else openDocument?.(current.sourceKey, xmlTarget) } }}>Go to XML</button>}
      <button type="button" disabled={!current?.text.trim()} aria-pressed={showSql} onClick={() => setShowSql(value => !value)}>Statement SQL</button>
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
      <aside className="plan-outline" aria-label="Plan outline" hidden={!outline} style={{ flexBasis: outlineWidth }}>
        <input type="search" aria-label="Find plan operators" placeholder="Find operators or objects" maxLength={256} value={query} onChange={event => { setQuery(event.target.value); setScroll(0); if (tree.current) tree.current.scrollTop = 0 }} />
        <label className="plan-warning-filter"><input type="checkbox" checked={warningsOnly} onChange={event => { setWarningsOnly(event.target.checked); setScroll(0); if (tree.current) tree.current.scrollTop = 0 }} />Warnings only ({warnings})</label>
        <div className="plan-outline-actions"><span className="plan-outline-summary" role="status">{shown.length} {query.trim() || warningsOnly ? 'matching' : ''} operators{ranking !== 'plan' ? ' available' : ''}</span>
          <select className="plan-ranking" aria-label="Operator ranking" aria-description="Descending available values, including measured zero. CPU sums threads; elapsed is the maximum thread in milliseconds. Operator times may overlap. Row discrepancy compares total rows to all estimated executions. Live totals are partial." value={ranking} onChange={event => { setRanking(event.target.value as OperatorRanking); setScroll(0); if (tree.current) tree.current.scrollTop = 0 }}>
            <option value="plan">Plan order</option><option value="cpu">CPU · summed threads</option><option value="elapsed">Elapsed · max thread</option><option value="rows">Row-estimate discrepancy</option>
          </select></div>
        <div className="plan-operator-tree" ref={tree} role="tree" aria-label="Plan operators" aria-description="Lists all operators, including inputs collapsed in the graph. Selecting an operator reveals its ancestors. Left collapses graph inputs; Right expands them." tabIndex={0} onKeyDown={navigate} onScroll={event => setScroll(event.currentTarget.scrollTop)}
          aria-activedescendant={shown.slice(first, last).some(match => match.node.id === selected) ? labelId + selected : undefined}>
          <div style={{ height: shown.length * rowHeight, position: 'relative' }}>{shown.slice(first, last).map(({ node }, offset) => <div key={node.id} id={labelId + node.id}
            role="treeitem" aria-selected={selected === node.id} aria-expanded={branches.has(node.id) ? !collapsed.has(node.id) : undefined} aria-level={1} aria-setsize={shown.length} aria-posinset={first + offset + 1}
            className="plan-operator-item" style={{ top: (first + offset) * rowHeight, height: rowHeight }} onClick={() => { choose(node.id); tree.current?.focus() }} title={[node.physicalOp, node.object, ...node.warnings].filter(Boolean).join(' · ')}>
            <span><Icon name={operatorIcon(node.physicalOp, node.logicalOp)} />{node.physicalOp}{collapsed.has(node.id) ? ' · Inputs collapsed' : ''}{ranking !== 'plan' ? ` · ${ranking === 'rows' ? discrepancyLabel(node) : formatPlanMetric(rankingValue(node, ranking)) + ' ms'}` : ''}</span><small>{node.warnings.length ? 'Warning · ' : ''}{node.object || `Node ${node.nodeId}`} · {rowFlow(node, content.statements[allNodes.get(node.id)!.statement].partial).label}</small>
          </div>)}</div>
        </div>
      </aside>
      {outline && <PlanPaneSizer name="outline" value={outlineWidth} minimum={120} resize={setOutlineWidth} commit={value => void settings.choose('queryResults.plan.outlineWidth', value)} />}
      <div className="plan-canvas-shell">
        <div className="plan-canvas" ref={root} hidden={showSql} tabIndex={0} role="region" aria-label="Query plan canvas" aria-description="Drag or scroll to pan. Pinch or Control-scroll to zoom. Hover over an operator for statistics, or use the outline or arrow keys to select it." aria-describedby={hoveredNode ? labelId + 'stats' : undefined} onKeyDown={navigate} />
        {showSql && <section className="plan-sql-view" aria-label="Statement SQL from plan"><button type="button" onClick={() => { returnToGraph.current = true; setShowSql(false) }}>Back to graph</button><p>SQL text supplied by SQL Server for this statement.</p><pre tabIndex={0}>{current?.text || 'SQL text unavailable'}</pre></section>}
        {!showSql && minimap && content.layout && !gpuFailed && <button type="button" className="plan-minimap-control" aria-label="Plan minimap" aria-description="Click or drag to center the viewport. Arrow keys pan; Home fits the batch. The overview groups operators into a fixed grid."
          onKeyDown={event => {
            if (event.key === 'Home') canvas.current?.fit()
            else if (event.key.startsWith('Arrow')) canvas.current?.pan(event.key === 'ArrowLeft' ? 80 : event.key === 'ArrowRight' ? -80 : 0, event.key === 'ArrowUp' ? 80 : event.key === 'ArrowDown' ? -80 : 0)
            else return
            event.preventDefault(); event.stopPropagation()
          }} onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); const box = event.currentTarget.getBoundingClientRect(); canvas.current?.navigateMinimap(event.clientX - box.left, event.clientY - box.top) }}
          onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = event.currentTarget.getBoundingClientRect(); canvas.current?.navigateMinimap(event.clientX - box.left, event.clientY - box.top) }}
          onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} />}
        {hovered && hoveredNode && root.current && <PlanHoverCard node={hoveredNode} anchor={hovered.anchor} owner={root.current.ownerDocument} id={labelId + 'stats'}
          hold={() => canvas.current?.holdHover()} leave={() => canvas.current?.leaveHover()} />}
        {!showSql && (!content.layout || gpuFailed) && <div className="plan-canvas-state"><EmptyState icon="execution-plan" detail={gpuFailed ? 'GPU rendering is unavailable. Use the operator outline and properties, or open the XML source.' : content.error ?? (content.empty ? 'This plan contains no statements to display. Its XML source is available.' : sources.length ? 'Preparing execution plans…' : 'Plans appear here when the query returns them.')}
          actions={content.error || gpuFailed ? [{ label: 'Retry plan viewer', run: () => setRetry(value => value + 1) }] : undefined} /></div>}
      </div>
      {inspector && <PlanPaneSizer name="properties" value={propertiesWidth} minimum={140} reverse resize={setPropertiesWidth} commit={value => void settings.choose('queryResults.plan.propertiesWidth', value)} />}
      <aside className="plan-inspector" aria-label="Plan properties" hidden={!inspector} style={{ flexBasis: propertiesWidth }}>
        <PlanProperties statement={current} node={selectedNode} liveRunning={live?.running && mode === 'live'} />
      </aside>
    </div>
  </section>
}
