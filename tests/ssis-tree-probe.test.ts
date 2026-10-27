import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, ExplorerChildrenResult, ExplorerNode, VariaApi } from '../src/shared/contracts'
import { folderSpecs, kindSpecs, type FolderId } from '../src/shared/explorer/catalog'
import type { ExplorerChildrenParams, ObjectRef } from '../src/shared/explorer/refs'
import { explorerChildrenParamsSchema } from '../src/shared/explorer/schema'
import type { LiveSpec, LiveOwner, LiveHandle, AppliedTick, LiveSnapshot } from '../src/renderer/src/live/LiveService'
import type { LiveProbeError, LiveTick } from '../src/shared/live/schema'
import { defaultSettings, type SettingsValues } from '../src/shared/settings/catalog'
import { catalogFingerprints, catalogFingerprintStatus, catalogProbeRetryMs as ssisTreeRetryMs } from '../src/shared/ssis/catalog'
import { EventBus } from '../src/renderer/src/core/events'
import type { WorkbenchEvent } from '../src/renderer/src/core/types'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { ExplorerService } from '../src/renderer/src/explorer/ExplorerService'
import { rowTooltip } from '../src/renderer/src/explorer/ExplorerRow'
import { SsisTreeProbe } from '../src/renderer/src/ssis/SsisTreeProbe'
import { connectionInfo, connectionOptions, manualTimers } from './fixtures/workbench'

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const cid = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

interface Catalog { folders: Record<string, { projects: Record<string, string[]>; environments: Record<string, number> }> }
const folder = (owner: ObjectRef, id: FolderId): ExplorerNode => ({ ref: { type: 'folder', owner: { ...owner }, folder: id }, label: folderSpecs[id].label, icon: 'folder', hasChildren: true })
const object = (value: ObjectRef, label: string, fields: Partial<ExplorerNode> = {}): ExplorerNode => ({ ref: { type: 'object', object: value }, label, icon: kindSpecs[value.kind].icon, hasChildren: true, ...fields })

/** A server whose folders are `serverFolders` (Integration Services Catalogs alone, unless a test adds others), holding
 *  SSISDB (when `exists`) as `catalog` describes it. A listing `hold` names reads the catalog when asked, and answers when released. */
function fakeBackend() {
  const state = { exists: true, catalog: { folders: { Finance: { projects: { Loads: ['Daily.dtsx'] }, environments: { Test: 2 } } } } as Catalog, serverFolders: ['integrationServicesCatalogs'] as FolderId[] }
  const holds = new Map<string, Promise<void>>()
  const hold = (name: string) => { let release!: () => void; holds.set(name, new Promise<void>(resolve => { release = resolve })); return () => { holds.delete(name); release() } }
  const sent: ExplorerChildrenParams[] = []
  const ok = (nodes: ExplorerNode[]): ApiResult<ExplorerChildrenResult> => ({ ok: true, value: { nodes, elapsedMs: 1, total: nodes.length } })
  function respond(params: ExplorerChildrenParams): ApiResult<ExplorerChildrenResult> {
    const { node } = params
    const folders = state.catalog.folders
    if (node.type === 'object') {
      const value = node.object
      switch (value.kind) {
        case 'server': return ok(state.serverFolders.map(id => folder(value, id)))
        case 'ssisCatalog': return ok(Object.keys(folders).map(name => object({ kind: 'ssisFolder', name }, name)))
        case 'ssisFolder': return ok([folder(value, 'ssisProjects'), folder(value, 'ssisEnvironments')])
        case 'ssisProject': return ok([folder(value, 'ssisPackages')])
        default: return ok([])
      }
    }
    const owner = node.owner
    switch (node.folder) {
      case 'integrationServicesCatalogs': return ok(state.exists ? [object({ kind: 'ssisCatalog', name: 'SSISDB' }, 'SSISDB')] : [])
      case 'ssisProjects': return ok(Object.keys(folders[owner.name!]?.projects ?? {}).map(name => object({ kind: 'ssisProject', ssisFolder: owner.name, name }, name)))
      case 'ssisEnvironments': return ok(Object.entries(folders[owner.name!]?.environments ?? {}).map(([name, count]) => object({ kind: 'ssisEnvironment', ssisFolder: owner.name, name }, name, { hasChildren: false, sublabel: `(${count} variables)` })))
      case 'ssisPackages': return ok((folders[owner.ssisFolder!]?.projects[owner.name!] ?? []).map(name => object({ kind: 'ssisPackage', ssisFolder: owner.ssisFolder, ssisProject: owner.name, name }, name, { hasChildren: false })))
      default: return ok([])
    }
  }
  const api = {
    explorerChildren: vi.fn<VariaApi['explorerChildren']>(async params => {
      sent.push(params)
      expect.soft(explorerChildrenParamsSchema.safeParse(params).success, JSON.stringify(params)).toBe(true)
      const result = respond(params)
      await holds.get(listing(params))
      return result
    }),
    explorerCancel: vi.fn<VariaApi['explorerCancel']>(async ids => ({ ok: true, value: { cancelled: ids.length } }))
  }
  return { api, sent, state, hold }
}
/** A listing's name in `loads` and `hold`: its folder id, or its node's kind and name. */
const listing = (params: ExplorerChildrenParams) => params.node.type === 'folder' ? params.node.folder : params.node.object.kind + ':' + params.node.object.name

