import { useState, type KeyboardEvent } from 'react'
import { actionLimits } from '../../../../shared/actions/catalog.ts'
import {
  checkNamesText, loginDetailWords, loginPropertiesMessages, newLoginAuthLabels, newLoginMessages, publicRole, windowsLoginName, type NewLoginAuth, type NewLoginModel
} from '../../../../shared/actions/logins.ts'
import { displayText } from '../../../../shared/explorer/refs.ts'
import { useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import PasswordField from '../../kit/PasswordField'
import { definitionOf } from '../definitions'
import { loginAuthOf, loginPropertiesEnabled, loginPropertiesHints, loginStatusLocks, sqlLogin, type LoginPropertiesDraft, type LoginPropertiesModel } from '../login-properties'
import {
  addCredential, credentialAddProblem, credentialProvider, newLoginEnabled, newLoginHints, newLoginKindNotes, offeredAuths, passwordFieldLength, removeCredential, renameLogin,
  type NewLoginDraft
} from '../new-login'
import type { PageProps } from '../ObjectDialog'
import SubDialog from '../SubDialog'

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

/** The kind radios: on New Login the kinds the server offers, on Login Properties the login's own kind checked among them, all read-only. */
function AuthRadios({ auths, checked, onChoose, describedBy }: { auths: readonly NewLoginAuth[]; checked: NewLoginAuth; onChoose?(auth: NewLoginAuth): void; describedBy?: string }) {
  return <div className="new-login-auth" role="radiogroup" aria-label="Authentication" aria-describedby={describedBy}>
    {auths.map(auth => <label key={auth} className="checkbox-label"><input type="radio" name="new-login-auth" checked={checked === auth} disabled={!onChoose} readOnly={!onChoose}
      onChange={onChoose ? () => onChoose(auth) : undefined} />{newLoginAuthLabels[auth]}</label>)}
  </div>
}

/** Mapped to certificate's and Mapped to asymmetric key's lists (master's), each enabled for its kind. Login Properties shows the
 *  login's own certificate or key, read-only. */
function SigningRows({ model, draft, editable }: { model: NewLoginModel; draft: NewLoginDraft; editable: boolean }) {
  const { dialogs } = useWorkbench()
  const row = (kind: 'certificate' | 'asymmetricKey', label: string, names: readonly string[]) => {
    const value = draft[kind], on = draft.auth === kind, listed = names.includes(value)
    return <div className="property-row"><label htmlFor={`new-login-${kind}`}>{label}</label>
      <select id={`new-login-${kind}`} value={value} disabled={!on || !editable} onChange={event => dialogs.updateDraft({ [kind]: event.target.value })}>
        {!listed && <option value={value}>{displayText(value)}</option>}
        {names.map(name => <option key={name} value={name}>{displayText(name)}</option>)}
      </select></div>
  }
  return <>
    {row('certificate', 'Certificate name', model.certificates)}
    {row('asymmetricKey', 'Asymmetric key name', model.asymmetricKeys)}
  </>
}

/**
 * Map to Credential (D2e): the box enables the server's credentials and Add, which appends the chosen one to Mapped Credentials
 * (Credential and Provider); Remove takes the selected row out. The grid is one tab stop: arrows move its selection, Delete removes.
 */
function CredentialRows({ model, draft, enabled, editable }: { model: NewLoginModel; draft: NewLoginDraft; enabled: { readonly mapCredential: boolean; readonly credential: boolean }; editable: boolean }) {
  const { dialogs } = useWorkbench()
  const [selected, setSelected] = useState<string>()
  const current = selected !== undefined && draft.credentials.includes(selected) ? selected : draft.credentials[0]
  const problem = credentialAddProblem(model, draft), listed = model.credentials.some(credential => credential.name === draft.credential)
  const usable = editable && enabled.mapCredential
  const remove = (name: string) => {
    const index = draft.credentials.indexOf(name), next = removeCredential(draft, name)
    setSelected(next.credentials[Math.min(index, next.credentials.length - 1)])
    dialogs.updateDraft(next)
  }
  const keyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const index = current === undefined ? -1 : draft.credentials.indexOf(current)
    const move = (to: number) => { const name = draft.credentials[to]; if (name !== undefined) setSelected(name) }
    switch (event.key) {
      case 'ArrowDown': move(Math.min(draft.credentials.length - 1, index + 1)); break
      case 'ArrowUp': move(Math.max(0, index - 1)); break
      case 'Home': move(0); break
      case 'End': move(draft.credentials.length - 1); break
      case 'Delete': if (current !== undefined && usable) remove(current); break
      default: return
    }
    event.preventDefault()
  }
  return <>
    <div className="property-row"><label className="checkbox-label"><input type="checkbox" checked={enabled.mapCredential && draft.mapCredential} disabled={!usable}
      onChange={event => dialogs.updateDraft({ mapCredential: event.target.checked })} />Map to Credential</label>
      <div className="new-login-inline">
        <select aria-label="Credential to map" value={draft.credential} disabled={!enabled.credential || !editable} onChange={event => dialogs.updateDraft({ credential: event.target.value })}>
          {!listed && <option value={draft.credential}>{draft.credential ? displayText(draft.credential) : ''}</option>}
          {model.credentials.map(credential => <option key={credential.name} value={credential.name}>{displayText(credential.name)}</option>)}
        </select>
        <button type="button" disabled={!enabled.credential || !editable || !!problem} title={enabled.credential ? problem : undefined}
          onClick={() => { const next = addCredential(model, draft); setSelected(draft.credential); dialogs.updateDraft(next) }}>Add</button>
      </div></div>
    <div className="new-login-credentials">
      <span className="new-login-caption" id="new-login-credentials-label">Mapped Credentials</span>
      <table className="new-login-credentials-grid" role="grid" aria-labelledby="new-login-credentials-label" aria-rowcount={draft.credentials.length + 1} tabIndex={0}
        aria-activedescendant={current === undefined ? undefined : `new-login-credential-${draft.credentials.indexOf(current)}`} onKeyDown={keyDown}>
        <thead><tr role="row"><th role="columnheader">Credential</th><th role="columnheader">Provider</th></tr></thead>
        <tbody>
          {draft.credentials.map((name, index) => <tr key={name} id={`new-login-credential-${index}`} role="row" aria-selected={name === current} data-selected={name === current || undefined}
            onPointerDown={() => setSelected(name)}>
            <td role="gridcell"><bdi>{displayText(name)}</bdi></td><td role="gridcell"><bdi>{displayText(credentialProvider(model, name))}</bdi></td>
          </tr>)}
        </tbody>
      </table>
      <div className="new-login-inline new-login-credentials-actions">
        <button type="button" disabled={!usable || current === undefined} onClick={() => { if (current !== undefined) remove(current) }}>Remove</button>
      </div>
    </div>
    {!enabled.mapCredential && <p className="field-note">{newLoginMessages.credentialsEntra}</p>}
    {model.credentialsTruncated && <p className="field-note">{`Only the first ${model.credentials.length.toLocaleString('en-US')} credentials are listed.`}</p>}
  </>
}

