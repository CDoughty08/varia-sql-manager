import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { DiffMatch } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { useWorkbench } from '../core/WorkbenchContext'
import { windows } from '../core/windows'
import { sqlTypeLabel } from '../grid/measure'
import { trapFocus } from '../trap-focus'
import { placePopover } from './ComparePopover'
import type { ChangeBase } from './CompareService'
import type { EntryKey } from './ResultsService'

type Mode = DiffMatch['mode']
/** The match modes, in the menu's order (D3). */
const modes: readonly { readonly mode: Mode; readonly label: string; readonly hint: string }[] = [
  { mode: 'auto', label: 'Automatic', hint: 'a column unique in both, else whole rows' },
  { mode: 'position', label: 'Row position', hint: '1st with 1st, 2nd with 2nd' },
  { mode: 'rows', label: 'Whole rows', hint: 'every compared column equal' },
  { mode: 'columns', label: 'Key columns', hint: 'the columns ticked below' }
]
const width = 300
/** How many match menus each comparison has mounted. */
const mounted = new Map<EntryKey, number>()

/** The pair indexes a state's key columns are at: those asked for, else Automatic's chosen column, found by name. */
function startingKeys(state: ChangeBase & { readonly match: { readonly mode?: string } }, names: readonly string[]): readonly number[] {
  if (state.asked?.mode === 'columns') return state.asked.columns
  if (state.match.mode !== 'auto') return []
  const lower = names.map(name => name.toLowerCase())
  return state.match.columns.flatMap(name => { const at = lower.indexOf(name.toLowerCase()); return at < 0 ? [] : [at] })
}

/**
 * A comparison's match menu (D3): a radio group of the match modes, and a searchable checklist of its paired columns with
 * their types, enabled under Key columns, where a column past the 16th is unavailable; Apply changes the comparison in
 * place (CompareService.replace) and is unavailable while Key columns has none ticked. It follows the filter menu's focus
 * pattern: the checklist is one Tab stop whose active row the arrows move (aria-activedescendant), Space ticks it, and
 * Enter applies.
 * Drawn in its grid's window (a popout's too) beside the toolbar's Match button, or beside ⋯ when it folded away there.
 * Escape and Cancel close it and give the focus back to what opened it; a press outside closes it.
 */
