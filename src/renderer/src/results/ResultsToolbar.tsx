import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { CommandId } from '../../../shared/commands/catalog'
import type { ViewSortMode } from '../../../shared/contracts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { useCommandEnabled } from '../core/useCommand'
import { observeResize, windows } from '../core/windows'
import { useMenuTarget } from '../menus/useMenuTarget'
import { columnTitle } from '../grid/selection'
import type { WhitespaceMode } from '../grid/whitespace'
import Icon from '../Icon'
import { entryOf, isSummaryActive } from './ResultsService'
import { searchBoxKeyAction, searchCount, skippedText, type SearchMode } from './search'
import { formatCount } from './status'

interface Choice<T> { readonly mode: T; readonly label: string; readonly hint: string; readonly title: string; readonly command?: CommandId }

/** The White space choices, each the command that turns it on (and, when it is already on, off). */
const whitespaceChoices: readonly Choice<WhitespaceMode>[] = [
  { mode: 'none', label: 'Off', hint: 'Default', title: 'Show values as they are' },
  { mode: 'spaces', label: 'Spaces', hint: 'Show spaces & tabs', title: 'Show spaces (·) and tabs (→)', command: 'output.showSpaces' },
  { mode: 'all', label: 'All', hint: 'Also CR, LF, NBSP…', title: 'Also name line breaks (CR, LF) and invisible spaces (NBSP, ZWSP, BOM…)', command: 'output.showAllWhitespace' }
]
/** How sorted grids order text columns (queryResults.grid.sortText), the same way. */
const sortTextChoices: readonly Choice<ViewSortMode>[] = [
  { mode: 'value', label: 'Value', hint: 'Collation order (default)', title: 'Sort text as ORDER BY would, by the column\'s collation' },
  { mode: 'chars', label: 'Chars', hint: 'Character length', title: 'Sort text by its length in characters, spaces included', command: 'output.sortTextByChars' },
  { mode: 'bytes', label: 'Bytes', hint: 'Byte length (DATALENGTH)', title: 'Sort text and binary values by their length in bytes (DATALENGTH)', command: 'output.sortTextByBytes' }
]

/** What the search box searches: cell values (in the backend) or column names. */
const searchModes: readonly { readonly mode: SearchMode; readonly label: string; readonly title: string; readonly icon: 'list-flat' | 'symbol-field' }[] = [
  { mode: 'values', label: 'Data', title: 'Data: search cell values, comparing text by each column collation', icon: 'list-flat' },
  { mode: 'columns', label: 'Columns', title: 'Columns: search column names only', icon: 'symbol-field' }
]

/**
 * The search box: its text searches every grid of the run (ResultsSearchService), Enter and Shift+Enter step through the
 * matches, Escape clears it and, in an empty box, returns to the grid. It is its own Tab stop, so Left and Right stay with
 * its text.
 */
