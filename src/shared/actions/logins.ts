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
  // Login Properties › Status (D2c) is where SSMS denies it.
  windowsGroupDisable: 'A Windows group cannot be disabled. Deny it permission to connect on Login Properties › Status instead.',
  externalRename: 'A Microsoft Entra login cannot be renamed.',
  notOffered: 'This kind of login does not offer this action.',
  own: 'This is the login this connection uses. Connect with another login to change it.',
  alterAnyLogin: 'You do not have permission to change logins (ALTER ANY LOGIN).',
  controlServer: 'The login is a member of sysadmin: changing it needs CONTROL SERVER.',
  // SQL Server's own answer is 15021, which does not say what is wrong (D4 P3).
  sqlBackslash: "A SQL Server login's name cannot contain a backslash.",
  // SQL Server accepts such a name, and Varia would then take the login for one of SQL Server's own and refuse to change it.
  systemName: "Names that start and end with ## are reserved for SQL Server's own logins.",
  // A login's Delete drops its users before the login; a session it cannot see would then fail the login's DROP (15434) after them.
  sessionsUncounted: "This connection cannot count the login's sessions (that needs VIEW SERVER STATE), and one would make its DROP fail after its users were deleted. Delete the login without its users.",
  // Unlock… (D4d). Only a SQL Server login that enforces the password policy is ever locked out; turning the policy on for one
  // that does not would change it rather than unlock it.
  unlockNoPolicy: 'The login does not enforce the password policy, so it is never locked out.',
  // SQL Server refuses CHECK_POLICY = OFF while MUST_CHANGE is set (15128), so only a new password unlocks such a login.
  unlockMustChange: 'The login must change its password at its next sign-in, so its password policy cannot be turned off. Unlock it by setting a new password.',
  notLocked: 'The login is not locked out.',
  // Unlock's plan turns back on the policy and expiration its preflight read; it reads them again in its transaction and stops
  // there when another session changed them meanwhile, rather than undo that change.
  unlockChanged: "The login's password policy changed while Unlock ran, so nothing was changed. Try again.",
  // Login Properties (D2c): the login this connection uses may change its own password and defaults, but Deny or Disable would
  // lock Varia out (owner decision 7).
  ownStatus: 'This is the login this connection uses. Denying it permission to connect or disabling it would lock this connection out. Connect with another login to change its status.',
  // SQL Server then refuses the login's new sign-ins (18488) until its password changes, which Varia's pools cannot do.
  ownMustChange: "This is the login this connection uses. Requiring a new password at its next sign-in would refuse this connection's new sessions. Connect with another login to require it.",
  // Only SQL Server authenticates a SQL Server login's password; a request for another kind is refused before anything runs.
  propertiesNotSql: 'Only a SQL Server login has a password and a password policy.',
  // D2e: Managed Instance's ALTER LOGIN for a Microsoft Entra login takes only ENABLE, DISABLE and the defaults (Learn).
  externalCredentials: 'A Microsoft Entra login cannot be mapped to a credential here.',
  // SQL Server refuses DEFAULT_SCHEMA for a user mapped to a certificate or an asymmetric key (15259, probed).
  signingSchema: 'A user mapped to a certificate or an asymmetric key has no default schema.'
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
  /** Credentials New Login's list and a login's Mapped Credentials grid show (D2e). */
  listedCredentials: 1_024,
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
  /** The server permissions it granted to other principals (DROP LOGIN fails on them, 15173); with the owned counts. */
  readonly grantedPermissions?: number
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

/** A database user mapped to a login (D4c): its database and name, the schemas, roles and other securables it owns, the permissions
 *  it granted to others, whether its database is read-only, and whether this connection may drop users there (ALTER ANY USER).
 *  C#: MappedUserDto. */
export interface MappedUser {
  readonly database: string; readonly user: string; readonly ownedSchemas: number; readonly ownedRoles: number; readonly readOnly: boolean
  readonly ownedSecurables: number; readonly grantedPermissions: number; readonly canDrop: boolean
}
/** The mapped-user scan's answer: at most loginLimits.mappedUsers users, how many it found in all, and how many databases it read
 *  and did not (offline, not accessible or readable, a failed read, or past its bound or budget). C#: LoginMappingsDto. */
