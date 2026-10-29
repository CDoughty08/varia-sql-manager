import type { AriaAttributes } from 'react'

interface Props extends Pick<AriaAttributes, 'aria-describedby' | 'aria-invalid' | 'aria-errormessage'> {
  readonly id: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly disabled?: boolean
  /** The words beside it for each state ("True" and "False" in a property sheet); the thumb's side says it too. */
  readonly states?: { readonly on: string; readonly off: string }
  /** Marks a value that differs from what was read (`data-changed`). */
  readonly changed?: boolean
}

/**
 * A boolean as a switch: a checkbox with the switch role, so Space toggles it and assistive technology says on or off.
 * A `<label htmlFor={id}>` elsewhere names it. The state shows three ways: the thumb's side, the fill, and the words.
 */
export default function Switch({ id, checked, onChange, disabled, states, changed, ...aria }: Props) {
  return <span className="switch-field">
    <input id={id} className="switch" type="checkbox" role="switch" checked={checked} disabled={disabled} data-changed={changed || undefined} {...aria}
      onChange={event => onChange(event.target.checked)} />
    {states && <span className="switch-state" aria-hidden="true">{checked ? states.on : states.off}</span>}
  </span>
}
