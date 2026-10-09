import type { MenuItemConstructorOptions } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '../src/shared/commands/keybindings'
import { applicationMenus, contextMenuIds, type ContextMenuId } from '../src/shared/commands/menus'
import { contextMenuTemplate } from '../src/main/context-menu'
import { nativeMenuRequest } from '../src/renderer/src/menus/native'
import type { ThemeState, ThemeSummary } from '../src/shared/theme/types'
import type { ResolvedMenuItem } from '../src/renderer/src/menus/resolve'
import { menuForTarget, type ExplorerNode, type InputTarget, type MenuTarget, type OutputView } from '../src/renderer/src/menus/targets'
import { connectionInfo, connectionOptions, queryOutput, readyBackend, workbenchFixture } from './fixtures/workbench'
import { deferred } from './fixtures/documents'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const themes: ThemeSummary[] = [
  { id: 'varia-dark', name: 'Varia Dark', source: 'builtin', types: ['dark'], usable: true, errors: 0, warnings: 0 },
  { id: 'varia-light', name: 'Varia Light', source: 'builtin', types: ['light'], usable: true, errors: 0, warnings: 0 },
  { id: 'harbor', name: 'Harbor & Sea', source: 'user', types: ['dark', 'light'], usable: true, errors: 0, warnings: 0 }
]
const states = ['disconnected', 'connected', 'running', 'busy'] as const

/** Every title-bar menu, resolved as the custom menus show it, in each workbench state: one snapshot per state. */
async function resolveAll(platform: Platform): Promise<(readonly ResolvedMenuItem[])[][]> {
  const fixture = workbenchFixture({ platform })
  cleanups.push(fixture.dispose)
  const theme = fixture.theme as { state: ThemeState }
  theme.state = { ...theme.state, themes }
  fixture.api.push(readyBackend())
  fixture.panes.set({ explorer: true, editor: true, output: true })
  const tab = fixture.documents.create('SQLQuery1.sql', 'SELECT 1', 'master')
  const snapshots: (readonly ResolvedMenuItem[])[][] = []
  const capture = () => { snapshots.push(applicationMenus.map(menu => fixture.menus.resolve(menu.id))) }
  capture()
  fixture.connections.add(connectionInfo('server-a'), connectionOptions)
  fixture.targets.update(tab.id, { connectionId: 'server-a' })
  capture()
  const running = fixture.startQuery()
  capture()
  await running.finish()
  const task = deferred<void>(), busy = fixture.documents.runTask(() => task.promise)
  capture()
  task.resolve()
  await busy
  return snapshots
}

/**
 * Every context menu for each kind of target, resolved in the same states: the editor, a saved and an unsaved query's
 * tab, a docked and a floating panel's tab, text fields that are editable, read-only, a password, or empty, every
 * kind of Object Explorer node (on server-a, which connects in the second state, and server-l, lost with a backend
 * restart before the first state), and Query Output's views of a query that ran before (on server-r, gone since): its grid
 * with and without selected cells, and Messages and the XML plan with and without selected text.
 */