export interface LoginMappings { readonly users: readonly MappedUser[]; readonly mapped: number; readonly checked: number; readonly notChecked: number }
/** Whether a Delete that drops the mapped users keeps this one: DROP USER fails while it owns a schema (15138), a role (15421) or
 *  another securable (15138, 15183), or has granted permissions (15284), cannot run in a read-only database, and needs ALTER ANY
 *  USER there. C#: ActionService.Kept. */
export const mappedUserKept = (user: MappedUser): boolean =>
  user.ownedSchemas > 0 || user.ownedRoles > 0 || user.ownedSecurables > 0 || user.grantedPermissions > 0 || user.readOnly || !user.canDrop

const counted = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`
/** What Delete Object says about a login (D4c). The note is SSMS's, which shows it once the login is gone; Varia shows it before OK
 *  and offers to delete the users too. */
export const loginDeleteText = {
  mappedHeading: 'Database users mapped to this login',
  noneMapped: 'No database user is mapped to this login.',
  /** The empty list when some databases were not read. */
  noneMappedChecked: 'No database user is mapped to this login in the databases checked.',
  orphanNote: 'Deleting a login does not delete the database users mapped to it. They are left orphaned: they keep their permissions but no login can use them.',
  dropOption: 'Also delete the database users mapped to this login',
  dropHint: 'Users that own schemas or other securables, or have granted permissions, are kept. Transfer or revoke those first, then delete the users in each database.',
  /** Why the option is greyed: nothing to drop, every mapped user kept, too many to list, or sessions it cannot count. */
  noneToDrop: 'There is no mapped user to delete.',
  allKept: 'Every mapped user is kept, as listed: none can be deleted with the login.',
  sessionsUncounted: loginMessages.sessionsUncounted,
  more: (count: number) => `…and ${count.toLocaleString('en-US')} more`,
  notChecked: (count: number) => `${count === 1 ? '1 database was' : `${count.toLocaleString('en-US')} databases were`} not checked (offline or not accessible).`,
  /** The backend refuses to drop more users than it lists (C#: ActionService.TooManyMappedUsers). */
  tooMany: `More than ${loginLimits.mappedUsers.toLocaleString('en-US')} users are mapped. Delete them in each database first, or delete the login without them.`,
  /** Why a Delete keeps a user: every reason its DROP USER would fail, as one note. */
  kept: (user: MappedUser) => `kept: ${[
    user.readOnly ? 'the database is read-only' : '',
    !user.canDrop ? 'you cannot delete users there (ALTER ANY USER)' : '',
    user.ownedSchemas || user.ownedRoles || user.ownedSecurables ? `owns ${[user.ownedSchemas ? counted(user.ownedSchemas, 'schema', 'schemas') : '', user.ownedRoles ? counted(user.ownedRoles, 'role', 'roles') : '',
      user.ownedSecurables ? counted(user.ownedSecurables, 'other securable', 'other securables') : ''].filter(Boolean).join(' and ')}` : '',
    user.grantedPermissions ? `has granted ${counted(user.grantedPermissions, 'permission', 'permissions')}` : ''
  ].filter(Boolean).join('; ')}`,
  /** What Varia's other connections that sign in as the login do to its Delete (critic D4-3): their pools' sessions fail the DROP
   *  (15434) until they disconnect, and Activity Monitor neither shows nor ends Varia's own sessions. */
  connections: (count: number) => count === 1 ? 'its sessions fail the DROP until it is disconnected' : 'their sessions fail the DROP until they are disconnected'
} as const
/**
 * A login's lock-out state, which only LOGINPROPERTY knows (ActionSql.LoginLock, the one statement allowed to call it, D4 §7):
 * read by Unlock…'s describe and again by its preflight. `lockoutTime` (the server's clock, yyyy-MM-ddTHH:mm:ss.fff) only
 * while locked; `daysUntilExpiration` only while the password expires.
 */
export interface LoginLockFacts {
  readonly locked: boolean
  readonly badPasswords?: number
  readonly lockoutTime?: string
  readonly mustChange: boolean
  readonly expired: boolean
  readonly daysUntilExpiration?: number
}
/** How Unlock… unlocks (D4d, owner decision 9): keeping the current password, by turning the password policy off and on
 *  again in one transaction (which clears the password history). D2c's Login Properties adds setting a new password, SSMS's way,
 *  as the dialog's first choice; that hand-off sends no request of its own. */
export const unlockModes = ['keepPassword'] as const
/** The only LOGINPROPERTY properties Varia reads (ActionSql.LoginLock, critic A15): never PasswordHash or
 *  PasswordHashAlgorithm. The backend checks its statement against this list (LoginRules.LockProperties). */
export const loginLockProperties = ['IsLocked', 'BadPasswordCount', 'LockoutTime', 'IsMustChange', 'IsExpired', 'DaysUntilExpiration'] as const
export type UnlockMode = typeof unlockModes[number]
/** Why Unlock… cannot keep the password now, or undefined: the login's rules (loginRefusal), then a login that is not a SQL
 *  Server login enforcing the password policy, one that must change its password, and one that is not locked out. C#:
 *  LoginRules.UnlockRefusal. */
export function unlockRefusal(facts: Pick<LoginFacts, 'subtype' | 'own' | 'sysadmin' | 'canAlter' | 'canControlServer' | 'type' | 'policyChecked'>, lock: Pick<LoginLockFacts, 'locked' | 'mustChange'>): LoginMessageId | undefined {
  return loginRefusal(facts, 'unlock') ?? (facts.type !== 'S' || facts.policyChecked !== true ? 'unlockNoPolicy' : lock.mustChange ? 'unlockMustChange' : !lock.locked ? 'notLocked' : undefined)
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
    lockProperties: loginLockProperties,
    messages: loginMessages,
    noBackslash: noBackslashSubtypes,
    ownRefuses: ownLoginRefuses,
    rules: loginSubtypes.map(subtype => ({ subtype, ...loginRules[subtype], greyed: Object.fromEntries(loginVerbs.filter(verb => loginRules[subtype][verb] === 'greyed').map(verb => [verb, loginGreyedMessage(subtype, verb)])) })),
    saPrincipalId,
    rolesDescribe: loginDatabaseRolesDescribe,
    // D2e: the kinds per engine, the policy options' engines, which kinds take credentials and defaults, and Check Names.
    newLogin: {
      authEngines: newLoginAuthEngines, entraBand: entraBoxBand, policyEngines: newLoginPolicyEngines, credentialAuths, defaultsAuths,
      messages: Object.fromEntries((['authNotOffered', 'entraVersion', 'policyManagedInstance', 'policyRequired'] as const).map(id => [id, newLoginMessages[id]]))
    },
    checkNames: { describe: windowsPrincipalDescribe, permission: checkNamesText.permission, notFound: checkNamesText.notFound },
    scriptHeader: passwordScriptHeader,
    typeSubtypes: loginTypeSubtypes
  }
}

// --- New Login (D2a) ---------------------------------------------------------------------------------------------------

/** How a new login authenticates, in SSMS's order on the General page (D2a: Windows and SQL Server; D2e: Microsoft Entra, certificate
 *  and asymmetric key). */
// One entry per line, so later kinds append cleanly.
export const newLoginAuths = [
  'windows',
  'sql',
  'entra',
  'certificate',
  'asymmetricKey'
] as const
export type NewLoginAuth = typeof newLoginAuths[number]
/** The servers New Login runs on (createActionSpecs.createLogin.engines), as the describe reports them. */
export type NewLoginEngine = 'box' | 'managedInstance'
/**
 * Which kinds a server offers (D2 §7): Managed Instance's CREATE LOGIN takes only a password or FROM EXTERNAL PROVIDER (Learn, MI
 * moniker), so Windows, certificate and asymmetric key logins are SQL Server's; Microsoft Entra on SQL Server from 2022 (band 16),
 * which answers 37525 until Azure Arc and Entra are set up there. C# reads these from actions-catalog.json (LoginRules.AuthRefusal).
 */
export const newLoginAuthEngines: { readonly [A in NewLoginAuth]: readonly NewLoginEngine[] } = {
  windows: ['box'], sql: ['box', 'managedInstance'], entra: ['box', 'managedInstance'], certificate: ['box'], asymmetricKey: ['box']
}
/** The first SQL Server band whose CREATE LOGIN takes FROM EXTERNAL PROVIDER (2022); Managed Instance always does. */
export const entraBoxBand = 16
/** Where CREATE LOGIN takes CHECK_POLICY, CHECK_EXPIRATION and MUST_CHANGE: Managed Instance's grammar has none of them (SSMS's
 *  ported SupportAdvancedPasswordOptions hides them there too), though its ALTER LOGIN takes them. */
export const newLoginPolicyEngines: readonly NewLoginEngine[] = ['box']
/** The kinds a credential can be mapped to: Managed Instance's ALTER LOGIN for a Microsoft Entra login takes only ENABLE, DISABLE and
 *  the defaults (Learn), and SQL Server's for one is unverified, so Map to Credential is greyed for Entra logins. */
export const credentialAuths: readonly NewLoginAuth[] = ['windows', 'sql', 'certificate', 'asymmetricKey']
/** The kinds whose CREATE LOGIN takes DEFAULT_DATABASE and DEFAULT_LANGUAGE: not certificate or asymmetric key (SMO writes neither for
 *  them, and FROM CERTIFICATE … WITH DEFAULT_DATABASE is a syntax error, 102, probed). */
export const defaultsAuths: readonly NewLoginAuth[] = ['windows', 'sql', 'entra']
/** Whether a server offers a kind of login. */
export const newLoginAuthOffered = (server: { readonly engine: NewLoginEngine; readonly level: number }, auth: NewLoginAuth): boolean =>
  newLoginAuthEngines[auth].includes(server.engine) && (auth !== 'entra' || server.engine !== 'box' || server.level >= entraBoxBand)
/** The General page's radio per kind, by SSMS's labels (D2e adds the last three; the Microsoft Entra label is unverified for SSMS 22). */
export const newLoginAuthLabels: { readonly [A in NewLoginAuth]: string } = {
  windows: 'Windows authentication', sql: 'SQL Server authentication', entra: 'Microsoft Entra authentication', certificate: 'Mapped to certificate', asymmetricKey: 'Mapped to asymmetric key'
}
/** New Login's General page as the request carries it. The SQL Server authentication options are present for `sql` on SQL Server
 *  and absent on Managed Instance, and follow SQL Server's chain: MUST_CHANGE needs CHECK_EXPIRATION (15099), which needs CHECK_POLICY
 *  (15122). A certificate or asymmetric key login names its certificate or key and has no defaults. */
export interface NewLoginGeneral {
  readonly auth: NewLoginAuth
  /** Used verbatim, at most 128 UTF-16 units; a Windows login is DOMAIN\name, a SQL login has no backslash (15006). */
  readonly name: string
  /** Present exactly for the defaultsAuths. */
  readonly defaultDatabase?: string
  /** Absent: the server's default language (no DEFAULT_LANGUAGE clause). */
  readonly defaultLanguage?: string
  readonly checkPolicy?: boolean
  readonly checkExpiration?: boolean
  readonly mustChange?: boolean
  /** A master certificate's name, exactly for `certificate`. */
  readonly certificate?: string
  /** A master asymmetric key's name, exactly for `asymmetricKey`. */
  readonly asymmetricKey?: string
  /** Map to Credential's Mapped Credentials, at most loginLimits.credentials (ALTER LOGIN … ADD CREDENTIAL each, after Disable). */
  readonly credentials?: readonly string[]
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
/** A credential from sys.credentials, with its cryptographic provider's name for an EKM credential (Mapped Credentials' Provider). */
export interface NewLoginCredential { readonly name: string; readonly provider?: string }
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
    /** SQL Server or Azure SQL Managed Instance (D2e), which decides the kinds and options offered. */
    readonly engine: NewLoginEngine
  }
  readonly databases: readonly NewLoginDatabase[]
  readonly databasesTruncated: boolean
  readonly languages: readonly NewLoginLanguage[]
  readonly serverRoles: readonly NewLoginServerRole[]
  readonly serverRolesTruncated: boolean
  /** master's certificates and asymmetric keys, at most loginLimits.certificates and .asymmetricKeys by name (D2e); SQL Server's own
   *  `##MS_…##` ones are listed too, as SSMS lists them. */
  readonly certificates: readonly string[]
  readonly certificatesTruncated: boolean
  readonly asymmetricKeys: readonly string[]
  readonly asymmetricKeysTruncated: boolean
  /** sys.credentials, at most loginLimits.listedCredentials by name (D2e). */
  readonly credentials: readonly NewLoginCredential[]
  readonly credentialsTruncated: boolean
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
  passwordScript: 'Sent only with OK; Script shows PASSWORD=<password>.',
  // D2e: the other kinds, Map to Credential and the engines.
  certificate: 'Choose a certificate from the list.',
  asymmetricKey: 'Choose an asymmetric key from the list.',
  /** A certificate or key login signs code; it cannot connect (Learn, CREATE LOGIN). */
  signingOnly: 'A login mapped to a certificate or an asymmetric key cannot connect to SQL Server: it is used for code signing.',
  noCertificates: 'master has no certificate.',
  noAsymmetricKeys: 'master has no asymmetric key.',
  /** SQL Server 2022 and later need Azure Arc and Microsoft Entra set up (37525 otherwise, probed on 2025). */
  entraBox: 'SQL Server creates Microsoft Entra logins once Azure Arc and Microsoft Entra authentication are set up on it; otherwise OK fails.',
  entraName: 'Type the Microsoft Entra user, group or application as Microsoft Entra ID names it (user@domain for a user).',
  credential: 'Choose a credential from the list.',
  credentialTwice: 'This credential is mapped already.',
  credentialsLimit: `At most ${loginLimits.credentials} credentials can be mapped at once.`,
  noCredentials: 'The server has no credential.',
  credentialsEntra: loginMessages.externalCredentials,
  /** The request asked for a kind the server does not offer (C#: ActionService refuses it as NOT_SUPPORTED). */
  authNotOffered: 'This server does not offer this kind of login.',
  entraVersion: 'Microsoft Entra logins need SQL Server 2022 or later.',
  policyManagedInstance: 'Azure SQL Managed Instance takes no password policy options when it creates a login. Set them in Login Properties afterwards.',
  policyRequired: 'A SQL Server login on SQL Server states its password policy options.'
} as const
/** Check Names (D2 §6, the Search… button's SubDialog "Select User or Group"): the describe id that asks the server about a Windows
 *  account through xp_logininfo (target `{ kind: 'login', name: DOMAIN\name }`), and what it answers. */
