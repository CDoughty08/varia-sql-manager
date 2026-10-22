// The Connect dialog's authentication types: the one place the TypeScript side lists them. The backend mirrors the ids
// and the rules in backend/Varia.Backend/Entra/EntraModes.cs (tests/auth-modes.test.ts compares the two). Erasable
// TypeScript, like ipc/methods.ts.

/** SSMS 22's Authentication list, in its order (Learn: Connect to Server, Login page). */
export const authenticationModes = ['windows', 'sql', 'entraMfa', 'entraPassword', 'entraIntegrated', 'entraServicePrincipal', 'entraManagedIdentity', 'entraDefault'] as const
export type AuthenticationMode = typeof authenticationModes[number]

/**
 * How each type fills the dialog. `user`: `identity` shows, greyed, who integrated authentication signs in as;
 * `required` and `optional` are typed; `userLabel` is the field's label. `password`: Password (and Remember password)
 * are editable. `interactive`: connecting signs in through the web browser. `windowsOnly`: SqlClient supports it only on
 * Windows.
 */
export interface AuthenticationInfo {
  readonly label: string
  readonly user: 'identity' | 'required' | 'optional'
  readonly userLabel: 'Login' | 'User name' | 'User assigned identity'
  readonly password: boolean
  readonly entra: boolean
  readonly interactive: boolean
  readonly windowsOnly: boolean
}
const entra = { entra: true, interactive: false, windowsOnly: false } as const
export const authenticationCatalog: { readonly [M in AuthenticationMode]: AuthenticationInfo } = {
  windows: { label: 'Windows Authentication', user: 'identity', userLabel: 'User name', password: false, entra: false, interactive: false, windowsOnly: false },
  // Learn calls SQL Server Authentication's field Login.
  sql: { label: 'SQL Server Authentication', user: 'required', userLabel: 'Login', password: true, entra: false, interactive: false, windowsOnly: false },
  // SqlClient lets MFA and Default go without a user name (the browser's account picker, the credential chain's first
  // identity); Learn asks for one, so the dialog shows it as optional.
  entraMfa: { ...entra, label: 'Microsoft Entra MFA', user: 'optional', userLabel: 'User name', password: false, interactive: true },
  entraPassword: { ...entra, label: 'Microsoft Entra Password', user: 'required', userLabel: 'User name', password: true },
  entraIntegrated: { ...entra, label: 'Microsoft Entra Integrated', user: 'identity', userLabel: 'User name', password: false, windowsOnly: true },
  entraServicePrincipal: { ...entra, label: 'Microsoft Entra Service Principal', user: 'required', userLabel: 'User name', password: true },
  entraManagedIdentity: { ...entra, label: 'Microsoft Entra Managed Identity', user: 'optional', userLabel: 'User assigned identity', password: false },
  entraDefault: { ...entra, label: 'Microsoft Entra Default', user: 'optional', userLabel: 'User name', password: false }
}

/** Password is editable, so it can be remembered (SQL Server Authentication, Entra Password and Service Principal). */
export function usesPassword(mode: AuthenticationMode): boolean { return authenticationCatalog[mode].password }
/** Connect needs a user name (for Service Principal, the application's client ID). */
export function requiresUser(mode: AuthenticationMode): boolean { return authenticationCatalog[mode].user === 'required' }
/** User name shows the signed-in Windows identity and is not stored (Windows Authentication, Entra Integrated). */
export function showsIdentity(mode: AuthenticationMode): boolean { return authenticationCatalog[mode].user === 'identity' }
export function isEntra(mode: AuthenticationMode): boolean { return authenticationCatalog[mode].entra }
