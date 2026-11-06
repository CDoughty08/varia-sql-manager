import type { KeyboardEvent } from 'react'
import type { CommandId } from '../../../shared/commands/catalog'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import type { WhitespaceMode } from '../grid/whitespace'
import Icon from '../Icon'

/** The White space choices, each the command that turns it on (and, when it is already on, off). */
const whitespaceChoices: readonly { readonly mode: WhitespaceMode; readonly label: string; readonly title: string; readonly command?: CommandId }[] = [
  { mode: 'none', label: 'Off', title: 'Show values as they are' },
  { mode: 'spaces', label: 'Spaces', title: 'Show spaces (·) and tabs (→)', command: 'output.showSpaces' },
  { mode: 'all', label: 'All', title: 'Also name line breaks (CR, LF) and invisible spaces (NBSP, ZWSP, BOM…)', command: 'output.showAllWhitespace' }
]
const commandFor = (mode: WhitespaceMode) => whitespaceChoices.find(choice => choice.mode === mode)?.command

/**
 * The results toolbar, in the Results panel's head beside its views: what it changes applies to every grid in the run. It
 * holds White space for now; search, stats and the other result tools join it. The controls follow the ARIA toolbar
 * pattern: one Tab stop, Left and Right (Home, End) move between them.
 */
export default function ResultsToolbar() {
  const { commands, settings } = useWorkbench()
  const whitespace = useServiceSnapshot(settings).values['queryResults.grid.whitespace']
  const choose = (mode: WhitespaceMode) => {
    if (mode === whitespace) return
    // Off runs the command of the choice that is on, which turns it off.
    const command = commandFor(mode) ?? commandFor(whitespace)
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
  const current = whitespaceChoices.findIndex(choice => choice.mode === whitespace)
  return <div className="results-toolbar" role="toolbar" aria-label="Results tools" onKeyDown={keyDown}>
    <span className="results-toolbar-label" aria-hidden="true" title="White space"><Icon name="whitespace" /></span>
    <div className="results-segments" role="group" aria-label="White space">
      {whitespaceChoices.map((choice, index) => <button key={choice.mode} type="button" aria-pressed={choice.mode === whitespace} title={choice.title}
        tabIndex={index === Math.max(0, current) ? 0 : -1} onClick={() => choose(choice.mode)}>{choice.label}</button>)}
    </div>
  </div>
}
