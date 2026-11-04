import { actionLimits } from '../../../../shared/actions/catalog.ts'
import { newLoginMessages, publicRole, type NewLoginModel } from '../../../../shared/actions/logins.ts'
import { displayText } from '../../../../shared/explorer/refs.ts'
import { useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import PasswordField from '../../kit/PasswordField'
import { newLoginEnabled, newLoginHints, passwordFieldLength, renameLogin, type NewLoginDraft } from '../new-login'
import type { PageProps } from '../ObjectDialog'

function useLogin(open: PageProps['open']) {
  return { model: open.model as NewLoginModel | undefined, draft: open.draft as NewLoginDraft | undefined }
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

/** Server Roles: every server role, by name; public is checked and greyed, as every login is a member. */
export function NewLoginServerRolesPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const { model, draft } = useLogin(open)
  if (!model || !draft) return null
  const chosen = new Set(draft.serverRoles)
  const toggle = (name: string, checked: boolean) => dialogs.updateDraft({ serverRoles: checked ? [...draft.serverRoles.filter(role => role !== name), name] : draft.serverRoles.filter(role => role !== name) })
  return <div className="new-login-page">
    <p className="field-note" id="new-login-roles-note">Server role is used to grant server-wide security privileges to a user.</p>
    <fieldset className="new-login-roles" role="group" aria-label="Server roles" aria-describedby="new-login-roles-note" disabled={!editable}>
      {model.serverRoles.map(role => role.name === publicRole
        ? <label key={role.name} className="checkbox-label"><input type="checkbox" checked disabled /><bdi>{role.name}</bdi></label>
        : <label key={role.name} className="checkbox-label"><input type="checkbox" checked={chosen.has(role.name)} onChange={event => toggle(role.name, event.target.checked)} /><bdi>{displayText(role.name)}</bdi></label>)}
    </fieldset>
    {model.serverRolesTruncated && <p className="field-note">{`Only the first ${model.serverRoles.length.toLocaleString('en-US')} server roles are listed.`}</p>}
  </div>
}

/** Status: Permission to connect to database engine (Grant, Deny) and Login (Enabled, Disabled); Login is locked out is Login
 *  Properties' and stays greyed. */
export function NewLoginStatusPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const { draft } = useLogin(open)
  if (!draft) return null
  return <div className="new-login-page">
    <fieldset className="property-section new-login-status" disabled={!editable}>
      <legend>Settings</legend>
      <div className="new-login-choice" role="radiogroup" aria-labelledby="new-login-connect">
        <div className="new-login-caption" id="new-login-connect">Permission to connect to database engine</div>
        <label className="checkbox-label"><input type="radio" name="new-login-connect" checked={draft.connect === 'grant'} onChange={() => dialogs.updateDraft({ connect: 'grant' })} />Grant</label>
        <label className="checkbox-label"><input type="radio" name="new-login-connect" checked={draft.connect === 'deny'} onChange={() => dialogs.updateDraft({ connect: 'deny' })} />Deny</label>
      </div>
      <div className="new-login-choice" role="radiogroup" aria-labelledby="new-login-enabled">
        <div className="new-login-caption" id="new-login-enabled">Login</div>
        <label className="checkbox-label"><input type="radio" name="new-login-enabled" checked={draft.enabled} onChange={() => dialogs.updateDraft({ enabled: true })} />Enabled</label>
        <label className="checkbox-label"><input type="radio" name="new-login-enabled" checked={!draft.enabled} onChange={() => dialogs.updateDraft({ enabled: false })} />Disabled</label>
      </div>
      <div className="new-login-choice">
        <div className="new-login-caption">SQL Server authentication</div>
        <label className="checkbox-label"><input type="checkbox" checked={false} disabled />Login is locked out</label>
      </div>
    </fieldset>
  </div>
}
