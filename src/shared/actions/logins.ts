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
    S: 'SQL Server authentication', U: 'Windows user', G: 'Windows group', C: 'Mapped to certificate', K: 'Mapped to asymmetric key',
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
  readonly sessions?: number
  /** The service that runs as this Windows login (sys.dm_server_services, guarded; or an NT SERVICE\ name), read by the
   *  loginFacts describe only; at most loginLimits.serviceName characters. */
  readonly service?: string
  readonly ownedDatabases?: number
  /** At most loginLimits.ownedDatabases, by name. */
  readonly ownedDatabaseNames: readonly string[]
  readonly ownedServerObjects?: number
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
    rolesDescribe: loginDatabaseRolesDescribe,
    scriptHeader: passwordScriptHeader,
    typeSubtypes: loginTypeSubtypes
  }
}

// --- New Login (D2a) ---------------------------------------------------------------------------------------------------

/** How a new login authenticates. D2a offers SSMS's first two; certificate, asymmetric key and Microsoft Entra come with D2e. */
export const newLoginAuths = ['windows', 'sql'] as const
export type NewLoginAuth = typeof newLoginAuths[number]
/** New Login's General page as the request carries it. The SQL Server authentication options are present exactly for `sql`,
 *  and follow SQL Server's chain: MUST_CHANGE needs CHECK_EXPIRATION (15099), which needs CHECK_POLICY (15122). */
export interface NewLoginGeneral {
  readonly auth: NewLoginAuth
  /** Used verbatim, at most 128 UTF-16 units; a Windows login is DOMAIN\name, a SQL login has no backslash (15006). */
  readonly name: string
  readonly defaultDatabase: string
  /** Absent: the server's default language (no DEFAULT_LANGUAGE clause). */
  readonly defaultLanguage?: string
  readonly checkPolicy?: boolean
  readonly checkExpiration?: boolean
  readonly mustChange?: boolean
}
/** The Status page: Permission to connect to database engine (Grant or Deny) and Login (Enabled or Disabled). */
export interface LoginStatusChoice { readonly connect: 'grant' | 'deny'; readonly enabled: boolean }
/** Passwords, only ever on actions.execute (sensitive as a whole); at most loginLimits.password UTF-16 units, no U+0000, well formed. */
export interface LoginSecrets { readonly password?: string; readonly oldPassword?: string }

/** A database as New Login's Default database list and User Mapping show it: its sys.databases state, whether this login can
 *  open it, and whether it is read-only (set READ_ONLY, a log-shipping standby or a database snapshot), where no user can be
 *  created. */
export interface NewLoginDatabase { readonly name: string; readonly state: number; readonly accessible: boolean; readonly readOnly: boolean }
/** A language from sys.syslanguages: SSMS lists names; the alias is secondary text. */
export interface NewLoginLanguage { readonly name: string; readonly alias: string }
/** A server role from sys.server_principals (type R): fixed roles, SQL Server 2022's ##MS_…## roles, and user-defined ones. */
export interface NewLoginServerRole { readonly name: string; readonly fixed: boolean }
/** What New Login's describe reads in master (the newLogin describe id, target the server). */
export interface NewLoginModel {
  readonly server: {
    /** The version band (13 = SQL Server 2016 … 17 = 2025). */
    readonly level: number
    readonly linux: boolean
    /** SERVERPROPERTY('IsIntegratedSecurityOnly'): Windows Authentication mode only. */
    readonly windowsOnly: boolean
    /** HAS_PERMS_BY_NAME ALTER ANY LOGIN; advisory, the server decides on OK. */
    readonly canCreate: boolean
  }
  readonly databases: readonly NewLoginDatabase[]
  readonly databasesTruncated: boolean
  readonly languages: readonly NewLoginLanguage[]
  readonly serverRoles: readonly NewLoginServerRole[]
  readonly serverRolesTruncated: boolean
}
/** A Windows login's name: DOMAIN\name, one backslash with text on both sides (the server answers 15407 otherwise). */
export const windowsLoginName = /^[^\\]+\\[^\\]+$/
/** Every login is a member of public, so it is shown checked and greyed, and never requested. */
export const publicRole = 'public'

/** New Login's messages in Varia's words where SSMS's exact text is unverified. They name fields, never values. */
export const newLoginMessages = {
  nameRequired: 'Enter a login name.',
  sqlBackslash: 'A SQL Server login name cannot contain a backslash.',
  windowsName: 'Enter a Windows login as DOMAIN\\name.',
  mismatch: 'Password and confirm password do not match.',
  tooLong: `A password can have at most ${loginLimits.password} characters.`,
  broken: 'The password holds a broken character (half of a surrogate pair), which SQL Server would not receive as typed. Retype the password.',
  blankWithoutPolicy: 'Enter a password. A blank password needs Enforce password policy, so the server can refuse it.',
  defaultDatabase: 'Choose a default database from the list.',
  defaultLanguage: 'Choose a default language from the list.',
  windowsOnly: 'This server accepts Windows authentication only. The login can\'t connect until SQL Server and Windows Authentication mode is turned on.',
  canCreate: 'You may not have permission to create logins (ALTER ANY LOGIN). The server checks when you press OK.',
  passwordsMatch: 'Passwords match.',
  policyServer: 'The server checks its password policy on OK.',
  passwordScript: 'Sent only with OK; Script shows PASSWORD=<password>.'
} as const
/** The Script Action header for a script with a password placeholder (D2 §5.6, A14): run unedited, the batch fails to parse. */
export const passwordScriptHeader = '/* Varia leaves passwords out of scripts. Replace <password> with the login\'s password, as an N\'…\' literal, before you run this script. */'

