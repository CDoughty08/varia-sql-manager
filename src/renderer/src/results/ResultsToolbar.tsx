import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent } from 'react'
import type { CommandId } from '../../../shared/commands/catalog'
import type { ViewSortMode } from '../../../shared/contracts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { useCommandEnabled } from '../core/useCommand'
import { observeResize } from '../core/windows'
import { useMenuTarget } from '../menus/useMenuTarget'
import { columnTitle } from '../grid/selection'
import type { WhitespaceMode } from '../grid/whitespace'
import Icon from '../Icon'
import { entryOf } from './ResultsService'
import { searchBoxKeyAction, searchCount, type SearchMode } from './search'
import { formatCount } from './status'

interface Choice<T> { readonly mode: T; readonly label: string; readonly title: string; readonly command?: CommandId }

/** The White space choices, each the command that turns it on (and, when it is already on, off). */
const whitespaceChoices: readonly Choice<WhitespaceMode>[] = [
  { mode: 'none', label: 'Off', title: 'Show values as they are' },
  { mode: 'spaces', label: 'Spaces', title: 'Show spaces (·) and tabs (→)', command: 'output.showSpaces' },
  { mode: 'all', label: 'All', title: 'Also name line breaks (CR, LF) and invisible spaces (NBSP, ZWSP, BOM…)', command: 'output.showAllWhitespace' }
]
/** How sorted grids order text columns (queryResults.grid.sortText), the same way. */
const sortTextChoices: readonly Choice<ViewSortMode>[] = [
  { mode: 'value', label: 'Value', title: 'Sort text as ORDER BY would, by the column\'s collation' },
  { mode: 'chars', label: 'Chars', title: 'Sort text by its length in characters, spaces included', command: 'output.sortTextByChars' },
  { mode: 'bytes', label: 'Bytes', title: 'Sort text and binary values by their length in bytes (DATALENGTH)', command: 'output.sortTextByBytes' }
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
function ResultsSearchBox({ tabId }: { tabId: string }) {
  const { resultsSearch } = useWorkbench()
  const search = useServiceSnapshot(resultsSearch)[tabId] ?? resultsSearch.of(tabId)
  const inputRef = useRef<HTMLInputElement>(null)
  const focus = search.focus
  // Find in Results (Ctrl+F in a grid) puts the focus here with the text selected, so typing replaces it; once, even when
  // the box is shown only after it (the Messages view), and not again each time the box is shown.
  useEffect(() => { if (resultsSearch.takeFocus(tabId)) { inputRef.current?.focus(); inputRef.current?.select() } }, [focus, resultsSearch, tabId])
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
  return <div className="results-search" data-mode={search.mode}>
    <Icon name="search" className="results-search-icon" />
    {/* The field is at least as wide as its placeholder, drawn unseen beside the input (data-placeholder), so the whole
        placeholder shows at every width and in every font; the toolbar folds its groups rather than narrow it. */}
    <span className="results-search-field" data-placeholder={placeholder}>
      <input ref={inputRef} type="text" spellCheck={false} maxLength={1024} aria-label={columns ? 'Search column names' : 'Search results'} placeholder={placeholder}
        value={search.text} title={search.approximate ? 'Some long values were searched only as far as they were stored.' : undefined}
        onChange={event => resultsSearch.setText(tabId, event.target.value)} onKeyDown={keyDown} />
    </span>
    {/* The count follows each keystroke and grid; the live region says only the settled count (TabSearch.announcement). */}
    <span className="results-search-count" title={search.error}>{count}</span>
    <span className="visually-hidden" role="status" aria-live="polite">{search.announcement}</span>
    <button type="button" tabIndex={-1} aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={search.total === 0} onClick={() => resultsSearch.step(tabId, -1)}><Icon name="arrow-up" /></button>
    <button type="button" tabIndex={-1} aria-label="Next match" title="Next match (Enter)" disabled={search.total === 0} onClick={() => resultsSearch.step(tabId, 1)}><Icon name="arrow-down" /></button>
    <div className="results-segments" role="group" aria-label="Search in">
      {/* Icons only, as the Show toggles: the toolbar must still fit the output pane of a 1024 px window. */}
      {searchModes.map(choice => <button key={choice.mode} type="button" className="results-icon-toggle" tabIndex={-1} aria-label={choice.label} aria-pressed={choice.mode === search.mode} title={choice.title}
        onClick={() => resultsSearch.setMode(tabId, choice.mode)}><Icon name={choice.icon} /></button>)}
    </div>
  </div>
}

/**
 * How the results toolbar gives way in a narrow pane, in order: Tabs goes (it is in the ⋯ menu and the Window menu), the
 * groups tighten (no icons beside them, the search box's magnifier and Previous and Next go: Enter, Shift+Enter and F3 still
 * step), then Transposed, Headers and Compare, then Sort text by, White space, and the Show group. The search field never
 * narrows past its placeholder. Search, Close Results
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

/**
 * Folds the toolbar to its width (`fitFold`) whenever it, its head or what shares the head changes size: the pane resized,
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
      // Once White space folds away its chosen button, the toolbar's Tab stop, goes with it: ⋯ takes the stop. React
      // never sets the button's tabIndex again (its prop does not change), so this stays until the next fold.
      const more = element.querySelector<HTMLButtonElement>('.results-more')
      if (more) more.tabIndex = moreIsTabStop(fold) ? 0 : -1
    }
    fit()
    let watched: { dispose(): void } | undefined
    const watch = () => {
      watched?.dispose()
      watched = observeResize([head, ...head.children], fit)
    }
    watch()
    const view = head.ownerDocument.defaultView
    const added = view ? new view.MutationObserver(() => { watch(); fit() }) : undefined
    added?.observe(head, { childList: true })
    return () => { added?.disconnect(); watched?.dispose() }
  }, [])
  return useCallback((element: HTMLDivElement | null) => { toolbar.current = element }, [])
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
 * holds search, White space, Sort text by, and the Profile and Row size toggles; the other result tools join it. The controls follow the
 * ARIA toolbar pattern: one Tab stop, Left and Right (Home, End) move between them; the search box is a Tab stop of its own.
 */
export default function ResultsToolbar({ tabId }: { tabId: string }) {
  const { commands, settings, results, pivot, compare } = useWorkbench()
  const values = useServiceSnapshot(settings).values
  // The addressed query can update while another query is active; the command hook also follows global busy state.
  useServiceSnapshot(results)
  const canClose = useCommandEnabled('output.closeResults', { tabId })
  const canPivot = useCommandEnabled('output.pivot', { tabId })
  const canTranspose = useCommandEnabled('output.transpose', { tabId })
  const pivotOpen = !!useServiceSnapshot(pivot).tabs[tabId]?.open
  const canCompare = useCommandEnabled('output.compare', { tabId })
  const compareOpen = !!useServiceSnapshot(compare).pickers[tabId]
  // The grid the toolbar's commands act on (the one that last had the focus), while it is drawn transposed: the button is
  // pressed, and Headers beside it names the column that heads the drawn columns.
  const turned = useServiceSnapshot(results.turned)[tabId]
  const headerColumn = turned?.headerColumn === undefined ? undefined : entryOf(results.getSnapshot()[tabId]?.sets, turned.entry)?.descriptor.columns[turned.headerColumn]
  const headers = headerColumn ? columnTitle(headerColumn.name) : 'Row number'
  const whitespace = values['queryResults.grid.whitespace'], sortText = values['queryResults.grid.sortText']
  // A sort or filter being built in any tab holds Sort text by off (it would sort every text-sorted grid again); it is
  // marked so once that operation shows, so a quick one never flashes it.
  const sortHeld = useSyncExternalStore(results.operations.subscribe, () => results.operations.anyBuilding(true))
  const profile = values['queryResults.grid.columnProfile'], rowSize = values['queryResults.grid.rowSize'], tabs = values['queryResults.grid.layout'] === 'tabs'
  // Off (or Value) runs the command of the choice that is on, which turns it off.
  const choose = <T,>(choices: readonly Choice<T>[], current: T, mode: T) => {
    if (mode === current) return
    const command = choices.find(choice => choice.mode === mode)?.command ?? choices.find(choice => choice.mode === current)?.command
    // The toolbar's own tab, which a refused Sort Text By tells why (the toolbar is no output view focusedOutput finds).
    if (command) void commands.execute(command, { tabId }, 'toolbar')
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    // Only shown buttons: a narrow window hides some (styles.css).
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(item => item.getClientRects().length > 0), at = items.indexOf(event.target as HTMLButtonElement)
    if (at < 0) return
    const next = event.key === 'ArrowRight' ? (at + 1) % items.length : event.key === 'ArrowLeft' ? (at + items.length - 1) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    items[next].focus()
  }
  // The toolbar's one Tab stop: the first group's chosen button.
  const tabStop = Math.max(0, whitespaceChoices.findIndex(choice => choice.mode === whitespace))
  const group = <T extends string>(label: string, icon: 'whitespace' | 'symbol-ruler', choices: readonly Choice<T>[], current: T, first: boolean, fold: string, held = false) => <>
    <span className={`results-toolbar-label ${fold}`} aria-hidden="true" title={label}><Icon name={icon} /></span>
    <div className={`results-segments ${fold}`} role="group" aria-label={label}>
      {choices.map((choice, index) => <button key={choice.mode} type="button" aria-pressed={choice.mode === current} title={held ? 'Waits until the sort or filter being built finishes' : choice.title} aria-disabled={held || undefined}
        tabIndex={first && index === tabStop ? 0 : -1} onClick={() => choose(choices, current, choice.mode)}>{choice.label}</button>)}
    </div>
  </>
  const fold = useToolbarFold()
  return <div ref={fold} className="results-toolbar" role="toolbar" aria-label="Results tools" onKeyDown={keyDown}>
    <ResultsSearchBox tabId={tabId} />
    {group('White space', 'whitespace', whitespaceChoices, whitespace, true, 'results-space')}
    {group('Sort text by', 'symbol-ruler', sortTextChoices, sortText, false, 'results-sort', sortHeld)}
    {/* Icons only: with the two segmented groups the toolbar must still fit the output pane of a 1024 px window. */}
    <div className="results-segments results-show" role="group" aria-label="Show">
      <button type="button" className="results-icon-toggle" aria-label="Profile" aria-pressed={profile} tabIndex={-1} title="Column profile: NULLs, distinct values, lowest and highest, lengths and a histogram for each column"
        onClick={() => void commands.execute('output.toggleColumnProfile', undefined, 'toolbar')}><Icon name="graph" /></button>
      <button type="button" className="results-icon-toggle" aria-label="Row size" aria-pressed={rowSize} tabIndex={-1} title="Row size: a bar behind each row number; hover it for the exact bytes"
        onClick={() => void commands.execute('output.toggleRowSize', undefined, 'toolbar')}><Icon name="list-flat" /></button>
      <button type="button" className="results-icon-toggle" aria-label="Pivot" aria-pressed={pivotOpen} tabIndex={-1} disabled={!pivotOpen && !canPivot}
        title="Pivot: group the focused grid's rows by columns and summarize them (count, sum, average, min, max) as a new result"
        onClick={() => { if (pivotOpen) pivot.close(tabId); else void commands.execute('output.pivot', { tabId }, 'toolbar') }}><Icon name="pivot" /></button>
      <button type="button" className="results-icon-toggle results-compare" aria-label="Compare" aria-haspopup="dialog" aria-expanded={compareOpen} tabIndex={-1} disabled={!compareOpen && !canCompare}
        title="Compare: compare the focused grid's result with another result of this run"
        onClick={event => { if (compareOpen) compare.close(tabId); else void commands.execute('output.compare', { tabId, anchor: event.currentTarget }, 'toolbar') }}><Icon name="git-compare" /></button>
      <button type="button" className="results-icon-toggle results-transpose" aria-label="Transposed" aria-pressed={!!turned} tabIndex={-1} disabled={!canTranspose}
        title="Transposed: draw the focused grid's columns as rows and its rows as columns. Nothing is copied; the grid follows its sort and filters"
        onClick={() => void commands.execute('output.transpose', { tabId }, 'toolbar')}><Icon name="transpose" /></button>
      {turned && <button type="button" className="results-transpose results-headers" aria-haspopup="listbox" tabIndex={-1} disabled={!canTranspose}
        title={`Using Column as Headers: the drawn columns are headed by ${headerColumn ? `the values of ${headers}` : 'row numbers'}. Choose another column`}
        onClick={event => void commands.execute('output.transposeChooseHeaders', { tabId, anchor: event.currentTarget }, 'toolbar')}><span>Headers: {headers}</span><Icon name="chevron-down" /></button>}
    </div>
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
