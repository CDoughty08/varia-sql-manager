import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, ExplorerChildrenResult, ExplorerNode, ResultDescriptor, VariaApi } from '../src/shared/contracts'
import { agentTreeChange, agentTreeFingerprints, agentTreeFolders, agentTreeStatus, agentTreeFinalCodes, agentTreeRetryMs } from '../src/shared/agent/tree'
import { folderSpecs, kindSpecs, type FolderId } from '../src/shared/explorer/catalog'
import type { ExplorerChildrenParams, ObjectRef } from '../src/shared/explorer/refs'
import { agentJobChips, statusChipDocs } from '../src/shared/explorer/status'
import { liveProbes, liveSources } from '../src/shared/live/catalog'
import type { LiveTick } from '../src/shared/live/schema'
import { defaultSettings, type SettingsValues } from '../src/shared/settings/catalog'
import { EventBus } from '../src/renderer/src/core/events'
import type { AppliedTick, LiveHandle, LiveOwner, LiveSnapshot, LiveSpec, LiveTable } from '../src/renderer/src/live/LiveService'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { ExplorerService } from '../src/renderer/src/explorer/ExplorerService'
import { rowStatus } from '../src/renderer/src/explorer/ExplorerStatusService'
import { liveJob } from '../src/renderer/src/explorer/ExplorerRow'
import { AgentTreeLive } from '../src/renderer/src/agent/AgentTreeLive'
import { connectionInfo, connectionOptions, manualTimers } from './fixtures/workbench'

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const cid = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const jobA = 'AAAAAAAA-0000-4000-8000-000000000001', jobB = 'bbbbbbbb-0000-4000-8000-000000000002'

describe('Job rows\' state chips (agentJobChips)', () => {
  const row = (fields: Partial<Parameters<typeof agentJobChips>[0]> = {}) => ({ enabled: 'Yes', status: 'Idle', step: null, lastOutcome: 'Succeeded', ...fields })
  it('shows Running with the step, Between retries, Suspended or a failed last run, as the mock does', () => {
    expect(agentJobChips(row({ status: 'Executing', step: 'Step 2 of 4 · Rebuild' }), true)).toEqual({ enabled: true, chips: [{ id: 'state', tone: 'running', label: 'Running · step 2/4', words: 'Running, step 2 of 4', title: 'Executing: step 2 of 4 (Rebuild).', icon: 'agent-job' }] })
    // No step count (msdb gives none) or no step at all.
    expect(agentJobChips(row({ status: 'Executing', step: 'Step 3' }), true).chips[0]).toMatchObject({ label: 'Running · step 3', words: 'Running, step 3' })
    expect(agentJobChips(row({ status: 'Performing completion actions' }), true).chips[0]).toMatchObject({ label: 'Running', words: 'Running, performing completion actions' })
    expect(agentJobChips(row({ status: 'Waiting for worker thread', step: 'Step 1 of 1' }), true).chips[0]).toMatchObject({ label: 'Running · step 1/1', tone: 'running' })
    expect(agentJobChips(row({ status: 'Between retries', step: 'Step 2 of 4' }), true).chips).toEqual([expect.objectContaining({ label: 'Between retries', tone: 'warning' })])
    expect(agentJobChips(row({ status: 'Suspended' }), true).chips[0]).toMatchObject({ label: 'Suspended', tone: 'warning' })
    // A running job that failed last time shows only that it runs; an idle one its failed last run.
    expect(agentJobChips(row({ status: 'Executing', lastOutcome: 'Failed' }), true).chips.map(chip => chip.label)).toEqual(['Running'])
    expect(agentJobChips(row({ lastOutcome: 'Failed' }), true).chips).toEqual([{ id: 'state', tone: 'critical', label: 'Failed', words: 'Last run failed', title: 'The job\'s last run failed.' }])
    // Idle and succeeded, untracked, or a status the catalogue does not name: no chip.
    for (const status of ['Idle', 'Not tracked on this server', 'toString', null]) expect(agentJobChips(row({ status }), true).chips).toEqual([])
  })
  it('says whether the read found the job enabled, and shows only the last outcome while Agent cannot run jobs', () => {
    expect(agentJobChips(row({ enabled: 'No' }), true)).toEqual({ chips: [], enabled: false })
    expect(agentJobChips(row({ enabled: null }), true)).toEqual({ chips: [] })
    expect(agentJobChips(row({ status: 'Executing', step: 'Step 1 of 2' }), false).chips).toEqual([])
    expect(agentJobChips(row({ status: 'Executing', lastOutcome: 'Failed' }), false).chips.map(chip => chip.label)).toEqual(['Failed'])
  })
  it('documents every job chip', () => {
    expect(statusChipDocs.filter(doc => doc.kind === 'agentJob').map(doc => doc.chip)).toEqual(['Running · step n/m', 'Between retries / Suspended', 'Failed'])
  })
})

