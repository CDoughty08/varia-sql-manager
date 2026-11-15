import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { focusResultGrid } from '../grid/ResultGrid'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { windows } from '../core/windows'
import { trapFocus } from '../trap-focus'
import type { UnpairedColumn } from './compare-pairing'
import type { CompareAnchor } from './CompareService'
import { comparedNames, comparisonName, distinctName, entryName, entryOf, entrySecondary, numberedName, type ResultSetEntry, type TabResults } from './ResultsService'
import { formatCount } from './status'

const nameOf = (column: UnpairedColumn) => column.name || '(No column name)'
const width = 300
/** The pairing rule, said where a column was left out (the ⓘ beside "Not compared"). */
export const pairingRule = 'Columns pair by name, ignoring case, and by both holding text or both binary data; a repeated name pairs in order. There is no manual mapping.'

interface Box { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export interface PopoverPlace { readonly left: number; readonly top?: number; readonly bottom?: number; readonly maxHeight: number }
const margin = 8

/** What the popover is drawn beside: the toolbar's Compare button while it shows, else the Table's grid, else the results;
 *  with the results' own box (`area`), which a grid scrolled partly out of view is cut to. */
function anchorOf(home: HTMLElement, anchor: CompareAnchor, tabId: string, key: string): { readonly rect: Box; readonly area?: Box; readonly button?: HTMLElement } {
  const pane = home.closest<HTMLElement>('[data-pane]') ?? home.ownerDocument.body
  const button = anchor === 'toolbar' ? pane.querySelector<HTMLElement>('.results-compare') : null
  const rect = button?.getBoundingClientRect()
  if (button && rect && rect.width > 0) return { rect, button }
  const area = (home.parentElement ?? pane).getBoundingClientRect()
  const grid = pane.querySelector<HTMLElement>(`[data-result-grid][data-tab-id="${CSS.escape(tabId)}"][data-result-entry="${CSS.escape(key)}"]`)
  return { rect: grid?.getBoundingClientRect() ?? area, area }
}

/**
 * Where the popover goes in a window of `width` × `height`: under the toolbar's button (`trigger`), else at the top right
 * of the grid's part in view (the grid cut to `area`, or the area when the grid is out of view); above the anchor when
 * there is more room there than below and the card (`wanted` tall) does not fit below. Always inside the window: it slides
 * up rather than run off the bottom, and scrolls inside when even the window is too short.
 */
export function placePopover(o: { readonly anchor: Box; readonly area?: Box; readonly trigger: boolean; readonly width: number; readonly height: number; readonly cardWidth: number; readonly wanted: number }): PopoverPlace {
  let a = o.anchor
  if (!o.trigger && o.area) {
    const cut = { left: Math.max(a.left, o.area.left), top: Math.max(a.top, o.area.top), right: Math.min(a.right, o.area.right), bottom: Math.min(a.bottom, o.area.bottom) }
    a = cut.right > cut.left && cut.bottom > cut.top ? cut : o.area
  }
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high))
  const left = clamp((o.trigger ? a.right : a.right - 12) - o.cardWidth, margin, Math.max(margin, o.width - o.cardWidth - margin))
  const floor = o.height - margin, need = Math.min(o.wanted, o.height - 2 * margin)
  const top = clamp(o.trigger ? a.bottom + 4 : a.top + 4, margin, floor)
  const edge = clamp(o.trigger ? a.top - 4 : a.bottom - 4, margin, floor)
  const below = floor - top, above = edge - margin
  if (below >= need || below >= above) {
    const slid = Math.max(margin, Math.min(top, floor - need))
    return { left, top: slid, maxHeight: floor - slid }
  }
  return { left, bottom: o.height - edge, maxHeight: above }
}

/** The card's height with all its content shown: its height less the body's visible part plus all of the body's content,
 *  as the body scrolls (and the card is capped) once placed. */
function naturalHeight(form: HTMLElement): number {
  const body = form.querySelector<HTMLElement>('.compare-body')
  return body ? form.offsetHeight - body.clientHeight + body.scrollHeight : form.scrollHeight
}

