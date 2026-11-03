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

/** Whether a login's name has SQL Server's own form, `##…##`. SQL Server compares names without trailing spaces, so `##x## `
 *  names the same login as `##x##` and counts too. C#: LoginRules.SystemName. */
export function isSystemLoginName(name: string): boolean {
  const trimmed = name.replace(/ +$/, '')
  return trimmed.length >= 4 && trimmed.startsWith('##') && trimmed.endsWith('##')
}

/** A login's subtype: sa by principal_id, SQL Server's own by a name that starts and ends with `##` (checked on the name read
 *  back, never by a SQL literal), else its type. Undefined for a type the Logins folder does not list. */
export function loginSubtypeOf(principalId: number, type: string, name: string): LoginSubtype | undefined {
  const byType = (loginTypeSubtypes as Readonly<Record<string, LoginSubtype>>)[type.trim()]
  if (!byType) return undefined
  if (principalId === saPrincipalId) return 'sa'
  if (isSystemLoginName(name)) return 'system'
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
  // Login Properties › Status (D2c) is where SSMS denies it; name it there once Varia has that page.
  windowsGroupDisable: 'A Windows group cannot be disabled. Deny it permission to connect (DENY CONNECT SQL) instead.',
  externalRename: 'A Microsoft Entra login cannot be renamed.',
  notOffered: 'This kind of login does not offer this action.',
  own: 'This is the login this connection uses. Connect with another login to change it.',
  alterAnyLogin: 'You do not have permission to change logins (ALTER ANY LOGIN).',
  controlServer: 'The login is a member of sysadmin: changing it needs CONTROL SERVER.',
  // SQL Server's own answer is 15021, which does not say what is wrong (D4 P3).
  sqlBackslash: "A SQL Server login's name cannot contain a backslash.",
  // SQL Server accepts such a name, and Varia would then take the login for one of SQL Server's own and refuse to change it.
  systemName: "Names that start and end with ## are reserved for SQL Server's own logins."
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
  ownedDatabases: 100, mappedUsers: 100, scanDatabases: 4_096, serviceNames: 4,
  /** How long the mapped-user scan (D4c's, which Login Properties reuses) reads databases before it counts the rest as not
   *  checked, inside the describe's 40 s. */
  scanMs: 20_000,
  /** sys.dm_server_services.servicename, as the login facts carry it. */
  serviceName: 256
} as const

/** What the login preflight (ActionSql.Login) reads in the action's own connection, in master. Counts that need VIEW SERVER
 *  STATE are absent without it, and what the login owns is absent where the preflight leaves it out (ActionSql.LoginAlter,
 *  before an ALTER LOGIN: its scans would wait behind other sessions' changes to any principal). */
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
  /** User sessions signed in as this login (sys.dm_exec_sessions.security_id). A Windows group's members sign in under their own SIDs,
   *  so a group counts none of them (critic D4-6): harmless: a group cannot be disabled, and its DROP is not
   *  refused for its members' sessions (15434; unverified). */
  readonly sessions?: number
  /** The service that runs as this Windows login (sys.dm_server_services, guarded; or an NT SERVICE\ name), read by the
   *  loginFacts describe only; at most loginLimits.serviceName characters. */
  readonly service?: string
  readonly ownedDatabases?: number
  /** At most loginLimits.ownedDatabases, by name. */
  readonly ownedDatabaseNames: readonly string[]
  readonly ownedServerObjects?: number
  /** The SQL Server Agent jobs it owns (Delete Object's describe only); absent when msdb could not be read. */
  readonly ownedJobs?: number
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

/** A database user mapped to a login (D4c): its database and name, the schemas and roles it owns, and whether its database is
 *  read-only. C#: MappedUserDto. */
export interface MappedUser { readonly database: string; readonly user: string; readonly ownedSchemas: number; readonly ownedRoles: number; readonly readOnly: boolean }
/** The mapped-user scan's answer: at most loginLimits.mappedUsers users, how many it found in all, and how many databases it read
 *  and did not (offline, not accessible or readable, a failed read, or past its bound or budget). C#: LoginMappingsDto. */
export interface LoginMappings { readonly users: readonly MappedUser[]; readonly mapped: number; readonly checked: number; readonly notChecked: number }
/** Whether a Delete that drops the mapped users keeps this one: DROP USER fails while it owns a schema (15138) or a role (15421),
 *  and cannot run in a read-only database. C#: ActionService.Kept. */
export const mappedUserKept = (user: MappedUser): boolean => user.ownedSchemas > 0 || user.ownedRoles > 0 || user.readOnly

const counted = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`
/** What Delete Object says about a login (D4c). The note is SSMS's, which shows it once the login is gone; Varia shows it before OK
 *  and offers to delete the users too. */
export const loginDeleteText = {
  mappedHeading: 'Database users mapped to this login',
  noneMapped: 'No database user is mapped to this login.',
  orphanNote: 'Deleting a login does not delete the database users mapped to it. They are left orphaned: they keep their permissions but no login can use them.',
  dropOption: 'Also delete the database users mapped to this login',
  dropHint: 'Users that own schemas are kept. Transfer the schemas first, then delete them in each database.',
  more: (count: number) => `…and ${count.toLocaleString('en-US')} more`,
  notChecked: (count: number) => `${count === 1 ? '1 database was' : `${count.toLocaleString('en-US')} databases were`} not checked (offline or not accessible).`,
  /** The backend refuses to drop more users than it lists (C#: ActionService.TooManyMappedUsers). */
  tooMany: `More than ${loginLimits.mappedUsers.toLocaleString('en-US')} users are mapped. Delete them in each database first, or delete the login without them.`,
  kept: (user: MappedUser) => user.readOnly ? 'kept: the database is read-only'
    : `kept: owns ${[user.ownedSchemas ? counted(user.ownedSchemas, 'schema', 'schemas') : '', user.ownedRoles ? counted(user.ownedRoles, 'role', 'roles') : ''].filter(Boolean).join(' and ')}`,
  /** What Varia's other connections that sign in as the login cannot do once it is gone (critic D4-3). */
  connections: 'cannot reconnect once it is deleted'
} as const

/** The subtypes whose names SQL Server authenticates itself, so a backslash is never part of one. */
export const noBackslashSubtypes: readonly LoginSubtype[] = ['sa', 'sql']
/** Why a login may not take this new name, or undefined: SQL Server's own form (`##…##`, for every subtype), which would
 *  make the login look like one of SQL Server's own; and a backslash in a SQL Server login's name (SQL Server answers 15021,
 *  "Invalid value given for parameter NAME", D4 P3), so Varia says why before sending; a Windows login's name is
 *  DOMAIN\name. C#: LoginRules.NameRefusal. */
export const loginNameRefusal = (subtype: LoginSubtype, newName: string): LoginMessageId | undefined =>
  isSystemLoginName(newName) ? 'systemName' : noBackslashSubtypes.includes(subtype) && newName.includes('\\') ? 'sqlBackslash' : undefined

/** The rules as actions-catalog.json carries them, so C# needs no rules of its own. */
export function loginsCatalog() {
  return {
    detail: loginDetailWords,
    limits: loginLimits,
    messages: loginMessages,
    noBackslash: noBackslashSubtypes,
    ownRefuses: ownLoginRefuses,
    rules: loginSubtypes.map(subtype => ({ subtype, ...loginRules[subtype], greyed: Object.fromEntries(loginVerbs.filter(verb => loginRules[subtype][verb] === 'greyed').map(verb => [verb, loginGreyedMessage(subtype, verb)])) })),
    saPrincipalId,
    typeSubtypes: loginTypeSubtypes
  }
}
