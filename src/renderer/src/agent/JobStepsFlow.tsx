// The job document's Steps › Flow view (docs/sql-server-agent.md › Steps › Flow; mocks rx-flow, rx-flow-menu, rx-flow-edit, rx-flow-end): the
// same draft as List, drawn as a graph by FlowCanvas (Pixi, loaded on first use as the plan viewer's canvas is). A visually hidden tree of
// the steps carries focus and the step menu over the canvas; beside it, the selected step's summary, the flow checks and the key, or the
// step's editor (the List's) docked. Every edit goes through JobDocumentService, so Undo, Save, Script and the dirty dot are List's.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flowActionWords, flowChecks, flowEdgeKey, flowLayout, flowMetrics, stepsFlow, type FlowCheck, type FlowEdge, type FlowWhich, type StepsFlow } from '../../../shared/agent/flow.ts'
import { agentLimits } from '../../../shared/agent/catalog.ts'
import { parseSsisCommand } from '../../../shared/agent/ssis-step.ts'
import { initialStepsDraft, stepText, stepTypeShort, type AgentStepDraft, type AgentStepsDraft } from '../../../shared/agent/steps.ts'
import type { AgentJobDocumentModel, AgentJobDraft } from '../../../shared/actions/agent-job.ts'
import type { SvgIconId } from '../../../shared/icons.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { useMenuTarget } from '../menus/useMenuTarget'
import Icon from '../Icon'
import type { Camera } from '../plans/geometry'
import type { FlowCanvas, FlowCanvasColors, FlowCanvasModel, FlowCanvasNode } from './FlowCanvas'
import type { JobDocumentService, JobDocumentState } from './JobDocumentService'
import { LastRunPanel, LiveRunPanel, RunPicker, useFlowRun } from './FlowRunPanel'

interface FlowProps {
  readonly state: JobDocumentState
  readonly model: AgentJobDocumentModel
  readonly draft: AgentJobDraft
  readonly editable: boolean
  readonly service: JobDocumentService
  /** The List | Flow switch, which leads the toolbar. */
  readonly switcher: ReactNode
  /** The List's step editor, docked when a step is opened. */
  readonly editor: (step: AgentStepDraft, position: number) => ReactNode
}

const stepIcon = (subsystem: string): SvgIconId => subsystem === 'TSQL' ? 'step-tsql' : subsystem === 'PowerShell' ? 'step-powershell' : subsystem === 'CmdExec' ? 'step-cmdexec'
  : subsystem === 'SSIS' ? 'ssis-package' : subsystem.startsWith('ANALYSIS') ? 'step-analysis' : 'step-other'
const firstLine = (text: string) => text.split(/\r?\n/).find(line => line.trim())?.trim() ?? ''
/** A node's key field and the summary's: the database, the package, the run-as proxy, the retries or the command's first line. */
export function flowStepFact(step: AgentStepDraft, model: Pick<AgentJobDocumentModel, 'proxies'>): { readonly label: string; readonly value: string } {
  if (step.subsystem === 'TSQL') return { label: 'Database', value: step.databaseName || 'master' }
  if (step.subsystem === 'SSIS') {
    const parsed = step.command.trim() ? parseSsisCommand(step.command) : undefined
    return { label: 'Package', value: parsed ? `${parsed.folder} › ${parsed.package}` : step.command.trim() ? 'Command text' : 'No package yet' }
  }
  if (step.subsystem.startsWith('ANALYSIS')) return { label: 'Server', value: `${step.subsystem === 'ANALYSISQUERY' ? 'Query' : 'Command'} · ${step.server || 'no server'}` }
  const proxy = step.proxyId ? model.proxies?.find(item => item.id === step.proxyId)?.name ?? `Proxy ${step.proxyId}` : undefined
  if (proxy) return { label: 'Run as', value: `Run as ${proxy}` }
  if (step.retryAttempts > 0) return { label: 'Retries', value: `Retry ${step.retryAttempts} ${step.retryAttempts === 1 ? 'time' : 'times'}, ${step.retryInterval} ${step.retryInterval === 1 ? 'minute' : 'minutes'} apart` }
  return { label: 'Command', value: firstLine(step.command) || 'No command yet' }
}
const retriesText = (step: AgentStepDraft) => step.retryAttempts > 0 ? `${step.retryAttempts} every ${step.retryInterval} min` : 'None'