function ResultsSearchBox({ tabId, disabled = false }: { tabId: string; disabled?: boolean }) {
  const { resultsSearch } = useWorkbench()
  const search = useServiceSnapshot(resultsSearch)[tabId] ?? resultsSearch.of(tabId)
  const inputRef = useRef<HTMLInputElement>(null)
  const focus = search.focus
  // Find in Results (Ctrl+F in a grid) puts the focus here with the text selected, so typing replaces it; once, even when
  // the box is shown only after it (the Messages view), and not again each time the box is shown.
  useEffect(() => {
    if (!resultsSearch.takeFocus(tabId) || disabled) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focus, resultsSearch, tabId])
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return
    const action = searchBoxKeyAction(event.nativeEvent, !!search.text)
    if (!action) return
    event.preventDefault()
    if (action === 'next' || action === 'previous') { resultsSearch.step(tabId, action === 'next' ? 1 : -1); return }
    event.stopPropagation()
    if (action === 'clear') { resultsSearch.clear(tabId); return }
    // Escape in an empty box goes back to the grid that last had the focus (the one F6 focuses), in the box's own window
    // (a popped-out Results panel has its own document).
    const grids = [...event.currentTarget.ownerDocument.querySelectorAll<HTMLElement>(`[data-result-grid][data-tab-id="${CSS.escape(tabId)}"]`)]
    ;(grids.find(grid => grid.dataset.paneFocus === 'selected') ?? grids[0])?.focus()
  }
  const count = searchCount(search, formatCount)
  const columns = search.mode === 'columns'
  const placeholder = columns ? 'Search column names' : 'Search all results'
  return <div className="results-search" data-mode={search.mode} data-disabled={disabled || undefined}>
    <Icon name="search" className="results-search-icon" />
    {/* The field is at least as wide as its placeholder, drawn unseen beside the input (data-placeholder), so the whole
        placeholder shows in every font; the toolbar folds its groups rather than narrow it, until none is left to fold. */}
    <span className="results-search-field" data-placeholder={placeholder}>
      <input ref={inputRef} type="text" spellCheck={false} maxLength={1024} disabled={disabled} aria-label={columns ? 'Search column names' : 'Search results'} placeholder={placeholder}
        value={search.text} title={disabled ? 'Select a result grid to search' : search.approximate ? 'Some long values were searched only as far as they were stored.' : undefined}
        onChange={event => resultsSearch.setText(tabId, event.target.value)} onKeyDown={keyDown} />
    </span>
    {/* The count follows each keystroke and grid; the live region says only the settled count (TabSearch.announcement). */}
    <span className="results-search-count" title={search.error || (search.skipped ? [count, skippedText].filter(Boolean).join('. ') : count) || undefined}>{count}</span>
    <span className="visually-hidden" role="status" aria-live="polite">{search.announcement}</span>
    <button type="button" tabIndex={-1} aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={disabled || search.total === 0} onClick={() => resultsSearch.step(tabId, -1)}><Icon name="arrow-up" /></button>
    <button type="button" tabIndex={-1} aria-label="Next match" title="Next match (Enter)" disabled={disabled || search.total === 0} onClick={() => resultsSearch.step(tabId, 1)}><Icon name="arrow-down" /></button>
    <div className="results-segments" role="group" aria-label="Search in">
      {/* Icons only, as the Show toggles: the toolbar must still fit the output pane of a 1024 px window. */}
      {searchModes.map(choice => <button key={choice.mode} type="button" className="results-icon-toggle" tabIndex={-1} disabled={disabled} aria-label={choice.label} aria-pressed={choice.mode === search.mode} title={choice.title}
        onClick={() => resultsSearch.setMode(tabId, choice.mode)}><Icon name={choice.icon} /></button>)}
    </div>
  </div>
}

/**
 * How the results toolbar gives way in a narrow pane, in order: Tabs goes (it is in the ⋯ menu and the Window menu), the
 * groups tighten (no icons beside them, the search box's magnifier and Previous and Next go: Enter, Shift+Enter and F3 still
 * step), then Transposed, Headers and Compare, then Sort text by, White space, and the Show group. The search field never
 * narrows past its placeholder until every group has folded; only then does it give up width. Search, Close Results
 * and ⋯ (which holds every tool) stay. The toolbar measures its own width, not the window's, so a pane docked beside the
 * editor or popped out into a window of its own folds as a narrow window does, whatever the fonts.
 */
export const toolbarFolds = ['layout', 'tight', 'view', 'sort', 'space', 'show'] as const
/** The least folding at which nothing overflows: `overflows` lays the toolbar out folded that far and says whether its
 *  groups still run past its edge. All of it, when even that does not fit. */
export function fitFold(overflows: (fold: number) => boolean, most: number = toolbarFolds.length): number {
  for (let fold = 0; fold < most; fold++) if (!overflows(fold)) return fold
  return most
}
/** The `data-fold` words for folding that far ('layout tight view'), which styles.css hides and tightens by. */
export const foldWords = (fold: number): string => toolbarFolds.slice(0, fold).join(' ')
/** Whether ⋯ is the toolbar's Tab stop: once folding that far hides White space, whose chosen button is the stop. */
export const moreIsTabStop = (fold: number): boolean => fold > toolbarFolds.indexOf('space')

