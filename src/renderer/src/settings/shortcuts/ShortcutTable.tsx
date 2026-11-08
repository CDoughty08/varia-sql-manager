import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import type { CommandId } from '../../../../shared/commands/catalog'
import { intrinsicKeys } from '../../../../shared/commands/intrinsic'
import { keybindingLabel, parseKeySpec, platforms as allPlatforms, type Platform } from '../../../../shared/commands/keybindings'
import { shortcutScope } from '../../../../shared/commands/scopes'
import Icon from '../../Icon'
import { KeyCaps } from './CaptureField'
import type { GestureRow } from './gesture-rows'
import { sourceTitles, type BindingRow, type BindingSource, type CommandRow } from './shortcut-draft'
import type { ShortcutGroup } from './shortcuts-search'

export const platformTitles: Readonly<Record<Platform, string>> = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }
/** A table row's identity: its command and the index of its shortcut in the command's row (−1 for a command without one). */
export interface ShortcutSelection { readonly command: CommandId; readonly index: number }
export const selectionKey = (selection: ShortcutSelection): string => `${selection.command}:${selection.index}`

interface Props {
  readonly groups: readonly ShortcutGroup[]
  readonly platform: Platform
  readonly selected?: ShortcutSelection
  readonly onSelect: (selection: ShortcutSelection) => void
  /** Enter on a row: the inspector's capture box takes focus. */
  readonly onActivate: () => void
  readonly onReset: (row: BindingRow) => void
  /** The All view's gesture rows, after the keyboard rows; choosing one opens the Mouse view. */
  readonly gestures?: readonly GestureRow[]
  readonly onShowMouse?: () => void
  /** The "Built in" group: shown while nothing filters the table. */
  readonly builtIn?: { readonly open: boolean; readonly onToggle: () => void }
  /** Show other platforms: every platform's shortcuts per command, one row a command. */
  readonly byPlatform?: Readonly<Record<Platform, ReadonlyMap<CommandId, CommandRow>>>
  /** Shown in place of rows when nothing matches. */
  readonly empty?: ReactNode
}

function SourceChip({ source, lock }: { readonly source: BindingSource | 'builtin' | 'unbound'; readonly lock?: string }) {
  if (source === 'unbound') return <span className="shortcuts-source">Unbound</span>
  return <span className="shortcuts-source" data-source={source} title={lock}>{lock && <Icon name="lock" />}{sourceTitles[source]}</span>
}

/**
 * Every command with its shortcuts, grouped by category: Command (title and id), Shortcut (key caps), Scope and Source.
 * A grid with one tab stop on the selected row; Up, Down, Home and End move the selection, Enter goes to the capture box.
 * A changed row has a dot and its own Reset.
 */
