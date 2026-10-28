import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { nextFrame } from '../core/frame'
import { useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { setKey, type ResultSetEntry, type TabResults } from '../results/ResultsService'
import { formatCount, plural } from '../results/status'
import { gridLimits as g } from './constants'
import ResultGrid from './ResultGrid'
import { contentHeight, dragSplitter, minGridHeight, mountedRange, stackLayout } from './stack'

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

/** "Batch 2 of 3", with the repetition of a batch run with GO n; '' for a script of one batch run once. */
export function batchText(batchNumber: number, iteration: number, totalBatches: number): string {
  const batch = totalBatches > 1 ? `Batch ${batchNumber} of ${totalBatches}` : ''
  return iteration > 1 ? batch ? `${batch}, repetition ${iteration}` : `Repetition ${iteration}` : batch
}

/**
 * A set's caption: Collapse, its name, rows (counting while they stream) and columns, the batch it came from, and Save
 * Results As for it. It renders for each set in view, so a set's facts show before its grid mounts.
 */
const ResultCaption = memo(function ResultCaption({ tabId, entry, collapsed, totalBatches, onToggle }: { tabId: string; entry: ResultSetEntry; collapsed: boolean; totalBatches: number; onToggle(index: number): void }) {
  const { commands } = useWorkbench()
  const snapshot = useSyncExternalStore(entry.handle.subscribe, entry.handle.getSnapshot)
  const { descriptor } = entry, rows = snapshot.rowsAvailable, columns = descriptor.columns.length, name = `Result ${entry.index + 1}`
  const facts = [`${formatCount(rows)} ${plural(rows, 'row')}`, `${formatCount(columns)} ${plural(columns, 'column')}`]
  if (descriptor.kind === 'executionPlan') facts.push('execution plan')
  const batch = batchText(descriptor.batchNumber, descriptor.iteration, totalBatches)
  const held = snapshot.state !== 'lost' && snapshot.state !== 'released'
  const save = (event: MouseEvent<HTMLButtonElement>) => {
    void commands.execute('output.saveResultsAs', { target: { kind: 'output', tabId, view: 'grid', resultIndex: entry.index, selectedText: '', element: event.currentTarget } }, 'toolbar')
  }
  return <div className="rs-caption">
    <button type="button" className="rs-caption-toggle" aria-expanded={!collapsed} onClick={() => onToggle(entry.index)}>
      <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} /><span className="rs-caption-name">{name}</span>
    </button>
    {/* Rows change while the set streams; the grid's own label announces its counts. */}
    <span className="rs-caption-facts" aria-live="off">{facts.join(' · ')}</span>
    {batch && <span className="rs-caption-batch">{batch}</span>}
    {held && <button type="button" className="icon-button rs-caption-save" aria-label={`Save ${name} As…`} title={`Save ${name} As…`} onClick={save}><Icon name="save-as" /></button>}
  </div>
})

/**
 * A run's result sets stacked, each under its caption: a set that has all its rows and needs less than its share is
 * sized to them, the rest share the pane equally (or by the weights a splitter drag left), no grid is shorter than a
 * header and four rows (or its rows), a collapsed set is its caption alone, and when they do not fit the stack scrolls.
 * Only the sets within a view above and below are rendered, at most 12, mounting at most 2 grids a frame; a set waiting
 * for its grid shows its caption. Scroll position, weights, collapsed sets and the focused grid live in the tab's view
 * state.
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
  const [collapsed, setCollapsedState] = useState(view.collapsed)
  const [mounted, setMounted] = useState<ReadonlySet<number>>(() => new Set())
  const minHeight = useMemo(() => minGridHeight(scrollbarSize()), [])
  const settled = tab.settled
  const content = useMemo(() => sets.map(entry => { const set = settled.get(setKey(entry.descriptor)); return set ? contentHeight(set.rows, scrollbarSize(), set.strip) : undefined }), [sets, settled])
  const layout = useMemo(() => stackLayout(paneHeight, count, weights, minHeight, { content, collapsed }), [paneHeight, count, weights, minHeight, content, collapsed])
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
  // At most 2 grids mount a frame, so scrolling a stack of 1,000 never builds 12 grids at once. The first ones mount
  // before the pane paints, so the first rows are not a frame later.
  useLayoutEffect(() => {
    let missing = false
    for (let index = first; index <= last; index++) if (!mounted.has(index)) { missing = true; break }
    const stale = [...mounted].some(index => index < first || index > last)
    if (!missing && !stale) return
    const mount = (current: ReadonlySet<number>) => {
      const next = new Set<number>()
      for (const index of current) if (index >= first && index <= last) next.add(index)
      for (let index = first, added = 0; index <= last && added < g.mountsPerFrame; index++) if (!next.has(index)) { next.add(index); added++ }
      return next
    }
    if (mounted.size === 0) { setMounted(mount); return }
    return nextFrame(() => setMounted(mount))
  }, [first, last, mounted])
  useEffect(() => () => drag.current?.frame?.(), [])

  const focus = (index: number) => { view.focusedIndex = index; setFocused(index) }
  // Stable, so captions re-render only when their own facts change.
  const toggle = useCallback((index: number) => {
    const next = new Set(view.collapsed)
    if (!next.delete(index)) next.add(index)
    view.collapsed = next
    setCollapsedState(next)
  }, [view])
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
    const shut = collapsed.has(index)
    items.push(<div key={`item-${setKey(entry.descriptor)}`} className="rs-item" data-collapsed={shut || undefined} style={{ top: layout.offsets[index], height: layout.heights[index] }}>
      <ResultCaption tabId={tabId} entry={entry} collapsed={shut} totalBatches={tab.totalBatches} onToggle={toggle} />
      {!shut && mounted.has(index) && <ResultGrid tabId={tabId} entry={entry} count={count} focused={index === Math.min(focused, count - 1)} budget={tab.summary?.budget} onFocus={focus} />}
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
