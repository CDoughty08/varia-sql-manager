import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isCommandId } from '../src/shared/commands/catalog'
import { parseWhen } from '../src/shared/commands/when'
import { isIconId } from '../src/shared/icons'
import { childParentKinds, kindSpecs, nodeKinds, type NodeKind, type NodeSubtype, type ParentKind } from '../src/shared/explorer/catalog'
import {
  preflightIds, scriptAsSubmenuId, scriptAsTitleKeys, scriptAsTitles, scriptCommandEntries, scriptCommandId, scriptCommandIds, scriptCommandTitle, scriptContextValues,
  scriptDestinations, scriptDestinationSpecs, scriptErrorCodes, scriptErrorRetryable, scriptingCatalogJson, scriptKindSpecs, scriptLimits, scriptMenuState, scriptObjectTitles,
  scriptRow, scriptSubmenuEntries, scriptSubmenuIds, scriptVerbContextKey, scriptVerbOffered, scriptVerbs, scriptVerbSpecs, scriptVerbSubmenuId, scriptVerbTitle, smoUrnTypes,
  type ScriptKindSpec, type ScriptVerb
} from '../src/shared/scripting/catalog'
import { renderScriptingDocs } from '../src/shared/scripting/docs'
import { defaultScriptingOptions, scriptingOptionDefs } from '../src/shared/scripting/options'
import { scriptCancelSchema, scriptRequestSchema } from '../src/shared/scripting/schema'

const unique = (values: readonly unknown[]) => new Set(values).size === values.length
const pr5 = (kind: NodeKind): ScriptKindSpec => { const spec = scriptKindSpecs[kind]; if (spec?.phase !== 'pr5') throw new Error(`${kind} is not scripted`); return spec }
/** Every node a selection can be: each kind without and with each subtype, below each parent kind a child can have. */
const nodes = nodeKinds.flatMap(kind => [undefined, ...kindSpecs[kind].subtypes ?? []].flatMap(subtype =>
  (childParentKinds(kind).length ? childParentKinds(kind) : [undefined]).map(parentKind => ({ kind, subtype, parentKind }))))
const nodeName = (node: { kind: string; subtype?: string; parentKind?: string }) => [node.kind, node.subtype ?? '-', node.parentKind ?? '-'].join(' ')

// Spec B3, one line per row: C, A, CoA, D, DC, S, I, U, Del, E, Modify. '*' is every subtype and none; '' is no subtype.
const createDrop = '✓––✓✓––––––'
const b3: readonly (readonly [NodeKind, readonly (NodeSubtype | '')[] | '*', readonly ParentKind[] | undefined, string, string])[] = [
  ['table', ['', 'system', 'systemVersioned', 'history', 'updatableLedger', 'appendOnlyLedger', 'graphNode', 'graphEdge', 'fileTable', 'external'], undefined, 'Table', '✓○○✓✓✓✓✓✓○–'],
  ['table', ['ledgerHistory'], undefined, 'Table', '○○○○○✓○○○○–'],
  ['view', ['', 'system'], undefined, 'View', '✓✓✓✓✓✓✓✓✓○–'],
  ['view', ['ledger'], undefined, 'View', '✓○○○○✓○○○○–'],
  ['procedure', ['sql'], undefined, 'Stored Procedure', '✓✓✓✓✓––––✓✓'],
  ['procedure', ['', 'system', 'clr'], undefined, 'Stored Procedure', '✓✓✓✓✓––––✓–'],
  ['function', ['inline', 'tableValued'], undefined, 'Function', '✓✓✓✓✓✓–––○✓'],
  ['function', ['', 'clrTableValued'], undefined, 'Function', '✓✓✓✓✓✓–––○–'],
  ['function', ['scalar'], undefined, 'Function', '✓✓✓✓✓✓–––✓✓'],
  ['function', ['clrScalar'], undefined, 'Function', '✓✓✓✓✓✓–––✓–'],
  ['function', ['aggregate'], undefined, 'Function', '✓○○✓✓○–––○–'],
  ['trigger', '*', ['table', 'view'], 'Trigger', '✓✓✓✓✓–––––✓'],
  ['databaseTrigger', '*', undefined, 'Database Trigger', '✓✓✓✓✓–––––✓'],
  ['serverTrigger', '*', undefined, 'Server Trigger', '✓✓✓✓✓–––––✓'],
  ['database', ['', 'system'], undefined, 'Database', '✓✓–✓✓––––––'],
  ['database', ['snapshot'], undefined, 'Database', '✓○–✓✓––––––'],
  ['index', '*', ['table', 'view'], 'Index', createDrop],
  ['key', '*', ['table'], 'Key', createDrop],
  ['constraint', '*', ['table'], 'Constraint', createDrop],
  ['statistic', '*', ['table', 'view'], 'Statistics', createDrop],
  ['synonym', '*', undefined, 'Synonym', createDrop],
  ['sequence', '*', undefined, 'Sequence', createDrop],
  ['type', ['', 'alias'], undefined, 'User-Defined Data Type', createDrop],
  ['type', ['clr'], undefined, 'User-Defined Type', createDrop],
  ['tableType', '*', undefined, 'User-Defined Table Type', createDrop],
  ...([
    ['xmlSchemaCollection', 'XML Schema Collection'], ['rule', 'Rule'], ['default', 'Default'], ['securityPolicy', 'Security Policy'], ['schema', 'Schema'], ['user', 'User'],
    ['databaseRole', 'Role'], ['applicationRole', 'Application Role'], ['databaseAuditSpecification', 'Database Audit Specification'], ['fullTextCatalog', 'Full-Text Catalog'],
    ['fullTextStoplist', 'Full-Text Stoplist'], ['searchPropertyList', 'Search Property List'], ['partitionScheme', 'Partition Scheme'], ['partitionFunction', 'Partition Function'],
    ['planGuide', 'Plan Guide'], ['login', 'Login'], ['serverRole', 'Server Role'], ['credential', 'Credential'], ['linkedServer', 'Linked Server'], ['backupDevice', 'Backup Device'],
    ['audit', 'Audit'], ['serverAuditSpecification', 'Server Audit Specification']
  ] as const).map(([kind, title]) => [kind, '*', undefined, title, createDrop] as const)
]
const later = ['assembly', 'asymmetricKey', 'certificate', 'symmetricKey', 'columnMasterKey', 'columnEncryptionKey', 'cryptographicProvider', 'externalDataSource', 'externalFileFormat']
const marks = (state: { verbs: Record<ScriptVerb, string>; modifiable: boolean }) =>
  [...scriptVerbs.map(verb => state.verbs[verb] === 'enabled' ? '✓' : state.verbs[verb] === 'disabled' ? '○' : '–'), state.modifiable ? '✓' : '–'].join('')

