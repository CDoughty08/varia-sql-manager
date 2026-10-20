import type { ReactNode } from 'react'

/**
 * One row of a property grid: its label and description, and its control's value as text. 'choice' is a list,
 * 'integer' a number field, 'combo' an editable field with suggestions (Max DOP for Secondary: PRIMARY or a number),
 * 'text' an editable field, and 'readonly' a value that cannot change. `changed` makes it bold. A row with `parent`
 * shows only while that row is `expanded`.
 */
export interface GridRow {
  readonly key: string
  readonly label: string
  readonly description: string
  readonly control: 'integer' | 'choice' | 'combo' | 'text' | 'readonly'
  readonly value: string
  readonly choices?: readonly { readonly value: string; readonly label: string }[]
  readonly min?: number
  readonly max?: number
  readonly changed: boolean
  readonly disabled: boolean
  readonly parent?: string
  readonly expanded?: boolean
}
export interface GridGroup { readonly label?: string; readonly rows: readonly GridRow[] }

export interface PropertyGridProps {
  /** Names the grid for assistive technology: the page title. */
  readonly label: string
  readonly groups: readonly GridGroup[]
  /** SSMS's Categorized (the groups) or Alphabetical (one list by label) view. */
  readonly order?: 'categorized' | 'alphabetical'
  /** Prefixes every control's id, so two grids never share one. */
  readonly idPrefix: string
  /** The row whose description shows; it is highlighted. */
  readonly focused?: string
  /** Messages of fields whose value cannot be saved, by key. */
  readonly errors?: ReadonlyMap<string, string>
  onFocusRow(key: string): void
  onChange(key: string, text: string): void
  /** Expands or collapses a row with child rows. */
  onToggle?(key: string): void
  /** A label as it shows: search matches highlighted. */
  renderLabel?(label: string): ReactNode
  /** The first row takes focus when the grid appears. */
  readonly autoFocus?: boolean
}

/** A control's id: the prefix and the key, dots as dashes (Tools › Options uses 'setting-'). */
export const controlId = (key: string, idPrefix = 'setting-') => idPrefix + key.replaceAll('.', '-')

function Control({ row, id, error, onFocus, onChange, autoFocus }: { row: GridRow; id: string; error?: string; onFocus(): void; onChange(text: string): void; autoFocus?: boolean }) {
  const common = { id, disabled: row.disabled, 'data-changed': row.changed || undefined, 'data-setting': row.key, 'aria-description': row.description, onFocus, autoFocus }
  const invalid = { 'aria-invalid': error ? true : undefined, 'aria-errormessage': error ? id + '-error' : undefined }
  if (row.control === 'integer') {
    return <input {...common} type="number" step={1} min={row.min} max={row.max} value={row.value} {...invalid} onChange={event => onChange(event.target.value)} />
  }
  if (row.control === 'combo') {
    return <><input {...common} type="text" list={id + '-list'} value={row.value} {...invalid} onChange={event => onChange(event.target.value)} />
      <datalist id={id + '-list'}>{row.choices?.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</datalist></>
  }
  if (row.control === 'text') return <input {...common} type="text" value={row.value} {...invalid} onChange={event => onChange(event.target.value)} />
  if (row.control === 'readonly') return <input {...common} type="text" readOnly value={row.choices?.find(choice => choice.value === row.value)?.label ?? row.value} />
  return <select {...common} value={row.value} onChange={event => onChange(event.target.value)}>
    {row.choices?.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
  </select>
}

const byLabel = (a: GridRow, b: GridRow) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' })

/**
 * SSMS's property grid: categories, then one row per property with its name and value. A changed value is bold, and a
 * greyed row cannot change. Stateless: the dialog owns the draft, the focused row and which rows are expanded.
 */
export default function PropertyGrid({ label, groups, order = 'categorized', idPrefix, focused, errors, onFocusRow, onChange, onToggle, renderLabel = text => text, autoFocus }: PropertyGridProps) {
  const shown: readonly GridGroup[] = order === 'alphabetical' ? [{ rows: groups.flatMap(group => group.rows).sort(byLabel) }] : groups
  const expanded = new Set(shown.flatMap(group => group.rows).filter(row => row.expanded).map(row => row.key))
  const first = shown[0]?.rows[0]?.key
  return <div className="options-list" role="group" aria-label={label}>
    {shown.map((group, index) => <div key={group.label ?? index} role="group" aria-label={group.label}>
      {group.label && <div className="options-category">{group.label}</div>}
      {/* A greyed row cannot take focus, so pressing it (or its label) shows its description, as selecting one does in SSMS. */}
      {group.rows.filter(row => row.parent === undefined || expanded.has(row.parent)).map(row => {
        const error = errors?.get(row.key), id = controlId(row.key, idPrefix)
        const name = <label htmlFor={id} title={row.label}>{renderLabel(row.label)}</label>
        return <div key={row.key} className="options-row" data-focused={row.key === focused || undefined} data-child={row.parent !== undefined || undefined} onPointerDown={() => onFocusRow(row.key)}>
          {row.expanded === undefined ? name : <span className="property-parent">
            <button type="button" className="property-twisty" aria-expanded={row.expanded} aria-label={(row.expanded ? 'Collapse ' : 'Expand ') + row.label} onClick={() => onToggle?.(row.key)}>
              <span className={`codicon codicon-chevron-${row.expanded ? 'down' : 'right'}`} aria-hidden="true" /></button>{name}</span>}
          <Control row={row} id={id} error={error} onFocus={() => onFocusRow(row.key)} onChange={text => onChange(row.key, text)} autoFocus={autoFocus && row.key === first} />
          {error && <span className="options-field-error" id={id + '-error'}>{error}</span>}
        </div>
      })}
    </div>)}
  </div>
}
