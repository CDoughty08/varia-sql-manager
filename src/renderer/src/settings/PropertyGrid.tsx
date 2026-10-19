import type { ReactNode } from 'react'
import type { RowGroup, SettingRow } from './options-form'

export interface PropertyGridProps {
  /** Names the grid for assistive technology: the page title. */
  readonly label: string
  readonly groups: readonly RowGroup[]
  /** The row whose description shows; it is highlighted. */
  readonly focused?: string
  /** Messages of fields whose value cannot be saved, by key. */
  readonly errors?: ReadonlyMap<string, string>
  onFocusRow(key: string): void
  onChange(key: string, text: string): void
  /** A label as it shows: search matches highlighted. */
  renderLabel?(label: string): ReactNode
  /** The first row takes focus when the grid appears. */
  readonly autoFocus?: boolean
}

export const controlId = (key: string) => 'setting-' + key.replaceAll('.', '-')

function Control({ row, error, onFocus, onChange, autoFocus }: { row: SettingRow; error?: string; onFocus(): void; onChange(text: string): void; autoFocus?: boolean }) {
  const common = { id: controlId(row.key), disabled: row.disabled, 'data-changed': row.changed || undefined, 'data-setting': row.key, 'aria-description': row.def.description, onFocus, autoFocus }
  if (row.def.type === 'integer') {
    return <input {...common} type="number" step={1} min={row.def.min} max={row.def.max} value={row.value} aria-invalid={error ? true : undefined}
      aria-errormessage={error ? controlId(row.key) + '-error' : undefined} onChange={event => onChange(event.target.value)} />
  }
  return <select {...common} value={row.value} onChange={event => onChange(event.target.value)}>
    {row.choices?.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
  </select>
}

/**
 * SSMS's property grid: categories, then one row per setting with its name and value (True/False lists for booleans, a
 * list for choices, a number field for integers). A value that differs from its default is bold, and a row whose
 * setting depends on another is greyed. Stateless: the dialog owns the draft and the focused row.
 */
export default function PropertyGrid({ label, groups, focused, errors, onFocusRow, onChange, renderLabel = text => text, autoFocus }: PropertyGridProps) {
  const first = groups[0]?.rows[0]?.key
  return <div className="options-list" role="group" aria-label={label}>
    {groups.map((group, index) => <div key={group.label ?? index} role="group" aria-label={group.label}>
      {group.label && <div className="options-category">{group.label}</div>}
      {/* A greyed row cannot take focus, so pressing it (or its label) shows its description, as selecting one does in SSMS. */}
      {group.rows.map(row => {
        const error = errors?.get(row.key)
        return <div key={row.key} className="options-row" data-focused={row.key === focused || undefined} onPointerDown={() => onFocusRow(row.key)}>
          <label htmlFor={controlId(row.key)} title={row.def.label}>{renderLabel(row.def.label)}</label>
          <Control row={row} error={error} onFocus={() => onFocusRow(row.key)} onChange={text => onChange(row.key, text)} autoFocus={autoFocus && row.key === first} />
          {error && <span className="options-field-error" id={controlId(row.key) + '-error'}>{error}</span>}
        </div>
      })}
    </div>)}
  </div>
}
