import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { explorerLimits, folderIds, kindScopes, kindSpecs, nodeKinds, scopeFields, type KindScope, type KindSpec, type NodeKind } from '../src/shared/explorer/catalog'
import { displayText, insertTextFor, kindScope, quoteName, refKey, type ExplorerChildrenParams, type ExplorerNodeRef, type ObjectRef } from '../src/shared/explorer/refs'
import {
  childrenParamsProblems, explorerCancelParamsSchema, explorerChildrenParamsSchema, explorerFilterSchema, ident, nodeRefSchema, objectRefProblems, objectRefSchema, type KindSpecs
} from '../src/shared/explorer/schema'

const connectionId = '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d'
/** The smallest valid ref of each kind. */
function minimal(kind: NodeKind): ObjectRef {
  switch (kindScope(kind)) {
    case 'server': return { kind }
    case 'serverObject': case 'database': return { kind, name: 'n' }
    case 'databaseObject': return { kind, database: 'db', name: 'n' }
    case 'schemaObject': return { kind, database: 'db', schema: 's', name: 'n' }
    case 'child': return { kind, database: 'db', parent: { kind: kind === 'parameter' ? 'procedure' : 'table', schema: 's', name: 'p' }, name: kind === 'parameter' ? '@n' : 'n' }
    case 'childUnnamed': return { kind, database: 'db', parent: { kind: 'procedure', schema: 's', name: 'p' } }
    case 'ssisCatalog': case 'ssisFolder': return { kind, name: 'n' }
    case 'ssisFolderObject': return { kind, ssisFolder: 'f', name: 'n' }
    case 'ssisProjectObject': return { kind, ssisFolder: 'f', ssisProject: 'p', name: 'n' }
  }
}
/** The catalogue with one kind changed: the mechanisms SSIS kinds use (S1b) are checked before any shipped kind uses them. */
const variant = (kind: NodeKind, change: Partial<KindSpec>): KindSpecs => ({ ...kindSpecs, [kind]: { ...kindSpecs[kind], ...change } })
const children = (node: ExplorerNodeRef, extra: Partial<ExplorerChildrenParams> = {}): ExplorerChildrenParams => ({ connectionId, requestId: randomUUID(), node, ...extra })
const object = (ref: ObjectRef): ExplorerNodeRef => ({ type: 'object', object: ref })
const params = (node: ExplorerNodeRef, extra: Record<string, unknown> = {}) => ({ connectionId, requestId: randomUUID(), node, ...extra })
const tables: ExplorerNodeRef = { type: 'folder', owner: { kind: 'database', name: 'AppData' }, folder: 'tables' }
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(true)
const rejects = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false)

