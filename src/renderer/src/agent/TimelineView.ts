// The Schedules Timeline's drawing (AG-14): imperative like GridView, so nothing in React runs per run. React renders the rows (at most
// timelineLimits.rows) with an empty lane cell each; this draws into the lanes the runs inside the visible part of the window, from a pool
// of elements per lane, merging runs closer than two pixels into one bar (so an every-10-seconds schedule draws at most one element per
// two pixels of lane, whatever the window holds), plus the time axis, midnight lines and the now line. Colours are CSS (var(--varia-*))
// on the classes it sets; text (the axis labels and the hover tooltip) is written only through Text nodes. It draws at most once an
// animation frame, when the model, the viewport, the size or the active run changed.
import { timelineClock, timelineText, type TimelineModel, type TimelineRun } from '../../../shared/agent/timeline'
import type { Disposable } from '../core/types'
import { observeResize } from '../core/windows'

export interface TimelineViewport {
  /** Seconds from the window's start at the left edge. */
  readonly start: number
  /** Seconds the lanes show. */
  readonly seconds: number
}
export interface TimelineActive { readonly row: number; readonly run: number }
export interface TimelineViewOptions {
  /** The axis row's lane part, where tick labels go. */
  readonly axis: HTMLElement
  /** A positioned element over the lanes for the hover tooltip. */
  readonly root: HTMLElement
  /** Opens a run: its job (or, with `schedule` or on a schedule row, its schedule). */
  readonly open: (row: number, run: number, schedule: boolean) => void
  readonly requestFrame?: (callback: () => void) => number
  readonly cancelFrame?: (handle: number) => void
}

/** Tick steps the axis picks from, the smallest giving labels at least 64 pixels apart. */
const tickSteps = [5 * 60, 15 * 60, 30 * 60, 3_600, 2 * 3_600, 3 * 3_600, 6 * 3_600, 12 * 3_600, 86_400]
const minTickPixels = 64
/** Runs whose bars come closer than this (pixels) draw as one. */
const mergePixels = 2

interface LanePool { readonly lane: HTMLElement; readonly bars: HTMLSpanElement[]; used: number }

/** The first run whose end is after `start` (runs are in start order and, within a row, the same length). */
function firstVisible(runs: readonly TimelineRun[], start: number): number {
  let low = 0, high = runs.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (runs[middle].start + runs[middle].seconds <= start) low = middle + 1
    else high = middle
  }
  return low
}

export class TimelineView implements Disposable {
  private model?: TimelineModel
  private viewport: TimelineViewport = { start: 0, seconds: 86_400 }
  private active?: TimelineActive
  private lanes: LanePool[] = []
  private readonly ticks: HTMLSpanElement[] = []
  private readonly marks: HTMLSpanElement[] = []
  private readonly tooltip: HTMLDivElement
  private readonly tooltipText: Text
  private frame?: number
  private resize?: Disposable
  /** Ends every lane listener at dispose (a lane cell outlives a view React's StrictMode replays). */
  private readonly listening = new AbortController()
  private readonly requestFrame: (callback: () => void) => number
  private readonly cancelFrame: (handle: number) => void

  constructor(private readonly options: TimelineViewOptions) {
    this.requestFrame = options.requestFrame ?? (callback => requestAnimationFrame(callback))
    this.cancelFrame = options.cancelFrame ?? (handle => cancelAnimationFrame(handle))
    const document = options.root.ownerDocument
    this.tooltip = document.createElement('div')
    this.tooltip.className = 'agent-timeline-tooltip'
    // Inside the grid, so kept out of the accessibility tree: the live region announces the active run, and a grid holds only rows.
    this.tooltip.setAttribute('aria-hidden', 'true')
    this.tooltip.hidden = true
    this.tooltipText = document.createTextNode('')
    this.tooltip.appendChild(this.tooltipText)
    options.root.appendChild(this.tooltip)
    this.resize = observeResize(options.axis, () => this.schedule())
  }

