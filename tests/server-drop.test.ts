// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { dropVerdict, ServerDropService, verdicts, type ServerDrag } from '../src/renderer/src/editor-groups/server-drop'
import ServerDropLayer, { placeOf } from '../src/renderer/src/editor-groups/ServerDropLayer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(fn => fn())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const drag: ServerDrag = { connectionId: 'reporting', label: 'REPORTING-SQL', server: 'REPORTING-SQL' }
const databaseDrag: ServerDrag = { ...drag, database: 'AppData', label: 'AppData' }
const rect = { left: 10, top: 10, width: 80, height: 24 }
const idle = { running: false, live: true, busy: false }

interface Doc { id: string; name: string; kind?: string; connectionId?: string; database: string }
function setup(options: { running?: boolean; cancel?: boolean; live?: boolean } = {}) {
  const docs = new Map<string, Doc>([['q1', { id: 'q1', name: 'Orders.sql', connectionId: 'sales', database: 'Sales' }], ['am', { id: 'am', name: 'Activity Monitor', kind: 'activityMonitor', connectionId: 'sales', database: 'master' }]])
  const connections = new Map([['sales', { id: 'sales', server: 'SALES', database: 'master' }], ['reporting', { id: 'reporting', server: 'REPORTING-SQL', database: 'master', ...options.live === false ? { lost: true } : {} }]])
  const documents = {
    get: (id: string) => docs.get(id),
    activate: vi.fn(),
    newQuery: vi.fn(),
    getSnapshot: () => ({ busy: false })
  }
  const targets = {
    changeConnection: vi.fn(async (id: string, connectionId?: string) => { if (!options.cancel) docs.set(id, { ...docs.get(id)!, connectionId, database: 'master' }) }),
    changeDatabase: vi.fn((id: string, database: string) => { docs.set(id, { ...docs.get(id)!, database }) })
  }
  const service = new ServerDropService({ documents, queries: { isRunning: () => !!options.running }, targets, connections: { get: (id: string) => connections.get(id) } } as never)
  return { service, docs, documents, targets }
}

describe('dropVerdict', () => {
  it('moves a query on another server, and refuses the rest with the reason the card shows', () => {
    const query = { connectionId: 'sales', database: 'Sales' }
    expect(dropVerdict(query, drag, idle)).toBe(verdicts.move)
    expect(dropVerdict({ ...query, kind: 'activityMonitor' } as never, drag, idle)).toBe(verdicts.notQuery)
    expect(dropVerdict(undefined, drag, idle)).toBe(verdicts.notQuery)
    expect(dropVerdict(query, drag, { ...idle, running: true })).toBe(verdicts.running)
    expect(dropVerdict(query, drag, { ...idle, live: false })).toBe(verdicts.disconnected)
    expect(dropVerdict(query, drag, { ...idle, busy: true })).toBe(verdicts.busy)
    expect(dropVerdict({ connectionId: 'reporting', database: 'master' }, drag, idle)).toBe(verdicts.same)
  })
  it('changes only the database when a database row on the query\'s own server is dropped', () => {
    expect(dropVerdict({ connectionId: 'reporting', database: 'master' }, databaseDrag, idle)).toBe(verdicts.database)
    expect(dropVerdict({ connectionId: 'reporting', database: 'AppData' }, databaseDrag, idle)).toBe(verdicts.same)
    expect(dropVerdict({ connectionId: 'sales', database: 'Sales' }, databaseDrag, idle)).toBe(verdicts.move)
  })
  it('enforces the 32-target cap against enabled targets and matches detached targets by dragTargetId', () => {
    const thirtyOneEnabled = Array.from({ length: 31 }, (_, i) => ({
      connectionId: `sql-${i}`, provider: 'sqlserver' as const, database: 'master', enabled: true
    }))
    const withOneDisabled = {
      database: '',
      multiMode: 'same' as const,
      multiTargets: [
        ...thirtyOneEnabled,
        { connectionId: 'sql-disabled', provider: 'sqlserver' as const, database: 'master', enabled: false }
      ]
    }
    // 31 enabled + 1 disabled = 32 stored entries: still accepts adding a 32nd enabled target.
    expect(dropVerdict(withOneDisabled, drag, idle, { dragProvider: 'sqlserver' })).toBe(verdicts.addTarget)

    // 32 enabled entries: refuses a brand-new target, but allows re-attaching an already-enabled detached target via dragTargetId.
    const thirtyTwoEnabled = {
      database: '',
      multiMode: 'same' as const,
      multiTargets: [
        ...thirtyOneEnabled,
        { targetId: 'target-rep', provider: 'sqlserver' as const, database: 'master', enabled: true }
      ]
    }
    expect(dropVerdict(thirtyTwoEnabled, drag, idle, { dragProvider: 'sqlserver' })).toBe(verdicts.targetLimit)
    expect(dropVerdict(thirtyTwoEnabled, drag, idle, { dragProvider: 'sqlserver', dragTargetId: 'target-rep' })).toBe(verdicts.addTarget)
  })
})

