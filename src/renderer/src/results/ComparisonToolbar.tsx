import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react'
import type { DiffKindName, DiffLayout } from '../../../shared/contracts'
import Icon from '../Icon'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { observeResize } from '../core/windows'
import { fitFold } from './ResultsToolbar'
import MatchMenu from './MatchMenu'
import { chipKinds, fallbackText, matchLabel, noticeId, type CompareInfo, type CompareSource, type ComparisonNotice, type NoticeAction } from './CompareService'
import { entryName, type EntryKey, type ResultSetEntry } from './ResultsService'
import { formatCount } from './status'

/** The Layout choices: one row per entry, or a changed entry's old and new values on two rows. */
const layouts: readonly { readonly layout: DiffLayout; readonly label: string; readonly title: string }[] = [
  { layout: 'entry', label: 'One row', title: 'One row per entry: a changed value shows its old value struck through, then the new one' },
  { layout: 'unified', label: 'Two rows', title: 'Two rows per changed entry: the old values, then the new ones' }
]
/** The Rows choices (D2): every row, or only the changed, added and removed ones (`context` -1 and 0). */
const rowChoices: readonly { readonly context: number; readonly label: string; readonly title: string }[] = [
  { context: -1, label: 'All rows', title: 'All rows: unchanged rows stay in the comparison, uncoloured' },
  { context: 0, label: 'Changes only', title: 'Changes only: only changed, added and removed rows, with a dashed rule where unchanged rows were left out' }
]
const chipSigns: Readonly<Record<Exclude<DiffKindName, 'same'>, string>> = { added: '+', removed: '−', changed: '~' }

/**
 * How the comparison toolbar gives way in a narrow pane, in order (plan: Narrow panes): the chips shrink to their sign and
 * count, then Exact text, Layout, Rows, Match, the sides, Profile and Save fold away; each is in ⋯ More results tools
 * (Exact Text, One Row per Entry, Changes Only, Match Rows By…, Swap Sides, Go to Old Result, Go to New Result, Column
 * Profile, Save Results As…). The title and the chips never fold.
 */
export const comparisonFolds = ['chips', 'exact', 'layout', 'rows', 'match', 'sides', 'profile', 'save'] as const
type FoldGroup = typeof comparisonFolds[number]

/**
 * A comparison's toolbar, above its grid: its title, its sides (each a link to that input, ⇄ swapping them), Match, Rows,
 * Layout and Exact text, the chips that filter by kind, Profile and Save; under it, its notices. Each control that runs
 * the comparison again replaces it in place (CompareService.replace); while an input is closed they are unavailable and
 * say why (D10), as are the notices' buttons. A polite live region reads what each new or changed comparison found.
 */
