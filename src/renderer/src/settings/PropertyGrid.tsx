import type { ReactNode } from 'react'
import { propertyGridAttribute, visibleGridRows } from './grid-rows'
import Icon from '../Icon'
import Switch from '../kit/Switch'

/**
 * One row of a property grid: its label and description, and its control's value as text. 'choice' is a list,
 * 'boolean' a 1-click switch with True/False, 'integer' a number field, 'combo' an editable field with suggestions
 * (Max DOP for Secondary: PRIMARY or a number), 'text' an editable field, and 'readonly' a value that cannot change.
 * `changed` marks customized rows. A row with `parent` shows only while that row is `expanded`.
 */
export interface GridRow {
  readonly key: string
  readonly label: string
  readonly description: string
  readonly control: 'integer' | 'choice' | 'boolean' | 'combo' | 'text' | 'readonly'
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
  /** Opts the fields into the shared control styling at the chosen size. */
  readonly fieldSize?: 'dense'
  /** The row whose description shows; it is highlighted. */
  readonly focused?: string
  /** Messages of fields whose value cannot be saved, by key. */
  readonly errors?: ReadonlyMap<string, string>
  onFocusRow(key: string): void
  onHoverRow?(key: string | undefined): void
  onChange(key: string, text: string): void
  /** Resets one row back to its default. */
  onResetRow?(key: string): void
  /** Expands or collapses a row with child rows. */
  onToggle?(key: string): void
  /** A label as it shows: search matches highlighted. */
  renderLabel?(label: string): ReactNode
  /** The first row takes focus when the grid appears. */
  readonly autoFocus?: boolean
}

/** A control's id: the prefix and the key, dots as dashes (Tools › Options uses 'setting-'). */
export const controlId = (key: string, idPrefix = 'setting-') => idPrefix + key.replaceAll('.', '-')

function Control({ row, id, error, onFocus, onChange, autoFocus, fieldSize }: { row: GridRow; id: string; error?: string; onFocus(): void; onChange(text: string): void; autoFocus?: boolean; fieldSize?: PropertyGridProps['fieldSize'] }) {
  const common = { id, disabled: row.disabled, className: fieldSize ? 'ui-field' : undefined, 'data-control-size': fieldSize, 'data-changed': row.changed || undefined, 'data-setting': row.key, 'aria-description': row.description, onFocus, autoFocus }
  const invalid = { 'aria-invalid': error ? true : undefined, 'aria-errormessage': error ? id + '-error' : undefined }
  if (row.control === 'boolean') {
    return <Switch id={id} checked={row.value === 'true'} disabled={row.disabled} changed={row.changed} states={{ on: 'True', off: 'False' }} data-setting={row.key} aria-description={row.description} onFocus={onFocus} autoFocus={autoFocus} onChange={checked => onChange(String(checked))} />
  }
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

/**
 * SSMS's property grid: categories, then one row per property with its name and value. A changed value is marked, and a
 * greyed row cannot change. Stateless: the dialog owns the draft, the focused row and which rows are expanded.
 */
export default function PropertyGrid({ label, groups, order = 'categorized', idPrefix, fieldSize, focused, errors, onFocusRow, onHoverRow, onChange, onResetRow, onToggle, renderLabel = text => text, autoFocus }: PropertyGridProps) {
  const shown = visibleGridRows(groups, order)
  const first = shown[0]?.rows[0]?.key
  return <div className="options-list" role="group" aria-label={label} {...{ [propertyGridAttribute]: '' }} onPointerLeave={() => onHoverRow?.(undefined)}>
    {shown.map((group, index) => <div key={group.label ?? index} role="group" aria-label={group.label}>
      {group.label && <div className="options-category">{group.label}</div>}
      {/* A greyed row cannot take focus, so pressing it (or its label) shows its description, as selecting one does in SSMS. */}
      {group.rows.map(row => {
        const error = errors?.get(row.key), id = controlId(row.key, idPrefix)
        const name = <label htmlFor={id} title={row.label}>{renderLabel(row.label)}</label>
        return <div key={row.key} className="options-row" data-focused={row.key === focused || undefined} data-changed={row.changed || undefined} data-child={row.parent !== undefined || undefined} onPointerDown={() => onFocusRow(row.key)} onPointerEnter={() => onHoverRow?.(row.key)}>
          <span className="options-row-name">
            {row.changed && <span className="options-row-dot" aria-hidden="true" />}
            {row.expanded === undefined ? name : <span className="property-parent">
              <button type="button" className="property-twisty" aria-expanded={row.expanded} aria-label={(row.expanded ? 'Collapse ' : 'Expand ') + row.label} onClick={() => onToggle?.(row.key)}>
                <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} /></button>{name}</span>}
          </span>
          <div className="options-row-control">
            <Control row={row} id={id} error={error} onFocus={() => onFocusRow(row.key)} onChange={text => onChange(row.key, text)} autoFocus={autoFocus && row.key === first} fieldSize={fieldSize} />
            {onResetRow && row.changed && <button type="button" className="ui-button icon-button options-row-reset" aria-label={`Reset ${row.label}`} title={`Reset ${row.label} to default`} tabIndex={-1} onClick={event => { event.stopPropagation(); onResetRow(row.key) }}><Icon name="discard" /></button>}
          </div>
          {error && <span className="options-field-error" id={id + '-error'}>{error}</span>}
        </div>
      })}
    </div>)}
  </div>
}
