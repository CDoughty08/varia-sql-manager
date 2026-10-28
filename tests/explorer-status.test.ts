import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, ResultDescriptor } from '../src/shared/contracts'
import { statusChipKinds } from '../src/shared/explorer/catalog'
import { databaseChips, serverChips, statusChipDocs } from '../src/shared/explorer/status'
import { liveProbes, liveSources } from '../src/shared/live/catalog'
import type { LiveEnd, LiveEvent, LiveSubscribeParams, LiveTick } from '../src/shared/live/schema'
import { defaultSettings, type SettingsValues } from '../src/shared/settings/catalog'
import { ExplorerStatusService, onlineStatus, rowStatus } from '../src/renderer/src/explorer/ExplorerStatusService'
import { LiveService, liveServiceLimits, type PageVisibility } from '../src/renderer/src/live/LiveService'
import type { LivePatch, LiveStream, ResultHandle, RowWindow } from '../src/renderer/src/results/ResultClient'
import type { ResultKey } from '../src/renderer/src/results/worker-protocol'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { PaneService } from '../src/renderer/src/services/panes'
import type { ConnectionInfo } from '../src/shared/contracts'

describe('Object Explorer status chips', () => {
  const row = (fields: Partial<Parameters<typeof databaseChips>[0] & object> = {}) => ({ name: 'Sales', state: 0, userAccess: 0, readOnly: false, standby: false, ...fields })
  it('turns a database\'s state, read-only flag and user access into chips, with a running restore\'s progress', () => {
    expect(databaseChips(undefined)).toEqual([])
    expect(databaseChips(row())).toEqual([])
    expect(databaseChips(row({ state: 1 }), { name: 'Sales', command: 'RESTORE DATABASE', percent: 42.9 }).map(chip => [chip.label, chip.tone, chip.words])).toEqual([['RESTORING 42 %', 'running', 'Restoring 42 %']])
    expect(databaseChips(row({ state: 1 }))[0]).toMatchObject({ label: 'RESTORING', title: 'The database is being restored, or waits for more backups to restore (WITH NORECOVERY).' })
    expect(databaseChips(row({ state: 2 }), { name: 'Sales', command: 'DB STARTUP', percent: 7 })[0]).toMatchObject({ label: 'RECOVERING 7 %', title: 'The database is recovering. It comes online when recovery ends. DB STARTUP: 7 % done.' })
    expect(databaseChips(row({ state: 3 }))[0]).toMatchObject({ label: 'RECOVERY PENDING', tone: 'critical' })
    expect(databaseChips(row({ state: 4 }))[0]).toMatchObject({ label: 'SUSPECT', tone: 'critical' })
    expect(databaseChips(row({ state: 5 }))[0]).toMatchObject({ label: 'EMERGENCY', tone: 'critical' })
    expect(databaseChips(row({ state: 6 }))[0]).toMatchObject({ label: 'OFFLINE', tone: 'warning' })
    expect(databaseChips(row({ state: 10 }))[0]).toMatchObject({ label: 'OFFLINE', title: 'The database is an offline secondary.' })
    // A state SQL Server adds later says its number rather than nothing.
    expect(databaseChips(row({ state: 42 }))[0]).toMatchObject({ label: 'STATE 42', tone: 'neutral' })
    expect(databaseChips(row({ readOnly: true, userAccess: 1 })).map(chip => chip.label)).toEqual(['READ-ONLY', 'SINGLE USER'])
    expect(databaseChips(row({ readOnly: true, standby: true, userAccess: 2, state: 1 })).map(chip => chip.label)).toEqual(['RESTORING', 'STANDBY', 'RESTRICTED USER'])
    // Percentages stay within 0 to 100 and whole.
    expect(databaseChips(row({ state: 1 }), { name: 'Sales', command: 'RESTORE LOG', percent: 140 })[0].label).toBe('RESTORING 100 %')
  })
  it('gives the server a running-jobs chip and its availability groups\' health, the least healthy first', () => {
    expect(serverChips(undefined, undefined)).toEqual([])
    expect(serverChips(0, [])).toEqual([])
    expect(serverChips(null, undefined)).toEqual([])
    expect(serverChips(1, undefined)).toEqual([expect.objectContaining({ id: 'jobs', tone: 'running', label: '1 job running', words: 'SQL Server Agent: 1 job running' })])
    expect(serverChips(1200, undefined)[0].label).toBe('1,200 jobs running')
    expect(serverChips(undefined, [{ name: 'AG1', health: 2, role: 1 }])).toEqual([expect.objectContaining({ id: 'availability', tone: 'success', label: 'AG1 healthy', icon: 'pass', title: 'Availability groups\nAG1: healthy, primary' })])
    const mixed = serverChips(2, [{ name: 'AG1', health: 2, role: 1 }, { name: 'AG2', health: 1, role: 2 }, { name: 'AG3', health: 1, role: 0 }])
    expect(mixed.map(chip => [chip.label, chip.tone])).toEqual([['2 jobs running', 'running'], ['2 AGs partially healthy', 'warning']])
    expect(mixed[1].title).toBe('Availability groups\nAG1: healthy, primary\nAG2: partially healthy, secondary\nAG3: partially healthy, resolving')
    expect(serverChips(0, [{ name: 'AG1', health: 0, role: 2 }])[0]).toMatchObject({ label: 'AG1 not healthy', tone: 'critical' })
    const many = serverChips(0, Array.from({ length: 12 }, (_, at) => ({ name: 'AG' + at, health: 2, role: 1 })))[0]
    expect(many.label).toBe('12 AGs healthy')
    expect(many.title.split('\n')).toHaveLength(12)
    expect(many.title.endsWith('and 2 more')).toBe(true)
  })
  it('declares its kinds and probes in the explorer catalogue, from the explorer live source, and documents every chip', () => {
    expect(Object.keys(statusChipKinds)).toEqual(['server', 'database'])
    expect([...statusChipKinds.database, ...statusChipKinds.server].sort()).toEqual([...liveSources.explorer.probes].sort())
    for (const probe of liveSources.explorer.probes) expect(liveProbes[probe as keyof typeof liveProbes].source).toBe('explorer')
    expect(statusChipDocs.filter(doc => doc.kind === 'database').map(doc => doc.chip)).toEqual(['RESTORING n %', 'RECOVERING n %', 'RECOVERY PENDING', 'SUSPECT', 'EMERGENCY', 'OFFLINE', 'COPYING', 'READ-ONLY / STANDBY', 'SINGLE USER / RESTRICTED USER'])
  })
})

