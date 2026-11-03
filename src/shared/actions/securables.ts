// The Securables page of New Login and Login Properties (D2d): the server-level securables a login can be given permissions on, the
// permissions each class takes, how a checkbox change becomes GRANT, DENY or REVOKE, and the page's words. The one place they live:
// the page, zod and C# (through actions-catalog.json) read them here, so a permission keyword reaches SQL only from this catalogue.
// Erasable TypeScript (no enums), so Node's type stripping can load it too.

/** The securables a login's Securables page lists: SQL Server's server-level classes (sys.server_permissions' class 100, 105, 101 and
 *  108). One entry per line, so later classes append cleanly. */
export const securableTypes = [
  'server',
  'endpoint',
  'login',
  'serverRole',
  'availabilityGroup'
] as const
export type SecurableType = typeof securableTypes[number]
/** The securable types that name an object (the server is the only one that does not). */
export type NamedSecurableType = Exclude<SecurableType, 'server'>
export const namedSecurableTypes = securableTypes.filter((type): type is NamedSecurableType => type !== 'server')

export interface SecurableSpec {
  /** The Type column's word (SSMS's, recalled). */
  readonly label: string
  /** Select Object Types' word for the type (Learn lists Endpoints, Logins, Servers, Availability Groups and Server roles). */
  readonly plural: string
  /** The class sys.fn_builtin_permissions and sys.fn_my_permissions take. */
  readonly sqlClass: string
  /** sys.server_permissions.class. A login and a server role share 101 (a server principal), told apart by its type. */
  readonly classId: number
  /** The statement's ON clause before the quoted name; the server has none. */
  readonly on?: string
  /**
   * The permissions the class takes, alphabetical, as sys.fn_builtin_permissions(class) lists them on SQL Server 2025 (probed for
   * D2d). The page offers those the server's own list names too (the describe reads it), so an older server never sees a newer
   * permission; a keyword reaches SQL only from this list.
   */
  readonly permissions: readonly string[]
}
export const securableSpecs: { readonly [T in SecurableType]: SecurableSpec } = {
  server: {
    label: 'Server', plural: 'Servers', sqlClass: 'SERVER', classId: 100,
    permissions: [
      'ADMINISTER BULK OPERATIONS', 'ALTER ANY AVAILABILITY GROUP', 'ALTER ANY CONNECTION', 'ALTER ANY CREDENTIAL', 'ALTER ANY DATABASE', 'ALTER ANY ENDPOINT',
      'ALTER ANY EVENT NOTIFICATION', 'ALTER ANY EVENT SESSION', 'ALTER ANY EVENT SESSION ADD EVENT', 'ALTER ANY EVENT SESSION ADD TARGET', 'ALTER ANY EVENT SESSION DISABLE',
      'ALTER ANY EVENT SESSION DROP EVENT', 'ALTER ANY EVENT SESSION DROP TARGET', 'ALTER ANY EVENT SESSION ENABLE', 'ALTER ANY EVENT SESSION OPTION', 'ALTER ANY LINKED SERVER',
      'ALTER ANY LOGIN', 'ALTER ANY SERVER AUDIT', 'ALTER ANY SERVER ROLE', 'ALTER RESOURCES', 'ALTER SERVER STATE', 'ALTER SETTINGS', 'ALTER TRACE', 'AUTHENTICATE SERVER',
      'CONNECT ANY DATABASE', 'CONNECT SQL', 'CONTROL SERVER', 'CREATE ANY DATABASE', 'CREATE ANY EVENT SESSION', 'CREATE AVAILABILITY GROUP', 'CREATE DDL EVENT NOTIFICATION',
      'CREATE ENDPOINT', 'CREATE LOGIN', 'CREATE SERVER ROLE', 'CREATE TRACE EVENT NOTIFICATION', 'DROP ANY EVENT SESSION', 'EXTERNAL ACCESS ASSEMBLY', 'IMPERSONATE ANY LOGIN',
      'SELECT ALL USER SECURABLES', 'SHUTDOWN', 'UNSAFE ASSEMBLY', 'VIEW ANY CRYPTOGRAPHICALLY SECURED DEFINITION', 'VIEW ANY DATABASE', 'VIEW ANY DEFINITION', 'VIEW ANY ERROR LOG',
      'VIEW ANY PERFORMANCE DEFINITION', 'VIEW ANY SECURITY DEFINITION', 'VIEW SERVER PERFORMANCE STATE', 'VIEW SERVER SECURITY AUDIT', 'VIEW SERVER SECURITY STATE', 'VIEW SERVER STATE'
    ]
  },
  endpoint: { label: 'Endpoint', plural: 'Endpoints', sqlClass: 'ENDPOINT', classId: 105, on: ' ON ENDPOINT::', permissions: ['ALTER', 'CONNECT', 'CONTROL', 'TAKE OWNERSHIP', 'VIEW DEFINITION'] },
  login: { label: 'Login', plural: 'Logins', sqlClass: 'LOGIN', classId: 101, on: ' ON LOGIN::', permissions: ['ALTER', 'CONTROL', 'IMPERSONATE', 'VIEW DEFINITION'] },
  serverRole: { label: 'Server Role', plural: 'Server roles', sqlClass: 'SERVER ROLE', classId: 101, on: ' ON SERVER ROLE::', permissions: ['ALTER', 'CONTROL', 'TAKE OWNERSHIP', 'VIEW DEFINITION'] },
  availabilityGroup: {
    label: 'Availability Group', plural: 'Availability Groups', sqlClass: 'AVAILABILITY GROUP', classId: 108, on: ' ON AVAILABILITY GROUP::', permissions: ['ALTER', 'CONTROL', 'TAKE OWNERSHIP', 'VIEW DEFINITION']
  }
}
/** Select Object Types' order, Learn's (Endpoints, Logins, Servers, Availability Groups, Server roles). */
export const objectTypeOrder: readonly SecurableType[] = ['endpoint', 'login', 'server', 'availabilityGroup', 'serverRole']
/** Permissions another page owns, shown read-only here: the Status page's Permission to connect to database engine (CONNECT SQL),
 *  which the Securables page never sends, so one change cannot be asked for twice. */
