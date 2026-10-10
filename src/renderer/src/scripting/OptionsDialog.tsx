import { useState, type KeyboardEvent } from 'react'
import type { ScriptingOptionKey } from '../../../shared/scripting/options.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { trapFocus } from '../trap-focus'
import { optionCategories, optionDescription, resetOptions, setOption, validateOptions } from './options-form'

const errorText = (error: unknown) => error instanceof Error && error.message ? error.message : 'The options could not be saved.'
const rowId = (key: ScriptingOptionKey) => `scripting-option-${key}`

/**
 * SSMS's Tools › Options with its one page so far, SQL Server Object Explorer › Scripting: a property list in four
 * categories, a value that differs from its default in bold, and the focused row's description below. Changes stay in
 * the dialog until OK stores them; Escape is Cancel, and focus returns to where it was.
 */
export default function OptionsDialog() {
  const { scriptingOptions } = useWorkbench()
  const { options } = useServiceSnapshot(scriptingOptions)
  const [draft, setDraft] = useState(options)
  const [focused, setFocused] = useState<ScriptingOptionKey>('delimitStatements')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // Read while rendering, before the first select takes focus.
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const close = () => {
    scriptingOptions.closeDialog()
    if (returnFocus?.isConnected) returnFocus.focus()
  }
  const ok = async () => {
    if (saving) return
    const result = validateOptions(draft)
    if (!result.ok) { setError(result.error); return }
    setSaving(true); setError('')
    try {
      await scriptingOptions.save(result.options)
      close()
    } catch (failure) { setError(errorText(failure)); setSaving(false) }
  }
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    // A select keeps Enter (it opens the list on macOS), and buttons act on it themselves.
    else if (event.key === 'Enter' && !(event.target instanceof HTMLSelectElement) && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); void ok() }
  }
  const described = optionDescription(focused)
  // Focusable itself, so pressing a greyed row, a label or the description keeps focus (and Escape and Enter) in the dialog.
  return <div className="modal-backdrop"><form className="connection-modal options-dialog" role="dialog" aria-modal="true" aria-labelledby="options-title" noValidate tabIndex={-1}
    onSubmit={event => { event.preventDefault(); void ok() }} onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id="options-title">Options</h2><button type="button" className="icon-button" aria-label="Close options" onClick={close}><Icon name="close" /></button></div>
    <div className="options-body">
      <nav className="options-pages" aria-label="Options pages">
        <ul><li><span>SQL Server Object Explorer</span><ul><li aria-current="page">Scripting</li></ul></li></ul>
      </nav>
      <div className="options-list" role="group" aria-label="Scripting">
        {optionCategories(draft).map(category => <div key={category.group} role="group" aria-labelledby={`scripting-group-${category.group}`}>
          <div className="options-category" id={`scripting-group-${category.group}`}>{category.label}</div>
          {/* A greyed row cannot take focus, so pressing it (or its label) shows its description, as selecting one does in SSMS. */}
          {category.rows.map(row => <div key={row.key} className="options-row" data-focused={row.key === focused || undefined} onPointerDown={() => setFocused(row.key)}>
            <label htmlFor={rowId(row.key)} title={row.label}>{row.label}</label>
            <select id={rowId(row.key)} value={row.value} disabled={row.disabled} data-changed={row.changed || undefined} autoFocus={row.key === 'delimitStatements'}
              aria-description={optionDescription(row.key).description} onFocus={() => setFocused(row.key)}
              onChange={event => { const value = event.target.value; setDraft(current => setOption(current, row.key, value)); setError('') }}>
              {row.choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          </div>)}
        </div>)}
      </div>
    </div>
    <div className="options-description"><strong>{described.label}</strong><p>{described.description}</p></div>
    {error && <p className="connect-error options-error" role="alert">{error}</p>}
    <div className="connection-footer">
      <button type="button" onClick={() => { setDraft(resetOptions()); setError('') }}>Reset to Defaults</button><span />
      <button className="primary" type="submit" disabled={saving}>OK</button><button type="button" onClick={close}>Cancel</button>
    </div>
  </form></div>
}
