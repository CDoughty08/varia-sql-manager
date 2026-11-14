import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { focusResultGrid } from '../grid/ResultGrid'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { trapFocus } from '../trap-focus'
import type { UnpairedColumn } from './compare-pairing'
import type { CompareAnchor } from './CompareService'
import { entryName, entryOf, type ResultSetEntry, type TabResults } from './ResultsService'
import { formatCount } from './status'

const nameOf = (column: UnpairedColumn) => column.name || '(No column name)'
const width = 300
/** The pairing rule, said where a column was left out (the ⓘ beside "Not compared"). */
export const pairingRule = 'Columns pair by name, ignoring case, and by both holding text or both binary data; a repeated name pairs in order. There is no manual mapping.'

/** What the popover is drawn beside: the toolbar's Compare button while it shows, else the Table's grid, else the results. */
function anchorOf(home: HTMLElement, anchor: CompareAnchor, tabId: string, key: string): { readonly rect: DOMRect; readonly button?: HTMLElement } {
  const pane = home.closest<HTMLElement>('[data-pane]') ?? home.ownerDocument.body
  const button = anchor === 'toolbar' ? pane.querySelector<HTMLElement>('.results-compare') : null
  const rect = button?.getBoundingClientRect()
  if (button && rect && rect.width > 0) return { rect, button }
  const grid = pane.querySelector<HTMLElement>(`[data-result-grid][data-tab-id="${CSS.escape(tabId)}"][data-result-entry="${CSS.escape(key)}"]`)
  return { rect: (grid ?? home.parentElement ?? pane).getBoundingClientRect() }
}

/**
 * The Compare popover: opened on a group's Table (Compare…, Compare Results…, or the toolbar's Compare), which is the new
 * side (+); the Table picked is the old side (−), and Swap turns them round. It is drawn beside what opened it, in that
 * window (the main one or a popout's): under the toolbar's Compare button, else at the top right of the Table's grid.
 *
 * It says only what applies: the list of targets when there is a choice, the columns left out when any are, and that the
 * inputs' filters and sorts are not applied only while one is sorted or filtered. Enter compares, Escape and Close close it
 * and give the focus back to what opened it, and a press outside closes it. Once the comparison is shown it closes and the
 * comparison takes the focus; while the comparison runs it stays, offering Cancel, and says a failure.
 */