/** A live view as the probe sees it: its spec and owner, the ticks it is given, its status, and what was asked of it. */
class FakeView {
  readonly id = crypto.randomUUID()
  readonly listeners = new Set<(tick: AppliedTick) => void>()
  readonly statusListeners = new Set<() => void>()
  readonly patches: unknown[] = []
  disposed = false
  seq = 0
  snapshot: LiveSnapshot
  constructor(readonly spec: LiveSpec, readonly owner: LiveOwner, refused?: { code: string; message: string }) {
    this.snapshot = refused ? { status: 'ended', probes: {}, connectionId: spec.connectionId, error: refused as LiveSnapshot['error'] } : { status: 'live', probes: {}, connectionId: spec.connectionId }
  }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener) } }
  /** The subscription ended: failed with a code, or on its own. */
  end(code?: string, message = 'It stopped.') {
    this.snapshot = { status: 'ended', probes: {}, connectionId: this.spec.connectionId, ended: { ended: code ? 'failed' : 'sourceEnded', ticks: this.seq, elapsedMs: 1, ...code ? { code, message } : {} } as LiveSnapshot['ended'],
      ...code ? { error: { code, message } as LiveSnapshot['error'] } : {} }
    for (const listener of [...this.statusListeners]) listener()
  }
  onTick(listener: (tick: AppliedTick) => void) { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener) } } }
  setProbe(probe: string, patch: unknown) { this.patches.push({ probe, patch }) }
  refreshes = 0
  refresh() { this.refreshes++ }
  dispose() { this.disposed = true }
  tick(status: ReadonlyMap<string, number> | undefined, errors?: LiveProbeError[]) {
    const tick: LiveTick = {
      type: 'live.tick', seq: ++this.seq, sampledAt: Date.now(),
      samples: status ? [{ probe: 'ssis.catalogProbe', costMs: 1, effectiveIntervalMs: 30_000, status: [...status].map(([id, value]) => ({ id, value })) }] : [],
      ...errors ? { errors } : {}
    }
    for (const listener of [...this.listeners]) listener({ subscriptionId: this.id, tick })
  }
}

/** Every fingerprint at count 1 and checksum 100, with the changes given (`projectsChecksum: 7`, say). */
const fingerprints = (changes: Record<string, number> = {}) => new Map(catalogFingerprintStatus.map(id => [id, changes[id] ?? (id.endsWith('Count') ? 1 : 100)]))

const disposals: (() => void)[] = []
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()) })

