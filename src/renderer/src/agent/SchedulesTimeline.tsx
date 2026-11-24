// The Schedules document's Timeline (AG-14, docs/agent-ui-rethink.md › rx-timeline): Next 24 hours or Next 7 days, a row per job (per
// schedule below sysadmin) with its runs drawn for its usual duration by TimelineView, overlaps flagged and explained under it. Zoom and
// scroll move a viewport through the window (buttons, a scroll slider, Ctrl+wheel and the wheel); the keyboard walks runs (Left and Right,
// Home and End), rows (Up and Down) and opens the job (Enter) or the schedule (Shift+Enter). React renders the rows only.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { momentOfText, type AgentSchedulesModel } from '../../../shared/actions/agent-schedule'
import { momentSeconds } from '../../../shared/agent/schedule'
import { timelineClock, timelineInputs, timelineModel, timelineSpans, timelineText, type TimelineModel, type TimelineRow, type TimelineSpan } from '../../../shared/agent/timeline'
import Icon from '../Icon'
import Segmented from '../kit/Segmented'
import { TimelineView, type TimelineActive, type TimelineViewport } from './TimelineView'

interface Props {
  readonly documentId: string
  readonly model: AgentSchedulesModel
  readonly span: TimelineSpan
  readonly onSpan: (span: TimelineSpan) => void
  readonly onOpenJob: (name: string) => void
  readonly onOpenSchedule: (scheduleId: number) => void
}

/** The narrowest viewport zoom reaches: an hour of the window across the lanes. */
export const minViewportSeconds = 3_600
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))
/** A viewport kept inside the window, at least an hour wide. */
export function fitViewport(viewport: TimelineViewport, seconds: number): TimelineViewport {
  const width = clamp(viewport.seconds, Math.min(minViewportSeconds, seconds), seconds)
  return { start: clamp(viewport.start, 0, seconds - width), seconds: width }
}
/** Zooms by `factor` (below 1 zooms in) around `at` (seconds into the window). */
export function zoomViewport(viewport: TimelineViewport, seconds: number, factor: number, at = viewport.start + viewport.seconds / 2): TimelineViewport {
  const width = clamp(viewport.seconds * factor, Math.min(minViewportSeconds, seconds), seconds)
  const ratio = viewport.seconds > 0 ? (at - viewport.start) / viewport.seconds : 0.5
  return fitViewport({ start: at - ratio * width, seconds: width }, seconds)
}
/** The viewport moved just enough to show a run. */
function revealRun(viewport: TimelineViewport, seconds: number, start: number, length: number): TimelineViewport {
  if (start >= viewport.start && start + Math.min(length, viewport.seconds) <= viewport.start + viewport.seconds) return viewport
  return fitViewport({ start: start - viewport.seconds * 0.1, seconds: viewport.seconds }, seconds)
}
/** The run on another row nearest in time to `start`. */
function nearestRun(row: TimelineRow, start: number): number {
  let best = 0
  for (let index = 1; index < row.runs.length; index++) if (Math.abs(row.runs[index].start - start) < Math.abs(row.runs[best].start - start)) best = index
  return best
}
/** The row's first run the viewport shows (focus lands there without moving the view, so a click hits what it was aimed at), or -1. */
function firstShown(row: TimelineRow, viewport: TimelineViewport): number {
  const index = row.runs.findIndex(run => run.start + run.seconds > viewport.start)
  return index >= 0 && row.runs[index].start < viewport.start + viewport.seconds ? index : -1
}
/** A row's summary for its lane cell's accessible name. */
function rowSummary(model: TimelineModel, row: TimelineRow): string {
  const count = row.runs.length, overlaps = row.runs.filter(run => run.overlap).length
  const runs = count ? `${count}${row.truncated ? '+' : ''} ${count === 1 ? 'run' : 'runs'}, first ${timelineClock(model, row.runs[0].start)}` : 'no run in this window'
  return [row.name, row.label, runs, overlaps ? `${overlaps} overlapping` : ''].filter(Boolean).join(', ')
}