describe('The agent.tree change source\'s catalogue', () => {
  it('declares one probe with every state value and fingerprint, mirrored by the backend\'s text in order', () => {
    expect(liveSources['agent.tree']).toMatchObject({ scope: 'server', probes: ['agent.treeProbe'], testOnly: false })
    expect(liveProbes['agent.treeProbe']).toMatchObject({ source: 'agent.tree', status: agentTreeStatus, gates: { minMajor: 13, editions: [1, 2, 3, 8] } })
    expect(agentTreeStatus).toEqual(['agentXps', 'serviceState', 'jobsCount', 'jobsChecksum', 'alertsCount', 'alertsChecksum', 'operatorsCount', 'operatorsChecksum', 'proxiesCount', 'proxiesChecksum', 'assignmentsCount', 'assignmentsChecksum'])
    const csharp = readFileSync(new URL('../backend/Varia.Backend/Live/LiveSql.AgentTree.cs', import.meta.url), 'utf8')
    const mirrored = [...csharp.matchAll(/\("(\w+)", "(msdb\.dbo\.\w+)", \[/g)].map(match => ({ id: match[1], table: match[2] }))
    expect(mirrored).toEqual(agentTreeFingerprints.map(({ id, table }) => ({ id, table })))
    for (const folder of agentTreeFolders) expect(folderSpecs[folder]).toBeDefined()
    expect(agentTreeFinalCodes).not.toContain('AGENT_DISABLED')
  })
  it('re-lists the node when Agent XPs or the service state changes, and reloads only the folders whose fingerprint changed', () => {
    const base = new Map<string, number>(agentTreeStatus.map(id => [id, id === 'agentXps' ? 1 : id === 'serviceState' ? 4 : 7]))
    const changed = (patch: Record<string, number | undefined>) => { const next = new Map(base); for (const [id, value] of Object.entries(patch)) if (value === undefined) next.delete(id); else next.set(id, value); return next }
    expect(agentTreeChange(base, new Map(base))).toEqual({ node: false, folders: [] })
    expect(agentTreeChange(base, changed({ agentXps: 0 }))).toEqual({ node: true, folders: [] })
    expect(agentTreeChange(base, changed({ serviceState: 1 }))).toEqual({ node: true, folders: [] })
    // A state the login stops being able to read counts as a change too.
    expect(agentTreeChange(base, changed({ serviceState: undefined })).node).toBe(true)
    expect(agentTreeChange(base, changed({ jobsChecksum: 8 }))).toEqual({ node: false, folders: ['agentJobs'] })
    expect(agentTreeChange(base, changed({ operatorsCount: 8, alertsChecksum: 1 }))).toEqual({ node: false, folders: ['agentAlerts', 'agentOperators'] })
    expect(agentTreeChange(base, changed({ assignmentsChecksum: 1, proxiesCount: 2 }))).toEqual({ node: false, folders: ['agentProxies', 'agentUnassignedProxies'] })
  })
})

// --- AgentTreeLive against a real ExplorerService over a fake backend and fake live views ------------------------------

interface Msdb { xps: boolean; jobs: { id: string; name: string; enabled?: boolean }[]; operators: string[] }
const folder = (owner: ObjectRef, id: FolderId): ExplorerNode => ({ ref: { type: 'folder', owner: { ...owner }, folder: id }, label: folderSpecs[id].label, icon: 'folder', hasChildren: true })
const object = (value: ObjectRef, label: string, fields: Partial<ExplorerNode> = {}): ExplorerNode => ({ ref: { type: 'object', object: value }, label, icon: kindSpecs[value.kind].icon, hasChildren: true, ...fields })

function fakeBackend() {
  const msdb: Msdb = { xps: true, jobs: [{ id: jobA, name: 'Index maintenance' }, { id: jobB, name: 'Nightly', enabled: false }], operators: ['DBA team'] }
  const sent: ExplorerChildrenParams[] = []
  const ok = (nodes: ExplorerNode[]): ApiResult<ExplorerChildrenResult> => ({ ok: true, value: { nodes, elapsedMs: 1, total: nodes.length } })
  function respond(params: ExplorerChildrenParams): ApiResult<ExplorerChildrenResult> {
    const { node } = params
    if (node.type === 'object') {
      if (node.object.kind === 'server') return ok([object({ kind: 'agent' }, 'SQL Server Agent'), folder(node.object, 'databases')])
      if (node.object.kind === 'agent') return msdb.xps
        ? ok([folder(node.object, 'agentJobs'), folder(node.object, 'agentOperators')])
        : { ok: true, value: { nodes: [], elapsedMs: 1, error: { code: 'AGENT_DISABLED', message: 'Agent XPs is off.', retryable: true } } as ExplorerChildrenResult }
      return ok([])
    }
    switch (node.folder) {
      case 'agentJobs': return ok(msdb.jobs.map(job => object({ kind: 'agentJob', name: job.name }, job.name, { hasChildren: false, jobId: job.id, ...job.enabled === false ? { status: 'disabled' } : {} })))
      case 'agentOperators': return ok(msdb.operators.map(name => object({ kind: 'agentOperator', name }, name, { hasChildren: false })))
      default: return ok([])
    }
  }
  const api = {
    explorerChildren: vi.fn<VariaApi['explorerChildren']>(async params => { sent.push(params); return respond(params) }),
    explorerCancel: vi.fn<VariaApi['explorerCancel']>(async ids => ({ ok: true, value: { cancelled: ids.length } }))
  }
  return { api, sent, msdb }
}
const listing = (params: ExplorerChildrenParams) => params.node.type === 'folder' ? params.node.folder : params.node.object.kind

const jobColumns = liveProbes['agent.jobs.list'].tables![0].columns
/** A live view as the service sees it: its spec and owner, the ticks it is given, its status, a jobs table, and what was asked of it. */
class FakeView {
  readonly id = crypto.randomUUID()
  readonly listeners = new Set<(tick: AppliedTick) => void>()
  readonly statusListeners = new Set<() => void>()
  disposed = false
  refreshes = 0
  seq = 0
  rows: (string | null)[][] = []
  snapshot: LiveSnapshot
  constructor(readonly spec: LiveSpec, readonly owner: LiveOwner, refused?: { code: string; message: string }) {
    this.snapshot = refused ? { status: 'ended', probes: {}, connectionId: spec.connectionId, error: refused as LiveSnapshot['error'] }
      : { status: 'live', probes: Object.fromEntries(spec.probes.map(probe => [probe.probe, { state: 'fresh', intervalMs: 5000, effectiveIntervalMs: 5000 }])), connectionId: spec.connectionId, subscriptionId: this.id }
  }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener) } }
  set(snapshot: Partial<LiveSnapshot>) { this.snapshot = { ...this.snapshot, ...snapshot }; for (const listener of [...this.statusListeners]) listener() }
  end(code?: string) { this.set({ status: 'ended', ...code ? { error: { code, message: 'It stopped.' } as LiveSnapshot['error'] } : {} }) }
  onTick(listener: (tick: AppliedTick) => void) { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener) } } }
  refresh() { this.refreshes++ }
  dispose() { this.disposed = true }
  table(): LiveTable {
    const rows = this.rows, columns = jobColumns.length
    const descriptor = { generation: 1, resultId: 1, columns: jobColumns.map(column => ({ name: column.name, dataType: column.dataType, wire: 'text', nullable: true })), rowsRead: rows.length, rowsStored: rows.length, rowsAvailable: rows.length, state: 'complete' } as unknown as ResultDescriptor
    return {
      probe: 'agent.jobs.list', index: 0, mode: 'snapshot', descriptor,
      handle: { getWindow: async (first: number, count: number, span?: { colStart: number; colEnd: number }) => {
        // As the results worker's windows: at most 4,096 rows each, and only the columns asked for.
        const colStart = span?.colStart ?? 0, colEnd = span?.colEnd ?? columns
        const shown = rows.slice(first, first + Math.min(count, 4096)).map(cells => cells.slice(colStart, colEnd))
        return { first, count: shown.length, colStart, colEnd, text: shown.flatMap(cells => cells.map(cell => cell ?? '')), flags: Uint8Array.from(shown.flatMap(cells => cells.map(cell => cell === null ? 1 : 0))) }
      } }
    } as unknown as LiveTable
  }
  emit(samples: LiveTick['samples']) {
    const tick: LiveTick = { type: 'live.tick', seq: ++this.seq, sampledAt: Date.now(), samples }
    for (const listener of [...this.listeners]) listener({ subscriptionId: this.id, tick })
  }
  /** An agent.treeProbe sample. */
  tree(status: ReadonlyMap<string, number>) { this.emit([{ probe: 'agent.treeProbe', costMs: 1, effectiveIntervalMs: 15_000, status: [...status].map(([id, value]) => ({ id, value })) }]) }
  /** An agent.jobs sample: the list's rows (a changed revision) and the service's state. */
  jobs(rows: Record<string, string | null>[], service: Record<string, number> = { agentXps: 1, serviceState: 4 }) {
    this.rows = rows.map(row => jobColumns.map(column => row[column.id] ?? null))
    this.emit([
      { probe: 'agent.jobs.list', costMs: 1, effectiveIntervalMs: 5000, tables: [{ table: 0, descriptor: this.table().descriptor, revision: this.seq + 1, diff: { added: rows.length, removed: 0, changed: 0 } }] },
      { probe: 'agent.jobs.service', costMs: 1, effectiveIntervalMs: 10_000, status: Object.entries(service).map(([id, value]) => ({ id, value })) }
    ] as LiveTick['samples'])
  }
}
const fingerprints = (changes: Record<string, number> = {}) => new Map(agentTreeStatus.map(id => [id, changes[id] ?? (id === 'agentXps' ? 1 : id === 'serviceState' ? 4 : 100)]))