describe('ServerDropService', () => {
  it('moves the query through Change Connection, then plays the landing once it has arrived', async () => {
    const { service, targets, documents } = setup()
    service.start(drag)
    const moved = service.moveQuery('q1', rect)
    expect(service.getSnapshot()).toMatchObject({ landing: { tabId: 'q1', arrived: false, label: 'REPORTING-SQL' } })
    expect(service.getSnapshot().drag).toBeUndefined()
    expect(await moved).toBe(true)
    expect(targets.changeConnection).toHaveBeenCalledWith('q1', 'reporting')
    expect(targets.changeDatabase).not.toHaveBeenCalled()
    expect(documents.activate).toHaveBeenCalledWith('q1')
    const landing = service.getSnapshot().landing!
    expect(landing.arrived).toBe(true)
    service.finishLanding(landing.seq)
    expect(service.getSnapshot().landing).toBeUndefined()
  })
  it('moves to a database row\'s server and then its database', async () => {
    const { service, targets, docs } = setup()
    service.start(databaseDrag)
    expect(await service.moveQuery('q1', rect)).toBe(true)
    expect(targets.changeConnection).toHaveBeenCalledWith('q1', 'reporting')
    expect(targets.changeDatabase).toHaveBeenCalledWith('q1', 'AppData')
    expect(docs.get('q1')).toMatchObject({ connectionId: 'reporting', database: 'AppData' })
  })
  it('drops the landing when the transaction prompt is cancelled', async () => {
    const { service, documents } = setup({ cancel: true })
    service.start(drag)
    expect(await service.moveQuery('q1', rect)).toBe(false)
    expect(service.getSnapshot().landing).toBeUndefined()
    expect(documents.activate).not.toHaveBeenCalled()
  })
  it('never moves a running query, a non-query, or onto a lost server', async () => {
    for (const [options, tab] of [[{ running: true }, 'q1'], [{}, 'am'], [{ live: false }, 'q1']] as const) {
      const { service, targets } = setup(options)
      service.start(drag)
      expect(await service.moveQuery(tab, rect)).toBe(false)
      expect(targets.changeConnection).not.toHaveBeenCalled()
      expect(service.getSnapshot()).toEqual({})
    }
  })
  it('opens a new query on the server, in the database a database row names', () => {
    const { service, documents } = setup()
    service.start(drag)
    expect(service.openQuery()).toBe(true)
    service.start(databaseDrag)
    expect(service.openQuery()).toBe(true)
    expect(documents.newQuery.mock.calls).toEqual([['', undefined, 'reporting', 'master'], ['', undefined, 'reporting', 'AppData']])
    expect(service.getSnapshot()).toEqual({})
  })
  it('publishes a hover only when it changes, and ignores hovers without a drag', () => {
    const { service } = setup()
    const listener = vi.fn()
    service.subscribe(listener)
    service.hover({ place: 'tab', tabId: 'q1', verdict: verdicts.move, insert: false, rect })
    expect(listener).not.toHaveBeenCalled()
    service.start(drag)
    service.hover({ place: 'tab', tabId: 'q1', verdict: service.verdict('q1'), insert: false, rect })
    service.hover({ place: 'tab', tabId: 'q1', verdict: service.verdict('q1'), insert: false, rect: { ...rect } })
    service.hover({ place: 'editor', tabId: 'q1', verdict: service.verdict('q1'), insert: true, rect })
    expect(listener).toHaveBeenCalledTimes(3)
  })
  it('prunes a disabled multi-target slot when adding past 32 stored entries and re-attaches detached targets by targetId', async () => {
    const thirtyOne = Array.from({ length: 31 }, (_, i) => ({
      connectionId: `sql-${i}`, provider: 'sqlserver' as const, database: 'master', enabled: true
    }))
    let multiTargets: { connectionId?: string; targetId?: string; attachWanted?: boolean; provider: 'sqlserver' | 'bigquery'; database: string; enabled: boolean }[] = [
      ...thirtyOne,
      { connectionId: 'sql-old-disabled', provider: 'sqlserver', database: 'master', enabled: false }
    ]
    const connections = new Map([
      ['reporting', { id: 'reporting', targetId: 'target-rep', server: 'REPORTING-SQL', database: 'Sales' }]
    ])
    const documents = {
      get: (id: string) => id === 'm1' ? { id: 'm1', name: 'Multi.sql', database: '', multiMode: 'same' as const, multiTargets } : undefined,
      activate: vi.fn(),
      newQuery: vi.fn(),
      getSnapshot: () => ({ busy: false }),
      setMultiTargets: vi.fn((_id: string, next: typeof multiTargets) => { multiTargets = next }),
      updateMultiTarget: vi.fn((_id: string, index: number, patch: (item: typeof multiTargets[number]) => typeof multiTargets[number]) => {
        multiTargets = multiTargets.map((item, i) => i === index ? patch(item) : item)
      })
    }
    const targets = {
      changeConnection: vi.fn(),
      changeDatabase: vi.fn(),
      targetForConnection: (id: string) => connections.get(id)?.targetId
    }
    const service = new ServerDropService({ documents, queries: { isRunning: () => false }, targets, connections: { get: (id: string) => connections.get(id) } } as never)

    service.start(drag)
    expect(service.verdict('m1')).toBe(verdicts.addTarget)
    expect(await service.moveQuery('m1', rect)).toBe(true)
    expect(multiTargets).toHaveLength(32)
    expect(multiTargets.some(t => t.connectionId === 'sql-old-disabled')).toBe(false)
    expect(multiTargets.at(-1)).toMatchObject({ connectionId: 'reporting', targetId: 'target-rep', attachWanted: true, enabled: true, database: 'Sales' })

    // Now detach 'reporting' (leaving 32 enabled targets) and drop again: verdict + moveQuery match by targetId identically.
    multiTargets = multiTargets.map(t => t.targetId === 'target-rep' ? { targetId: 'target-rep', provider: 'sqlserver', database: 'Sales', enabled: true } : t)
    service.start(databaseDrag)
    expect(service.verdict('m1')).toBe(verdicts.addTarget)
    expect(await service.moveQuery('m1', rect)).toBe(true)
    expect(multiTargets).toHaveLength(32)
    expect(multiTargets.find(t => t.targetId === 'target-rep')).toMatchObject({ connectionId: 'reporting', attachWanted: true, enabled: true, database: 'AppData' })
  })
})