async function resolveContexts(platform: Platform): Promise<{ labels: string[]; snapshots: (readonly ResolvedMenuItem[])[][] }> {
  const fixture = workbenchFixture({ platform })
  cleanups.push(fixture.dispose)
  fixture.api.push(readyBackend())
  // From a backend generation that has ended, so it is lost.
  fixture.connections.add(connectionInfo('server-l', 0), connectionOptions)
  const ran = fixture.documents.create('ran.sql', 'SELECT 3', 'master', 'server-r')
  fixture.connections.add(connectionInfo('server-r'), connectionOptions)
  fixture.api.execute.mockResolvedValueOnce({ ok: true, value: { ...queryOutput, resultSets: [
    { columns: [{ name: 'Id', dataType: 'int' }], rows: [['1']], truncated: false }, { columns: [{ name: 'Id', dataType: 'int' }], rows: [['2']], truncated: false }
  ] } })
  await fixture.queries.execute()
  fixture.connections.remove('server-r')
  fixture.resultSelection.set(ran.id, { resultIndex: 1, anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 }, mode: 'cells' })
  const output = (view: OutputView, resultIndex: number, selectedText = ''): MenuTarget => ({ kind: 'output', tabId: ran.id, view, resultIndex, selectedText, element: { textContent: 'Completed.' } as HTMLElement })
  const unsaved = fixture.documents.create('SQLQuery1.sql', 'SELECT 1', 'master')
  const saved = fixture.documents.create('saved.sql', 'SELECT 2', 'master', undefined, false, { id: '6f0c9a77-0d3b-4c39-9a2e-36c4a1f5e6a1', name: 'saved.sql', path: '/queries/saved.sql' })
  vi.mocked(fixture.host.paneLocation).mockImplementation(pane => pane === 'output' ? 'floating' : 'grid')
  const node = (value: ExplorerNode): MenuTarget => ({ kind: 'explorer', node: value })
  const server = { connectionId: 'server-a' }, database = { ...server, database: 'AppData' }
  const field = (facts: Partial<InputTarget>): MenuTarget => ({ kind: 'input', element: {} as HTMLElement, readOnly: false, secret: false, hasSelection: true, empty: false, canUndo: true, canRedo: false, ...facts })
  const targets: [string, MenuTarget][] = [
    ['the query editor', { kind: 'editor', tabId: saved.id }], ['a saved query\'s tab', { kind: 'documentTab', tabId: saved.id }], ['an unsaved query\'s tab', { kind: 'documentTab', tabId: unsaved.id }],
    ['a docked panel\'s tab', { kind: 'dockTab', pane: 'explorer', floating: false }], ['a floating panel\'s tab', { kind: 'dockTab', pane: 'output', floating: true }],
    ['a text field with selected text', field({})], ['a read-only text field', field({ readOnly: true })], ['a password field', field({ secret: true })],
    ['an empty text field', field({ empty: true, hasSelection: false, canUndo: false })],
    ['Object Explorer\'s empty area', node({ kind: 'background' })], ['a server', node({ kind: 'server', ...server })], ['a lost server', node({ kind: 'lostServer', connectionId: 'server-l' })],
    ...(['databasesFolder', 'systemDatabasesFolder', 'snapshotsFolder', 'securityFolder'] as const).map((kind): [string, MenuTarget] => [`the ${kind} node`, node({ kind, ...server })]),
    ['a database', node({ kind: 'database', ...database })], ['a Tables folder', node({ kind: 'tablesFolder', ...database })],
    ['a table', node({ kind: 'table', ...database, schema: 'dbo', name: 'Orders' })], ['a server object folder', node({ kind: 'serverObjectsFolder', ...server, objectKind: 'logins' })],
    ['a server object', node({ kind: 'serverObject', ...server, objectKind: 'logins', name: 'sa' })],
    ['a results grid with selected cells', output('grid', 1)], ['a results grid without', output('grid', 0)],
    ['Messages with selected text', output('messages', 0, 'Completed.')], ['Messages without', output('messages', 0)], ['the XML plan', output('plan', 0)]
  ]
  const snapshots: (readonly ResolvedMenuItem[])[][] = []
  const capture = () => { snapshots.push(targets.map(([, target]) => fixture.menus.resolve(menuForTarget[target.kind], target))) }
  capture()
  fixture.connections.add(connectionInfo('server-a'), connectionOptions)
  fixture.targets.update(saved.id, { connectionId: 'server-a' })
  capture()
  const running = fixture.startQuery()
  capture()
  await running.finish()
  const task = deferred<void>(), busy = fixture.documents.runTask(() => task.promise)
  capture()
  task.resolve()
  await busy
  return { labels: targets.map(([label, target]) => `${menuForTarget[target.kind]}, for ${label}`), snapshots }
}

/**
 * One line per item: the title with `&` before its access key, its keys, its check or radio mark, and whether it is
 * enabled in each state (+ or -, in the order of `states`).
 */