/** Computes the `.results-more` button's roving `tabIndex`: `0` whenever folding hid White space OR no earlier visible,
 *  enabled toolbar button holds `tabIndex = 0` (preventing zero-tab-stop states on Summary / pure-DDL runs). */
export function resolveMoreTabIndex(toolbar: HTMLElement, fold: number): 0 | -1 {
  if (moreIsTabStop(fold)) return 0
  const more = toolbar.querySelector<HTMLButtonElement>('.results-more')
  const view = toolbar.ownerDocument.defaultView
  for (const button of toolbar.querySelectorAll<HTMLButtonElement>('button')) {
    if (button === more || button.disabled || button.tabIndex !== 0 || button.closest('.results-search')) continue
    const style = view?.getComputedStyle(button)
    if (style && (style.display === 'none' || style.visibility === 'hidden')) continue
    return -1
  }
  return 0
}

/**
 * Folds the toolbar to its width (`fitFold`) whenever it, one of its groups, its head or what shares the head changes size: the pane resized,
 * the status line or a job strip came or went, a font arrived, Headers appeared. Written to the element, not React state, so
 * a fold never renders the toolbar again; laying it out folded and unfolded settles on the same answer, so the observers
 * it triggers change nothing more.
 */
function useToolbarFold(): (element: HTMLDivElement | null) => void {
  const toolbar = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const element = toolbar.current, head = element?.parentElement
    if (!element || !head) return
    const fit = () => {
      const fold = fitFold(trial => { element.dataset.fold = foldWords(trial); return element.scrollWidth > element.clientWidth + 0.5 })
      element.dataset.fold = foldWords(fold)
      // Whenever White space folds away or is disabled (e.g. Summary active / pure-DDL run), ⋯ takes the roving Tab stop.
      // React never sets the button's tabIndex again (its prop does not change), so this stays until the next fold or disable toggle.
      const more = element.querySelector<HTMLButtonElement>('.results-more')
      if (more) more.tabIndex = resolveMoreTabIndex(element, fold)
    }
    fit()
    let watched: { dispose(): void } | undefined
    const watch = () => {
      watched?.dispose()
      // The toolbar's own groups too: once it is as wide as its pane, a group growing inside it (Headers, a choice turning
      // bold, the search count) changes no size outside it.
      watched = observeResize([head, ...head.children, ...element.children], fit)
    }
    watch()
    const view = head.ownerDocument.defaultView
    const added = view ? new view.MutationObserver(() => { watch(); fit() }) : undefined
    added?.observe(head, { childList: true })
    // A tool coming or going, becoming disabled (e.g. switching between grid and Summary without resizing), or a choice
    // pressed/expanded, anywhere in the toolbar. fit writes only data-fold and tabIndex, never these.
    added?.observe(element, { childList: true, subtree: true, attributeFilter: ['aria-pressed', 'data-active', 'disabled'] })
    return () => { added?.disconnect(); watched?.dispose() }
  }, [])
  return useCallback((element: HTMLDivElement | null) => { toolbar.current = element }, [])
}

const popoverMargin = 8

/**
 * Progressive-disclosure popover trigger for White space (¶) and Sort text by (📏): stays compact icon-only at default
 * (`Off` / `Value`) and expands into a tinted state chip with its active mode label when non-default. Opens a keyboard-
 * navigable `role="menu"` popover anchored below the button (in the button's own window for popouts), returning focus to
 * the trigger on Escape or selection.
 */