  setModel(model: TimelineModel | undefined): void { this.model = model; this.hideTooltip(); this.schedule() }
  setViewport(viewport: TimelineViewport): void { this.viewport = viewport; this.hideTooltip(); this.schedule() }
  setActive(active: TimelineActive | undefined): void { this.active = active; this.schedule() }
  /** The lane cells, one per row in the model's order; lanes no longer listed lose their bars. */
  setLanes(lanes: readonly HTMLElement[]): void {
    const kept = new Map(this.lanes.map(pool => [pool.lane, pool]))
    for (const pool of this.lanes) if (!lanes.includes(pool.lane)) { for (const bar of pool.bars) bar.remove() }
    this.lanes = lanes.map(lane => {
      const found = kept.get(lane)
      if (found) return found
      const pool: LanePool = { lane, bars: [], used: 0 }
      const { signal } = this.listening
      lane.addEventListener('pointermove', event => this.hover(pool, event), { signal })
      lane.addEventListener('pointerleave', () => this.hideTooltip(), { signal })
      lane.addEventListener('click', event => this.click(pool, event), { signal })
      return pool
    })
    this.schedule()
  }

  /** The run under a lane's x (client pixels), or undefined: the nearest bar within a few pixels. */
  hit(row: number, clientX: number): number | undefined {
    const pool = this.lanes[row], runs = this.model?.rows[row]?.runs
    if (!pool || !runs?.length) return undefined
    const box = pool.lane.getBoundingClientRect()
    if (box.width <= 0) return undefined
    const { start, seconds } = this.viewport
    const at = start + (clientX - box.left) / box.width * seconds, slack = 4 / box.width * seconds
    let best: number | undefined, distance = Infinity
    for (let index = firstVisible(runs, at - slack); index < runs.length && runs[index].start <= at + slack; index++) {
      const run = runs[index], gap = at < run.start ? run.start - at : at > run.start + run.seconds ? at - run.start - run.seconds : 0
      if (gap < distance) { distance = gap; best = index }
    }
    return distance <= slack ? best : undefined
  }

  dispose(): void {
    if (this.frame !== undefined) this.cancelFrame(this.frame)
    this.listening.abort()
    this.resize?.dispose()
    this.options.root.style.removeProperty('--agent-timeline-grid-step')
    this.options.root.style.removeProperty('--agent-timeline-grid-offset')
    for (const pool of this.lanes) for (const bar of pool.bars) bar.remove()
    for (const element of [...this.ticks, ...this.marks]) element.remove()
    this.tooltip.remove()
    this.lanes = []
  }

  private schedule(): void {
    if (this.frame !== undefined) return
    this.frame = this.requestFrame(() => { this.frame = undefined; this.draw() })
  }

  /** Draws now; tests call it to skip the frame. */
  draw(): void {
    const model = this.model
    this.drawAxis(model)
    this.lanes.forEach((pool, row) => this.drawLane(pool, model?.rows[row]?.runs ?? [], row))
  }

  private drawAxis(model: TimelineModel | undefined): void {
    const width = this.options.axis.clientWidth
    const { start, seconds } = this.viewport
    let tick = 0, mark = 0
    if (model && width > 0) {
      const step = tickSteps.find(candidate => candidate / seconds * width >= minTickPixels) ?? tickSteps[tickSteps.length - 1]
      // Ticks on the wall clock's round times: the window starts at now, so the first is the next multiple of the step after it.
      const origin = secondsIntoDay(model)
      const first = Math.ceil((origin + start) / step) * step - origin
      const stepPx = step / seconds * width
      const offsetPx = (first - start) / seconds * width
      this.options.root.style.setProperty('--agent-timeline-grid-step', `${stepPx}px`)
      this.options.root.style.setProperty('--agent-timeline-grid-offset', `${offsetPx}px`)
      for (let at = first; at <= start + seconds; at += step) {
        const element = this.pooled(this.ticks, tick++, 'agent-timeline-tick', this.options.axis)
        element.style.left = `${(at - start) / seconds * 100}%`
        const text = element.firstChild as Text
        text.nodeValue = timelineClock(model, at)
      }
      // Midnights (the start of each day) as faint lines across the axis.
      for (let at = Math.ceil((origin + start) / 86_400) * 86_400 - origin; at <= start + seconds; at += 86_400) {
        const element = this.pooled(this.marks, mark++, 'agent-timeline-midnight', this.options.axis)
        element.style.left = `${(at - start) / seconds * 100}%`
        ;(element.firstChild as Text).nodeValue = ''
      }
    } else {
      this.options.root.style.removeProperty('--agent-timeline-grid-step')
      this.options.root.style.removeProperty('--agent-timeline-grid-offset')
    }
    for (let index = tick; index < this.ticks.length; index++) this.ticks[index].hidden = true
    for (let index = mark; index < this.marks.length; index++) this.marks[index].hidden = true
  }

