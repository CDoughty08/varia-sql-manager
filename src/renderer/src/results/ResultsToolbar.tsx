import type { KeyboardEvent } from 'react'
import type { CommandId } from '../../../shared/commands/catalog'
import type { ViewSortMode } from '../../../shared/contracts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import type { WhitespaceMode } from '../grid/whitespace'
import Icon from '../Icon'

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

/**
 * The results toolbar, in the Results panel's head beside its views: what it changes applies to every grid in the run. It
 * holds White space, Sort text by, and the Profile and Row size toggles; search and the other result tools join it. The controls follow the
 * ARIA toolbar pattern: one Tab stop, Left and Right (Home, End) move between them.
 */
export default function ResultsToolbar() {
  const { commands, settings } = useWorkbench()
  const values = useServiceSnapshot(settings).values
  const whitespace = values['queryResults.grid.whitespace'], sortText = values['queryResults.grid.sortText']
  const profile = values['queryResults.grid.columnProfile'], rowSize = values['queryResults.grid.rowSize']
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
    {group('White space', 'whitespace', whitespaceChoices, whitespace, true)}
    {group('Sort text by', 'symbol-ruler', sortTextChoices, sortText, false)}
    <div className="results-segments" role="group" aria-label="Show">
      <button type="button" aria-pressed={profile} tabIndex={-1} title="Column profile: NULLs, distinct values, lowest and highest, lengths and a histogram for each column"
        onClick={() => void commands.execute('output.toggleColumnProfile', undefined, 'toolbar')}><Icon name="graph" />Profile</button>
      <button type="button" aria-pressed={rowSize} tabIndex={-1} title="Row size: a bar behind each row number; hover it for the exact bytes"
        onClick={() => void commands.execute('output.toggleRowSize', undefined, 'toolbar')}><Icon name="list-flat" />Row size</button>
    </div>
  </div>
}