// The service against LiveService over a fake ResultClient: the test plays the backend (live.opened, ticks with tables
// whose rows the fake handles serve, ends), as tests/live-service.test.ts does.
interface FakeStream { params: LiveSubscribeParams; onEvent: (event: LiveEvent, bytes: number) => void; updates: LivePatch[]; cancelled: boolean; ended: boolean; end(result: ApiResult<LiveEnd>): void }
class FakeClient {
  readonly streams: FakeStream[] = []
  readonly rows = new Map<number, (string | null)[][]>()
  reads = 0
  live(params: LiveSubscribeParams, onEvent: (event: LiveEvent, bytes: number) => void): LiveStream {
    let settle!: (result: ApiResult<LiveEnd>) => void
    const done = new Promise<ApiResult<LiveEnd>>(resolve => { settle = resolve })
    const fake: FakeStream = {
      params: structuredClone(params), onEvent, updates: [], cancelled: false, ended: false,
      end: result => { if (!fake.ended) { fake.ended = true; settle(result) } }
    }
    this.streams.push(fake)
    return {
      subscriptionId: params.subscriptionId, done,
      update: patch => { fake.updates.push(structuredClone(patch)); return Promise.resolve({ ok: true, value: { applied: true, probes: [] } }) },
      cancel: () => { fake.cancelled = true; fake.end({ ok: true, value: { ended: 'cancelled', ticks: 0, elapsedMs: 0 } }) },
      ack: () => {}
    }
  }
  open(descriptor: ResultDescriptor): ResultHandle {
    const rows = this.rows.get(descriptor.resultId) ?? []
    return {
      key: { generation: descriptor.generation, resultId: descriptor.resultId }, columns: descriptor.columns, getSnapshot: () => ({ state: 'complete' }),
      getWindow: async (first: number, count: number): Promise<RowWindow> => {
        this.reads++
        const shown = rows.slice(first, first + count), columns = descriptor.columns.length
        return { first, count: shown.length, colStart: 0, colEnd: columns, text: shown.flatMap(cells => cells.map(cell => cell ?? '')), flags: Uint8Array.from(shown.flatMap(cells => cells.map(cell => cell === null ? 1 : 0))) }
      }
    } as unknown as ResultHandle
  }
  release(_keys: readonly ResultKey[]): Promise<void> { return Promise.resolve() }
}