function fixture(settings: Partial<SettingsValues> = {}) {
  const backend = fakeBackend()
  const connections = new ConnectionService(), events = new EventBus(), emitted: WorkbenchEvent[] = []
  events.subscribe(event => emitted.push(event))
  let ids = 0
  const explorer = new ExplorerService({ api: backend.api, connections, events, schedule: callback => callback(), newId: () => uuid(++ids) })
  const views: FakeView[] = []
  /** The next open answers an ended view, as LiveService does when the window has too many. */
  const refuse: { next?: { code: string; message: string } } = {}
  const live = { open: (spec: LiveSpec, owner: LiveOwner) => { const view = new FakeView(spec, owner, refuse.next); refuse.next = undefined; views.push(view); return view as unknown as LiveHandle } }
  const { timers, advance, pending } = manualTimers()
  let visible = true
  const paneListeners = new Set<() => void>()
  const explorerVisible = { visible: () => visible, subscribe: (listener: () => void) => { paneListeners.add(listener); return () => paneListeners.delete(listener) } }
  const setVisible = (value: boolean) => { visible = value; paneListeners.forEach(listener => listener()) }
  let values: SettingsValues = { ...defaultSettings, ...settings }
  const settingListeners = new Set<() => void>()
  const settingsSource = { getSnapshot: () => ({ values }), subscribe: (listener: () => void) => { settingListeners.add(listener); return () => settingListeners.delete(listener) } }
  const setSettings = (patch: Partial<SettingsValues>) => { values = { ...values, ...patch }; settingListeners.forEach(listener => listener()) }
  const probe = new SsisTreeProbe({ explorer, live, explorerVisible, settings: settingsSource, events, timers })
  disposals.push(() => { probe.dispose(); explorer.dispose() })
  const connect = (n = 1) => connections.add({ ...connectionInfo(cid(n), 1), server: `server-${n}.example` }, connectionOptions)
  const rows = () => Array.from(explorer.getSnapshot().rows.ids).filter(id => id > 0).map(id => explorer.node(id)!)
  const labels = () => rows().map(node => '  '.repeat(node.level - 1) + node.label + (node.sublabel ? ' ' + node.sublabel : ''))
  const find = (label: string, under?: number) => {
    const found = rows().filter(node => node.label === label && (under === undefined || isBelow(node.id, under)))
    if (found.length !== 1) throw new Error(`${found.length} rows are labelled ${label}`)
    return found[0].id
  }
  const isBelow = (id: number, ancestor: number): boolean => { for (let node = explorer.node(id); node; node = explorer.node(node.parent)) if (node.id === ancestor) return true; return false }
  const open = async (...path: string[]) => {
    let under: number | undefined
    for (const label of path) { under = find(label, under); explorer.expand(under); await settle() }
    return under!
  }
  /** The folders and nodes each explorer.children call since `from` listed. */
  const loads = (from = 0) => backend.sent.slice(from).map(listing)
  return { ...backend, explorer, connections, emitted, views, probe, connect, labels, find, open, loads, setVisible, setSettings, refuse, advance, pending }
}

describe('SsisTreeProbe: the view\'s life', () => {
  it('opens one catalog view per connection only while its SSISDB node is open, on Object Explorer\'s visibility', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('Integration Services Catalogs')
    expect(f.views).toHaveLength(0)
    await f.open('SSISDB')
    expect(f.views).toHaveLength(1)
    const [view] = f.views
    // The catalog probe at the setting's interval (30 s, the catalogue's default), owned by Object Explorer.
    expect(view.spec).toEqual({ connectionId: cid(1), source: 'ssis.catalog', probes: [{ probe: 'ssis.catalogProbe', intervalMs: 30_000 }] })
    expect(view.owner.key).toBe('explorer:ssis:' + cid(1))
    expect(view.owner.visible()).toBe(true)
    f.setVisible(false)
    expect(view.owner.visible()).toBe(false)
    const changed = vi.fn()
    view.owner.subscribe(changed)
    f.setVisible(true)
    expect(changed).toHaveBeenCalled()
    expect(view.owner.connectionId?.()).toBe(cid(1))
    expect(f.probe.connections).toEqual([cid(1)])
    // Opening a folder below keeps the one view; closing SSISDB ends it.
    await f.open('Finance')
    expect(f.views).toHaveLength(1)
    f.explorer.collapse(f.find('SSISDB'))
    await settle()
    expect(view.disposed).toBe(true)
    expect(f.probe.connections).toEqual([])
  })
  it('ends the view when its server leaves the tree, and keeps one view per connection', async () => {
    const f = fixture()
    f.connect(1)
    f.connect(2)
    await settle()
    for (const server of ['server-1.example', 'server-2.example']) {
      const catalogs = f.find('Integration Services Catalogs', f.find(server))
      f.explorer.expand(catalogs)
      await settle()
      f.explorer.expand(f.find('SSISDB', catalogs))
      await settle()
    }
    expect(f.views.map(view => view.spec.connectionId)).toEqual([cid(1), cid(2)])
    f.connections.remove(cid(1))
    await settle()
    expect(f.views[0].owner.connectionId?.()).toBeUndefined()
    expect(f.views[0].disposed).toBe(true)
    expect(f.views[1].disposed).toBe(false)
  })
  it('follows the settings: off closes every view and on opens them again; a new interval goes to the running views', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('Integration Services Catalogs', 'SSISDB')
    f.setSettings({ 'integrationServices.treeRefreshSeconds': 120 })
    expect(f.views[0].patches).toEqual([{ probe: 'ssis.catalogProbe', patch: { intervalMs: 120_000 } }])
    f.setSettings({ 'integrationServices.treeLive': false })
    expect(f.views[0].disposed).toBe(true)
    f.setSettings({ 'integrationServices.treeLive': true })
    expect(f.views).toHaveLength(2)
    expect(f.views[1].spec.probes).toEqual([{ probe: 'ssis.catalogProbe', intervalMs: 120_000 }])
  })
  it('opens no view with the setting off', async () => {
    const f = fixture({ 'integrationServices.treeLive': false })
    f.connect()
    await settle()
    await f.open('Integration Services Catalogs', 'SSISDB')
    expect(f.views).toHaveLength(0)
  })
})

