import type { ReactNode } from 'react'

/** The parts of a field besides its control: what it does, why it is greyed, and what is wrong with its value. */
export interface FieldText { readonly description?: string; readonly note?: string; readonly error?: string }

/**
 * The ARIA a field's control carries: its description and note as its description, and its error as its error message.
 * The description stays in the DOM while it is hidden, so it is read whether or not it shows.
 */
export function fieldAria(id: string, { description, note, error }: FieldText): { 'aria-describedby'?: string; 'aria-invalid'?: true; 'aria-errormessage'?: string } {
  const described = [description && `${id}-description`, note && `${id}-note`].filter(Boolean).join(' ')
  return { ...described ? { 'aria-describedby': described } : {}, ...error ? { 'aria-invalid': true, 'aria-errormessage': `${id}-error` } : {} }
}

interface Props extends FieldText {
  /** The control's id; the label points at it, and the texts take ids from it. */
  readonly id: string
  readonly label: string
  /** Bold label and a "Changed" mark: the value differs from what was read. */
  readonly changed?: boolean
  /** A control that a `<label for>` cannot name (a radio group) takes `${id}-label` as its aria-labelledby instead. */
  readonly labelFor?: boolean
  readonly children: ReactNode
}

/**
 * One row of a property sheet: the label, the control and its description, then its note and error. The description
 * shows beside the control while the row is hovered or holds focus, and as the label's tooltip (no empty description
 * well, U1 D2); a note (why it is greyed) and an error always show, under the control.
 */
export default function PropertyField({ id, label, changed, labelFor = true, description, note, error, children }: Props) {
  return <div className="property-field" data-changed={changed || undefined} data-field={id}>
    {/* The Changed mark sits beside the label, not in it, so the control's name stays the label's words. */}
    <div className="property-field-label">
      <label id={`${id}-label`} htmlFor={labelFor ? id : undefined} title={description}>{label}</label>
      {changed && <span className="property-field-changed" aria-hidden="true">Changed</span>}
    </div>
    <div className="property-field-control">{children}</div>
    {description && <p className="property-field-description" id={`${id}-description`} title={description}>{description}</p>}
    {note && <p className="property-field-note" id={`${id}-note`}><span className="codicon codicon-info" aria-hidden="true" />{note}</p>}
    {error && <p className="property-field-error" id={`${id}-error`}><span className="codicon codicon-error" aria-hidden="true" />{error}</p>}
  </div>
}

/** Read-only facts as text, label and value pairs (General's backups, size and owner), never as greyed inputs. */
export function FactList({ facts }: { readonly facts: readonly { readonly label: string; readonly value: string; readonly title?: string }[] }) {
  return <dl className="property-facts">
    {facts.map(fact => <div key={fact.label} className="property-fact" title={fact.title}><dt>{fact.label}</dt><dd>{fact.value || '—'}</dd></div>)}
  </dl>
}