let client: FakeClient
let live: LiveService
let connections: ConnectionService
let panes: PaneService
let settings: { getSnapshot(): { values: SettingsValues }; subscribe(listener: () => void): () => void; set(patch: Partial<SettingsValues>): void }
let status: ExplorerStatusService
let resultId = 1
let seq = 0
const first = '6f1e3a52-8a8b-4d63-9a43-2c1e1e0d7c11', second = '0b6f2f8e-0b0e-4f6a-9d61-6d8c2b7f1e22'
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const info = (id: string): ConnectionInfo => ({ id, server: 'srv-' + id.slice(0, 4), generation: 1 } as unknown as ConnectionInfo)

function columns(probe: 'explorer.databases' | 'explorer.progress' | 'explorer.availability') {
  return liveProbes[probe].tables![0].columns.map(column => ({ name: column.name, dataType: column.dataType, wire: 'text', nullable: true }))
}
/** A stored table revision holding `rows`. */
function table(probe: 'explorer.databases' | 'explorer.progress' | 'explorer.availability', rows: (string | null)[][], diff?: { added: number; removed: number; changed: number }) {
  const id = resultId++
  client.rows.set(id, rows)
  const descriptor = { generation: 1, resultId: id, columns: columns(probe), rowsStored: rows.length, rowsAvailable: rows.length, bytesStored: 1, truncatedCells: 0, state: 'complete', statement: 0 } as unknown as ResultDescriptor
  return { probe, costMs: 1, effectiveIntervalMs: 5000, tables: [{ table: 0, descriptor, revision: id, ...diff ? { diff } : {} }] }
}
const tick = (samples: unknown[], errors?: LiveTick['errors']): LiveTick => ({ type: 'live.tick', seq: ++seq, sampledAt: Date.now(), samples, ...errors ? { errors } : {} } as LiveTick)
function open(fake: FakeStream) {
  fake.onEvent({ type: 'live.opened', seq: 0, source: 'explorer', probes: fake.params.probes.map(probe => ({ probe: probe.probe, intervalMs: probe.intervalMs, minIntervalMs: 2000, maxIntervalMs: 300_000, state: 'ok' as const })) }, 10)
}
const streamOf = (connectionId: string) => client.streams.filter(stream => stream.params.connectionId === connectionId).at(-1)!

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-27T10:00:00Z') })
  client = new FakeClient()
  seq = 0
  let values: SettingsValues = { ...defaultSettings }
  const listeners = new Set<() => void>()
  settings = {
    getSnapshot: () => ({ values }), subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: patch => { values = { ...values, ...patch }; for (const listener of [...listeners]) listener() }
  }
  const page: PageVisibility = { hidden: () => false, subscribe: () => () => {} }
  live = new LiveService({ client, settings, page, schedule: callback => callback() })
  connections = new ConnectionService()
  panes = new PaneService()
  panes.set({ explorer: true, editor: true, output: false })
  status = new ExplorerStatusService({ live, connections, panes, settings, schedule: callback => callback() })
})
afterEach(() => { status.dispose(); live.dispose(); vi.useRealTimers() })

