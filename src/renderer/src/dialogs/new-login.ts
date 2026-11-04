// New Login (D2a, D2b): its draft, SSMS's defaults, which controls are enabled, and the request OK and Script send. No React and no
// password here: the password lives only in ObjectDialogService's secret slot, and this file sees whether it is empty, matches its
// confirmation and is well formed (`SecretState`).
import { actionLimits } from '../../../shared/actions/catalog.ts'
import {
  loginLimits, newLoginMessages, newLoginProblem, newLoginStatements, publicRole, tooManyStatementsMessage, userMappingMessages, type LoginStatusChoice, type NewLoginAuth, type NewLoginGeneral,
  type NewLoginModel, type UserMappingChoice
} from '../../../shared/actions/logins.ts'
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
  /** User Mapping's rows the user has touched, by database: kept when Map is cleared, so checking it again restores them. */
  readonly mappings: readonly MappingDraft[]
  /** User Mapping's selected row, whose guest state and roles show below the grid. */
  readonly mappingDatabase?: string
}
/** One User Mapping row as edited: Map, the User and Default Schema as typed (blank schema: none), and the database roles checked
 *  other than public. */
export interface MappingDraft {
  readonly database: string
  readonly map: boolean
  readonly user: string
  readonly defaultSchema: string
  readonly roles: readonly string[]
}

/**
 * SSMS's New Login defaults (its LoginPrototypeData): Windows authentication, or SQL Server authentication when the server runs
 * on Linux; master; the three password options on; no server role but public; Grant; Enabled.
 */
export function initialNewLoginDraft(model: NewLoginModel): NewLoginDraft {
  return {
    auth: model.server.linux ? 'sql' : 'windows', name: '', defaultDatabase: 'master', checkPolicy: true, checkExpiration: true, mustChange: true,
    serverRoles: [], connect: 'grant', enabled: true, mappings: []
  }
}

// --- User Mapping (D2b) ---

/** A database's row as edited, or a fresh one: unmapped, with no user, schema or role. */
export function mappingOf(draft: Pick<NewLoginDraft, 'mappings'>, database: string): MappingDraft {
  return draft.mappings.find(mapping => mapping.database === database) ?? { database, map: false, user: '', defaultSchema: '', roles: [] }
}
const withMapping = (draft: NewLoginDraft, next: MappingDraft): Pick<NewLoginDraft, 'mappings'> =>
  ({ mappings: draft.mappings.some(mapping => mapping.database === next.database) ? draft.mappings.map(mapping => mapping.database === next.database ? next : mapping) : [...draft.mappings, next] })
/** Whether a database can be mapped: online and open to this login (SSMS greys the others, checking Status & Normal), and not
 *  read-only, where CREATE USER fails (3906) after CREATE LOGIN has already run. */
export const mappable = (database: NewLoginModel['databases'][number]) => database.state === 0 && database.accessible && !database.readOnly
/** Map checked or cleared. Checking it fills a blank User with the login name, as SSMS does ("By default, the database user has
 *  the same name as the login"). */
export function setMapped(draft: NewLoginDraft, database: string, map: boolean): Pick<NewLoginDraft, 'mappings'> {
  const current = mappingOf(draft, database)
  return withMapping(draft, { ...current, map, user: map && !current.user ? draft.name : current.user })
}
export const setMappingUser = (draft: NewLoginDraft, database: string, user: string) => withMapping(draft, { ...mappingOf(draft, database), user })
export const setMappingSchema = (draft: NewLoginDraft, database: string, defaultSchema: string) => withMapping(draft, { ...mappingOf(draft, database), defaultSchema })
export function setMappingRole(draft: NewLoginDraft, database: string, role: string, checked: boolean): Pick<NewLoginDraft, 'mappings'> {
  const current = mappingOf(draft, database), roles = current.roles.filter(name => name !== role)
  return withMapping(draft, { ...current, roles: checked && role !== publicRole ? [...roles, role] : roles })
}
/** The login name changed: as SSMS's UpdateDefaultSchemaAndUserNames does, a row whose User or Default Schema was the old name
 *  follows the new one, an unmapped row too, so checking Map again never maps a user named after an earlier login name. A blank
 *  field stays blank: a blank User already means the login name, and a blank Default Schema means none (no ALTER USER, no
 *  CREATE SCHEMA), even while the name is typed after Map was checked or after it was cleared. */
export function renameLogin(draft: NewLoginDraft, name: string): Pick<NewLoginDraft, 'name' | 'mappings'> {
  const follow = (value: string) => value !== '' && value === draft.name ? name : value
  return { name, mappings: draft.name === name ? draft.mappings : draft.mappings.map(mapping => ({ ...mapping, user: follow(mapping.user), defaultSchema: follow(mapping.defaultSchema) })) }
}
/** The User a mapped row shows and OK sends: a blank one is the login name. */
export const mappedUser = (draft: Pick<NewLoginDraft, 'name'>, mapping: MappingDraft) => mapping.user || draft.name
/** The mappings OK sends: mapped rows of databases the describe lists and that can be mapped, in its order (by name); a blank User
 *  is the login name and a blank Default Schema none; roles by name. */
export function userMappings(model: NewLoginModel, draft: NewLoginDraft): UserMappingChoice[] {
  const byName = new Map(draft.mappings.filter(mapping => mapping.map).map(mapping => [mapping.database, mapping]))
  return model.databases.filter(database => mappable(database) && byName.has(database.name)).map(database => {
    const mapping = byName.get(database.name)!
    const roles = [...new Set(mapping.roles)].filter(role => role !== publicRole).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    return { database: database.name, user: mappedUser(draft, mapping), ...(mapping.defaultSchema ? { defaultSchema: mapping.defaultSchema } : {}), rolesAdd: roles }
  })
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
 *  go in the describe's order, those it no longer lists left out; mappings as userMappings builds them, within loginLimits.mappings
 *  and actionLimits.statements. */
export function newLoginRequest(target: ObjectRef, model: NewLoginModel, draft: NewLoginDraft, secrets: SecretState = emptySecrets): Omit<CreateLoginRequest, 'connectionId' | 'requestId'> | { readonly problem: string } {
  const login = newLoginGeneral(draft)
  const problem = newLoginProblem(login, { empty: secrets.password === 'empty', matches: secrets.matches, wellFormed: secrets.wellFormed, tooLong: secrets.tooLong }, model)
  if (problem) return { problem }
  const chosen = new Set(draft.serverRoles)
  const serverRoles = model.serverRoles.filter(role => role.name !== publicRole && chosen.has(role.name)).map(role => role.name)
  const mappings = userMappings(model, draft), status = { connect: draft.connect, enabled: draft.enabled }
  if (mappings.length > loginLimits.mappings) return { problem: userMappingMessages.mappingsLimit }
  if (newLoginStatements({ serverRoles, status, mappings }) > actionLimits.statements) return { problem: tooManyStatementsMessage(actionLimits.statements) }
  return { action: 'createLogin', target, login, serverRoles, mappings, status }
}
