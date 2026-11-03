import type { AriaAttributes } from 'react'

interface Props extends Pick<AriaAttributes, 'aria-describedby' | 'aria-invalid'> {
  readonly id: string
  /** Its value goes here on every change, and nowhere else: React never holds it, so no state or snapshot can carry it. */
  readonly onValue: (value: string) => void
  readonly maxLength: number
  readonly disabled?: boolean
}

/**
 * A masked password input, uncontrolled: the browser keeps what was typed (a page that stays mounted keeps it across page
 * switches), and `onValue` hands each change to its owner's secret slot. Never `type="text"` and no reveal button, as in SSMS;
 * no autofill, spell check or autocorrect reads it. A `<label htmlFor={id}>` names it.
 */
export default function PasswordField({ id, onValue, maxLength, disabled, ...aria }: Props) {
  return <input id={id} className="password-field" type="password" autoComplete="new-password" spellCheck={false} autoCorrect="off" autoCapitalize="off" maxLength={maxLength}
    disabled={disabled} defaultValue="" {...aria} onChange={event => onValue(event.target.value)} />
}
