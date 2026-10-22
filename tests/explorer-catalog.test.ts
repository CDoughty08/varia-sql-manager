import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  bandOf, childParentKinds, cloudEngineEditions, engineOf, explorerCatalogJson, explorerIcons, explorerLimits, filterProperties, folderGates, folderIds, folderOwnerKinds,
  folderServed, folderSpecs, foldersFor, kindScopes, kindSpecs, laterFolders, maxBand, maxNameOf, minBand, nodeKinds, nodeSubtypes, parentKinds, queryIds, refFields,
  rootFolder, scopeFields, staticChildren, statusBadges, subfolders, svgIcons, type ExplorerProfile, type FolderId, type KindSpec, type NodeKind
} from '../src/shared/explorer/catalog'
import { renderExplorerDocs } from '../src/shared/explorer/docs'
import { svgPaths } from '../src/renderer/src/Icon'

const unique = (values: readonly unknown[]) => new Set(values).size === values.length
const box = (band: number): ExplorerProfile => ({ band, engine: 'box' })
const cloud = (band: number): ExplorerProfile => ({ band, engine: 'cloud' })
/** The served folder tree below a node, two spaces per level. */
const outline = (ids: readonly FolderId[], profile: ExplorerProfile, depth = 0): string[] =>
  ids.flatMap(id => ['  '.repeat(depth) + folderSpecs[id].label, ...outline(staticChildren({ folder: id }, profile), profile, depth + 1)])
const without = (lines: readonly string[], removed: readonly string[]) => {
  for (const line of removed) expect(lines, line).toContain(line)
  return lines.filter(line => !removed.includes(line))
}

const server = [
  'Databases', '  System Databases', '  Database Snapshots',
  'Security', '  Logins', '  Server Roles', '  Credentials', '  Cryptographic Providers', '  Audits', '  Server Audit Specifications',
  'Server Objects', '  Backup Devices', '  Linked Servers', '  Triggers'
]
const database17 = [
  'Tables', '  System Tables', '  FileTables', '  External Tables', '  Graph Tables', '  Dropped Ledger Tables',
  'Views', '  System Views', '  Dropped Ledger Views',
  'External Resources', '  External Data Sources', '  External File Formats',
  'Synonyms',
  'Programmability',
  '  Stored Procedures', '    System Stored Procedures',
  '  Functions', '    Table-valued Functions', '    Scalar-valued Functions', '    Aggregate Functions',
  '  Database Triggers', '  Assemblies',
  '  Types', '    User-Defined Data Types', '    User-Defined Table Types', '    User-Defined Types', '    XML Schema Collections',
  '  Rules', '  Defaults', '  Plan Guides', '  Sequences',
  'Storage', '  Full Text Catalogs', '  Partition Schemes', '  Partition Functions', '  Full Text Stoplists', '  Search Property Lists',
  'Security', '  Users', '  Roles', '    Database Roles', '    Application Roles', '  Schemas', '  Asymmetric Keys', '  Certificates', '  Symmetric Keys',
  '  Always Encrypted Keys', '    Column Master Keys', '    Column Encryption Keys', '  Database Audit Specifications', '  Security Policies'
]
const database16 = database17
const database14 = without(database16, ['  Dropped Ledger Tables', '  Dropped Ledger Views'])
const database13 = without(database14, ['  Graph Tables'])
const database12 = without(database13, ['  External Tables', 'External Resources', '  External Data Sources', '  External File Formats', '  Always Encrypted Keys',
  '    Column Master Keys', '    Column Encryption Keys', '  Security Policies'])

