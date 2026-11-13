import { describe, expect, it } from 'vitest'
import { ConnectionIdentityRegistry, type ConnectionPrincipalEvidence } from '../src/main/connection-identity'
import { advancedDefaults } from '../src/shared/connections'
import type { AdvancedConnectionOptions, ConnectionOptions } from '../src/shared/contracts'

const options: ConnectionOptions = { server: 'sql-prod-01', database: 'Sales', authentication: 'sql', username: 'alex', password: 'typed-secret', encrypt: 'mandatory', trustServerCertificate: false }
const principal = (authentication: ConnectionOptions['authentication'], id = 'tenant/account') => ({ authentication, id }) satisfies ConnectionPrincipalEvidence

describe('live connection identity', () => {
  it('reuses complete equality regardless of object property order or presentation', () => {
    const registry = new ConnectionIdentityRegistry()
    const reordered = { password: options.password, username: options.username, database: options.database, server: `  ${options.server}  `, authentication: options.authentication, trustServerCertificate: false }
    expect(registry.key(reordered)).toBe(registry.key(options))
    expect(registry.key({ ...options, displayName: 'Reporting', color: '#33ccdd', environment: 'Production' })).toBe(registry.key(options))
    expect(registry.key({ ...options, advanced: { applicationName: advancedDefaults.applicationName, packetSize: advancedDefaults.packetSize } })).toBe(registry.key(options))
    expect(registry.key({ ...options, advanced: { packetSize: advancedDefaults.packetSize, applicationName: advancedDefaults.applicationName } })).toBe(registry.key(options))
  })

  it('keeps changed passwords, case-sensitive identities, database, routing and TLS separate', () => {
    const registry = new ConnectionIdentityRegistry()
    const initial = registry.key(options)
    expect(initial).toMatch(/^[a-f0-9]{64}$/)
    const variants: ConnectionOptions[] = [
      { ...options, password: 'other-secret' }, { ...options, password: 'Typed-secret' },
      { ...options, username: 'Alex' }, { ...options, database: 'sales' }, { ...options, database: '' },
      { ...options, server: 'other-alias' }, { ...options, server: 'SQL-PROD-01' }, { ...options, server: 'tcp:sql-prod-01' }, { ...options, server: 'sql-prod-01,1433' },
      { ...options, encrypt: 'optional' }, { ...options, encrypt: 'strict' }, { ...options, trustServerCertificate: true },
      { ...options, hostNameInCertificate: 'db.example.test' }
    ]
    for (const variant of variants) expect(registry.key(variant)).not.toBe(initial)
    expect(registry.key({ ...options, encrypt: 'strict', trustServerCertificate: true })).not.toBe(registry.key({ ...options, encrypt: 'strict' }))
  })

  it('keeps every advanced option in equality and distinguishes inherited execution timeout', () => {
    const registry = new ConnectionIdentityRegistry()
    const changed: AdvancedConnectionOptions = {
      commandTimeout: 30, connectTimeout: 20, columnEncryption: true, secureEnclaves: true,
      attestationProtocol: 'HGS', enclaveAttestationUrl: 'https://attestation.example.test', multipleActiveResultSets: true,
      networkProtocol: 'tcp', packetSize: 4096, transactionBinding: 'Explicit Unbind', typeSystemVersion: 'SQL Server 2008',
      connectRetryCount: 2, connectRetryInterval: 5, applicationName: 'Other app', workstationId: 'other-host',
      applicationIntent: 'ReadOnly', currentLanguage: 'French', replication: true, ipAddressPreference: 'IPv6First',
      serverCertificate: '/cert/server.cer', attachDbFilename: '/db/attached.mdf', failoverPartner: 'other-server',
      failoverPartnerSpn: 'MSSQLSvc/other-server', multiSubnetFailover: true, serverSpn: 'MSSQLSvc/sql-prod-01', userInstance: true
    }
    expect(Object.keys(changed).sort()).toEqual(Object.keys(advancedDefaults).sort())
    const initial = registry.key(options)
    for (const key of Object.keys(changed) as (keyof AdvancedConnectionOptions)[]) {
      const value = { ...options, advanced: { [key]: changed[key] } }
      expect(registry.key(value), key).not.toBe(initial)
      expect(registry.key(value), key).toBeDefined()
    }
    expect(registry.key({ ...options, advanced: { commandTimeout: 0 } })).not.toBe(initial)
    expect(registry.key({ ...options, advanced: { commandTimeout: undefined } })).toBe(initial)
  })

  it('requires an actual secret for credential modes and rejects unvalidated options', () => {
    const registry = new ConnectionIdentityRegistry()
    for (const authentication of ['sql', 'entraPassword', 'entraServicePrincipal'] as const) {
      for (const password of [undefined, '']) expect(registry.key({ ...options, authentication, password }, principal(authentication))).toBeUndefined()
      expect(registry.key({ ...options, authentication }, principal(authentication))).toBeDefined()
    }
    expect(registry.key({ ...options, server: '' })).toBeUndefined()
    expect(registry.key({ ...options, advanced: { packetSize: -1 } })).toBeUndefined()
    expect(registry.key({ ...options, connectionString: 'Password=never-retained' } as ConnectionOptions)).toBeUndefined()
  })

  it('keys an authenticated blank SQL password only with stable account evidence', () => {
    const registry = new ConnectionIdentityRegistry(), account = principal('sql', 'sid:01020304')
    const blank = { ...options, password: '' }, absent = { ...options, password: undefined }
    expect(registry.key(blank, account)).toBeUndefined()
    expect(registry.key(absent, account)).toBeUndefined()
    expect(registry.authenticatedKey(blank, account)).toBeDefined()
    expect(registry.authenticatedKey(blank, account)).toBe(registry.authenticatedKey(absent, account))
    expect(registry.authenticatedKey(blank, account)).not.toBe(registry.authenticatedKey(blank, principal('sql', 'sid:05060708')))
    expect(registry.authenticatedKey(blank, account)).not.toBe(registry.authenticatedKey(options, account))
    expect(registry.authenticatedKey(options, account)).toBe(registry.key(options))
    expect(registry.authenticatedKey(blank, principal('windows'))).toBeUndefined()
    for (const authentication of ['entraPassword', 'entraServicePrincipal'] as const)
      expect(registry.authenticatedKey({ ...blank, authentication }, principal(authentication))).toBeUndefined()
  })

  it('rekeys nonsecret database settings using only an ephemeral credential component', () => {
    const registry = new ConnectionIdentityRegistry(), material = registry.authenticatedMaterial(options, principal('sql', 'sid:01020304'))!
    const { password: _password, ...withoutPassword } = options
    const renamed = { ...withoutPassword, database: 'RenamedSales' }
    expect(registry.rekey(renamed, material.credential)).toBe(registry.key({ ...options, database: renamed.database }))
    expect(registry.rekey(renamed, material.credential)).not.toBe(material.key)
    expect(JSON.stringify(material)).not.toContain(options.password)
    expect(material.credential).toMatch(/^[a-f0-9]{64}$/)
    registry.dispose()
    expect(registry.rekey(renamed, material.credential)).toBeUndefined()
  })

  it('requires authoritative principal evidence for OS and every Entra authentication mode', () => {
    const registry = new ConnectionIdentityRegistry()
    for (const authentication of ['windows', 'entraMfa', 'entraPassword', 'entraIntegrated', 'entraServicePrincipal', 'entraManagedIdentity', 'entraDefault'] as const) {
      const value = { ...options, authentication }
      expect(registry.key(value), authentication).toBeUndefined()
      expect(registry.key(value, principal(authentication)), authentication).toBeDefined()
      expect(registry.key(value, principal(authentication, 'other/account')), authentication).not.toBe(registry.key(value, principal(authentication)))
      expect(registry.key(value, principal('sql')), authentication).toBeUndefined()
    }
    expect(registry.key({ ...options, authentication: 'entraMfa', username: undefined }, principal('entraMfa'))).toBeDefined()
    for (const authentication of ['windows', 'entraIntegrated'] as const) {
      const identity = principal(authentication)
      expect(registry.key({ ...options, authentication, username: 'Displayed identity' }, identity)).toBe(registry.key({ ...options, authentication, username: undefined }, identity))
    }
    for (const id of ['', ' ', 'x'.repeat(1025)]) expect(registry.key(options, principal('sql', id))).toBeUndefined()
  })

  it('uses stable accounts instead of token material and does not consume irrelevant passwords', () => {
    const registry = new ConnectionIdentityRegistry()
    const value: ConnectionOptions = { ...options, authentication: 'entraMfa', password: undefined }
    const identity = principal('entraMfa')
    expect(registry.key(value, identity)).toBe(registry.key({ ...value, password: 'irrelevant' }, identity))
    expect(registry.key(value, identity)).toBe(registry.key(value, { ...identity }))
    expect(registry.key(value, identity)).not.toBe(registry.key({ ...value, authentication: 'entraDefault' }, principal('entraDefault')))
  })

  it('scopes opaque comparison keys to a disposable registry without serializing private material', () => {
    const registry = new ConnectionIdentityRegistry(), other = new ConnectionIdentityRegistry()
    expect(registry.key(options)).not.toBe(other.key(options))
    expect(JSON.stringify(registry)).toBe('{}')
    const key = registry.key(options)!
    expect(key).not.toContain(options.password)
    expect(key).not.toContain(options.server)
    registry.dispose()
    registry.dispose()
    expect(registry.key(options)).toBeUndefined()
    expect(other.key(options)).toBeDefined()
  })
})