/** Why a New Login request cannot be sent, or undefined: the problems the page shows before anything is sent. `password` is
 *  only its length and whether it equals the confirmation, so no value leaves the secret slot. */
export function newLoginProblem(login: NewLoginGeneral, password: { readonly empty: boolean; readonly matches: boolean; readonly wellFormed?: boolean; readonly tooLong?: boolean } | undefined, model?: Pick<NewLoginModel, 'databases' | 'languages'>): string | undefined {
  if (!login.name) return newLoginMessages.nameRequired
  if (login.auth === 'sql' && login.name.includes('\\')) return newLoginMessages.sqlBackslash
  if (login.auth === 'windows' && !windowsLoginName.test(login.name)) return newLoginMessages.windowsName
  if (model && !model.databases.some(database => database.name === login.defaultDatabase)) return newLoginMessages.defaultDatabase
  if (model && login.defaultLanguage !== undefined && !model.languages.some(language => language.name === login.defaultLanguage)) return newLoginMessages.defaultLanguage
  if (login.auth === 'sql' && password) {
    if (password.tooLong) return newLoginMessages.tooLong
    if (!password.matches) return newLoginMessages.mismatch
    if (password.wellFormed === false) return newLoginMessages.broken
    if (password.empty && !login.checkPolicy) return newLoginMessages.blankWithoutPolicy
  }
  return undefined
}

// --- User Mapping (D2b) -------------------------------------------------------------------------------------------------

/** The describe id of User Mapping's lazy read of one database (target `{ kind: 'database', name }`): its roles, whether guest
 *  can connect, and its schemas, read through the database's own module when its row is selected, as SSMS's
 *  InitializeRoleMembership does. Login Properties (D2c) adds the login's user and memberships. */
export const loginDatabaseRolesDescribe = 'loginDatabaseRoles'
/** What `loginDatabaseRoles` answers: at most loginLimits.roles database roles and loginLimits.schemas schemas, by name (one more
 *  read, so a truncation shows), and whether guest has CONNECT there (sys.database_permissions CO, granted). */
export interface LoginDatabaseRoles {
  readonly roles: readonly string[]
  readonly rolesTruncated: boolean
  readonly guest: boolean
  readonly schemas: readonly string[]
  readonly schemasTruncated: boolean
}
/**
 * One mapped database of New Login: CREATE USER [user] FOR LOGIN, then ALTER USER … WITH DEFAULT_SCHEMA when a default schema is
 * chosen (CREATE SCHEMA … AUTHORIZATION [user] too when the database has no such schema), then ALTER ROLE … ADD MEMBER for each
 * role in `rolesAdd` (public never: every user is a member). Login Properties (D2c) adds what changes for a mapped user.
 */
export interface UserMappingChoice {
  readonly database: string
  /** Blank in the grid means the login's name (SSMS fills it in when Map is checked). */
  readonly user: string
  readonly defaultSchema?: string
  readonly rolesAdd: readonly string[]
}
/** The most statements a mapping plans: CREATE USER, the default schema's ALTER USER and CREATE SCHEMA, and one per role. */
export const mappingStatements = (mapping: Pick<UserMappingChoice, 'defaultSchema' | 'rolesAdd'>): number => 1 + (mapping.defaultSchema === undefined ? 0 : 2) + mapping.rolesAdd.length
/** The most statements New Login plans: CREATE LOGIN, Deny, Disable, each server role, and each mapping's. Bounded by
 *  actionLimits.statements (src/shared/actions/catalog.ts), which the request schema, the page and C# all check. */
export function newLoginStatements(request: { readonly serverRoles: readonly string[]; readonly status: LoginStatusChoice; readonly mappings: readonly Pick<UserMappingChoice, 'defaultSchema' | 'rolesAdd'>[] }): number {
  return 1 + (request.status.connect === 'deny' ? 1 : 0) + (request.status.enabled ? 0 : 1) + request.serverRoles.length + request.mappings.reduce((sum, mapping) => sum + mappingStatements(mapping), 0)
}
/** Why a plan is too long (the limit is actionLimits.statements; catalog.ts imports this file, so the number is passed in). */
export const tooManyStatementsMessage = (limit: number) => `This login would need more than ${limit.toLocaleString('en-US')} statements. Map fewer databases, or apply the rest afterwards.`
/** User Mapping's own notes, in Varia's words. They name databases only as the page shows them. */
export const userMappingMessages = {
  rolesLoading: 'Reading the database roles…',
  notMapped: 'Check Map to choose roles for this database.',
  unavailable: 'This database is not online, not accessible to you, or read-only, so it cannot be mapped.',
  mappingsLimit: `At most ${loginLimits.mappings} databases can be mapped at once.`,
  noSchemas: 'This database lists no schemas.'
} as const
