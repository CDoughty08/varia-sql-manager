import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, QueryOptions, QueryResult, TableColumns } from '../src/shared/contracts'
import { peekLimits, type PeekResult } from '../src/shared/explorer/peek'
import { selectTopRowsScript } from '../src/shared/sql/identifiers'
import type { ScriptingOptions } from '../src/shared/scripting/options'
import { PeekService, peekMessages } from '../src/renderer/src/explorer/PeekService'
import { PeekTabService, peekTabName } from '../src/renderer/src/explorer/PeekTabService'
import { explorerContribution } from '../src/renderer/src/contributions/explorer'
import { focusFacts } from '../src/renderer/src/core/contextkeys'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { fakeResults, summary } from './fixtures/peek-results'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { contextRecord } from '../src/shared/commands/context-keys'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'

const connectionId = '11111111-1111-4111-8111-111111111111'
const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const node = (kind: 'table' | 'view' | 'procedure', id = 1, name = 'Customer'): ExplorerMenuNode => ({
  id, connectionId, kind, label: name, lost: false, ref: { type: 'object', object: { kind, database: 'Sales', schema: 'dbo', name } }
})

function setup(options: { columns?: ApiResult<TableColumns> } = {}) {
  const results = fakeResults()
  const executes: { options: QueryOptions; resolve: (value: ApiResult<QueryResult>) => void }[] = []
  let columns: (value: ApiResult<TableColumns>) => void = () => {}
  const api = {
    explorerPeek: vi.fn(() => new Promise<ApiResult<PeekResult>>(() => {})),
    explorerPeekDependencies: vi.fn(() => new Promise<never>(() => {})),
    explorerChildren: vi.fn(() => new Promise<never>(() => {})),
    explorerCancel: vi.fn(async () => ok({ cancelled: 1 })),
    scriptObjects: vi.fn(() => new Promise<never>(() => {})),
    cancelScripting: vi.fn(async () => ok({ cancelled: 1 })),
    writeClipboardText: vi.fn(async () => ok(undefined)),
    tableColumns: vi.fn(() => options.columns ? Promise.resolve(options.columns) : new Promise<ApiResult<TableColumns>>(resolve => { columns = resolve })),
    execute: vi.fn((query: QueryOptions) => new Promise<ApiResult<QueryResult>>(resolve => { executes.push({ options: query, resolve }) })),
    closeQuerySession: vi.fn(async () => ok({ closed: true }))
  }
  let live: { id: string; lost?: boolean }[] = [{ id: connectionId }]
  const listeners = new Set<() => void>()
  const connections = { getSnapshot: () => live, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  let ids = 0
  const service = new PeekService({
    api: api as never, connections, scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
    timers: { setTimeout: () => 1, clearTimeout: () => {} }, newId: () => `id-${++ids}`, results
  })
  return {
    service, api, results, executes, columns: (value: ApiResult<TableColumns>) => columns(value),
    lose: () => { live = []; for (const listener of [...listeners]) listener() },
    reconnect: (id = connectionId) => { live = [{ id }]; for (const listener of [...listeners]) listener() }
  }
}

describe('Peek Top rows on the results grid', () => {
  it('runs Select Top N Rows\' script with N = peekLimits.rows in a session and results entry of its own, and closes the session once the run settles', async () => {
    const { service, api, results, executes, columns } = setup()
    service.peek(node('table'), 'menu')
    service.selectTab('rows')
    // The run's entry is followed before anything is sent; the script waits for the columns.
    const key = 'id-3', queryId = 'id-4'
    expect(results.held()).toEqual([key])
    expect(service.getSnapshot().open?.rows).toEqual({ status: 'loading' })
    expect(api.tableColumns).toHaveBeenCalledWith(connectionId, 'Sales', 'dbo', 'Customer')
    columns(ok({ columns: [{ name: 'Id', dataType: 'int' }, { name: 'Name', dataType: 'nvarchar' }], truncated: false }))
    await flush()
    expect(executes).toHaveLength(1)
    expect(executes[0]!.options).toEqual({
      connectionId, sessionId: key, database: 'Sales', queryId, maxRows: peekLimits.rows, maxResultSets: 1, timeoutSeconds: Math.ceil(peekLimits.budgetMs / 1000),
      sql: selectTopRowsScript({ database: 'Sales', schema: 'dbo', name: 'Customer', columns: [{ name: 'Id' }, { name: 'Name' }], truncated: false }, 10)
    })
    expect(executes[0]!.options.sql).toContain('SELECT TOP (10) [Id]')
    expect(api.closeQuerySession).not.toHaveBeenCalled()
    executes[0]!.resolve(ok(summary(key)))
    await flush()
    expect(api.closeQuerySession).toHaveBeenCalledWith(key)
    expect(service.getSnapshot().open?.rows).toEqual({ status: 'ready', value: { key } })
    // The session closed, the results stay until the view lets them go.
    expect(results.held()).toEqual([key])
    expect(results.released).toEqual([])
  })

  it('selects * when the columns cannot be listed, as Select Top 1000 Rows does with a cut list', async () => {
    const { service, executes } = setup({ columns: { ok: false, error: 'denied' } })
    service.peek(node('view'), 'menu')
    service.selectTab('rows')
    await flush()
    expect(executes[0]!.options.sql).toBe(selectTopRowsScript({ database: 'Sales', schema: 'dbo', name: 'Customer', columns: [], truncated: true }, peekLimits.rows))
  })

  it('releases its rows when the card closes, refreshes or shows another object, and a run still going is stopped by closing its session', async () => {
    const { service, api, results, executes } = setup({ columns: ok({ columns: [], truncated: false }) })
    service.peek(node('table'), 'menu')
    service.selectTab('rows')
    await flush()
    // Closed while the script runs: the session closes (which cancels it in the backend) and the entry goes at once.
    service.close()
    expect(api.closeQuerySession).toHaveBeenCalledWith('id-3')
    expect(results.released).toEqual(['id-3'])
    expect(results.held()).toEqual([])
    // Its late summary frees the sets it describes, since nothing shows them, and the closed card stays closed.
    executes[0]!.resolve(ok(summary('id-3', 1, 41)))
    await flush()
    expect(results.orphanSets).toEqual([41])
    expect(service.getSnapshot().open).toBeUndefined()
    expect(api.closeQuerySession).toHaveBeenCalledTimes(1)

    service.peek(node('table'), 'menu')
    service.selectTab('rows')
    await flush()
    executes[1]!.resolve(ok(summary('x')))
    await flush()
    const first = (service.getSnapshot().open?.rows as { value: { key: string } }).value.key
    service.refresh()
    expect(results.released).toContain(first)
    // Refresh keeps the tab, so it reads the rows again under a new key.
    await flush()
    expect(executes).toHaveLength(3)
    const second = executes[2]!.options.sessionId
    expect(second).not.toBe(first)
    executes[2]!.resolve(ok(summary('y')))
    await flush()
    service.peek(node('view', 2, 'Other'), 'menu')
    expect(results.released).toContain(second)
    expect(results.held()).toEqual([])
  })

  it('never opens a session when released while the columns are read, and keeps nothing for a run without a result set', async () => {
    const { service, api, results, executes, columns } = setup()
    service.peek(node('table'), 'menu')
    service.selectTab('rows')
    service.close()
    columns(ok({ columns: [], truncated: false }))
    await flush()
    expect(api.execute).not.toHaveBeenCalled()
    expect(api.closeQuerySession).not.toHaveBeenCalled()
    expect(results.held()).toEqual([])

    service.peek(node('table'), 'menu')
    service.selectTab('rows')
    columns(ok({ columns: [], truncated: false }))
    await flush()
    executes[0]!.resolve(ok({ ...summary('z', 0), status: 'failed', error: { code: 'SQL_ERROR', message: 'Invalid object name.', batchNumber: 1, iteration: 1 } }))
    await flush()
    expect(service.getSnapshot().open?.rows).toEqual({ status: 'error', message: 'Invalid object name.' })
    expect(results.held()).toEqual([])
    // Choosing the tab again after a failure runs it again.
    service.selectTab('rows')
    expect(service.getSnapshot().open?.rows).toEqual({ status: 'loading' })
    expect(results.held()).toHaveLength(1)
  })

  it('says why when the run fails outright, or no result store is wired', async () => {
    const { service, executes } = setup({ columns: ok({ columns: [], truncated: false }) })
    service.peek(node('table'), 'menu')
    service.selectTab('rows')
    await flush()
    executes[0]!.resolve({ ok: false, error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    await flush()
    expect(service.getSnapshot().open?.rows).toEqual({ status: 'error', message: 'The SQL backend stopped.' })
    const bare = new PeekService({ api: { explorerPeek: () => new Promise(() => {}), explorerCancel: async () => ok({ cancelled: 0 }), scriptObjects: () => new Promise(() => {}), cancelScripting: async () => ok({ cancelled: 0 }) } as never, connections: { getSnapshot: () => [{ id: connectionId }], subscribe: () => () => {} }, scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} } })
    bare.peek(node('table'), 'menu')
    bare.selectTab('rows')
    expect(bare.getSnapshot().open?.rows).toEqual({ status: 'error', message: peekMessages.rowsUnavailable })
  })

  it('closes the card and frees its rows when its server is lost; a tab keeps what it shows until Refresh on a live server', async () => {
    const { service, results, executes, lose, reconnect, api } = setup({ columns: ok({ columns: [], truncated: false }) })
    service.peek(node('table'), 'menu')
    service.selectTab('rows')
    await flush()
    executes[0]!.resolve(ok(summary('a')))
    await flush()
    const tab = service.createView()
    tab.show(node('table', 1), 'rows')
    await flush()
    executes[1]!.resolve(ok(summary('b')))
    await flush()
    expect(results.held()).toHaveLength(2)
    lose()
    expect(service.getSnapshot().open).toBeUndefined()
    expect(results.held()).toEqual([])
    expect(tab.getSnapshot().open).toMatchObject({ kind: 'table', tab: 'rows', rows: { status: 'error', message: peekMessages.notConnected }, facts: { status: 'error', message: peekMessages.notConnected } })
    expect(tab.connected).toBe(false)
    tab.refresh()
    expect(api.tableColumns).toHaveBeenCalledTimes(2)
    reconnect()
    tab.refresh()
    expect(tab.getSnapshot().open?.rows).toEqual({ status: 'loading' })
    tab.dispose()
    expect(results.held()).toEqual([])
  })
})

describe('Peek tabs (PeekTabService)', () => {
  function tabs() {
    const base = setup({ columns: ok({ columns: [], truncated: false }) })
    const opened: { id: string; kind: string; name: string; connectionId?: string; database: string }[] = []
    const providers: unknown[] = []
    const documents = {
      openCustom: vi.fn((kind: string, name: string, connectionId: string | undefined, database: string) => { const document = { id: `doc-${opened.length + 1}`, kind, name, connectionId, database }; opened.push(document); return document as never }),
      registerProvider: vi.fn((provider: unknown) => { providers.push(provider); return { dispose: () => { providers.splice(providers.indexOf(provider), 1) } } }),
      update: vi.fn((id: string, patch: Partial<{ name: string; connectionId: string }>) => { Object.assign(opened.find(document => document.id === id)!, patch); for (const listener of [...listeners]) listener() }),
      get: vi.fn((id: string) => opened.find(document => document.id === id) as never),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
    }
    const listeners = new Set<() => void>()
    const servers: Record<string, string> = { [connectionId]: 'Prod\SQL01' }
    const peekTabs = new PeekTabService({ peek: base.service, documents, connections: { get: id => servers[id] === undefined ? undefined : { server: servers[id]! } } })
    return { ...base, peekTabs, documents, opened, providers, servers, listeners }
  }

  it('opens the object in a tab of its own with a view that owns its reads and rows, and closing the tab releases them', async () => {
    const { peekTabs, documents, results, executes, providers, api } = tabs()
    expect(providers).toEqual([peekTabs])
    expect(peekTabs.open(node('procedure'))).toBe('doc-1')
    expect(documents.openCustom).toHaveBeenCalledWith('peek', 'dbo.Customer', connectionId, 'Sales')
    const id = peekTabs.open(node('table', 2, 'Orders'), 'rows')!
    const view = peekTabs.view(id)!
    expect(view.getSnapshot().open).toMatchObject({ kind: 'table', tab: 'rows' })
    await flush()
    executes[0]!.resolve(ok(summary('t')))
    await flush()
    expect(results.held()).toHaveLength(1)
    peekTabs.closed(id)
    expect(peekTabs.view(id)).toBeUndefined()
    expect(results.held()).toEqual([])
    expect(api.explorerCancel).toHaveBeenCalled()
    // Not saved, never in Save All, nothing to refuse a close.
    expect([peekTabs.inSaveAll, peekTabs.saves, peekTabs.canClose()]).toEqual([false, false, undefined])
    await expect(peekTabs.save()).resolves.toBe(false)
  })

  it('follows Reconnect to a new connection to the server it was opened on, and reads again there', async () => {
    const { peekTabs, documents, executes, lose, reconnect, servers, api, results } = tabs()
    const id = peekTabs.open(node('table'), 'rows')!
    const view = peekTabs.view(id)!
    view.follow({ name: 'vOrders', schema: 'dbo', kind: 'view' })
    view.selectTab('rows')
    await flush()
    executes[0]!.resolve(ok(summary('r')))
    await flush()
    lose()
    expect(view.connected).toBe(false)
    expect(results.held()).toEqual([])
    // Reconnect gives the server a new connection id; the document moves only to the server the tab was opened on.
    const next = '22222222-2222-4222-8222-222222222222'
    servers[next] = 'prod\sql01'
    expect([peekTabs.follows(id, 'PROD\SQL01 '), peekTabs.follows(id, 'Other')]).toEqual([true, false])
    reconnect(next)
    const peeks = api.explorerPeek.mock.calls.length
    documents.update(id, { connectionId: next })
    expect(view.connected).toBe(true)
    expect(view.getSnapshot().open).toMatchObject({ node: { connectionId: next, lost: false, label: 'dbo.vOrders' }, back: [{ node: { connectionId: next } }], rows: { status: 'loading' } })
    expect(api.explorerPeek.mock.calls.length).toBe(peeks + 1)
    expect((api.explorerPeek.mock.calls.at(-1) as unknown as [{ connectionId: string }])[0].connectionId).toBe(next)
    await flush()
    expect(executes.at(-1)!.options.connectionId).toBe(next)
    // A tab closed is forgotten: it no longer follows anything.
    peekTabs.closed(id)
    expect(peekTabs.follows(id, 'Prod\SQL01')).toBe(false)
  })

  it('refuses what Peek cannot describe, names the tab after a followed dependency, and lets every view go on dispose', () => {
    const { peekTabs, documents, providers, results } = tabs()
    expect(peekTabs.open({ ...node('table'), lost: true })).toBeUndefined()
    expect(peekTabs.open({ id: 9, connectionId, kind: 'folder', label: 'Tables', lost: false, ref: { type: 'folder', owner: { kind: 'database', name: 'Sales' }, folder: 'tables' } } as never)).toBeUndefined()
    const id = peekTabs.open(node('table'))!
    peekTabs.view(id)!.follow({ name: 'vOrders', schema: 'Sales', kind: 'view' })
    expect(documents.update).toHaveBeenCalledWith(id, { name: 'Sales.vOrders' })
    expect(peekTabName(node('view', 3, 'Totals'))).toBe('dbo.Totals')
    peekTabs.view(id)!.selectTab('rows')
    peekTabs.dispose()
    expect(providers).toEqual([])
    expect(results.held()).toEqual([])
  })

  it('Open Peek as Tab moves the open card to a tab on the tab it showed, and otherwise opens the node a menu or Ctrl+click names', () => {
    const { service, peekTabs } = tabs()
    const handlers = new Map<string, { when?: (args?: unknown) => boolean; run: (args?: unknown) => unknown }>()
    const commands = { register: (id: string, handler: { when?: (args?: unknown) => boolean; run: (args?: unknown) => unknown }) => { handlers.set(id, handler); return { dispose: () => {} } } }
    const selected = node('view', 5, 'Selected')
    explorerContribution({
      commands: commands as never, documents: { getSnapshot: () => ({ activeId: '' }) } as never, connections: { isLive: () => true, get: () => undefined } as never,
      explorer: { menuNode: () => selected, getSnapshot: () => ({ selected: 5 }) } as never, peek: service, peekTabs
    }, { writeClipboardText: async () => ok(undefined) })
    const open = handlers.get('explorer.openPeekTab')!
    service.peek(node('table', 1, 'Card'), 'menu')
    service.selectTab('dependencies')
    expect(open.when?.()).toBe(true)
    open.run()
    expect(service.getSnapshot().open).toBeUndefined()
    const first = Object.values(peekTabs.getSnapshot().views)[0]!
    expect(first.getSnapshot().open).toMatchObject({ kind: 'table', tab: 'dependencies', node: { label: 'Card' } })
    // With no card, the selection; with a target (a menu or a Ctrl+click), the target.
    open.run()
    open.run({ target: { kind: 'explorer', node: node('procedure', 6, 'Clicked') } })
    expect(Object.values(peekTabs.getSnapshot().views).map(view => view.getSnapshot().open?.node.label)).toEqual(['Card', 'Selected', 'Clicked'])
    expect(open.when?.({ target: { kind: 'explorer', node: { ...node('table'), lost: true } } })).toBe(false)
  })

  it("opens a tab by Ctrl+Enter in the tree or the card, but not in a search hit, which it would not name, nor in the card's grid", () => {
    const keys = commandDescriptor('explorer.openPeekTab').keybindings!.map(spec => compileWhen(spec.when!))
    const fires = (values: Parameters<typeof contextRecord>[1]) => keys.some(when => evaluateWhen(when, contextRecord('win32', values)))
    expect(fires({ activePanel: 'explorer', explorerFocus: true })).toBe(true)
    expect(fires({ peekFocus: true })).toBe(true)
    expect(fires({ activePanel: 'explorer', searchHitsFocus: true })).toBe(false)
    expect(fires({ peekFocus: true, outputGridFocus: true })).toBe(false)
    expect(fires({ activePanel: 'explorer', inputFocus: true, textInputFocus: true })).toBe(false)
  })

  it('marks focus in the card and in a Peek tab for their keys', () => {
    const element = (marks: string[]) => ({ matches: () => false, closest: (selector: string) => marks.includes(selector) ? { getAttribute: () => null } : null })
    expect(focusFacts(element(['[data-peek-card]']), undefined)).toMatchObject({ peekFocus: true, peekTabFocus: false })
    expect(focusFacts(element(['[data-peek-tab]']), undefined)).toMatchObject({ peekFocus: false, peekTabFocus: true })
  })
})
