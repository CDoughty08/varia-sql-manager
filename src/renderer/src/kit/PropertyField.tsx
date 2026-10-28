import { createContext, useCallback, useContext, useMemo, useState, type FocusEvent, type ReactNode } from 'react'
import Icon from '../Icon'

/** The parts of a field besides its control: what it does, why it is greyed, and what is wrong with its value. */
export interface FieldText { readonly description?: string; readonly note?: string; readonly error?: string }

/**
 * The ARIA a field's control carries: whether it changed, its description and its note as its description, and its error
 * as its error message. The Changed mark and the description stay in the DOM while they are hidden, so they are read
 * whether or not they show.
 */
export function fieldAria(id: string, { description, note, error, changed }: FieldText & { readonly changed?: boolean }): { 'aria-describedby'?: string; 'aria-invalid'?: true; 'aria-errormessage'?: string } {
  const described = [changed && `${id}-changed`, description && `${id}-description`, note && `${id}-note`].filter(Boolean).join(' ')
  return { ...described ? { 'aria-describedby': described } : {}, ...error ? { 'aria-invalid': true, 'aria-errormessage': `${id}-error` } : {} }
}

/** A field's description as the document's hint strip shows it. */
export interface FieldHint { readonly id: string; readonly label: string; readonly description: string }
type HintSource = 'hovered' | 'focused'
/** The hovered and the focused field's hints, and which of them came last. */
export interface Hints { readonly hovered?: FieldHint; readonly focused?: FieldHint; readonly last?: HintSource }
type HintSetter = (source: HintSource, id: string, hint: FieldHint | undefined) => void
const HintSetterContext = createContext<HintSetter | undefined>(undefined)
const HintContext = createContext<FieldHint | undefined>(undefined)

/** The hint state after a field is entered (`hint`) or left (undefined): leaving clears only that field's own hint. */
export function nextHints(current: Hints, source: HintSource, id: string, hint: FieldHint | undefined): Hints {
  if (!hint) return current[source]?.id === id ? { ...current, [source]: undefined } : current
  return current[source] === hint && current.last === source ? current : { ...current, [source]: hint, last: source }
}
/**
 * The hint the strip shows: the one that came last (a row the pointer entered, or a control that took focus), else the
 * other, so a pointer resting on a row never hides the description of the control the keyboard moved to.
 */
export function shownHint({ hovered, focused, last }: Hints): FieldHint | undefined {
  return last === 'focused' ? focused ?? hovered : hovered ?? focused
}

/**
 * Holds which field's description the hint strip shows (shownHint). The fields only set it (a context that never
 * changes), so hovering re-renders the strip and nothing else.
 */
export function FieldHints({ children }: { readonly children: ReactNode }) {
  const [hints, setHints] = useState<Hints>({})
  const set = useCallback<HintSetter>((source, id, hint) => setHints(current => nextHints(current, source, id, hint)), [])
  return <HintSetterContext.Provider value={set}><HintContext.Provider value={shownHint(hints)}>{children}</HintContext.Provider></HintSetterContext.Provider>
}

/**
 * The strip that shows the hovered or focused field's whole description (Calm Pro: a description on hover or focus, no
 * empty well). It ends the sections column and is pinned to its bottom edge, over the rows: it takes no room, so showing
 * it never moves a row under the pointer, and it is not there at all while it has nothing to say. Its dock keeps two lines
 * at the end of the column, so the last row scrolls clear of it. Screen readers have each description as its control's
 * description already, so the strip is hidden from them.
 */
export function FieldHintStrip(props: { readonly hint?: FieldHint }) {
  const shown = useContext(HintContext), hint = props.hint ?? shown
  return <div className="field-hint-dock" aria-hidden="true">
    <div className="field-hint" data-field={hint?.id}>{hint && <><span className="field-hint-label">{hint.label}</span> {hint.description}</>}</div>
  </div>
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
 * One row of a property sheet: the label and the control, then its note and error. Its description shows in the
 * document's hint strip (FieldHintStrip) while the row is hovered or holds focus, and as the label's tooltip (no empty
 * description well, U1 D2); a note (why it is greyed) and an error always show, under the control.
 */
export default function PropertyField({ id, label, changed, labelFor = true, description, note, error, children }: Props) {
  const setHint = useContext(HintSetterContext)
  const hint = useMemo(() => description ? { id, label, description } : undefined, [id, label, description])
  const hints = setHint && hint ? {
    onMouseEnter: () => setHint('hovered', id, hint),
    onMouseLeave: () => setHint('hovered', id, undefined),
    onFocus: () => setHint('focused', id, hint),
    onBlur: (event: FocusEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHint('focused', id, undefined) }
  } : {}
  return <div className="property-field" data-changed={changed || undefined} data-field={id} {...hints}>
    {/* The Changed mark sits beside the label, not in it, so the control's name stays the label's words; the control's
        description carries it (fieldAria). */}
    <div className="property-field-label">
      <label id={`${id}-label`} htmlFor={labelFor ? id : undefined} title={description}>{label}</label>
      {changed && <span className="property-field-changed" id={`${id}-changed`} aria-hidden="true">Changed</span>}
    </div>
    <div className="property-field-control">{children}</div>
    {description && <p className="property-field-description" id={`${id}-description`} hidden>{description}</p>}
    {note && <p className="property-field-note" id={`${id}-note`}><Icon name="info" />{note}</p>}
    {error && <p className="property-field-error" id={`${id}-error`}><Icon name="error" />{error}</p>}
  </div>
}

/** Read-only facts as text, label and value pairs (General's backups, size and owner), never as greyed inputs. */
export function FactList({ facts }: { readonly facts: readonly { readonly label: string; readonly value: string; readonly title?: string }[] }) {
  return <dl className="property-facts">
    {facts.map(fact => <div key={fact.label} className="property-fact" title={fact.title}><dt>{fact.label}</dt><dd>{fact.value || '—'}</dd></div>)}
  </dl>
}
