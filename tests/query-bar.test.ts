import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseInfo } from '../src/shared/contracts'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import QueryBar from '../src/renderer/src/QueryBar'
import StandardToolbar from '../src/renderer/src/ShellToolbar'
import { lostHint, queryContextModel, toolbarMove, toolbarRescue, toolbarReturn, toolbarStop, type QueryContextInput } from '../src/renderer/src/query-context'
import type { LiveConnection } from '../src/renderer/src/services/connections'
import { densities, densityUse } from '../src/shared/theme/metrics'
import { connectionColorNames } from '../src/shared/theme/connection-colors'
import { stylesheetRules } from './fixtures/css-rules'
import { documentUri } from '../src/renderer/src/services/documents'
import { EditorStatusService } from '../src/renderer/src/services/editor-status'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'
import { connectionTargetOptions } from '../src/shared/connection-targets'
import { ConnectionTargetService } from '../src/renderer/src/services/connection-targets'
import { TargetService } from '../src/renderer/src/services/targets'

// Server rendering reads a store through getServerSnapshot, which the services leave to their client snapshot.
vi.mock('react', async original => {
  const react = await original<typeof import('react')>()
  return { ...react, useSyncExternalStore: <T>(subscribe: (listener: () => void) => () => void, snapshot: () => T, server?: () => T) => react.useSyncExternalStore(subscribe, snapshot, server ?? snapshot) }
})

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const live = (id: string, fields: Partial<LiveConnection> = {}): LiveConnection => ({ ...connectionInfo(id), options: connectionOptions, ...fields })
const databases = (...names: string[]): DatabaseInfo[] => names.map(name => ({ name, isSystem: name === 'master', isSnapshot: false }))
const input = (fields: Partial<QueryContextInput> = {}): QueryContextInput =>
  ({ connectionId: 'a', database: 'AppData', connections: [live('a'), live('b')], databases: databases('master', 'AppData'), query: true, running: false, busy: false, ...fields })

describe('query context lists', () => {
  it('keeps the disconnecting query server as a disabled value and excludes other disconnecting choices', () => {
    const closing = (id: string) => live(id, { lifecycle: { state: 'disconnecting', attemptId: crypto.randomUUID(), handle: { id, generation: 1 } } })
    const model = queryContextModel(input({ connections: [closing('a'), closing('b'), live('c')] }))
    expect(model.live).toBe(false)
    expect(model.databaseDisabled).toBe(true)
    expect(model.databases).toEqual(['AppData'])
    expect(model.servers.map(server => [server.id, server.disabled])).toEqual([['', false], ['a', true], ['c', false]])
  })
  it('list Disconnected and every live server, and the databases of the query\'s own one', () => {
    const model = queryContextModel(input({ connections: [live('a', { displayName: 'Orders' }), live('b')] }))
    expect(model.servers).toEqual([
      { id: '', label: 'Disconnected', shortLabel: 'Disconnected', disabled: false },
      { id: 'a', label: 'Orders (a.example)', shortLabel: 'Orders', disabled: false },
      { id: 'b', label: 'b.example', shortLabel: 'b.example', disabled: false }
    ])
    expect([model.live, model.serverDisabled, model.databaseDisabled, model.database, model.serverName]).toEqual([true, false, false, 'AppData', 'Orders (a.example)'])
    expect(model.databases).toEqual(['master', 'AppData'])
  })
  it('keep the query\'s database listed while the server\'s list lacks it', () => {
    expect(queryContextModel(input({ databases: [] })).databases).toEqual(['AppData'])
    expect(queryContextModel(input({ database: 'Dropped' })).databases).toEqual(['Dropped', 'master', 'AppData'])
  })
  it('show a lost connection only for its own query, where it cannot be chosen again', () => {
    const connections = [live('a', { lost: true }), live('b', { lost: true }), live('c')]
    const model = queryContextModel(input({ connections }))
    expect(model.servers.map(server => [server.id, server.label, server.disabled])).toEqual([['', 'Disconnected', false], ['a', 'a.example Disconnected', true], ['c', 'c.example', false]])
    // A lost query can still be moved to a live server, but lists no databases of its lost one.
    expect([model.live, model.serverDisabled, model.databaseDisabled, model.databases]).toEqual([false, false, true, ['AppData']])
  })
  it('lock both lists while the query runs or a document task is under way, and for documents that are not queries', () => {
    for (const fields of [{ running: true }, { busy: true }, { query: false }]) {
      const model = queryContextModel(input(fields))
      expect([model.serverDisabled, model.databaseDisabled], JSON.stringify(fields)).toEqual([true, true])
    }
    const disconnected = queryContextModel(input({ connectionId: undefined, database: 'master' }))
    expect([disconnected.connection, disconnected.serverDisabled, disconnected.databaseDisabled, disconnected.databases]).toEqual([undefined, false, true, ['master']])
  })
})

