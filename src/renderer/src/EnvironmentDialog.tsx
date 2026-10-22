import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { environmentPreset, environmentPresets, maxEnvironmentLength } from '../../shared/environments'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import EnvironmentTag from './EnvironmentTag'
import Icon from './Icon'
import { applyEnvironment, parseEnvironment } from './services/environments'
import { trapFocus } from './trap-focus'

interface FieldProps {
  /** The select's id; the custom label's box is `${id}-custom`. */
  readonly id: string
  readonly value: string | undefined
  readonly disabled?: boolean
  /** undefined is None; a custom label is passed on as typed ('' until one is typed), for the caller to check (parseEnvironment). */
  onChange(value: string | undefined): void
}

/**
 * The environment of a connection: <none>, a preset, or Custom with a label of up to 32 characters. The Connect
 * dialog's Custom Properties and the server's Environment dialog both use it.
 */
export function EnvironmentField({ id, value, disabled, onChange }: FieldProps) {
  const [custom, setCustom] = useState(() => !!value?.trim() && !environmentPreset(value))
  // A profile chosen from history, a saved entry matched by the typed server, or Reset replaces the value from outside:
  // a preset then shows as itself, never as a Custom label that spells it. What the field passed on itself (a Custom
  // label being typed, even one that spells a preset) keeps the field as it is.
  const emitted = useRef(value)
  const emit = (next: string | undefined) => { emitted.current = next; onChange(next) }
  useEffect(() => {
    if (value === emitted.current) return
    emitted.current = value
    setCustom(!!value?.trim() && !environmentPreset(value))
  }, [value])
  const choice = custom ? 'custom' : environmentPreset(value) ?? ''
  return <div className="property-input-action environment-field">
    <select id={id} value={choice} disabled={disabled} onChange={event => {
      const next = event.target.value
      setCustom(next === 'custom')
      emit(next === 'custom' ? '' : next || undefined)
    }}>
      <option value="">{'<none>'}</option>
      {environmentPresets.map(preset => <option key={preset} value={preset}>{preset}</option>)}
      <option value="custom">Custom…</option>
    </select>
    {custom && <input id={`${id}-custom`} aria-label="Custom environment label" placeholder="Label, such as UAT" maxLength={maxEnvironmentLength} disabled={disabled} autoComplete="off" spellCheck={false}
      value={value ?? ''} onChange={event => emit(event.target.value)} />}
  </div>
}

/**
 * Object Explorer's Environment… for a connected server: the same field, saved with the connection's entry in
 * connections.json and shown at once on every connection to it. Cancel and Escape change nothing; focus goes back to
 * where the command came from.
 */
export default function EnvironmentDialog({ connectionId, onClose }: { readonly connectionId: string; onClose(): void }) {
  const { connections } = useWorkbench()
  const connection = useServiceSnapshot(connections).find(value => value.id === connectionId)
  const [value, setValue] = useState(connection?.options.environment)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const form = useRef<HTMLFormElement>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; form.current?.querySelector<HTMLSelectElement>('select')?.focus(); return () => { alive.current = false } }, [])
  const close = () => { onClose(); if (returnFocus?.isConnected) returnFocus.focus() }
  const parsed = parseEnvironment(value)
  const ok = async () => {
    if (busy || !parsed.ok) return
    setBusy(true); setError('')
    const outcome = await applyEnvironment({ connections, setEnvironment: input => window.varia.setConnectionEnvironment(input) }, connectionId, value)
    if (!alive.current) return
    setBusy(false)
    if (outcome.ok) close()
    else setError(outcome.error)
  }
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); close() }
  }
  const server = connection ? connection.displayName ? `${connection.displayName} (${connection.server})` : connection.server : ''
  return <div className="modal-backdrop"><form ref={form} className="connection-modal environment-dialog" role="dialog" aria-modal="true" aria-labelledby="environment-title" aria-describedby="environment-server" noValidate
    onSubmit={event => { event.preventDefault(); void ok() }} onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id="environment-title">Connection Environment</h2><button type="button" className="icon-button" aria-label="Close Connection Environment" disabled={busy} onClick={close}><Icon name="close" /></button></div>
    <div className="connection-scroll">
      <p className="field-note" id="environment-server">{connection ? server : 'This server is no longer connected.'}</p>
      <div className="property-grid">
        <div className="property-row"><label htmlFor="environment-choice">Environment</label><EnvironmentField id="environment-choice" value={value} disabled={busy || !connection} onChange={next => { setValue(next); setError('') }} /></div>
        <div className="property-row"><span />{parsed.ok ? parsed.environment ? <span className="environment-preview"><span>Shown as</span><EnvironmentTag environment={parsed.environment} place="list" /></span> : <span className="field-note">No environment tag.</span> : <p className="field-note" id="environment-hint">{parsed.error}</p>}</div>
      </div>
      <p className="field-note">Saved with this connection in Varia on this computer. Production shows a red PROD tag on the server, its query tabs and the status bars, beside the connection colour.</p>
      {error && <p className="connect-error" role="alert">{error}</p>}
    </div>
    <div className="connection-footer"><span /><button className="primary" type="submit" disabled={busy || !connection || !parsed.ok}>OK</button><button type="button" disabled={busy} onClick={close}>Cancel</button></div>
  </form></div>
}
