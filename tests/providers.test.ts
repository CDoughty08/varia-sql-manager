import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bigQueryConnectionOptionsSchema, bigQueryLimits, connectionKey, connectionOptionsSchema, connectionPrincipalSchema, credentialBinding, providerConnectionOptionsSchema } from '../src/shared/connections'
import { bigQueryTargetOptions, connectionTargetOptionsSchema, persistedConnectionTargetSchema, principalFits, queryConnectionAssociationSchema, samePrincipal, targetServerName, targetUsesPassword } from '../src/shared/connection-targets'
import { normalizedProvider, providerAllows, providerOf, providersOf } from '../src/shared/providers'
import { storedSessionSchema } from '../src/main/session-store'
import { settingDef } from '../src/shared/settings/catalog'
import { recoveryRecordSchema } from '../src/main/recovery-store'

const sqlServer = { server: 'sql-prod-01', database: 'Sales', authentication: 'windows' as const, trustServerCertificate: false }
const bigQuery = { provider: 'bigquery' as const, project: 'acme-analytics-01', authentication: 'gcloud' as const }

describe('provider ids', () => {
  it('reads 0.9.0 spelling and missing providers as SQL Server, and lets an empty context hide nothing', () => {
    expect(normalizedProvider('sqlServer')).toBe('sqlserver')
    expect(normalizedProvider('bigquery')).toBe('bigquery')
    expect(providerOf(undefined)).toBe('sqlserver')
    expect(providerOf({ provider: 'bigquery' })).toBe('bigquery')
    expect(providersOf({})).toEqual(['sqlserver'])
    expect(providerAllows(['sqlserver'], '')).toBe(true)
    expect(providerAllows(['sqlserver'], 'bigquery')).toBe(false)
  })
})

describe('the connection principal union', () => {
  it("reads 0.9.0's sqlServer spelling as sqlserver, and writes it so", () => {
    expect(connectionPrincipalSchema.parse({ provider: 'sqlServer', authentication: 'windows', id: 'sid:0105' })).toEqual({ provider: 'sqlserver', authentication: 'windows', id: 'sid:0105' })
    expect(connectionPrincipalSchema.parse({ provider: 'sqlserver', authentication: 'sql', id: 'sid:01' }).provider).toBe('sqlserver')
  })
  it("takes BigQuery's project and principal, and refuses another provider, a mixed shape or an unprintable id", () => {
    expect(connectionPrincipalSchema.parse({ provider: 'bigquery', project: 'acme-analytics-01', principal: 'reader@acme-analytics-01.iam.gserviceaccount.com' }).provider).toBe('bigquery')
    for (const value of [
      { provider: 'postgresql', authentication: 'windows', id: 'x' }, { provider: 'bigquery', authentication: 'windows', id: 'x' },
      { provider: 'sqlserver', project: 'acme-analytics-01', principal: 'x' }, { provider: 'bigquery', project: 'Bad_Project', principal: 'x' },
      { provider: 'sqlserver', authentication: 'windows', id: 'a\nb' }, { provider: 'sqlserver', authentication: 'windows', id: 'x'.repeat(257) }
    ]) expect(connectionPrincipalSchema.safeParse(value).success, JSON.stringify(value).slice(0, 80)).toBe(false)
  })
  it('a principal fits only its own provider\'s target, and two principals match only within a provider', () => {
    const sqlPrincipal = { provider: 'sqlserver' as const, authentication: 'windows' as const, id: 'sid:0105' }
    const bqPrincipal = { provider: 'bigquery' as const, project: 'acme-analytics-01', principal: 'me@example.com' }
    expect(principalFits(sqlPrincipal, sqlServer)).toBe(true)
    expect(principalFits(sqlPrincipal, bigQuery)).toBe(false)
    expect(principalFits(bqPrincipal, bigQuery)).toBe(true)
    expect(principalFits(bqPrincipal, { ...bigQuery, project: 'acme-other-02' })).toBe(false)
    expect(principalFits(bqPrincipal, sqlServer)).toBe(false)
    expect(samePrincipal(sqlPrincipal, { ...sqlPrincipal })).toBe(true)
    expect(samePrincipal(sqlPrincipal, bqPrincipal)).toBe(false)
    expect(samePrincipal(bqPrincipal, { ...bqPrincipal, principal: 'other@example.com' })).toBe(false)
  })
})