describe('query bar keyboard', () => {
  const controls = (...disabled: boolean[]) => disabled.map((value, index) => ({ name: index, disabled: value }))
  it('keeps one tab stop: the control used last while enabled, else the first enabled one', () => {
    const [execute, cancel, server, database] = controls(false, true, false, false)
    const all = [execute, cancel, server, database]
    expect(toolbarStop(all, undefined)).toBe(execute)
    expect(toolbarStop(all, database)).toBe(database)
    expect(toolbarStop(all, cancel)).toBe(execute)
    expect(toolbarStop(controls(true, true), undefined)).toBeUndefined()
  })
  it('moves with the arrow keys, Home and End over the enabled controls, wrapping at the ends', () => {
    const all = controls(false, true, false, false)
    expect(toolbarMove(all, all[0], 'ArrowRight')).toBe(all[2])
    expect(toolbarMove(all, all[3], 'ArrowRight')).toBe(all[0])
    expect(toolbarMove(all, all[0], 'ArrowLeft')).toBe(all[3])
    expect(toolbarMove(all, all[2], 'Home')).toBe(all[0])
    expect(toolbarMove(all, all[0], 'End')).toBe(all[3])
    expect(toolbarMove(all, all[0], 'ArrowDown')).toBeUndefined()
  })
  it('hands focus from a control that turns disabled to the nearest enabled one, the earlier when two are as near', () => {
    // Execute starts the query and turns disabled: Cancel takes focus. Cancel ends it: Execute takes focus back.
    const running = controls(true, false, true, true)
    expect(toolbarRescue(running, running[0])).toBe(running[1])
    const done = controls(false, true, false, false)
    expect(toolbarRescue(done, done[1])).toBe(done[0])
    expect(toolbarRescue(controls(true, true), controls(true)[0])).toBeUndefined()
  })
  it('waits while a document task disables every control, then gives focus back to the control that lost it', () => {
    // Choosing a server ends the query's session first: every control is disabled until that task ends.
    const all = controls(true, true, true, true)
    expect(toolbarReturn(all, all[2])).toBeUndefined()
    const done = controls(false, true, false, false)
    expect(toolbarReturn(done, done[2])).toBe(done[2])
    // Still disabled once the others are enabled again: the nearest enabled control takes it.
    const locked = controls(false, true, true, false)
    expect(toolbarReturn(locked, locked[2])).toBe(locked[3])
  })
})

