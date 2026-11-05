import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, ExplorerChildrenResult, ExplorerNode, VariaApi } from '../src/shared/contracts'
import { folderSpecs, kindSpecs, type FolderId } from '../src/shared/explorer/catalog'
import type { ExplorerChildrenParams, ObjectRef } from '../src/shared/explorer/refs'
import { explorerChildrenParamsSchema } from '../src/shared/explorer/schema'
import { EventBus } from '../src/renderer/src/core/events'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { ExplorerService } from '../src/renderer/src/explorer/ExplorerService'
import { revealPaths } from '../src/renderer/src/search/ObjectSearchService'
import { connectionInfo, connectionOptions } from './fixtures/workbench'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const connectionId = '10000000-0000-4000-8000-000000000061'
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const folder = (owner: ObjectRef, id: FolderId): ExplorerNode => ({ ref: { type: 'folder', owner: { ...owner }, folder: id }, label: folderSpecs[id].label, icon: 'folder', hasChildren: true })
const object = (value: ObjectRef, label: string, hasChildren = true): ExplorerNode => ({ ref: { type: 'object', object: value }, label, icon: kindSpecs[value.kind].icon, hasChildren })
const ok = (nodes: ExplorerNode[]): ApiResult<ExplorerChildrenResult> => ({ ok: true, value: { nodes, elapsedMs: 1, total: nodes.length } })

/**
 * A backend that groups as the real one does: AppData has dbo.Orders, hr.People and the database trigger audit. Grouped,
 * the database keeps Programmability (Database Triggers only) and lists its schemas; a schema row has Tables and
 * Programmability (Stored Procedures), and its Tables lists that schema's tables by name alone.
 */
function fakeBackend() {
  const tables = [['dbo', 'Orders'], ['hr', 'People']] as const
  const sent: ExplorerChildrenParams[] = []
  function respond(params: ExplorerChildrenParams): ApiResult<ExplorerChildrenResult> {
    const { node } = params
    if (node.type === 'object') {
      const value = node.object
      switch (value.kind) {
        case 'server': return ok([folder(value, 'databases')])
        case 'database': return ok(params.groupBySchema
          ? [folder(value, 'programmability'), ...['dbo', 'hr'].map(name => object({ kind: 'schema', database: value.name, name }, name))]
          : [folder(value, 'tables'), folder(value, 'programmability')])
        case 'schema': return ok([folder(value, 'tables'), folder(value, 'programmability')])
        default: return ok([])
      }
    }
    const owner = node.owner
    switch (node.folder) {
      case 'databases': return ok([object({ kind: 'database', name: 'AppData' }, 'AppData')])
      case 'tables': {
        const listed = tables.filter(([schema]) => owner.kind !== 'schema' || schema === owner.name)
        return ok(listed.map(([schema, name]) => object({ kind: 'table', database: 'AppData', schema, name }, owner.kind === 'schema' ? name : `${schema}.${name}`)))
      }
      case 'programmability': return ok(owner.kind === 'schema' ? [folder(owner, 'storedProcedures')]
        : params.groupBySchema ? [folder(owner, 'databaseTriggers')] : [folder(owner, 'storedProcedures'), folder(owner, 'databaseTriggers')])
      case 'databaseTriggers': return ok([object({ kind: 'databaseTrigger', database: 'AppData', name: 'audit' }, 'audit', false)])
      default: return ok([])
    }
  }
  const api = {
    explorerChildren: vi.fn<VariaApi['explorerChildren']>(async params => {
      sent.push(params)
      // Every request is one main would accept.
      expect.soft(explorerChildrenParamsSchema.safeParse(params).success, JSON.stringify(params)).toBe(true)
      return respond(params)
    }),
    explorerCancel: vi.fn<VariaApi['explorerCancel']>(async ids => ({ ok: true, value: { cancelled: ids.length } }))
  }
  return { api, sent }
}

const disposals: (() => void)[] = []
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()) })

function fixture(grouped = false) {
  const backend = fakeBackend()
  const connections = new ConnectionService()
  const setting = { value: grouped, listeners: new Set<() => void>() }
  const groupBySchema = { get: () => setting.value, subscribe: (listener: () => void) => { setting.listeners.add(listener); return () => setting.listeners.delete(listener) } }
  let ids = 0
  const explorer = new ExplorerService({ api: backend.api, connections, events: new EventBus(), schedule: callback => callback(), newId: () => uuid(++ids), groupBySchema })
  disposals.push(() => explorer.dispose())
  connections.add({ ...connectionInfo(connectionId, 1), server: 'a.example', productVersion: '16.0.4135.4', login: 'sa' }, connectionOptions)
  const toggle = (value: boolean) => { setting.value = value; for (const listener of setting.listeners) listener() }
  const rows = () => Array.from(explorer.getSnapshot().rows.ids).filter(id => id > 0)
  const labels = () => rows().map(id => '  '.repeat(explorer.node(id)!.level - 1) + explorer.node(id)!.label)
  const find = (label: string, under?: number) => {
    const below = (id: number) => { for (let node = explorer.node(id); node; node = explorer.node(node.parent)) if (node.id === under) return true; return false }
    const found = rows().filter(id => explorer.node(id)!.label === label && (under === undefined || below(id)))
    if (found.length !== 1) throw new Error(`${found.length} rows are labelled ${label}`)
    return found[0]
  }
  const open = async (...path: string[]) => {
    let under: number | undefined
    for (const label of path) { under = find(label, under); explorer.expand(under); await settle() }
    return under!
  }
  return { ...backend, explorer, toggle, labels, find, open }
}