export default function MatchMenu({ tabId, entryKey, state, anchor, onClose }: {
  readonly tabId: string
  readonly entryKey: EntryKey
  readonly state: ChangeBase & { readonly match: { readonly mode?: string } }
  /** What it is drawn beside, and what takes the focus back when it closes. */
  readonly anchor: () => HTMLElement | null
  onClose(): void
}) {
  const { compare } = useWorkbench()
  const ids = useId()
  const pairs = useMemo(() => compare.pairsOf(tabId, entryKey), [compare, tabId, entryKey])
  const [mode, setMode] = useState<Mode>(state.asked?.mode ?? 'auto')
  const [keys, setKeys] = useState<readonly number[]>(() => startingKeys(state, pairs.map(pair => pair.name)))
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)
  const home = useRef<HTMLSpanElement>(null), card = useRef<HTMLFormElement>(null), list = useRef<HTMLDivElement>(null)
  const [host, setHost] = useState<HTMLElement | undefined>()
  const [place, setPlace] = useState<CSSProperties | undefined>()
  useLayoutEffect(() => { setHost(home.current?.ownerDocument.body) }, [])
  const shown = useMemo(() => {
    const words = search.trim().toLowerCase()
    return pairs.flatMap((pair, index) => !words || pair.name.toLowerCase().includes(words) ? [index] : [])
  }, [pairs, search])
  const columns = mode === 'columns', full = keys.length >= wire.diff.maxKeyColumns
  const at = Math.min(active, Math.max(0, shown.length - 1))

  // Placed under its anchor, clamped to the window, measured after every render (its content changes its height).
  useLayoutEffect(() => {
    const element = home.current, form = card.current, target = anchor()
    if (!element || !form || !host) return
    const view = element.ownerDocument.defaultView ?? window, rect = (target ?? element).getBoundingClientRect()
    const next: CSSProperties = { ...placePopover({ anchor: rect, trigger: true, width: view.innerWidth, height: view.innerHeight, cardWidth: Math.min(width, view.innerWidth - 16), wanted: form.scrollHeight }) }
    setPlace(current => current && JSON.stringify(current) === JSON.stringify(next) ? current : next)
  })
  // The focus goes in once it is placed: to the chosen mode.
  const placed = !!place
  useLayoutEffect(() => {
    if (!placed) return
    const doc = card.current?.ownerDocument
    if (doc && !doc.hasFocus()) doc.defaultView?.focus()
    card.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus({ preventScroll: true })
  }, [placed])
  // A press outside, the window losing the focus, or its pane moving to another window closes it.
  useEffect(() => {
    const element = home.current
    if (!element || !host) return
    const doc = element.ownerDocument, view = doc.defaultView
    // A press on Match itself is left to its click, which closes the menu (closed here, the click would open it again).
    const press = (event: PointerEvent) => { const target = event.target as Element; if (!card.current?.contains(target) && !target.closest?.('.rg-compare-match')) onClose() }
    const blur = () => onClose()
    const adoption = windows.onDidAdopt(() => { if (home.current?.ownerDocument.body !== host) onClose() })
    doc.addEventListener('pointerdown', press, true)
    view?.addEventListener('blur', blur)
    return () => { doc.removeEventListener('pointerdown', press, true); view?.removeEventListener('blur', blur); adoption.dispose() }
  }, [host, onClose])
  // Unmounted while still open (its pane hidden, its grid unmounted), it closes, so it never shows again unasked later.
  // A remount in the same task (StrictMode, a popout's adoption) keeps it.
  useEffect(() => {
    mounted.set(entryKey, (mounted.get(entryKey) ?? 0) + 1)
    return () => {
      const left = (mounted.get(entryKey) ?? 1) - 1
      if (left > 0) mounted.set(entryKey, left)
      else mounted.delete(entryKey)
      queueMicrotask(() => { if (!mounted.get(entryKey) && compare.getSnapshot().matchMenu?.key === entryKey) compare.closeMatchMenu() })
    }
  }, [compare, entryKey])
  // The active row stays in view.
  useLayoutEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${shown[at] ?? -1}"]`)?.scrollIntoView?.({ block: 'nearest' }) }, [at, shown])

  const toggle = (index: number) => {
    if (!columns) return
    if (keys.includes(index)) setKeys(keys.filter(key => key !== index))
    else if (!full) setKeys([...keys, index])
  }
  const dismiss = () => {
    const target = anchor()
    onClose()
    target?.focus()
  }
  const apply = () => {
    if (columns && keys.length === 0) return
    const match: DiffMatch = columns ? { mode: 'columns', columns: [...keys] } : { mode }
    const now = state.asked ?? { mode: 'auto' as const }
    const target = anchor()
    onClose()
    target?.focus()
    if (JSON.stringify(now) !== JSON.stringify(match)) void compare.replace(tabId, entryKey, { match })
  }
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() }
  }
  const listKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 : undefined
    if (to !== undefined) { event.preventDefault(); setActive(Math.max(0, Math.min(shown.length - 1, to))) }
    else if (event.key === ' ' && shown[at] !== undefined) { event.preventDefault(); toggle(shown[at]) }
    // Enter applies, as it does from the modes and the search (a list is not a field, so the form does not submit itself).
    else if (event.key === 'Enter') { event.preventDefault(); apply() }
  }
  const optionId = (index: number) => `${ids}-key-${index}`

  return <>
    <span ref={home} hidden />
    {host && createPortal(<form ref={card} className="compare-popover compare-match" role="dialog" aria-label="Match rows by" style={place ?? { visibility: 'hidden' }}
      onKeyDown={keyDown} onSubmit={event => { event.preventDefault(); apply() }}>
      <div className="compare-body">
        <fieldset className="compare-match-modes">
          <legend>Match rows by</legend>
          {modes.map(choice => <label key={choice.mode} className="compare-target">
            <input type="radio" name={ids + 'mode'} checked={mode === choice.mode} onChange={() => setMode(choice.mode)} />
            <span className="compare-target-name">{choice.label}</span><small>{choice.hint}</small>
          </label>)}
        </fieldset>
        <div className="compare-match-search">
          <input type="search" aria-label="Search key columns" placeholder="Search columns" value={search} maxLength={wire.search.maxText} disabled={!columns}
            onChange={event => { setSearch(event.target.value); setActive(0) }} />
        </div>
        <div ref={list} className="compare-match-list" role="listbox" aria-multiselectable="true" aria-label="Key columns" aria-disabled={!columns || undefined}
          tabIndex={columns && shown.length > 0 ? 0 : -1} aria-activedescendant={columns && shown[at] !== undefined ? optionId(shown[at]) : undefined} onKeyDown={listKeys}>
          {shown.map((index, row) => {
            const ticked = keys.includes(index), blocked = !columns || (full && !ticked), pair = pairs[index]
            return <div key={index} id={optionId(index)} data-index={index} role="option" aria-checked={ticked} aria-selected={row === at} aria-disabled={blocked || undefined}
              className={'compare-match-item' + (row === at && columns ? ' active' : '') + (blocked ? ' disabled' : '')} title={columns && full && !ticked ? `At most ${wire.diff.maxKeyColumns} key columns` : undefined}
              onPointerDown={event => event.preventDefault()} onClick={() => { setActive(row); toggle(index); list.current?.focus() }}>
              <input type="checkbox" tabIndex={-1} aria-hidden="true" checked={ticked} disabled={blocked} readOnly />
              <span className="compare-target-name">{pair.name || '(No column name)'}</span><small>{sqlTypeLabel(pair.column)}</small>
            </div>
          })}
          {shown.length === 0 && <p className="compare-note">No column matches.</p>}
        </div>
        <p className="compare-note">NULL matches NULL. {columns && keys.length > 1 ? `A row matches when all ${keys.length} columns are equal.` : 'Tick several columns for a composite key.'}</p>
      </div>
      <div className="compare-foot">
        <span className="compare-gap" />
        <button type="button" onClick={dismiss}>Cancel</button>
        <button type="submit" className="primary" disabled={columns && keys.length === 0} title={columns && keys.length === 0 ? 'Tick at least one key column' : undefined}>Apply</button>
      </div>
    </form>, host)}
  </>
}