export const reservedPermissions: { readonly [T in SecurableType]?: readonly string[] } = { server: ['CONNECT SQL'] }
export const reservedPermission = (type: SecurableType, permission: string) => reservedPermissions[type]?.includes(permission) ?? false

/** A permission's state as sys.server_permissions keeps it (G, W, D), and as the Explicit tab's checkboxes ask for it. No state: none. */
export const permissionStates = ['grant', 'withGrant', 'deny'] as const
export type PermissionState = typeof permissionStates[number]
/** What one permission statement does: GRANT, GRANT … WITH GRANT OPTION, DENY, REVOKE, or REVOKE GRANT OPTION FOR (… CASCADE). */
export const permissionVerbs = ['grant', 'withGrant', 'deny', 'revoke', 'revokeGrantOption'] as const
export type PermissionVerb = typeof permissionVerbs[number]

/** One securable: its type, and its name (none for the server). */
export interface SecurableRef { readonly type: SecurableType; readonly name?: string }
/**
 * One permission statement of a request (C#: PermissionDto): the securable, a permission of its class (never free text), and what to
 * do. `cascade` (DENY and REVOKE only) is set when the permission was granted WITH GRANT OPTION, as SMO does: SQL Server refuses to
 * deny or revoke a grantable permission without it (4611). REVOKE GRANT OPTION FOR always cascades.
 */
export interface PermissionChoice { readonly securable: SecurableRef; readonly permission: string; readonly state: PermissionVerb; readonly cascade?: boolean }
/** One row of the login's explicit permissions (sys.server_permissions, grantee the login), as Login Properties' describe reads it. */
export interface ExplicitPermission { readonly securable: SecurableRef; readonly permission: string; readonly state: PermissionState; readonly grantor: string }
/** What New Login's describe reads for the Securables page, in master: the server's name (The server's row), the permissions each
 *  type takes on this server (the catalogue's that sys.fn_builtin_permissions lists too), and the objects Add Objects lists per type
 *  (at most loginLimits.securableObjects each, by name; a truncation shows). */
export interface SecurablesModel {
  readonly server: string
  readonly permissions: { readonly [T in SecurableType]: readonly string[] }
  readonly objects: { readonly [T in NamedSecurableType]: readonly string[] }
  readonly truncated: boolean
}
/** The describe id of the Effective tab's read (target the login, `securable` the selected one): what the login may do there, from
 *  sys.fn_my_permissions under EXECUTE AS LOGIN on the action's own unpooled read connection, which needs IMPERSONATE. */
export const loginEffectiveDescribe = 'loginEffectivePermissions'
/** What the Effective tab's read answers: the permission names, at most loginLimits.effectivePermissions (one more is read). */
export interface EffectivePermissions { readonly permissions: readonly string[]; readonly truncated: boolean }

/** A securable's identity in the draft and the page: its type, then its name. */
export const securableKey = (ref: SecurableRef) => ref.type + ':' + (ref.name ?? '')
export const sameSecurable = (a: SecurableRef, b: SecurableRef) => a.type === b.type && (a.name ?? '') === (b.name ?? '')

/**
 * The statement that turns `before` (the state the describe read; undefined for none) into `after`, as SMO's
 * SecurableUtils writes it (D2 §3.4): GRANT, GRANT … WITH GRANT OPTION (over a DENY too, which it replaces), DENY, REVOKE, and REVOKE
 * GRANT OPTION FOR when With Grant alone is cleared; DENY and REVOKE of a grantable permission cascade (4611). Undefined: no change.
 */