describe('Object Explorer: Group by Schema', () => {
  it('asks a database and its own folders to group, never a schema row or the folders below it', async () => {
    const f = fixture(true)
    expect(f.explorer.groupBySchema).toBe(true)
    expect(f.explorer.context.getSnapshot().explorerGroupBySchema).toBe(true)
    await f.open('a.example', 'Databases', 'AppData', 'Programmability')
    await f.open('a.example', 'Databases', 'AppData', 'dbo', 'Tables')
    f.explorer.expand(f.find('Programmability', f.find('dbo')))
    await settle()
    expect(f.labels().slice(3)).toEqual(['      Programmability', '        Database Triggers', '      dbo', '        Tables', '          Orders', '        Programmability',
      '          Stored Procedures', '      hr'])
    const flagged = (params: ExplorerChildrenParams) => params.groupBySchema === true
    const at = (kind: string, folder?: FolderId) => f.sent.filter(params => (params.node.type === 'object' ? params.node.object.kind === kind && !folder
      : params.node.owner.kind === kind && params.node.folder === folder))
    expect(at('database').every(flagged) && at('database', 'programmability').every(flagged)).toBe(true)
    expect(at('database').length + at('database', 'programmability').length).toBe(2)
    expect([...at('schema'), ...at('schema', 'tables'), ...at('schema', 'programmability'), ...at('server'), ...at('server', 'databases')].some(flagged)).toBe(false)
    // The schema row's Tables offers every filter property of Tables but Schema, which the row already fixes.
    const tables = f.find('Tables', f.find('dbo'))
    expect(f.explorer.filterProperties(f.explorer.node(tables)!)).toEqual(['name', 'owner', 'created'])
    expect(() => f.explorer.setFilter(tables, { schema: { op: 'equals', value: 'hr' } })).toThrow('This folder cannot be filtered by that property.')
    f.explorer.setFilter(tables, { name: { op: 'contains', value: 'Ord' } })
    await settle()
    expect(f.sent.at(-1)).toMatchObject({ node: { type: 'folder', owner: { kind: 'schema', name: 'dbo' }, folder: 'tables' }, filter: { name: { op: 'contains', value: 'Ord' } } })
    expect(f.sent.at(-1)!.groupBySchema).toBeUndefined()
  })

  it('regroups every database that has listed its children when the setting changes, and back', async () => {
    const f = fixture()
    expect(f.explorer.context.getSnapshot().explorerGroupBySchema).toBe(false)
    await f.open('a.example', 'Databases', 'AppData', 'Tables')
    expect(f.labels().slice(3)).toEqual(['      Tables', '        dbo.Orders', '        hr.People', '      Programmability'])
    expect(f.sent.some(params => params.groupBySchema)).toBe(false)
    f.toggle(true)
    await settle()
    await settle()
    expect(f.explorer.context.getSnapshot().explorerGroupBySchema).toBe(true)
    expect(f.labels().slice(3)).toEqual(['      Programmability', '      dbo', '      hr'])
    expect(f.sent.at(-1)).toMatchObject({ node: { type: 'object', object: { kind: 'database', name: 'AppData' } }, groupBySchema: true })
    await f.open('a.example', 'Databases', 'AppData', 'hr', 'Tables')
    expect(f.labels().slice(6)).toEqual(['        Tables', '          People', '        Programmability'])
    // Off again: the database lists Tables again, and its Programmability folder its every subfolder.
    f.toggle(false)
    await settle()
    await settle()
    expect(f.explorer.context.getSnapshot().explorerGroupBySchema).toBe(false)
    expect(f.labels().slice(3)).toEqual(['      Tables', '      Programmability'])
    expect(f.sent.at(-1)!.groupBySchema).toBeUndefined()
  })

  it('reveals an object below its schema row, and a database-scoped one below the database', async () => {
    const f = fixture(true)
    await f.open('a.example')
    const people = await f.explorer.seek(connectionId, revealPaths({ object: { kind: 'table', database: 'AppData', schema: 'hr', name: 'People' }, folder: 'tables', label: 'hr.People' }, f.explorer.groupBySchema))
    expect(people.ok).toBe(true)
    expect(f.explorer.getSnapshot().selected).toBe(f.find('People'))
    expect(f.explorer.node(f.find('People'))!.parent).toBe(f.find('Tables', f.find('hr')))
    const audit = await f.explorer.seek(connectionId, revealPaths({ object: { kind: 'databaseTrigger', database: 'AppData', name: 'audit' }, folder: 'databaseTriggers', label: 'audit' }, f.explorer.groupBySchema))
    expect(audit.ok).toBe(true)
    expect(f.explorer.getSnapshot().selected).toBe(f.find('audit'))
    // The ungrouped path finds nothing while grouped: AppData has no Tables folder.
    const ungrouped = await f.explorer.seek(connectionId, revealPaths({ object: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }, folder: 'tables', label: 'dbo.Orders' }))
    expect(ungrouped.ok).toBe(false)
  })
})