/** Edges whose action differs from the job as read: drawn in the accent and tagged "changed" (a new step's are not, being all new). */
function changedEdges(draft: AgentStepsDraft, model: AgentJobDocumentModel): Set<string> {
  const original = new Map(initialStepsDraft(model.steps, model.job?.startStepId).steps.map(step => [step.key, step]))
  const changed = new Set<string>()
  draft.steps.forEach((step, at) => {
    const was = step.from === undefined ? undefined : original.get(step.key)
    if (!was) return
    if (was.onSuccess !== step.onSuccess || (step.onSuccess === 4 && was.onSuccessTarget !== step.onSuccessTarget)) changed.add(flowEdgeKey(at, 'success'))
    if (was.onFail !== step.onFail || (step.onFail === 4 && was.onFailTarget !== step.onFailTarget)) changed.add(flowEdgeKey(at, 'fail'))
  })
  return changed
}
/** The accessible name of a step's tree item, which says what the node draws. */
function stepLabel(flow: StepsFlow, step: AgentStepDraft, at: number, run?: readonly { readonly text: string }[]): string {
  const edge = (which: FlowWhich) => flow.edges[at * 2 + (which === 'success' ? 0 : 1)]!
  return `Step ${at + 1}, ${step.name || 'Unnamed step'}, ${stepTypeShort(step.subsystem)}${flow.start === at ? ', Start step' : ''}${flow.reachable[at] ? '' : ', never runs'}. `
    + `On success, ${flowActionWords(edge('success'))}. On failure, ${flowActionWords(edge('fail'))}.`
    // An overlay's words for the step, as the node draws them: "This run: ×2, ✓ 00:00:03, ✗ 00:00:02".
    + (run?.length ? ` This run: ${run.map(part => part.text).join(', ')}.` : '')
}
/** "Go to the next step · 5 Merge facts", in the summary. */
function actionLine(edge: FlowEdge, steps: readonly AgentStepDraft[]): string {
  const target = edge.target
  if (target.kind === 'quit') return `Quit reporting ${target.success ? 'success' : 'failure'}`
  if (target.kind === 'end') return 'Go to the next step · none, so the job fails'
  if (target.kind === 'missing') return 'Go to a step that no longer exists'
  const name = steps[target.index]?.name || 'Unnamed step'
  return edge.action === 3 ? `Go to the next step · ${target.index + 1} ${name}` : `Go to step ${target.index + 1} · ${name}`
}
function reachedFrom(flow: StepsFlow, at: number): string {
  const from = flow.edges.filter(edge => edge.target.kind === 'step' && edge.target.index === at).map(edge => `Step ${edge.from + 1} on ${edge.which === 'success' ? 'success' : 'failure'}`)
  return [...flow.start === at ? ['The job\'s start'] : [], ...from].join(', ') || 'No step'
}

const forcedQuery = '(forced-colors: active)'
/** Forced colours replace the canvas's colours, so Flow then offers List instead (as the plan viewer offers its outline). */
export function useForcedColors(): boolean {
  const [forced, setForced] = useState(() => typeof matchMedia === 'function' && matchMedia(forcedQuery).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia(forcedQuery), changed = () => setForced(query.matches)
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [])
  return forced
}

function Check({ check, editable, service, id }: { readonly check: FlowCheck; readonly editable: boolean; readonly service: JobDocumentService; readonly id: string }) {
  return <div className="agent-flow-check" role="listitem">
    <Icon name={check.kind === 'loop' || check.kind === 'closedLoop' ? 'sync' : 'warning'} />
    <span className="agent-flow-check-title">{check.title}</span>
    {check.fix && <button type="button" disabled={!editable} onClick={() => service.applyFlowFix(id, check.key, check.fix!)}>{check.fixLabel}</button>}
    <span className="agent-flow-check-detail">{check.detail}</span>
  </div>
}