describe('SsisTreeProbe: reloading what changed', () => {
  async function opened() {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('Integration Services Catalogs', 'SSISDB', 'Finance', 'Projects', 'Loads', 'Packages')
    await f.open('Environments')
    const view = f.views[0]
    // The first sample is the baseline: nothing reloads for it.
    const loaded = f.sent.length
    view.tick(fingerprints())
    await settle()
    expect(f.sent.length).toBe(loaded)
    return { f, view }
  }
  it('takes the first sample as the baseline, and reloads nothing while the fingerprints stay', async () => {
    const { f, view } = await opened()
    const before = f.sent.length
    view.tick(fingerprints())
    await settle()
    expect(f.sent.length).toBe(before)
  })
  it('reloads only the Projects folders when projects change, in place and in the background', async () => {
    const { f, view } = await opened()
    const loads = f.find('Loads'), daily = f.find('Daily.dtsx')
    f.explorer.select(daily)
    f.state.catalog.folders.Finance.projects.Nightly = ['Nightly.dtsx']
    const before = f.sent.length
    view.tick(fingerprints({ projectsChecksum: 7, projectsCount: 2 }))
    await settle()
    expect(f.loads(before)).toEqual(['ssisProjects'])
    expect(f.labels()).toContain('          Nightly')
    // Loads kept its node, its expansion and the selection below it; a background reconcile tells nobody to reload databases.
    expect(f.find('Loads')).toBe(loads)
    expect(f.explorer.node(loads)!.expanded).toBe(true)
    expect(f.explorer.getSnapshot().selected).toBe(daily)
    expect(f.emitted.filter(event => event.type === 'explorer.refreshed')).toEqual([])
  })
  it('reloads the environments when a variable changes, so their counts follow', async () => {
    const { f, view } = await opened()
    f.state.catalog.folders.Finance.environments.Test = 3
    const before = f.sent.length
    view.tick(fingerprints({ variablesChecksum: 5, variablesCount: 3 }))
    await settle()
    expect(f.loads(before)).toEqual(['ssisEnvironments'])
    expect(f.labels()).toContain('          Test (3 variables)')
  })
  it('reloads the Projects folder deeply when its packages change too, and the packages alone otherwise', async () => {
    const { f, view } = await opened()
    f.state.catalog.folders.Finance.projects.Loads.push('Weekly.dtsx')
    let before = f.sent.length
    view.tick(fingerprints({ packagesCount: 2 }))
    await settle()
    expect(f.loads(before)).toEqual(['ssisPackages'])
    expect(f.labels()).toContain('              Weekly.dtsx')
    f.state.catalog.folders.Finance.projects.Loads.push('Monthly.dtsx')
    f.state.catalog.folders.Finance.projects.Archive = []
    before = f.sent.length
    view.tick(fingerprints({ packagesCount: 3, projectsCount: 2 }))
    await settle()
    // One deep reconcile of Projects: it lists the projects, then reloads the expanded Loads and its Packages below.
    expect(f.loads(before).sort()).toEqual(['ssisPackages', 'ssisProject:Loads', 'ssisProjects'])
    expect(f.labels()).toEqual(expect.arrayContaining(['              Monthly.dtsx', '          Archive']))
    expect(f.explorer.node(f.find('Loads'))!.expanded).toBe(true)
  })
  it('reloads SSISDB deeply when folders change, keeping the folders that stay open', async () => {
    const { f, view } = await opened()
    f.state.catalog.folders.Sales = { projects: {}, environments: {} }
    f.state.catalog.folders.Finance.projects.Loads.push('Weekly.dtsx')
    const finance = f.find('Finance')
    const before = f.sent.length
    view.tick(fingerprints({ foldersCount: 2, packagesCount: 2 }))
    await settle()
    expect(f.loads(before)[0]).toBe('ssisCatalog:SSISDB')
    expect(f.labels()).toEqual(expect.arrayContaining(['      Sales', '              Weekly.dtsx']))
    expect(f.find('Finance')).toBe(finance)
    expect(f.explorer.node(finance)!.expanded).toBe(true)
  })
  it('reloads nothing for references, parameters or catalog properties, which no tree row shows', async () => {
    const { f, view } = await opened()
    const before = f.sent.length
    view.tick(fingerprints({ referencesChecksum: 1, parametersCount: 9, propertiesChecksum: 2 }))
    await settle()
    expect(f.sent.length).toBe(before)
    expect(catalogFingerprints.filter(fingerprint => !fingerprint.reloads.kinds && !fingerprint.reloads.folders).map(fingerprint => fingerprint.id)).toEqual(['references', 'parameters', 'properties'])
  })
  it('compares a new view\'s first sample with the last one seen, so what changed while SSISDB was closed still reloads', async () => {
    const { f } = await opened()
    f.explorer.collapse(f.find('SSISDB'))
    await settle()
    expect(f.views[0].disposed).toBe(true)
    f.state.catalog.folders.Finance.environments.Prod = 1
    f.explorer.expand(f.find('SSISDB'))
    await settle()
    const view = f.views[1]
    const before = f.sent.length
    view.tick(fingerprints({ environmentsCount: 2 }))
    await settle()
    expect(f.loads(before)).toEqual(['ssisEnvironments'])
    expect(f.labels()).toContain('          Prod (1 variables)')
  })
  it('takes SSISDB away when the catalog no longer exists, which ends its view', async () => {
    const { f, view } = await opened()
    f.state.exists = false
    const before = f.sent.length
    view.tick(undefined, [{ probe: 'ssis.catalogProbe', code: 'CATALOG_MISSING', message: 'This server has no SSIS Catalog (it may have been deleted).', retryInMs: 0, terminal: true }])
    await settle()
    expect(f.loads(before)).toEqual(['integrationServicesCatalogs'])
    expect(f.labels().slice(1)).toEqual(['  Integration Services Catalogs'])
    expect(view.disposed).toBe(true)
    // Another error is a value the next sample retries: nothing reloads.
    expect(f.probe.connections).toEqual([])
  })
  it('ignores other probe errors, and a sample with no status', async () => {
    const { f, view } = await opened()
    const before = f.sent.length
    view.tick(undefined, [{ probe: 'ssis.catalogProbe', code: 'BLOCKED', message: 'Another session held a lock this view needed for more than a second. It tries again.', retryInMs: 30_000, terminal: false }])
    view.tick(undefined)
    await settle()
    expect(f.sent.length).toBe(before)
    expect(view.disposed).toBe(false)
  })
  it('reloads a listing that was on its way when a change was seen once it answers, without restarting the user\'s load', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('Integration Services Catalogs', 'SSISDB', 'Finance')
    const view = f.views[0]
    view.tick(fingerprints())
    await settle()
    // The user's listing of Projects reads the catalog before a deploy commits, and answers after the probe saw the deploy.
    const release = f.hold('ssisProjects')
    const before = f.sent.length
    f.explorer.expand(f.find('Projects'))
    await settle()
    f.state.catalog.folders.Finance.projects.Nightly = ['Nightly.dtsx']
    view.tick(fingerprints({ projectsCount: 2, projectsChecksum: 7 }))
    await settle()
    expect(f.loads(before)).toEqual(['ssisProjects'])
    release()
    await settle()
    view.tick(fingerprints({ projectsCount: 2, projectsChecksum: 7 }))
    await settle()
    expect(f.loads(before)).toEqual(['ssisProjects', 'ssisProjects'])
    expect(f.labels()).toContain('          Nightly')
  })
  it('reloads SSISDB when folders changed while its own first listing was on its way', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('Integration Services Catalogs')
    const release = f.hold('ssisCatalog:SSISDB')
    f.explorer.expand(f.find('SSISDB'))
    await settle()
    const view = f.views[0]
    view.tick(fingerprints())
    f.state.catalog.folders.Sales = { projects: {}, environments: {} }
    view.tick(fingerprints({ foldersCount: 2, foldersChecksum: 7 }))
    await settle()
    release()
    await settle()
    expect(f.labels()).toEqual(expect.arrayContaining(['      Finance', '      Sales']))
  })
  it('reloads at once after Varia\'s own change and has the view sample now, and hands a document the last fingerprints', async () => {
    const { f, view } = await opened()
    expect(f.probe.fingerprints(cid(1))).toEqual(fingerprints())
    expect(f.probe.fingerprints(cid(2))).toBeUndefined()
    f.state.catalog.folders.Finance.environments.Prod = 1
    const before = f.sent.length
    f.probe.reload(cid(1), catalogFingerprints.filter(fingerprint => fingerprint.id === 'environments'))
    await settle()
    expect(f.loads(before)).toEqual(['ssisEnvironments'])
    expect(f.labels()).toContain('          Prod (1 variables)')
    // The sample it asks for becomes the baseline, so later samples compare with the catalog after the change.
    expect(view.refreshes).toBe(1)
    view.tick(fingerprints({ environmentsCount: 2 }))
    expect(f.probe.fingerprints(cid(1))?.get('environmentsCount')).toBe(2)
  })
})