// Spec B4 and C3.
const urns: Readonly<Record<string, string>> = {
  database: 'Database',
  table: 'Table', view: 'View', procedure: 'StoredProcedure', function: 'UserDefinedFunction', 'function aggregate': 'UserDefinedAggregate', synonym: 'Synonym', sequence: 'Sequence',
  type: 'UserDefinedDataType', 'type alias': 'UserDefinedDataType', 'type clr': 'UserDefinedType', tableType: 'UserDefinedTableType', xmlSchemaCollection: 'XmlSchemaCollection',
  rule: 'Rule', default: 'Default', securityPolicy: 'SecurityPolicy',
  trigger: 'Trigger', index: 'Index', key: 'Index', 'key primary': 'Index', 'key unique': 'Index', 'key foreign': 'ForeignKey',
  constraint: 'Check', 'constraint check': 'Check', 'constraint edge': 'EdgeConstraint', 'constraint default': 'Column/Default', statistic: 'Statistic',
  schema: 'Schema', user: 'User', databaseRole: 'Role', applicationRole: 'ApplicationRole', databaseTrigger: 'DdlTrigger', databaseAuditSpecification: 'DatabaseAuditSpecification',
  fullTextCatalog: 'FullTextCatalog', fullTextStoplist: 'FullTextStopList', searchPropertyList: 'SearchPropertyList', partitionScheme: 'PartitionScheme',
  partitionFunction: 'PartitionFunction', planGuide: 'PlanGuide',
  login: 'Login', serverRole: 'Role', credential: 'Credential', linkedServer: 'LinkedServer', backupDevice: 'BackupDevice', serverTrigger: 'DdlTrigger', audit: 'Audit',
  serverAuditSpecification: 'ServerAuditSpecification'
}
const preflights: Readonly<Record<string, readonly NodeKind[]>> = {
  module: ['view', 'procedure', 'function', 'rule', 'default'], table: ['table'], child: ['key', 'constraint', 'trigger', 'index', 'statistic'], type: ['type', 'tableType'],
  schemaObject: ['synonym', 'sequence', 'xmlSchemaCollection', 'securityPolicy'],
  databaseObject: ['user', 'databaseRole', 'applicationRole', 'schema', 'databaseAuditSpecification', 'databaseTrigger', 'fullTextCatalog', 'fullTextStoplist', 'partitionScheme',
    'partitionFunction', 'searchPropertyList', 'planGuide'],
  database: ['database'], serverObject: ['login', 'serverRole', 'credential', 'audit', 'serverAuditSpecification', 'backupDevice', 'linkedServer', 'serverTrigger']
}

