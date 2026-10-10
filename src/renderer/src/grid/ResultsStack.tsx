import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { nextFrame } from '../core/frame'
import { useWorkbench } from '../core/WorkbenchContext'
import type { TabResults } from '../results/ResultsService'
import { gridLimits as g } from './constants'
import ResultGrid, { GridPlaceholder } from './ResultGrid'
import { dragSplitter, minGridHeight, mountedRange, stackLayout } from './stack'

let scrollbar: number | undefined
/** The platform's scroll bar thickness (classic scroll bars take room; overlay ones take none). */
function scrollbarSize(): number {
  if (scrollbar !== undefined) return scrollbar
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;top:-1000px;width:100px;height:100px;overflow:scroll'
  document.body.append(probe)
  scrollbar = probe.offsetHeight - probe.clientHeight
  probe.remove()
  return scrollbar
}

/**
 * A run's result sets stacked as SSMS stacks them: the pane is split equally (or by the weights a splitter drag left),
 * no grid is shorter than a header and four rows, and when they do not fit the stack scrolls. Only the grids within a
 * view above and below are rendered, at most 12, mounting at most 2 a frame; the rest show a one-line placeholder or
 * nothing. Scroll position, weights and the focused grid live in the tab's view state.
 */
export default function ResultsStack({ tabId, tab }: { tabId: string; tab: TabResults }) {
  const { results } = useWorkbench()
  const view = results.viewState(tabId)
  const sets = tab.sets, count = sets.length
  const stackRef = useRef<HTMLDivElement>(null)
  const [paneHeight, setPaneHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(view.stackScrollTop)
  const [weights, setWeightsState] = useState(view.weights)
  const [focused, setFocused] = useState(view.focusedIndex)
  const [mounted, setMounted] = useState<ReadonlySet<number>>(() => new Set())
  const minHeight = useMemo(() => minGridHeight(scrollbarSize()), [])
  const layout = useMemo(() => stackLayout(paneHeight, count, weights, minHeight), [paneHeight, count, weights, minHeight])
  const [first, last] = paneHeight > 0 ? mountedRange(layout, scrollTop, paneHeight) : [0, -1]
  const drag = useRef<{ index: number; pointerId: number; startY: number; heights: readonly number[]; frame?: () => void; y: number } | undefined>(undefined)
  const setWeights = (next: number[] | undefined) => { view.weights = next; setWeightsState(next) }

  useLayoutEffect(() => {
    const element = stackRef.current!
    const observer = new ResizeObserver(() => setPaneHeight(element.clientHeight))
    observer.observe(element)
    setPaneHeight(element.clientHeight)
    return () => observer.disconnect()
  }, [])
  // The saved scroll position, once the content is tall enough to take it.
  useLayoutEffect(() => {
    const element = stackRef.current
    if (element && paneHeight > 0 && Math.abs(element.scrollTop - view.stackScrollTop) >= 1) element.scrollTop = view.stackScrollTop
  }, [paneHeight, view])
  // At most 2 grids mount a frame, so scrolling a stack of 1,000 never builds 12 grids at once.
  useEffect(() => {
    let missing = false
    for (let index = first; index <= last; index++) if (!mounted.has(index)) { missing = true; break }
    const stale = [...mounted].some(index => index < first || index > last)
    if (!missing && !stale) return
    return nextFrame(() => setMounted(current => {
      const next = new Set<number>()
      for (const index of current) if (index >= first && index <= last) next.add(index)
      for (let index = first, added = 0; index <= last && added < g.mountsPerFrame; index++) if (!next.has(index)) { next.add(index); added++ }
      return next
    }))
  }, [first, last, mounted])
  useEffect(() => () => drag.current?.frame?.(), [])

  const focus = (index: number) => { view.focusedIndex = index; setFocused(index) }
  const splitterDown = (index: number, event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus()
    drag.current = { index, pointerId: event.pointerId, startY: event.clientY, heights: layout.heights, y: event.clientY }
  }
  const splitterMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    state.y = event.clientY
    if (state.frame) return
    // One layout per frame while dragging.
    state.frame = nextFrame(() => {
      state.frame = undefined
      if (drag.current === state) setWeights(dragSplitter(state.heights, state.index, state.y - state.startY, minHeight))
    })
  }
  const splitterUp = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    state.frame?.()
    setWeights(dragSplitter(state.heights, state.index, event.clientY - state.startY, minHeight))
    drag.current = undefined
  }
  const splitterKey = (index: number, event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowUp' ? -g.rowHeight : event.key === 'ArrowDown' ? g.rowHeight : event.key === 'Home' ? -Infinity : event.key === 'End' ? Infinity : undefined
    if (event.key === 'Enter') { event.preventDefault(); setWeights(undefined); return }
    if (delta === undefined || event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    setWeights(dragSplitter(layout.heights, index, delta, minHeight))
  }

  const items = []
  for (let index = first; index <= last; index++) {
    const entry = sets[index]
    if (!entry) continue
    items.push(<div key={`item-${entry.descriptor.generation}:${entry.descriptor.resultId}`} className="rs-item" style={{ top: layout.offsets[index], height: layout.heights[index] }}>
      {mounted.has(index) ? <ResultGrid tabId={tabId} entry={entry} count={count} focused={index === Math.min(focused, count - 1)} budget={tab.summary?.budget} onFocus={focus} /> : <GridPlaceholder entry={entry} />}
    </div>)
    if (index < count - 1) {
      // The value is the upper grid's height, which the splitter moves between the two grids' minimum heights.
      const height = Math.round(layout.heights[index])
      items.push(<div key={`splitter-${index}`} className="rs-splitter" role="separator" aria-orientation="horizontal" aria-label={`Resize Result ${index + 1}`}
        aria-valuenow={height} aria-valuemin={Math.round(minHeight)} aria-valuemax={Math.round(layout.heights[index] + layout.heights[index + 1] - minHeight)}
        aria-valuetext={`Result ${index + 1} height ${height} pixels`} tabIndex={0} style={{ top: layout.offsets[index] + layout.heights[index] }}
        onPointerDown={event => splitterDown(index, event)} onPointerMove={splitterMove} onPointerUp={splitterUp} onLostPointerCapture={() => { drag.current = undefined }}
        onDoubleClick={() => setWeights(undefined)} onKeyDown={event => splitterKey(index, event)} />)
    }
  }
  return <div ref={stackRef} className="rs-stack" onScroll={event => { view.stackScrollTop = event.currentTarget.scrollTop; setScrollTop(event.currentTarget.scrollTop) }}>
    <div className="rs-content" style={{ height: layout.total }}>{items}</div>
  </div>
}
