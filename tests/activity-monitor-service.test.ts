import { afterEach, describe, expect, it } from 'vitest'
import { activityLiveProbes, paneProbes, pendingPanes } from '../src/shared/activity/catalog'
import { defaultSettings } from '../src/shared/settings/catalog'
import { initialMonitor, monitorTitle, probeSettings, shownPanes } from '../src/renderer/src/activity/ActivityMonitorService'
import { cyclePanel } from '../src/renderer/src/contributions/activity'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

// ActivityMonitorService and its commands over the workbench fixture: LiveService is a stand-in that records each view
// (tests/fixtures/live-views.ts), so these check what the monitor asks the live layer for, not the samples.

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }

function monitorFixture(settings = {}) {
  const fixture = workbenchFixture({ settings })
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  return fixture
}
const serverNode = (connectionId: string, lost = false): ExplorerMenuNode => ({ id: 1, lost, kind: 'server', connectionId, label: connectionId, ref: { type: 'object', object: { kind: 'server', name: connectionId } } } as unknown as ExplorerMenuNode)

describe('Activity Monitor document', () => {
  it('opens one tab per connection, subscribed once to every activity probe, with only what a shown pane reads running', async () => {
    const { activity, documents, connect, liveViews, commands } = monitorFixture()
    connect(connectionInfo('c1'))
    const id = activity.open('c1')
    expect(documents.active).toMatchObject({ id, kind: 'activityMonitor', name: monitorTitle('c1.example'), dirty: false, connectionId: 'c1' })
    expect(documents.active?.name).toBe('c1.example - Activity Monitor')
    expect(liveViews.views).toHaveLength(1)
    expect(liveViews.last.spec).toEqual({
      connectionId: 'c1', source: 'activity',
      // Every pane's grid is still to come, so only the tiles' overview samples; the others wait, paused, for their panes.
      probes: [{ probe: 'activity.overview', intervalMs: 2000, paused: false }, { probe: 'activity.sessions', intervalMs: 2000, paused: true }, { probe: 'activity.resources', intervalMs: 5000, paused: true }]
    })
    expect(liveViews.last.owner.key).toBe(`tab:${id}`)
    // Opening it again activates the same tab and subscribes nothing new; another server gets its own.
    documents.create('q.sql', '', 'master', 'c1')
    expect(activity.open('c1')).toBe(id)
    expect(documents.getSnapshot().activeId).toBe(id)
    connect(connectionInfo('c2'))
    expect(activity.open('c2')).not.toBe(id)
    expect(liveViews.views.map(view => view.spec.connectionId)).toEqual(['c1', 'c2'])
    // A monitor has nothing to save, so Save is not offered on it.
    expect(commands.isEnabled('file.save')).toBe(false)
    expect(commands.isEnabled('file.save', { tabId: id })).toBe(false)
    await settled()
  })
  it('leaves Save on every other tab while a monitor is active, as a tab menu offers it', () => {
    const { activity, documents, connect, commands } = monitorFixture()
    connect(connectionInfo('c1'))
    const query = documents.create('q.sql', '', 'master', 'c1').id
    expect(commands.isEnabled('file.save', { tabId: query })).toBe(true)
    activity.open('c1')
    expect(documents.active?.kind).toBe('activityMonitor')
    expect(commands.isEnabled('file.save', { tabId: query })).toBe(true)
  })
  it('says each threshold crossing once per monitor, even when its view is drawn again after a tab switch', () => {
    const { activity, connect } = monitorFixture()
    connect(connectionInfo('c1'))
    const id = activity.open('c1')
    const calm = [{ caption: 'Blocked Sessions' }, { caption: 'Waiting Tasks' }], blocked = [{ caption: 'Blocked Sessions', tone: 'critical' as const }, { caption: 'Waiting Tasks' }]
    expect(activity.noteTones(id, calm)).toBeUndefined()
    expect(activity.noteTones(id, blocked)).toBe('Blocked Sessions is above its critical threshold.')
    // The same readings again (another render, or the view mounted again on a tab switch) say nothing.
    expect(activity.noteTones(id, blocked)).toBeUndefined()
    expect(activity.noteTones(id, calm)).toBeUndefined()
    expect(activity.noteTones(id, blocked)).toBe('Blocked Sessions is above its critical threshold.')
    expect(activity.noteTones('nope', blocked)).toBeUndefined()
  })
  it('refuses a lost connection, and a server that is not connected', () => {
    const { activity, connect, connections, liveViews } = monitorFixture()
    connect(connectionInfo('c1'))
    connections.markLostBefore(2)
    expect(() => activity.open('c1')).toThrow('Reconnect it first.')
    expect(() => activity.open('nope')).toThrow('Connect to the server first.')
    expect(liveViews.views).toHaveLength(0)
  })
  it('picks the server: the menu node, the active document, the Object Explorer selection, or one picked; with none, the Connect dialog', async () => {
    const { commands, documents, connect, connections, quickInput, events } = monitorFixture()
    const requested: string[] = []
    events.subscribe(event => { if (event.type === 'activity.connectRequested') requested.push(event.type) })
    await commands.execute('activity.open', undefined, 'palette')
    expect(requested).toEqual(['activity.connectRequested'])
    connect(connectionInfo('c1'))
    connect(connectionInfo('c2'))
    // The server node's menu names its server.
    await commands.execute('activity.open', { target: { kind: 'explorer', node: serverNode('c2') } }, 'menu')
    expect(documents.active).toMatchObject({ kind: 'activityMonitor', connectionId: 'c2' })
    // A lost server's menu does not offer it.
    expect(commands.isEnabled('activity.open', { target: { kind: 'explorer', node: serverNode('c1', true) } })).toBe(false)
    // The active query's server.
    documents.create('q.sql', '', 'master', 'c1')
    await commands.execute('activity.open', undefined, 'palette')
    expect(documents.active).toMatchObject({ kind: 'activityMonitor', connectionId: 'c1' })
    // A disconnected query: the server selected in Object Explorer (the first one connected).
    documents.create('r.sql', '', 'master')
    await commands.execute('activity.open', undefined, 'palette')
    expect(documents.active).toMatchObject({ kind: 'activityMonitor', connectionId: 'c1' })
    // That server lost and two others live: the user picks one of them.
    connect(connectionInfo('c3', 2))
    connect(connectionInfo('c4', 2))
    connections.markLostBefore(2)
    documents.create('s.sql', '', 'master')
    await commands.execute('activity.open', undefined, 'palette')
    expect(quickInput.getSnapshot()).toMatchObject({ visible: true, ariaLabel: 'Activity Monitor' })
    expect(quickInput.getSnapshot().rows.map(row => row.item.id)).toEqual(['c3', 'c4'])
    quickInput.hide('cancel')
    // One live server left: it is the one.
    connections.remove('c4')
    await commands.execute('activity.open', undefined, 'palette')
    expect(documents.active).toMatchObject({ kind: 'activityMonitor', connectionId: 'c3' })
  })
  it('pauses and resumes the whole view, refreshes only while it runs, and says so in its context keys', async () => {
    const { activity, commands, connect, liveViews, context } = monitorFixture()
    connect(connectionInfo('c1'))
    const id = activity.open('c1')
    expect(context.getState()).toMatchObject({ activeDocumentIsActivityMonitor: true, activityPaused: false, activitySplit: true })
    await commands.execute('activity.refresh', undefined, 'keybinding')
    await commands.execute('activity.togglePause', undefined, 'toolbar')
    // getState is cached on the services' snapshots: the monitor's own store must be one of them.
    expect(context.getState()).toMatchObject({ activityPaused: true })
    expect(commands.isEnabled('activity.refresh')).toBe(false)
    activity.refresh(id)
    await commands.execute('activity.togglePause', { tabId: id }, 'toolbar')
    expect(context.getState()).toMatchObject({ activityPaused: false })
    expect(liveViews.last.calls).toEqual([{ method: 'refresh' }, { method: 'setUserPaused', paused: true }, { method: 'setUserPaused', paused: false }])
  })
  it('sends only the probes an interval changes, raised to each probe\'s floor', () => {
    const { activity, connect, liveViews } = monitorFixture()
    connect(connectionInfo('c1'))
    const id = activity.open('c1')
    activity.setInterval(id, 1)
    // Resources never sample more often than every 5 s, so going from 2 s to 1 s leaves them alone.
    expect(liveViews.last.calls).toEqual([{ method: 'setProbe', probe: 'activity.overview', patch: { intervalMs: 1000 } }, { method: 'setProbe', probe: 'activity.sessions', patch: { intervalMs: 1000 } }])
    liveViews.last.calls.length = 0
    activity.setInterval(id, 10)
    expect(liveViews.last.calls.map(call => call.method === 'setProbe' ? [call.probe, call.patch.intervalMs] : [])).toEqual([['activity.overview', 10_000], ['activity.sessions', 10_000], ['activity.resources', 10_000]])
    // Values the header does not offer are ignored.
    liveViews.last.calls.length = 0
    activity.setInterval(id, 7)
    expect([activity.get(id)?.intervalSeconds, liveViews.last.calls]).toEqual([10, []])
  })
  it('runs a probe only while a shown pane whose grid exists reads it', () => {
    expect(paneProbes(['processes', 'waits'], [])).toEqual(['activity.overview', 'activity.sessions', 'activity.resources'])
    expect(paneProbes(['recentQueries'], [])).toEqual(['activity.overview', 'activity.queries'])
    expect(paneProbes(['processes', 'waits'])).toEqual(['activity.overview'])
    expect(pendingPanes).toEqual(['processes', 'blocking', 'waits', 'fileIo', 'recentQueries', 'activeQueries'])
    const state = initialMonitor('m', 'server', defaultSettings)
    expect(shownPanes(state)).toEqual(['processes', 'waits'])
    expect(shownPanes({ ...state, split: false })).toEqual(['processes'])
    expect(probeSettings(state).map(entry => entry.probe)).toEqual([...activityLiveProbes])
  })
  it('keeps the panes apart, splits and unsplits, and expands at most two charts, the oldest giving way', () => {
    const { activity, connect, liveViews, context } = monitorFixture()
    connect(connectionInfo('c1'))
    const id = activity.open('c1')
    // SSMS's two charts are open first: % Processor Time and Waiting Tasks.
    expect(activity.get(id)).toMatchObject({ primary: 'processes', secondary: 'waits', split: true, expanded: [0, 1], windowMinutes: 15 })
    activity.setPane(id, 'secondary', 'processes')
    expect(activity.get(id)).toMatchObject({ primary: 'waits', secondary: 'processes' })
    activity.toggleSplit(id)
    expect([activity.get(id)?.split, context.getState().activitySplit]).toEqual([false, false])
    // Pane changes while every grid is pending start no SQL.
    expect(liveViews.last.calls).toEqual([])
    activity.toggleTile(id, 4)
    expect(activity.get(id)?.expanded).toEqual([1, 4])
    activity.toggleTile(id, 1)
    expect(activity.get(id)?.expanded).toEqual([4])
    activity.toggleTile(id, 99)
    activity.setWindow(id, 60)
    activity.setWindow(id, 7)
    activity.setSplitRatio(id, 0.9)
    expect(activity.get(id)).toMatchObject({ expanded: [4], windowMinutes: 60, splitRatio: 0.75 })
  })
  it('starts a new monitor from the settings, a second pane equal to the first or none unsplit', () => {
    expect(initialMonitor('m', 's', { ...defaultSettings, 'activityMonitor.refreshIntervalSeconds': '5', 'activityMonitor.chartWindowMinutes': '60', 'activityMonitor.primaryPane': 'blocking', 'activityMonitor.secondaryPane': 'none' }))
      .toMatchObject({ intervalSeconds: 5, windowMinutes: 60, primary: 'blocking', split: false })
    expect(initialMonitor('m', 's', { ...defaultSettings, 'activityMonitor.primaryPane': 'waits', 'activityMonitor.secondaryPane': 'waits' })).toMatchObject({ primary: 'waits', secondary: 'processes', split: false })
  })
  it('closes like a tab, ending its view, and follows a reconnect only to its own server', async () => {
    const { activity, commands, connect, liveViews, documents, targets } = monitorFixture()
    connect(connectionInfo('c1'))
    const id = activity.open('c1')
    // Reconnect: a connection to another server does not take it, one to its own does.
    connect({ ...connectionInfo('other'), server: 'elsewhere.example' })
    targets.retarget('c1', 'other')
    expect(documents.get(id)?.connectionId).toBe('c1')
    connect({ ...connectionInfo('c1b'), server: 'C1.EXAMPLE' })
    targets.retarget('c1', 'c1b')
    expect(documents.get(id)?.connectionId).toBe('c1b')
    expect(activity.monitorOf('c1b')).toBe(id)
    await commands.execute('activity.close', undefined, 'keybinding')
    await settled()
    expect(documents.get(id)).toBeUndefined()
    expect(activity.get(id)).toBeUndefined()
    expect(liveViews.last.disposed).toBe(true)
  })
  it('subscribes again on Retry, and disposes every view with the service', () => {
    const { activity, connect, liveViews } = monitorFixture()
    connect(connectionInfo('c1'))
    const id = activity.open('c1')
    activity.setPaused(id, true)
    activity.retry(id)
    expect(liveViews.views.map(view => view.disposed)).toEqual([true, false])
    // The new view subscribes paused, as the monitor is, rather than pausing once it has opened.
    expect(liveViews.last.spec.paused).toBe(true)
    expect(liveViews.last.calls).toEqual([])
    expect(activity.get(id)?.generation).toBe(1)
    activity.dispose()
    expect(liveViews.last.disposed).toBe(true)
  })
})