describe('node identity', () => {
  it('maps each kind to its scope', () => {
    const expected: Record<KindScope, NodeKind[]> = {
      server: ['server'],
      serverObject: ['login', 'serverRole', 'credential', 'cryptographicProvider', 'audit', 'serverAuditSpecification', 'backupDevice', 'linkedServer', 'serverTrigger'],
      database: ['database'],
      databaseObject: ['user', 'databaseRole', 'applicationRole', 'schema', 'assembly', 'asymmetricKey', 'certificate', 'symmetricKey', 'columnMasterKey', 'columnEncryptionKey',
        'databaseAuditSpecification', 'databaseTrigger', 'externalDataSource', 'externalFileFormat', 'fullTextCatalog', 'fullTextStoplist', 'partitionScheme', 'partitionFunction',
        'searchPropertyList', 'planGuide'],
      schemaObject: ['table', 'view', 'synonym', 'procedure', 'function', 'sequence', 'type', 'tableType', 'xmlSchemaCollection', 'rule', 'default', 'securityPolicy'],
      child: ['column', 'key', 'constraint', 'trigger', 'index', 'statistic', 'parameter'],
      childUnnamed: ['returnValue'],
      ssisCatalog: [], ssisFolder: [], ssisFolderObject: [], ssisProjectObject: []
    }
    for (const scope of kindScopes) expect(nodeKinds.filter(kind => kindScope(kind) === scope), scope).toEqual(expected[scope])
  })
  it('keys refs stably and case-sensitively', () => {
    const ref = object({ kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' })
    expect(refKey(connectionId, ref)).toBe(refKey(connectionId, object({ name: 'Orders', schema: 'dbo', database: 'AppData', kind: 'table' })))
    expect(refKey(connectionId, ref)).toBe(JSON.stringify([connectionId, 'object', 'table', 'AppData', 'dbo', 'Orders', null, null, null, null]))
    expect(refKey(connectionId, ref)).not.toBe(refKey(connectionId, object({ kind: 'table', database: 'AppData', schema: 'dbo', name: 'orders' })))
    expect(refKey(connectionId, ref)).not.toBe(refKey(randomUUID(), ref))
    expect(refKey(connectionId, tables)).toBe(JSON.stringify([connectionId, 'folder', 'database', null, null, 'AppData', null, null, null, 'tables']))
  })
  it('keeps every existing kind\'s key as it was before the SSIS fields', () => {
    // Generated at 74d3ab7, before ObjectRef had SSIS fields: Object Explorer keys its selection, filters and expansion by these.
    const golden = JSON.parse(readFileSync('tests/fixtures/explorer/ref-keys.json', 'utf8')) as { connectionId: string; ref: ExplorerNodeRef; key: string }[]
    expect(golden.length).toBeGreaterThan(300)
    expect(new Set(golden.map(entry => entry.ref.type === 'object' ? entry.ref.object.kind : entry.ref.owner.kind))).toEqual(new Set(nodeKinds))
    expect(new Set(golden.flatMap(entry => entry.ref.type === 'folder' ? [entry.ref.folder] : []))).toEqual(new Set(folderIds))
    for (const entry of golden) expect(refKey(entry.connectionId, entry.ref), entry.key).toBe(entry.key)
  })
  it('keys SSIS refs by folder and project, apart from every other ref', () => {
    const plain = object({ kind: 'database', name: 'n' })
    const keyed: ExplorerNodeRef[] = [plain, object({ kind: 'database', name: 'n', ssisFolder: 'f' }), object({ kind: 'database', name: 'n', ssisProject: 'f' }),
      object({ kind: 'database', name: 'n', ssisFolder: 'f', ssisProject: 'p' }), object({ kind: 'database', name: 'n', ssisFolder: 'p', ssisProject: 'f' }),
      object({ kind: 'database', name: 'n', ssisFolder: 'null' }), object({ kind: 'database', name: 'n', ssisFolder: 'f', ssisProject: 'null' }),
      { type: 'folder', owner: { kind: 'database', name: 'n', ssisFolder: 'f' }, folder: 'tables' }, { type: 'folder', owner: { kind: 'database', name: 'n' }, folder: 'tables' }]
    const keys = keyed.map(ref => refKey(connectionId, ref))
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys[3]).toBe(JSON.stringify([connectionId, 'object', 'database', null, null, 'n', null, null, null, null, 'f', 'p']))
    expect(keys[1]).toBe(JSON.stringify([connectionId, 'object', 'database', null, null, 'n', null, null, null, null, 'f', null]))
    expect(keys[0]).toBe(JSON.stringify([connectionId, 'object', 'database', null, null, 'n', null, null, null, null]))
  })
  it('keys distinct refs apart, whatever their names hold', () => {
    const names = [']', '"', '\\', '\u0001', ',', 'null', '"null"', '["a","b"]', 'a', 'A', ' ', '😀', 'x'.repeat(128), 'dbo.Orders', 'dbo', 'Orders']
    const refs: ExplorerNodeRef[] = []
    for (const a of names) {
      refs.push(object({ kind: 'database', name: a }), { type: 'folder', owner: { kind: 'database', name: a }, folder: 'tables' }, { type: 'folder', owner: { kind: 'database', name: a }, folder: 'views' })
      for (const b of names) {
        refs.push(object({ kind: 'table', database: 'db', schema: a, name: b }), object({ kind: 'view', database: 'db', schema: a, name: b }), object({ kind: 'user', database: a, name: b }))
        refs.push(object({ kind: 'column', database: 'db', parent: { kind: 'table', schema: a, name: b }, name: 'c' }))
        refs.push(object({ kind: 'returnValue', database: a, parent: { kind: 'function', schema: 's', name: b } }))
        refs.push(object({ kind: 'database', ssisFolder: a, name: b }), object({ kind: 'database', ssisFolder: a, ssisProject: b, name: 'n' }), object({ kind: 'database', ssisProject: a, name: b }))
      }
    }
    refs.push(object({ kind: 'server' }), { type: 'folder', owner: { kind: 'server' }, folder: 'databases' })
    const keys = refs.map(ref => refKey(connectionId, ref))
    expect(new Set(keys).size).toBe(keys.length)
  })
  it('quotes names as QUOTENAME does', () => {
    expect(quoteName('Orders')).toBe('[Orders]')
    expect(quoteName('a]b]]')).toBe('[a]]b]]]]]')
    expect(quoteName(' ')).toBe('[ ]')
  })
  it('inserts each kind\'s name in its style', () => {
    const expected: Partial<Record<NodeKind, string | undefined>> = { server: undefined, returnValue: undefined, parameter: '@n' }
    for (const kind of nodeKinds) {
      const style = kindSpecs[kind].insert
      const text = kind in expected ? expected[kind] : style === 'twoPart' ? '[s].[n]' : '[n]'
      expect(insertTextFor(object(minimal(kind))), kind).toBe(text)
    }
    expect(insertTextFor(object({ kind: 'table', database: 'App]Data', schema: 'my]schema', name: 'Order]s' }))).toBe('[my]]schema].[Order]]s]')
    expect(insertTextFor(object({ kind: 'database', name: 'App]Data' }))).toBe('[App]]Data]')
    expect(insertTextFor(object({ kind: 'column', database: 'db', parent: { kind: 'view', schema: 's', name: 'v' }, name: 'First Name' }))).toBe('[First Name]')
    expect(insertTextFor(object({ kind: 'procedure', database: 'db', schema: 'dbo', name: 'usp_Get' }))).toBe('[dbo].[usp_Get]')
    expect(insertTextFor(object({ kind: 'login', name: 'DOMAIN\\user' }))).toBe('[DOMAIN\\user]')
    expect(insertTextFor(tables)).toBeUndefined()
    expect(insertTextFor({ type: 'folder', owner: { kind: 'server' }, folder: 'databases' })).toBeUndefined()
  })
  it('shows invisible and reordering characters as markers', () => {
    const marked = [...Array.from({ length: 0x20 }, (_, code) => code), 0x7f, ...Array.from({ length: 0x20 }, (_, index) => 0x80 + index), 0x2028, 0x2029,
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]
    for (const code of marked) {
      const hex = code.toString(16).toUpperCase().padStart(4, '0')
      expect(displayText(`a${String.fromCharCode(code)}b`), hex).toBe(`a⟨U+${hex}⟩b`)
    }
    for (const text of ['Orders', 'Ünïcødé表', '😀', ' ', '50%_off', '[x]', '\u200b', '\u00a0', 'a\u0301', 'ﬁ']) expect(displayText(text), text).toBe(text)
    expect(displayText('evil\u202etxt.exe')).toBe('evil⟨U+202E⟩txt.exe')
    expect(displayText('line\r\nbreak\ttab')).toBe('line⟨U+000D⟩⟨U+000A⟩break⟨U+0009⟩tab')
  })
})

describe('explorer request schemas', () => {
  it('accepts names verbatim within sysname limits', () => {
    for (const value of ['a', ' ', '  x  ', 'x'.repeat(128), '𝒜'.repeat(64), ']', '\u202e']) accepts(ident, value)
    for (const value of ['', 'x'.repeat(129), '𝒜'.repeat(64) + 'a', 'a\u0000b', 1, null]) rejects(ident, value)
  })
  it('accepts each scope\'s minimal ref and rejects missing or forbidden fields', () => {
    for (const kind of nodeKinds) {
      const ref = minimal(kind)
      accepts(objectRefSchema, ref)
      accepts(nodeRefSchema, object(ref))
      const { required, forbidden } = scopeFields[kindScope(kind)]
      for (const field of required) { const copy: Record<string, unknown> = { ...ref }; delete copy[field]; rejects(objectRefSchema, copy) }
      for (const field of forbidden) rejects(objectRefSchema, { ...ref, [field]: field === 'parent' ? { kind: 'table', schema: 's', name: 'p' } : 'x' })
    }
  })
  it('checks each SSIS scope\'s fields, and refuses SSIS fields on every other kind', () => {
    const scoped: [KindScope, NodeKind, ObjectRef][] = [
      ['ssisCatalog', 'server', { kind: 'server', name: 'SSISDB' }],
      ['ssisFolder', 'login', { kind: 'login', name: 'Finance' }],
      ['ssisFolderObject', 'user', { kind: 'user', ssisFolder: 'Finance', name: 'Loads' }],
      ['ssisProjectObject', 'table', { kind: 'table', ssisFolder: 'Finance', ssisProject: 'Loads', name: 'Daily.dtsx' }]
    ]
    for (const [scope, kind, ref] of scoped) {
      const specs = variant(kind, { scope })
      expect(objectRefProblems(ref, specs), scope).toEqual([])
      for (const field of scopeFields[scope].required) {
        const copy: Record<string, unknown> = { ...ref }
        delete copy[field]
        expect(objectRefProblems(copy as unknown as ObjectRef, specs), `${scope} ${field}`).toEqual([`A ${kind} needs a ${field}.`])
      }
      for (const field of scopeFields[scope].forbidden) {
        expect(objectRefProblems({ ...ref, [field]: field === 'parent' ? { kind: 'table', schema: 's', name: 'p' } : 'x' }, specs), `${scope} ${field}`).toContain(`A ${kind} has no ${field}.`)
      }
    }
    for (const kind of nodeKinds) for (const field of ['ssisFolder', 'ssisProject'] as const) {
      expect(scopeFields[kindScope(kind)].forbidden, kind).toContain(field)
      rejects(objectRefSchema, { ...minimal(kind), [field]: 'Finance' })
    }
    for (const field of ['ssisFolder', 'ssisProject'] as const) {
      for (const value of ['', 'x'.repeat(129), '𝒜'.repeat(64) + 'a', 'a\u0000', 1]) {
        expect(objectRefSchema.safeParse({ kind: 'server', [field]: value }).error?.issues.some(issue => issue.path[0] === field), `${field} ${String(value)}`).toBe(true)
      }
      expect(objectRefSchema.safeParse({ kind: 'server', [field]: 'x'.repeat(128) }).error?.issues.some(issue => issue.path[0] === field), field).toBe(false)
    }
  })
  it('bounds names by kind: 128 unless the kind declares a longer one, never past the catalogue\'s maximum', () => {
    expect(explorerLimits.maxName).toBe(260)
    for (const kind of nodeKinds) {
      const named = minimal(kind)
      if (named.name === undefined) continue
      accepts(objectRefSchema, { ...named, name: 'x'.repeat(128) })
      rejects(objectRefSchema, { ...named, name: 'x'.repeat(129) })
      rejects(objectRefSchema, { ...named, name: '𝒜'.repeat(64) + 'a' })
    }
    const packages = variant('login', { maxName: 260 })
    expect(objectRefProblems({ kind: 'login', name: 'x'.repeat(260) }, packages)).toEqual([])
    expect(objectRefProblems({ kind: 'login', name: 'x'.repeat(261) }, packages)).toEqual(['A login name has at most 260 UTF-16 code units.'])
    expect(objectRefProblems({ kind: 'login', name: 'x'.repeat(129) })).toEqual(['A login name has at most 128 UTF-16 code units.'])
    rejects(objectRefSchema, { kind: 'login', name: 'x'.repeat(261) })
    // The other identity fields stay sysnames.
    rejects(objectRefSchema, { kind: 'user', database: 'x'.repeat(129), name: 'n' })
    rejects(objectRefSchema, { kind: 'column', database: 'db', parent: { kind: 'table', schema: 's', name: 'x'.repeat(129) }, name: 'c' })
  })
  it('rejects extra keys, bad names, and children of the wrong parent', () => {
    rejects(objectRefSchema, { kind: 'database', name: 'db', extra: 1 })
    rejects(objectRefSchema, { kind: 'folder', name: 'db' })
    rejects(objectRefSchema, { kind: 'database', name: 'x'.repeat(129) })
    rejects(objectRefSchema, { kind: 'database', name: 'a\u0000' })
    rejects(objectRefSchema, { kind: 'database', name: '' })
    accepts(objectRefSchema, { kind: 'database', name: ' ' })
    rejects(objectRefSchema, { kind: 'column', database: 'db', parent: { kind: 'table', schema: 's', name: 'p', extra: true }, name: 'c' })
    rejects(objectRefSchema, { kind: 'column', database: 'db', parent: { kind: 'database', schema: 's', name: 'p' }, name: 'c' })
    rejects(objectRefSchema, { kind: 'column', database: 'db', parent: { kind: 'procedure', schema: 's', name: 'p' }, name: 'c' })
    rejects(objectRefSchema, { kind: 'parameter', database: 'db', parent: { kind: 'table', schema: 's', name: 'p' }, name: '@c' })
    rejects(objectRefSchema, { kind: 'key', database: 'db', parent: { kind: 'view', schema: 's', name: 'p' }, name: 'k' })
    accepts(objectRefSchema, { kind: 'column', database: 'db', parent: { kind: 'function', schema: 's', name: 'tvf' }, name: 'c' })
    accepts(objectRefSchema, { kind: 'index', database: 'db', parent: { kind: 'tableType', schema: 's', name: 't' }, name: 'ix' })
    rejects(nodeRefSchema, { type: 'object', object: { kind: 'server' }, extra: 1 })
    rejects(nodeRefSchema, { type: 'item', object: { kind: 'server' } })
  })
  it('accepts folders only below the kinds that own them', () => {
    accepts(nodeRefSchema, { type: 'folder', owner: { kind: 'server' }, folder: 'databases' })
    accepts(nodeRefSchema, { type: 'folder', owner: { kind: 'server' }, folder: 'logins' })
    accepts(nodeRefSchema, tables)
    accepts(nodeRefSchema, { type: 'folder', owner: { kind: 'database', name: 'db' }, folder: 'systemStoredProcedures' })
    accepts(nodeRefSchema, { type: 'folder', owner: minimal('function'), folder: 'columns' })
    accepts(nodeRefSchema, { type: 'folder', owner: minimal('procedure'), folder: 'parameters' })
    rejects(nodeRefSchema, { type: 'folder', owner: { kind: 'server' }, folder: 'tables' })
    rejects(nodeRefSchema, { type: 'folder', owner: { kind: 'database', name: 'db' }, folder: 'logins' })
    rejects(nodeRefSchema, { type: 'folder', owner: minimal('table'), folder: 'parameters' })
    rejects(nodeRefSchema, { type: 'folder', owner: minimal('view'), folder: 'keys' })
    rejects(nodeRefSchema, { type: 'folder', owner: minimal('login'), folder: 'columns' })
    rejects(nodeRefSchema, { type: 'folder', owner: { kind: 'database', name: 'db' }, folder: 'endpoints' })
    rejects(nodeRefSchema, { type: 'folder', owner: { kind: 'database' }, folder: 'tables' })
    rejects(nodeRefSchema, { type: 'folder', owner: { kind: 'database', name: 'db' }, folder: 'tables', extra: 1 })
    for (const folder of folderIds) expect(nodeRefSchema.safeParse({ type: 'folder', owner: { kind: 'server' }, folder }).success, folder).toBe(['databases', 'systemDatabases',
      'databaseSnapshots', 'serverSecurity', 'logins', 'serverRoles', 'credentials', 'cryptographicProviders', 'audits', 'serverAuditSpecifications', 'serverObjects',
      'backupDevices', 'linkedServers', 'serverTriggers'].includes(folder))
  })
  it('accepts children requests within their bounds', () => {
    accepts(explorerChildrenParamsSchema, params(object({ kind: 'server' })))
    accepts(explorerChildrenParamsSchema, params(tables, { pageSize: 1 }))
    accepts(explorerChildrenParamsSchema, params(tables, { pageSize: 2000, cursor: 'v1.tables.WyJkYm8iLCJPcmRlcnMiXQ' }))
    accepts(explorerChildrenParamsSchema, params(object(minimal('table')), { subtype: 'systemVersioned' }))
    for (const pageSize of [0, 2001, 1.5, '10']) rejects(explorerChildrenParamsSchema, params(tables, { pageSize }))
    rejects(explorerChildrenParamsSchema, params(tables, { extra: true }))
    rejects(explorerChildrenParamsSchema, { ...params(tables), connectionId: 'server-a' })
    rejects(explorerChildrenParamsSchema, { ...params(tables), requestId: undefined })
    rejects(explorerChildrenParamsSchema, { ...params(tables), requestId: 'not-a-uuid' })
  })
  it('accepts a subtype only for an object of that kind', () => {
    rejects(explorerChildrenParamsSchema, params(object(minimal('table')), { subtype: 'scalar' }))
    rejects(explorerChildrenParamsSchema, params(object(minimal('login')), { subtype: 'system' }))
    rejects(explorerChildrenParamsSchema, params(tables, { subtype: 'system' }))
    rejects(explorerChildrenParamsSchema, params(object(minimal('table')), { subtype: 'unknown' }))
    accepts(explorerChildrenParamsSchema, params(object({ kind: 'database', name: 'snap' }), { subtype: 'snapshot' }))
  })
  it('rejects cursors that are malformed or for another folder', () => {
    const payload = 'WyJkYm8iLCJPcmRlcnMiXQ'
    for (const cursor of ['', `v2.tables.${payload}`, `v1.nope.${payload}`, `v1.tables.${payload}+`, `v1.tables.${payload}=`, 'v1.tables.', `v1.tables.${'a'.repeat(1601)}`,
      `v1.views.${payload}`, `v1.historyTable.${payload}`, `V1.tables.${payload}`, ` v1.tables.${payload}`]) rejects(explorerChildrenParamsSchema, params(tables, { cursor }))
    rejects(explorerChildrenParamsSchema, params(object(minimal('table')), { cursor: `v1.tables.${payload}` }))
    rejects(explorerChildrenParamsSchema, params({ type: 'folder', owner: { kind: 'database', name: 'db' }, folder: 'programmability' }, { cursor: `v1.tables.${payload}` }))
    accepts(explorerChildrenParamsSchema, params({ type: 'folder', owner: minimal('procedure'), folder: 'parameters' }, { cursor: 'v1.parameters.WzEyXQ' }))
    accepts(explorerChildrenParamsSchema, params(tables, { cursor: `v1.tables.${'a'.repeat(1600)}` }))
  })
  it('accepts a cursor on an object whose kind lists rows after its folders, for that query only', () => {
    const listing = variant('database', { list: 'schemas', rows: ['schema'] })
    const database = object({ kind: 'database', name: 'db' })
    const wrong = [['cursor', 'The cursor is not for this node.']]
    expect(childrenParamsProblems(children(database, { cursor: 'v1.schemas.AQ' }), listing)).toEqual([])
    expect(childrenParamsProblems(children(database), listing)).toEqual([])
    expect(childrenParamsProblems(children(database, { cursor: 'v1.users.AQ' }), listing)).toEqual(wrong)
    expect(childrenParamsProblems(children(database, { cursor: 'v1.schemas.AQ' }))).toEqual(wrong)
    expect(childrenParamsProblems(children(object({ kind: 'server' }), { cursor: 'v1.schemas.AQ' }), listing)).toEqual(wrong)
    // A folder's cursor still names the folder's own query, whatever its owner lists.
    expect(childrenParamsProblems(children({ type: 'folder', owner: { kind: 'database', name: 'db' }, folder: 'tables' }, { cursor: 'v1.schemas.AQ' }), listing)).toEqual(wrong)
    // A folder without a query of its own takes no cursor, not even its owner's.
    expect(childrenParamsProblems(children({ type: 'folder', owner: { kind: 'database', name: 'db' }, folder: 'programmability' }, { cursor: 'v1.schemas.AQ' }), listing)).toEqual(wrong)
    const logins = variant('server', { list: 'logins', rows: ['login'] })
    expect(childrenParamsProblems(children({ type: 'folder', owner: { kind: 'server' }, folder: 'serverSecurity' }, { cursor: 'v1.logins.AQ' }), logins)).toEqual(wrong)
    expect(childrenParamsProblems(children({ type: 'folder', owner: { kind: 'server' }, folder: 'logins' }, { cursor: 'v1.logins.AQ' }), logins)).toEqual([])
    expect(childrenParamsProblems(children(database, { filter: { name: { op: 'contains', value: 'x' } } }), listing)).toEqual([['filter', 'This folder cannot be filtered by name.']])
    rejects(explorerChildrenParamsSchema, params(database, { cursor: 'v1.schemas.AQ' }))
  })
  it('accepts filters with the folder\'s properties and valid values only', () => {
    accepts(explorerChildrenParamsSchema, params(tables, { filter: { name: { op: 'contains', value: 'Ord' } } }))
    accepts(explorerChildrenParamsSchema, params(tables, { filter: { name: { op: 'equals', value: 'x'.repeat(128) }, schema: { op: 'notContains', value: '%' }, owner: { op: 'equals', value: 'dbo' },
      created: { op: 'between', value: '2024-01-01', value2: '2024-01-01' } } }))
    const databases: ExplorerNodeRef = { type: 'folder', owner: { kind: 'server' }, folder: 'databases' }
    accepts(explorerChildrenParamsSchema, params(databases, { filter: { owner: { op: 'contains', value: 'sa' } } }))
    rejects(explorerChildrenParamsSchema, params(databases, { filter: { schema: { op: 'contains', value: 'dbo' } } }))
    rejects(explorerChildrenParamsSchema, params({ type: 'folder', owner: { kind: 'server' }, folder: 'systemDatabases' }, { filter: { name: { op: 'contains', value: 'm' } } }))
    rejects(explorerChildrenParamsSchema, params({ type: 'folder', owner: { kind: 'server' }, folder: 'serverSecurity' }, { filter: { name: { op: 'contains', value: 'm' } } }))
    rejects(explorerChildrenParamsSchema, params(object({ kind: 'database', name: 'db' }), { filter: { name: { op: 'contains', value: 'm' } } }))
    rejects(explorerChildrenParamsSchema, params(tables, { filter: {} }))
    rejects(explorerChildrenParamsSchema, params(tables, { filter: { name: { op: 'contains', value: '' } } }))
    rejects(explorerChildrenParamsSchema, params(tables, { filter: { name: { op: 'contains', value: 'x'.repeat(129) } } }))
    rejects(explorerChildrenParamsSchema, params(tables, { filter: { name: { op: 'contains', value: '\u{1D49C}'.repeat(64) + 'a' } } }))
    rejects(explorerChildrenParamsSchema, params(tables, { filter: { name: { op: 'like', value: 'x' } } }))
    rejects(explorerChildrenParamsSchema, params(tables, { filter: { name: { op: 'contains', value: 'x', extra: 1 } } }))
    rejects(explorerChildrenParamsSchema, params(tables, { filter: { type: { op: 'contains', value: 'x' } } }))
  })
  it('accepts creation dates from 1753 to 9999, with a second date exactly for ranges', () => {
    const created = (value: Record<string, unknown>) => ({ created: value })
    for (const op of ['equals', 'lessThan', 'lessOrEqual', 'greaterThan', 'greaterOrEqual']) {
      accepts(explorerFilterSchema, created({ op, value: '2024-02-29' }))
      rejects(explorerFilterSchema, created({ op, value: '2024-02-29', value2: '2024-03-01' }))
    }
    for (const op of ['between', 'notBetween']) {
      accepts(explorerFilterSchema, created({ op, value: '1753-01-01', value2: '9999-12-31' }))
      rejects(explorerFilterSchema, created({ op, value: '2024-01-01' }))
      rejects(explorerFilterSchema, created({ op, value: '2024-01-02', value2: '2024-01-01' }))
    }
    for (const value of ['2023-02-29', '2024-13-01', '2024-04-31', '1752-12-31', '10000-01-01', '2024-1-01', '2024-01-01T00:00', '', '20240101', '0000-01-01']) {
      rejects(explorerFilterSchema, created({ op: 'equals', value }))
    }
    rejects(explorerFilterSchema, created({ op: 'before', value: '2024-01-01' }))
  })
  it('accepts 1 to 256 unique request ids to cancel', () => {
    accepts(explorerCancelParamsSchema, { requestIds: [randomUUID()] })
    accepts(explorerCancelParamsSchema, { requestIds: Array.from({ length: 256 }, () => randomUUID()) })
    rejects(explorerCancelParamsSchema, { requestIds: Array.from({ length: 257 }, () => randomUUID()) })
    rejects(explorerCancelParamsSchema, { requestIds: [] })
    const id = randomUUID()
    rejects(explorerCancelParamsSchema, { requestIds: [id, id] })
    rejects(explorerCancelParamsSchema, { requestIds: ['not-a-uuid'] })
    rejects(explorerCancelParamsSchema, { requestIds: [randomUUID()], extra: true })
  })
})
