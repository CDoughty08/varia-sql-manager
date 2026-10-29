import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { kindScope } from '../src/shared/explorer/refs'
import { nodeKinds } from '../src/shared/explorer/catalog'
import {
  catalogDatabase, catalogProbeRetryMs, describeTargets, describeViews, executableResults, finalStatuses, loggingLevels, messageSourceTypes, messageTypes, openStatuses, operationStatuses, operationTypes,
  parameterObjectTypes, permissionTypes, securableTypes, ssisActions, ssisActionVerbs, ssisCatalogJson, ssisErrorCodes, ssisErrorRetryable, ssisFeatures, ssisFeatureSources, ssisLimits,
  stoppableOperationTypes, systemParameters, createCatalog, catalogBackupFile,
  isSsisDocumentKind, ssisCommandEntries, ssisDocumentKinds, ssisDocumentName, ssisDocumentSpecs, ssisVerbContextKey, ssisVerbContextValues, ssisVerbMenuState, ssisVerbs, ssisVerbSpecs, validationStatuses
} from '../src/shared/ssis/catalog'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { generatedMarker, renderSsisDocs } from '../src/shared/ssis/docs'
import { ssisRequestLimits } from '../src/main/backend/ssis-requests'
import { createCatalogDrainMs, methodPolicies } from '../src/shared/ipc/methods'

const unique = (values: readonly unknown[]) => new Set(values).size === values.length
const docsPath = join('docs', 'integration-services.md')