const disposals: (() => void)[] = []
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()) })

function fixture(options: { settings?: Partial<SettingsValues> } = {}) {
  const backend = fakeBackend()
  const connections = new ConnectionService(), events = new EventBus()
  let ids = 0
  const explorer = new ExplorerService({ api: backend.api, connections, events, schedule: callback => callback(), newId: () => uuid(++ids) })
  const views: FakeView[] = []
  const refuse: { next?: { code: string; message: string } } = {}
  const live = { open: (spec: LiveSpec, owner: LiveOwner) => { const view = new FakeView(spec, owner, refuse.next); refuse.next = undefined; views.push(view); return view as unknown as LiveHandle } }
  const { timers, advance } = manualTimers()
  let visible = true
  const paneListeners = new Set<() => void>()
  const explorerVisible = { visible: () => visible, subscribe: (listener: () => void) => { paneListeners.add(listener); return () => paneListeners.delete(listener) } }
  const setVisible = (value: boolean) => { visible = value; paneListeners.forEach(listener => listener()) }
  let values: SettingsValues = { ...defaultSettings, ...options.settings }
  const settingListeners = new Set<() => void>()
  const settings = { getSnapshot: () => ({ values }), subscribe: (listener: () => void) => { settingListeners.add(listener); return () => settingListeners.delete(listener) } }
  const setSettings = (patch: Partial<SettingsValues>) => { values = { ...values, ...patch }; settingListeners.forEach(listener => listener()) }
  const tree = new AgentTreeLive({ explorer, live, explorerVisible, settings, events, timers })
  disposals.push(() => { tree.dispose(); explorer.dispose() })
  const connect = (n = 1) => connections.add({ ...connectionInfo(cid(n), 1), server: `server-${n}.example` }, connectionOptions)
  const rows = () => Array.from(explorer.getSnapshot().rows.ids).filter(id => id > 0).map(id => explorer.node(id)!)
  const find = (label: string) => {
    const found = rows().filter(node => node.label === label)
    if (found.length !== 1) throw new Error(`${found.length} rows are labelled ${label}`)
    return found[0].id
  }
  const open = async (...path: string[]) => { for (const label of path) { explorer.expand(find(label)); await settle() } }
  const loads = (from = 0) => backend.sent.slice(from).map(listing)
  const viewsOf = (source: string) => views.filter(view => view.spec.source === source)
  return { ...backend, explorer, connections, events, views, viewsOf, tree, connect, find, rows, open, loads, setVisible, setSettings, refuse, advance }
}

