// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { dropVerdict, ServerDropService, verdicts, type ServerDrag } from '../src/renderer/src/editor-groups/server-drop'
import { placeOf } from '../src/renderer/src/editor-groups/ServerDropLayer'

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
