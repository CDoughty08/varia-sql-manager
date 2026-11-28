import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { densities, defaultDensity } from '../../../shared/theme/metrics'
import { observeResize, windows } from '../core/windows'
import Icon from '../Icon'
import { placePopover } from '../results/ComparePopover'
import type { EntryKey, TabResults } from '../results/ResultsService'
import { filterRows, pickerRows, pickerScroll, pickerSummary, pickerWindow } from './result-picker'

/** A row of the list (.rt-picker-row, `--varia-row`) in the default density, and the most rows it shows before it scrolls. */
export const pickerRowHeight = densities[defaultDensity].row
export const pickerRowsShown = 10
const cardWidth = 320, margin = 8

/**
 * The Tabs layout's overflow picker: every view of the run (each result's Table, its Pivot indented under it, then the
 * comparisons) in a themed list with a filter box. The list is virtual: whatever the run holds (a run can return 1,000
 * results), it draws the rows in view and a few either side. The filter box keeps the focus and the list follows it as a
 * combobox's does: Up, Down, Page Up and Page Down move the active row, Enter shows it, Escape closes the picker. A press
 * outside, the focus leaving and the window losing the focus close it too. Drawn in the window of its anchor (a popout's too).
 */
export default function ResultsPicker({ tab, anchor, selected, onPick, onClose }: {
  tab: Pick<TabResults, 'groups' | 'comparisons' | 'sorts'> & Partial<Pick<TabResults, 'multi'>>
  /** What it is placed under: the overflow button, else the row of result tabs. */
  anchor: () => HTMLElement | null | undefined
  selected?: EntryKey
  onPick: (key: EntryKey) => void
  /** `restore`: Escape, which gives the focus back to the layout; a press or the focus going elsewhere leaves it there. */
  onClose: (restore: boolean) => void
}) {
  const id = useId()
  const card = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null)
  const [host] = useState(() => anchor()?.ownerDocument.body)
  // The row height the stylesheet sets (`--varia-row`, which follows the density), else the default density's.
  const [rowHeight] = useState(() => {
    const element = anchor(), value = element ? Number.parseFloat(element.ownerDocument.defaultView?.getComputedStyle(element).getPropertyValue('--varia-row') ?? '') : NaN
    return value > 0 ? value : pickerRowHeight
  })
  const [query, setQuery] = useState('')
  const rows = useMemo(() => pickerRows(tab), [tab.groups, tab.comparisons, tab.sorts, tab.multi])
  const shown = useMemo(() => filterRows(rows, query), [rows, query])
  const at = (key: EntryKey | undefined) => Math.max(0, shown.findIndex(row => row.key === key))
  const [active, setActive] = useState(() => at(selected))
  const [scrollTop, setScrollTop] = useState(0)
  // The list's height: its rows up to `pickerRowsShown`, less when the window is too short for the card (it is laid out
  // in a flex column then). Measured once laid out; before that, the height it asks for.
  const wanted = Math.max(1, Math.min(shown.length, pickerRowsShown)) * rowHeight
  const [viewHeight, setViewHeight] = useState(0)
  const height = viewHeight || wanted
  const [place, setPlace] = useState<CSSProperties | undefined>()

  const scrollTo = (top: number) => {
    const element = list.current
    if (element) element.scrollTop = top
    setScrollTop(element?.scrollTop ?? top)
  }
  const move = (to: number) => {
    const next = Math.max(0, Math.min(shown.length - 1, to))
    setActive(next)
    scrollTo(pickerScroll(list.current?.scrollTop ?? scrollTop, height, next, rowHeight))
  }
  // A new filter starts at the selected view when it still matches, else at the first row, a few rows below the top. The
  // run changing underneath (a result arriving, closed or pivoted) keeps the active row, where it still is, and the scroll.
  // Recorded when the active row moves, not on every render: a render with the run's new rows still has the old place.
  const activeKey = useRef<EntryKey | undefined>(undefined)
  const filtered = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    if (filtered.current !== query) {
      filtered.current = query
      const start = at(selected)
      setActive(start)
      scrollTo(Math.max(0, (start - 3) * rowHeight))
      return
    }
    const kept = shown.findIndex(row => row.key === activeKey.current)
    setActive(kept >= 0 ? kept : Math.max(0, Math.min(active, shown.length - 1)))
  }, [shown])
  useLayoutEffect(() => { activeKey.current = shown[active]?.key }, [active])

  // Placed under its anchor, right-aligned, else above it; clamped to the window. Again when the window or the anchor
  // changes size; an anchor with no size left (its pane hidden, Ctrl+R) closes the picker.
  const measure = useRef<() => void>(() => {})
  measure.current = () => {
    const target = anchor(), element = card.current
    if (!target || !element) return
    const view = target.ownerDocument.defaultView ?? window, rect = target.getBoundingClientRect()
    const next: CSSProperties = { ...placePopover({ anchor: rect, trigger: true, width: view.innerWidth, height: view.innerHeight, cardWidth: Math.min(cardWidth, view.innerWidth - 2 * margin), wanted: element.offsetHeight - (list.current?.clientHeight ?? 0) + wanted }) }
    setPlace(current => current && JSON.stringify(current) === JSON.stringify(next) ? current : next)
  }
  useLayoutEffect(() => { measure.current() })
  useLayoutEffect(() => {
    const element = list.current, view = host?.ownerDocument.defaultView
    if (!element || !view) return
    const again = () => measure.current()
    const resized = observeResize(element, () => setViewHeight(element.clientHeight))
    const target = anchor()
    const moved = target && observeResize(target, () => {
      const rect = target.getBoundingClientRect()
      // Closed with the focus in it, the focus goes back (to where it was opened from, else the layout), not to the page.
      if (!target.isConnected || (rect.width === 0 && rect.height === 0)) onClose(!!card.current?.contains(card.current.ownerDocument.activeElement))
      else again()
    })
    view.addEventListener('resize', again)
    return () => { resized.dispose(); moved?.dispose(); view.removeEventListener('resize', again) }
  }, [host])
  // In: the filter box takes the focus once the picker is placed (until then it is hidden, and a hidden box cannot take
  // it); its window comes forward when the picker opened from another one's palette.
  const placed = !!place
  useLayoutEffect(() => {
    const doc = host?.ownerDocument
    if (!placed || !doc) return
    if (!doc.hasFocus()) doc.defaultView?.focus()
    input.current?.focus({ preventScroll: true })
  }, [host, placed])
  // A press outside or the window losing the focus closes it; so does its pane moving to another window.
  useEffect(() => {
    const doc = host?.ownerDocument, view = doc?.defaultView
    if (!doc || !view) return
    const press = (event: PointerEvent) => {
      const at = event.target as Element | null
      // Nor its filter box's context menu (Paste), drawn in the menu layer.
      if (card.current?.contains(at) || at?.closest('.menu-layer')) return
      // The overflow button is a toggle: its own press closes the picker.
      if (at?.closest('.rt-overflow') && anchor()?.closest('.rt-root')?.contains(at)) return
      onClose(false)
    }
    const blur = () => onClose(false)
    doc.addEventListener('pointerdown', press, true)
    view.addEventListener('blur', blur)
    const adoption = windows.onDidAdopt(() => onClose(false))
    return () => { doc.removeEventListener('pointerdown', press, true); view.removeEventListener('blur', blur); adoption.dispose() }
  }, [host])

  if (!host) return null
  const leave = (event: FocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget as Element | null
    // Not its overflow button, a toggle that closes it itself; not another dialog (the palette) or a context menu, which
    // give the focus back.
    const toggle = !!to?.closest('.rt-overflow') && !!anchor()?.closest('.rt-root')?.contains(to)
    if (to && !event.currentTarget.contains(to) && !toggle && !to.closest('[role="dialog"], .menu-layer')) onClose(false)
  }
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const page = Math.max(1, Math.floor(height / rowHeight) - 1)
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'PageDown' ? page : event.key === 'PageUp' ? -page : 0
    if (step && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); move(active + step) }
    else if (event.key === 'Enter') { event.preventDefault(); const row = shown[active]; if (row) onPick(row.key) }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true) }
    else if (event.key === 'Tab') { event.preventDefault() }
  }
  const [from, end] = pickerWindow(scrollTop, height, shown.length, rowHeight)
  // The active row is named only while it is drawn (a wheel can scroll it away).
  const named = shown[active] && active >= from && active < end
  const optionId = (place: number) => `${id}option-${place}`
  // `data-results-picker`: the focus here counts as the Results pane's for its keys (`resultsFocus`).
  // A press anywhere in it but the filter box leaves the focus there, so its keys keep working.
  return createPortal(<div ref={card} className="rt-picker" role="dialog" aria-label="Go to Result" data-results-picker="" style={place ?? { visibility: 'hidden' }} onBlur={leave}
    onMouseDown={event => { if (event.target !== input.current) event.preventDefault() }}>
    <label className="rt-picker-head">
      <Icon name="search" />
      <input ref={input} type="text" role="combobox" value={query} placeholder="Go to a result, view or comparison" aria-label="Filter results, views and comparisons"
        aria-expanded="true" aria-controls={id + 'list'} aria-autocomplete="list" {...named ? { 'aria-activedescendant': optionId(active) } : {}}
        spellCheck={false} autoComplete="off" onChange={event => setQuery(event.target.value)} onKeyDown={keyDown} />
    </label>
    <div ref={list} className="rt-picker-list" id={id + 'list'} role="listbox" aria-label="Results, views and comparisons" style={{ height: wanted }}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      {shown.length === 0 ? <div className="rt-picker-none">Nothing matches.</div>
        : <div className="rt-picker-space" style={{ height: shown.length * rowHeight }}>
          {shown.slice(from, end).map((row, place) => {
            const index = from + place
            // The active row is the selected option, as a combobox's list has it; the view shown is the current one.
            return <div key={row.key} id={optionId(index)} className="rt-picker-row" role="option" aria-selected={index === active} aria-label={row.label}
              {...row.key === selected ? { 'aria-current': 'true' as const } : {}}
              data-active={index === active || undefined} data-sub={row.kind === 'pivot' || undefined} style={{ top: index * rowHeight, height: rowHeight }}
              aria-setsize={shown.length} aria-posinset={index + 1}
              // The filter box keeps the focus, so the keys still work after a press.
              onPointerDown={event => event.preventDefault()} onClick={() => onPick(row.key)}>
              {row.kind === 'summary' && <Icon name="layers" />}{row.kind === 'plan' && <Icon name="execution-plan" />}{row.kind === 'comparison' && <Icon name="git-compare" />}
              <span className="rt-picker-name">{row.name}</span>{row.number && <small className="rt-picker-number">{row.number}</small>}{row.detail && <small>{row.detail}</small>}
            </div>
          })}
        </div>}
    </div>
    <div className="rt-picker-foot" aria-live="polite">{pickerSummary(rows, shown.length)}</div>
  </div>, host)
}
