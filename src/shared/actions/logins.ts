// Logins: their subtypes, the rules that protect some of them, the limits of the login dialogs and actions, and the facts
// the backend's login preflight (ActionSql.Login) reads. The one place these live (critic A18): Object Explorer's login
// subtypes, the menus' greying and the backend's refusals all come from here, the backend through actions-catalog.json.
// Erasable TypeScript (no enums), so Node's type stripping can load it too.

// One entry per line, so later subtypes append cleanly.
export const loginSubtypes = [
  'sa',
  'system',
  'sql',
  'windowsUser',
  'windowsGroup',
  'certificateMapped',
  'asymmetricKeyMapped',
  'externalUser',
  'externalGroup'
] as const
export type LoginSubtype = typeof loginSubtypes[number]

/** sys.server_principals.type of each login the Logins folder lists, and the subtype it gives (sa and SQL Server's own
 *  `##…##` logins aside). */
export const loginTypeSubtypes = {
  S: 'sql', U: 'windowsUser', G: 'windowsGroup', C: 'certificateMapped', K: 'asymmetricKeyMapped', E: 'externalUser', X: 'externalGroup'
} as const satisfies Record<string, LoginSubtype>
export type LoginType = keyof typeof loginTypeSubtypes
/** sa keeps principal_id 1 whatever it is renamed to. */
export const saPrincipalId = 1

/** A login's subtype: sa by principal_id, SQL Server's own by a name that starts and ends with `##` (checked on the name read
 *  back, never by a SQL literal), else its type. Undefined for a type the Logins folder does not list. */
export function loginSubtypeOf(principalId: number, type: string, name: string): LoginSubtype | undefined {
  const byType = (loginTypeSubtypes as Readonly<Record<string, LoginSubtype>>)[type.trim()]
  if (!byType) return undefined
  if (principalId === saPrincipalId) return 'sa'
  if (name.length >= 4 && name.startsWith('##') && name.endsWith('##')) return 'system'
  return byType
}

/**
 * A login row's status in Object Explorer (D4a): `disabled` when the login is disabled, else `noAccess` when CONNECT SQL is
 * denied to it. They were one status before; they stay apart because they are lifted apart (ENABLE leaves a DENY CONNECT
 * SQL in place, D4 P18). A login with both is `disabled`, and its detail names both.
 */
export function loginStatusOf(disabled: boolean, connectDenied: boolean): 'disabled' | 'noAccess' | undefined {
  return disabled ? 'disabled' : connectDenied ? 'noAccess' : undefined
}
/** The words of a login row's detail (its tooltip): its kind by sys.server_principals.type, then its state and password
 *  policy, from catalog views only (sys.server_principals, sys.server_permissions and sys.sql_logins). */
export const loginDetailWords = {
  types: {
    S: 'SQL Server authentication', U: 'Windows user', G: 'Windows group', C: 'Mapped to a certificate', K: 'Mapped to an asymmetric key',
    E: 'Microsoft Entra user or application', X: 'Microsoft Entra group'
  },
  disabled: 'Disabled',
  connectDenied: 'Permission to connect denied',
  policyChecked: 'Password policy enforced',
  expirationChecked: 'Password expiration enforced'
} as const satisfies { readonly types: { readonly [T in LoginType]: string }; readonly disabled: string; readonly connectDenied: string; readonly policyChecked: string; readonly expirationChecked: string }
/** What a login row's listing reads besides its name. */
export interface LoginListingFacts { readonly disabled: boolean; readonly connectDenied: boolean; readonly policyChecked: boolean; readonly expirationChecked: boolean }
/** A login row's detail: its kind, then Disabled and Permission to connect denied (both when both apply), then the password
 *  policy flags, joined with " · " (C#: LoginRules.Detail, from actions-catalog.json). */
export function loginDetail(type: string, facts: LoginListingFacts): string {
  const words = loginDetailWords
  return [(words.types as Readonly<Record<string, string>>)[type.trim()], facts.disabled && words.disabled, facts.connectDenied && words.connectDenied,
    facts.policyChecked && words.policyChecked, facts.expirationChecked && words.expirationChecked].filter((part): part is string => !!part).join(' · ')
}

/** The verbs a login's rules decide (D4b-d, and Properties' Status page in D2c). */
export const loginVerbs = ['disable', 'enable', 'unlock', 'rename', 'delete'] as const
export type LoginVerb = typeof loginVerbs[number]
/** 'allowed'; 'greyed' (shown, refused, with its reason); 'hidden' (not offered). */
export type LoginRule = 'allowed' | 'greyed' | 'hidden'
type LoginRules = { readonly [V in LoginVerb]: LoginRule }
const open: LoginRules = { disable: 'allowed', enable: 'allowed', unlock: 'hidden', rename: 'allowed', delete: 'allowed' }
/** D4 §4: which verb each subtype allows. Greying is a convenience for the menus; the backend's preflight re-derives the
 *  subtype in its own connection and refuses by these same rules. */