function ToolbarChoiceMenu<T extends string>({ label, icon, choices, current, defaultMode, first, foldClass, held = false, disabled = false, open, onOpenChange, onChoose }: {
  readonly label: string
  readonly icon: 'whitespace' | 'symbol-ruler'
  readonly choices: readonly Choice<T>[]
  readonly current: T
  readonly defaultMode: T
  readonly first: boolean
  readonly foldClass: string
  readonly held?: boolean
  readonly disabled?: boolean
  readonly open: boolean
  onOpenChange(open: boolean): void
  onChoose(mode: T): void
}) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const focusOnOpen = useRef<'checked' | 'first' | 'last'>('checked')
  const [host, setHost] = useState<HTMLElement | undefined>()
  const [place, setPlace] = useState<CSSProperties | undefined>()
  const [activeIndex, setActiveIndex] = useState(0)

  const currentIndex = Math.max(0, choices.findIndex(choice => choice.mode === current))
  const activeChoice = choices[currentIndex] ?? choices[0]
  const nonDefault = current !== defaultMode

  useLayoutEffect(() => {
    if (!open) { setHost(undefined); setPlace(undefined); return }
    const trigger = triggerRef.current
    if (!trigger) return
    setHost(trigger.ownerDocument.body)
    const initial = focusOnOpen.current === 'first' ? 0 : focusOnOpen.current === 'last' ? choices.length - 1 : currentIndex
    setActiveIndex(initial)
  }, [open])

  const openChangeRef = useRef(onOpenChange)
  openChangeRef.current = onOpenChange

  // Position below the trigger (or above when space below is tighter), clamped to the window.
  useLayoutEffect(() => {
    if (!open || !host) return
    const trigger = triggerRef.current, menu = menuRef.current
    if (!trigger || !menu) return
    const update = () => {
      const view = trigger.ownerDocument.defaultView ?? window
      if (!trigger.isConnected || view.getComputedStyle(trigger).display === 'none') { openChangeRef.current(false); return }
      const rect = trigger.getBoundingClientRect()
      const menuWidth = Math.max(menu.offsetWidth, 172), menuHeight = menu.offsetHeight || menu.scrollHeight
      const maxLeft = Math.max(popoverMargin, view.innerWidth - menuWidth - popoverMargin)
      const left = Math.max(popoverMargin, Math.min(rect.left, maxLeft))
      const below = view.innerHeight - popoverMargin - (rect.bottom + 4)
      const above = rect.top - 4 - popoverMargin
      const next: CSSProperties = below >= menuHeight || below >= above
        ? { left, top: Math.max(popoverMargin, rect.bottom + 4) }
        : { left, bottom: Math.max(popoverMargin, view.innerHeight - (rect.top - 4)) }
      setPlace(prev => prev && prev.left === next.left && prev.top === next.top && prev.bottom === next.bottom ? prev : next)
    }
    update()
    const view = trigger.ownerDocument.defaultView
    view?.addEventListener('resize', update)
    return () => { view?.removeEventListener('resize', update) }
  }, [open, host])

  // Focus the initial menu item once rendered in the portal.
  useLayoutEffect(() => {
    if (!open || !host) return
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    items?.[activeIndex]?.focus({ preventScroll: true })
  }, [open, host, activeIndex])

  // Close on outside press, window blur, or adoption into another window.
  useEffect(() => {
    if (!open || !host) return
    const trigger = triggerRef.current
    if (!trigger) return
    const doc = trigger.ownerDocument, view = doc.defaultView
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (menuRef.current?.contains(target) || trigger.contains(target))) return
      openChangeRef.current(false)
    }
    const onBlur = () => openChangeRef.current(false)
    const adoption = windows.onDidAdopt(() => { if (trigger.ownerDocument.body !== host) openChangeRef.current(false) })
    doc.addEventListener('pointerdown', onPointerDown, true)
    view?.addEventListener('blur', onBlur)
    return () => { doc.removeEventListener('pointerdown', onPointerDown, true); view?.removeEventListener('blur', onBlur); adoption.dispose() }
  }, [open, host])

  const closeAndFocusTrigger = () => {
    onOpenChange(false)
    triggerRef.current?.focus({ preventScroll: true })
  }

  const pick = (mode: T) => {
    closeAndFocusTrigger()
    onChoose(mode)
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      focusOnOpen.current = event.key === 'ArrowDown' ? 'first' : 'last'
      onOpenChange(true)
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeAndFocusTrigger()
      return
    }
    if (event.key === 'Tab') {
      onOpenChange(false)
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const count = choices.length
    const next = event.key === 'ArrowDown' ? (activeIndex + 1) % count
      : event.key === 'ArrowUp' ? (activeIndex + count - 1) % count
      : event.key === 'Home' ? 0
      : event.key === 'End' ? count - 1 : -1
    if (next >= 0) {
      event.preventDefault()
      event.stopPropagation()
      setActiveIndex(next)
    }
  }

  const effectiveOpen = open && !disabled
  const triggerTitle = disabled
    ? `${label}: unavailable on Summary`
    : held
      ? `${label}: ${activeChoice.label} — Waits until the sort or filter being built finishes`
      : `${label}: ${activeChoice.label} — ${activeChoice.title}`

  return <>
    <button ref={triggerRef} type="button" className={`results-choice-trigger ${foldClass}`} data-active={nonDefault ? 'true' : undefined}
      disabled={disabled} aria-label={`${label}: ${activeChoice.label}`} aria-haspopup="menu" aria-expanded={effectiveOpen} aria-controls={effectiveOpen ? menuId : undefined}
      aria-disabled={held || undefined} tabIndex={first && !disabled ? 0 : -1} title={triggerTitle}
      onKeyDown={onTriggerKeyDown}
      onClick={() => { if (disabled) return; focusOnOpen.current = 'checked'; onOpenChange(!open) }}>
      <Icon name={icon} />{nonDefault && <span>{activeChoice.label}</span>}
    </button>
    {effectiveOpen && host && createPortal(
      <div ref={menuRef} id={menuId} className="results-choice-menu" role="menu" aria-label={label} style={place ?? { visibility: 'hidden' }} onKeyDown={onMenuKeyDown}>
        <div className="results-choice-head" aria-hidden="true">{label}</div>
        {choices.map((choice, index) => {
          const checked = choice.mode === current
          return <button key={choice.mode} type="button" role="menuitemradio" className="results-choice-item" aria-checked={checked}
            aria-disabled={held || undefined} tabIndex={index === activeIndex ? 0 : -1}
            title={held ? 'Waits until the sort or filter being built finishes' : choice.title}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => pick(choice.mode)}>
            <span className="results-choice-text">
              <span className="results-choice-name">{choice.label}</span>
              <span className="results-choice-hint">{choice.hint}</span>
            </span>
            <span className="results-choice-check" aria-hidden="true">{checked && <Icon name="check" />}</span>
          </button>
        })}
      </div>,
      host
    )}
  </>
}

