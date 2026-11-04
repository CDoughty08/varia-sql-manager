import { actionLimits } from '../../../../shared/actions/catalog.ts'
import { loginDetailWords, loginPropertiesMessages, newLoginMessages, publicRole, type NewLoginModel } from '../../../../shared/actions/logins.ts'
import { displayText } from '../../../../shared/explorer/refs.ts'
import { useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import PasswordField from '../../kit/PasswordField'
import { definitionOf } from '../definitions'
import { loginPropertiesEnabled, loginPropertiesHints, loginStatusLocks, sqlLogin, type LoginPropertiesDraft, type LoginPropertiesModel } from '../login-properties'
import { newLoginEnabled, newLoginHints, passwordFieldLength, renameLogin, type NewLoginDraft } from '../new-login'
import type { PageProps } from '../ObjectDialog'

function useLogin(open: PageProps['open']) {
  return { model: open.model as NewLoginModel | undefined, draft: open.draft as NewLoginDraft | undefined }
}
/** Login Properties (D2c) shows these pages on an existing login: its model and draft, when that is the dialog. */
function propertiesOf(open: PageProps['open']) {
  return open.dialog === 'loginProperties' ? { model: open.model as LoginPropertiesModel | undefined, draft: open.draft as LoginPropertiesDraft | undefined } : undefined
}
/** Why Login Properties cannot change the login (SQL Server's own logins), or undefined: every page says so and greys its controls,
 *  since OK is greyed whichever page is shown. */
export function loginBlocked(open: PageProps['open']): string | undefined {
  return open.dialog === 'loginProperties' && open.model && open.draft ? definitionOf(open.dialog).blocked?.(open.model, open.draft) : undefined
}
/** The blocked reason above a page's controls. */
export function LoginBlockedNote({ open }: Pick<PageProps, 'open'>) {
  const blocked = loginBlocked(open)
  return blocked ? <ul className="object-dialog-warnings" aria-label="Notes"><li><Icon name="warning" /><span>{blocked}</span></li></ul> : null
}

/**
 * New Login's General page, in SSMS's order: Login name; Windows or SQL Server authentication, with Password, Confirm password,
 * Specify old password (Login Properties only, so greyed) and the three password options, each greyed unless the one before it
 * is checked; then Default database and Default language. The page stays mounted (`keepMounted`), so the password inputs keep
 * what was typed across page switches; their values go only to the dialog's secret slot.
 */
export function NewLoginGeneralPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const { model, draft } = useLogin(open)
  if (!model || !draft) return <p className="field-note" role="status">{open.phase === 'loading' ? 'Loading…' : ''}</p>
  if (open.dialog === 'loginProperties') return <LoginPropertiesGeneral open={open} editable={editable} />
  const enabled = newLoginEnabled(draft), sql = draft.auth === 'sql', secrets = open.secretState, hints = newLoginHints(draft)
  const matched = sql && secrets?.password === 'set' && secrets.matches
  return <div className="new-login-page">
    <fieldset className="property-grid new-login-fields" disabled={!editable}>
      <div className="property-row"><label htmlFor="new-login-name">Login name</label>
        <input id="new-login-name" type="text" autoComplete="off" spellCheck={false} maxLength={actionLimits.newName} value={draft.name} onChange={event => dialogs.updateDraft(renameLogin(draft, event.target.value))} /></div>
      <div className="new-login-auth" role="radiogroup" aria-label="Authentication">
        <label className="checkbox-label"><input type="radio" name="new-login-auth" checked={draft.auth === 'windows'} onChange={() => dialogs.updateDraft({ auth: 'windows' })} />Windows authentication</label>
        <label className="checkbox-label"><input type="radio" name="new-login-auth" checked={sql} onChange={() => dialogs.updateDraft({ auth: 'sql' })} />SQL Server authentication</label>
      </div>
      <div className="new-login-sql">
        <div className="property-row"><label htmlFor="new-login-password">Password</label>
          <PasswordField id="new-login-password" maxLength={passwordFieldLength} disabled={!enabled.password} onValue={value => dialogs.setSecret('password', value)} /></div>
        <div className="property-row"><label htmlFor="new-login-confirm">Confirm password</label>
          <PasswordField id="new-login-confirm" maxLength={passwordFieldLength} disabled={!enabled.password} aria-describedby={matched ? 'new-login-match' : undefined}
            onValue={value => dialogs.setSecret('confirm', value)} /></div>
        {matched && <p className="field-note new-login-match" id="new-login-match"><Icon name="pass" />{newLoginMessages.passwordsMatch}</p>}
        <div className="property-row"><label className="checkbox-label"><input type="checkbox" checked={false} disabled />Specify old password</label>
          <input type="password" aria-label="Old password" disabled defaultValue="" /></div>
        <label className="checkbox-label"><input type="checkbox" checked={enabled.checkPolicy && draft.checkPolicy} disabled={!enabled.checkPolicy}
          onChange={event => dialogs.updateDraft({ checkPolicy: event.target.checked })} />Enforce password policy</label>
        <label className="checkbox-label"><input type="checkbox" checked={enabled.checkExpiration && draft.checkExpiration} disabled={!enabled.checkExpiration}
          onChange={event => dialogs.updateDraft({ checkExpiration: event.target.checked })} />Enforce password expiration</label>
        <label className="checkbox-label"><input type="checkbox" checked={enabled.mustChange && draft.mustChange} disabled={!enabled.mustChange}
          onChange={event => dialogs.updateDraft({ mustChange: event.target.checked })} />User must change password at next login</label>
        {hints.length > 0 && <ul className="new-login-hints" aria-label="Password notes">
          {hints.map(hint => <li key={hint}><Icon name={hint === newLoginMessages.policyServer ? 'workspace-trusted' : 'lock'} /><span>{hint}</span></li>)}
        </ul>}
      </div>
      <div className="property-row"><label htmlFor="new-login-database">Default database</label>
        <select id="new-login-database" value={draft.defaultDatabase} onChange={event => dialogs.updateDraft({ defaultDatabase: event.target.value })}>
          {model.databases.map(database => <option key={database.name} value={database.name}>{displayText(database.name)}</option>)}
        </select></div>
      <div className="property-row"><label htmlFor="new-login-language">Default language</label>
        <select id="new-login-language" value={draft.defaultLanguage ?? ''} onChange={event => dialogs.updateDraft({ defaultLanguage: event.target.value || undefined })}>
          <option value="">{'<default>'}</option>
          {model.languages.map(language => <option key={language.name} value={language.name}>{language.alias && language.alias !== language.name ? `${language.name} – ${language.alias}` : language.name}</option>)}
        </select></div>
    </fieldset>
    {(sql && model.server.windowsOnly || !model.server.canCreate || model.databasesTruncated) && <ul className="object-dialog-warnings" aria-label="Notes">
      {sql && model.server.windowsOnly && <li><Icon name="warning" /><span>{newLoginMessages.windowsOnly}</span></li>}
      {!model.server.canCreate && <li><Icon name="warning" /><span>{newLoginMessages.canCreate}</span></li>}
      {model.databasesTruncated && <li><Icon name="warning" /><span>{`Only the first ${model.databases.length.toLocaleString('en-US')} databases are listed.`}</span></li>}
    </ul>}
  </div>
}