export const loginRules: { readonly [S in LoginSubtype]: LoginRules } = {
  // Disabling and renaming sa are standard hardening; SQL Server refuses to drop it.
  sa: { disable: 'allowed', enable: 'allowed', unlock: 'allowed', rename: 'allowed', delete: 'greyed' },
  system: { disable: 'greyed', enable: 'greyed', unlock: 'greyed', rename: 'greyed', delete: 'greyed' },
  sql: { ...open, unlock: 'allowed' },
  windowsUser: open,
  // ALTER LOGIN … DISABLE on a Windows group fails with 15151 by design (Learn).
  windowsGroup: { disable: 'greyed', enable: 'hidden', unlock: 'hidden', rename: 'allowed', delete: 'allowed' },
  certificateMapped: open,
  asymmetricKeyMapped: open,
  // Microsoft Entra's ALTER LOGIN grammar has no NAME.
  externalUser: { ...open, rename: 'greyed' },
  externalGroup: { ...open, rename: 'greyed' }
}
/** What the login this connection uses (or a Windows group it gets in through) may not do: Varia would lock itself out, or
 *  its own pools would reconnect under a name that no longer exists. */
export const ownLoginRefuses: readonly LoginVerb[] = ['disable', 'rename', 'delete']

/** Why a verb is refused, as the menus' hints and the backend's NOT_SUPPORTED and PERMISSION_DENIED messages say it. */
export const loginMessages = {
  system: 'This login belongs to SQL Server and cannot be changed.',
  saDelete: 'The sa login cannot be deleted.',
  windowsGroupDisable: 'A Windows group cannot be disabled. Deny it permission to connect in Login Properties › Status.',
  externalRename: 'A Microsoft Entra login cannot be renamed.',
  notOffered: 'This kind of login does not offer this action.',
  own: 'This is the login this connection uses. Connect with another login to change it.',
  alterAnyLogin: 'You do not have permission to change logins (ALTER ANY LOGIN).',
  controlServer: 'The login is a member of sysadmin: changing it needs CONTROL SERVER.'
} as const
export type LoginMessageId = keyof typeof loginMessages
/** The message a subtype's greyed verb answers with. */
export function loginGreyedMessage(subtype: LoginSubtype, verb: LoginVerb): LoginMessageId {
  if (subtype === 'system') return 'system'
  if (subtype === 'sa' && verb === 'delete') return 'saDelete'
  if (subtype === 'windowsGroup' && verb === 'disable') return 'windowsGroupDisable'
  if ((subtype === 'externalUser' || subtype === 'externalGroup') && verb === 'rename') return 'externalRename'
  return 'notOffered'
}

/** Bounds of the login dialogs and actions, D2's (New Login, Login Properties) and D4's (login actions) merged. */
export const loginLimits = {
  /** UTF-16 units of a password. */
  password: 128,
  databases: 4_096, languages: 64, serverRoles: 256,
  /** Per database. */
  roles: 256, schemas: 1_024, mappings: 256,
  /** Per request; 1,024 are listed. */
  credentials: 16, certificates: 1_024, asymmetricKeys: 1_024, permissions: 512,
  /** A SID as hexadecimal text (CONVERT(varchar(172), sid, 2)). */
  sidHex: 172,
  /** An action step's title and detail (ActionStep). */
  stepTitle: 64, stepDetail: 128,
  ownedDatabases: 100, mappedUsers: 100, scanDatabases: 4_096, serviceNames: 4
} as const

/** What the login preflight (ActionSql.Login) reads in the action's own connection, in master. Counts that need VIEW SERVER
 *  STATE are absent without it. */
export interface LoginFacts {
  readonly principalId: number
  readonly type: LoginType
  readonly subtype: LoginSubtype
  readonly disabled: boolean
  /** Hexadecimal, at most loginLimits.sidHex characters. */
  readonly sid: string
  /** create_date as yyyy-MM-ddTHH:mm:ss.fff. */
  readonly created: string
  /** SQL logins only. */
  readonly policyChecked?: boolean
  readonly expirationChecked?: boolean
  readonly connectDenied: boolean
  /** The login this connection uses, or a Windows group it gets in through (sys.login_token). */
  readonly own: boolean
  readonly sysadmin: boolean
  readonly sessions?: number
  readonly ownedDatabases: number
  /** At most loginLimits.ownedDatabases, by name. */
  readonly ownedDatabaseNames: readonly string[]
  readonly ownedServerObjects: number
  readonly canAlter: boolean
  readonly canControlServer: boolean
  readonly nameInUse: boolean
}

/** The refusal of a verb for a login the preflight read, or undefined: its subtype's rule, the own login, then the
 *  permissions SQL Server asks for (ALTER ANY LOGIN, and CONTROL SERVER for a sysadmin). C# evaluates the same rules
 *  (Actions/LoginRules.cs) from actions-catalog.json. */
export function loginRefusal(facts: Pick<LoginFacts, 'subtype' | 'own' | 'sysadmin' | 'canAlter' | 'canControlServer'>, verb: LoginVerb): LoginMessageId | undefined {
  if (loginRules[facts.subtype][verb] !== 'allowed') return loginGreyedMessage(facts.subtype, verb)
  if (facts.own && ownLoginRefuses.includes(verb)) return 'own'
  if (!facts.canAlter) return 'alterAnyLogin'
  if (facts.sysadmin && !facts.canControlServer) return 'controlServer'
  return undefined
}

/** The rules as actions-catalog.json carries them, so C# needs no rules of its own. */
export function loginsCatalog() {
  return {
    detail: loginDetailWords,
    limits: loginLimits,
    messages: loginMessages,
    ownRefuses: ownLoginRefuses,
    rules: loginSubtypes.map(subtype => ({ subtype, ...loginRules[subtype], greyed: Object.fromEntries(loginVerbs.filter(verb => loginRules[subtype][verb] === 'greyed').map(verb => [verb, loginGreyedMessage(subtype, verb)])) })),
    saPrincipalId,
    typeSubtypes: loginTypeSubtypes
  }
}