describe('placeOf', () => {
  it('finds the tab, the strip\'s empty space and the query editor under a drag', () => {
    document.body.innerHTML = `<div id="root"><div class="dv-tabs-and-actions-container"><div class="dv-tab"><div data-tab-id="q1"><span id="name">Orders</span></div></div><button id="more">⋯</button><span id="void"></span></div>
      <div class="editor-container" data-document-id="q1"><div id="line"></div></div><div id="other"></div></div><div id="outside"></div>`
    const root = document.getElementById('root')!, at = (id: string) => placeOf(root, document.getElementById(id))
    expect(at('name')).toMatchObject({ place: 'tab', tabId: 'q1' })
    expect(at('void')).toMatchObject({ place: 'strip' })
    expect(at('more')).toBeUndefined()
    expect(at('line')).toMatchObject({ place: 'editor', tabId: 'q1' })
    expect(at('other')).toBeUndefined()
    expect(at('outside')).toBeUndefined()
  })
})

describe('ServerDropLayer DropCard preview', () => {
  it('R5 D2 #1: previews existing multi-target database/dataset on addTarget by connectionId or targetId, while letting drag.database override', async () => {
    const connectionsStore = new SnapshotStore([
      { id: 'sql-1', targetId: 'target-sql-1', server: 'SQL-01', database: 'master', options: {} },
      { id: 'sql-2', targetId: 'target-sql-2', server: 'SQL-02', database: 'SalesDefault', options: {} },
      { id: 'bq-1', targetId: 'target-bq-1', providerId: 'bigquery', server: 'bq-proj', database: 'analytics_default', options: { provider: 'bigquery' } }
    ])
    const docs = new Map([
      ['m1', {
        id: 'm1',
        name: 'Multi.sql',
        database: '',
        multiMode: 'cross' as const,
        multiTargets: [
          { connectionId: 'sql-1', targetId: 'target-sql-1', provider: 'sqlserver' as const, database: 'BillingDB', enabled: false },
          { targetId: 'target-sql-2', provider: 'sqlserver' as const, database: 'ArchiveDB', enabled: true },
          { targetId: 'target-bq-1', provider: 'bigquery' as const, database: '', enabled: false }
        ]
      }]
    ])
    class TestDropStore<T> extends SnapshotStore<T> {
      set(next: T) { this.publish(next) }
    }
    const serverDrop = new TestDropStore<{
      drag?: ServerDrag
      hover?: { place: 'tab'; tabId: string; verdict: typeof verdicts.addTarget; insert: boolean; rect: typeof rect }
    }>({})
    const workbench = {
      serverDrop,
      documents: { get: (id: string) => docs.get(id) },
      connections: connectionsStore,
      gestures: { modifiers: () => '', phrase: () => '' }
    } as unknown as Workbench

    const areaRoot = document.body.appendChild(document.createElement('div'))
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.push(() => { act(() => root.unmount()); host.remove(); areaRoot.remove() })
    await act(async () => {
      root.render(createElement(WorkbenchProvider, { workbench, children: createElement(ServerDropLayer, { root: areaRoot }) }))
    })

    const hoverWith = async (nextDrag: ServerDrag) => {
      await act(async () => {
        serverDrop.set({
          drag: nextDrag,
          hover: { place: 'tab', tabId: 'm1', verdict: verdicts.addTarget, insert: false, rect }
        })
      })
      return document.body.querySelector<HTMLElement>('.server-drop-card .server-drop-note')!.textContent
    }

    // 1. Existing disabled entry matched by connectionId -> previews preserved 'BillingDB' instead of connection's 'master'.
    expect(await hoverWith({ connectionId: 'sql-1', label: 'SQL-01', server: 'SQL-01' })).toContain('Database: BillingDB.')

    // 2. Existing detached entry matched by to.targetId -> previews preserved 'ArchiveDB' instead of connection's 'SalesDefault'.
    expect(await hoverWith({ connectionId: 'sql-2', label: 'SQL-02', server: 'SQL-02' })).toContain('Database: ArchiveDB.')

    // 3. Explicit drag.database overrides existing entry's database.
    expect(await hoverWith({ connectionId: 'sql-1', database: 'AppData', label: 'AppData', server: 'SQL-01' })).toContain('Database: AppData.')

    // 4. Existing BigQuery entry with empty dataset ('') preserves 'none' instead of connection's 'analytics_default'.
    expect(await hoverWith({ connectionId: 'bq-1', label: 'bq-proj', server: 'bq-proj' })).toContain('Default dataset: none.')
  })

  it('R6 #2: insert-modifier hint says "add this target instead" on multi-server tabs and "move the query instead" on single-server tabs', async () => {
    const connectionsStore = new SnapshotStore([
      { id: 'sql-1', targetId: 'target-sql-1', server: 'SQL-01', database: 'master', options: {} }
    ])
    const docs = new Map([
      ['m1', { id: 'm1', name: 'Multi.sql', database: '', multiMode: 'same' as const, multiTargets: [] }],
      ['s1', { id: 's1', name: 'Single.sql', database: 'master' }]
    ])
    class TestDropStore<T> extends SnapshotStore<T> {
      set(next: T) { this.publish(next) }
    }
    const serverDrop = new TestDropStore<{
      drag?: ServerDrag
      hover?: { place: 'editor'; tabId: string; verdict: typeof verdicts.addTarget | typeof verdicts.move; insert: boolean; rect: typeof rect }
    }>({})
    const workbench = {
      serverDrop,
      documents: { get: (id: string) => docs.get(id) },
      connections: connectionsStore,
      gestures: { modifiers: () => '', phrase: () => '' }
    } as unknown as Workbench

    const areaRoot = document.body.appendChild(document.createElement('div'))
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.push(() => { act(() => root.unmount()); host.remove(); areaRoot.remove() })
    await act(async () => {
      root.render(createElement(WorkbenchProvider, { workbench, children: createElement(ServerDropLayer, { root: areaRoot }) }))
    })

    const drag: ServerDrag = { connectionId: 'sql-1', label: 'SQL-01', server: 'SQL-01' }
    await act(async () => {
      serverDrop.set({ drag, hover: { place: 'editor', tabId: 'm1', verdict: verdicts.addTarget, insert: true, rect } })
    })
    expect(document.body.querySelector('.server-drop-insert .server-drop-card')?.textContent)
      .toBe('Insert the name at the caret · release the key to add this target instead')

    await act(async () => {
      serverDrop.set({ drag, hover: { place: 'editor', tabId: 's1', verdict: verdicts.move, insert: true, rect } })
    })
    expect(document.body.querySelector('.server-drop-insert .server-drop-card')?.textContent)
      .toBe('Insert the name at the caret · release the key to move the query instead')
  })
})