/**
 * Login Properties' General page (D2c), New Login's in SSMS's order on an existing login: Login name and its authentication read-only;
 * Password and Confirm password blank, which keeps the password (SSMS fills them with a fake value instead); Specify old password and
 * Old password; the policy options; User must change only once a new password is typed; then Default database and Default language,
 * which has no <default> here (SMO's ALTER for it is unverified).
 */
function LoginPropertiesGeneral({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const { model, draft } = propertiesOf(open)!
  if (!model || !draft) return null
  const secrets = open.secretState, enabled = loginPropertiesEnabled(model, draft, secrets), hints = loginPropertiesHints(model, draft, secrets), sql = sqlLogin(model)
  const matched = sql && secrets?.password === 'set' && secrets.matches
  // The radios already say SQL Server or Windows authentication; a group, a certificate, a key or Entra is worth a note.
  const kind = model.login.type === 'S' || model.login.type === 'U' ? undefined : loginDetailWords.types[model.login.type as keyof typeof loginDetailWords.types] ?? model.login.type
  // A remount empties the password fields after a partial run used their passwords (ObjectDialogService.spend).
  const epoch = open.secretEpoch ?? 0
  return <div className="new-login-page">
    <LoginBlockedNote open={open} />
    <fieldset className="property-grid new-login-fields" disabled={!editable || !!loginBlocked(open)}>
      <div className="property-row"><label htmlFor="new-login-name">Login name</label>
        <input id="new-login-name" type="text" readOnly value={draft.name} aria-describedby={kind ? 'login-properties-kind' : undefined} /></div>
      <div className="new-login-auth" role="radiogroup" aria-label="Authentication" aria-describedby={kind ? 'login-properties-kind' : undefined}>
        <label className="checkbox-label"><input type="radio" name="new-login-auth" checked={!sql} disabled readOnly />Windows authentication</label>
        <label className="checkbox-label"><input type="radio" name="new-login-auth" checked={sql} disabled readOnly />SQL Server authentication</label>
        {kind && <p className="field-note" id="login-properties-kind">{kind}</p>}
      </div>
      <div className="new-login-sql">
        <div className="property-row"><label htmlFor="new-login-password">Password</label>
          <PasswordField key={`password-${epoch}`} id="new-login-password" maxLength={passwordFieldLength} disabled={!enabled.password} aria-describedby={sql ? 'login-properties-keep' : undefined} onValue={value => dialogs.setSecret('password', value)} /></div>
        <div className="property-row"><label htmlFor="new-login-confirm">Confirm password</label>
          <PasswordField key={`confirm-${epoch}`} id="new-login-confirm" maxLength={passwordFieldLength} disabled={!enabled.password} aria-describedby={matched ? 'new-login-match' : undefined}
            onValue={value => dialogs.setSecret('confirm', value)} /></div>
        {matched && <p className="field-note new-login-match" id="new-login-match"><Icon name="pass" />{newLoginMessages.passwordsMatch}</p>}
        <label className="checkbox-label"><input type="checkbox" checked={sql && draft.specifyOld} disabled={!sql}
          onChange={event => dialogs.updateDraft({ specifyOld: event.target.checked })} />Specify old password</label>
        <div className="property-row"><label htmlFor="login-old-password">Old password</label>
          <PasswordField key={`old-${epoch}`} id="login-old-password" maxLength={passwordFieldLength} disabled={!enabled.oldPassword} onValue={value => dialogs.setSecret('oldPassword', value)} /></div>
        <label className="checkbox-label"><input type="checkbox" checked={enabled.checkPolicy && draft.checkPolicy} disabled={!enabled.checkPolicy}
          onChange={event => dialogs.updateDraft({ checkPolicy: event.target.checked })} />Enforce password policy</label>
        <label className="checkbox-label"><input type="checkbox" checked={enabled.checkExpiration && draft.checkExpiration} disabled={!enabled.checkExpiration}
          onChange={event => dialogs.updateDraft({ checkExpiration: event.target.checked })} />Enforce password expiration</label>
        <label className="checkbox-label"><input type="checkbox" checked={enabled.mustChange && draft.mustChange} disabled={!enabled.mustChange}
          onChange={event => dialogs.updateDraft({ mustChange: event.target.checked })} />User must change password at next login</label>
        {hints.length > 0 && <ul className="new-login-hints" aria-label="Password notes">
          {hints.map((hint, index) => <li key={hint} id={index === 0 ? 'login-properties-keep' : undefined}><Icon name={hint === loginPropertiesMessages.unlockNeedsPassword ? 'unlock' : 'lock'} /><span>{hint}</span></li>)}
        </ul>}
      </div>
      <div className="property-row"><label htmlFor="new-login-database">Default database</label>
        <select id="new-login-database" value={draft.defaultDatabase} onChange={event => dialogs.updateDraft({ defaultDatabase: event.target.value })}>
          {!model.databases.some(database => database.name === draft.defaultDatabase) && <option value={draft.defaultDatabase}>{displayText(draft.defaultDatabase)}</option>}
          {model.databases.map(database => <option key={database.name} value={database.name}>{displayText(database.name)}</option>)}
        </select></div>
      <div className="property-row"><label htmlFor="new-login-language">Default language</label>
        <select id="new-login-language" value={draft.defaultLanguage ?? ''} onChange={event => dialogs.updateDraft({ defaultLanguage: event.target.value || undefined })}>
          {draft.defaultLanguage === undefined && <option value="" disabled>{''}</option>}
          {model.languages.map(language => <option key={language.name} value={language.name}>{language.alias && language.alias !== language.name ? `${language.name} – ${language.alias}` : language.name}</option>)}
        </select></div>
    </fieldset>
    {model.databasesTruncated && <ul className="object-dialog-warnings" aria-label="Notes">
      <li><Icon name="warning" /><span>{`Only the first ${model.databases.length.toLocaleString('en-US')} databases are listed.`}</span></li>
    </ul>}
  </div>
}

/** Server Roles: every server role, by name; public is checked and greyed, as every login is a member. */
export function NewLoginServerRolesPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const { model, draft } = useLogin(open)
  if (!model || !draft) return null
  const chosen = new Set(draft.serverRoles)
  const toggle = (name: string, checked: boolean) => dialogs.updateDraft({ serverRoles: checked ? [...draft.serverRoles.filter(role => role !== name), name] : draft.serverRoles.filter(role => role !== name) })
  return <div className="new-login-page">
    <LoginBlockedNote open={open} />
    <p className="field-note" id="new-login-roles-note">Server role is used to grant server-wide security privileges to a user.</p>
    <fieldset className="new-login-roles" role="group" aria-label="Server roles" aria-describedby="new-login-roles-note" disabled={!editable || !!loginBlocked(open)}>
      {model.serverRoles.map(role => role.name === publicRole
        ? <label key={role.name} className="checkbox-label"><input type="checkbox" checked disabled /><bdi>{role.name}</bdi></label>
        : <label key={role.name} className="checkbox-label"><input type="checkbox" checked={chosen.has(role.name)} onChange={event => toggle(role.name, event.target.checked)} /><bdi>{displayText(role.name)}</bdi></label>)}
    </fieldset>
    {model.serverRolesTruncated && <p className="field-note">{`Only the first ${model.serverRoles.length.toLocaleString('en-US')} server roles are listed.`}</p>}
    {propertiesOf(open)?.model?.properties.serverRolesTruncated && <p className="field-note">{`The login is a member of more server roles than the first ${model.serverRoles.length.toLocaleString('en-US')} read; only those can be removed here.`}</p>}
  </div>
}