export default function ComparisonToolbar({ tabId, entry, info, sources, goTo }: {
  readonly tabId: string
  readonly entry: ResultSetEntry
  readonly info: CompareInfo
  readonly sources: readonly CompareSource[] | undefined
  goTo(key: EntryKey): void
}) {
  const { compare, results, commands, settings } = useWorkbench()
  const announcement = useSyncExternalStore(compare.subscribe, () => compare.getSnapshot().announcements.get(entry.key))
  // While a change runs, the controls show what it asks for, and the next change builds on it.
  const pending = useSyncExternalStore(compare.subscribe, () => compare.pendingChange(tabId, entry.key))
  const state = pending ?? info
  const menu = useSyncExternalStore(compare.subscribe, () => { const open = compare.getSnapshot().matchMenu; return open?.tabId === tabId && open.key === entry.key ? open.from : undefined })
  // Read as strings, so the toolbar renders again only when they change.
  const pressed = useSyncExternalStore(results.subscribe, () => compare.pressedKinds(tabId, entry.key).join(',')).split(',').filter(Boolean)
  const noticeKey = useSyncExternalStore(compare.subscribe, () => { const { notices, refused, dismissed } = compare.getSnapshot(); return `${notices.get(entry.key) ?? ''}|${refused.has(entry.key)}|${[...dismissed.get(entry.key) ?? []].join('|')}` })
  const profile = !!useServiceSnapshot(settings).values['queryResults.grid.columnProfile']
  const ref = useRef<HTMLDivElement>(null), head = useRef<HTMLDivElement>(null)
  const closed = sources?.find(source => source.entry === undefined)
  // Why the controls that re-run are unavailable: an input closed (D10).
  const reason = closed ? `${closed.name} is closed` : undefined
  // A swap onto the pair the run has the other way round shows that comparison: the focus goes to it.
  const change = (o: Parameters<typeof compare.replace>[2]) => {
    if (reason) return
    void compare.replace(tabId, entry.key, o).then(outcome => { if (outcome && 'key' in outcome && outcome.key !== entry.key) goTo(outcome.key) })
  }
  useToolbarHandoff(head, tabId, entry.key)
  useComparisonFold(ref)
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const items = toolbarButtons(event.currentTarget), at = items.indexOf(event.target as HTMLButtonElement)
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
  // The first control is the toolbar's Tab stop; with the old side closed, Swap is (a fold moves it to the first shown).
  const swapStop = sources?.[0]?.entry === undefined
  const unavailable = (title: string) => reason ? { 'aria-disabled': true, title: `${title}: unavailable because ${reason}` } : { title }
  // The same sentence twice is read out twice: a live region reads a change of its text, so each announcement alternates a
  // trailing no-break space.
  const spoken = useLiveText(announcement, at => compare.speak(entry.key, at))
  const label = matchLabel(pending ? { ...pending.asked ? { asked: pending.asked } : {}, match: { columns: pending.match.columns } } : info)
  const matchButton = useRef<HTMLButtonElement>(null)
  // The match menu is drawn beside Match, or beside ⋯ when it opened there or Match has folded away.
  const anchor = useCallback(() => {
    const button = matchButton.current
    if (menu !== 'more' && button && button.getClientRects().length > 0) return button
    return ref.current?.closest('[data-pane]')?.querySelector<HTMLElement>('.results-more') ?? button
  }, [menu])
  // Opened from a notice, the focus goes back to that notice's button while it is there.
  const opener = useRef<HTMLElement | null>(null)
  const focusBack = useCallback(() => menu === 'notice' && opener.current?.isConnected ? opener.current : anchor(), [menu, anchor])
  const closeMenu = useCallback(() => compare.closeMatchMenu(), [compare])
  const rows = state.context === 0 ? 0 : -1
  const chip = (kind: Exclude<DiffKindName, 'same'>) => {
    const count = info[kind], on = pressed.includes(kind), off = count === 0 && !on
    const name = `${formatCount(count)} ${kind}`
    return <button key={kind} type="button" className={`rg-compare-chip is-${kind}`} data-control={`chip-${kind}`} data-fold-group="chips" tabIndex={-1} aria-pressed={on} aria-label={name}
      {...off ? { 'aria-disabled': true, title: `No ${kind} rows` } : { title: on ? `Showing ${kind} rows: press again to stop` : `Show only ${kind} rows (with the other kinds pressed)` }}
      onClick={() => { if (!off) compare.toggleKind(tabId, entry.key, kind) }}>
      <span className="rg-compare-chip-sign" aria-hidden="true">{chipSigns[kind]}</span><span aria-hidden="true">{formatCount(count)}</span><span className="rg-compare-chip-word" aria-hidden="true"> {kind}</span>
    </button>
  }
  const focusGrid = () => results.focusEntry(tabId, entry.key)
  // One element around the toolbar and its notices (display: contents), so a change that remounts both hands the focus
  // from either to its new copy.
  return <div ref={head} className="rg-compare-head" data-notices={noticeKey}>
    <div ref={ref} className="rg-compare-bar" role="toolbar" aria-label="Comparison tools" onKeyDown={keyDown}>
      <span className="rg-compare-title" title={entryName(entry)}><Icon name="git-compare" /><span>Differences</span></span>
      <span className="rg-compare-sides" role="group" aria-label="Sides" data-fold-group="sides">
        {side(sources?.[0], '−', 'old')}
        <button type="button" className="rg-compare-swap" data-control="swap" aria-label="Swap sides" tabIndex={swapStop ? 0 : -1}
          {...unavailable('Swap sides: compare the new side against the old one')} onClick={() => change({ swap: true })}><Icon name="arrow-swap" /></button>
        {side(sources?.[1], '+', 'new')}
      </span>
      <button ref={matchButton} type="button" className="rg-compare-match" data-control="match" data-fold-group="match" tabIndex={-1} aria-haspopup="dialog" aria-expanded={!!menu} aria-label={label.key ? label.name : `Match rows: ${label.text}`}
        {...unavailable(`${label.name}. Choose how rows are paired`)} onClick={() => { if (reason) return; if (menu) compare.closeMatchMenu(); else compare.openMatchMenu(tabId, entry.key, 'toolbar') }}>
        <span className={label.key ? 'rg-compare-key' : undefined}>{label.text}</span><Icon name="chevron-down" />
      </button>
      <div className="results-segments rg-compare-rows" role="group" aria-label="Rows" data-fold-group="rows">
        {rowChoices.map(choice => <button key={choice.context} type="button" data-control={`rows-${choice.context}`} tabIndex={-1} aria-pressed={rows === choice.context} {...unavailable(choice.title)}
          onClick={() => { if (rows !== choice.context) change({ context: choice.context }) }}>{choice.label}</button>)}
      </div>
      <div className="results-segments rg-compare-layout" role="group" aria-label="Layout" data-fold-group="layout">
        {layouts.map(choice => {
          const blocked = state.fallback && choice.layout === 'entry'
          const props = blocked ? { 'aria-disabled': true, title: fallbackText } : unavailable(choice.title)
          return <button key={choice.layout} type="button" data-control={`layout-${choice.layout}`} tabIndex={-1} aria-pressed={state.layout === choice.layout} {...props}
            onClick={() => { if (!blocked && state.layout !== choice.layout) change({ layout: choice.layout }) }}>{choice.label}</button>
        })}
      </div>
      <button type="button" className="results-icon-toggle rg-compare-exact" data-control="exact" data-fold-group="exact" aria-pressed={state.exact} tabIndex={-1}
        {...unavailable(state.exact ? 'Exact text: on. Values that differ only by case or trailing spaces count as changed' : 'Exact text: off. Values equal by collation (case, trailing spaces) count as the same')}
        onClick={() => change({ exact: !state.exact })}><Icon name="case-sensitive" /><span>Exact text</span></button>
      <span className="rg-compare-chips" role="group" aria-label="Show rows">
        {chipKinds.map(chip)}
        <span className="rg-compare-count" title={info.context === 0 ? 'Unchanged rows: left out by Changes only' : 'Unchanged rows'}>{formatCount(info.same)} unchanged{info.context === 0 && info.same > 0 ? ' (hidden)' : ''}</span>
        {info.repeated > 0 && <span className="rg-compare-count is-repeated" title="Rows whose key repeats were paired in order (≈ in their row headers)"><span aria-hidden="true">≈ </span>{formatCount(info.repeated)} repeated</span>}
      </span>
      <span className="rg-compare-gap" />
      <button type="button" className="results-icon-toggle" data-control="profile" data-fold-group="profile" aria-label="Profile" aria-pressed={profile} tabIndex={-1} title="Column profile of this comparison: each column's changes"
        onClick={() => { focusGrid(); void commands.execute('output.toggleColumnProfile', undefined, 'toolbar') }}><Icon name="graph" /></button>
      <button type="button" className="results-icon-toggle" data-control="save" data-fold-group="save" aria-label="Save Results As" tabIndex={-1} title="Save Results As: the comparison, with its change markers and input row numbers"
        onClick={event => { focusGrid(); void commands.execute('output.saveResultsAs', { target: { kind: 'output', tabId, view: 'grid', entry: entry.key, selectedText: '', element: event.currentTarget } }, 'toolbar') }}><Icon name="save-as" /></button>
      <span className="visually-hidden" role="status" aria-live="polite">{spoken}</span>
    </div>
    <NoticeStrip tabId={tabId} entryKey={entry.key} info={info} reason={reason} change={change} toolbar={ref} opener={opener} />
    {menu && !reason && <MatchMenu tabId={tabId} entryKey={entry.key} state={pending ?? info} anchor={anchor} focusBack={focusBack} onClose={closeMenu} />}
  </div>
}

