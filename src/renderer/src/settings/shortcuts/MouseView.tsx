import { Fragment, type JSX } from 'react'
import { commandDescriptor } from '../../../../shared/commands/catalog'
import { gesturePhrase, isGestureId } from '../../../../shared/commands/gestures'
import type { Platform } from '../../../../shared/commands/keybindings'
import type { ShortcutFile } from '../../../../shared/commands/shortcut-schema'
import { pagePath } from '../../../../shared/settings/catalog'
import { useServiceSelector, useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import Keybinding from '../../Keybinding'
import { gestureRowGroups, gestureRows, gestureSourceTitles, setGesture, type GestureRow, type LinkedSettings } from './gesture-rows'

export interface MouseViewProps {
  readonly draft: ShortcutFile
  onChange(next: ShortcutFile): void
  readonly platform: Platform
  readonly search: string
  /** Opens another Options page (a linked setting's); without it the page is named, not linked. */
  onOpenPage?(page: string): void
  /**
   * The Options dialog's draft value of Text Editor › General › Add a cursor with, so the linked row follows a change not
   * yet saved; without it the row shows the saved setting.
   */
  readonly multiCursorModifier?: LinkedSettings['multiCursorModifier']
}

const actionWords: Readonly<Record<GestureRow['action'], string>> = { click: 'click', doubleClick: 'double-click', hover: 'hover', drag: 'drag', wheel: 'wheel' }
const domId = (id: string) => 'mouse-' + id.replace(/\./g, '-')

function Binding({ row, platform, onPick }: { row: GestureRow; platform: Platform; onPick(token: string): void }) {
  if (!row.options.length) return <span className="mouse-binding-text">{row.label} {row.target}</span>
  const described = [domId(row.id) + '-about', row.problems.length ? domId(row.id) + '-problems' : ''].filter(Boolean).join(' ')
  return <span className="mouse-binding">
    <select id={domId(row.id)} value={row.currentToken} aria-label={`${row.title}: modifier`} aria-describedby={described}
      aria-invalid={row.problems.some(problem => problem.severity === 'error') || undefined} onChange={event => onPick(event.target.value)}>
      {row.options.map(option => <option key={option.token} value={option.token}>{option.label}</option>)}
    </select>
    <span className="mouse-action">{row.current === null ? `(${actionWords[row.action]} does nothing extra)` : `+ ${actionWords[row.action]}`}</span>
    {row.current !== null && <span className="visually-hidden">{gesturePhrase(row.action, row.current, platform)} {row.target}</span>}
  </span>
}

/** The commands that do the same from the keyboard, with their keys in the draft (a key remapped on the page shows here before OK). */
function KeyboardPath({ row }: { row: GestureRow }) {
  if (!row.keys.length) return null
  return <span className="mouse-keyboard">Keyboard: {row.keys.map(({ command, label }, index) => <Fragment key={command}>{index > 0 && ', '}{commandDescriptor(command).title}{label && <> <Keybinding label={label} /></>}</Fragment>)}</span>
}

/** What a row is and how else to reach it, under its control: read with the dropdown (`aria-describedby`), not with every cell. */
function Details({ row }: { row: GestureRow }) {
  return <span className="mouse-details">
    <span className="mouse-about" id={domId(row.id) + '-about'}>{row.description}</span>
    {row.locked && <span className="mouse-reason">{row.locked}</span>}
    {row.otherPlatform && <span className="mouse-reason">This file sets a choice for this gesture that only another platform offers, so the default applies here. Reset removes it.</span>}
    <KeyboardPath row={row} />
    {row.problems.length > 0 && <span className="mouse-problems" id={domId(row.id) + '-problems'}>
      {row.problems.map(problem => <span key={problem.code + (problem.other ?? '')} className="mouse-problem" data-severity={problem.severity}>
        <Icon name={problem.severity === 'error' ? 'error' : 'warning'} label={problem.severity === 'error' ? 'Error' : 'Warning'} />{problem.message}</span>)}
    </span>}
  </span>
}

/**
 * The Shortcuts page's Mouse view: modifier behaviours and pointer commands, each with a dropdown of the modifiers it
 * may use on this platform (and Off for a behaviour), fixed gestures locked with their reason, and the query editor's
 * multi-cursor setting linked to its page. Edits change only the draft's `gestures`; OK saves them.
 */
export default function MouseView({ draft, onChange, platform, search, onOpenPage, multiCursorModifier }: MouseViewProps): JSX.Element {
  const { settings } = useWorkbench()
  const saved = useServiceSelector(settings, snapshot => snapshot.values['textEditor.multiCursorModifier'])
  const rows = gestureRows(draft, platform, search, { multiCursorModifier: multiCursorModifier ?? saved })
  if (!rows.length) return <p className="mouse-empty" role="status">No gestures match.</p>
  const pick = (row: GestureRow, token: string | undefined) => {
    if (!isGestureId(row.id)) return
    const option = token === undefined ? undefined : row.options.find(entry => entry.token === token)
    onChange(setGesture(draft, row.id, option?.choice, platform))
  }
  return <table className="mouse-view" aria-label="Mouse gestures">
    <colgroup><col className="mouse-col-gesture" /><col className="mouse-col-binding" /><col className="mouse-col-where" /><col className="mouse-col-source" /></colgroup>
    <thead><tr><th scope="col">Gesture</th><th scope="col">Binding</th><th scope="col">Where</th><th scope="col">Source</th></tr></thead>
    {gestureRowGroups.map(group => {
      const shown = rows.filter(row => row.kind === group.id)
      if (!shown.length) return null
      return <tbody key={group.id}>
        <tr className="mouse-group"><th scope="rowgroup" colSpan={4}>{group.title}</th></tr>
        {shown.map(row => <tr key={row.id} data-gesture={row.id} data-modified={row.changed || undefined}>
          {/* The row header holds only the title, so screen readers repeat no more than that with each cell. */}
          <th scope="row"><span className="mouse-gesture">
            <span className="mouse-dot" aria-hidden="true" data-on={row.changed || undefined} />
            <span className="mouse-title">{row.title}</span>
          </span></th>
          <td>
            {row.kind === 'linked'
              ? <span className="mouse-binding-text">{row.label} · {onOpenPage && row.page
                ? <button type="button" className="mouse-link" onClick={() => onOpenPage(row.page!)}>{pagePath(row.page).map(node => node.title).join(' › ')}</button>
                : row.page && pagePath(row.page).map(node => node.title).join(' › ')}</span>
              : <Binding row={row} platform={platform} onPick={token => pick(row, token)} />}
            <Details row={row} />
          </td>
          <td>{row.scopeTitle}</td>
          <td>
            <span className="mouse-source" data-source={row.source} title={row.locked}>{row.locked && <Icon name="lock" />}{gestureSourceTitles[row.source]}</span>
            {row.options.length > 0 && <button type="button" className="icon-button mouse-reset" disabled={!row.changed} title={`Reset to ${row.defaultLabel}`}
              aria-label={`Reset ${row.title} to ${row.defaultLabel}`} onClick={() => pick(row, undefined)}><Icon name="discard" /></button>}
          </td>
        </tr>)}
      </tbody>
    })}
  </table>
}
