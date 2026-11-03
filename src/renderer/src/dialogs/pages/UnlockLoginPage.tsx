import { loginMessages, type LoginLockFacts } from '../../../../shared/actions/logins.ts'
import { useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import type { UnlockDraft, UnlockModel } from '../definitions'
import type { PageProps } from '../ObjectDialog'

/** The page's words, which the dialog service's tests and the docs share. */
export const unlockPageText = {
  notLocked: 'This login is not locked out.',
  expired: 'The password has expired.',
  mustChange: 'The login must change its password at next sign-in.',
  how: 'How to unlock',
  keepPassword: 'Keep the current password',
  keepPasswordHelp: 'Turns the password policy off and on again in one transaction (Microsoft\'s documented way to unlock without a password). This clears the login\'s password history.'
} as const

/** "2026-11-02T21:07:12.123" (the server's clock) as "2026-11-02 21:07:12". */
const serverTime = (value: string) => value.replace('T', ' ').replace(/\.\d+$/, '')
const failedSignIns = (count: number) => `${count.toLocaleString('en-US')} failed ${count === 1 ? 'sign-in' : 'sign-ins'}`

/** The lock-out state as sentences: locked since when and after how many failed sign-ins, or not locked; then the password's state. */
export function unlockStateLines(lock: LoginLockFacts): readonly string[] {
  const locked = lock.locked
    ? 'Locked out' + (lock.lockoutTime ? ` since ${serverTime(lock.lockoutTime)} (server time)` : '') + (lock.badPasswords ? ` after ${failedSignIns(lock.badPasswords)}` : '') + '.'
    : unlockPageText.notLocked
  return [locked, ...lock.expired ? [unlockPageText.expired] : [], ...lock.mustChange ? [unlockPageText.mustChange] : []]
}

/**
 * Unlock Login's General page (D4d): the login's lock-out state, why OK cannot run when it cannot, and How to unlock. Keeping the
 * current password is its only choice until Login Properties (D2c) adds Set a new password…, SSMS's way and then the default.
 */
export default function UnlockLoginPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const model = open.model as UnlockModel | undefined, draft = open.draft as UnlockDraft | undefined
  if (!model || !draft) return <p className="field-note">{open.phase === 'loading' ? 'Loading…' : ''}</p>
  const reason = dialogs.unavailable(open)
  return <div className="unlock-login">
    <section aria-labelledby="unlock-login-state">
      <div className="object-dialog-caption" id="unlock-login-state">State</div>
      <ul className="unlock-login-state" aria-labelledby="unlock-login-state">
        {unlockStateLines(model.lock).map(line => <li key={line}>{line}</li>)}
      </ul>
    </section>
    {reason && reason !== loginMessages.notLocked && <ul className="object-dialog-warnings" aria-label="Warnings"><li><Icon name="warning" /><span>{reason}</span></li></ul>}
    <fieldset className="object-dialog-options" role="radiogroup" aria-labelledby="unlock-login-how" disabled={!editable || !!reason}>
      <legend className="object-dialog-caption" id="unlock-login-how">{unlockPageText.how}</legend>
      <label className="checkbox-label"><input type="radio" name="unlock-mode" value="keepPassword" checked={draft.mode === 'keepPassword'} aria-describedby="unlock-login-keep-help"
        onChange={() => dialogs.updateDraft({ mode: 'keepPassword' })} />{unlockPageText.keepPassword}</label>
      <p className="field-note" id="unlock-login-keep-help">{unlockPageText.keepPasswordHelp}</p>
    </fieldset>
  </div>
}