export const windowsPrincipalDescribe = 'windowsPrincipal'
/** xp_logininfo's answer: the account name as the server gives it, `user` or `group`, and the path its access comes through (a group,
 *  or the account itself). No row means the server found the account but no login gives it access (probed: a missing account answers
 *  15404, NOT_FOUND), so `access` is false and the type unknown. */
export interface WindowsPrincipal {
  readonly accountName: string
  readonly access: boolean
  readonly type?: 'user' | 'group'
  readonly via?: string
}
/** Check Names' words, in Varia's: SSMS's Object Picker is Windows' own and has none of these. */
export const checkNamesText = {
  title: 'Select User or Group',
  nameLabel: 'Enter the object name',
  check: 'Check Names',
  checking: 'Checking…',
  hint: 'Varia asks the server (xp_logininfo), which resolves the name as CREATE LOGIN … FROM WINDOWS will. Type DOMAIN\\name.',
  user: 'Windows user',
  group: 'Windows group',
  found: 'The server found this account.',
  noAccess: 'The server found this account; no login gives it access yet.',
  via: (path: string) => `It has access through ${path}.`,
  /** xp_logininfo needs sysadmin, or EXECUTE granted on it in master (Learn); the server answers 229 otherwise. */
  permission: 'Check Names needs permission to run xp_logininfo. Type the name as DOMAIN\\name; the server checks it when you press OK.',
  notFound: 'The server could not find this Windows account. Check the name, typed as DOMAIN\\name.',
  changed: 'The name changed since it was checked. Check Names again.'
} as const
/** The Script Action header for a script with a password placeholder (D2 §5.6, A14): run unedited, the batch fails to parse. */
export const passwordScriptHeader = '/* Varia leaves passwords out of scripts. Replace <password> with the login\'s password, as an N\'…\' literal, before you run this script. */'

