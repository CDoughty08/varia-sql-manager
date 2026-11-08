import { useState, type ReactNode } from 'react'
import { commandDescriptor } from '../../../../shared/commands/catalog'
import type { ShortcutVerdict } from '../../../../shared/commands/conflicts'
import { keybindingLabel, type Platform } from '../../../../shared/commands/keybindings'
import { shortcutScopes, type ScopeId } from '../../../../shared/commands/scopes'
import type { ShortcutFile } from '../../../../shared/commands/shortcut-schema'
import Icon from '../../Icon'
import type { IconId } from '../../../../shared/icons'
import CaptureField, { KeyCaps, type CaptureSource } from './CaptureField'
import ConflictSheet from './ConflictSheet'
import { assignShortcut, removeRule, resetCommand, restoreRule, ruleScope, scopeTitle, verdictFor, type CommandRow } from './shortcut-draft'

/** The id of the "Press shortcut keys" box, which Enter on a table row focuses. */
export const captureFieldId = 'shortcuts-capture'

type MessageKind = ShortcutVerdict['verdict'] | 'info' | 'pending'
const messageIcons: Readonly<Record<MessageKind, IconId>> = { ok: 'pass', warning: 'warning', shadow: 'layers', conflict: 'warning', refused: 'error', info: 'info', pending: 'info' }
export function Message({ kind, children }: { readonly kind: MessageKind; readonly children: ReactNode }) {
  return <p className="shortcuts-message" data-kind={kind} role={kind === 'refused' ? 'alert' : 'status'}><Icon name={messageIcons[kind]} /><span>{children}</span></p>
}

interface Props {
  readonly row: CommandRow
  readonly draft: ShortcutFile
  readonly platform: Platform
  readonly onChange: (next: ShortcutFile) => void
  readonly capture?: CaptureSource
}

/**
 * SSMS's Keyboard page below the table, with its labels: the selected command's shortcuts (each with Remove, or Restore
 * for a removed default), "Use new shortcut in", "Press shortcut keys" with Assign, and "Shortcut currently used by".
 * The verdict under them is `validateShortcut`'s, checked as keys are pressed; Assign stages the shortcut.
 */
export default function Inspector({ row, draft, platform, onChange, capture }: Props) {
  const [scope, setScope] = useState<ScopeId>('global')
  const [chords, setChords] = useState<readonly string[]>([])
  const [sheet, setSheet] = useState<ShortcutVerdict>()
  const verdict = chords.length ? verdictFor(draft, row.id, chords, scope, platform) : undefined
  const label = chords.length ? keybindingLabel(chords, platform) : undefined
  const locked = row.lock !== undefined
  const commit = (next: ShortcutFile) => { onChange(next); setChords([]); setSheet(undefined) }
  const assign = () => {
    if (!verdict || verdict.verdict === 'refused') return
    if (verdict.verdict === 'conflict') { setSheet(verdict); return }
    commit(assignShortcut(draft, row.id, chords, scope, platform))
  }
  const used = verdict ? [...verdict.conflicts, ...verdict.shadows.map(shadow => shadow.rule)] : []
  const describedBy = 'shortcuts-capture-hint'
  return <section className="shortcuts-inspector" aria-label={`Shortcuts for ${row.title}`}>
    <div className="shortcuts-inspector-head"><strong>{row.title}</strong><span className="shortcuts-muted">{row.id}</span></div>
    {row.lock && <Message kind="info"><strong>{row.lock.source === 'editor' ? 'Editor key.' : row.lock.source === 'dialog' ? 'Dialog key.' : 'System key.'}</strong> {row.lock.reason}</Message>}
    <div className="shortcuts-inspector-columns">
      <div className="shortcuts-field">
        <span id="shortcuts-list-label">Shortcuts for selected command:</span>
        <ul className="shortcuts-list" aria-labelledby="shortcuts-list-label">
          {row.bindings.length ? row.bindings.map((binding, index) => <li key={index}>
            <KeyCaps label={binding.label} source={binding.source} />
            <span className="shortcuts-muted">{binding.scopeTitle}{binding.source === 'removed' ? ' · removed' : binding.source === 'user' ? ' · yours' : ''}</span>
            {row.lock ? <span className="shortcuts-lock" title={row.lock.reason}><Icon name="lock" /></span>
              : binding.source === 'removed' ? <button type="button" aria-label={`Restore ${binding.label.text}`} onClick={() => onChange(restoreRule(draft, binding.rule, platform))}>Restore</button>
                : <button type="button" aria-label={`Remove ${binding.label.text}`} onClick={() => onChange(removeRule(draft, binding.rule, platform))}>Remove</button>}
          </li>) : <li className="shortcuts-muted">No shortcuts</li>}
        </ul>
        <div><button type="button" disabled={!row.changed} onClick={() => onChange(resetCommand(draft, row.id, platform))}><Icon name="discard" />Reset command</button></div>
      </div>
      <fieldset className="shortcuts-new" disabled={locked}>
        <legend className="visually-hidden">New shortcut</legend>
        <div className="shortcuts-field">
          <label htmlFor="shortcuts-scope">Use new shortcut in:</label>
          <select id="shortcuts-scope" value={scope} onChange={event => setScope(event.target.value as ScopeId)}>
            {shortcutScopes.map(preset => <option key={preset.id} value={preset.id}>{preset.title}</option>)}
          </select>
        </div>
        <div className="shortcuts-field">
          <label htmlFor={captureFieldId}>Press shortcut keys:</label>
          <div className="shortcuts-capture-row">
            <CaptureField id={captureFieldId} platform={platform} value={chords} onChange={setChords} capture={capture} label="Press shortcut keys" describedBy={describedBy} />
            <button type="button" className={verdict && verdict.verdict !== 'refused' ? 'primary' : undefined} disabled={!verdict || verdict.verdict === 'refused'} onClick={assign}>Assign</button>
          </div>
          <span id={describedBy} className="shortcuts-muted">Tab leaves the box; every other key is recorded, Escape and Enter included. {platform === 'darwin' ? '⌘K' : 'Ctrl+K'} starts a two-part shortcut.</span>
        </div>
        <div className="shortcuts-field">
          <span id="shortcuts-used-label">Shortcut currently used by:</span>
          <ul className="shortcuts-used" aria-labelledby="shortcuts-used-label">
            {used.map((rule, index) => <li key={index}>{commandDescriptor(rule.command).title} <span className="shortcuts-muted">({scopeTitle(ruleScope(rule))})</span></li>)}
            {verdict && !used.length && <li className="shortcuts-muted">none</li>}
          </ul>
        </div>
      </fieldset>
    </div>
    {verdict && <Message kind={verdict.verdict}>{verdict.message}{verdict.warnings.filter(warning => warning !== verdict.message).map(warning => <span key={warning} className="shortcuts-message-more">{warning}</span>)}</Message>}
    {sheet && label && <ConflictSheet label={label} commandTitle={row.title} scope={scope} verdict={sheet}
      onReassign={() => commit(assignShortcut(draft, row.id, chords, scope, platform, sheet.conflicts))}
      onNarrower={narrower => { setScope(narrower); commit(assignShortcut(draft, row.id, chords, narrower, platform)) }}
      onCancel={() => setSheet(undefined)} />}
  </section>
}
