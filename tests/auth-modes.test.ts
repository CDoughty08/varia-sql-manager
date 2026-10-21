import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { authenticationCatalog, authenticationModes, isEntra, requiresUser, showsIdentity, usesPassword } from '../src/shared/auth'

/** A `string[]` array of EntraModes.cs, by its name. */
function backendList(source: string, name: string): string[] {
  const match = new RegExp(`internal static readonly string\\[\\] ${name} = \\[([^\\]]*)\\];`).exec(source)
  if (!match) throw new Error(`EntraModes.${name} not found`)
  return [...match[1].matchAll(/"([^"]+)"/g)].map(item => item[1])
}

describe('authentication types', () => {
  it('lists SSMS 22\'s eight types, in its order and with its labels', () => {
    expect(authenticationModes.map(mode => authenticationCatalog[mode].label)).toEqual([
      'Windows Authentication', 'SQL Server Authentication', 'Microsoft Entra MFA', 'Microsoft Entra Password', 'Microsoft Entra Integrated',
      'Microsoft Entra Service Principal', 'Microsoft Entra Managed Identity', 'Microsoft Entra Default'
    ])
  })
  it('fills the dialog per type: who signs in, what the field is called, and whether Password is editable', () => {
    expect(Object.fromEntries(authenticationModes.map(mode => { const { user, userLabel, password, interactive, windowsOnly } = authenticationCatalog[mode]; return [mode, [user, userLabel, password, interactive, windowsOnly].join(' | ')] }))).toMatchInlineSnapshot(`
      {
        "entraDefault": "optional | User name | false | false | false",
        "entraIntegrated": "identity | User name | false | false | true",
        "entraManagedIdentity": "optional | User assigned identity | false | false | false",
        "entraMfa": "optional | User name | false | true | false",
        "entraPassword": "required | User name | true | false | false",
        "entraServicePrincipal": "required | User name | true | false | false",
        "sql": "required | Login | true | false | false",
        "windows": "identity | User name | false | false | false",
      }
    `)
    expect(authenticationModes.filter(usesPassword)).toEqual(['sql', 'entraPassword', 'entraServicePrincipal'])
    expect(authenticationModes.filter(requiresUser)).toEqual(['sql', 'entraPassword', 'entraServicePrincipal'])
    expect(authenticationModes.filter(showsIdentity)).toEqual(['windows', 'entraIntegrated'])
    expect(authenticationModes.filter(isEntra)).toEqual(authenticationModes.filter(mode => mode.startsWith('entra')))
  })
  it('matches the backend\'s list and rules (EntraModes.cs), so neither side accepts a type the other does not', () => {
    const source = readFileSync('backend/Varia.Backend/Entra/EntraModes.cs', 'utf8')
    expect(backendList(source, 'Known')).toEqual([...authenticationModes])
    expect(backendList(source, 'Password')).toEqual(authenticationModes.filter(usesPassword))
    expect(backendList(source, 'RequiredUser')).toEqual(authenticationModes.filter(requiresUser))
  })
})