export default function ShortcutTable({ groups, platform, selected, onSelect, onActivate, onReset, gestures, onShowMouse, builtIn, byPlatform, empty }: Props) {
  const body = useRef<HTMLTableElement>(null)
  const focusNext = useRef(false)
  const order = groups.flatMap(group => group.rows.filter(row => !byPlatform || row.first).map(row => ({ command: row.row.id, index: row.binding ? row.row.bindings.indexOf(row.binding) : -1 })))
  const current = selected && order.some(item => selectionKey(item) === selectionKey(selected)) ? selectionKey(selected) : order[0] && selectionKey(order[0])
  useEffect(() => {
    if (!focusNext.current || !current) return
    focusNext.current = false
    body.current?.querySelector<HTMLElement>(`[data-row="${current}"]`)?.focus()
  }, [current])
  const keyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-row]')) return
    const at = order.findIndex(item => selectionKey(item) === current)
    const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : undefined
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); onActivate(); return }
    if (to === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const next = order[Math.max(0, Math.min(order.length - 1, to))]
    if (!next) return
    focusNext.current = true
    onSelect(next)
  }
  const columns = byPlatform ? ['Command', ...allPlatforms.map(item => platformTitles[item]), 'Source'] : ['Command', 'Shortcut', 'Scope', 'Source']
  const rows: ReactNode[] = []
  for (const group of groups) {
    rows.push(<tr key={'group:' + group.category} className="shortcuts-group"><th colSpan={columns.length} scope="colgroup">{group.category}</th></tr>)
    for (const match of group.rows) {
      if (byPlatform && !match.first) continue
      const { row, binding } = match
      const selection = { command: row.id, index: binding ? row.bindings.indexOf(binding) : -1 }
      const key = selectionKey(selection), isSelected = key === current
      const changed = byPlatform ? row.changed : binding?.source === 'user' || binding?.source === 'removed'
      const command = <td className="shortcuts-command" title={`${row.title}\n${row.id}`}>
        {changed ? <span className="shortcuts-dot" role="img" aria-label="Changed" title="Changed: saved when you choose OK" /> : <span className="shortcuts-nodot" />}
        {match.first ? <><span className="shortcuts-command-title">{row.title}</span><span className="shortcuts-muted shortcuts-command-id">{row.id}</span></> : <span className="shortcuts-muted">{row.title}</span>}
      </td>
      const source = <td className="shortcuts-source-cell">
        <SourceChip source={binding?.source ?? (row.lock ? row.lock.source : 'unbound')} lock={row.lock?.reason} />
        {binding && changed && !byPlatform && <button type="button" className="shortcuts-reset" tabIndex={-1} aria-label={`Reset ${binding.label.text} for ${row.title}`} onClick={event => { event.stopPropagation(); onReset(binding) }}>Reset</button>}
      </td>
      const cells = byPlatform
        ? allPlatforms.map(item => {
          const keys = byPlatform[item].get(row.id)?.bindings.filter(entry => entry.source !== 'removed') ?? []
          return <td key={item}>{keys.length ? keys.map((entry, index) => <KeyCaps key={index} label={entry.label} source={entry.source} />) : <span className="shortcuts-muted" title="Not bound on this platform">—</span>}</td>
        })
        : [<td key="keys">{binding ? <KeyCaps label={binding.label} source={binding.source} /> : <span className="shortcuts-muted">—</span>}</td>,
          <td key="scope" title={binding?.rule.whenSource ? `When: ${binding.rule.whenSource}` : undefined}>{binding ? binding.scopeTitle : <span className="shortcuts-muted">—</span>}</td>]
      rows.push(<tr key={key} data-row={key} aria-selected={isSelected} tabIndex={isSelected ? 0 : -1} data-locked={row.lock ? true : undefined}
        onClick={() => onSelect(selection)} onFocus={() => { if (!isSelected) onSelect(selection) }}>{command}{cells}{source}</tr>)
    }
  }
  if (gestures?.length) {
    rows.push(<tr key="group:mouse" className="shortcuts-group"><th colSpan={columns.length} scope="colgroup">Mouse</th></tr>)
    for (const gesture of gestures) rows.push(<tr key={'gesture:' + gesture.id} className="shortcuts-gesture" onClick={onShowMouse} title="Choose to open the Mouse view">
      <td className="shortcuts-command">{gesture.changed ? <span className="shortcuts-dot" role="img" aria-label="Changed" /> : <span className="shortcuts-nodot" />}<span className="shortcuts-command-title">{gesture.title}</span></td>
      {byPlatform ? <td colSpan={allPlatforms.length}>{gesture.label}</td> : <><td>{gesture.label}</td><td>{gesture.scopeTitle}</td></>}
      <td className="shortcuts-source-cell"><SourceChip source={gesture.locked ? 'builtin' : gesture.changed ? 'user' : 'default'} lock={gesture.locked} /></td>
    </tr>)
  }
  if (builtIn) {
    rows.push(<tr key="group:builtin" className="shortcuts-group"><th colSpan={columns.length} scope="colgroup">
      <button type="button" className="shortcuts-group-toggle" aria-expanded={builtIn.open} onClick={builtIn.onToggle}><Icon name="chevron-right" />Built in: fixed keys of the grid, the tree and the designer (read only)</button>
    </th></tr>)
    if (builtIn.open) intrinsicKeys.forEach((entry, index) => {
      const keys = entry.key === undefined ? <kbd>{entry.label}</kbd> : <KeyCaps label={keybindingLabel(parseKeySpec(entry.key, platform), platform)} source="builtin" />
      rows.push(<tr key={'builtin:' + index} className="shortcuts-builtin">
        <td className="shortcuts-command"><span className="shortcuts-nodot" /><span className="shortcuts-muted">{entry.title}</span></td>
        {byPlatform ? <td colSpan={allPlatforms.length}>{keys}</td> : <><td>{keys}</td><td>{shortcutScope(entry.scope).title}</td></>}
        <td className="shortcuts-source-cell" title="Fixed by the grid, the tree or the designer. Shown so you can see what a new shortcut would shadow."><SourceChip source="builtin" /></td>
      </tr>)
    })
  }
  return <div className="shortcuts-table">
    <table ref={body} role="grid" aria-label="Shortcuts" aria-rowcount={-1} data-platforms={byPlatform ? true : undefined} onKeyDown={keyDown}>
      <thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
      <tbody>{rows}{!groups.length && empty && <tr><td colSpan={columns.length} className="shortcuts-empty">{empty}</td></tr>}</tbody>
    </table>
  </div>
}