describe('AgentTreeLive: the views\' life', () => {
  it('opens agent.tree while the Agent node is open and shown, agent.jobs while its Jobs folder is, and closes each when it is not', async () => {
    const f = fixture()
    f.connect()
    await settle()
    expect(f.views).toHaveLength(0)
    await f.open('SQL Server Agent')
    const [treeView] = f.viewsOf('agent.tree')
    expect(treeView.spec).toEqual({ connectionId: cid(1), source: 'agent.tree', probes: [{ probe: 'agent.treeProbe' }], background: true })
    expect(treeView.owner.key).toBe('explorer:agent:tree:' + cid(1))
    expect(f.viewsOf('agent.jobs')).toHaveLength(0)
    await f.open('Jobs')
    const [jobsView] = f.viewsOf('agent.jobs')
    // Job Activity Monitor's own probes: the list and Agent's state, no second polling path.
    expect(jobsView.spec).toEqual({ connectionId: cid(1), source: 'agent.jobs', probes: [{ probe: 'agent.jobs.list' }, { probe: 'agent.jobs.service' }], background: true })
    expect(f.tree.keys).toEqual(['tree:' + cid(1), 'jobs:' + cid(1)])
    // Both follow Object Explorer's visibility (LiveService pauses them) and end with their server.
    f.setVisible(false)
    expect(jobsView.owner.visible()).toBe(false)
    f.setVisible(true)
    expect(jobsView.owner.connectionId?.()).toBe(cid(1))
    // Collapsing Jobs ends the chips' view; collapsing the Agent node ends the tree's too.
    f.explorer.collapse(f.find('Jobs'))
    await settle()
    expect(jobsView.disposed).toBe(true)
    expect(treeView.disposed).toBe(false)
    f.explorer.expand(f.find('Jobs'))
    await settle()
    expect(f.viewsOf('agent.jobs')).toHaveLength(2)
    f.explorer.collapse(f.find('SQL Server Agent'))
    await settle()
    expect(f.views.every(view => view.disposed)).toBe(true)
    expect(f.tree.keys).toEqual([])
    // Hidden below a collapsed server, nothing runs.
    f.explorer.expand(f.find('SQL Server Agent'))
    await settle()
    expect(f.tree.keys).toHaveLength(2)
    f.explorer.collapse(f.find('server-1.example'))
    await settle()
    expect(f.tree.keys).toEqual([])
  })
  it('opens nothing with live status off, and closes its views when that setting goes off', async () => {
    const f = fixture({ settings: { 'liveData.explorerStatus': false } })
    f.connect()
    await settle()
    await f.open('SQL Server Agent', 'Jobs')
    expect(f.views).toHaveLength(0)
    f.setSettings({ 'liveData.explorerStatus': true })
    expect(f.tree.keys).toHaveLength(2)
    f.setSettings({ 'liveData.explorerStatus': false })
    expect(f.views.every(view => view.disposed)).toBe(true)
  })
  it('opens a view that ended again after a growing back-off, and one that ended for good only after a Refresh of the Agent node', async () => {
    const f = fixture()
    f.connect()
    await settle()
    f.refuse.next = { code: 'BUSY', message: 'No room.' }
    await f.open('SQL Server Agent')
    expect(f.viewsOf('agent.tree')).toHaveLength(1)
    f.advance(agentTreeRetryMs.first - 1)
    expect(f.viewsOf('agent.tree')).toHaveLength(1)
    f.advance(1)
    expect(f.viewsOf('agent.tree')).toHaveLength(2)
    // It ends again before a sample: twice as long.
    f.viewsOf('agent.tree')[1].end('BUSY')
    f.advance(agentTreeRetryMs.first)
    expect(f.viewsOf('agent.tree')).toHaveLength(2)
    f.advance(agentTreeRetryMs.first)
    expect(f.viewsOf('agent.tree')).toHaveLength(3)
    // No access ends it for good: no timer reopens it, a Refresh of the Agent node does.
    f.viewsOf('agent.tree')[2].end('PERMISSION_DENIED')
    f.advance(agentTreeRetryMs.max * 2)
    expect(f.viewsOf('agent.tree')).toHaveLength(3)
    f.events.emit({ type: 'explorer.refreshed', connectionId: cid(1), scope: 'databases', nodeId: f.find('Databases') })
    expect(f.viewsOf('agent.tree')).toHaveLength(3)
    f.events.emit({ type: 'explorer.refreshed', connectionId: cid(1), scope: 'other', nodeId: f.find('SQL Server Agent') })
    expect(f.viewsOf('agent.tree')).toHaveLength(4)
  })
})