describe('Object Explorer catalogue', () => {
  it('has unique ids in every list', () => {
    for (const [name, values] of Object.entries({ nodeKinds, folderIds, nodeSubtypes, queryIds, explorerIcons, svgIcons, kindScopes, parentKinds, filterProperties })) {
      expect(unique(values), name).toBe(true)
    }
    expect(nodeKinds).toHaveLength(51)
    expect(folderIds).toHaveLength(72)
    for (const id of folderIds) expect(folderSpecs[id].id).toBe(id)
    for (const kind of nodeKinds) expect(kindSpecs[kind].kind).toBe(kind)
    expect(Object.keys(folderSpecs)).toEqual([...folderIds])
    expect(Object.keys(kindSpecs)).toEqual([...nodeKinds])
  })
  it('nests folders under existing parents with the same owner, without cycles', () => {
    for (const id of folderIds) {
      const seen = new Set<FolderId>()
      for (let current: FolderId | undefined = id; current; current = folderSpecs[current].parent) {
        expect(seen.has(current), id).toBe(false)
        seen.add(current)
        expect(folderIds, id).toContain(current)
      }
      const parent = folderSpecs[id].parent
      if (parent) {
        expect(folderSpecs[parent].owner, id).toBe(folderSpecs[id].owner)
        expect(subfolders(parent), id).toContain(id)
      }
    }
    expect(rootFolder('systemStoredProcedures')).toBe('programmability')
    expect(rootFolder('tables')).toBe('tables')
    for (const later of laterFolders) if (later.parent) expect(folderSpecs[later.parent].owner, later.label).toBe(later.owner)
  })
  it('orders siblings uniquely, planned folders included', () => {
    const siblings = new Map<string, number[]>()
    const add = (owner: string, parent: string | undefined, order: number) => {
      if (owner === 'object') return
      const key = owner + '/' + (parent ?? '')
      siblings.set(key, [...siblings.get(key) ?? [], order])
    }
    for (const id of folderIds) add(folderSpecs[id].owner, folderSpecs[id].parent, folderSpecs[id].order)
    for (const later of laterFolders) add(later.owner, later.parent, later.order)
    for (const [key, orders] of siblings) expect(unique(orders), key).toBe(true)
    for (const id of folderIds) expect(Number.isInteger(folderSpecs[id].order) && folderSpecs[id].order > 0, id).toBe(true)
    for (const kind of nodeKinds) {
      const orders = kindSpecs[kind].folders.map(id => folderSpecs[id].order)
      expect(orders, kind).toEqual([...orders].sort((a, b) => a - b))
      for (const set of Object.values(kindSpecs[kind].subtypeFolders ?? {})) expect(set!.map(id => folderSpecs[id].order), kind).toEqual(set!.map(id => folderSpecs[id].order).sort((a, b) => a - b))
    }
  })
  it('has plain labels and titles', () => {
    const texts = [...folderIds.map(id => folderSpecs[id].label), ...laterFolders.flatMap(later => [later.label, ...later.contents ?? []]), ...nodeKinds.map(kind => kindSpecs[kind].title)]
    for (const text of texts) {
      expect(text, text).toMatch(/^\S(.*\S)?$/)
      expect(text.includes('&'), text).toBe(false)
    }
  })
  it('gates versions between 2016 and 2025, never earlier than a parent', () => {
    for (const spec of [...folderIds.map(id => folderSpecs[id]), ...laterFolders]) {
      if (spec.since === undefined) continue
      expect(spec.since).toBeGreaterThanOrEqual(minBand)
      expect(spec.since).toBeLessThanOrEqual(maxBand)
    }
    for (const id of folderIds) {
      const parent = folderSpecs[id].parent
      if (!parent) continue
      expect(folderSpecs[id].since ?? 0, id).toBeGreaterThanOrEqual(folderSpecs[parent].since ?? 0)
      for (const engine of folderSpecs[id].engines ?? []) expect(folderSpecs[parent].engines ?? ['box', 'cloud'], id).toContain(engine)
    }
    expect([11, 12, 13, 14, 15, 16, 17, 18, 99].map(bandOf)).toEqual([12, 12, 13, 14, 15, 16, 17, 17, 17])
    expect([1, 2, 3, 4, 8, 5, 6, 9, 11, 12].map(engineOf)).toEqual(['box', 'box', 'box', 'box', 'box', 'cloud', 'cloud', 'cloud', 'cloud', 'cloud'])
    expect(cloudEngineEditions).toEqual([5, 6, 9, 11, 12])
  })
  it('lists rows exactly in the folders and kinds that have a query, with filters only in folders', () => {
    const lists = [...folderIds.flatMap(id => folderSpecs[id].list ?? []), ...nodeKinds.flatMap(kind => kindSpecs[kind].list ?? [])]
    expect(unique(lists)).toBe(true)
    expect([...lists, 'historyTable'].sort()).toEqual([...queryIds].sort())
    for (const kind of nodeKinds) {
      const spec = kindSpecs[kind]
      expect(spec.rows !== undefined, kind).toBe(spec.list !== undefined)
      for (const row of spec.rows ?? []) expect(nodeKinds, kind).toContain(row)
    }
    // No shipped kind lists rows yet; the SSIS catalog (S1b) is the first.
    expect(nodeKinds.filter(kind => kindSpecs[kind].list)).toEqual([])
    for (const id of folderIds) {
      const spec = folderSpecs[id]
      expect(spec.rows !== undefined, id).toBe(spec.list !== undefined)
      if (!spec.filter) continue
      expect(spec.list, id).toBeDefined()
      expect(spec.filter.length, id).toBeGreaterThan(0)
      expect(unique(spec.filter), id).toBe(true)
      // Only schema-scoped rows have a schema to filter on.
      if (spec.filter.includes('schema')) for (const kind of spec.rows!) expect(kindSpecs[kind].scope, id).toBe('schemaObject')
    }
    for (const id of ['columns', 'keys', 'constraints', 'tableTriggers', 'indexes', 'statistics', 'parameters'] as const) expect(folderSpecs[id].filter, id).toBeUndefined()
  })
  it('gives every kind a scope, an icon, its subtypes, and a way to appear', () => {
    const listed = new Set([...folderIds.flatMap(id => folderSpecs[id].rows ?? []), ...nodeKinds.flatMap(kind => kindSpecs[kind].rows ?? [])])
    const usedSubtypes = new Set<string>()
    for (const kind of nodeKinds) {
      const spec = kindSpecs[kind]
      expect(kindScopes, kind).toContain(spec.scope)
      expect(explorerIcons, kind).toContain(spec.icon)
      if (kind !== 'server') expect(listed.has(kind), kind).toBe(true)
      for (const subtype of spec.subtypes ?? []) usedSubtypes.add(subtype)
      expect(unique(spec.subtypes ?? []), kind).toBe(true)
      for (const map of [spec.subtypeIcons, spec.subtypeFolders, spec.subtypeSmo]) for (const subtype of Object.keys(map ?? {})) expect(spec.subtypes, kind).toContain(subtype)
      for (const subtype of spec.historyLookup ?? []) expect(spec.subtypes, kind).toContain(subtype)
      for (const icon of [...Object.values(spec.subtypeIcons ?? {}), ...Object.values(spec.variantIcons ?? {})]) expect(explorerIcons, kind).toContain(icon)
      if (spec.scriptable) expect(spec.smo, kind).toBeDefined()
      // A kind's own folders hang directly below it.
      const owner = kind === 'server' ? 'server' : kind === 'database' ? 'database' : 'object'
      for (const set of [spec.folders, ...Object.values(spec.subtypeFolders ?? {})]) for (const id of set!) {
        expect(folderSpecs[id].parent, `${kind} ${id}`).toBeUndefined()
        expect(folderSpecs[id].owner, `${kind} ${id}`).toBe(owner)
      }
    }
    expect([...usedSubtypes].sort()).toEqual([...nodeSubtypes].sort())
    expect(nodeKinds.filter(kind => kindSpecs[kind].historyLookup)).toEqual(['table'])
    expect(nodeKinds.filter(kind => !kindSpecs[kind].scriptable)).toEqual(['server', 'column', 'parameter', 'returnValue'])
    // Schema-scoped objects insert [schema].[name]; the rest a one-part name, except parameters, the server and return values.
    for (const kind of nodeKinds) expect(kindSpecs[kind].insert === 'twoPart', kind).toBe(kindSpecs[kind].scope === 'schemaObject')
    expect(nodeKinds.filter(kind => kindSpecs[kind].insert === 'none')).toEqual(['server', 'returnValue'])
    expect(nodeKinds.filter(kind => kindSpecs[kind].insert === 'raw')).toEqual(['parameter'])
  })
  it('lets every folder hang below some kind, and child kinds below the kinds that list them', () => {
    for (const id of folderIds) {
      const owners = folderOwnerKinds(id)
      expect(owners.length, id).toBeGreaterThan(0)
      const { owner } = folderSpecs[id]
      if (owner === 'server' || owner === 'database') expect(owners, id).toEqual([owner])
      else for (const kind of owners) expect(parentKinds, id).toContain(kind)
    }
    expect(folderOwnerKinds('columns')).toEqual(['table', 'view', 'function', 'tableType'])
    expect(folderOwnerKinds('parameters')).toEqual(['procedure', 'function'])
    expect(folderOwnerKinds('systemTables')).toEqual(['database'])
    expect(Object.fromEntries(nodeKinds.filter(kind => childParentKinds(kind).length).map(kind => [kind, childParentKinds(kind)]))).toEqual({
      column: ['table', 'view', 'tableType', 'function'], key: ['table', 'tableType'], constraint: ['table', 'tableType'], trigger: ['table', 'view'],
      index: ['table', 'view', 'tableType'], statistic: ['table', 'view'], parameter: ['procedure', 'function'], returnValue: ['procedure', 'function']
    })
    for (const kind of nodeKinds) expect(childParentKinds(kind).length > 0, kind).toBe(['child', 'childUnnamed'].includes(kindSpecs[kind].scope))
    expect(new Set(nodeKinds.flatMap(childParentKinds))).toEqual(new Set(parentKinds))
  })
  it('splits each scope\'s fields into required and forbidden', () => {
    for (const scope of kindScopes) {
      const { required, forbidden } = scopeFields[scope]
      expect([...required, ...forbidden].sort(), scope).toEqual([...refFields].sort())
    }
    expect(refFields).toEqual(['database', 'schema', 'name', 'parent', 'ssisFolder', 'ssisProject'])
    expect(scopeFields.ssisFolderObject.required).toEqual(['ssisFolder', 'name'])
    expect(scopeFields.ssisProjectObject.required).toEqual(['ssisFolder', 'ssisProject', 'name'])
    for (const scope of kindScopes.filter(scope => !scope.startsWith('ssis'))) expect(scopeFields[scope].forbidden, scope).toEqual(expect.arrayContaining(['ssisFolder', 'ssisProject']))
  })
  it('bounds names at sysname\'s 128 unless a kind declares a longer one within the catalogue\'s maximum', () => {
    for (const kind of nodeKinds) {
      const { maxName } = kindSpecs[kind]
      if (maxName !== undefined) expect(Number.isInteger(maxName) && maxName > 128 && maxName <= explorerLimits.maxName, kind).toBe(true)
    }
    // Packages (260) arrive with the SSIS kinds in S1b.
    expect(nodeKinds.filter(kind => kindSpecs[kind].maxName !== undefined)).toEqual([])
    expect(maxNameOf(kindSpecs.table)).toBe(128)
    expect(maxNameOf({ maxName: 260 })).toBe(260)
  })
  it('gives a kind with names past 128 no folders, history row or rows, which bind their owner\'s name as a sysname', () => {
    const ownsChildren = (spec: KindSpec) => spec.folders.length > 0 || Object.keys(spec.subtypeFolders ?? {}).length > 0 || (spec.historyLookup?.length ?? 0) > 0 || spec.list !== undefined
    for (const kind of nodeKinds) if (maxNameOf(kindSpecs[kind]) > 128) expect(ownsChildren(kindSpecs[kind]), kind).toBe(false)
    expect(ownsChildren(kindSpecs.synonym)).toBe(false)
    expect([{ list: 'logins' as const }, { folders: ['columns'] as const }, { historyLookup: ['history'] as const }, { subtypeFolders: { history: ['columns'] as const } }]
      .map(change => ownsChildren({ ...kindSpecs.synonym, ...change }))).toEqual([true, true, true, true])
  })
  it('uses icons that exist: codicons in the bundled font, svg icons in Icon.tsx', async () => {
    // Untyped Monaco internals, as in command-catalog.test.ts.
    const library = 'monaco-editor/base/common/codiconsLibrary.js', util = 'monaco-editor/base/common/codiconsUtil.js'
    await import(library)
    const { getCodiconFontCharacters } = await import(util) as { getCodiconFontCharacters(): Record<string, number> }
    const characters = getCodiconFontCharacters()
    for (const icon of [...explorerIcons, ...Object.values(statusBadges)]) {
      if (icon.startsWith('svg:')) expect(svgIcons, icon).toContain(icon.slice(4))
      else expect(Object.hasOwn(characters, icon), icon).toBe(true)
    }
    for (const icon of svgIcons) expect(Object.hasOwn(svgPaths, icon), icon).toBe(true)
    expect(explorerIcons.filter(icon => icon.startsWith('svg:'))).toEqual(svgIcons.map(icon => 'svg:' + icon))
  })
  it('serves the SSMS server folders, and only Databases on cloud editions', () => {
    for (const band of [12, 13, 14, 16, 17]) {
      expect(outline(staticChildren({ kind: 'server' }, box(band)), box(band)), `box ${band}`).toEqual(server)
      expect(outline(staticChildren({ kind: 'server' }, cloud(band)), cloud(band)), `cloud ${band}`).toEqual(['Databases', '  System Databases'])
    }
  })
  it('serves the SSMS database folders for each version band, on every engine', () => {
    const expected: Record<number, string[]> = { 12: database12, 13: database13, 14: database14, 16: database16, 17: database17 }
    for (const [band, lines] of Object.entries(expected)) for (const profile of [box(Number(band)), cloud(Number(band))]) {
      expect(outline(staticChildren({ kind: 'database' }, profile), profile), `${profile.engine} ${band}`).toEqual(lines)
      expect(outline(staticChildren({ kind: 'database', subtype: 'snapshot' }, profile), profile)).toEqual(lines)
    }
    expect(database12).toHaveLength(40)
    expect(folderServed('externalDataSources', box(12))).toBe(false)
    expect(folderServed('externalDataSources', box(13))).toBe(true)
    expect(folderServed('logins', cloud(17))).toBe(false)
    expect(folderGates('logins')).toEqual({ since: undefined, engines: ['box'] })
    expect(folderGates('graphTables')).toEqual({ since: 14, engines: ['box', 'cloud'] })
  })
  it('gives objects their SSMS child folders', () => {
    const labels = (kind: NodeKind, subtype?: Parameters<typeof foldersFor>[1]) => staticChildren({ kind, subtype }, box(17)).map(id => folderSpecs[id].label)
    const six = ['Columns', 'Keys', 'Constraints', 'Triggers', 'Indexes', 'Statistics']
    for (const subtype of [undefined, 'graphNode', 'graphEdge', 'fileTable', 'systemVersioned', 'updatableLedger', 'appendOnlyLedger', 'system'] as const) expect(labels('table', subtype), subtype).toEqual(six)
    for (const subtype of ['history', 'ledgerHistory', 'droppedLedger'] as const) expect(labels('table', subtype), subtype).toEqual(['Columns', 'Indexes', 'Statistics'])
    expect(labels('table', 'external')).toEqual(['Columns', 'Statistics'])
    expect(kindSpecs.table.historyLookup).toEqual(['systemVersioned', 'updatableLedger'])
    for (const subtype of [undefined, 'system', 'ledger', 'droppedLedger'] as const) expect(labels('view', subtype)).toEqual(['Columns', 'Triggers', 'Indexes', 'Statistics'])
    expect(labels('tableType')).toEqual(['Columns', 'Keys', 'Constraints', 'Indexes'])
    for (const subtype of [undefined, 'sql', 'clr', 'extended', 'replicationFilter', 'system'] as const) expect(labels('procedure', subtype)).toEqual(['Parameters'])
    for (const subtype of ['inline', 'tableValued', 'clrTableValued'] as const) expect(labels('function', subtype)).toEqual(['Columns', 'Parameters'])
    for (const subtype of [undefined, 'scalar', 'clrScalar', 'aggregate'] as const) expect(labels('function', subtype)).toEqual(['Parameters'])
    const parents = ['server', 'database', 'table', 'view', 'tableType', 'procedure', 'function']
    for (const kind of nodeKinds.filter(kind => !parents.includes(kind))) expect(foldersFor(kind), kind).toEqual([])
    for (const id of ['columns', 'parameters'] as const) expect(staticChildren({ folder: id }, box(12))).toEqual([])
  })
  it('loads in plain Node 24, so scripts and test fixtures can share it', () => {
    const files = ['catalog.ts', 'refs.ts', 'schema.ts', 'docs.ts'].map(name => join('src', 'shared', 'explorer', name))
    // Strip mode throws on enums, namespaces, parameter properties, and other syntax that needs a transform.
    for (const file of files) expect(() => stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }), file).not.toThrow()
    const script = files.map(file => `await import(${JSON.stringify(pathToFileURL(file).href)})`).join(';')
    const result = spawnSync(process.execPath, ['--input-type=module', '--disable-warning=ExperimentalWarning', '-e', script], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
  it('keeps the spec\'s limits', () => {
    expect(explorerLimits).toEqual({
      pageSize: 2000, folderCap: 100_000, nodeBudget: 250_000, inFlightPerConnection: 4, inFlightTotal: 8, queuePerConnection: 512,
      cancelBatch: 256, siblingLoads: 50, filters: 64, watchdogMs: 60_000, loadingRowDelayMs: 150, typeAheadMs: 1000,
      typeAheadMax: 64, rowHeight: 22, indent: 16, overscan: 10, deleteSlice: 10_000,
      cursorLength: 1650, label: 300, sublabel: 200, detail: 512, message: 512, maxName: 260
    })
  })
})

// Regenerate both files after changing the catalogue: npx vitest run tests/explorer-catalog.test.ts -u
describe('generated catalogue files', () => {
  it('keeps the backend\'s embedded copy in sync', async () => {
    await expect(explorerCatalogJson()).toMatchFileSnapshot('../backend/Varia.Backend/Explorer/explorer-catalog.json')
  })
  it('exports served folders and every kind, with sorted keys and defaults spelled out', () => {
    const catalog = JSON.parse(explorerCatalogJson()) as { version: number; folders: { id: string; engines: string[]; filter: string[] }[]; kinds: { kind: string; parents: string[]; subtypes: string[]; rows: string[]; maxName: number; list?: string }[]; queries: string[]; scopes: object; cloudEngineEditions: number[] }
    const sorted = (value: unknown, path: string): void => {
      if (Array.isArray(value)) { value.forEach((item, index) => sorted(item, `${path}[${index}]`)); return }
      if (!value || typeof value !== 'object') return
      const keys = Object.keys(value)
      expect(keys, path).toEqual([...keys].sort())
      for (const key of keys) sorted((value as Record<string, unknown>)[key], `${path}.${key}`)
    }
    sorted(catalog, '$')
    expect(catalog.version).toBe(1)
    expect(catalog.folders.map(folder => folder.id)).toEqual([...folderIds])
    expect(catalog.kinds.map(kind => kind.kind)).toEqual([...nodeKinds])
    expect(catalog.queries).toEqual([...queryIds])
    expect(catalog.cloudEngineEditions).toEqual([5, 6, 9, 11, 12])
    expect(catalog.scopes).toEqual(scopeFields)
    for (const folder of catalog.folders) { expect(folder.engines.length, folder.id).toBeGreaterThan(0); expect(Array.isArray(folder.filter), folder.id).toBe(true) }
    // Gates are resolved through the folders above, so the backend checks one folder only.
    const folder = (id: FolderId) => catalog.folders.find(folder => folder.id === id) as { engines: string[]; since?: number }
    expect(folder('serverSecurity').engines).toEqual(['box'])
    expect(folder('logins').engines).toEqual(['box'])
    expect(folder('tables').engines).toEqual(['box', 'cloud'])
    expect(folder('tables').since).toBeUndefined()
    expect(folder('columnMasterKeys').since).toBe(13)
    for (const id of folderIds) for (const profile of [box(12), box(13), box(14), box(16), box(17), cloud(12), cloud(16), cloud(17)]) {
      expect((folder(id).since ?? 12) <= profile.band && folder(id).engines.includes(profile.engine), `${id} ${profile.engine} ${profile.band}`).toBe(folderServed(id, profile))
    }
    expect(catalog.kinds.find(kind => kind.kind === 'column')?.parents).toEqual(['table', 'view', 'tableType', 'function'])
    expect(catalog.kinds.find(kind => kind.kind === 'login')?.subtypes).toEqual([])
    for (const kind of catalog.kinds) { expect(kind.maxName, kind.kind).toBe(maxNameOf(kindSpecs[kind.kind as NodeKind])); expect(kind.rows, kind.kind).toEqual(kindSpecs[kind.kind as NodeKind].rows ?? []) }
    const json = explorerCatalogJson()
    for (const later of laterFolders) expect(json.includes(`"${later.label}"`), later.label).toBe(false)
    expect(json.endsWith('}\n')).toBe(true)
  })
  it('keeps docs/object-explorer.md in sync', async () => {
    await expect(renderExplorerDocs()).toMatchFileSnapshot('../docs/object-explorer.md')
  })
  it('documents every folder, planned folders, kinds and limits', () => {
    const docs = renderExplorerDocs()
    for (const id of folderIds) expect(docs, id).toContain(`| \`${id}\` |`)
    for (const kind of nodeKinds) expect(docs, kind).toContain(`| \`${kind}\` |`)
    for (const later of laterFolders) expect(docs, later.label).toContain(later.label)
    expect(docs).toContain('| Databases › System Databases | `systemDatabases` | — | Yes | Database (`systemDatabases`) | — |')
    expect(docs).toContain('| Tables › Graph Tables | `graphTables` | 2017 (14) | Yes | Table (`graphTables`) | Name, Schema, Owner, Creation Date |')
    expect(docs).toContain('| Security | `serverSecurity` | — | No | — | — |')
    expect(docs).toContain('| Server Objects › Endpoints | — | — | — | Planned: System Endpoints, Database Mirroring, Service Broker, TSQL | — |')
    expect(docs).toContain('| `table` | `systemVersioned`, `updatableLedger` | Its history table first, then Columns, Keys, Constraints, Triggers, Indexes, Statistics |')
    expect(docs).toContain('| `function` | `inline`, `tableValued`, `clrTableValued` | Columns, Parameters |')
    expect(docs).toContain('| `parameter` | Parameter | `child` | `symbol-parameter` | Parameter | No | the name as is (`@name`) |')
    expect(docs).toContain('| `pageSize` | 2,000 |')
    expect(docs).toContain(`## Node kinds (${nodeKinds.length})`)
  })
})
