import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { CommandId } from '../../../shared/commands/catalog'
import type { ViewSortMode } from '../../../shared/contracts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import type { WhitespaceMode } from '../grid/whitespace'
import Icon from '../Icon'
import { searchCount, type SearchMode } from './search'
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
const searchModes: readonly { readonly mode: SearchMode; readonly label: string; readonly title: string }[] = [
  { mode: 'values', label: 'Data', title: 'Search cell values, comparing text by each column collation' },
  { mode: 'columns', label: 'Columns', title: 'Search column names only' }
]

/**
 * The search box: its text searches every grid of the run (ResultsSearchService), Enter and Shift+Enter step through the
 * matches, Escape clears it. It is its own Tab stop, so Left and Right stay with its text.
 */
function ResultsSearchBox({ tabId }: { tabId: string }) {
  const { resultsSearch } = useWorkbench()
  const search = useServiceSnapshot(resultsSearch)[tabId] ?? resultsSearch.of(tabId)
  const inputRef = useRef<HTMLInputElement>(null)
  const focus = search.focus
  // Find in Results (Ctrl+F in a grid) puts the focus here with the text selected, so typing replaces it.
  useEffect(() => { if (focus > 0) { inputRef.current?.focus(); inputRef.current?.select() } }, [focus])
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); resultsSearch.step(tabId, event.shiftKey ? -1 : 1) }
    else if (event.key === 'Escape' && search.text) { event.preventDefault(); event.stopPropagation(); resultsSearch.clear(tabId) }
  }
  const count = searchCount(search, formatCount)
  const columns = search.mode === 'columns'
  return <div className="results-search" data-mode={search.mode}>
    <Icon name="search" />
    <input ref={inputRef} type="text" spellCheck={false} maxLength={1024} aria-label={columns ? 'Search column names' : 'Search results'} placeholder={columns ? 'Search column names' : 'Search all results'}
      value={search.text} title={search.approximate ? 'Some long values were searched only as far as they were stored.' : undefined}
      onChange={event => resultsSearch.setText(tabId, event.target.value)} onKeyDown={keyDown} />
    <span className="results-search-count" role="status" aria-live="polite" title={search.error}>{count}</span>
    <button type="button" tabIndex={-1} aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={search.total === 0} onClick={() => resultsSearch.step(tabId, -1)}><Icon name="arrow-up" /></button>
    <button type="button" tabIndex={-1} aria-label="Next match" title="Next match (Enter)" disabled={search.total === 0} onClick={() => resultsSearch.step(tabId, 1)}><Icon name="arrow-down" /></button>
    <div className="results-segments" role="group" aria-label="Search in">
      {searchModes.map(choice => <button key={choice.mode} type="button" tabIndex={-1} aria-pressed={choice.mode === search.mode} title={choice.title}
        onClick={() => resultsSearch.setMode(tabId, choice.mode)}>{choice.label}</button>)}
    </div>
  </div>
}

/**
 * The results toolbar, in the Results panel's head beside its views: what it changes applies to every grid in the run. It
 * holds search, White space and Sort text by for now; stats and the other result tools join it. The buttons follow the
 * ARIA toolbar pattern: one Tab stop, Left and Right (Home, End) move between them; the search box is a Tab stop of its own.
 */
export default function ResultsToolbar({ tabId }: { tabId: string }) {
  const { commands, settings } = useWorkbench()
  const values = useServiceSnapshot(settings).values
  const whitespace = values['queryResults.grid.whitespace'], sortText = values['queryResults.grid.sortText']
  // Off (or Value) runs the command of the choice that is on, which turns it off.
  const choose = <T,>(choices: readonly Choice<T>[], current: T, mode: T) => {
    if (mode === current) return
    const command = choices.find(choice => choice.mode === mode)?.command ?? choices.find(choice => choice.mode === current)?.command
    if (command) void commands.execute(command, undefined, 'toolbar')
  }
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
  </div>
}