describe('F6 in the Activity Monitor', () => {
  /** A region as the DOM answers querySelector: the first of its elements, in document order, that a selector matches. */
  class Region {
    readonly focused: string[] = []
    constructor(readonly name: string, readonly elements: readonly { readonly name: string; readonly matches: readonly string[] }[]) {}
    contains(node: unknown): boolean { return node === this }
    querySelector(selector: string) {
      const element = this.elements.find(item => selector.split(', ').some(part => item.matches.includes(part)))
      return element ? { focus: () => { this.focused.push(element.name) } } as unknown as HTMLElement : null
    }
  }
  const button = 'button:not(:disabled)', selectedTab = '[role="tab"][aria-selected="true"]'
  it('moves to the next or previous region that has something to focus, wrapping, onto its selected tab or first control', () => {
    const tiles = new Region('tiles', [{ name: 'cpu toggle', matches: [button] }]), charts = new Region('charts', [])
    // The selected tab comes after the first tab in the document, which is a button too.
    const pane = (name: string) => new Region(name, [{ name: 'Processes', matches: [button] }, { name: 'Resource Waits', matches: [button, selectedTab] }])
    const primary = pane('primary'), secondary = pane('secondary')
    const root = { querySelectorAll: () => [tiles, charts, primary, secondary] } as unknown as ParentNode
    cyclePanel(root, tiles as unknown as Element, 1)
    cyclePanel(root, secondary as unknown as Element, 1)
    cyclePanel(root, tiles as unknown as Element, -1)
    cyclePanel(root, null, 1)
    expect([tiles.focused, primary.focused, secondary.focused, charts.focused]).toEqual([['cpu toggle', 'cpu toggle'], ['Resource Waits'], ['Resource Waits'], []])
  })
})