describe('SsisTreeProbe: an empty catalog', () => {
  it('keeps watching an SSISDB with no folders, and gives it back its expander without opening it when one appears', async () => {
    const f = fixture()
    f.state.catalog.folders = {}
    f.connect()
    await settle()
    await f.open('Integration Services Catalogs', 'SSISDB')
    const ssisdb = f.explorer.node(f.find('SSISDB'))!
    // Listed empty, it collapsed and lost its expander, yet it is still the catalog the user opened.
    expect([ssisdb.expanded, ssisdb.hasChildren]).toEqual([false, false])
    expect(f.views).toHaveLength(1)
    f.views[0].tick(fingerprints({ foldersCount: 0 }))
    f.state.catalog.folders.Finance = { projects: {}, environments: {} }
    const before = f.sent.length
    f.views[0].tick(fingerprints())
    await settle()
    // A background reconcile never opens a node: SSISDB has its expander again and lists Finance when the user opens it.
    expect(f.sent.length).toBe(before)
    expect([ssisdb.expanded, ssisdb.hasChildren, ssisdb.load]).toEqual([false, true, 'none'])
    f.explorer.expand(ssisdb.id)
    await settle()
    expect(f.labels()).toContain('      Finance')
  })
})

/** A connection with SSISDB > Finance > Projects > Loads > Packages and Environments open, and the baseline sampled. */
async function openedCatalog() {
  const f = fixture()
  f.connect()
  await settle()
  await f.open('Integration Services Catalogs', 'SSISDB', 'Finance', 'Projects', 'Loads', 'Packages')
  await f.open('Environments')
  f.views[0].tick(fingerprints())
  await settle()
  return f
}