/** Select User or Group (D2e, D2 §6): Search…'s server-side Check Names. The server answers through xp_logininfo; OK puts the account
 *  name it gave (or the name as typed, which the server checks on OK) into Login name. */
function SelectUserOrGroup({ open, initial, onOk, onCancel }: { open: PageProps['open']; initial: string; onOk(name: string): void; onCancel(): void }) {
  const { dialogs } = useWorkbench()
  const [name, setName] = useState(initial)
  const lookup = open.checkNames?.name === name ? open.checkNames : undefined
  const found = lookup?.state === 'ready' ? lookup.value : undefined
  const stale = open.checkNames && open.checkNames.name !== name && open.checkNames.state === 'ready'
  return <SubDialog title={checkNamesText.title} okDisabled={!windowsLoginName.test(name)} onOk={() => onOk(found?.accountName ?? name)} onCancel={onCancel} initialFocus="check-names-name">
    <label htmlFor="check-names-name">{checkNamesText.nameLabel}</label>
    <div className="new-login-inline">
      <input id="check-names-name" type="text" autoComplete="off" spellCheck={false} maxLength={actionLimits.newName} value={name} aria-describedby="check-names-hint"
        onChange={event => setName(event.target.value)} />
      <button type="button" disabled={!name || lookup?.state === 'checking'} onClick={() => dialogs.checkNames(name)}>{checkNamesText.check}</button>
    </div>
    <p className="field-note" id="check-names-hint">{checkNamesText.hint}</p>
    <div className="check-names-answer" role="status">
      {lookup?.state === 'checking' && <p className="field-note">{checkNamesText.checking}</p>}
      {found && <ul className="new-login-hints" aria-label="Check Names">
        <li><Icon name={found.access ? 'pass' : 'info'} /><span>{found.access ? checkNamesText.found : checkNamesText.noAccess}</span></li>
        <li><Icon name="person" /><span><bdi>{found.accountName}</bdi>{found.type ? ` · ${found.type === 'group' ? checkNamesText.group : checkNamesText.user}` : ''}</span></li>
        {found.via && found.via !== found.accountName && <li><Icon name="link" /><span>{checkNamesText.via(found.via)}</span></li>}
      </ul>}
      {lookup?.state === 'failed' && <p className="field-note" role="alert"><Icon name="warning" />{lookup.error.message}</p>}
      {stale && <p className="field-note">{checkNamesText.changed}</p>}
    </div>
  </SubDialog>
}