describe('BigQuery connection options', () => {
  it('validates project ids, datasets, locations and colours as Google Cloud spells them', () => {
    for (const project of ['acme-analytics-01', 'example.com:acme-data', 'abcdef']) expect(bigQueryConnectionOptionsSchema.safeParse({ ...bigQuery, project }).success, project).toBe(true)
    for (const project of ['Acme', 'ab', '1acme-analytics', 'acme_analytics', 'acme-analytics-', 'a'.repeat(31)]) expect(bigQueryConnectionOptionsSchema.safeParse({ ...bigQuery, project }).success, project).toBe(false)
    expect(bigQueryConnectionOptionsSchema.safeParse({ ...bigQuery, dataset: 'sales_2026', location: 'europe-west2', color: '#1a2B3c' }).success).toBe(true)
    for (const extra of [{ dataset: 'sales-2026' }, { dataset: 'x'.repeat(1025) }, { location: 'eu west' }, { color: '#12345g' }]) expect(bigQueryConnectionOptionsSchema.safeParse({ ...bigQuery, ...extra }).success, JSON.stringify(extra)).toBe(false)
  })
  it("bounds the connection's own cost threshold as Options' threshold, outside its identity and target", () => {
    for (const costThreshold of [0, 1, 50, bigQueryLimits.costThresholdGiB]) expect(bigQueryConnectionOptionsSchema.safeParse({ ...bigQuery, costThreshold }).success, String(costThreshold)).toBe(true)
    for (const costThreshold of [-1, 1.5, bigQueryLimits.costThresholdGiB + 1, '10']) expect(bigQueryConnectionOptionsSchema.safeParse({ ...bigQuery, costThreshold }).success, String(costThreshold)).toBe(false)
    const setting = settingDef('queryExecution.bigQuery.costThreshold')
    expect(setting.type === 'integer' && setting.max).toBe(bigQueryLimits.costThresholdGiB)
    // C# bounds it the same (BigQueryLimits.Check).
    const csharp = readFileSync('backend/Varia.Backend/BigQuery/BigQueryContracts.cs', 'utf8').match(/const int CostThresholdGiB = ([\d_]+);/)?.[1]
    expect(Number(csharp?.replaceAll('_', ''))).toBe(bigQueryLimits.costThresholdGiB)
    // A preference, like the cost-prompt choice: the same entry, and the same target (so it never opens a second connection).
    expect(connectionKey({ ...bigQuery, costThreshold: 50 })).toBe(connectionKey(bigQuery))
    expect(bigQueryTargetOptions({ ...bigQuery, costThreshold: 50, costPrompt: false })).toEqual(bigQueryTargetOptions(bigQuery))
  })
  it('requires a key file reference exactly for key file authentication, and never a path', () => {
    const keyFile = randomUUID()
    expect(bigQueryConnectionOptionsSchema.safeParse({ ...bigQuery, authentication: 'serviceAccountKey', keyFile }).success).toBe(true)
    expect(bigQueryConnectionOptionsSchema.safeParse({ ...bigQuery, authentication: 'externalAccount', keyFile }).success).toBe(true)
    expect(bigQueryConnectionOptionsSchema.safeParse({ ...bigQuery, authentication: 'serviceAccountKey' }).success).toBe(false)
    expect(bigQueryConnectionOptionsSchema.safeParse({ ...bigQuery, keyFile }).success).toBe(false)
    expect(bigQueryConnectionOptionsSchema.safeParse({ ...bigQuery, authentication: 'serviceAccountKey', keyFile: 'C:\\keys\\sa.json' }).success).toBe(false)
    expect(bigQueryConnectionOptionsSchema.safeParse({ ...bigQuery, password: 'x' }).success).toBe(false)
  })
  it('the options union keeps SQL Server\'s options as they were, with or without provider', () => {
    expect(providerConnectionOptionsSchema.parse(sqlServer)).toEqual(sqlServer)
    expect(connectionOptionsSchema.parse({ ...sqlServer, provider: 'sqlserver' })).toEqual({ ...sqlServer, provider: 'sqlserver' })
    expect(providerConnectionOptionsSchema.parse(bigQuery)).toEqual(bigQuery)
    expect(connectionOptionsSchema.safeParse({ ...sqlServer, provider: 'bigquery' }).success).toBe(false)
  })
  it('keys and bindings name the provider, so a BigQuery entry never matches a SQL Server one, and SQL Server\'s are unchanged', () => {
    expect(JSON.parse(connectionKey(sqlServer)).slice(0, 7)).toEqual(['sql-prod-01', 'Sales', 'windows', '', 'mandatory', false, ''])
    expect(connectionKey({ ...sqlServer, provider: 'sqlserver' })).toBe(connectionKey(sqlServer))
    expect(JSON.parse(connectionKey(bigQuery))[0]).toBe('bigquery')
    expect(connectionKey({ ...bigQuery, dataset: 'sales' })).not.toBe(connectionKey(bigQuery))
    expect(credentialBinding(sqlServer)).toBe(JSON.stringify(['sql-prod-01', 'windows', '', 'mandatory', false, '', '', '', 'default']))
    expect(credentialBinding({ ...sqlServer, provider: 'sqlserver' })).toBe(credentialBinding(sqlServer))
    const binding = credentialBinding(bigQuery, { principal: 'me@example.com' })
    expect(JSON.parse(binding)[0]).toBe('bigquery')
    expect(binding).not.toBe(credentialBinding(bigQuery, { principal: 'other@example.com' }))
    expect(credentialBinding({ ...bigQuery, authentication: 'serviceAccountKey' }, { keyPath: '/a.json' })).not.toBe(credentialBinding({ ...bigQuery, authentication: 'serviceAccountKey' }, { keyPath: '/b.json' }))
  })
})