describe('SsisTreeProbe: a change that keeps every count', () => {
  it('reloads the Projects folder when only their checksum changes (a project renamed, or deployed again)', async () => {
    const f = await openedCatalog()
    const projects = f.state.catalog.folders.Finance.projects
    projects.Reloads = projects.Loads
    delete projects.Loads
    const before = f.sent.length
    f.views[0].tick(fingerprints({ projectsChecksum: 7 }))
    await settle()
    expect(f.loads(before)).toEqual(['ssisProjects'])
    expect(f.labels()).toContain('          Reloads')
    expect(f.labels()).not.toContain('          Loads')
  })
})

describe('SsisTreeProbe: only while SSISDB shows', () => {
  it('closes the view while a collapsed server row or Integration Services Catalogs folder hides SSISDB, and opens one when it shows again', async () => {
    const f = await openedCatalog()
    const [first] = f.views
    f.explorer.collapse(f.find('server-1.example'))
    await settle()
    expect(first.disposed).toBe(true)
    expect(f.probe.connections).toEqual([])
    // Nothing samples or loads for rows nobody can see.
    const before = f.sent.length
    first.tick(fingerprints({ projectsCount: 2, projectsChecksum: 7 }))
    await settle()
    expect(f.sent.length).toBe(before)
    f.explorer.expand(f.find('server-1.example'))
    await settle()
    expect(f.views).toHaveLength(2)
    f.explorer.collapse(f.find('Integration Services Catalogs'))
    await settle()
    expect(f.views[1].disposed).toBe(true)
    expect(f.probe.connections).toEqual([])
    f.explorer.expand(f.find('Integration Services Catalogs'))
    await settle()
    expect(f.views).toHaveLength(3)
    expect(f.probe.connections).toEqual([cid(1)])
  })
  it('keeps an empty SSISDB unwatched while its folder is collapsed', async () => {
    const f = fixture()
    f.state.catalog.folders = {}
    f.connect()
    await settle()
    await f.open('Integration Services Catalogs', 'SSISDB')
    expect(f.views).toHaveLength(1)
    f.explorer.collapse(f.find('Integration Services Catalogs'))
    await settle()
    expect(f.views[0].disposed).toBe(true)
  })
  it('reloads a listing hidden under a collapsed node only once that node is expanded again', async () => {
    const f = await openedCatalog()
    f.explorer.collapse(f.find('Finance'))
    await settle()
    f.state.catalog.folders.Finance.projects.Nightly = ['Nightly.dtsx']
    let before = f.sent.length
    f.views[0].tick(fingerprints({ projectsCount: 2, projectsChecksum: 7 }))
    await settle()
    expect(f.loads(before)).toEqual([])
    before = f.sent.length
    f.explorer.expand(f.find('Finance'))
    await settle()
    expect(f.loads(before)).toEqual(['ssisProjects'])
    expect(f.labels()).toContain('          Nightly')
  })
})

