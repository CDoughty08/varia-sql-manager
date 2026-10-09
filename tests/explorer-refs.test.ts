import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { folderIds, kindScopes, kindSpecs, nodeKinds, scopeFields, type KindScope, type NodeKind } from '../src/shared/explorer/catalog'
import { displayText, insertTextFor, kindScope, quoteName, refKey, type ExplorerNodeRef, type ObjectRef } from '../src/shared/explorer/refs'
import { explorerCancelParamsSchema, explorerChildrenParamsSchema, explorerFilterSchema, ident, nodeRefSchema, objectRefSchema } from '../src/shared/explorer/schema'

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
  }
}
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
      childUnnamed: ['returnValue']
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
  it('keys distinct refs apart, whatever their names hold', () => {
    const names = [']', '"', '\\', '\u0001', ',', 'null', '"null"', '["a","b"]', 'a', 'A', ' ', '😀', 'x'.repeat(128), 'dbo.Orders', 'dbo', 'Orders']
    const refs: ExplorerNodeRef[] = []
    for (const a of names) {
      refs.push(object({ kind: 'database', name: a }), { type: 'folder', owner: { kind: 'database', name: a }, folder: 'tables' }, { type: 'folder', owner: { kind: 'database', name: a }, folder: 'views' })
      for (const b of names) {
        refs.push(object({ kind: 'table', database: 'db', schema: a, name: b }), object({ kind: 'view', database: 'db', schema: a, name: b }), object({ kind: 'user', database: a, name: b }))
        refs.push(object({ kind: 'column', database: 'db', parent: { kind: 'table', schema: a, name: b }, name: 'c' }))
        refs.push(object({ kind: 'returnValue', database: a, parent: { kind: 'function', schema: 's', name: b } }))
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