/** Why a column is not compared, naming each result: only one has it, its name repeats in its own result (the other's
 *  column of that name already paired, whatever the types), or the other's holds another kind of value (text and binary). */
function unpairedWhy(column: UnpairedColumn, own: ResultSetEntry, other: ResultSetEntry, sets: readonly ResultSetEntry[]): string {
  // Each result by its name, with its number when another result of the run shares it, so the sentence says which one.
  const [ownName, otherName] = comparedNames(own, other, sets)
  if (column.otherType === undefined) return `only in ${ownName}`
  if (column.repeat) return `a second column of this name in ${ownName}`
  return `${column.dataType} in ${ownName}, ${column.otherType} in ${otherName}`
}

/** Popovers drawn per tab: one that goes while its picker is open (its pane hidden, another tab shown) closes the picker,
 *  unless another takes its place at once (StrictMode's replay, a re-render under a new key). */
const drawn = new Map<string, number>()

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
  // With its number when another result of the run has its name, so the heading says which of them is compared.
  const name = active ? distinctName(active, tab.sets) : ''
  const targets = active ? compare.targetsOf(tabId, active.key) : []
  const sides = compare.sidesOf(tabId)
  const running = !!sides && !!picker && compare.isRunning(tabId, sides.old.key, sides.neu.key, picker.exact)
  const shown = sides && picker ? compare.existing(tabId, sides.old.key, sides.neu.key, picker.exact) : undefined

  // Placed under its anchor when it fits, else above it; clamped to the window, scrolling inside when short. Measured
  // after every render (any of its content can change its height; an unchanged place is not set again) and on resize and
  // scroll.
  const measure = useRef<() => void>(() => {})
  measure.current = () => {
    const element = home.current, form = card.current
    if (!element || !picker || !host) return
    const view = element.ownerDocument.defaultView ?? window
    const { rect, area, button: trigger } = anchorOf(element, picker.anchor, tabId, picker.active)
    const next: CSSProperties = { ...placePopover({ anchor: rect, ...area ? { area } : {}, trigger: !!trigger, width: view.innerWidth, height: view.innerHeight, cardWidth: Math.min(width, view.innerWidth - 2 * margin), wanted: form ? naturalHeight(form) : 0 }) }
    setPlace(current => current && JSON.stringify(current) === JSON.stringify(next) ? current : next)
  }
  useLayoutEffect(() => { measure.current() })
  useLayoutEffect(() => {
    const element = home.current
    if (!element || !picker || !host) return
    const view = element.ownerDocument.defaultView ?? window
    const again = () => measure.current()
    view.addEventListener('resize', again)
    element.ownerDocument.addEventListener('scroll', again, true)
    return () => { view.removeEventListener('resize', again); element.ownerDocument.removeEventListener('scroll', again, true) }
  }, [host, !!picker])

  // Closed, it is placed afresh (and takes the focus again) when it next opens.
  useLayoutEffect(() => { if (!picker) setPlace(undefined) }, [!!picker])
  // The focus goes in once it is placed, and again when it opens on another Table: to the picked target when there is a
  // list, else to Compare.
  const placed = !!place
  useLayoutEffect(() => {
    if (!placed) return
    const form = card.current
    const into = form?.querySelector<HTMLInputElement>('input[type="radio"]:checked') ?? form?.querySelector<HTMLInputElement>('input[type="radio"]') ?? button.current
    // Opened from another window (the palette in the main window over a popped-out Results): that window comes forward,
    // else the keys would stay where they were and the popover could not be reached or dismissed by keyboard.
    const doc = form?.ownerDocument
    if (doc && !doc.hasFocus()) doc.defaultView?.focus()
    into?.focus({ preventScroll: true })
  }, [placed, picker?.active, picker?.anchor])

  // Its pane moving to another window (popping out, docking back) closes it: its listeners and anchor are in the old one.
  useEffect(() => {
    if (!picker || !host) return
    const adoption = windows.onDidAdopt(() => { if (home.current?.ownerDocument.body !== host) compare.close(tabId) })
    return () => adoption.dispose()
  }, [compare, tabId, !!picker, host])

  // Gone while its picker is open (its pane hidden, another document shown): the picker closes too, so it does not come
  // back, taking the focus, when the view does.
  useEffect(() => {
    drawn.set(tabId, (drawn.get(tabId) ?? 0) + 1)
    return () => {
      const left = (drawn.get(tabId) ?? 1) - 1
      if (left > 0) drawn.set(tabId, left)
      else drawn.delete(tabId)
      queueMicrotask(() => { if (!drawn.has(tabId)) compare.close(tabId) })
    }
  }, [compare, tabId])

  // A press outside closes it, leaving the focus where the press put it, as does the window losing the focus; the
  // toolbar's Compare closes it itself.
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
    // A press in another window (the main one, or a popout) reaches this window only as its losing the focus.
    const view = doc.defaultView
    const blur = () => compare.close(tabId)
    doc.addEventListener('pointerdown', press, true)
    view?.addEventListener('blur', blur)
    return () => { doc.removeEventListener('pointerdown', press, true); view?.removeEventListener('blur', blur) }
  }, [compare, tabId, !!picker])

  if (!picker) return null

  /** The focus moving out by key (F6, F8, a shortcut to another view) closes it, as a press outside does. Not a move into
   *  another dialog (the command palette, a modal), which gives the focus back; not the toolbar's Compare, a toggle that
   *  closes it itself; and not the window losing the focus (no `relatedTarget`), handled above. */
  const leave = (event: FocusEvent<HTMLFormElement>) => {
    const to = event.relatedTarget as Element | null
    if (!to || event.currentTarget.contains(to) || to.closest('[role="dialog"]')) return
    if (to.closest('.results-compare') && home.current?.closest('[data-pane]')?.contains(to)) return
    compare.close(tabId)
  }

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
    // Asked once the comparison is there: with the focus in another dialog (the palette), the popover stays for it to come
    // back. Any Compare popover of the document counts (closed and opened again on the pair, it is a new one), and so does
    // a focus lost to the page (a press on the popover's text), which nothing else holds.
    const holdsFocus = () => { const at = owner?.activeElement; return !at || at === owner.body || !at.isConnected || !!at.closest('.compare-popover') }
    const focused = await compare.run(tabId, { holdsFocus })
    const at = owner?.activeElement
    const lost = !at || at === owner.body || !at.isConnected || !!form?.contains(at)
    if (focused !== undefined && lost && results.getSnapshot()[tabId]?.focused === focused) focusResultGrid(owner, tabId, focused)
  }
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() }
    // Enter on a target or on Exact text compares, as it would in a form with one button. The focus moves to Compare first,
    // where a failure is said and from where Escape returns it.
    else if (event.key === 'Enter' && (event.target as Element).matches('input')) { event.preventDefault(); button.current?.focus(); void start() }
  }

  const list = targets.length > 1 || (targets.length === 1 && !sides)
  const reordered = (entry: ResultSetEntry) => { const sort = results.sortOf(tabId, entry.key); return !!sort && (sort.keys.length > 0 || sort.filters.length > 0) }
  const filtered = sides ? [sides.old, sides.neu].filter(reordered) : []
  const left = sides ? [...sides.pairing.oldOnly.map(column => [column, sides.old, sides.neu] as const), ...sides.pairing.newOnly.map(column => [column, sides.neu, sides.old] as const)] : []
  const rows = (entry: ResultSetEntry) => { const stored = entry.handle.getSnapshot().rowsStored; return `${formatCount(stored)} ${stored === 1 ? 'row' : 'rows'}` }
  const side = (entry: ResultSetEntry, old: boolean) => <div className="compare-side" role="group" aria-label={old ? 'Old side' : 'New side'}
    title={old ? 'Old side: its rows that differ show as removed (−)' : 'New side: its rows that differ show as added (+)'}>
    <span className={old ? 'compare-sign removed' : 'compare-sign added'} aria-hidden="true">{old ? '−' : '+'}</span>
    <b {...entrySecondary(entry) ? { title: numberedName(entry) } : {}}>{numberedName(entry)}</b>{!list && <small>{rows(entry)}</small>}
  </div>
  const title = sides ? comparisonName(...comparedNames(sides.old, sides.neu, tab.sets)) : ''

  return <>
    <span ref={home} hidden />
    {host && createPortal(<form ref={card} className="compare-popover" role="dialog" aria-label="Compare" aria-busy={running || undefined} style={place ?? { visibility: 'hidden' }}
      onKeyDown={keyDown} onBlur={leave} onSubmit={event => { event.preventDefault(); void start() }}>
      <div className="compare-head">
        <h2 {...active && entrySecondary(active) ? { title: `Compare ${name}` } : {}}>Compare {name}{targets.length > 0 && <span> with</span>}</h2>
        <button type="button" className="icon-button" aria-label="Close Compare" title="Close (Escape)" onClick={dismiss}><Icon name="close" /></button>
      </div>
      <div className="compare-body">
        {targets.length === 0 && <p className="compare-note">No other result of this run shares a column with {name}.</p>}
        {list && <fieldset className="compare-targets">
          <legend className="visually-hidden">Compare {name} with</legend>
          {targets.map(target => {
            // Columns of either result left out: "2 of 3 columns" counts both results' columns, a pair once.
            const paired = target.pairing.pairs.length, all = paired + target.pairing.oldOnly.length + target.pairing.newOnly.length
            // A named result's number follows its name, so two results of one name are told apart.
            const number = entrySecondary(target.entry)
            return <label key={target.entry.key} className={picker.target === target.entry.key ? 'compare-target picked' : 'compare-target'}>
              <input type="radio" name={ids + 'target'} checked={picker.target === target.entry.key} onChange={() => compare.pick(tabId, target.entry.key)} />
              <span className="compare-target-name" {...number ? { title: `${entryName(target.entry)} · ${number}` } : {}}>{entryName(target.entry)}</span>
              {number && <small className="compare-target-number">{number}</small>}
              {paired < all && <span className="compare-chip" title={`${formatCount(paired)} of ${formatCount(all)} columns pair; the rest are not compared`}>{formatCount(paired)} of {formatCount(all)} columns</span>}
              <small>{rows(target.entry)}</small>
            </label>
          })}
        </fieldset>}
        {sides && <div className="compare-sides">
          {side(sides.old, true)}
          <button type="button" className="icon-button" aria-label="Swap old and new" title="Swap old and new" onClick={() => compare.swap(tabId)}><Icon name="arrow-swap" /></button>
          {side(sides.neu, false)}
        </div>}
        {left.length > 0 && <section className="compare-unpaired" aria-labelledby={ids + 'unpaired'}>
          <h3 id={ids + 'unpaired'}>Not compared <span className="compare-info" title={pairingRule} aria-label={pairingRule} role="img"><Icon name="info" /></span></h3>
          <ul>{left.map(([column, own, other]) => <li key={own.key + ':' + column.index}>
            <code>{nameOf(column)}</code>
            <span>{unpairedWhy(column, own, other, tab.sets)}</span>
          </li>)}</ul>
        </section>}
        {filtered.length > 0 && <p className="compare-note warning"><Icon name="filter" /><span>{filtered.map(entry => distinctName(entry, tab.sets)).join(' and ')} {filtered.length > 1 ? 'are' : 'is'} sorted or filtered here. The comparison uses all the stored rows, in their own order.</span></p>}
        {/* Mounted, and in the accessibility tree, while the popover is, so a failure written into it is read out. */}
        <p className={picker.error ? 'compare-note error' : picker.cancelled ? 'compare-note' : 'visually-hidden'} role="status">{picker.error ?? (picker.cancelled ? 'Comparison cancelled.' : '')}</p>
      </div>
      <div className="compare-foot">
        <label className="compare-exact" title="Case and trailing spaces count"><input type="checkbox" checked={picker.exact} onChange={event => compare.setExact(tabId, event.target.checked)} /> Exact text</label>
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