export default function ComparePopover({ tabId, tab }: { tabId: string; tab: TabResults }) {
  const { compare, results } = useWorkbench()
  const state = useServiceSnapshot(compare)
  useServiceSnapshot(results)
  const ids = useId()
  const home = useRef<HTMLSpanElement>(null), card = useRef<HTMLFormElement>(null), button = useRef<HTMLButtonElement>(null)
  const [place, setPlace] = useState<CSSProperties | undefined>()
  // The window it opens in: the one its results are drawn in (the main window, or a popout's).
  const [host, setHost] = useState<HTMLElement | undefined>()
  useLayoutEffect(() => { setHost(home.current?.ownerDocument.body) }, [])
  const picker = state.pickers[tabId]
  const active = picker ? entryOf(tab.sets, picker.active) : undefined
  const name = active ? entryName(active) : ''
  const targets = active ? compare.targetsOf(tabId, active.key) : []
  const sides = compare.sidesOf(tabId)
  const running = !!sides && !!picker && compare.isRunning(tabId, sides.old.key, sides.neu.key, picker.exact)
  const shown = sides && picker ? compare.existing(tabId, sides.old.key, sides.neu.key, picker.exact) : undefined

  // Placed under its anchor when it fits, else above it; clamped to the window, scrolling inside when short.
  useLayoutEffect(() => {
    const element = home.current, form = card.current
    if (!element || !picker || !host) return
    const measure = () => {
      const view = element.ownerDocument.defaultView ?? window
      const { rect, button: trigger } = anchorOf(element, picker.anchor, tabId, picker.active)
      const right = trigger ? rect.right : rect.right - 12
      const left = Math.max(8, Math.min(right - width, view.innerWidth - width - 8))
      const top = trigger ? rect.bottom + 4 : rect.top + 4
      const below = view.innerHeight - top - 8, above = (trigger ? rect.top : rect.bottom) - 12
      const wanted = form?.scrollHeight ?? 0
      const next: CSSProperties = below >= wanted || below >= above ? { left, top, maxHeight: Math.max(120, below) } : { left, bottom: view.innerHeight - (trigger ? rect.top - 4 : rect.bottom - 4), maxHeight: above }
      setPlace(current => current && JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }
    measure()
    const view = element.ownerDocument.defaultView ?? window
    view.addEventListener('resize', measure)
    element.ownerDocument.addEventListener('scroll', measure, true)
    return () => { view.removeEventListener('resize', measure); element.ownerDocument.removeEventListener('scroll', measure, true) }
  }, [host, picker?.anchor, picker?.active, tabId, targets.length, !!sides, sides?.pairing.oldOnly.length, sides?.pairing.newOnly.length, picker?.error])

  // The focus goes in once it is placed: to the picked target when there is a list, else to Compare.
  const placed = !!place
  useLayoutEffect(() => {
    if (!placed) return
    const form = card.current
    const into = form?.querySelector<HTMLInputElement>('input[type="radio"]:checked') ?? form?.querySelector<HTMLInputElement>('input[type="radio"]') ?? button.current
    into?.focus({ preventScroll: true })
  }, [placed])

  // A press outside closes it, leaving the focus where the press put it; the toolbar's Compare closes it itself.
  useEffect(() => {
    const element = home.current
    if (!element || !picker) return
    const doc = element.ownerDocument
    const press = (event: PointerEvent) => {
      const at = event.target as Element | null
      if (card.current?.contains(at)) return
      // The toolbar's Compare is a toggle: its own press closes the popover.
      if (at?.closest('.results-compare') && element.closest('[data-pane]')?.contains(at)) return
      compare.close(tabId)
    }
    doc.addEventListener('pointerdown', press, true)
    return () => doc.removeEventListener('pointerdown', press, true)
  }, [compare, tabId, !!picker])

  if (!picker) return null

  /** Escape, Close and the head's close button: the focus goes back to what opened it. */
  const dismiss = () => {
    const element = home.current
    const trigger = element ? anchorOf(element, picker.anchor, tabId, picker.active).button : undefined
    const owner = element?.ownerDocument
    compare.close(tabId)
    if (trigger) trigger.focus()
    else focusResultGrid(owner, tabId, picker.active)
  }
  // Compare (or Show It) shows the comparison and closes the popover: the keyboard focus goes to the comparison's grid,
  // unless the user has put it somewhere other than this popover since.
  const start = async () => {
    if (running || !sides) return
    const owner = card.current?.ownerDocument, form = card.current
    const focused = await compare.run(tabId)
    const at = owner?.activeElement
    const lost = !at || at === owner.body || !at.isConnected || !!form?.contains(at)
    if (focused !== undefined && lost && results.getSnapshot()[tabId]?.focused === focused) focusResultGrid(owner, tabId, focused)
  }
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() }
    // Enter on a target or on Exact text compares, as it would in a form with one button.
    else if (event.key === 'Enter' && (event.target as Element).matches('input')) { event.preventDefault(); void start() }
  }

  const columns = (active?.descriptor.columns ?? []).filter(column => column.role !== 'tone').length
  const list = targets.length > 1 || (targets.length === 1 && !sides)
  const reordered = (entry: ResultSetEntry) => { const sort = results.sortOf(tabId, entry.key); return !!sort && (sort.keys.length > 0 || sort.filters.length > 0) }
  const filtered = sides ? [sides.old, sides.neu].filter(reordered) : []
  const left = sides ? [...sides.pairing.oldOnly.map(column => [column, sides.old, sides.neu] as const), ...sides.pairing.newOnly.map(column => [column, sides.neu, sides.old] as const)] : []
  const rows = (entry: ResultSetEntry) => formatCount(entry.handle.getSnapshot().rowsStored)
  const side = (entry: ResultSetEntry, old: boolean) => <div className="compare-side" role="group" aria-label={old ? 'Old side' : 'New side'}
    title={old ? 'Old side: its rows that differ show as removed (−)' : 'New side: its rows that differ show as added (+)'}>
    <span className={old ? 'compare-sign removed' : 'compare-sign added'} aria-hidden="true">{old ? '−' : '+'}</span>
    <b>{entryName(entry)}</b>{!list && <small>{rows(entry)} rows</small>}
  </div>
  const title = sides ? `Differences: ${entryName(sides.old)} → ${entryName(sides.neu)}` : ''

  return <>
    <span ref={home} hidden />
    {host && createPortal(<form ref={card} className="compare-popover" role="dialog" aria-label="Compare" aria-busy={running || undefined} style={place ?? { visibility: 'hidden' }}
      onKeyDown={keyDown} onSubmit={event => { event.preventDefault(); void start() }}>
      <div className="compare-head">
        <h2>Compare {name}{targets.length > 0 && <span> with</span>}</h2>
        <button type="button" className="icon-button" aria-label="Close Compare" title="Close (Escape)" onClick={dismiss}><Icon name="close" /></button>
      </div>
      <div className="compare-body">
        {targets.length === 0 && <p className="compare-note">No other result of this run shares a column with {name}.</p>}
        {list && <fieldset className="compare-targets">
          <legend className="visually-hidden">Compare {name} with</legend>
          {targets.map(target => {
            const partial = target.pairing.pairs.length < columns
            return <label key={target.entry.key} className={picker.target === target.entry.key ? 'compare-target picked' : 'compare-target'}>
              <input type="radio" name={ids + 'target'} disabled={running} checked={picker.target === target.entry.key} onChange={() => compare.pick(tabId, target.entry.key)} />
              <span className="compare-target-name">{entryName(target.entry)}</span>
              {partial && <span className="compare-chip" title={`${formatCount(target.pairing.pairs.length)} of ${formatCount(columns)} columns pair; the rest are not compared`}>{formatCount(target.pairing.pairs.length)} of {formatCount(columns)} columns</span>}
              <small>{rows(target.entry)} rows</small>
            </label>
          })}
        </fieldset>}
        {sides && <div className="compare-sides">
          {side(sides.old, true)}
          <button type="button" className="icon-button" aria-label="Swap old and new" title="Swap old and new" disabled={running} onClick={() => compare.swap(tabId)}><Icon name="arrow-swap" /></button>
          {side(sides.neu, false)}
        </div>}
        {left.length > 0 && <section className="compare-unpaired" aria-labelledby={ids + 'unpaired'}>
          <h3 id={ids + 'unpaired'}>Not compared <span className="compare-info" title={pairingRule} aria-label={pairingRule} role="img"><Icon name="info" /></span></h3>
          <ul>{left.map(([column, own, other]) => <li key={own.key + ':' + column.index}>
            <code>{nameOf(column)}</code>
            <span>{column.otherType !== undefined ? `${column.dataType} here, ${column.otherType} in ${entryName(other)}` : `only in ${entryName(own)}`}</span>
          </li>)}</ul>
        </section>}
        {filtered.length > 0 && <p className="compare-note warning"><Icon name="filter" /><span>{filtered.map(entryName).join(' and ')} {filtered.length > 1 ? 'are' : 'is'} sorted or filtered here. The comparison uses all the stored rows, in their own order.</span></p>}
        {/* Mounted, and in the accessibility tree, while the popover is, so a failure written into it is read out. */}
        <p className={picker.error ? 'compare-note error' : picker.cancelled ? 'compare-note' : 'visually-hidden'} role="status">{picker.error ?? (picker.cancelled ? 'Comparison cancelled.' : '')}</p>
      </div>
      <div className="compare-foot">
        <label className="compare-exact" title="Case and trailing spaces count"><input type="checkbox" disabled={running} checked={picker.exact} onChange={event => compare.setExact(tabId, event.target.checked)} /> Exact text</label>
        <span className="compare-gap" />
        {running && sides
          ? <button type="button" onClick={() => compare.cancel(tabId, sides.old.key, sides.neu.key, picker.exact)}>Cancel</button>
          : <button type="button" onClick={dismiss}>Close</button>}
        {/* Only aria-disabled while its comparison runs, so the keyboard focus stays on it and a failure is met there. */}
        <button ref={button} type="submit" className="primary" disabled={!sides} aria-disabled={running || undefined}
          title={sides ? `${shown ? 'Shows' : 'Opens'} “${title}”, a copy that stays when its inputs close` : undefined}>
          {running ? <><Icon name="loading" spin /> Comparing…</> : shown ? 'Show It' : 'Compare'}
        </button>
      </div>
    </form>, host)}
  </>
}