describe('AgentTreeLive: agent.tree reloads only what changed', () => {
  it('takes the first sample as a baseline, then reloads only the changed folder, keeping expansion and selection', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('SQL Server Agent', 'Jobs', 'Operators')
    const [view] = f.viewsOf('agent.tree')
    f.explorer.select(f.find('Nightly'))
    const from = f.sent.length
    view.tree(fingerprints())
    await settle()
    expect(f.loads(from)).toEqual([])
    // A job created elsewhere: only Jobs lists again, in the background, and the new job appears.
    f.msdb.jobs.push({ id: uuid(77), name: 'Created elsewhere' })
    view.tree(fingerprints({ jobsCount: 101, jobsChecksum: 5 }))
    await settle()
    expect(f.loads(from)).toEqual(['agentJobs'])
    expect(f.rows().map(node => node.label)).toContain('Created elsewhere')
    expect(f.explorer.node(f.find('Jobs'))!.expanded).toBe(true)
    expect(f.explorer.getSnapshot().selected).toBe(f.find('Nightly'))
    // An operator renamed elsewhere: only Operators.
    f.msdb.operators = ['DBA on call']
    view.tree(fingerprints({ jobsCount: 101, jobsChecksum: 5, operatorsChecksum: 9 }))
    await settle()
    expect(f.loads(from)).toEqual(['agentJobs', 'agentOperators'])
    expect(f.rows().map(node => node.label)).toContain('DBA on call')
    // The same sample again reloads nothing.
    view.tree(fingerprints({ jobsCount: 101, jobsChecksum: 5, operatorsChecksum: 9 }))
    await settle()
    expect(f.loads(from)).toHaveLength(2)
  })
  it('re-lists the Agent node when Agent XPs flips off and on, so Refresh is not needed', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('SQL Server Agent', 'Jobs')
    const [view] = f.viewsOf('agent.tree')
    view.tree(fingerprints())
    await settle()
    const from = f.sent.length
    f.msdb.xps = false
    view.tree(fingerprints({ agentXps: 0 }))
    await settle()
    expect(f.loads(from)).toEqual(['agent'])
    // As after a Refresh, the node says AGENT_DISABLED and keeps its last rows as stale; it stays open, so its view keeps
    // sampling and sees Agent XPs come back.
    const agent = () => f.explorer.node(f.find('SQL Server Agent'))!
    expect(agent()).toMatchObject({ load: 'error', error: { code: 'AGENT_DISABLED' } })
    expect(f.tree.keys).toContain('tree:' + cid(1))
    f.msdb.xps = true
    view.tree(fingerprints())
    await settle()
    expect(f.loads(from)).toEqual(['agent', 'agent'])
    expect(agent()).toMatchObject({ load: 'loaded', error: undefined })
    expect(f.rows().map(node => node.label)).toContain('Jobs')
    // A service that stopped while Agent XPs stayed on (as the service probe reads it) re-lists the node too.
    view.tree(fingerprints({ serviceState: 1 }))
    await settle()
    expect(f.loads(from)).toEqual(['agent', 'agent', 'agent'])
  })
  it('lists the Agent node when Agent XPs comes on after it was first listed with Agent XPs off (no rows to keep)', async () => {
    const f = fixture()
    f.msdb.xps = false
    f.connect()
    await settle()
    await f.open('SQL Server Agent')
    const agent = () => f.explorer.node(f.find('SQL Server Agent'))!
    expect(agent()).toMatchObject({ load: 'error', error: { code: 'AGENT_DISABLED' }, children: undefined, expanded: true })
    const [view] = f.viewsOf('agent.tree')
    expect(view).toBeDefined()
    view.tree(fingerprints({ agentXps: 0 }))
    await settle()
    const from = f.sent.length
    f.msdb.xps = true
    view.tree(fingerprints())
    await settle()
    expect(f.loads(from)).toEqual(['agent'])
    expect(agent()).toMatchObject({ load: 'loaded', error: undefined })
    expect(f.rows().map(node => node.label)).toContain('Jobs')
  })
  it('lists a node that failed before its view opened once its view first samples, so a flip meanwhile is not lost', async () => {
    const f = fixture({ settings: { 'liveData.explorerStatus': false } })
    f.msdb.xps = false
    f.connect()
    await settle()
    await f.open('SQL Server Agent')
    expect(f.explorer.node(f.find('SQL Server Agent'))).toMatchObject({ load: 'error', children: undefined })
    // Agent XPs comes back on while no view watches; the view that opens then first reads it on.
    f.msdb.xps = true
    f.setSettings({ 'liveData.explorerStatus': true })
    await settle()
    const [view] = f.viewsOf('agent.tree')
    const from = f.sent.length
    view.tree(fingerprints())
    await settle()
    expect(f.loads(from)).toEqual(['agent'])
    expect(f.explorer.node(f.find('SQL Server Agent'))).toMatchObject({ load: 'loaded' })
  })
  it('reloads everything once when the node was listed before its view opened, and compares with the last fingerprints when it opens again', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('SQL Server Agent', 'Jobs')
    const [first] = f.viewsOf('agent.tree')
    first.tree(fingerprints())
    await settle()
    // Closed meanwhile; a job is deleted elsewhere; opening the node again compares with what it last saw.
    f.explorer.collapse(f.find('SQL Server Agent'))
    await settle()
    f.msdb.jobs = f.msdb.jobs.slice(1)
    f.explorer.expand(f.find('SQL Server Agent'))
    await settle()
    const from = f.sent.length
    f.viewsOf('agent.tree')[1].tree(fingerprints({ jobsCount: 99 }))
    await settle()
    expect(f.loads(from)).toEqual(['agentJobs'])
    expect(f.rows().map(node => node.label)).not.toContain('Index maintenance')
    // A second connection whose node was listed with live status off has no baseline: its first sample reloads it all.
    const g = fixture({ settings: { 'liveData.explorerStatus': false } })
    g.connect()
    await settle()
    await g.open('SQL Server Agent', 'Jobs')
    g.setSettings({ 'liveData.explorerStatus': true })
    const at = g.sent.length
    g.viewsOf('agent.tree')[0].tree(fingerprints())
    await settle()
    expect(g.loads(at)).toEqual(['agent', 'agentJobs'])
  })
})

