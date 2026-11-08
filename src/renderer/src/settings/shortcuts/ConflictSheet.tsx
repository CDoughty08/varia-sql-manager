import { useId, type KeyboardEvent, type ReactNode } from 'react'
import { commandDescriptor } from '../../../../shared/commands/catalog'
import type { ShortcutVerdict } from '../../../../shared/commands/conflicts'
import type { KeybindingLabel } from '../../../../shared/commands/keybindings'
import { shortcutScope, type ScopeId } from '../../../../shared/commands/scopes'
import { trapFocus } from '../../trap-focus'
import { KeyCaps } from './CaptureField'
import { ruleScope, scopeTitle } from './shortcut-draft'

interface SheetProps {
  readonly title: string
  /** `alertdialog` for a question about something that just happened; `dialog` for a form. */
  readonly role?: 'alertdialog' | 'dialog'
  readonly onCancel: () => void
  readonly children: ReactNode
  readonly className?: string
}
/**
 * A sheet over the Shortcuts page, inside Options: Tab stays in it, and Escape cancels it without closing Options. Its
 * first button takes focus.
 */
export function Sheet({ title, role = 'alertdialog', onCancel, children, className }: SheetProps) {
  const id = useId()
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') { trapFocus(event); event.stopPropagation() }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
    // Enter presses the focused button; it never reaches Options' OK.
    else if (event.key === 'Enter') event.stopPropagation()
  }
  return <div className="shortcuts-scrim">
    <div className={'shortcuts-sheet' + (className ? ' ' + className : '')} role={role} aria-modal="true" aria-labelledby={id} tabIndex={-1} onKeyDown={keyDown}>
      <h4 id={id}>{title}</h4>
      {children}
    </div>
  </div>
}

interface Props {
  readonly label: KeybindingLabel
  /** The title of the command being assigned. */
  readonly commandTitle: string
  readonly scope: ScopeId
  readonly verdict: ShortcutVerdict
  readonly onReassign: () => void
  readonly onNarrower: (scope: ScopeId) => void
  readonly onCancel: () => void
}

/**
 * Assign found the key in use where the new shortcut would apply. A key does one thing in a scope, so the choices are
 * to take it from the other command (staged as a removal, undone by Reset), to use a narrower scope where the new one
 * wins, or to cancel. There is no "keep both": effective rules never overlap.
 */
export default function ConflictSheet({ label, commandTitle: title, scope, verdict, onReassign, onNarrower, onCancel }: Props) {
  const others = [...new Set(verdict.conflicts.map(rule => `${commandDescriptor(rule.command).title} (${scopeTitle(ruleScope(rule))})`))]
  const narrower = verdict.narrowerScopes[0]
  return <Sheet title={`${label.text} is already used`} onCancel={onCancel}>
    <p>{others.join(', ')} {others.length > 1 ? 'use' : 'uses'} <KeyCaps label={label} /> where {title} would ({shortcutScope(scope).title}). In a scope a key does one thing.</p>
    <ul className="shortcuts-sheet-options">
      <li><strong>Reassign</strong>: {title} gets {label.text}; {others.length > 1 ? 'they lose it' : `${commandDescriptor(verdict.conflicts[0].command).title} loses it`} (undone by Reset).</li>
      {narrower && <li><strong>Use {shortcutScope(narrower).title}</strong>: {title} gets {label.text} only there, where it wins; elsewhere the key keeps its command.</li>}
    </ul>
    <div className="shortcuts-sheet-actions">
      <button type="button" className="primary" autoFocus onClick={onReassign}>Reassign</button>
      {narrower && <button type="button" onClick={() => onNarrower(narrower)}>Use {shortcutScope(narrower).title}</button>}
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </Sheet>
}