describe('SsisTreeProbe: a view that stopped', () => {
  it('opens the view again after a growing back-off when the server refused it for now (BUSY), while SSISDB stays open', async () => {
    const f = await openedCatalog()
    f.views[0].end('BUSY', 'Too many live views are reading this server at once. Retry in a moment.')
    expect(f.views[0].disposed).toBe(true)
    f.advance(ssisTreeRetryMs.first - 1)
    expect(f.views).toHaveLength(1)
    f.advance(1)
    expect(f.views).toHaveLength(2)
    f.views[1].end('BUSY')
    f.advance(ssisTreeRetryMs.first * 2 - 1)
    expect(f.views).toHaveLength(2)
    f.advance(1)
    expect(f.views).toHaveLength(3)
    // A view that sampled starts the back-off over; one that ended on its own is opened again too.
    f.views[2].tick(fingerprints())
    f.views[2].end()
    f.advance(ssisTreeRetryMs.first)
    expect(f.views).toHaveLength(4)
    expect(f.probe.connections).toEqual([cid(1)])
    expect(f.explorer.node(f.find('SSISDB'))!.note).toBeUndefined()
  })
  it('tries again a view the window refused (too many live views), and stops waiting once SSISDB closes', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('Integration Services Catalogs')
    f.refuse.next = { code: 'TOO_MANY_REQUESTS', message: 'This window has too many live views open.' }
    await f.open('SSISDB')
    expect(f.views).toHaveLength(1)
    expect(f.views[0].disposed).toBe(true)
    f.advance(ssisTreeRetryMs.first)
    expect(f.views).toHaveLength(2)
    expect(f.views[1].disposed).toBe(false)
    f.views[1].end('BUSY')
    f.explorer.collapse(f.find('SSISDB'))
    await settle()
    expect(f.pending.size).toBe(0)
    f.advance(ssisTreeRetryMs.max)
    expect(f.views).toHaveLength(2)
  })
  it('shows why on SSISDB when the view stops for good, never retries it alone, and tries again on Refresh or when SSISDB opens again', async () => {
    const f = await openedCatalog()
    const message = 'This login cannot read the SSIS Catalog. Ask for access to the catalog\'s database, or connect with a login that has it.'
    f.views[0].end('PERMISSION_DENIED', message)
    await settle()
    const ssisdb = f.find('SSISDB')
    expect(f.explorer.node(ssisdb)!.note).toEqual({ label: '(not updating)', sentence: 'Live updates stopped. ' + message + ' Refresh SSISDB to try again.' })
    expect(rowTooltip(f.explorer.node(ssisdb)!)).toContain(message)
    f.advance(10 * ssisTreeRetryMs.max)
    expect(f.views).toHaveLength(1)
    expect(f.probe.connections).toEqual([])
    // Refreshing SSISDB or anything in it tries again.
    f.explorer.refresh(f.find('Environments'))
    await settle()
    expect(f.views).toHaveLength(2)
    expect(f.explorer.node(ssisdb)!.note).toBeUndefined()
    f.views[1].end('LOGIN_FAILED', 'SQL Server refused this view\'s sign-in.')
    await settle()
    expect(f.explorer.node(ssisdb)!.note?.label).toBe('(not updating)')
    // So does refreshing the server.
    f.explorer.refresh(f.find('server-1.example'))
    await settle()
    expect(f.views).toHaveLength(3)
    f.views[2].end('PERMISSION_DENIED', message)
    await settle()
    // Closing SSISDB forgets why; opening it again tries again.
    f.explorer.collapse(ssisdb)
    await settle()
    expect(f.explorer.node(ssisdb)!.note).toBeUndefined()
    f.explorer.expand(ssisdb)
    await settle()
    expect(f.views).toHaveLength(4)
    expect(f.views[3].disposed).toBe(false)
  })
  it('tries a view that stopped for good again only on a refresh of SSISDB, of what is in it, of its folder or of its server', async () => {
    const f = fixture()
    f.state.serverFolders = ['databases', 'integrationServicesCatalogs']
    f.connect()
    await settle()
    await f.open('Integration Services Catalogs', 'SSISDB')
    f.views[0].end('PERMISSION_DENIED', 'This login cannot read the SSIS Catalog.')
    await settle()
    const ssisdb = f.find('SSISDB')
    // A refresh of another folder on the same server says nothing about the catalog: the note stays and nothing opens.
    f.explorer.refresh(f.find('Databases'))
    await settle()
    expect(f.emitted.some(event => event.type === 'explorer.refreshed' && event.nodeId === f.find('Databases'))).toBe(true)
    expect(f.views).toHaveLength(1)
    expect(f.explorer.node(ssisdb)!.note?.label).toBe('(not updating)')
    f.explorer.refresh(f.find('Integration Services Catalogs'))
    await settle()
    expect(f.views).toHaveLength(2)
    expect(f.explorer.node(ssisdb)!.note).toBeUndefined()
  })
  it('tries again after CATALOG_MISSING while the catalogs folder still lists SSISDB (the catalog dropped and created again)', async () => {
    const f = await openedCatalog()
    f.views[0].tick(undefined, [{ probe: 'ssis.catalogProbe', code: 'CATALOG_MISSING', message: 'This server has no SSIS Catalog (it may have been deleted).', retryInMs: 0, terminal: true }])
    f.views[0].end('CATALOG_MISSING', 'This server has no SSIS Catalog (it may have been deleted).')
    await settle()
    expect(f.labels()).toContain('    SSISDB')
    f.advance(ssisTreeRetryMs.first)
    expect(f.views).toHaveLength(2)
    expect(f.views[1].disposed).toBe(false)
  })
})