export default function SchedulesTimeline({ documentId, model: read, span, onSpan, onOpenJob, onOpenSchedule }: Props) {
  const seconds = timelineSpans.find(item => item.id === span)?.seconds ?? 86_400
  const model = useMemo(() => {
    const now = momentOfText(read.now)
    return now ? timelineModel({ now, seconds, ...timelineInputs(read) }) : undefined
  }, [read, seconds])
  const [viewport, setViewport] = useState<TimelineViewport>({ start: 0, seconds })
  // The active run by its row's key, its moment on the server's clock and its schedule (two schedules may start a job together), so a
  // Refresh (rows re-sorted, the window's start moved on) or the filter keeps it on the same run, or drops it when that run is gone.
  const [picked, setPicked] = useState<{ readonly key: string; readonly at?: number; readonly scheduleId?: number }>()
  const axis = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const lanes = useRef<(HTMLDivElement | null)[]>([])
  const view = useRef<TimelineView>(undefined)
  const rows = useMemo(() => model?.rows ?? [], [model])
  const active = useMemo<TimelineActive | undefined>(() => {
    const row = picked ? rows.findIndex(item => item.key === picked.key) : -1
    if (row < 0) return undefined
    const origin = model ? momentSeconds(model.start) : 0
    const run = picked?.at === undefined ? -1 : rows[row].runs.findIndex(item => origin + item.start === picked.at && item.scheduleId === picked.scheduleId)
    return { row, run }
  }, [picked, rows, model])
  const setActive = (row: number, run: number) => {
    const target = rows[row], item = target?.runs[run]
    if (target) setPicked({ key: target.key, ...item && model ? { at: momentSeconds(model.start) + item.start, scheduleId: item.scheduleId } : {} })
  }
  const activator = useRef(setActive)
  activator.current = setActive
  const open = (row: number, run: number, schedule: boolean) => {
    const target = model?.rows[row], item = target?.runs[run]
    if (!target || !item) return
    if (schedule || target.kind === 'schedule' || !target.jobId) onOpenSchedule(item.scheduleId)
    else onOpenJob(target.name)
  }
  const opener = useRef(open)
  opener.current = open

  // The whole window shows again when the span changes.
  useEffect(() => { setViewport({ start: 0, seconds }); setPicked(undefined) }, [seconds])
  const drawn = !!model
  useEffect(() => {
    if (!axis.current || !body.current) return
    const created = new TimelineView({ axis: axis.current, root: body.current, open: (row, run, schedule) => { activator.current(row, run); opener.current(row, run, schedule) } })
    view.current = created
    // A view made after the first draw (the model arriving later) starts from what is shown now, not its defaults.
    created.setViewport(viewport)
    created.setActive(active)
    return () => { created.dispose(); view.current = undefined }
  }, [drawn])
  useEffect(() => {
    view.current?.setModel(model)
    view.current?.setLanes(lanes.current.slice(0, rows.length).filter((lane): lane is HTMLDivElement => !!lane))
  }, [model, rows.length])
  useEffect(() => { view.current?.setViewport(viewport) }, [viewport])
  useEffect(() => { view.current?.setActive(active) }, [active])
  // A focused lane whose row a Refresh took away leaves focus nowhere: it moves to the lane now in that place, so the keyboard stays in.
  const focused = useRef<{ key: string; index: number }>(undefined)
  useEffect(() => {
    const was = focused.current, document = body.current?.ownerDocument
    if (!was || !document) return
    // Still there (perhaps re-sorted): remember where it is now, for when a later Refresh takes it away.
    const now = rows.findIndex(row => row.key === was.key)
    if (now >= 0) { focused.current = { key: was.key, index: now }; return }
    if (document.activeElement && document.activeElement !== document.body) { focused.current = undefined; return }
    const index = Math.min(was.index, rows.length - 1)
    if (index >= 0) lanes.current[index]?.focus()
    else focused.current = undefined
  }, [rows])
  // Ctrl/⌘+wheel zooms at the pointer and Shift or sideways wheel scrolls, as on the plan canvas. A native listener, not
  // React's passive onWheel, so preventDefault keeps Chromium from zooming the whole window as well.
  const wheelState = useRef({ viewport, seconds })
  wheelState.current = { viewport, seconds }
  useEffect(() => {
    const element = body.current
    if (!element) return
    const onWheel = (event: globalThis.WheelEvent) => {
      const { viewport: shown, seconds: span } = wheelState.current
      const lane = lanes.current.find(item => item?.contains(event.target as Node)) ?? axis.current
      const box = lane?.getBoundingClientRect()
      if (!box || box.width <= 0) return
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        const at = shown.start + (event.clientX - box.left) / box.width * shown.seconds
        setViewport(current => zoomViewport(current, span, event.deltaY < 0 ? 0.8 : 1.25, at))
      } else if ((event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) && shown.seconds < span) {
        event.preventDefault()
        const delta = (event.deltaX || event.deltaY) / box.width * shown.seconds
        setViewport(current => fitViewport({ start: current.start + delta, seconds: current.seconds }, span))
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [drawn])

  if (!model) return <p className="field-note">{timelineText.none}</p>
  const zoom = (factor: number) => setViewport(current => zoomViewport(current, seconds, factor))
  const moveTo = (row: number, run: number) => {
    const target = rows[row]?.runs[run]
    if (!target) return
    setActive(row, run)
    setViewport(current => revealRun(current, seconds, target.start, target.seconds))
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>, row: number) => {
    // Chords belong to the workbench (Ctrl+= zooms the window); only plain keys and Shift+Enter walk the Timeline.
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const runs = rows[row].runs, current = active?.row === row ? active.run : -1
    const go = (next: number | undefined) => { event.preventDefault(); if (next !== undefined) moveTo(row, next) }
    switch (event.key) {
      case 'ArrowRight': return go(runs.length ? Math.min(runs.length - 1, current + 1) : undefined)
      case 'ArrowLeft': return go(runs.length ? Math.max(0, current < 0 ? 0 : current - 1) : undefined)
      case 'Home': return go(runs.length ? 0 : undefined)
      case 'End': return go(runs.length ? runs.length - 1 : undefined)
      case 'ArrowDown': case 'ArrowUp': {
        event.preventDefault()
        const next = row + (event.key === 'ArrowDown' ? 1 : -1)
        if (next < 0 || next >= rows.length) return
        lanes.current[next]?.focus()
        const at = current >= 0 ? runs[current].start : viewport.start
        if (rows[next].runs.length) moveTo(next, nearestRun(rows[next], at))
        else setActive(next, -1)
        return
      }
      case 'Enter': {
        event.preventDefault()
        if (current >= 0) open(row, current, event.shiftKey)
        return
      }
      case '+': case '=': event.preventDefault(); zoom(0.5); return
      case '-': event.preventDefault(); zoom(2); return
    }
  }
  const activeRow = active ? rows[active.row] : undefined, activeRun = active && activeRow ? activeRow.runs[active.run] : undefined
  const announced = activeRow && activeRun ? timelineText.run(model, activeRow, activeRun) : ''
  const spanId = `agent-timeline-span-${documentId}`
  const zoomed = viewport.seconds < seconds
  return <div className="agent-timeline-wrap" data-agent-timeline={documentId}>
    <div className="agent-timeline-tools" role="toolbar" aria-label="Timeline">
      <span id={spanId} className="visually-hidden">Window</span>
      <Segmented id={`${spanId}-seg`} labelledBy={spanId} value={span} onChange={value => onSpan(value as TimelineSpan)} segments={timelineSpans.map(item => ({ value: item.id, label: item.label }))} />
      {/* aria-disabled, not disabled: a button that disables itself under the keyboard would drop focus to the page (each is a no-op then). */}
      <button type="button" className="agent-timeline-zoom" aria-label="Zoom in" title="Zoom in (+)" aria-disabled={viewport.seconds <= Math.min(minViewportSeconds, seconds)} onClick={() => zoom(0.5)}><Icon name="zoom-in" /></button>
      <button type="button" className="agent-timeline-zoom" aria-label="Zoom out" title="Zoom out (-)" aria-disabled={!zoomed} onClick={() => zoom(2)}><Icon name="zoom-out" /></button>
      <button type="button" className="agent-timeline-zoom" aria-disabled={!zoomed} onClick={() => setViewport({ start: 0, seconds })}>Show all</button>
      <input type="range" className="agent-timeline-scroll" aria-label="Scroll the timeline" min={0} max={Math.max(0, seconds - viewport.seconds)} step={60} value={Math.round(viewport.start)} aria-disabled={!zoomed}
        aria-valuetext={`${timelineClock(model, viewport.start)} to ${timelineClock(model, viewport.start + viewport.seconds)}`}
        onChange={event => setViewport(current => fitViewport({ start: Number(event.target.value), seconds: current.seconds }, seconds))} />
      <span className="field-note agent-timeline-hint">{timelineText.bars(model.kind)}</span>
    </div>
    <div className="agent-timeline" role="grid" aria-label="Schedules timeline" aria-rowcount={rows.length + 1} aria-colcount={2} ref={body}>
      <div className="agent-timeline-row agent-timeline-head" role="row">
        <div className="agent-timeline-name" role="columnheader">{model.kind === 'job' ? 'Job' : 'Schedule'}</div>
        <div className="agent-timeline-lane agent-timeline-axis" role="columnheader" ref={axis} aria-label={`Server time, ${timelineClock(model, viewport.start)} to ${timelineClock(model, viewport.start + viewport.seconds)}`} />
      </div>
      {rows.map((row, index) => <div key={row.key} className="agent-timeline-row" role="row" data-disabled={row.enabled ? undefined : true}>
        <div className="agent-timeline-name" role="rowheader" title={`${row.name} · ${row.label}`}>
          <Icon name={row.kind === 'job' ? 'agent-job' : 'agent-schedule'} /><span className="agent-timeline-title">{row.name}</span><span className="agent-timeline-label">{row.label}</span>
        </div>
        <div className="agent-timeline-lane" role="gridcell" ref={element => { lanes.current[index] = element }} tabIndex={(active?.row ?? 0) === index ? 0 : -1}
          aria-label={rowSummary(model, row)} aria-describedby={`${spanId}-run`} onKeyDown={event => onKey(event, index)}
          onFocus={() => { focused.current = { key: row.key, index }; if (active?.row !== index) setActive(index, firstShown(row, viewport)) }}
          onBlur={event => { if (!lanes.current.includes(event.relatedTarget as HTMLDivElement)) focused.current = undefined }} />
      </div>)}
    </div>
    <p id={`${spanId}-run`} className="visually-hidden" aria-live="polite">{announced}</p>
    {!rows.length && <p className="field-note">{timelineText.none}</p>}
    {(model.overlaps.length > 0 || model.selfOverlaps.length > 0) && <div className="agent-timeline-notes" role="region" aria-label="Overlaps">
      {model.overlaps.map(overlap => <p key={`${overlap.row}:${overlap.start}:${overlap.scheduleId}`} className="agent-timeline-note"><Icon name="warning" />
        <span>{timelineText.overlap(model, overlap)}</span>
        <button type="button" className="agent-schedules-link" onClick={() => onOpenSchedule(overlap.scheduleId)}>
          Open {rows.find(row => row.key === overlap.row)?.schedules.find(item => item.id === overlap.scheduleId)?.name ?? 'schedule'}</button></p>)}
      {model.moreOverlaps > 0 && <p className="field-note">{timelineText.moreOverlaps(model.moreOverlaps)}</p>}
      {model.overlapsCut && <p className="field-note">{timelineText.overlapsCut}</p>}
      {model.selfOverlaps.map(self => <p key={self.row} className="agent-timeline-note"><Icon name="warning" /><span>{timelineText.self(self)}</span></p>)}
    </div>}
    {model.rowsLeftOut > 0 && <p className="field-note">{timelineText.rowsLeftOut(model.rowsLeftOut)}</p>}
    {model.runsCut && <p className="field-note">{timelineText.runsCut}</p>}
    <p className="field-note">{`The line at the left edge is now (${timelineClock({ start: model.start, seconds: 86_400 }, 0)} server time). Disabled jobs and schedules are dashed. ${model.kind === 'job' ? 'Click a run to open its job; Shift+click opens its schedule.' : 'Click a run to open its schedule.'}`}</p>
  </div>
}