describe('targets and tab records', () => {
  it('a target is either provider\'s, and only SQL Server password targets keep a credential', () => {
    expect(connectionTargetOptionsSchema.parse(bigQuery)).toEqual(bigQuery)
    expect(targetServerName(bigQuery)).toBe('acme-analytics-01')
    expect(targetServerName(sqlServer)).toBe('sql-prod-01')
    expect(targetUsesPassword(bigQuery)).toBe(false)
    const target = { id: randomUUID(), options: bigQuery, details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: false }
    expect(persistedConnectionTargetSchema.safeParse({ ...target, expectedPrincipal: { provider: 'bigquery', project: 'acme-analytics-01', principal: 'me@example.com' } }).success).toBe(true)
    expect(persistedConnectionTargetSchema.safeParse({ ...target, expectedPrincipal: { provider: 'sqlserver', authentication: 'windows', id: 'sid:01' } }).success).toBe(false)
    expect(persistedConnectionTargetSchema.safeParse({ ...target, credential: { profileId: randomUUID(), revision: randomUUID() } }).success).toBe(false)
    // 0.9.0's target, spelled sqlServer, reads as SQL Server's.
    const old = persistedConnectionTargetSchema.parse({ ...target, options: sqlServer, expectedPrincipal: { provider: 'sqlServer', authentication: 'windows', id: 'sid:01' } })
    expect(old.expectedPrincipal).toEqual({ provider: 'sqlserver', authentication: 'windows', id: 'sid:01' })
  })
  it('an association keeps 128-character databases for SQL Server and 1,024-character datasets for BigQuery', () => {
    const association = { targetId: randomUUID(), attachWanted: true }
    expect(queryConnectionAssociationSchema.safeParse({ ...association, database: 'd'.repeat(128) }).success).toBe(true)
    expect(queryConnectionAssociationSchema.safeParse({ ...association, database: 'd'.repeat(129) }).success).toBe(false)
    expect(queryConnectionAssociationSchema.safeParse({ ...association, provider: 'sqlserver', database: 'd'.repeat(129) }).success).toBe(false)
    expect(queryConnectionAssociationSchema.safeParse({ ...association, provider: 'bigquery', database: 'd'.repeat(1024) }).success).toBe(true)
    expect(queryConnectionAssociationSchema.safeParse({ ...association, provider: 'bigquery', database: 'd'.repeat(1025) }).success).toBe(false)
  })
  it('session files are version 4 with multi-server targets; version 2 and version 3 read forward to version 4', () => {
    const document = { name: 'Orders.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'select 1' }
    const session = { version: 4, savedAt: '2026-11-01T10:00:00.000Z', activeIndex: 0, documents: [{ ...document, provider: 'bigquery', database: 'd'.repeat(1024) }] }
    expect(storedSessionSchema.safeParse(session).success).toBe(true)
    expect(storedSessionSchema.safeParse({ ...session, documents: [{ ...document, provider: 'bigquery', database: 'd'.repeat(1025) }] }).success).toBe(false)
    expect(storedSessionSchema.safeParse({ ...session, documents: [{ ...document, database: 'd'.repeat(129) }] }).success).toBe(false)
    expect(storedSessionSchema.safeParse({ ...session, documents: [{ ...document, provider: 'postgresql' }] }).success).toBe(false)
    // A BigQuery tab's job key (docs/bigquery.md, Re-attaching to jobs) is a uuid, in version 3+.
    expect(storedSessionSchema.safeParse({ ...session, documents: [{ ...document, provider: 'bigquery', jobKey: randomUUID() }] }).success).toBe(true)
    expect(storedSessionSchema.safeParse({ ...session, documents: [{ ...document, provider: 'bigquery', jobKey: 'not-a-key' }] }).success).toBe(false)
    expect(storedSessionSchema.safeParse({ version: 2, savedAt: '2026-11-01T10:00:00.000Z', activeIndex: 0, documents: [{ ...document, jobKey: randomUUID() }] }).success).toBe(false)
    const v2 = storedSessionSchema.parse({ version: 2, savedAt: '2026-11-01T10:00:00.000Z', activeIndex: 0, documents: [document] })
    expect(v2.version).toBe(4)
    expect(providerOf(v2.documents[0] as { provider?: 'sqlserver' })).toBe('sqlserver')
    const v3 = storedSessionSchema.parse({ version: 3, savedAt: '2026-11-01T10:00:00.000Z', activeIndex: 0, documents: [{ ...document, provider: 'bigquery' }] })
    expect(v3.version).toBe(4)
    expect((v3.documents[0] as { provider?: string }).provider).toBe('bigquery')
    // A version 2 file cannot carry a provider: 0.9.0 never wrote one.
    expect(storedSessionSchema.safeParse({ version: 2, savedAt: '2026-11-01T10:00:00.000Z', activeIndex: 0, documents: [{ ...document, provider: 'sqlserver' }] }).success).toBe(false)
    // Version 4 multiTargets bounds (1..32, per-provider database limit).
    const multiTargets = Array.from({ length: 32 }, (_, i) => ({ provider: 'sqlserver' as const, database: `db${i}`, enabled: true }))
    expect(storedSessionSchema.safeParse({ ...session, documents: [{ ...document, multiMode: 'same', multiTargets }] }).success).toBe(true)
    expect(storedSessionSchema.safeParse({ ...session, documents: [{ ...document, multiMode: 'same', multiTargets: [...multiTargets, { provider: 'sqlserver', database: 'db32', enabled: true }] }] }).success).toBe(false)
  })
  it('AutoRecover records are version 3 with multi-server hints; version 1 and version 2 read forward to version 3', () => {
    const record = { id: randomUUID(), owner: { instance: randomUUID(), generation: 1 }, name: 'Query 1', kind: 'sql', eol: 'lf', server: 'acme-analytics-01', savedAt: '2026-11-01T10:00:00.000Z', text: 'select 2' }
    expect(recoveryRecordSchema.safeParse({ ...record, version: 3, provider: 'bigquery', database: 'd'.repeat(1024) }).success).toBe(true)
    expect(recoveryRecordSchema.safeParse({ ...record, version: 3, database: 'd'.repeat(129) }).success).toBe(false)
    expect(recoveryRecordSchema.safeParse({ ...record, version: 1, provider: 'sqlserver' }).success).toBe(false)
    const old = recoveryRecordSchema.parse({ ...record, version: 1, database: 'Sales' })
    expect(old.version).toBe(3)
    expect('provider' in old).toBe(false)
    const v2 = recoveryRecordSchema.parse({ ...record, version: 2, provider: 'bigquery', database: 'sales' })
    expect(v2.version).toBe(3)
    expect((v2 as { provider?: string }).provider).toBe('bigquery')
    expect(recoveryRecordSchema.safeParse({ ...record, version: 3, multiMode: 'cross', crossView: 'split', multiTargets: [{ provider: 'sqlserver', database: 'Sales', enabled: true }, { provider: 'bigquery', database: 'analytics', enabled: true }] }).success).toBe(true)
    expect(recoveryRecordSchema.safeParse({ ...record, version: 3, multiMode: 'same', multiTargets: [{ provider: 'sqlserver', database: 'Sales', enabled: true, targetId: randomUUID() }] }).success).toBe(false)
  })
})