describe('query bar', () => {
  function fixture() {
    const value = workbenchFixture({ platform: 'win32' })
    const registry = new ConnectionTargetService(), targets = new TargetService(value.documents, value.queries, value.connections, value.files, registry)
    cleanups.push(value.dispose)
    value.api.push(readyBackend())
    // Server rendering has no theme store: a connection colour is drawn as the theme would give it.
    const theme = { subscribe: () => () => {}, getSnapshot: () => 0, accent: (color: string | undefined) => color ? `var(--varia-connection-${color})` : undefined }
    const editorStatus = new EditorStatusService(callback => callback())
    cleanups.push(() => editorStatus.dispose())
    const workbench = { ...value, targets, theme, editorStatus } as unknown as Workbench
    const render = (element: ReactElement) => renderToStaticMarkup(createElement(WorkbenchProvider, { workbench, children: element }))
    return { ...value, targets, registry, render, editorStatus }
  }
  it('shows a remembered disconnected target and its environment while preserving the unavailable database', () => {
    const { documents, registry, render, api } = fixture()
    const targetId = '00000000-0000-4000-8000-000000000001'
    registry.add({ id: targetId, options: connectionTargetOptions(connectionOptions), details: { displayName: 'Reporting', environment: 'Production', color: '#123456', autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true })
    const query = documents.create('restored.sql', '', 'Unavailable')
    documents.update(query.id, { targetId, attachWanted: true, lastServer: 'obsolete-server' })
    const html = render(createElement(QueryBar))
    expect(html).toContain('Production environment')
    expect(html).toContain(`<option value="remembered:${targetId}" disabled="" title="Reporting (server.example) Disconnected" selected="">Reporting Disconnected</option>`)
    expect(html).toContain('title="Server: Reporting (server.example) Disconnected"')
    expect(html).toContain('<option value="Unavailable" selected="">Unavailable</option>')
    expect(html).toContain('aria-label="Query database" title="Database: Unavailable" disabled=""')
    expect(api.execute).not.toHaveBeenCalled()
  })
  it('is an ARIA toolbar with Execute, Cancel and the connection pill: colour, environment tag, friendly alias and full dropdown details', () => {
    const { connections, documents, render } = fixture()
    connections.add({ ...connectionInfo('prod'), color: 'red', displayName: 'Orders' }, { ...connectionOptions, color: 'red', displayName: 'Orders', environment: 'Production' })
    connections.add({ ...connectionInfo('stg'), color: 'blue', displayName: 'Staging ERP' }, { ...connectionOptions, server: 'stg.example', color: 'blue', displayName: 'Staging ERP', environment: 'Staging' })
    documents.create('a.sql', 'SELECT 1', 'AppData', 'prod')
    const html = render(createElement(QueryBar))
    // data-query-bar gives queryBarFocus, so F5, which Execute shows, runs the query from the bar too.
    expect(html).toMatch(/^<div class="query-bar" role="toolbar" aria-label="SQL Editor" data-query-bar="" data-connection-accent="" style="--query-bar-accent:var\(--varia-connection-red\)">/)
    // Execute is the bar's only filled button and names its key; Cancel waits for a running query.
    expect(html).toMatch(/<button type="button" class="ui-button query-bar-action execute primary" aria-label="Execute" aria-keyshortcuts="F5" title="Execute \(F5\)">.*<kbd aria-hidden="true">F5<\/kbd><\/button>/)
    expect(html).toMatch(/<button type="button" class="ui-button query-bar-action" aria-label="Cancel" aria-keyshortcuts="Alt\+Pause" disabled="" title="Cancel Executing Query \(Alt\+Pause\)">/)
    const pill = html.slice(html.indexOf('<div class="query-connection"'))
    expect(pill).toMatch(/^<div class="query-connection" role="group" aria-label="Connection" data-connection-accent="" style="--query-bar-accent:var\(--varia-connection-red\)"><span class="connection-swatch" style="background:var\(--varia-connection-red\)" aria-hidden="true"><\/span>/)
    expect(pill).toContain('<span class="query-bar-environment"><span class="visually-hidden">Environment: </span><span class="environment-tag" data-place="query" data-tone="critical">')
    expect(pill).toContain('title="Orders (prod.example): Production environment"')
    // The collapsed selected option shows the friendly alias while other options and the tooltip keep the full host.
    expect(pill).toMatch(/<select id="query-server" class="ui-field" aria-label="Query server" aria-description="Production environment" title="Server: Orders \(prod.example\)">.*<option value="prod" title="Orders \(prod.example\)" selected="">Orders<\/option><option value="stg">Staging ERP \(stg.example\)<\/option><\/select>/)
    expect(pill).toMatch(/<select id="query-database" class="ui-field" aria-label="Query database" title="Database: AppData"><option value="AppData" selected="">AppData<\/option><\/select>/)
  })
  it('scopes per-tab QueryBars in split groups with unique IDs, independent connection tinting and execution state', () => {
    const { connections, documents, queries, render } = fixture()
    connections.add({ ...connectionInfo('prod'), color: 'red', displayName: 'Production ERP' }, { ...connectionOptions, color: 'red', displayName: 'Production ERP', environment: 'Production' })
    connections.add({ ...connectionInfo('stg'), color: 'blue', displayName: 'Staging Analytics' }, { ...connectionOptions, server: 'stg.example', color: 'blue', displayName: 'Staging Analytics', environment: 'Staging' })
    const q1 = documents.create('prod.sql', 'SELECT 1', 'AppData', 'prod')
    const q2 = documents.create('stg.sql', 'SELECT 2', 'AnalyticsStg', 'stg')
    documents.update(q1.id, { includeActualPlan: true })
    documents.activate(q1.id)
    vi.spyOn(queries, 'getSnapshot').mockReturnValue({ [q1.id]: { running: { queryId: 'run-1', connectionId: 'prod', startedAt: 1 } } })
    vi.spyOn(queries, 'isRunning').mockImplementation(id => id === q1.id)
    const html1 = render(createElement(QueryBar, { tabId: q1.id }))
    const html2 = render(createElement(QueryBar, { tabId: q2.id }))
    expect(html1).toContain(`id="query-server-${q1.id}"`)
    expect(html1).toContain(`id="query-database-${q1.id}"`)
    expect(html2).toContain(`id="query-server-${q2.id}"`)
    expect(html2).toContain(`id="query-database-${q2.id}"`)
    expect(html1).toContain('--query-bar-accent:var(--varia-connection-red)')
    expect(html2).toContain('--query-bar-accent:var(--varia-connection-blue)')
    expect(html1).toMatch(/aria-label="Execute"[^>]*disabled=""/)
    expect(html1).toMatch(/aria-label="Cancel"[^>]*title="Cancel Executing Query \(Alt\+Pause\)">/)
    expect(html1).not.toMatch(/aria-label="Cancel"[^>]*disabled=""/)
    expect(html1).toMatch(/aria-label="Include Actual Execution Plan"[^>]*aria-pressed="true"/)
    expect(html2).not.toMatch(/aria-label="Execute"[^>]*disabled=""/)
    expect(html2).toMatch(/aria-label="Cancel"[^>]*disabled=""/)
    expect(html2).toMatch(/aria-label="Include Actual Execution Plan"[^>]*aria-pressed="false"/)
    expect(html1).toContain('<option value="prod" title="Production ERP (prod.example)" selected="">Production ERP</option>')
    expect(html1).toContain('<option value="stg">Staging Analytics (stg.example)</option>')
    expect(html2).toContain('<option value="stg" title="Staging Analytics (stg.example)" selected="">Staging Analytics</option>')
    expect(html2).toContain('<option value="prod">Production ERP (prod.example)</option>')
    // Even when a non-query tab is active, a visible SQL split group keeps its own enabled QueryBar.
    const xml = documents.openText({ name: 'result.xml', text: '<a/>', kind: 'xml' })
    expect(documents.active?.id).toBe(xml.id)
    const html2WithXmlActive = render(createElement(QueryBar, { tabId: q2.id }))
    expect(html2WithXmlActive).not.toMatch(/aria-label="Execute"[^>]*disabled=""/)
    expect(html2WithXmlActive).toContain('<option value="AnalyticsStg" selected="">AnalyticsStg</option>')
  })
  it('tints QueryBar and its connection pill for every preset and custom hex color, and stays neutral when unset', () => {
    const { connections, documents, render } = fixture()
    for (const color of [...connectionColorNames, '#2266aa']) {
      const id = `conn-${color}`
      connections.add({ ...connectionInfo(id), color }, { ...connectionOptions, server: `${id}.example`, color })
      const doc = documents.create(`${id}.sql`, 'SELECT 1', 'master', id)
      const html = render(createElement(QueryBar, { tabId: doc.id }))
      expect(html, color).toContain(`data-connection-accent="" style="--query-bar-accent:var(--varia-connection-${color})"`)
    }
    const plain = documents.create('plain.sql', 'SELECT 1', 'master')
    const plainHtml = render(createElement(QueryBar, { tabId: plain.id }))
    expect(plainHtml).not.toContain('data-connection-accent')
    expect(plainHtml).not.toContain('--query-bar-accent')
  })
  it('gives each database its exact name as the option\'s value, spaces and all', () => {
    const { connections, documents, render } = fixture()
    connections.add(connectionInfo('a'), connectionOptions)
    // An option's text has its spaces collapsed and trimmed when it has no value: this one would read "Sales 2024".
    documents.create('a.sql', '', 'Sales  2024', 'a')
    const html = render(createElement(QueryBar))
    expect(html).toContain('<option value="Sales  2024" selected="">Sales  2024</option>')
    expect(html).not.toContain('aria-description')
  })
  it('labels the execution selection in both toolbar layouts and rejects stale metadata from another query', () => {
    const { documents, render, editorStatus } = fixture()
    const query = documents.create('a.sql', 'SELECT 1\nSELECT 2', 'master')
    vi.spyOn(editorStatus, 'getSnapshot').mockReturnValue({ line: 2, column: 9, character: 9, eol: 'lf', selection: { uri: documentUri(query.id), startLine: 1, endLine: 2 } })
    for (const bar of [createElement(QueryBar), createElement(StandardToolbar, { variant: 'classic' })]) {
      const html = render(bar)
      expect(html).toContain('aria-label="Execute selection"')
      expect(html).toContain('Execute selection · Lines 1–2 (F5)')
      expect(html).toContain('<span class="query-scope">Lines 1–2</span>')
    }
    documents.create('b.sql', '', 'master')
    const html = render(createElement(QueryBar))
    expect(html).toContain('aria-label="Execute"')
    expect(html).toContain('<span class="query-scope">Entire query</span>')
  })
  it('names the lost connection on Execute, and shows no colour or tag for a disconnected query', () => {
    const { connections, documents, render, api } = fixture()
    connections.add(connectionInfo('a'), connectionOptions)
    documents.create('a.sql', '', 'master', 'a')
    api.push({ status: 'restarting', generation: 1, retryInMs: 0, lost: { generation: 1, reason: 'crash', connections: 1, queries: 0 } })
    const lost = render(createElement(QueryBar))
    expect(lost).toContain(`title="${lostHint.replaceAll("'", '&#x27;')}"`)
    expect(lost).toContain('data-lost="true"')
    expect(lost).toContain('<option value="a" disabled="" selected="">a.example Disconnected</option>')
    documents.create('b.sql', '', 'master')
    const disconnected = render(createElement(QueryBar))
    expect(disconnected).not.toContain('connection-swatch')
    expect(disconnected).not.toContain('environment-tag')
    expect(disconnected).toMatch(/<select id="query-database" class="ui-field" aria-label="Query database" title="Database: master" disabled="">/)
    expect(disconnected).toContain('title="This query is not connected"')
  })
  it('leaves the header\'s Standard toolbar the file commands grouped by dividers, and marks Save when the active tab is dirty', () => {
    const { connections, documents, render } = fixture()
    connections.add(connectionInfo('a'), connectionOptions)
    const doc = documents.create('a.sql', '', 'master', 'a')
    const clean = render(createElement(StandardToolbar, { variant: 'header' }))
    expect([...clean.matchAll(/aria-label="([^"]+)"/g)].map(match => match[1])).toEqual(['Standard', 'Connect', 'New query', 'Open', 'Save', 'Save All', 'Activity Monitor'])
    expect(clean.match(/class="toolbar-divider"/g)).toHaveLength(2)
    expect(clean).not.toContain('save-dirty-dot')
    expect(clean).not.toContain('<select')
    documents.markUnsaved(doc.id)
    const dirty = render(createElement(StandardToolbar, { variant: 'header' }))
    expect(dirty).toContain('save-dirty-dot')
    const classic = render(createElement(StandardToolbar, { variant: 'classic' }))
    expect(classic).toContain('<label class="context-field" for="query-server">Server</label><select id="query-server" class="ui-field" aria-label="Query server"')
    expect(classic).toContain('<label class="context-field" for="query-database">Database</label><select id="query-database" class="ui-field" aria-label="Query database"')
    expect(classic).toMatch(/>Execute<kbd>F5<\/kbd><\/button>/)
  })
  it('sizes the bar and its controls from the density tokens, and gives way at narrow widths without wrapping', () => {
    expect(densityUse.bar).toContain('.query-bar')
    expect(densityUse.control).toContain('.query-connection')
    const rules = stylesheetRules()
    const value = (selector: string, property: string, at: string[] = []) => rules.find(rule => rule.selector === selector && rule.at.join(' ') === at.join(' ') && rule.declarations.some(item => item.property === property))
      ?.declarations.find(item => item.property === property)?.value
    expect([value('.query-bar', 'container-type'), value('.query-bar', 'overflow'), value('.query-connection', 'margin-left')]).toEqual(['inline-size', 'hidden', 'auto'])
    expect(value('.query-bar-label', 'display', ['@container (max-width: 500px)'])).toBe('none')
    expect(value('.query-bar-action.execute kbd', 'display', ['@container (max-width: 960px)'])).toBe('none')
    // The bar sets its own size, so the tag's 12em is as wide as on the status bar; the tag shrinks inside its wrapper
    // rather than running under the server list, and the lists give way first, by weight, down to their minimum.
    expect(value('.query-bar', 'font-size')).toBe('var(--varia-size-sm)')
    expect(value('.environment-tag[data-place="query"]', 'flex')).toBe('0 1 auto')
    expect([value('.query-connection select.ui-field', 'flex'), value('.query-connection select.ui-field', 'min-width')]).toEqual(['0 1000 auto', '64px'])
    expect(value('.ui-field', 'height')).toBe('var(--ui-control-height)')
    expect(value('.ui-button', 'min-height')).toBe('var(--ui-control-height)')
    // Tabs sit above per-query bars: .query-bar-spacer is retired, and 2-line tabs use 40/44 px with a fixed 20 px Pin slot.
    expect(rules.some(rule => rule.selector === '.query-bar-spacer')).toBe(false)
    expect([densities.compact.documentTab, densities.comfortable.documentTab]).toEqual([40, 44])
    expect([value('.tab-pin, .tab-close', 'width'), value('.tab-pin, .tab-close', 'height')]).toEqual(['20px', '20px'])
    expect([value('.query-tab:not([data-pinned]) .tab-pin', 'opacity'), value('.query-tab:not([data-pinned]):hover .tab-pin', 'opacity'), value('.query-tab[data-pinned] .tab-pin', 'opacity')]).toEqual(['0.52', '1', '1'])
    expect([value('.query-bar[data-connection-accent]::before', 'opacity'), value(':root[data-theme-type="light"] .query-bar[data-connection-accent]::before', 'opacity')]).toEqual(['0.08', '0.065'])
    expect([value('.query-bar[data-connection-accent]::after', 'height'), value('.query-bar[data-connection-accent]::after', 'opacity'), value(':root[data-theme-type="light"] .query-bar[data-connection-accent]::after', 'opacity')]).toEqual(['1px', '0.38', '0.32'])
    expect(value('.query-connection[data-connection-accent]::before', 'opacity')).toBe('0.42')
  })
  it('gives every list an opaque fill: Chromium draws an open list on its background, white for a transparent one', () => {
    // In Dark the options keep the list's light text, which on white is all but invisible.
    const targetsSelect = (selector: string) => selector.split(',').some(part => /(^|[\s>+~])select(?![\w-])[^\s>+~]*$/.test(part.trim()))
    const clear = stylesheetRules().filter(rule => targetsSelect(rule.selector) && rule.declarations.some(item => /^background(-color)?$/.test(item.property) && /^(transparent|none)\b|rgba\([^)]*,\s*0\)/.test(item.value)))
    expect(clear.map(rule => rule.selector)).toEqual([])
    expect(stylesheetRules().find(rule => rule.selector === '.ui-field' && rule.declarations.some(item => item.property === 'background'))?.declarations.find(item => item.property === 'background')?.value).toBe('var(--varia-input-background)')
  })
})