/** The other kinds' notes (D2e): Entra's, and that a certificate or key login cannot connect. */
function KindNotes({ notes }: { notes: readonly string[] }) {
  return notes.length ? <ul className="new-login-hints" aria-label="Authentication notes">{notes.map(note => <li key={note}><Icon name="info" /><span>{note}</span></li>)}</ul> : null
}

/**
 * New Login's General page, in SSMS's order: Login name and Search… (Check Names, Windows authentication only); the kinds the server
 * offers (D2e: Microsoft Entra, Mapped to certificate and Mapped to asymmetric key on SQL Server; SQL Server and Entra only on Managed
 * Instance); Password, Confirm password, Specify old password (Login Properties only, so greyed) and the three password options, each
 * greyed unless the one before it is checked, and hidden on Managed Instance; the certificate and key lists; Map to Credential and
 * Mapped Credentials; then Default database and Default language, greyed for a certificate or key login. The page stays mounted
 * (`keepMounted`), so the password inputs keep what was typed across page switches; their values go only to the dialog's secret slot.
 */
export function NewLoginGeneralPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const { model, draft } = useLogin(open)
  const [searching, setSearching] = useState(false)
  if (!model || !draft) return <p className="field-note" role="status">{open.phase === 'loading' ? 'Loading…' : ''}</p>
  if (open.dialog === 'loginProperties') return <LoginPropertiesGeneral open={open} editable={editable} />
  const enabled = newLoginEnabled(draft, model.server), sql = draft.auth === 'sql', secrets = open.secretState, hints = newLoginHints(draft, model.server)
  const matched = sql && secrets?.password === 'set' && secrets.matches, notes = newLoginKindNotes(model, draft)
  return <div className="new-login-page">
    <fieldset className="property-grid new-login-fields" disabled={!editable}>
      <div className="property-row"><label htmlFor="new-login-name">Login name</label>
        <div className="new-login-inline">
          <input id="new-login-name" type="text" autoComplete="off" spellCheck={false} maxLength={actionLimits.newName} value={draft.name} onChange={event => dialogs.updateDraft(renameLogin(draft, event.target.value))} />
          <button type="button" disabled={!enabled.search} onClick={() => setSearching(true)}>Search…</button>
        </div></div>
      <AuthRadios auths={offeredAuths(model.server)} checked={draft.auth} onChoose={auth => dialogs.updateDraft({ auth })} describedBy={notes.length ? 'new-login-kind-notes' : undefined} />
      <div className="new-login-sql">
        <div className="property-row"><label htmlFor="new-login-password">Password</label>
          <PasswordField id="new-login-password" maxLength={passwordFieldLength} disabled={!enabled.password} onValue={value => dialogs.setSecret('password', value)} /></div>
        <div className="property-row"><label htmlFor="new-login-confirm">Confirm password</label>
          <PasswordField id="new-login-confirm" maxLength={passwordFieldLength} disabled={!enabled.password} aria-describedby={matched ? 'new-login-match' : undefined}
            onValue={value => dialogs.setSecret('confirm', value)} /></div>
        {matched && <p className="field-note new-login-match" id="new-login-match"><Icon name="pass" />{newLoginMessages.passwordsMatch}</p>}
        {enabled.policy && <>
          <div className="property-row"><label className="checkbox-label"><input type="checkbox" checked={false} disabled />Specify old password</label>
            <input type="password" aria-label="Old password" disabled defaultValue="" /></div>
          <label className="checkbox-label"><input type="checkbox" checked={enabled.checkPolicy && draft.checkPolicy} disabled={!enabled.checkPolicy}
            onChange={event => dialogs.updateDraft({ checkPolicy: event.target.checked })} />Enforce password policy</label>
          <label className="checkbox-label"><input type="checkbox" checked={enabled.checkExpiration && draft.checkExpiration} disabled={!enabled.checkExpiration}
            onChange={event => dialogs.updateDraft({ checkExpiration: event.target.checked })} />Enforce password expiration</label>
          <label className="checkbox-label"><input type="checkbox" checked={enabled.mustChange && draft.mustChange} disabled={!enabled.mustChange}
            onChange={event => dialogs.updateDraft({ mustChange: event.target.checked })} />User must change password at next login</label>
        </>}
        {hints.length > 0 && <ul className="new-login-hints" aria-label="Password notes">
          {hints.map(hint => <li key={hint}><Icon name={hint === newLoginMessages.policyServer ? 'workspace-trusted' : hint === newLoginMessages.policyManagedInstance ? 'info' : 'lock'} /><span>{hint}</span></li>)}
        </ul>}
      </div>
      {offeredAuths(model.server).includes('certificate') && <SigningRows model={model} draft={draft} editable={editable} />}
      <div id="new-login-kind-notes"><KindNotes notes={notes} /></div>
      <CredentialRows model={model} draft={draft} enabled={enabled} editable={editable} />
      <div className="property-row"><label htmlFor="new-login-database">Default database</label>
        <select id="new-login-database" value={draft.defaultDatabase} disabled={!enabled.defaults} onChange={event => dialogs.updateDraft({ defaultDatabase: event.target.value })}>
          {model.databases.map(database => <option key={database.name} value={database.name}>{displayText(database.name)}</option>)}
        </select></div>
      <div className="property-row"><label htmlFor="new-login-language">Default language</label>
        <select id="new-login-language" value={draft.defaultLanguage ?? ''} disabled={!enabled.defaults} onChange={event => dialogs.updateDraft({ defaultLanguage: event.target.value || undefined })}>
          <option value="">{'<default>'}</option>
          {model.languages.map(language => <option key={language.name} value={language.name}>{language.alias && language.alias !== language.name ? `${language.name} – ${language.alias}` : language.name}</option>)}
        </select></div>
    </fieldset>
    {(sql && model.server.windowsOnly || !model.server.canCreate || model.databasesTruncated || model.certificatesTruncated || model.asymmetricKeysTruncated) && <ul className="object-dialog-warnings" aria-label="Notes">
      {sql && model.server.windowsOnly && <li><Icon name="warning" /><span>{newLoginMessages.windowsOnly}</span></li>}
      {!model.server.canCreate && <li><Icon name="warning" /><span>{newLoginMessages.canCreate}</span></li>}
      {model.databasesTruncated && <li><Icon name="warning" /><span>{`Only the first ${model.databases.length.toLocaleString('en-US')} databases are listed.`}</span></li>}
      {model.certificatesTruncated && <li><Icon name="warning" /><span>{`Only the first ${model.certificates.length.toLocaleString('en-US')} certificates are listed.`}</span></li>}
      {model.asymmetricKeysTruncated && <li><Icon name="warning" /><span>{`Only the first ${model.asymmetricKeys.length.toLocaleString('en-US')} asymmetric keys are listed.`}</span></li>}
    </ul>}
    {searching && <SelectUserOrGroup open={open} initial={draft.name} onCancel={() => setSearching(false)}
      onOk={name => { setSearching(false); dialogs.updateDraft(renameLogin(draft, name)) }} />}
  </div>
}