/** Why a New Login request cannot be sent, or undefined: the problems the page shows before anything is sent. `password` is
 *  only its length and whether it equals the confirmation, so no value leaves the secret slot. */
export function newLoginProblem(login: NewLoginGeneral, password: { readonly empty: boolean; readonly matches: boolean; readonly wellFormed?: boolean; readonly tooLong?: boolean } | undefined,
  model?: Pick<NewLoginModel, 'databases' | 'languages'> & Partial<Pick<NewLoginModel, 'server' | 'certificates' | 'asymmetricKeys' | 'credentials'>>): string | undefined {
  if (!login.name) return newLoginMessages.nameRequired
  if (model?.server && !newLoginAuthOffered(model.server, login.auth)) return newLoginMessages.authNotOffered
  if (login.auth === 'sql' && login.name.includes('\\')) return newLoginMessages.sqlBackslash
  if (login.auth === 'windows' && !windowsLoginName.test(login.name)) return newLoginMessages.windowsName
  if (login.auth === 'certificate' && (!login.certificate || (model?.certificates && !model.certificates.includes(login.certificate)))) return newLoginMessages.certificate
  if (login.auth === 'asymmetricKey' && (!login.asymmetricKey || (model?.asymmetricKeys && !model.asymmetricKeys.includes(login.asymmetricKey)))) return newLoginMessages.asymmetricKey
  if (defaultsAuths.includes(login.auth) && (login.defaultDatabase === undefined || (model && !model.databases.some(database => database.name === login.defaultDatabase)))) return newLoginMessages.defaultDatabase
  if (model && login.defaultLanguage !== undefined && !model.languages.some(language => language.name === login.defaultLanguage)) return newLoginMessages.defaultLanguage
  const credentials = login.credentials ?? []
  if (credentials.length > 0 && !credentialAuths.includes(login.auth)) return newLoginMessages.credentialsEntra
  if (credentials.length > loginLimits.credentials) return newLoginMessages.credentialsLimit
  if (new Set(credentials).size !== credentials.length) return newLoginMessages.credentialTwice
  if (model?.credentials && credentials.some(name => !model.credentials!.some(credential => credential.name === name))) return newLoginMessages.credential
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
  /** Login Properties (D2c), whose read names its login: the user mapped to it there (absent when none) and that user's roles. */
  readonly user?: LoginDatabaseUser
  readonly memberOf?: readonly string[]
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
/** The most statements New Login plans: CREATE LOGIN, Deny, Disable, each credential (D2e), each server role, and each mapping's.
 *  Bounded by actionLimits.statements (src/shared/actions/catalog.ts), which the request schema, the page and C# all check. */
export function newLoginStatements(request: { readonly login?: Pick<NewLoginGeneral, 'credentials'>; readonly serverRoles: readonly string[]; readonly status: LoginStatusChoice; readonly mappings: readonly Pick<UserMappingChoice, 'defaultSchema' | 'rolesAdd'>[] }): number {
  return 1 + (request.status.connect === 'deny' ? 1 : 0) + (request.status.enabled ? 0 : 1) + (request.login?.credentials?.length ?? 0) + request.serverRoles.length
    + request.mappings.reduce((sum, mapping) => sum + mappingStatements(mapping), 0)
}
/** Why a plan is too long (the limit is actionLimits.statements; catalog.ts imports this file, so the number is passed in). */
export const tooManyStatementsMessage = (limit: number) => `This login would need more than ${limit.toLocaleString('en-US')} statements. Map fewer databases, or apply the rest afterwards.`

// --- Login Properties (D2c) ---------------------------------------------------------------------------------------------

/** A new password (the value travels in LoginSecrets): with the old one (`oldPassword`; then neither UNLOCK nor MUST_CHANGE, as
 *  T-SQL's grammar takes one or the others), or with UNLOCK to clear a lock-out and MUST_CHANGE to require a change at the next sign-in. */
export interface LoginPasswordChange { readonly oldPassword: boolean; readonly unlock: boolean; readonly mustChange: boolean }
export const loginMappingChanges = ['map', 'unmap', 'update'] as const
export type LoginMappingChangeKind = typeof loginMappingChanges[number]
/**
 * One database whose User Mapping changed: `map` (CREATE USER `user` FOR LOGIN), `unmap` (DROP USER `user`, the user the describe
 * read, and nothing else) or `update` (`user` the user the describe read, `newName` to rename it); a default schema and roles to
 * add or drop for map and update (drop for update only).
 */
export interface LoginMappingChange {
  readonly database: string
  readonly change: LoginMappingChangeKind
  readonly user: string
  readonly newName?: string
  readonly defaultSchema?: string
  readonly rolesAdd?: readonly string[]
  readonly rolesDrop?: readonly string[]
}
/** Login Properties' changes: only what differs from its describe, so an unchanged dialog sends nothing. C#: LoginChangesDto. */
export interface LoginChanges {
  readonly defaultDatabase?: string
  readonly defaultLanguage?: string
  readonly checkPolicy?: boolean
  readonly checkExpiration?: boolean
  readonly password?: LoginPasswordChange
  readonly rolesAdd?: readonly string[]
  readonly rolesDrop?: readonly string[]
  readonly mappings?: readonly LoginMappingChange[]
  readonly connect?: 'grant' | 'deny'
  readonly enabled?: boolean
  /** Mapped Credentials' rows added and removed (D2e): ALTER LOGIN … ADD CREDENTIAL and DROP CREDENTIAL, at most loginLimits.credentials each. */
  readonly credentialsAdd?: readonly string[]
  readonly credentialsDrop?: readonly string[]
}
/** A user mapped to the login in one database, as the describe's scan read it: `owner` when it is dbo (the login owns the database). */
export interface LoginMappedUser { readonly database: string; readonly user: string; readonly defaultSchema?: string; readonly owner: boolean }
/** The user mapped to a login in one database, as User Mapping's read with a login finds it. */
export interface LoginDatabaseUser { readonly name: string; readonly defaultSchema?: string; readonly owner: boolean }
/** What Login Properties reads of the login besides its facts, lock-out state and New Login's lists. `read`: the databases whose users
 *  the scan read (by name); a database it did not read shows "Not read" until its row is selected. C#: LoginPropertiesDto. */
export interface LoginPropertiesFacts {
  readonly defaultDatabase: string
  readonly defaultLanguage?: string
  readonly serverRoles: readonly string[]
  readonly serverRolesTruncated: boolean
  readonly users: readonly LoginMappedUser[]
  readonly read: readonly string[]
  /** D2e: the credentials mapped to the login (sys.server_principal_credentials), at most loginLimits.listedCredentials by name, and
   *  the certificate or asymmetric key a C or K login is mapped to (by its SID). */
  readonly credentials: readonly string[]
  readonly credentialsTruncated: boolean
  readonly certificate?: string
  readonly asymmetricKey?: string
}
/** The most statements Login Properties plans: the options, the password, Connect, Enabled, each credential removed and added (D2e),
 *  each server role, and per database its DROP USER, or its CREATE USER or rename, the default schema's two and one per role. C#:
 *  LoginSql.PropertiesStatements. */
export function loginPropertiesStatements(changes: LoginChanges): number {
  const options = changes.defaultDatabase !== undefined || changes.defaultLanguage !== undefined || changes.checkPolicy !== undefined || changes.checkExpiration !== undefined
  return (options ? 1 : 0) + (changes.password ? 1 : 0) + (changes.connect ? 1 : 0) + (changes.enabled === undefined ? 0 : 1) + (changes.rolesAdd?.length ?? 0) + (changes.rolesDrop?.length ?? 0)
    + (changes.credentialsAdd?.length ?? 0) + (changes.credentialsDrop?.length ?? 0)
    + (changes.mappings ?? []).reduce((sum, mapping) => sum + (mapping.change === 'unmap' ? 1
      : (mapping.change === 'map' || mapping.newName !== undefined ? 1 : 0) + (mapping.defaultSchema === undefined ? 0 : 2) + (mapping.rolesAdd?.length ?? 0) + (mapping.rolesDrop?.length ?? 0)), 0)
}
/** Why Login Properties cannot apply these changes to the login its describe read, or undefined: SQL Server's own logins, Deny,
 *  Disable or MUST_CHANGE of the login this connection uses, Disable of a Windows group, and a password or policy for a login that is
 *  not a SQL Server login. Permissions are the server's to answer: a login may change its own password (with the old one) and defaults. C#:
 *  LoginRules.PropertiesRefusal. */
export function loginPropertiesRefusal(facts: Pick<LoginFacts, 'subtype' | 'own' | 'type'>, changes: LoginChanges): LoginMessageId | undefined {
  if (facts.subtype === 'system') return 'system'
  if (facts.own && (changes.enabled === false || changes.connect === 'deny')) return 'ownStatus'
  if (facts.own && changes.password?.mustChange) return 'ownMustChange'
  if (facts.subtype === 'windowsGroup' && changes.enabled === false) return 'windowsGroupDisable'
  if (facts.type !== 'S' && (changes.password || changes.checkPolicy !== undefined || changes.checkExpiration !== undefined)) return 'propertiesNotSql'
  if ((facts.type === 'E' || facts.type === 'X') && (changes.credentialsAdd?.length || changes.credentialsDrop?.length)) return 'externalCredentials'
  if ((facts.type === 'C' || facts.type === 'K') && changes.mappings?.some(mapping => mapping.defaultSchema !== undefined)) return 'signingSchema'
  return undefined
}
/** Login Properties' own words, in Varia's where SSMS's are unverified. They name fields, never values. */
export const loginPropertiesMessages = {
  /** SSMS fills the password fields with a fake value; Varia leaves them blank (D2 §4). */
  keepPassword: 'Leave blank to keep the current password.',
  /** SSMS's ResetPasswordWhileUnlocking: only a new password unlocks a login here. */
  unlockNeedsPassword: 'Type a new password to unlock the login.',
  mustChangeHint: 'Type a new password to require a change at next login.',
  /** Set when the connection's own login lacks ALTER ANY LOGIN: SQL Server then asks for the old password. */
  ownPassword: 'You are changing the password of the login this connection uses: SQL Server asks for the old password unless you can alter any login.',
  /** SQL Server answers a wrong old password with 15151; ActionService.LoginOldPasswordAdvice. */
  oldPasswordAdvice: 'Check the old password.',
  notRead: 'Not read',
  /** A database whose users the describe did not read in its budget: they are read when its row is selected. */
  notReadHint: 'This database was not read yet. Select it to read its user and roles.',
  owner: 'The login owns this database, so its user is dbo, which cannot be unmapped or renamed here.',
  /** The steps preview's and Script's warning per unmapped database (ActionService.LoginPropertiesWarnings). */
  dropsUser: (user: string, database: string) => `Drops the user [${user.replaceAll(']', ']]')}] in [${database.replaceAll(']', ']]')}].`,
  locked: 'Login is locked out',
  /** SQL Server refuses OLD_PASSWORD on a locked-out login (15113); only a new password with UNLOCK clears the lock-out. */
  lockedOldPassword: 'The login is locked out, and SQL Server refuses its old password then. Clear Specify old password: a new password unlocks it.',
  /** After a partial run reloaded the login, until the dialog has read the database again (`shown` as the page shows names). */
  readAgain: (shown: string) => `User Mapping has not read ${shown} again since the last run. Select it on User Mapping (Retry if its read failed), then press OK.`,
  /** A partial run that completed the password step: the fields are cleared, so a retry does not send it again. */
  passwordApplied: 'The new password was set before the failure, so the password fields were cleared.',
  /** After a password change for a login Varia's connections sign in as: the backend gives them the new password; main's remembered one is stale. */
  connectionsPassword: (label: string) => `Changed the password of ${label}. Varia's connections that sign in as this login use the new password from now on; if Varia remembers the old one, type the new one the next time you connect.`
} as const
/** Unlock…'s choices (D4 §5.5, owner decision 9): a new password, SSMS's way, which hands over to Login Properties with "Login is locked
 *  out" cleared and sends nothing itself (the default); or keeping the current one (the `unlock` action's keepPassword mode). */
export const unlockChoices = ['setPassword', 'keepPassword'] as const
export type UnlockChoice = typeof unlockChoices[number]
export const unlockChoiceText: { readonly [C in UnlockChoice]: string } = { setPassword: 'Set a new password…', keepPassword: 'Keep the current password' }
/** Unlock…'s OK while "Set a new password…" is chosen. */
export const unlockHandOffLabel = 'Continue in Login Properties…'

/** User Mapping's own notes, in Varia's words. They name databases only as the page shows them. */
export const userMappingMessages = {
  rolesLoading: 'Reading the database roles…',
  notMapped: 'Check Map to choose roles for this database.',
  unavailable: 'This database is not online, not accessible to you, or read-only, so it cannot be mapped.',
  mappingsLimit: `At most ${loginLimits.mappings} databases can be mapped at once.`,
  noSchemas: 'This database lists no schemas.'
} as const
