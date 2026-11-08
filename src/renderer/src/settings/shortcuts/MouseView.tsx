// A stub of lane D2's Mouse view (the shortcuts contract): the Shortcuts page's Mouse segment. D2 replaces this file
// with the modifier choices; it keeps the props.
import type { Platform } from '../../../../shared/commands/keybindings'
import type { ShortcutFile } from '../../../../shared/commands/shortcut-schema'
import { gestureRows } from './gesture-rows'

export interface MouseViewProps {
  readonly draft: ShortcutFile
  readonly onChange: (next: ShortcutFile) => void
  readonly platform: Platform
  readonly search: string
}

/** The gestures as a read-only list until the Mouse view lands. */
export function MouseView({ draft, platform, search }: MouseViewProps) {
  const rows = gestureRows(draft, platform, search)
  return <ul className="shortcuts-mouse" aria-label="Mouse shortcuts">
    {rows.map(row => <li key={row.id}><span>{row.title}</span><span className="shortcuts-muted">{row.label} · {row.scopeTitle}</span></li>)}
  </ul>
}
export default MouseView
