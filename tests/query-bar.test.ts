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
import { densityUse } from '../src/shared/theme/metrics'
import { stylesheetRules } from './fixtures/css-rules'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

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
  it('list Disconnected and every live server, and the databases of the query\'s own one', () => {
    const model = queryContextModel(input({ connections: [live('a', { displayName: 'Orders' }), live('b')] }))
    expect(model.servers).toEqual([{ id: '', label: 'Disconnected', disabled: false }, { id: 'a', label: 'Orders (a.example)', disabled: false }, { id: 'b', label: 'b.example', disabled: false }])
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
    expect(model.servers.map(server => [server.id, server.label, server.disabled])).toEqual([['', 'Disconnected', false], ['a', 'a.example (connection lost)', true], ['c', 'c.example', false]])
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
    cleanups.push(value.dispose)
    value.api.push(readyBackend())
    // Server rendering has no theme store: a connection colour is drawn as the theme would give it.
    const theme = { subscribe: () => () => {}, getSnapshot: () => 0, accent: (color: string | undefined) => color ? `var(--varia-connection-${color})` : undefined }
    const workbench = { ...value, theme } as unknown as Workbench
    const render = (element: ReactElement) => renderToStaticMarkup(createElement(WorkbenchProvider, { workbench, children: element }))
    return { ...value, render }
  }
  it('is an ARIA toolbar with Execute, Cancel and the connection pill: colour, environment tag, server and database', () => {
    const { connections, documents, render } = fixture()
    connections.add({ ...connectionInfo('prod'), color: 'red', displayName: 'Orders' }, { ...connectionOptions, color: 'red', displayName: 'Orders', environment: 'Production' })
    documents.create('a.sql', 'SELECT 1', 'AppData', 'prod')
    const html = render(createElement(QueryBar))
    // data-query-bar gives queryBarFocus, so F5, which Execute shows, runs the query from the bar too.
    expect(html).toMatch(/^<div class="query-bar" role="toolbar" aria-label="SQL Editor" data-query-bar="">/)
    // Execute is the bar's only filled button and names its key; Cancel waits for a running query.
    expect(html).toMatch(/<button type="button" class="query-bar-action execute primary" aria-label="Execute" aria-keyshortcuts="F5" title="Execute \(F5\)">.*<kbd aria-hidden="true">F5<\/kbd><\/button>/)
    expect(html).toMatch(/<button type="button" class="query-bar-action" aria-label="Cancel" aria-keyshortcuts="Alt\+Pause" disabled="" title="Cancel Executing Query \(Alt\+Pause\)">/)
    const pill = html.slice(html.indexOf('<div class="query-connection"'))
    expect(pill).toMatch(/^<div class="query-connection" role="group" aria-label="Connection"><span class="connection-swatch" style="background:var\(--varia-connection-red\)" aria-hidden="true"><\/span>/)
    expect(pill).toContain('<span class="query-bar-environment"><span class="visually-hidden">Environment: </span><span class="environment-tag" data-place="query" data-tone="critical">')
    expect(pill).toContain('title="Orders (prod.example): Production environment"')
    // The tag is no control: the server list, which the toolbar's keys reach, describes the environment.
    expect(pill).toMatch(/<select id="query-server" aria-label="Query server" aria-description="Production environment" title="Server: Orders \(prod.example\)">.*<option value="prod" selected="">Orders \(prod.example\)<\/option><\/select>/)
    expect(pill).toMatch(/<select id="query-database" aria-label="Query database" title="Database: AppData"><option value="AppData" selected="">AppData<\/option><\/select>/)
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
  it('names the lost connection on Execute, and shows no colour or tag for a disconnected query', () => {
    const { connections, documents, render, api } = fixture()
    connections.add(connectionInfo('a'), connectionOptions)
    documents.create('a.sql', '', 'master', 'a')
    api.push({ status: 'restarting', generation: 1, retryInMs: 0, lost: { generation: 1, reason: 'crash', connections: 1, queries: 0 } })
    const lost = render(createElement(QueryBar))
    expect(lost).toContain(`title="${lostHint.replaceAll("'", '&#x27;')}"`)
    expect(lost).toContain('data-lost="true"')
    expect(lost).toContain('<option value="a" disabled="" selected="">a.example (connection lost)</option>')
    documents.create('b.sql', '', 'master')
    const disconnected = render(createElement(QueryBar))
    expect(disconnected).not.toContain('connection-swatch')
    expect(disconnected).not.toContain('environment-tag')
    expect(disconnected).toMatch(/<select id="query-database" aria-label="Query database" title="Database: master" disabled="">/)
    expect(disconnected).toContain('title="This query is not connected"')
  })
  it('leaves the header\'s Standard toolbar the file commands; the classic toolbar keeps the global lists', () => {
    const { connections, documents, render } = fixture()
    connections.add(connectionInfo('a'), connectionOptions)
    documents.create('a.sql', '', 'master', 'a')
    const header = render(createElement(StandardToolbar, { variant: 'header' }))
    expect([...header.matchAll(/aria-label="([^"]+)"/g)].map(match => match[1])).toEqual(['Standard', 'Connect', 'New query', 'Open', 'Save', 'Save All', 'Activity Monitor'])
    expect(header).not.toContain('<select')
    const classic = render(createElement(StandardToolbar, { variant: 'classic' }))
    expect(classic).toContain('<label class="context-field" for="query-server">Server</label><select id="query-server" aria-label="Query server"')
    expect(classic).toContain('<label class="context-field" for="query-database">Database</label><select id="query-database" aria-label="Query database"')
    expect(classic).toMatch(/>Execute<kbd>F5<\/kbd><\/button>/)
  })
  it('sizes the bar and its controls from the density tokens, and gives way at narrow widths without wrapping', () => {
    expect(densityUse.bar).toContain('.query-bar')
    expect(densityUse.control).toEqual(expect.arrayContaining(['.query-bar-action', '.query-connection']))
    const rules = stylesheetRules()
    const value = (selector: string, property: string, at: string[] = []) => rules.find(rule => rule.selector === selector && rule.at.join(' ') === at.join(' ') && rule.declarations.some(item => item.property === property))
      ?.declarations.find(item => item.property === property)?.value
    expect([value('.query-bar', 'container-type'), value('.query-bar', 'overflow'), value('.query-connection', 'margin-left')]).toEqual(['inline-size', 'hidden', 'auto'])
    expect(value('.query-bar-label', 'display', ['@container (max-width: 400px)'])).toBe('none')
    expect(value('.query-bar-action.execute kbd', 'display', ['@container (max-width: 520px)'])).toBe('none')
    // The bar sets its own size, so the tag's 12em is as wide as on the status bar; the tag shrinks inside its wrapper
    // rather than running under the server list, and the lists give way first, by weight, down to their minimum.
    expect(value('.query-bar', 'font-size')).toBe('var(--varia-size-sm)')
    expect(value('.environment-tag[data-place="query"]', 'flex')).toBe('0 1 auto')
    expect([value('.query-connection select', 'flex'), value('.query-connection select', 'min-width')]).toEqual(['0 1000 auto', '64px'])
  })
  it('gives every list an opaque fill: Chromium draws an open list on its background, white for a transparent one', () => {
    // In Dark the options keep the list's light text, which on white is all but invisible.
    const targetsSelect = (selector: string) => selector.split(',').some(part => /(^|[\s>+~])select(?![\w-])[^\s>+~]*$/.test(part.trim()))
    const clear = stylesheetRules().filter(rule => targetsSelect(rule.selector) && rule.declarations.some(item => /^background(-color)?$/.test(item.property) && /^(transparent|none)\b|rgba\([^)]*,\s*0\)/.test(item.value)))
    expect(clear.map(rule => rule.selector)).toEqual([])
    expect(stylesheetRules().find(rule => rule.selector === '.query-connection select')?.declarations.find(item => item.property === 'background')?.value).toBe('var(--varia-input-background)')
  })
})
