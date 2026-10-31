// New Login (D2a): its draft, SSMS's defaults, which controls are enabled, and the request OK and Script send. No React and no
// password here: the password lives only in ObjectDialogService's secret slot, and this file sees whether it is empty, matches its
// confirmation and is well formed (`SecretState`).
import { loginLimits, publicRole, newLoginMessages, newLoginProblem, type LoginStatusChoice, type NewLoginAuth, type NewLoginGeneral, type NewLoginModel } from '../../../shared/actions/logins.ts'
import type { CreateLoginRequest } from '../../../shared/actions/schema.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import type { ExplorerMenuNode } from '../menus/targets'

/** What the dialog knows of its password fields: never their values. */
export interface SecretState {
  readonly password: 'empty' | 'set'
  /** Password equals Confirm password, ordinal. */
  readonly matches: boolean
  /** No half of a surrogate pair, so SQL Server receives what was typed. */
  readonly wellFormed: boolean
  /** Longer than SQL Server takes: the field allows one character more, so a longer paste is refused rather than cut short. */
  readonly tooLong: boolean
}
export const emptySecrets: SecretState = { password: 'empty', matches: true, wellFormed: true, tooLong: false }
/** A password field's maxLength: one over the limit, so a paste longer than SQL Server takes shows the problem (`tooLong`) instead
 *  of being cut silently to a password the user never typed in full. */
export const passwordFieldLength = loginLimits.password + 1

/** The pages' state. The password options keep what the user checked; a greyed one counts as unchecked (`newLoginEnabled`). */
export interface NewLoginDraft {
  readonly auth: NewLoginAuth
  readonly name: string
  readonly defaultDatabase: string
  /** Undefined: `<default>`, the server's default language (no DEFAULT_LANGUAGE clause). */
  readonly defaultLanguage?: string
  readonly checkPolicy: boolean
  readonly checkExpiration: boolean
  readonly mustChange: boolean
  /** Checked server roles other than public, by name. */
  readonly serverRoles: readonly string[]
  readonly connect: LoginStatusChoice['connect']
  readonly enabled: boolean
}

/**
 * SSMS's New Login defaults (its LoginPrototypeData): Windows authentication, or SQL Server authentication when the server runs
 * on Linux; master; the three password options on; no server role but public; Grant; Enabled.
 */
export function initialNewLoginDraft(model: NewLoginModel): NewLoginDraft {
  return {
    auth: model.server.linux ? 'sql' : 'windows', name: '', defaultDatabase: 'master', checkPolicy: true, checkExpiration: true, mustChange: true,
    serverRoles: [], connect: 'grant', enabled: true
  }
}

/** Which General page controls are enabled: the password fields and options for SQL Server authentication only, each option
 *  only while the one before it is checked (SQL Server refuses CHECK_EXPIRATION without CHECK_POLICY, 15122, and MUST_CHANGE
 *  without CHECK_EXPIRATION, 15099). Specify old password is Login Properties'. */
export function newLoginEnabled(draft: NewLoginDraft) {
  const sql = draft.auth === 'sql'
  return { password: sql, checkPolicy: sql, checkExpiration: sql && draft.checkPolicy, mustChange: sql && draft.checkPolicy && draft.checkExpiration, oldPassword: false } as const
}

/** The General page as the request carries it: the password options only for SQL Server authentication, as enabled. */
export function newLoginGeneral(draft: NewLoginDraft): NewLoginGeneral {
  const enabled = newLoginEnabled(draft)
  return {
    auth: draft.auth, name: draft.name, defaultDatabase: draft.defaultDatabase, ...(draft.defaultLanguage !== undefined ? { defaultLanguage: draft.defaultLanguage } : {}),
    ...(draft.auth === 'sql' ? { checkPolicy: draft.checkPolicy, checkExpiration: enabled.checkExpiration && draft.checkExpiration, mustChange: enabled.mustChange && draft.mustChange } : {})
  }
}

/** The General page's password notes: the policy one only while the policy is checked (CHECK_POLICY=OFF skips it). */
export function newLoginHints(draft: NewLoginDraft): readonly string[] {
  if (draft.auth !== 'sql') return []
  return newLoginEnabled(draft).checkPolicy && draft.checkPolicy ? [newLoginMessages.policyServer, newLoginMessages.passwordScript] : [newLoginMessages.passwordScript]
}

/** New Login opens on a SQL Server's Security folder, its Logins folder or a login; its target is the server. */
export function newLoginTarget(node: ExplorerMenuNode): ObjectRef | undefined {
  const onServer = node.ref.type === 'folder' ? node.ref.owner.kind === 'server' && (node.folder === 'logins' || node.folder === 'serverSecurity') : node.kind === 'login'
  return onServer && node.engine === 'box' ? { kind: 'server' } : undefined
}

/** The request OK and Script send, without secrets (only OK attaches the password), or the problem the page shows. Server roles
 *  go in the describe's order, those it no longer lists left out. */
export function newLoginRequest(target: ObjectRef, model: NewLoginModel, draft: NewLoginDraft, secrets: SecretState = emptySecrets): Omit<CreateLoginRequest, 'connectionId' | 'requestId'> | { readonly problem: string } {
  const login = newLoginGeneral(draft)
  const problem = newLoginProblem(login, { empty: secrets.password === 'empty', matches: secrets.matches, wellFormed: secrets.wellFormed, tooLong: secrets.tooLong }, model)
  if (problem) return { problem }
  const chosen = new Set(draft.serverRoles)
  const serverRoles = model.serverRoles.filter(role => role.name !== publicRole && chosen.has(role.name)).map(role => role.name)
  return { action: 'createLogin', target, login, serverRoles, status: { connect: draft.connect, enabled: draft.enabled } }
}