/** Status: Permission to connect to database engine (Grant, Deny) and Login (Enabled, Disabled); Login is locked out is Login
 *  Properties' (D2c): checked while the login is locked out, and enabled then to clear it (which needs a new password) or check it
 *  again. Login Properties greys the choices its rules refuse (the connection's own login's Deny and Disabled, a Windows group's
 *  Disabled), with the reason beside them. */
export function NewLoginStatusPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const { draft } = useLogin(open)
  const properties = propertiesOf(open)
  if (!draft) return null
  const lock = properties?.model && properties.draft ? { enabled: loginPropertiesEnabled(properties.model, properties.draft, open.secretState).locked, checked: properties.draft.locked } : { enabled: false, checked: false }
  const greyed = properties?.model ? loginStatusLocks(properties.model) : {}, reason = greyed.deny ?? greyed.disable
  const note = (why: string | undefined) => why ? 'login-status-note' : undefined
  return <div className="new-login-page">
    <LoginBlockedNote open={open} />
    <fieldset className="property-section new-login-status" disabled={!editable || !!loginBlocked(open)}>
      <legend>Settings</legend>
      <div className="new-login-choice" role="radiogroup" aria-labelledby="new-login-connect">
        <div className="new-login-caption" id="new-login-connect">Permission to connect to database engine</div>
        <label className="checkbox-label"><input type="radio" name="new-login-connect" checked={draft.connect === 'grant'} onChange={() => dialogs.updateDraft({ connect: 'grant' })} />Grant</label>
        <label className="checkbox-label"><input type="radio" name="new-login-connect" checked={draft.connect === 'deny'} disabled={!!greyed.deny} aria-describedby={note(greyed.deny)}
          onChange={() => dialogs.updateDraft({ connect: 'deny' })} />Deny</label>
      </div>
      <div className="new-login-choice" role="radiogroup" aria-labelledby="new-login-enabled">
        <div className="new-login-caption" id="new-login-enabled">Login</div>
        <label className="checkbox-label"><input type="radio" name="new-login-enabled" checked={draft.enabled} onChange={() => dialogs.updateDraft({ enabled: true })} />Enabled</label>
        <label className="checkbox-label"><input type="radio" name="new-login-enabled" checked={!draft.enabled} disabled={!!greyed.disable} aria-describedby={note(greyed.disable)}
          onChange={() => dialogs.updateDraft({ enabled: false })} />Disabled</label>
      </div>
      {reason && <p className="field-note" id="login-status-note">{reason}</p>}
      <div className="new-login-choice">
        <div className="new-login-caption">SQL Server authentication</div>
        <label className="checkbox-label"><input type="checkbox" checked={lock.checked} disabled={!lock.enabled}
          onChange={event => dialogs.updateDraft({ locked: event.target.checked })} aria-describedby={lock.enabled ? 'login-properties-unlock' : undefined} />{loginPropertiesMessages.locked}</label>
        {lock.enabled && <p className="field-note" id="login-properties-unlock">{loginPropertiesMessages.unlockNeedsPassword}</p>}
      </div>
    </fieldset>
  </div>
}