/** The ⋯ at the toolbar's end: More results tools, every tool of the toolbar as a menu (`output.tools`), so whatever a narrow
 *  pane folded away is a click away, Show Results as Tabs among them. */
function MoreTools({ tabId }: { tabId: string }) {
  const { menus } = useWorkbench()
  const button = useRef<HTMLButtonElement | null>(null)
  const register = useMenuTarget<HTMLButtonElement>(() => ({ kind: 'resultsTools', tabId }))
  const ref = useCallback((element: HTMLButtonElement | null) => { button.current = element; register(element) }, [register])
  const menuFor = useServiceSnapshot(menus.menuFor)
  return <button type="button" ref={ref} className="results-icon-toggle results-more" aria-label="More results tools" aria-haspopup="menu" aria-expanded={!!menuFor && menuFor === button.current}
    tabIndex={-1} title="More results tools: every tool of this toolbar, with those a narrow pane folds away, and Show Results as Tabs"
    // Enter and Space click with no detail: the menu then opens as the keyboard opens menus, its first item active.
    onClick={event => { menus.openForElement(event.currentTarget, { keyboard: event.detail === 0 }) }}><Icon name="ellipsis" /></button>
}

/**
 * The results toolbar, in the Results panel's head beside its views: what it changes applies to every grid in the run. It
 * holds search, progressive-disclosure White space and Sort text by popovers, and the Profile, Row size, Pivot, Compare,
 * Transposed, Tabs, Close Results and ⋯ tools. The controls follow the ARIA toolbar pattern: one Tab stop, Left and Right
 * (Home, End) move between them; the search box is a Tab stop of its own.
 */