export default function JobStepsFlow({ state, model, draft, editable, service, switcher, editor }: FlowProps) {
  const { theme, commands } = useWorkbench()
  const colors = useServiceSnapshot(theme).active.colors
  const steps = draft.steps.steps
  const selectedStep = service.selectedStep(state.id)
  const selected = selectedStep ? steps.indexOf(selectedStep) : -1
  const [adding, setAdding] = useState('TSQL')
  const [zoom, setZoom] = useState(1)
  const [focused, setFocused] = useState(false)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<FlowCanvas | undefined>(undefined)
  const items = useRef(new Map<string, HTMLDivElement>())
  const dropMarker = useRef<HTMLSpanElement>(null)

  const flow = useMemo(() => stepsFlow(draft.steps), [draft.steps])
  const layout = useMemo(() => flowLayout(flow, flowMetrics), [flow])
  // A job with more steps than Varia reads has go-tos past them that are not problems Varia can fix, so it checks nothing (as List).
  const truncated = !!model.stepsTruncated
  const checks = useMemo(() => truncated ? [] : flowChecks(draft.steps, flow), [draft.steps, flow, truncated])
  // Show: Targets only, or a run drawn over the graph (Last run, or Live run while the job runs).
  const run = useFlowRun(state, model, draft.steps, flow, service)
  const running = !!state.live?.running
  const shown = run?.overlay ?? 'targets'
  const canvasModel: FlowCanvasModel = useMemo(() => {
    const accent = changedEdges(draft.steps, model)
    const nodes = steps.map((step, at): FlowCanvasNode => ({
      name: step.name || 'Unnamed step', type: stepTypeShort(step.subsystem), icon: stepIcon(step.subsystem), sub: flowStepFact(step, model).value,
      never: !flow.reachable[at], changed: accent.has(flowEdgeKey(at, 'success')) || accent.has(flowEdgeKey(at, 'fail'))
    }))
    const chips = [
      ...flow.loops.map(loop => ({ edge: flowEdgeKey(loop.back.from, loop.back.which), text: `Loop · ${loop.steps.map(step => step + 1).join(loop.steps.length === 2 ? ' \u21C4 ' : ', ')}` })),
      ...[...accent].map(edge => ({ edge, text: 'changed', tone: 'accent' as const }))
    ]
    if (!run) return { flow, layout, nodes, accent, hot: new Set(), fadeRest: false, chips, sequence: new Map() }
    // A run over the graph: its path bold and numbered, the rest faded; the draft's own marks (changed, loops) stay.
    const { drawing } = run
    const drawn = nodes.map((node, at) => ({ ...node, ...drawing.steps[at] }))
    return { flow, layout, nodes: drawn, accent, hot: drawing.hot, lit: drawing.lit, fadeRest: true, chips, sequence: drawing.sequence }
  }, [flow, layout, steps, draft.steps, model, run])
  const palette: FlowCanvasColors = useMemo(() => ({
    background: colors['panel.background'], card: colors['input.background'], text: colors.foreground, muted: colors.descriptionForeground, border: colors['panel.border'],
    accent: colors.focusBorder, selection: colors['list.inactiveSelectionBackground'], success: colors.successForeground, error: colors.errorForeground, warning: colors.warningForeground,
    dots: colors['charts.canvasDots']
  }), [colors])

  // The canvas is created once per mount (and on Retry) and told what changed; it reads the latest model and handlers through refs.
  const latest = useRef({ canvasModel, palette, selected, focused, editable, steps, state })
  latest.current = { canvasModel, palette, selected, focused, editable, steps, state }
  // The hidden tree's items sit over their nodes, so a keyboard menu opens below the step and assistive technology finds it there.
  const place = (camera: Camera) => {
    const nodes = latest.current.canvasModel.layout.nodes
    latest.current.steps.forEach((step, at) => {
      const item = items.current.get(step.key), node = nodes[at]
      if (!item || !node) return
      Object.assign(item.style, { left: `${camera.x + node.x * camera.scale}px`, top: `${camera.y + node.y * camera.scale}px`, width: `${node.width * camera.scale}px`, height: `${node.height * camera.scale}px` })
    })
  }
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 })
  useEffect(() => {
    const element = root.current
    if (!element) return
    let disposed = false
    setFailed(false)
    void import('./FlowCanvas').then(({ FlowCanvas }) => {
      if (disposed) return
      const now = latest.current
      canvas.current = new FlowCanvas({
        root: element, model: now.canvasModel, colors: now.palette, selected: now.selected, focused: now.focused, editable: now.editable,
        select: index => { const step = latest.current.steps[index]; if (step) service.selectStep(latest.current.state.id, step.key) },
        open: index => { const step = latest.current.steps[index]; if (step) service.openStepEditor(latest.current.state.id, step.key) },
        connect: (from, which, to) => {
          const step = latest.current.steps[from], target = latest.current.steps[to]
          if (step && target) service.setStepAction(latest.current.state.id, step.key, which, 4, target.key)
        },
        dropped: (from, which, clientX, clientY) => {
          const step = latest.current.steps[from], marker = dropMarker.current, box = element.getBoundingClientRect()
          if (!step || !marker) return
          service.selectStep(latest.current.state.id, step.key)
          Object.assign(marker.style, { left: `${clientX - box.left}px`, top: `${clientY - box.top}px` })
          void commands.execute(which === 'success' ? 'agentJob.pickStepOnSuccess' : 'agentJob.pickStepOnFailure', { tabId: latest.current.state.id, target: { kind: 'agentStep', tabId: latest.current.state.id, key: step.key }, anchor: marker }, 'toolbar')
        },
        cameraChanged: camera => { cameraRef.current = camera; place(camera); setZoom(current => current === camera.scale ? current : camera.scale) },
        failed: () => { if (!disposed) setFailed(true) }
      })
    }).catch(() => { if (!disposed) setFailed(true) })
    return () => { disposed = true; canvas.current?.dispose(); canvas.current = undefined }
  // The handlers read `latest`; the canvas lives as long as the view, and Retry makes a new one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry, service])
  useEffect(() => { canvas.current?.update(canvasModel, selected, focused, editable) }, [canvasModel, selected, focused, editable])
  useEffect(() => { canvas.current?.colors(palette) }, [palette])
  useEffect(() => { if (selected >= 0) canvas.current?.reveal(selected) }, [selected])
  useLayoutEffect(() => place(cameraRef.current))
  // The docked editor narrows the graph, as closing it widens it: the graph is placed again for its new width (Fit when it no longer fits).
  const editingNow = !!state.stepEditor
  const firstPlace = useRef(true)
  useEffect(() => { if (firstPlace.current) { firstPlace.current = false; return } canvas.current?.recenter() }, [editingNow])

  const menuTarget = useMenuTarget<HTMLElement>(element => {
    const key = element.getAttribute('data-step-key') ?? service.selectedStep(state.id)?.key
    return key ? { kind: 'agentStep', tabId: state.id, key } : null
  }, () => root.current ?? undefined)
  const treeRef = (element: HTMLDivElement | null) => { root.current = element; menuTarget(element) }

  const missing = truncated ? [] : flow.edges.filter(edge => edge.target.kind === 'missing')
  const problemCount = checks.length + missing.length
  const editing = !!state.stepEditor && !!selectedStep
  const fact = selectedStep ? flowStepFact(selectedStep, model) : undefined
  const loopOf = (edge: FlowEdge) => edge.loop
  const edgeOf = (which: FlowWhich) => flow.edges[selected * 2 + (which === 'success' ? 0 : 1)]
  const canStartHere = selectedStep ? service.canStartAtStep(state.id, selectedStep.key) : false
  return <div className="agent-flow" data-agent-steps="">
    <div className="agent-flow-toolbar" role="toolbar" aria-label="Steps flow">
      {switcher}
      <span className="agent-flow-sep" />
      <span className="agent-flow-label" id={`agent-flow-${state.id}-show`}>Show</span>
      <span className="segmented agent-flow-show" role="radiogroup" aria-labelledby={`agent-flow-${state.id}-show`} onKeyDown={event => {
        const order: readonly ('targets' | 'last' | 'live')[] = running ? ['targets', 'last', 'live'] : ['targets', 'last']
        const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
        if (!(event.key in keys) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        event.preventDefault()
        const next = order[(order.indexOf(shown) + keys[event.key]! + order.length) % order.length]!
        service.setFlowOverlay(state.id, next)
        event.currentTarget.querySelector<HTMLElement>(`[data-show="${next}"]`)?.focus()
      }}>
        {([['targets', 'Targets only'], ['last', 'Last run'], ['live', 'Live run']] as const).map(([value, label]) => <button key={value} type="button" role="radio" className="segmented-option" data-show={value}
          aria-checked={shown === value} tabIndex={shown === value ? 0 : -1} disabled={value === 'live' && !running} title={value === 'live' && !running ? 'Live run shows while the job runs; it turns on by itself when the job starts.' : undefined}
          onClick={() => service.setFlowOverlay(state.id, value)}>{value === 'live' && running && <Icon name="play" />}{label}</button>)}
      </span>
      {shown === 'last' && <RunPicker state={state} service={service} />}
      <span className="agent-flow-sep" />
      <button type="button" disabled={!editable || steps.length >= agentLimits.stepsPerJob} title={steps.length >= agentLimits.stepsPerJob ? stepText.tooMany : undefined}
        onClick={() => service.addStepOf(state.id, adding)}><Icon name="add" />Add step</button>
      <select className="property-input agent-flow-type" aria-label="Type of the step to add" value={adding} disabled={!editable} onChange={event => setAdding(event.target.value)}>
        {service.stepTypes(state.id).map(type => <option key={type} value={type}>{stepTypeShort(type)}</option>)}
      </select>
      <span className="agent-flow-spacer" />
      <button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out" disabled={failed} onClick={() => canvas.current?.zoom(1 / 1.2)}><Icon name="zoom-out" /></button>
      <span className="agent-flow-zoom" aria-live="polite">{`${Math.round(zoom * 100)}%`}</span>
      <button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in" disabled={failed} onClick={() => canvas.current?.zoom(1.2)}><Icon name="zoom-in" /></button>
      <button type="button" disabled={failed} onClick={() => canvas.current?.fit()}><Icon name="screen-full" />Fit</button>
    </div>
    <div className="agent-flow-body" data-wide={editing || undefined}>
      <div className="agent-flow-canvas">
        {failed ? <div className="agent-flow-failed" role="status">
          <p className="field-note"><Icon name="info" />GPU drawing is unavailable, so the Flow view cannot draw. List shows the same steps and targets.</p>
          <span className="agent-step-inline"><button type="button" onClick={() => service.setStepsView(state.id, 'list')}>Show List</button><button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></span>
        </div> : null}
        <div ref={treeRef} className="agent-flow-tree" role="tree" aria-label="Steps flow, in step order" tabIndex={steps.length ? 0 : -1} hidden={failed}
          aria-activedescendant={selectedStep ? `agent-flow-${state.id}-${selectedStep.key}` : undefined} data-agent-flow=""
          onFocus={event => { if (event.target === event.currentTarget) setFocused(true) }} onBlur={() => setFocused(false)}
          onKeyDown={event => {
            if (event.key === 'Escape' && canvas.current?.cancelConnect()) { event.preventDefault(); return }
            const keys: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }
            if (!(event.key in keys) || event.altKey || event.ctrlKey || event.metaKey) return
            event.preventDefault()
            const delta = keys[event.key]!, at = Math.max(0, Math.min(steps.length - 1, Number.isFinite(delta) ? selected + delta : delta < 0 ? 0 : steps.length - 1))
            const next = steps[at]
            if (next) service.selectStep(state.id, next.key)
          }}>
          {steps.map((step, at) => <div key={step.key} id={`agent-flow-${state.id}-${step.key}`} role="treeitem" aria-selected={at === selected} aria-label={stepLabel(flow, step, at, run?.drawing.steps[at]?.right)}
            className="agent-flow-item" data-step-key={step.key} ref={element => { if (element) { items.current.set(step.key, element); menuTarget(element) } else items.current.delete(step.key) }} />)}
          <span ref={dropMarker} className="agent-flow-drop" aria-hidden="true" />
        </div>
      </div>
      <div className="agent-flow-side">
        {run && !editing ? run.overlay === 'last' ? <LastRunPanel state={state} run={run} service={service} /> : <LiveRunPanel state={state} run={run} flow={flow} service={service} /> : editing ? <>
          <div className="agent-flow-head"><span>{`Step ${selected + 1} of ${steps.length}`}</span>
            <button type="button" onClick={() => service.closeStepEditor(state.id)}><Icon name="close" />Close editor</button></div>
          {editor(selectedStep!, selected)}
        </> : <>
          {selectedStep && fact && <section className="agent-flow-sec" aria-labelledby={`agent-flow-${state.id}-selected`}>
            <h4 id={`agent-flow-${state.id}-selected`}>Selected step<span className="agent-flow-sec-right"><Icon name={stepIcon(selectedStep.subsystem)} />{stepTypeShort(selectedStep.subsystem)}</span></h4>
            <p className="agent-flow-name"><span className="agent-flow-no">{selected + 1}</span>{selectedStep.name || 'Unnamed step'}</p>
            <dl className="agent-flow-facts">
              <div className="agent-flow-fact"><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
              {fact.label !== 'Retries' && <div className="agent-flow-fact"><dt>Retries</dt><dd>{retriesText(selectedStep)}</dd></div>}
              {(['success', 'fail'] as const).map(which => {
                const edge = edgeOf(which)!
                return <div key={which} className="agent-flow-fact">
                  <dt>{which === 'success' ? 'On success' : 'On failure'}</dt>
                  <dd><span className={which === 'success' ? 'agent-step-ok' : 'agent-step-bad'}><Icon name={which === 'success' ? 'check' : 'close'} /></span> {actionLine(edge, steps)}
                    {loopOf(edge) && <span className="agent-step-tag" data-tone="warning">Loop</span>}</dd>
                </div>
              })}
              <div className="agent-flow-fact"><dt>Reached from</dt><dd>{reachedFrom(flow, selected)}</dd></div>
            </dl>
            <span className="agent-step-inline">
              <button type="button" onClick={() => service.openStepEditor(state.id, selectedStep.key)}><Icon name="edit" />Edit step</button>
              <button type="button" disabled={!canStartHere} title={canStartHere ? undefined : 'Save the step first; the job must not be running.'} onClick={() => void service.startAtStep(state.id, selectedStep.key)}><Icon name="play" />{`Start at step ${selected + 1}`}</button>
            </span>
            <p className="field-note">Double-click a step, or press Enter, to edit it here. Right-click it, or press Shift+F10, for its actions. Drag a step’s success or failure port onto a step to go to it.</p>
          </section>}
          <section className="agent-flow-sec" aria-labelledby={`agent-flow-${state.id}-checks`}>
            <h4 id={`agent-flow-${state.id}-checks`}>Flow checks<span className="agent-flow-sec-right">{truncated ? 'Not checked' : problemCount === 0 ? 'No problems' : `${problemCount} ${problemCount === 1 ? 'problem' : 'problems'}`}</span></h4>
            {truncated ? <p className="field-note" role="note">{stepText.stepsTruncated}</p> : <div role="list" aria-labelledby={`agent-flow-${state.id}-checks`}>
              {checks.map(check => <Check key={`${check.kind}:${check.key}:${check.field}`} check={check} editable={editable} service={service} id={state.id} />)}
              {missing.map(edge => <div key={`${edge.from}:${edge.which}`} className="agent-flow-check" role="listitem">
                <Icon name="error" /><span className="agent-flow-check-title">{`Step ${edge.from + 1} goes to a step that no longer exists`}</span>
                <span className="agent-flow-check-detail">{`Its On ${edge.which === 'success' ? 'success' : 'failure'} action needs another step, or a Quit.`}</span>
              </div>)}
              {missing.length === 0 && <div className="agent-flow-check" role="listitem" data-tone="ok">
                <Icon name="pass" /><span className="agent-flow-check-title">Every go-to target exists</span>
                <span className="agent-flow-check-detail">No step goes to a step that no longer exists.</span>
              </div>}
            </div>}
          </section>
          <section className="agent-flow-sec" aria-labelledby={`agent-flow-${state.id}-key`}>
            <h4 id={`agent-flow-${state.id}-key`}>Key</h4>
            <ul className="agent-flow-legend">
              <li><span className="agent-flow-line" data-which="success" /><Icon name="check" />On success</li>
              <li><span className="agent-flow-line" data-which="fail" /><Icon name="close" />On failure</li>
              <li><span className="agent-flow-pill" data-tone="ok">Quit · success</span></li>
              <li><span className="agent-flow-pill" data-tone="bad">Quit · failure</span></li>
              <li><span className="agent-flow-pill" data-tone="accent"><Icon name="play" />Start</span>Start step</li>
              <li><span className="agent-step-tag" data-tone="warning">Never runs</span>nothing reaches it</li>
              <li><span className="agent-flow-pill" data-tone="warning"><Icon name="warning" />End · job fails</span>last step goes to the next step</li>
              <li className="agent-flow-legend-note">Steps stay in step order, top to bottom, as in List and History. Jumps run beside the column: success on the left, failure on the right. A go-to to the step just below is straight, marked with its number.</li>
            </ul>
          </section>
        </>}
      </div>
    </div>
  </div>
}