export function permissionChange(before: PermissionState | undefined, after: PermissionState | undefined): Pick<PermissionChoice, 'state' | 'cascade'> | undefined {
  if (before === after) return undefined
  const cascade = before === 'withGrant' ? { cascade: true } : {}
  if (after === 'grant') return before === 'withGrant' ? { state: 'revokeGrantOption' } : { state: 'grant' }
  if (after === 'withGrant') return { state: 'withGrant' }
  if (after === 'deny') return { state: 'deny', ...cascade }
  return { state: 'revoke', ...cascade }
}
/** The Explicit tab's columns: Grant, With Grant and Deny. */
export const permissionColumns = ['grant', 'withGrant', 'deny'] as const
export type PermissionColumn = typeof permissionColumns[number]
/** A checkbox of the Explicit tab changed, as SSMS's grid does it: Grant and Deny exclude each other, With Grant implies Grant, and
 *  clearing Grant clears With Grant. */
export function toggledPermission(current: PermissionState | undefined, column: PermissionColumn, checked: boolean): PermissionState | undefined {
  if (column === 'deny') return checked ? 'deny' : current === 'deny' ? undefined : current
  if (column === 'withGrant') return checked ? 'withGrant' : current === 'withGrant' ? 'grant' : current
  return checked ? (current === 'withGrant' ? 'withGrant' : 'grant') : current === 'grant' || current === 'withGrant' ? undefined : current
}
/** Whether a column's box is checked for a state. */
export const permissionChecked = (state: PermissionState | undefined, column: PermissionColumn) =>
  column === 'grant' ? state === 'grant' || state === 'withGrant' : state === column

/** The login's explicit permissions by securable and permission, as the Explicit tab shows them: a deny over any grant, a grant with
 *  grant option over a plain one (sys.server_permissions keeps a row per grantor), with the first such row's grantor. */
export function explicitStates(rows: readonly ExplicitPermission[]): ReadonlyMap<string, ReadonlyMap<string, { readonly state: PermissionState; readonly grantor: string }>> {
  const rank = { grant: 0, withGrant: 1, deny: 2 } as const
  const states = new Map<string, Map<string, { state: PermissionState; grantor: string }>>()
  for (const row of rows) {
    const key = securableKey(row.securable), of = states.get(key) ?? new Map<string, { state: PermissionState; grantor: string }>()
    const current = of.get(row.permission)
    if (!current || rank[row.state] > rank[current.state]) of.set(row.permission, { state: row.state, grantor: row.grantor })
    states.set(key, of)
  }
  return states
}

/** The Securables page's words, Varia's where SSMS's are unverified. They name securables only as the page shows them. */
export const securablesMessages = {
  /** The Status page owns CONNECT SQL. */
  reserved: 'Set on the Status page (Permission to connect to database engine).',
  noSecurable: 'Select a securable above to see its permissions, or add one with Search….',
  noPermissions: 'This server lists no permissions of this type that Varia can set.',
  effectiveLoading: 'Reading the effective permissions…',
  /** SQL Server answers EXECUTE AS LOGIN without IMPERSONATE with 15406 or 15517. */
  effectiveDenied: 'You don\'t have permission to view effective permissions.',
  effectiveNewLogin: 'Effective permissions show once the login exists.',
  effectiveNone: 'The login has no permissions on this securable.',
  addNone: 'Choose at least one object type.',
  noObjects: 'This server has no objects of these types that this login can see.',
  objectsTruncated: (count: number) => `Only the first ${count.toLocaleString('en-US')} objects of each type are listed.`,
  explicitTruncated: (count: number) => `Only the first ${count.toLocaleString('en-US')} explicit permissions are listed; OK changes only those shown.`,
  effectiveTruncated: (count: number) => `Only the first ${count.toLocaleString('en-US')} effective permissions are listed.`,
  securablesLimit: (count: number) => `At most ${count.toLocaleString('en-US')} securables can be listed at once.`,
  permissionsLimit: (count: number) => `At most ${count.toLocaleString('en-US')} permissions can change at once. Apply some, then the rest.`
} as const
/** Add Objects' three choices (SSMS's, recalled) and the dialogs they open. */
export const addObjectsChoices = ['specific', 'all', 'server'] as const
export type AddObjectsChoice = typeof addObjectsChoices[number]
export const addObjectsText = {
  title: 'Add Objects',
  prompt: 'What objects do you want to add?',
  specific: 'Specific objects…',
  all: 'All objects of the types…',
  server: (server: string) => `The server '${server}'`,
  selectObjects: 'Select Objects',
  selectTypes: 'Select Object Types',
  typesPrompt: 'Select the types of objects:',
  objectsPrompt: 'Matching objects:'
} as const

/** The Securables block of actions-catalog.json: what C# builds statements and reads from, so it holds no permission keyword of its own. */
export function securablesCatalog() {
  return {
    effectiveDescribe: loginEffectiveDescribe,
    effectiveDenied: securablesMessages.effectiveDenied,
    reserved: securableTypes.flatMap(type => (reservedPermissions[type] ?? []).map(permission => ({ type, permission }))),
    types: securableTypes.map(type => ({ type, ...securableSpecs[type] }))
  }
}