/** A notice button's words, in sentence case. */
const actionLabels: Readonly<Record<NoticeAction, string>> = { changesOnly: 'Show changes only', chooseKeys: 'Choose key columns…', byPosition: 'Match by row position' }

/**
 * A comparison's notices, under its toolbar (plan: Toolbar and notices): one line each, plain text in the information or
 * warning colour, with its buttons (unavailable with the reason while an input is closed, D10) and a Dismiss button, so
 * each is dismissible by keyboard. A dismissed notice stays hidden while its kind and text are unchanged.
 */
function NoticeStrip({ tabId, entryKey, info, reason, change, toolbar, opener }: {
  readonly tabId: string; readonly entryKey: EntryKey; readonly info: CompareInfo; readonly reason: string | undefined
  change(o: Parameters<ReturnType<typeof useWorkbench>['compare']['replace']>[2]): void
  readonly toolbar: RefObject<HTMLDivElement | null>
  readonly opener: RefObject<HTMLElement | null>
}) {
  const { compare } = useWorkbench()
  const strip = useRef<HTMLDivElement>(null), dismissed = useRef<number | undefined>(undefined)
  const notices = compare.visibleNotices(entryKey, info)
  // A dismissed notice's button goes with it: the focus moves to the notice that takes its place, else the one before,
  // else the toolbar's Tab stop.
  useLayoutEffect(() => {
    const at = dismissed.current
    if (at === undefined) return
    dismissed.current = undefined
    const buttons = [...strip.current?.querySelectorAll<HTMLButtonElement>('.rg-compare-notice-dismiss') ?? []]
    const next = buttons[Math.min(at, buttons.length - 1)] ?? toolbar.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')
    next?.focus({ preventScroll: true })
  })
  if (notices.length === 0) return null
  const act = (action: NoticeAction, button: HTMLElement) => {
    if (reason) return
    // Show changes only asks the refused change again with Changes only (a refused first run is the popover's).
    if (action === 'changesOnly') change(compare.refusedChange(entryKey) ?? { context: 0 })
    else if (action === 'byPosition') change({ match: { mode: 'position' } })
    else { opener.current = button; compare.openMatchMenu(tabId, entryKey, 'notice') }
  }
  return <div ref={strip} className="rg-compare-notices" role="group" aria-label="Comparison notices">
    {notices.map((notice: ComparisonNotice, index) => <div key={noticeId(notice)} className={`rg-compare-notice is-${notice.tone}`} data-notice={notice.kind}>
      <Icon name={notice.tone === 'warning' ? 'warning' : 'info'} />
      <span className="rg-compare-notice-text" title={notice.text}>{notice.text}</span>
      {notice.actions?.map(action => <button key={action} type="button" className="rg-compare-notice-action" data-action={action} data-control={`notice-${action}`}
        {...reason ? { 'aria-disabled': true, title: `${actionLabels[action]}: unavailable because ${reason}` } : {}} onClick={event => act(action, event.currentTarget)}>{actionLabels[action]}</button>)}
      <button type="button" className="icon-button rg-compare-notice-dismiss" aria-label="Dismiss notice" title="Dismiss" onClick={event => { if (strip.current?.contains(event.currentTarget.ownerDocument.activeElement)) dismissed.current = index; compare.dismiss(entryKey, notice) }}><Icon name="close" /></button>
    </div>)}
  </div>
}

