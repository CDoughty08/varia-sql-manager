import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react'
import type { DiffLayout } from '../../../shared/contracts'
import Icon from '../Icon'
import { useWorkbench } from '../core/WorkbenchContext'
import { fallbackText, type CompareInfo, type CompareSource } from './CompareService'
import { entryName, type EntryKey, type ResultSetEntry } from './ResultsService'

/** The Layout choices: one row per entry, or a changed entry's old and new values on two rows. */
const layouts: readonly { readonly layout: DiffLayout; readonly label: string; readonly title: string }[] = [
  { layout: 'entry', label: 'One row', title: 'One row per entry: a changed value shows its old value struck through, then the new one' },
  { layout: 'unified', label: 'Two rows', title: 'Two rows per changed entry: the old values, then the new ones' }
]

/**
 * A comparison's toolbar, above its grid: its title, its sides (each a link to that input, ⇄ swapping them), Layout and
 * Exact text. Each control that runs the comparison again replaces it in place (CompareService.replace); while an input
 * is closed they are unavailable and say why (D10). A polite live region reads what each new or changed comparison found.
 */
export default function ComparisonToolbar({ tabId, entry, info, sources, goTo }: {
  readonly tabId: string
  readonly entry: ResultSetEntry
  readonly info: CompareInfo
  readonly sources: readonly CompareSource[] | undefined
  goTo(key: EntryKey): void
}) {
  const { compare } = useWorkbench()
  const announcement = useSyncExternalStore(compare.subscribe, () => compare.getSnapshot().announcements.get(entry.key))
  // While a change runs, the controls show what it asks for, and the next change builds on it.
  const state = useSyncExternalStore(compare.subscribe, () => compare.pendingChange(tabId, entry.key)) ?? info
  const ref = useRef<HTMLDivElement>(null)
  const closed = sources?.find(source => source.entry === undefined)
  // Why the controls that re-run are unavailable: an input closed (D10).
  const reason = closed ? `${closed.name} is closed` : undefined
  // A swap onto the pair the run has the other way round shows that comparison: the focus goes to it.
  const change = (o: Parameters<typeof compare.replace>[2]) => {
    if (reason) return
    void compare.replace(tabId, entry.key, o).then(outcome => { if (outcome && 'key' in outcome && outcome.key !== entry.key) goTo(outcome.key) })
  }
  useToolbarHandoff(ref, tabId, entry.key)
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')], at = items.indexOf(event.target as HTMLButtonElement)
    if (at < 0) return
    const next = event.key === 'ArrowRight' ? (at + 1) % items.length : event.key === 'ArrowLeft' ? (at + items.length - 1) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    items[next].focus()
  }
  const side = (source: CompareSource | undefined, sign: string, control: string) => source === undefined ? null
    : source.entry === undefined
      ? <span className="rg-compare-side is-closed" title={`${source.name} was closed after it was compared`}><span aria-hidden="true">{sign} </span>{source.name} (closed)</span>
      : <button type="button" className="rg-compare-side" data-control={control} tabIndex={control === 'old' ? 0 : -1} title={`Go to ${source.name}`} onClick={() => goTo(source.entry!)}>
        <span aria-hidden="true">{sign} </span>{source.name}</button>
  // The first control is the toolbar's Tab stop; with the old side closed, Swap is.
  const swapStop = sources?.[0]?.entry === undefined
  const unavailable = (title: string) => reason ? { 'aria-disabled': true, title: `${title}: unavailable because ${reason}` } : { title }
  // The same sentence twice is read out twice: a live region reads a change of its text, so each announcement alternates a
  // trailing no-break space.
  const spoken = useLiveText(announcement, at => compare.speak(entry.key, at))
  return <div ref={ref} className="rg-compare-bar" role="toolbar" aria-label="Comparison tools" onKeyDown={keyDown}>
    <span className="rg-compare-title" title={entryName(entry)}><Icon name="git-compare" /><span>Differences</span></span>
    <span className="rg-compare-sides" role="group" aria-label="Sides">
      {side(sources?.[0], '−', 'old')}
      <button type="button" className="rg-compare-swap" data-control="swap" aria-label="Swap sides" tabIndex={swapStop ? 0 : -1}
        {...unavailable('Swap sides: compare the new side against the old one')} onClick={() => change({ swap: true })}><Icon name="arrow-swap" /></button>
      {side(sources?.[1], '+', 'new')}
    </span>
    <div className="results-segments rg-compare-layout" role="group" aria-label="Layout">
      {layouts.map(choice => {
        const blocked = state.fallback && choice.layout === 'entry'
        const props = blocked ? { 'aria-disabled': true, title: fallbackText } : unavailable(choice.title)
        return <button key={choice.layout} type="button" data-control={`layout-${choice.layout}`} tabIndex={-1} aria-pressed={state.layout === choice.layout} {...props}
          onClick={() => { if (!blocked && state.layout !== choice.layout) change({ layout: choice.layout }) }}>{choice.label}</button>
      })}
    </div>
    <button type="button" className="results-icon-toggle rg-compare-exact" data-control="exact" aria-pressed={state.exact} tabIndex={-1}
      {...unavailable(state.exact ? 'Exact text: on. Values that differ only by case or trailing spaces count as changed' : 'Exact text: off. Values equal by collation (case, trailing spaces) count as the same')}
      onClick={() => change({ exact: !state.exact })}><Icon name="case-sensitive" /><span>Exact text</span></button>
    <span className="visually-hidden" role="status" aria-live="polite">{spoken}</span>
  </div>
}

/**
 * A comparison's live region text: empty on its first render, then each announcement not yet said. A change remounts the
 * toolbar (it is keyed by the result it shows), and a region inserted with its sentence already in it is not read out;
 * mounted empty, the sentence that follows is a change screen readers announce. A remount without a new announcement
 * (another tab shown and back, a popout) says nothing. The same sentence twice is read twice: each alternates a trailing
 * no-break space, so the region's text changes.
 */
export function useLiveText(announcement: { readonly text: string; readonly at: number } | undefined, speak: (at: number) => boolean): string {
  const [shown, setShown] = useState('')
  useEffect(() => {
    if (announcement && speak(announcement.at)) setShown(announcement.text + (announcement.at % 2 ? ' ' : ''))
    // Only a new announcement is offered: `speak` is a fresh function each render.
  }, [announcement])
  return shown
}

/**
 * A change replaces the comparison, and with it the grid and this toolbar (they are keyed by the result they show), so a
 * control that had the focus would drop it to the page: the new toolbar gives it to its own control of the same name.
 */
function useToolbarHandoff(ref: RefObject<HTMLDivElement | null>, tabId: string, key: EntryKey): void {
  useLayoutEffect(() => {
    const element = ref.current, owner = element?.ownerDocument
    if (!element || !owner) return
    const mark = handoff, active = owner.activeElement
    if (mark?.owner === owner && mark.tabId === tabId && mark.key === key && (!active || active === owner.body)) {
      element.querySelector<HTMLElement>(`[data-control="${CSS.escape(mark.control)}"]`)?.focus({ preventScroll: true })
    }
    return () => {
      const focused = owner.activeElement
      const control = focused instanceof HTMLElement && element.contains(focused) ? focused.getAttribute('data-control') : null
      if (!control) return
      const next = { owner, tabId, key, control }
      handoff = next
      queueMicrotask(() => { if (handoff === next) handoff = undefined })
    }
  }, [tabId, key])
}
let handoff: { readonly owner: Document; readonly tabId: string; readonly key: EntryKey; readonly control: string } | undefined