/**
 * Login Properties' General page (D2c), New Login's in SSMS's order on an existing login: Login name and its kind read-only (D2e: all
 * five kinds, the login's checked, with its certificate or key); Password and Confirm password blank, which keeps the password (SSMS
 * fills them with a fake value instead); Specify old password and Old password; the policy options; User must change only once a new
 * password is typed; Map to Credential and Mapped Credentials (D2e; not for a Microsoft Entra login); then Default database and
 * Default language, which has no <default> here (SMO's ALTER for it is unverified).
 */
function LoginPropertiesGeneral({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const { model, draft } = propertiesOf(open)!
  if (!model || !draft) return null
  const secrets = open.secretState, enabled = loginPropertiesEnabled(model, draft, secrets), hints = loginPropertiesHints(model, draft, secrets), sql = sqlLogin(model)
  const matched = sql && secrets?.password === 'set' && secrets.matches, auth = loginAuthOf(model.login.type), blocked = !!loginBlocked(open)
  // The radios say the kind; a Windows group, or Entra's group or application, is worth a note.
  const kind = model.login.type === 'G' || model.login.type === 'X' ? loginDetailWords.types[model.login.type] : undefined
  // A remount empties the password fields after a partial run used their passwords (ObjectDialogService.spend).
  const epoch = open.secretEpoch ?? 0
  return <div className="new-login-page">
    <LoginBlockedNote open={open} />
    <fieldset className="property-grid new-login-fields" disabled={!editable || blocked}>
      <div className="property-row"><label htmlFor="new-login-name">Login name</label>
        <div className="new-login-inline">
          <input id="new-login-name" type="text" readOnly value={draft.name} aria-describedby={kind ? 'login-properties-kind' : undefined} />
          <button type="button" disabled>Search…</button>
        </div></div>
      <AuthRadios auths={offeredAuths(model.server).includes(auth) ? offeredAuths(model.server) : [...offeredAuths(model.server), auth]} checked={auth} describedBy={kind ? 'login-properties-kind' : undefined} />
      {kind && <p className="field-note new-login-kind" id="login-properties-kind">{kind}</p>}
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
      {(auth === 'certificate' || auth === 'asymmetricKey' || offeredAuths(model.server).includes('certificate')) && <SigningRows model={model} draft={draft} editable={false} />}
      <CredentialRows model={model} draft={draft} enabled={{ mapCredential: enabled.mapCredential, credential: enabled.credential }} editable={editable && !blocked} />
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