export default function ResultsToolbar({ tabId }: { tabId: string }) {
  const { commands, settings, results, pivot, compare } = useWorkbench()
  const values = useServiceSnapshot(settings).values
  const [openMenu, setOpenMenu] = useState<'space' | 'sort' | null>(null)
  // The addressed query can update while another query is active; the command hook also follows global busy state.
  const tab = useServiceSnapshot(results)[tabId]
  const canClose = useCommandEnabled('output.closeResults', { tabId })
  const canPivot = useCommandEnabled('output.pivot', { tabId })
  const canTranspose = useCommandEnabled('output.transpose', { tabId })
  const pivotOpen = !!useServiceSnapshot(pivot).tabs[tabId]?.open
  const canCompare = useCommandEnabled('output.compare', { tabId })
  const compareOpen = !!useServiceSnapshot(compare).pickers[tabId]
  // The grid the toolbar's commands act on (the one that last had the focus), while it is drawn transposed: the button is
  // pressed, and Headers beside it names the column that heads the drawn columns.
  const turned = useServiceSnapshot(results.turned)[tabId]
  const headerColumn = turned?.headerColumn === undefined ? undefined : entryOf(tab?.sets, turned.entry)?.descriptor.columns[turned.headerColumn]
  const headers = headerColumn ? columnTitle(headerColumn.name) : 'Row number'
  const whitespace = values['queryResults.grid.whitespace'], sortText = values['queryResults.grid.sortText']
  // A sort or filter being built in any tab holds Sort text by off (it would sort every text-sorted grid again); it is
  // marked so once that operation shows, so a quick one never flashes it.
  const sortHeld = useSyncExternalStore(results.operations.subscribe, () => results.operations.anyBuilding(true))
  const profile = values['queryResults.grid.columnProfile'], rowSize = values['queryResults.grid.rowSize'], tabs = values['queryResults.grid.layout'] === 'tabs'
  // Grid-only controls disable while Summary is active (or on pure-DDL/DML runs with 0 result sets).
  const gridDisabled = !tab || tab.sets.length === 0 || (tabs && isSummaryActive(tab))
  useEffect(() => { if (gridDisabled && openMenu !== null) setOpenMenu(null) }, [gridDisabled, openMenu])
  // Off (or Value) runs the command of the choice that is on, which turns it off.
  const choose = <T,>(choices: readonly Choice<T>[], current: T, mode: T) => {
    if (mode === current) return
    const command = choices.find(choice => choice.mode === mode)?.command ?? choices.find(choice => choice.mode === current)?.command
    // The toolbar's own tab, which a refused Sort Text By tells why (the toolbar is no output view focusedOutput finds).
    if (command) void commands.execute(command, { tabId }, 'toolbar')
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    // Ignore events bubbled from portaled choice popovers.
    if (!event.currentTarget.contains(event.target as Node)) return
    // Only shown buttons: a narrow window hides some (styles.css).
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(item => item.getClientRects().length > 0), at = items.indexOf(event.target as HTMLButtonElement)
    if (at < 0) return
    const next = event.key === 'ArrowRight' ? (at + 1) % items.length : event.key === 'ArrowLeft' ? (at + items.length - 1) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    items[next].focus()
  }
  const fold = useToolbarFold()
  return <div ref={fold} className="results-toolbar" role="toolbar" aria-label="Results tools" onKeyDown={keyDown}>
    <ResultsSearchBox tabId={tabId} disabled={gridDisabled} />
    <ToolbarChoiceMenu label="White space" icon="whitespace" choices={whitespaceChoices} current={whitespace} defaultMode="none" first foldClass="results-space" disabled={gridDisabled}
      open={openMenu === 'space'} onOpenChange={next => setOpenMenu(next ? 'space' : null)} onChoose={mode => choose(whitespaceChoices, whitespace, mode)} />
    <ToolbarChoiceMenu label="Sort text by" icon="symbol-ruler" choices={sortTextChoices} current={sortText} defaultMode="value" first={false} foldClass="results-sort" held={sortHeld} disabled={gridDisabled}
      open={openMenu === 'sort'} onOpenChange={next => setOpenMenu(next ? 'sort' : null)} onChoose={mode => choose(sortTextChoices, sortText, mode)} />
    <span className="results-divider results-show" aria-hidden="true" />
    {/* Icons only, so the toolbar folds as little as it can in a narrow pane (the Show group folds last). */}
    <div className="results-segments results-show" role="group" aria-label="Show">
      <button type="button" className="results-icon-toggle" aria-label="Profile" aria-pressed={profile} tabIndex={-1} disabled={gridDisabled} title="Column profile: NULLs, distinct values, lowest and highest, lengths and a histogram for each column"
        onClick={() => void commands.execute('output.toggleColumnProfile', undefined, 'toolbar')}><Icon name="graph" /></button>
      <button type="button" className="results-icon-toggle" aria-label="Row size" aria-pressed={rowSize} tabIndex={-1} disabled={gridDisabled} title="Row size: a bar behind each row number; hover it for the exact bytes"
        onClick={() => void commands.execute('output.toggleRowSize', undefined, 'toolbar')}><Icon name="list-flat" /></button>
      <button type="button" className="results-icon-toggle" aria-label="Pivot" aria-pressed={pivotOpen} tabIndex={-1} disabled={gridDisabled || (!pivotOpen && !canPivot)}
        title="Pivot: group the focused grid's rows by columns and summarize them (count, sum, average, min, max) as a new result"
        onClick={() => { if (pivotOpen) pivot.close(tabId); else void commands.execute('output.pivot', { tabId }, 'toolbar') }}><Icon name="pivot" /></button>
      <button type="button" className="results-icon-toggle results-compare" aria-label="Compare" aria-haspopup="dialog" aria-expanded={compareOpen} tabIndex={-1} disabled={!compareOpen && !canCompare}
        title="Compare: compare the focused grid's result with another result of this run"
        onClick={event => { if (compareOpen) compare.close(tabId); else void commands.execute('output.compare', { tabId, anchor: event.currentTarget }, 'toolbar') }}><Icon name="git-compare" /></button>
      <button type="button" className="results-icon-toggle results-transpose" aria-label="Transposed" aria-pressed={!!turned} tabIndex={-1} disabled={gridDisabled || !canTranspose}
        title="Transposed: draw the focused grid's columns as rows and its rows as columns. Nothing is copied; the grid follows its sort and filters"
        onClick={() => void commands.execute('output.transpose', { tabId }, 'toolbar')}><Icon name="transpose" /></button>
      {turned && <button type="button" className="results-transpose results-headers" aria-haspopup="listbox" tabIndex={-1} disabled={gridDisabled || !canTranspose}
        title={`Using Column as Headers: the drawn columns are headed by ${headerColumn ? `the values of ${headers}` : 'row numbers'}. Choose another column`}
        onClick={event => void commands.execute('output.transposeChooseHeaders', { tabId, anchor: event.currentTarget }, 'toolbar')}><span>Headers: {headers}</span><Icon name="chevron-down" /></button>}
    </div>
    <span className="results-divider results-show" aria-hidden="true" />
    <div className="results-segments" role="group" aria-label="Results">
      <button type="button" className="results-icon-toggle results-layout" aria-label="Tabs" aria-pressed={tabs} tabIndex={-1}
        title="Tabs: show one result at a time, under a row of tabs, with its Table and Pivot as view tabs; off, every result is stacked"
        onClick={() => void commands.execute('output.toggleResultsTabs', undefined, 'toolbar')}><Icon name="window" /></button>
      <button type="button" className="results-icon-toggle" aria-label="Close Results" tabIndex={-1} disabled={!canClose}
        title="Close all results for this query to free memory; keep Messages" onClick={() => void commands.execute('output.closeResults', { tabId }, 'toolbar')}><Icon name="close" /></button>
      <MoreTools tabId={tabId} />
    </div>
  </div>
}