  private pooled(pool: HTMLSpanElement[], index: number, className: string, parent: HTMLElement): HTMLSpanElement {
    let element = pool[index]
    if (!element) {
      element = parent.ownerDocument.createElement('span')
      element.className = className
      element.setAttribute('aria-hidden', 'true')
      element.appendChild(parent.ownerDocument.createTextNode(''))
      parent.appendChild(element)
      pool[index] = element
    }
    element.hidden = false
    return element
  }

  private drawLane(pool: LanePool, runs: readonly TimelineRun[], row: number): void {
    const width = pool.lane.clientWidth
    const { start, seconds } = this.viewport
    const end = start + seconds
    pool.used = 0
    // The now line: the window starts at now, so it shows while the viewport starts there.
    if (width > 0 && start <= 0) this.bar(pool, 'agent-timeline-now', 0, 2, false, false, false)
    if (width > 0) {
      let open: { x0: number; x1: number; off: boolean; overlap: boolean; active: boolean; element: HTMLSpanElement } | undefined
      for (let index = firstVisible(runs, start); index < runs.length && runs[index].start < end; index++) {
        const run = runs[index]
        const x0 = Math.floor((run.start - start) / seconds * width)
        const x1 = Math.max(x0 + 2, Math.ceil((run.start + run.seconds - start) / seconds * width))
        const active = this.active?.row === row && this.active.run === index
        if (open && !active && !open.active && open.off === run.off && open.overlap === run.overlap && x0 <= open.x1 + mergePixels) {
          open.x1 = Math.max(open.x1, x1)
          open.element.style.width = `${open.x1 - open.x0}px`
          continue
        }
        const element = this.bar(pool, 'agent-timeline-bar', x0, x1 - x0, run.off, run.overlap, active)
        open = { x0, x1, off: run.off, overlap: run.overlap, active, element }
      }
    }
    for (let index = pool.used; index < pool.bars.length; index++) pool.bars[index].hidden = true
  }

  private bar(pool: LanePool, className: string, x: number, width: number, off: boolean, overlap: boolean, active: boolean): HTMLSpanElement {
    let element = pool.bars[pool.used]
    if (!element) {
      element = pool.lane.ownerDocument.createElement('span')
      element.setAttribute('aria-hidden', 'true')
      pool.lane.appendChild(element)
      pool.bars.push(element)
    }
    pool.used++
    element.hidden = false
    element.className = className
    element.toggleAttribute('data-off', off)
    element.toggleAttribute('data-overlap', overlap)
    element.toggleAttribute('data-active', active)
    element.style.left = `${x}px`
    element.style.width = `${width}px`
    return element
  }

  private hover(pool: LanePool, event: PointerEvent): void {
    const row = this.lanes.indexOf(pool), model = this.model
    const run = row < 0 ? undefined : this.hit(row, event.clientX)
    if (!model || run === undefined) { this.hideTooltip(); return }
    this.tooltipText.nodeValue = timelineText.run(model, model.rows[row], model.rows[row].runs[run])
    // The root scrolls (up to timelineLimits.rows rows): place the tooltip in its content, kept inside its visible part.
    const root = this.options.root, box = root.getBoundingClientRect()
    this.tooltip.hidden = false
    const width = this.tooltip.offsetWidth, height = this.tooltip.offsetHeight
    const x = event.clientX - box.left + 12, y = event.clientY - box.top + 16
    const left = x + width > root.clientWidth ? Math.max(0, event.clientX - box.left - 12 - width) : x
    const top = y + height > root.clientHeight ? Math.max(0, event.clientY - box.top - 8 - height) : y
    this.tooltip.style.left = `${left + root.scrollLeft}px`
    this.tooltip.style.top = `${top + root.scrollTop}px`
  }
  private hideTooltip(): void { this.tooltip.hidden = true }
  private click(pool: LanePool, event: MouseEvent): void {
    const row = this.lanes.indexOf(pool)
    const run = row < 0 ? undefined : this.hit(row, event.clientX)
    if (run !== undefined) this.options.open(row, run, event.shiftKey)
  }
}

/** Seconds from midnight to the window's start (the server's now). */
function secondsIntoDay(model: TimelineModel): number {
  const time = model.start.time
  return Math.floor(time / 10_000) * 3_600 + Math.floor(time / 100) % 100 * 60 + time % 100
}