describe('ExplorerStatusService', () => {
  it('opens one background view of the explorer source per connected server, with every status probe', () => {
    connections.add(info(first), { server: 'a' } as never)
    connections.add(info(second), { server: 'b' } as never)
    expect(client.streams.map(stream => [stream.params.connectionId, stream.params.source, stream.params.probes.map(probe => [probe.probe, probe.intervalMs])])).toEqual([
      [first, 'explorer', [['explorer.databases', 5000], ['explorer.progress', 5000], ['explorer.agent', 10_000], ['explorer.availability', 10_000]]],
      [second, 'explorer', [['explorer.databases', 5000], ['explorer.progress', 5000], ['explorer.agent', 10_000], ['explorer.availability', 10_000]]]
    ])
    expect(live.getSnapshot().handles.map(handle => handle.ownerKey)).toEqual(['explorer:' + first, 'explorer:' + second])
    // Removing a server ends its view; a lost one ends too.
    connections.remove(second)
    expect(streamOf(second).cancelled).toBe(true)
    connections.markLostBefore(2)
    expect(streamOf(first).cancelled).toBe(true)
    expect(status.getSnapshot().servers.size).toBe(0)
  })

  it('shows chips from the probes\' rows only while they sample, and online for databases the probe does not list', async () => {
    connections.add(info(first), { server: 'a' } as never)
    const fake = streamOf(first)
    open(fake)
    expect(status.server(first)).toMatchObject({ server: undefined, databases: undefined })
    fake.onEvent(tick([
      table('explorer.databases', [['Archive', '0', '0', '1', '0'], ['Restored', '1', '0', '0', '0'], ['Solo', '0', '1', '0', '0']]),
      table('explorer.progress', [['Restored', 'RESTORE DATABASE', '42']]),
      { probe: 'explorer.agent', costMs: 1, effectiveIntervalMs: 10_000, metrics: [3] },
      table('explorer.availability', [['AG1', '2', '1']])
    ]), 10)
    await settle()
    const server = status.server(first)!
    expect(server.server?.chips.map(chip => chip.label)).toEqual(['3 jobs running', 'AG1 healthy'])
    expect(server.server?.words).toBe('SQL Server Agent: 3 jobs running, Availability groups: AG1 healthy')
    expect(server.databases?.get('Restored')).toMatchObject({ live: true, words: 'Restoring 42 %', state: 'unavailable' })
    expect(server.databases?.get('Archive')).toMatchObject({ words: 'Read-only', state: 'readOnly' })
    expect(server.databases?.get('Solo')?.state).toBeUndefined()
    const database = (name: string) => ({ parent: 3, kind: 'database' as const, ref: { type: 'object' as const, object: { kind: 'database' as const, name } } })
    expect(rowStatus(server, database('Sales'))).toBe(onlineStatus)
    expect(rowStatus(server, { parent: 0, kind: 'server', ref: { type: 'object', object: { kind: 'server' } } } as never)).toBe(server.server)
    expect(rowStatus(server, { parent: 9, kind: 'table', ref: { type: 'object', object: { kind: 'table', database: 'Sales', schema: 'dbo', name: 'T' } } } as never)).toBeUndefined()

    // An unchanged revision is not read again, and unchanged chips keep their objects (memoised rows do not render).
    const reads = client.reads, before = status.server(first)!
    fake.onEvent(tick([table('explorer.databases', [], { added: 0, removed: 0, changed: 0 })]), 10)
    await settle()
    expect(client.reads).toBe(reads)
    expect(status.server(first)!.databases).toBe(before.databases)
    expect(status.server(first)!.server).toBe(before.server)
    // The restore finished: only its row changes.
    fake.onEvent(tick([table('explorer.databases', [['Archive', '0', '0', '1', '0'], ['Solo', '0', '1', '0', '0']]), table('explorer.progress', [])]), 10)
    await settle()
    const after = status.server(first)!.databases!
    expect(after.get('Restored')).toBeUndefined()
    expect(after.get('Archive')).toBe(before.databases!.get('Archive'))

    // A probe that fails says nothing (its rows show again with its next sample); the others carry on.
    fake.onEvent(tick([{ probe: 'explorer.agent', costMs: 1, effectiveIntervalMs: 10_000, metrics: [1] }], [{ probe: 'explorer.databases', code: 'BLOCKED', message: 'Another session held a lock this view needed for more than a second. It tries again.', retryInMs: 5000, terminal: false }]), 10)
    await settle()
    expect(status.server(first)).toMatchObject({ databases: undefined })
    expect(status.server(first)!.server?.chips.map(chip => chip.label)).toEqual(['1 job running', 'AG1 healthy'])
  })

  it('leaves a database without progress when the progress probe is unavailable, and the server without chips while nothing runs', async () => {
    connections.add(info(first), { server: 'a' } as never)
    const fake = streamOf(first)
    fake.onEvent({
      type: 'live.opened', seq: 0, source: 'explorer', probes: fake.params.probes.map(probe => ({
        probe: probe.probe, intervalMs: probe.intervalMs, minIntervalMs: 2000, maxIntervalMs: 300_000,
        ...probe.probe === 'explorer.progress' || probe.probe === 'explorer.availability' ? { state: 'unavailable' as const, reason: 'PERMISSION_DENIED' as const } : { state: 'ok' as const }
      }))
    }, 10)
    fake.onEvent(tick([table('explorer.databases', [['Restored', '1', '0', '0', '0']]), { probe: 'explorer.agent', costMs: 1, effectiveIntervalMs: 10_000, metrics: [0] }]), 10)
    await settle()
    expect(status.server(first)!.databases?.get('Restored')?.words).toBe('Restoring')
    expect(status.server(first)!.server).toBeUndefined()
  })

  it('pauses while Object Explorer is hidden, and ends every view when the setting is turned off', async () => {
    connections.add(info(first), { server: 'a' } as never)
    const fake = streamOf(first)
    open(fake)
    panes.set({ explorer: false, editor: true, output: false })
    vi.advanceTimersByTime(defaultSettings['liveData.pauseAfterSeconds'] * 1000)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }])
    panes.set({ explorer: true, editor: true, output: false })
    await settle()
    expect(fake.updates).toEqual([{ paused: true }, { paused: false }])
    // Object Explorer's Refresh samples the server at once.
    status.refresh(first)
    await settle()
    expect(fake.updates.at(-1)).toEqual({ refresh: true })
    settings.set({ 'liveData.explorerStatus': false })
    expect(fake.cancelled).toBe(true)
    expect(live.getSnapshot().handles).toEqual([])
    settings.set({ 'liveData.explorerStatus': true })
    expect(client.streams).toHaveLength(2)
  })

  it('opens no view while Object Explorer is hidden, so a server connected then runs no SQL until the pane shows', () => {
    panes.set({ explorer: false, editor: true, output: false })
    connections.add(info(first), { server: 'a' } as never)
    expect(client.streams).toHaveLength(0)
    panes.set({ explorer: true, editor: true, output: false })
    expect(client.streams.map(stream => stream.params.connectionId)).toEqual([first])
  })

  it('tries a view the server refused again when Object Explorer shows again, not before', async () => {
    connections.add(info(first), { server: 'a' } as never)
    streamOf(first).end({ ok: false, error: 'Too many live views are reading this server.', code: 'TOO_MANY_REQUESTS' })
    await settle()
    expect(client.streams).toHaveLength(1)
    // The ended view holds no slot in the window.
    expect(live.getSnapshot().handles).toEqual([])
    expect(status.server(first)).toMatchObject({ server: undefined, databases: undefined })
    panes.set({ explorer: false, editor: true, output: false })
    expect(client.streams).toHaveLength(1)
    panes.set({ explorer: true, editor: true, output: false })
    expect(client.streams).toHaveLength(2)
  })

  it('takes only background slots, so the documents a user opens always find one', () => {
    for (let at = 0; at < 10; at++) connections.add(info(`00000000-0000-4000-8000-00000000000${at.toString(16)}`), { server: 's' + at } as never)
    expect(client.streams).toHaveLength(liveServiceLimits.background)
    expect(live.getSnapshot().handles).toHaveLength(10)
  })
})