describe('scripting catalogue', () => {
  it('has the spec\'s verbs, destinations and titles', () => {
    expect(scriptVerbs).toEqual(['create', 'alter', 'createOrAlter', 'drop', 'dropAndCreate', 'select', 'insert', 'update', 'delete', 'execute'])
    expect(scriptDestinations).toEqual(['newQuery', 'file', 'clipboard'])
    expect(scriptVerbs.map(scriptVerbTitle)).toEqual(['CREATE To', 'ALTER To', 'CREATE OR ALTER To', 'DROP To', 'DROP And CREATE To', 'SELECT To', 'INSERT To', 'UPDATE To', 'DELETE To', 'EXECUTE To'])
    expect(scriptVerbs.map(verb => `${scriptVerbSpecs[verb].mnemonic} ${scriptVerbSpecs[verb].group}@${scriptVerbSpecs[verb].order} ${scriptVerbSpecs[verb].class} ${scriptVerbSpecs[verb].smoFlag ?? '-'}`)).toEqual([
      'c 1_ddl@1 ddl -', 'a 1_ddl@2 ddl ScriptForAlter', 'r 1_ddl@3 ddl ScriptForCreateOrAlter', 'd 1_ddl@4 ddl ScriptDrops', 'n 1_ddl@5 ddl ScriptForCreateDrop',
      's 2_dml@1 dml -', 'i 2_dml@2 dml -', 'u 2_dml@3 dml -', 'e 2_dml@4 dml -', 'x 3_execute@1 execute -'
    ])
    expect(scriptDestinations.map(destination => Object.values(scriptDestinationSpecs[destination]).join(' '))).toEqual([
      'New Query Editor Window n 1 file-code true Open in Query Window', 'File… f 2 save-as true Save Script As…', 'Clipboard l 3 clippy false Copy'
    ])
    for (const titled of [...scriptVerbs.map(verb => [scriptVerbTitle(verb), scriptVerbSpecs[verb].mnemonic]), ...scriptDestinations.map(destination => [scriptDestinationSpecs[destination].title, scriptDestinationSpecs[destination].mnemonic])]) {
      expect(titled[0].toLowerCase(), titled[0]).toContain(titled[1])
    }
    expect(unique(scriptVerbs.map(verb => scriptVerbSpecs[verb].mnemonic))).toBe(true)
    expect(unique(scriptDestinations.map(destination => scriptDestinationSpecs[destination].mnemonic))).toBe(true)
    expect(scriptAsTitleKeys).toHaveLength(39)
    expect(unique(scriptAsTitleKeys)).toBe(true)
    expect(unique(Object.values(scriptAsTitles))).toBe(true)
    expect(Object.keys(scriptObjectTitles)).toEqual([...scriptAsTitleKeys])
    for (const key of scriptAsTitleKeys) expect(scriptAsTitles[key], key).toMatch(/^Script [A-Z][\w -]*[a-z] as$/)
    expect([scriptAsTitles.table, scriptAsTitles.procedure, scriptAsTitles.databaseRole, scriptAsTitles.statistic, scriptAsTitles.fullTextCatalog]).toEqual([
      'Script Table as', 'Script Stored Procedure as', 'Script Role as', 'Script Statistics as', 'Script Full-Text Catalog as'
    ])
  })
  it('gives exactly the kinds Object Explorer marks scriptable a spec', () => {
    const scriptable = nodeKinds.filter(kind => kindSpecs[kind].scriptable)
    expect(nodeKinds.filter(kind => scriptKindSpecs[kind])).toEqual(scriptable)
    expect(Object.keys(scriptKindSpecs)).toEqual(scriptable)
    expect(scriptable.filter(kind => scriptKindSpecs[kind]?.phase === 'later').sort()).toEqual([...later].sort())
    for (const kind of scriptable) expect(scriptKindSpecs[kind]!.kind, kind).toBe(kind)
  })
  it('keeps each pr5 spec consistent: subtypes of its kind, a URN, a preflight, titles, Modify only with ALTER, parents of children', () => {
    const titles = new Set<string>()
    for (const kind of nodeKinds) {
      const spec = scriptKindSpecs[kind]
      if (spec?.phase !== 'pr5') continue
      const subtypes: readonly string[] = kindSpecs[kind].subtypes ?? []
      for (const map of [spec.subtypeTitles, spec.subtypeUrns, spec.subtypeVerbs]) for (const subtype of Object.keys(map ?? {})) expect(subtypes, kind).toContain(subtype)
      for (const subtype of spec.modifiable === true ? [] : spec.modifiable ?? []) expect(subtypes, kind).toContain(subtype)
      expect(smoUrnTypes, kind).toContain(spec.urn)
      for (const urn of Object.values(spec.subtypeUrns ?? {})) expect(smoUrnTypes, kind).toContain(urn)
      expect(preflightIds, kind).toContain(spec.preflight)
      expect(spec.objectTypes !== undefined, kind).toBe(spec.preflight === 'module')
      for (const title of [spec.title, ...Object.values(spec.subtypeTitles ?? {})]) { expect(scriptAsTitleKeys, kind).toContain(title); titles.add(title) }
      expect(spec.parents !== undefined, kind).toBe(kindSpecs[kind].scope === 'child')
      for (const parent of spec.parents ?? []) expect(childParentKinds(kind), kind).toContain(parent)
      expect(Object.keys(spec.verbs).length, kind).toBeGreaterThan(0)
    }
    expect([...titles].sort()).toEqual([...scriptAsTitleKeys].sort())
    for (const node of nodes) {
      const row = scriptRow(node.kind, node.subtype, node.parentKind)
      if (row?.modifiable) expect(row.verbs.alter, nodeName(node)).toBe('enabled')
      // Every Script submenu has something to run.
      if (row) expect(Object.values(row.verbs), nodeName(node)).toContain('enabled')
    }
  })
  it('offers each kind and subtype the verbs of spec B3', () => {
    const used = new Set<number>()
    for (const node of nodes) {
      const index = b3.findIndex(([kind, subtypes, parents]) => kind === node.kind && (subtypes === '*' || subtypes.includes(node.subtype ?? '')) && (!parents || parents.includes(node.parentKind!)))
      const state = scriptMenuState(node)
      if (index < 0) { expect(state, nodeName(node)).toEqual({ title: '', verbs: Object.fromEntries(scriptVerbs.map(verb => [verb, ''])), modifiable: false }); continue }
      used.add(index)
      const [, , , title, expected] = b3[index]
      expect(state.title && scriptObjectTitles[state.title], nodeName(node)).toBe(title)
      expect(marks(state), nodeName(node)).toBe(expected)
    }
    expect([...used].sort((a, b) => a - b)).toEqual(b3.map((_, index) => index))
    // Deferred kinds and subtypes, table types' children, and what SMO cannot script show no submenu.
    for (const node of [
      { kind: 'table', subtype: 'droppedLedger' }, { kind: 'view', subtype: 'droppedLedger' }, { kind: 'procedure', subtype: 'extended' }, { kind: 'procedure', subtype: 'replicationFilter' },
      { kind: 'certificate' }, { kind: 'assembly' }, { kind: 'index', parentKind: 'tableType' }, { kind: 'key', parentKind: 'tableType' }, { kind: 'index' }, { kind: 'trigger' },
      { kind: 'server' }, { kind: 'column', parentKind: 'table' }, { kind: 'parameter', parentKind: 'procedure' }, { kind: 'returnValue', parentKind: 'function' }, { kind: 'folder' },
      { kind: 'table', subtype: 'scalar' }
    ] as const) expect(scriptMenuState(node).title, JSON.stringify(node)).toBe('')
    expect(scriptMenuState(undefined).title).toBe('')
  })
  it('scripts each kind through the URN type of spec B4 and the preflight of spec C3', () => {
    for (const node of nodes) {
      const row = scriptRow(node.kind, node.subtype, node.parentKind)
      if (!row) continue
      expect(row.urn, nodeName(node)).toBe(urns[`${node.kind} ${node.subtype}`] ?? urns[node.kind])
      expect(preflights[row.preflight], nodeName(node)).toContain(node.kind)
    }
    expect(Object.fromEntries(nodeKinds.flatMap(kind => scriptKindSpecs[kind]?.phase === 'pr5' && pr5(kind).objectTypes ? [[kind, pr5(kind).objectTypes]] : []))).toEqual({
      view: ['V'], procedure: ['P', 'PC', 'X', 'RF'], function: ['FN', 'IF', 'TF', 'FS', 'FT', 'AF'], rule: ['R'], default: ['D']
    })
    expect(new Set(Object.values(urns))).toEqual(new Set(smoUrnTypes))
    expect(Object.keys(preflights).sort()).toEqual([...preflightIds].sort())
  })
  it('tells main which verbs a kind can ever run', () => {
    expect(scriptVerbOffered('table', 'insert')).toBe(true)
    expect(scriptVerbOffered('table', 'alter')).toBe(false)
    expect(scriptVerbOffered('table', 'execute')).toBe(false)
    expect(scriptVerbOffered('function', 'execute')).toBe(true)
    expect(scriptVerbOffered('function', 'insert')).toBe(false)
    expect(scriptVerbOffered('database', 'alter')).toBe(true)
    expect(scriptVerbOffered('database', 'createOrAlter')).toBe(false)
    expect(scriptVerbOffered('index', 'create', 'view')).toBe(true)
    expect(scriptVerbOffered('index', 'create', 'tableType')).toBe(false)
    expect(scriptVerbOffered('certificate', 'create')).toBe(false)
    expect(scriptVerbOffered('column', 'create', 'table')).toBe(false)
  })
  it('publishes context keys for every verb', () => {
    expect(scriptVerbs.map(scriptVerbContextKey)).toEqual([
      'explorerScriptCreate', 'explorerScriptAlter', 'explorerScriptCreateOrAlter', 'explorerScriptDrop', 'explorerScriptDropAndCreate',
      'explorerScriptSelect', 'explorerScriptInsert', 'explorerScriptUpdate', 'explorerScriptDelete', 'explorerScriptExecute'
    ])
    expect(scriptContextValues(scriptMenuState({ kind: 'procedure', subtype: 'sql' }))).toEqual({
      explorerScriptTitle: 'procedure', explorerScriptCreate: 'enabled', explorerScriptAlter: 'enabled', explorerScriptCreateOrAlter: 'enabled', explorerScriptDrop: 'enabled',
      explorerScriptDropAndCreate: 'enabled', explorerScriptSelect: '', explorerScriptInsert: '', explorerScriptUpdate: '', explorerScriptDelete: '', explorerScriptExecute: 'enabled',
      explorerSelectionModifiable: true
    })
    expect(Object.values(scriptContextValues(scriptMenuState({ kind: 'folder' })))).toEqual(['', ...scriptVerbs.map(() => ''), false])
  })
  it('generates the 30 commands, keeping the table menu\'s CREATE ids', () => {
    expect(scriptCommandIds).toHaveLength(30)
    expect(unique(scriptCommandIds)).toBe(true)
    for (const id of scriptCommandIds) expect(id).toMatch(/^explorer\.script(Create|Alter|CreateOrAlter|Drop|DropAndCreate|Select|Insert|Update|Delete|Execute)To(NewQuery|File|Clipboard)$/)
    expect(scriptCommandId('dropAndCreate', 'newQuery')).toBe('explorer.scriptDropAndCreateToNewQuery')
    for (const destination of scriptDestinations) expect(isCommandId(scriptCommandId('create', destination)), destination).toBe(true)
    const entries = scriptCommandEntries()
    expect(Object.keys(entries)).toEqual([...scriptCommandIds])
    expect(entries['explorer.scriptCreateToNewQuery']).toEqual({
      title: 'Script as CREATE to New Query Editor Window', category: 'Object Explorer', icon: 'file-code', keywords: ['script'],
      precondition: "backendReady && explorerScriptCreate == 'enabled' && !documentBusy", unavailableHint: 'Select an object in Object Explorer that can be scripted.', palette: false,
      menus: [{ menu: 'explorer.scriptAs.create', group: '1_destination', order: 1, title: 'New Query Editor Window', mnemonic: 'n' }]
    })
    expect(entries['explorer.scriptCreateOrAlterToClipboard'].precondition).toBe("backendReady && explorerScriptCreateOrAlter == 'enabled'")
    expect(entries['explorer.scriptDeleteToFile'].precondition).toBe("backendReady && explorerScriptDelete == 'enabled' && !documentBusy")
    expect(scriptCommandTitle('dropAndCreate', 'file')).toBe('Script as DROP And CREATE to File…')
    for (const verb of scriptVerbs) for (const destination of scriptDestinations) {
      const entry = entries[scriptCommandId(verb, destination)]
      expect(() => parseWhen(entry.precondition)).not.toThrow()
      expect(entry.menus).toEqual([{ menu: scriptVerbSubmenuId(verb), group: '1_destination', order: scriptDestinationSpecs[destination].order, title: scriptDestinationSpecs[destination].title, mnemonic: scriptDestinationSpecs[destination].mnemonic }])
      expect(entry.title).toBe(`Script as ${scriptVerbSpecs[verb].name} to ${scriptDestinationSpecs[destination].title}`)
    }
  })
  it('nests one submenu per verb in a Script submenu with a dynamic title', () => {
    expect(scriptSubmenuIds).toEqual([scriptAsSubmenuId, ...scriptVerbs.map(verb => `explorer.scriptAs.${verb}`)])
    const entries = scriptSubmenuEntries()
    expect(Object.keys(entries)).toEqual([...scriptSubmenuIds])
    expect(entries['explorer.scriptAs']).toEqual({
      title: 'Script as', nativeId: 'explorer.scriptAs', dynamicTitle: 'scriptAs',
      placements: [{ menu: 'explorer.context', group: '2_script', order: 1, mnemonic: 's', when: "explorerScriptTitle != '' && explorerNode != 'background'" }]
    })
    expect(entries['explorer.scriptAs.createOrAlter']).toEqual({
      title: 'CREATE OR ALTER To', nativeId: 'explorer.scriptAs.createOrAlter', placements: [{ menu: 'explorer.scriptAs', group: '1_ddl', order: 3, mnemonic: 'r', when: "explorerScriptCreateOrAlter != ''" }]
    })
    for (const entry of Object.values(entries)) for (const placement of entry.placements) expect(() => parseWhen(placement.when)).not.toThrow()
  })
  it('uses destination icons of the icon registry', () => {
    for (const destination of scriptDestinations) expect(isIconId(scriptDestinationSpecs[destination].icon), destination).toBe(true)
  })
  it('keeps the spec\'s limits and error codes', () => {
    expect(scriptLimits).toEqual({
      maxScriptChars: 4_000_000, maxDefinitionBytes: 8_000_000, maxColumns: 30_000, maxParameters: 2_100,
      requestMs: 60_000, budgetMs: 55_000, statementTimeoutS: 30, preflightTimeoutS: 30, lockTimeoutMs: 10_000,
      gatePerConnection: 2, gateTotal: 4, registered: 256, tombstones: 256, tombstoneMs: 60_000, cancelIds: 64,
      rendererJobs: 4, statusDelayMs: 300, noticeMs: 4_000, warningNoticeMs: 8_000, warnings: 8, warningChars: 512,
      messageChars: 2_048, prefsBytes: 16_384, fileNameChars: 200
    })
    // The backend's budget ends before main's deadline, and 4,000,000 characters of UTF-8 stay under PR6's 16 MiB body.
    expect(scriptLimits.budgetMs).toBeLessThan(scriptLimits.requestMs)
    expect(scriptLimits.maxScriptChars * 3).toBeLessThan(16 * 1024 * 1024)
    expect(scriptErrorCodes).toEqual(['NOT_FOUND', 'NOT_SUPPORTED', 'ENCRYPTED', 'NO_DEFINITION', 'PERMISSION_DENIED', 'DATABASE_UNAVAILABLE', 'TOO_LARGE', 'EMPTY', 'BLOCKED',
      'TIMEOUT', 'CONNECTION_LOST', 'UNREPRESENTABLE', 'SMO_ERROR', 'SQL_ERROR', 'AUTH_KERBEROS', 'AUTH_UNSUPPORTED', 'AUTH_ENTRA'])
    expect(scriptErrorCodes.filter(code => scriptErrorRetryable[code])).toEqual(['PERMISSION_DENIED', 'DATABASE_UNAVAILABLE', 'BLOCKED', 'TIMEOUT', 'CONNECTION_LOST', 'SMO_ERROR', 'SQL_ERROR', 'AUTH_KERBEROS', 'AUTH_UNSUPPORTED', 'AUTH_ENTRA'])
  })
  it('loads in plain Node 24, so scripts and test fixtures can share it', () => {
    const files = ['catalog.ts', 'options.ts', 'schema.ts', 'docs.ts'].map(name => join('src', 'shared', 'scripting', name))
    for (const file of files) expect(() => stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }), file).not.toThrow()
    const script = files.map(file => `await import(${JSON.stringify(pathToFileURL(file).href)})`).join(';')
    const result = spawnSync(process.execPath, ['--input-type=module', '--disable-warning=ExperimentalWarning', '-e', script], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})

describe('scripting request schemas', () => {
  const table = { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' } as const
  const request = (changes: Record<string, unknown> = {}) => ({ connectionId: randomUUID(), requestId: randomUUID(), targets: [table], verb: 'create', options: defaultScriptingOptions, ...changes })
  const valid = (value: unknown) => scriptRequestSchema.safeParse(value).success
  it('accepts one scriptable target with a verb its kind offers and every option', () => {
    expect(valid(request())).toBe(true)
    expect(valid(request({ verb: 'insert' }))).toBe(true)
    expect(valid(request({ targets: [{ kind: 'procedure', database: 'AppData', schema: 'dbo', name: 'Run' }], verb: 'execute' }))).toBe(true)
    expect(valid(request({ targets: [{ kind: 'login', name: 'sa' }], verb: 'dropAndCreate' }))).toBe(true)
    expect(valid(request({ targets: [{ kind: 'database', name: 'AppData' }], verb: 'alter' }))).toBe(true)
    expect(valid(request({ targets: [{ kind: 'index', database: 'AppData', name: 'IX_Orders', parent: { kind: 'view', schema: 'dbo', name: 'V' } }] }))).toBe(true)
    expect(valid(request({ options: { ...defaultScriptingOptions, scriptUseDatabase: false, targetServerVersion: '130' } }))).toBe(true)
  })
  it('rejects other shapes, unscriptable targets and verbs a kind never offers', () => {
    expect(valid(request({ targets: [] }))).toBe(false)
    expect(valid(request({ targets: [table, table] }))).toBe(false)
    expect(valid(request({ verb: 'modify' }))).toBe(false)
    expect(valid(request({ verb: 'alter' }))).toBe(false)
    expect(valid(request({ verb: 'execute' }))).toBe(false)
    expect(valid(request({ connectionId: 'c1' }))).toBe(false)
    expect(valid(request({ requestId: undefined }))).toBe(false)
    expect(valid({ ...request(), extra: true })).toBe(false)
    expect(valid(request({ targets: [{ ...table, schema: undefined }] }))).toBe(false)
    expect(valid(request({ targets: [{ ...table, name: 'x'.repeat(129) }] }))).toBe(false)
    expect(valid(request({ targets: [{ kind: 'column', database: 'AppData', name: 'Id', parent: { kind: 'table', schema: 'dbo', name: 'Orders' } }] }))).toBe(false)
    expect(valid(request({ targets: [{ kind: 'certificate', database: 'AppData', name: 'C' }] }))).toBe(false)
    expect(valid(request({ targets: [{ kind: 'server' }] }))).toBe(false)
    expect(valid(request({ targets: [{ kind: 'index', database: 'AppData', name: 'PK', parent: { kind: 'tableType', schema: 'dbo', name: 'T' } }] }))).toBe(false)
    const { scriptOwner: _, ...missing } = defaultScriptingOptions
    expect(valid(request({ options: missing }))).toBe(false)
    expect(valid(request({ options: { ...defaultScriptingOptions, scriptData: true } }))).toBe(false)
    expect(valid(request({ options: { ...defaultScriptingOptions, scriptOwner: 'yes' } }))).toBe(false)
    expect(valid(request({ options: { ...defaultScriptingOptions, targetServerVersion: '120' } }))).toBe(false)
    const result = scriptRequestSchema.safeParse(request({ targets: [{ kind: 'certificate', database: 'AppData', name: 'C' }] }))
    expect(result.success ? [] : result.error.issues.map(issue => [issue.path.join('.'), issue.message])).toEqual([['targets.0', 'A certificate cannot be scripted.']])
  })
  it('cancels 1 to 64 distinct request ids', () => {
    const ids = (count: number) => Array.from({ length: count }, () => randomUUID())
    expect(scriptCancelSchema.safeParse({ requestIds: ids(1) }).success).toBe(true)
    expect(scriptCancelSchema.safeParse({ requestIds: ids(64) }).success).toBe(true)
    expect(scriptCancelSchema.safeParse({ requestIds: ids(65) }).success).toBe(false)
    expect(scriptCancelSchema.safeParse({ requestIds: [] }).success).toBe(false)
    const id = randomUUID()
    expect(scriptCancelSchema.safeParse({ requestIds: [id, id] }).success).toBe(false)
    expect(scriptCancelSchema.safeParse({ requestIds: ['nope'] }).success).toBe(false)
    expect(scriptCancelSchema.safeParse({ requestIds: ids(1), all: true }).success).toBe(false)
  })
})

// Regenerate both files after changing the catalogue or options: npx vitest run tests/scripting-catalog.test.ts -u
describe('generated scripting files', () => {
  it('keeps the backend\'s embedded copy in sync', async () => {
    await expect(scriptingCatalogJson()).toMatchFileSnapshot('../backend/Varia.Backend/Scripting/scripting-catalog.json')
  })
  it('exports every scriptable kind and subtype resolved, the options in request order, and the limits', () => {
    type Target = { kind: string; subtype: string; phase: string; title: string; urn: string; preflight: string; objectTypes: string[]; parents: string[]; enabled: string[]; disabled: string[]; modifiable: boolean }
    const catalog = JSON.parse(scriptingCatalogJson()) as {
      version: number; targets: Target[]; options: { key: string; type: string; values: string[]; default: unknown }[]; verbs: { verb: string; name: string; class: string; smoFlag: string }[]
      titles: Record<string, string>; limits: Record<string, number>; errors: { code: string; retryable: boolean }[]
    }
    const sorted = (value: unknown, path: string): void => {
      if (Array.isArray(value)) { value.forEach((item, index) => sorted(item, `${path}[${index}]`)); return }
      if (!value || typeof value !== 'object') return
      const keys = Object.keys(value)
      expect(keys, path).toEqual([...keys].sort())
      for (const key of keys) sorted((value as Record<string, unknown>)[key], `${path}.${key}`)
    }
    sorted(catalog, '$')
    expect(catalog.version).toBe(1)
    expect(catalog.limits).toEqual(scriptLimits)
    expect(catalog.titles).toEqual(scriptObjectTitles)
    expect(catalog.verbs.map(verb => verb.verb)).toEqual([...scriptVerbs])
    expect(catalog.errors.map(error => error.code)).toEqual(scriptErrorCodes)
    expect(catalog.options.map(option => option.key)).toEqual(scriptingOptionDefs.map(def => def.key))
    expect(catalog.options.find(option => option.key === 'targetServerVersion')).toEqual({ key: 'targetServerVersion', type: 'enum', values: ['130', '140', '150', '160', '170'], default: '160' })
    // One row per scriptable kind and each of its subtypes, in catalogue order, with the same answer as scriptRow.
    const expected = nodeKinds.flatMap(kind => scriptKindSpecs[kind] ? ['', ...kindSpecs[kind].subtypes ?? []].map(subtype => `${kind} ${subtype}`) : [])
    expect(catalog.targets.map(target => `${target.kind} ${target.subtype}`)).toEqual(expected)
    for (const target of catalog.targets) {
      const spec = scriptKindSpecs[target.kind as NodeKind]!
      const row = scriptRow(target.kind as NodeKind, (target.subtype || undefined) as NodeSubtype | undefined, spec.phase === 'pr5' ? spec.parents?.[0] : undefined)
      if (!row) { expect(target, `${target.kind} ${target.subtype}`).toEqual({ ...target, phase: 'later', title: '', urn: '', preflight: '', objectTypes: [], parents: [], enabled: [], disabled: [], modifiable: false }); continue }
      expect(target.phase).toBe('pr5')
      expect([target.title, target.urn, target.preflight, target.modifiable]).toEqual([row.title, row.urn, row.preflight, row.modifiable])
      expect(target.enabled).toEqual(scriptVerbs.filter(verb => row.verbs[verb] === 'enabled'))
      expect(target.disabled).toEqual(scriptVerbs.filter(verb => row.verbs[verb] === 'disabled'))
    }
    expect(catalog.targets.find(target => target.kind === 'trigger')).toMatchObject({ parents: ['table', 'view'], enabled: ['create', 'alter', 'createOrAlter', 'drop', 'dropAndCreate'], modifiable: true })
    expect(catalog.targets.filter(target => target.phase === 'later').map(target => `${target.kind} ${target.subtype}`)).toEqual([
      'cryptographicProvider ', 'assembly ', 'asymmetricKey ', 'certificate ', 'symmetricKey ', 'columnMasterKey ', 'columnEncryptionKey ', 'externalDataSource ', 'externalFileFormat ',
      'table droppedLedger', 'view droppedLedger', 'procedure extended', 'procedure replicationFilter'
    ])
    expect(scriptingCatalogJson().endsWith('}\n')).toBe(true)
  })
  it('keeps docs/scripting.md in sync', async () => {
    await expect(renderScriptingDocs()).toMatchFileSnapshot('../docs/scripting.md')
  })
  it('documents every verb, kind, option, error and limit', () => {
    const docs = renderScriptingDocs()
    for (const verb of scriptVerbs) expect(docs, verb).toContain(`| \`${verb}\` | ${scriptVerbTitle(verb)} |`)
    for (const kind of nodeKinds) if (scriptKindSpecs[kind]?.phase === 'pr5') expect(docs, kind).toContain(`| \`${kind}\` |`)
    for (const def of scriptingOptionDefs) expect(docs, def.key).toContain(`| \`${def.key}\` |`)
    for (const code of scriptErrorCodes) expect(docs, code).toContain(`| \`${code}\` |`)
    for (const key of Object.keys(scriptLimits)) expect(docs, key).toContain(`| \`${key}\` |`)
    expect(docs).toContain('| `table` | none, `systemVersioned`, `history`, `updatableLedger`, `appendOnlyLedger`, `graphNode`, `graphEdge`, `fileTable`, `external`, `system` | Script Table as | ✓ | ○ | ○ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | `Table` | `table` |')
    expect(docs).toContain('| `table` | `ledgerHistory` | Script Table as | ○ | ○ | ○ | ○ | ○ | ✓ | ○ | ○ | ○ | ○ | – | `Table` | `table` |')
    expect(docs).toContain('| `procedure` | `sql` | Script Stored Procedure as | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | – | ✓ | ✓ | `StoredProcedure` | `module` |')
    expect(docs).toContain('| 6 | Script USE &lt;database> | `scriptUseDatabase` | True | ')
    expect(docs).toContain('| 13 | Script permissions | `scriptPermissions` | False (docs page: True) | ')
    expect(docs).toContain('`table` (`droppedLedger`)')
    expect(docs).toContain('`certificate`')
    expect(docs).toContain('| `login` | — | Script Login as |')
    expect(docs).toContain('Not scriptable: folders, and `server`, `column`, `parameter`, `returnValue`, `ssisCatalog`, `ssisFolder`, `ssisProject`, `ssisPackage`, `ssisEnvironment`.')
    expect(docs).toContain('| `maxScriptChars` | 4,000,000 |')
  })
})