function describeMenus(heading: string, labels: readonly string[], snapshots: (readonly ResolvedMenuItem[])[][]): string {
  const lines = [`# ${heading}; enablement per state: ${states.join(', ')}`]
  const visit = (levels: (readonly ResolvedMenuItem[])[], depth: number) => {
    levels[0].forEach((item, index) => {
      const indent = '  '.repeat(depth)
      if (item.kind === 'separator') { lines.push(indent + '---'); return }
      const title = item.mnemonic < 0 ? item.title : item.title.slice(0, item.mnemonic) + '&' + item.title.slice(item.mnemonic)
      if (item.kind === 'submenu') {
        lines.push(`${indent}${title} >`)
        visit(levels.map(level => { const same = level[index]; return same.kind === 'submenu' ? same.items : [] }), depth + 1)
        return
      }
      const mark = item.checked === undefined ? '' : item.radio ? (item.checked ? ' (*)' : ' ( )') : (item.checked ? ' [x]' : ' [ ]')
      const enabled = levels.map(level => { const same = level[index]; return same.kind === 'command' && same.enabled ? '+' : '-' }).join('')
      lines.push(`${indent}${title}${item.keybinding ? `  ${item.keybinding.text}` : ''}${mark}  ${enabled}`)
    })
  }
  labels.forEach((label, index) => {
    lines.push(label)
    visit(snapshots.map(snapshot => snapshot[index]), 1)
  })
  return lines.join('\n') + '\n'
}

describe('title-bar menu content', () => {
  it.each(['win32', 'linux'] as const)('is pinned on %s', async platform => {
    const snapshots = await resolveAll(platform)
    // Regenerate deliberately with `npx vitest run tests/menus-content.test.ts -u`, and review it against the spec's menu tables.
    await expect(describeMenus(`Title-bar menus on ${platform}`, applicationMenus.map(menu => menu.label), snapshots)).toMatchFileSnapshot(`fixtures/menus-content.${platform}.txt`)
  })
  it.each(['win32', 'linux', 'darwin'] as const)('pins every context menu on %s', async platform => {
    const { labels, snapshots } = await resolveContexts(platform)
    await expect(describeMenus(`Context menus on ${platform}`, labels, snapshots)).toMatchFileSnapshot(`fixtures/menus-context.${platform}.txt`)
  })
  it('shows the same structure in every state, with the platform\'s Exit or Quit', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const snapshots = await resolveAll(platform)
      const shape = (items: readonly ResolvedMenuItem[]): unknown[] => items.map(item => item.kind === 'submenu' ? [item.key, shape(item.items)] : item.key)
      for (const snapshot of snapshots) expect(snapshot.map(shape)).toEqual(snapshots[0].map(shape))
      expect(snapshots[0][0].at(-1)).toMatchObject(platform === 'win32' ? { title: 'Exit', keybinding: { text: 'Alt+F4' } } : { title: 'Quit', keybinding: { text: 'Ctrl+Q' } })
    }
  })
  it('shows macOS\'s native context menus exactly as resolved: the same items, ids, titles, and enablement', async () => {
    const { labels, snapshots } = await resolveContexts('darwin')
    const resolved = (items: readonly ResolvedMenuItem[]): unknown[] => items.map(item => item.kind === 'separator' ? '---'
      : item.kind === 'submenu' ? [`${item.key} ${item.title}`, resolved(item.items)] : `${item.key} ${item.title}${item.enabled ? '' : ' (disabled)'}`)
    const native = (items: readonly MenuItemConstructorOptions[]): unknown[] => items.map(item => item.type === 'separator' ? '---'
      : Array.isArray(item.submenu) ? [`${item.id} ${item.label}`, native(item.submenu)] : `${item.id} ${item.label}${item.enabled === false ? ' (disabled)' : ''}`)
    for (const snapshot of snapshots) {
      snapshot.forEach((items, index) => {
        const menu = labels[index].split(',')[0] as ContextMenuId
        expect(contextMenuIds).toContain(menu)
        expect(native(contextMenuTemplate(nativeMenuRequest(1, menu, items, { x: 0, y: 0 }), 'darwin', () => {})), labels[index]).toEqual(resolved(items))
      })
    }
  })
})