/** The toolbar's buttons that show: none of a folded group's. */
function toolbarButtons(element: HTMLElement): HTMLButtonElement[] {
  const folded = new Set((element.dataset.fold ?? '').split(' ').filter(word => word && word !== 'chips'))
  return [...element.querySelectorAll<HTMLButtonElement>('button')].filter(button => !folded.has(button.closest<HTMLElement>('[data-fold-group]')?.dataset.foldGroup as FoldGroup))
}

/**
 * Folds the toolbar to its width (`comparisonFolds`, as the results toolbar does) whenever it or its groups change size,
 * and keeps its one Tab stop on its first button that shows (a fold can take the one it had). Written to the element, so a
 * fold never renders the toolbar again.
 */
function useComparisonFold(ref: RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const fit = () => {
      const fold = fitFold(trial => { element.dataset.fold = comparisonFolds.slice(0, trial).join(' '); return element.scrollWidth > element.clientWidth + 0.5 }, comparisonFolds.length)
      element.dataset.fold = comparisonFolds.slice(0, fold).join(' ')
      const shown = toolbarButtons(element), focused = element.ownerDocument.activeElement
      const stop = shown.find(button => button.tabIndex === 0) ?? shown[0]
      for (const button of element.querySelectorAll<HTMLButtonElement>('button')) button.tabIndex = button === stop ? 0 : -1
      // A folded control that had the focus hands it to the Tab stop rather than the page.
      if (focused instanceof HTMLElement && element.contains(focused) && !shown.includes(focused as HTMLButtonElement)) stop?.focus({ preventScroll: true })
    }
    fit()
    const watched = observeResize([element, ...element.children], fit)
    const view = element.ownerDocument.defaultView
    const added = view ? new view.MutationObserver(fit) : undefined
    added?.observe(element, { childList: true, subtree: true, attributeFilter: ['aria-pressed'] })
    return () => { added?.disconnect(); watched.dispose() }
  }, [])
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
      // The same control, else (a notice the new comparison does not show) the toolbar's Tab stop.
      const target = element.querySelector<HTMLElement>(`[data-control="${CSS.escape(mark.control)}"]`) ?? element.querySelector<HTMLElement>('[role="toolbar"] button[tabindex="0"]')
      target?.focus({ preventScroll: true })
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