describe('SSIS catalogue', () => {
  it('has unique codes in every code table, as Learn documents them', () => {
    for (const [name, rows] of Object.entries({ operationTypes, operationStatuses, messageTypes, messageSourceTypes, executableResults, loggingLevels, parameterObjectTypes, securableTypes, permissionTypes })) {
      expect(unique(rows.map(row => row.code)), name).toBe(true)
      for (const row of rows) expect(row.label, name).toMatch(/^\S(.*\S)?$/)
    }
    expect(operationTypes.map(row => row.code)).toEqual([1, 2, 3, 101, 102, 106, 200, 202, 300, 301, 1000])
    expect(operationStatuses.map(row => row.code)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect([...openStatuses, ...finalStatuses].sort((a, b) => a - b)).toEqual(operationStatuses.map(row => row.code))
    expect(messageTypes.map(row => row.code)).toEqual([-1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 200, 400])
    expect(messageTypes.filter(row => row.tone === 'error').map(row => row.code)).toEqual([120, 130])
    expect(messageTypes.filter(row => row.tone === 'warning').map(row => row.code)).toEqual([110])
    expect(messageTypes.filter(row => row.tone === 'muted').map(row => row.code)).toEqual([60, 90])
    expect(loggingLevels.map(row => row.code)).toEqual([0, 1, 2, 3, 4, 100])
    for (const row of permissionTypes) for (const on of row.on) expect(securableTypes.map(type => type.code), row.label).toContain(on)
    expect(permissionTypes.filter(row => row.code >= 100).every(row => row.on.length === 1 && row.on[0] === 1)).toBe(true)
  })
  it('leaves SYNCHRONIZED and any 32-bit runtime out, so no request can carry either', () => {
    expect(systemParameters).toEqual(['LOGGING_LEVEL', 'CUSTOMIZED_LOGGING_LEVEL', 'DUMP_ON_ERROR', 'DUMP_ON_EVENT', 'DUMP_EVENT_CODE'])
    const json = ssisCatalogJson()
    expect(json).not.toMatch(/SYNCHRONIZED/i)
    // Owner decision 11: no 32-bit support on any version.
    expect(json).not.toMatch(/32bit|32-bit/i)
  })
  it('describes each view\'s own SSIS kind, and probes each feature through a catalog object', () => {
    expect(describeViews).toEqual(['catalog', 'folder', 'project', 'package', 'environment'])
    for (const view of describeViews) {
      expect(nodeKinds, view).toContain(describeTargets[view])
      expect(kindScope(describeTargets[view]).startsWith('ssis'), view).toBe(true)
    }
    expect(unique(Object.values(describeTargets))).toBe(true)
    expect(Object.keys(ssisFeatureSources)).toEqual([...ssisFeatures])
    for (const source of Object.values(ssisFeatureSources)) expect(source).toMatch(/^catalog\.[a-z_]+(\.[a-z_]+)?$/)
    expect(catalogDatabase).toBe('SSISDB')
  })
  it('gives each verb one command, on Object Explorer\'s menu for its own kind only, and each document its own view', () => {
    expect(ssisVerbs).toEqual(['folderProperties', 'projectProperties', 'packageProperties', 'environmentProperties'])
    const entries = ssisCommandEntries()
    expect(Object.keys(entries)).toEqual([...ssisVerbs.map(verb => ssisVerbSpecs[verb].command), 'ssis.refreshProperties'])
    for (const verb of ssisVerbs) {
      const spec = ssisVerbSpecs[verb], key = ssisVerbContextKey(verb), kind = spec.kinds[0]
      expect(spec, verb).toMatchObject({ class: 'document', writes: false, document: kind, menuTitle: 'Properties', group: '9_properties', mnemonic: 'p' })
      expect(commandDescriptor(spec.command), verb).toEqual(entries[spec.command])
      expect(entries[spec.command]).toMatchObject({ category: 'Integration Services', precondition: `backendReady && ${key} == 'enabled'`, menus: [{ menu: 'explorer.context', title: 'Properties', when: `explorerNode == '${kind}' && ${key} != ''` }] })
      expect(key).toBe(`ssisVerb${verb[0].toUpperCase()}${verb.slice(1)}`)
      // Only its own kind offers it.
      for (const other of [...nodeKinds, 'folder' as const]) expect(ssisVerbMenuState(other)[verb], `${verb} on ${other}`).toBe(other === kind ? 'enabled' : '')
    }
    expect(ssisVerbContextValues(ssisVerbMenuState('ssisProject'))).toEqual({ ssisVerbFolderProperties: '', ssisVerbProjectProperties: 'enabled', ssisVerbPackageProperties: '', ssisVerbEnvironmentProperties: '' })
    for (const kind of ssisDocumentKinds) {
      expect(describeTargets[ssisDocumentSpecs[kind].view], kind).toBe(kind)
      expect(ssisDocumentSpecs[kind].sections[0], kind).toEqual({ id: 'general', title: 'General' })
      expect(unique(ssisDocumentSpecs[kind].sections.map(section => section.id)), kind).toBe(true)
      expect(isSsisDocumentKind(kind)).toBe(true)
    }
    expect([isSsisDocumentKind('ssisCatalog'), isSsisDocumentKind('tableDesigner'), isSsisDocumentKind(undefined)]).toEqual([false, false, false])
    expect(ssisDocumentName('ssisPackage', 'Daily.dtsx')).toBe('Package Properties - Daily.dtsx')
    expect(validationStatuses).toEqual([{ code: 'N', label: 'Not validated' }])
  })
  it('keeps error codes retryable only where a retry can help', () => {
    expect(ssisErrorCodes.filter(code => ssisErrorRetryable[code])).toEqual(['DATABASE_UNAVAILABLE', 'BLOCKED', 'TIMEOUT', 'CONNECTION_LOST', 'AUTH_KERBEROS', 'NOT_RUNNING', 'CANCELLED', 'SQL_ERROR'])
    expect(ssisErrorCodes).toContain('CATALOG_MISSING')
    // Stop Operation on an ended operation, or on a created one nobody started (it never runs), is information, and a SQL Server
    // login cannot fix itself by retrying.
    expect(ssisErrorRetryable).toMatchObject({ WINDOWS_AUTH_REQUIRED: false, ALREADY_FINAL: false, NOT_STARTED: false })
    // Create Catalog's refusals need the user to change something first: the existing catalog, or the CLR agreement.
    expect(ssisErrorRetryable).toMatchObject({ CATALOG_EXISTS: false, CLR_REQUIRED: false })
  })
  it('declares each ssis.execute verb with its steps, procedures and gates, Stop Operation first', () => {
    expect(ssisActionVerbs).toEqual(['stopOperation', 'createCatalog'])
    expect(ssisActions.stopOperation).toEqual({ title: 'Stop Operation', steps: ['Stop the operation'], procedures: ['stop_operation'], revision: false, windowsAuthOnBox: true, scope: 'catalog' })
    // Create Catalog runs in master and calls none of the catalog's procedures (they do not exist yet); a sysadmin SQL Server
    // login may run it, as in SSMS.
    expect(ssisActions.createCatalog).toEqual({
      title: 'Create Catalog', procedures: [], revision: false, windowsAuthOnBox: false, scope: 'server',
      steps: ['Enable CLR integration', 'Restore the catalog database', 'Create the master key', 'Register the Integration Services assembly and startup procedure', 'Create the maintenance job']
    })
    for (const verb of ssisActionVerbs) {
      const spec = ssisActions[verb]
      expect(spec.steps.length, verb).toBeGreaterThan(0)
      for (const name of spec.procedures) expect(name, verb).toMatch(/^[a-z_]+$/)
      if (spec.scope === 'catalog') expect(spec.procedures.length, verb).toBe(spec.steps.length)
    }
    // Executions and validations, by the code table's own types.
    expect([...stoppableOperationTypes]).toEqual([200, 300, 301])
    for (const type of stoppableOperationTypes) expect(operationTypes.map(row => row.code)).toContain(type)
  })
  it('keeps the read path\'s limits, and main uses them for varia:ssis-cancel', () => {
    expect(ssisLimits).toMatchObject({ name: 128, packageName: 260, description: 1024, value: 4000, rows: 2048, describeMs: 40_000, gateWaitMs: 30_000, readPerConnection: 2, readTotal: 4,
      registered: 256, cancelIds: 64, readLockTimeoutMs: 5000, profileLockTimeoutMs: 1000, revision: 64 })
    expect(ssisRequestLimits).toEqual({ tombstones: 64, tombstoneMs: 60_000, running: 256, cancelBatch: 64 })
    // The answer fits main's 16 MiB response limit with room to spare, and the deadline covers the backend's own budget.
    expect(ssisLimits.describeBytes).toBeLessThan(16 * 1024 * 1024 / 2)
    expect(methodPolicies['ssis.describe']).toEqual({ kind: 'unary', lane: 'ssis', deadlineMs: 45_000 })
    expect(methodPolicies['ssis.describe'].deadlineMs as number).toBeGreaterThan(ssisLimits.describeMs)
  })
  it('keeps the write path\'s limits: one write per connection, two in all, no deadline, and a sensitive frame', () => {
    expect(ssisLimits).toMatchObject({ writePerConnection: 1, writeTotal: 2, registeredWrites: 64, preflightLockTimeoutMs: 10_000, preflightMs: 25_000, stopGraceMs: 10_000 })
    // A write waits for locks as SSMS does, so only Stop ends it; later verbs carry sensitive values, so the frame is zeroed once written.
    const { drainMs, ...policy } = methodPolicies['ssis.execute']
    expect(policy).toEqual({ kind: 'unary', lane: 'ssis', deadlineMs: 0, sensitive: true })
    // A closing generation runs on while Create Catalog finishes or undoes itself (createDrainMs in the backend); Stop Operation needs no drain.
    expect(drainMs?.({ connectionId: 'c', requestId: 'r', action: { verb: 'createCatalog', password: 'x', enableClr: true, startupProcedure: false } })).toBe(createCatalogDrainMs)
    expect(drainMs?.({ connectionId: 'c', requestId: 'r', action: { verb: 'stopOperation', operationId: 1 } })).toBe(0)
    expect(createCatalogDrainMs).toBeGreaterThan(ssisLimits.createDrainMs)
    expect(ssisLimits.registeredWrites).toBeLessThanOrEqual(ssisLimits.registered)
  })
  it('finds the catalog backup by version, as Integration Services names it, and bounds Create Catalog inputs', () => {
    // SSMS 22's Catalog.Create names SSISDBBackup.bak for every version (docs/integration-services.md 14.12); SSISDB.bak is no installed file.
    expect([13, 14, 15, 16, 17, 18].map(catalogBackupFile)).toEqual(Array(6).fill('SSISDBBackup.bak'))
    expect(createCatalog.assemblyFile).toBe('Microsoft.SqlServer.IntegrationServices.Server.dll')
    expect(ssisLimits).toMatchObject({ catalogPassword: 128, serverPath: 1024 })
    // The dialog's read is a read: no secret, a describe's deadline.
    expect(methodPolicies['ssis.catalogSetup']).toEqual({ kind: 'unary', lane: 'ssis', deadlineMs: 45_000 })
  })
  it('loads in plain Node 24, as the other catalogues do', () => {
    const files = ['catalog.ts', 'schema.ts', 'docs.ts'].map(name => join('src', 'shared', 'ssis', name))
    for (const file of files) expect(() => stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }), file).not.toThrow()
    const script = files.map(file => `await import(${JSON.stringify(pathToFileURL(file).href)})`).join(';')
    const result = spawnSync(process.execPath, ['--input-type=module', '--disable-warning=ExperimentalWarning', '-e', script], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})

// Regenerate both after changing the catalogue: npx vitest run tests/ssis-catalog.test.ts -u
describe('generated SSIS files', () => {
  it('keeps the backend\'s embedded copy in sync', async () => {
    await expect(ssisCatalogJson()).toMatchFileSnapshot('../backend/Varia.Backend/Ssis/ssis-catalog.json')
  })
  it('exports sorted keys, every view, error and table', () => {
    const json = JSON.parse(ssisCatalogJson()) as { version: number; catalogDatabase: string; views: { view: string; kind: string }[]; errors: { code: string; retryable: boolean }[]; features: string[]; limits: Record<string, number>;
      actions: { verb: string }[]; stoppableOperationTypes: number[]; openStatuses: number[]; finalStatuses: number[] }
    const sorted = (value: unknown, path: string): void => {
      if (Array.isArray(value)) { value.forEach((item, index) => sorted(item, `${path}[${index}]`)); return }
      if (!value || typeof value !== 'object') return
      const keys = Object.keys(value)
      expect(keys, path).toEqual([...keys].sort())
      for (const key of keys) sorted((value as Record<string, unknown>)[key], `${path}.${key}`)
    }
    sorted(json, '$')
    expect(json.version).toBe(1)
    expect(json.views).toEqual(describeViews.map(view => ({ view, kind: describeTargets[view] })))
    expect(json.errors.map(error => error.code)).toEqual(ssisErrorCodes)
    expect(json.features).toEqual([...ssisFeatures])
    expect(json.limits).toEqual(ssisLimits)
    expect(json.actions).toEqual(ssisActionVerbs.map(verb => ({ verb, ...ssisActions[verb] })))
    expect(json).toMatchObject({ stoppableOperationTypes: [200, 300, 301], openStatuses: [...openStatuses], finalStatuses: [...finalStatuses] })
  })
  it('keeps the generated part of docs/integration-services.md in sync, below its hand-written part', async () => {
    const current = readFileSync(docsPath, 'utf8')
    const at = current.indexOf(generatedMarker)
    expect(at, 'the marker line').toBeGreaterThan(0)
    expect(current.indexOf(generatedMarker, at + 1)).toBe(-1)
    await expect(current.slice(0, at) + renderSsisDocs()).toMatchFileSnapshot('../docs/integration-services.md')
  })
  it('documents every view, verb, error, feature and limit', () => {
    const docs = renderSsisDocs()
    for (const verb of ssisActionVerbs) expect(docs, verb).toContain(`| \`${verb}\` | ${ssisActions[verb].title} |`)
    for (const view of describeViews) expect(docs, view).toContain(`| \`${view}\` |`)
    for (const code of ssisErrorCodes) expect(docs, code).toContain(`| \`${code}\` |`)
    for (const feature of ssisFeatures) expect(docs, feature).toContain(`| \`${feature}\` |`)
    for (const key of Object.keys(ssisLimits)) expect(docs, key).toContain(`| \`${key}\` |`)
    expect(docs).toContain('| Packages | `ssisPackages` | Package (`ssisPackages`) | Name |')
    expect(docs).toContain(`opens again after ${catalogProbeRetryMs.first / 1000} s, doubling to ${catalogProbeRetryMs.max / 1000} s`)
  })
  it('takes the live tree\'s interval from the probe\'s catalogue entry, as the settings do', async () => {
    vi.resetModules()
    vi.doMock('../src/shared/live/catalog.ts', async importOriginal => {
      const original = await importOriginal<typeof import('../src/shared/live/catalog.ts')>()
      return { ...original, liveProbes: { ...original.liveProbes, 'ssis.catalogProbe': { ...original.liveProbes['ssis.catalogProbe'], intervalMs: { default: 45_000, min: 15_000, max: 600_000 } } } }
    })
    try {
      const { renderSsisDocs: render } = await import('../src/shared/ssis/docs')
      expect(render()).toContain('every 45 s by default (Tools › Options › SQL Server Integration Services; 15 to 600 s, or off)')
    } finally {
      vi.doUnmock('../src/shared/live/catalog.ts')
      vi.resetModules()
    }
  })
})