describe('AgentTreeLive: job rows\' chips from agent.jobs', () => {
  const job = (id: string, fields: Record<string, string | null>) => ({ jobId: id, name: 'job', enabled: 'Yes', status: 'Idle', step: null, lastOutcome: 'Succeeded', ...fields })
  it('publishes each job\'s chips by connection and job id while the Jobs folder is open, and none once it closes', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('SQL Server Agent', 'Jobs')
    const [view] = f.viewsOf('agent.jobs')
    view.jobs([job(jobA.toLowerCase(), { status: 'Executing', step: 'Step 2 of 4 · Rebuild' }), job(jobB, { lastOutcome: 'Failed', enabled: 'No' })])
    await settle()
    const running = f.explorer.node(f.find('Index maintenance'))!
    // The tree lists ids in msdb's case; the read's may differ.
    expect(rowStatus(undefined, running, f.tree)).toMatchObject({ words: 'Running, step 2 of 4', enabled: true })
    expect(rowStatus(undefined, running, f.tree)?.chips.map(chip => chip.label)).toEqual(['Running · step 2/4'])
    // The read and the listing are both stamped, so a Disable's re-list after the read wins until the next read (liveJob).
    expect(running.listedAt).toBeTypeOf('number')
    expect(rowStatus(undefined, running, f.tree)?.enabledAt).toBeTypeOf('number')
    expect(rowStatus(undefined, f.explorer.node(f.find('Nightly'))!, f.tree)).toMatchObject({ words: 'Last run failed', enabled: false })
    // An unchanged sample keeps the same objects, so memoised rows do not render again (once the first read, which had no
    // earlier tick to date it, has been dated by the next one).
    const unchanged = () => view.emit([{ probe: 'agent.jobs.list', costMs: 1, effectiveIntervalMs: 5000, tables: [{ table: 0, descriptor: view.table().descriptor, revision: 9, diff: { added: 0, removed: 0, changed: 0 } }] }] as LiveTick['samples'])
    unchanged()
    await settle()
    const before = f.tree.getSnapshot()
    unchanged()
    await settle()
    expect(f.tree.getSnapshot()).toBe(before)
    f.explorer.collapse(f.find('Jobs'))
    await settle()
    expect(f.tree.job(cid(1), jobA)).toBeUndefined()
  })
  it('lets a listing newer than the read win, then the next read, changed or not, win again', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('SQL Server Agent', 'Jobs')
    const [view] = f.viewsOf('agent.jobs')
    const shown = () => { const node = f.explorer.node(f.find('Index maintenance'))!; const status = rowStatus(undefined, node, f.tree); return status ? liveJob(node, status).status : node.status }
    // Ticks stamped by the clock, later than what came before them.
    const later = () => new Promise(resolve => setTimeout(resolve, 5))
    const unchanged = () => view.emit([{ probe: 'agent.jobs.list', costMs: 1, effectiveIntervalMs: 5000, tables: [{ table: 0, descriptor: view.table().descriptor, revision: view.seq, diff: { added: 0, removed: 0, changed: 0 } }] }] as LiveTick['samples'])
    // Listed enabled; the first read finds it disabled elsewhere, but nothing dates it after the listing yet, so the listing stays.
    await later()
    view.jobs([job(jobA, { enabled: 'No' })])
    await settle()
    expect(shown()).toBeUndefined()
    // The next tick dates those rows after the listing: the read wins.
    await later()
    unchanged()
    await settle()
    expect(shown()).toBe('disabled')
    // The job's menu follows it too: Enable Job, not Disable Job (the actions catalogue reads the target's status).
    const jobs = f.explorer.useJobStatus(f.tree)
    expect(f.explorer.menuNode(f.find('Index maintenance'))?.status).toBe('disabled')
    jobs.dispose()
    expect(f.explorer.menuNode(f.find('Index maintenance'))?.status).toBeUndefined()
    // The folder lists again (as a Disable or Enable re-lists it at once): the listing wins over rows read before it.
    await later()
    f.explorer.reconcile(f.find('Jobs'))
    await settle()
    expect(shown()).toBeUndefined()
    // A tick that arrives after the listing may have read msdb before it (the backend stamps a tick when it ends): it does not win.
    await later()
    unchanged()
    await settle()
    expect(shown()).toBeUndefined()
    // The tick after it read msdb after the listing, and the list still says disabled: the read wins again.
    await later()
    unchanged()
    await settle()
    expect(shown()).toBe('disabled')
  })
  it('reads every job the list keeps, past the 1,000 rows of the explorer status tables and the 4,096 of one window', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('SQL Server Agent', 'Jobs')
    const [view] = f.viewsOf('agent.jobs')
    const filler = Array.from({ length: 4_200 }, (_, n) => job(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, {}))
    view.jobs([...filler, job(jobB, { lastOutcome: 'Failed' })])
    await settle()
    expect(rowStatus(undefined, f.explorer.node(f.find('Nightly'))!, f.tree)).toMatchObject({ words: 'Last run failed' })
  })
  it('keeps only what stays true while Agent is stopped or its XPs off, and reads again once Agent can run jobs', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('SQL Server Agent', 'Jobs')
    const [view] = f.viewsOf('agent.jobs')
    view.jobs([job(jobA, { status: 'Executing', step: 'Step 1 of 2 · Load', lastOutcome: 'Failed' }), job(jobB, { lastOutcome: 'Failed', enabled: 'No' })])
    await settle()
    expect(f.tree.job(cid(1), jobA)?.chips.map(chip => chip.label)).toEqual(['Running · step 1/2'])
    // Agent stops: its service sample reads it stopped, and the list's next sample stops on AGENT_DISABLED (15281), as the
    // real backend's does. The last rows stay for a failed last run and a disabled job, not for what was running.
    view.emit([{ probe: 'agent.jobs.service', costMs: 1, effectiveIntervalMs: 10_000, status: [{ id: 'agentXps', value: 0 }, { id: 'serviceState', value: 1 }] }] as LiveTick['samples'])
    view.set({ probes: { ...view.snapshot.probes, 'agent.jobs.list': { state: 'failing', intervalMs: 5000, effectiveIntervalMs: 5000, error: { probe: 'agent.jobs.list', code: 'AGENT_DISABLED', message: 'Agent XPs is off.', retryInMs: 5000, terminal: true } } } })
    await settle()
    expect(f.tree.job(cid(1), jobA)?.chips.map(chip => chip.label)).toEqual(['Failed'])
    expect(f.tree.job(cid(1), jobB)).toMatchObject({ words: 'Last run failed', enabled: false })
    // The list stopped on AGENT_DISABLED even before a service sample says so: what was running is not shown either.
    view.emit([{ probe: 'agent.jobs.service', costMs: 1, effectiveIntervalMs: 10_000, status: [{ id: 'agentXps', value: 1 }, { id: 'serviceState', value: 4 }] }] as LiveTick['samples'])
    await settle()
    expect(f.tree.job(cid(1), jobA)?.chips.map(chip => chip.label)).toEqual(['Failed'])
    // That service sample, reading Agent usable, asked the stopped list for a read at once.
    expect(view.refreshes).toBe(1)
    // Another failure is not Agent's stop: no rows are shown for it.
    view.set({ probes: { ...view.snapshot.probes, 'agent.jobs.list': { state: 'failing', intervalMs: 5000, effectiveIntervalMs: 5000, error: { probe: 'agent.jobs.list', code: 'TIMEOUT', message: 'It timed out.', retryInMs: 5000, terminal: false } } } })
    await settle()
    expect(f.tree.job(cid(1), jobA)).toBeUndefined()
  })
  it('shows nothing of an earlier subscription once the view subscribes again', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('SQL Server Agent', 'Jobs')
    const [view] = f.viewsOf('agent.jobs')
    view.jobs([job(jobA, { status: 'Executing' })])
    await settle()
    expect(f.tree.job(cid(1), jobA)).toBeDefined()
    view.set({ subscriptionId: 'another' })
    await settle()
    expect(f.tree.job(cid(1), jobA)).toBeUndefined()
  })
})
