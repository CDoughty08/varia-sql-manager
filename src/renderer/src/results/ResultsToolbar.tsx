import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { CommandId } from '../../../shared/commands/catalog'
import type { ViewSortMode } from '../../../shared/contracts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { useCommandEnabled } from '../core/useCommand'
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
  return <div className="results-search" data-mode={search.mode}>
    <Icon name="search" className="results-search-icon" />
    <input ref={inputRef} type="text" spellCheck={false} maxLength={1024} aria-label={columns ? 'Search column names' : 'Search results'} placeholder={columns ? 'Search column names' : 'Search all results'}
      value={search.text} title={search.approximate ? 'Some long values were searched only as far as they were stored.' : undefined}
      onChange={event => resultsSearch.setText(tabId, event.target.value)} onKeyDown={keyDown} />
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
 * The results toolbar, in the Results panel's head beside its views: what it changes applies to every grid in the run. It
 * holds search, White space, Sort text by, and the Profile and Row size toggles; the other result tools join it. The controls follow the
 * ARIA toolbar pattern: one Tab stop, Left and Right (Home, End) move between them; the search box is a Tab stop of its own.
 */
export default function ResultsToolbar({ tabId }: { tabId: string }) {
  const { commands, settings, results, pivot } = useWorkbench()
  const values = useServiceSnapshot(settings).values
  // The addressed query can update while another query is active; the command hook also follows global busy state.
  useServiceSnapshot(results)
  const canClose = useCommandEnabled('output.closeResults', { tabId })
  const canPivot = useCommandEnabled('output.pivot', { tabId })
  const canTranspose = useCommandEnabled('output.transpose', { tabId })
  const pivotOpen = !!useServiceSnapshot(pivot).tabs[tabId]?.open
  // The grid the toolbar's commands act on (the one that last had the focus), while it is drawn transposed: the button is
  // pressed, and Headers beside it names the column that heads the drawn columns.
  const turned = useServiceSnapshot(results.turned)[tabId]
  const headerColumn = turned?.headerColumn === undefined ? undefined : entryOf(results.getSnapshot()[tabId]?.sets, turned.entry)?.descriptor.columns[turned.headerColumn]
  const headers = headerColumn ? columnTitle(headerColumn.name) : 'Row number'
  const whitespace = values['queryResults.grid.whitespace'], sortText = values['queryResults.grid.sortText']
  const profile = values['queryResults.grid.columnProfile'], rowSize = values['queryResults.grid.rowSize'], tabs = values['queryResults.grid.layout'] === 'tabs'
  // Off (or Value) runs the command of the choice that is on, which turns it off.
  const choose = <T,>(choices: readonly Choice<T>[], current: T, mode: T) => {
    if (mode === current) return
    const command = choices.find(choice => choice.mode === mode)?.command ?? choices.find(choice => choice.mode === current)?.command
    if (command) void commands.execute(command, undefined, 'toolbar')
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
  const group = <T extends string>(label: string, icon: 'whitespace' | 'symbol-ruler', choices: readonly Choice<T>[], current: T, first: boolean) => <>
    <span className="results-toolbar-label" aria-hidden="true" title={label}><Icon name={icon} /></span>
    <div className="results-segments" role="group" aria-label={label}>
      {choices.map((choice, index) => <button key={choice.mode} type="button" aria-pressed={choice.mode === current} title={choice.title}
        tabIndex={first && index === tabStop ? 0 : -1} onClick={() => choose(choices, current, choice.mode)}>{choice.label}</button>)}
    </div>
  </>
  return <div className="results-toolbar" role="toolbar" aria-label="Results tools" onKeyDown={keyDown}>
    <ResultsSearchBox tabId={tabId} />
    {group('White space', 'whitespace', whitespaceChoices, whitespace, true)}
    {group('Sort text by', 'symbol-ruler', sortTextChoices, sortText, false)}
    {/* Icons only: with the two segmented groups the toolbar must still fit the output pane of a 1024 px window. */}
    <div className="results-segments" role="group" aria-label="Show">
      <button type="button" className="results-icon-toggle" aria-label="Profile" aria-pressed={profile} tabIndex={-1} title="Column profile: NULLs, distinct values, lowest and highest, lengths and a histogram for each column"
        onClick={() => void commands.execute('output.toggleColumnProfile', undefined, 'toolbar')}><Icon name="graph" /></button>
      <button type="button" className="results-icon-toggle" aria-label="Row size" aria-pressed={rowSize} tabIndex={-1} title="Row size: a bar behind each row number; hover it for the exact bytes"
        onClick={() => void commands.execute('output.toggleRowSize', undefined, 'toolbar')}><Icon name="list-flat" /></button>
      <button type="button" className="results-icon-toggle" aria-label="Pivot" aria-pressed={pivotOpen} tabIndex={-1} disabled={!pivotOpen && !canPivot}
        title="Pivot: group the focused grid's rows by columns and summarize them (count, sum, average, min, max) as a new result"
        onClick={() => { if (pivotOpen) pivot.close(tabId); else void commands.execute('output.pivot', { tabId }, 'toolbar') }}><Icon name="pivot" /></button>
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
    </div>
  </div>
}
