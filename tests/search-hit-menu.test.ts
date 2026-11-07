import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'
import { searchHitNames, type ObjectSearchHit } from '../src/shared/explorer/search'
import type { ObjectRef } from '../src/shared/explorer/refs'
import type { ResolvedMenuItem } from '../src/renderer/src/menus/resolve'
import { argsFor } from '../src/renderer/src/menus/targets'
import { isCopyKey, searchHitTarget } from '../src/renderer/src/search/hit-actions'
import { defaultRules } from '../src/shared/commands/keybindings'
import { contextRecord } from '../src/shared/commands/context-keys'
import { evaluateWhen } from '../src/shared/commands/when'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const table: ObjectRef = { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }
const procedure: ObjectRef = { kind: 'procedure', database: 'AppData', schema: 'Sales', name: 'usp_Refresh' }
const column: ObjectRef = { kind: 'column', database: 'AppData', parent: { kind: 'table', schema: 'dbo', name: 'Order Details' }, name: 'UnitPrice' }
const login: ObjectRef = { kind: 'login', name: 'app_reader' }
const hitOf = (object: ObjectRef, extra: Partial<ObjectSearchHit> = {}): ObjectSearchHit => ({ object, folder: 'tables', label: object.name ?? '', ...extra })

describe('a Search Objects result\'s names', () => {
  it('qualify by schema and database, bracketing only the parts a query needs bracketed', () => {
    expect(searchHitNames(table)).toEqual({ name: 'Orders', schema: 'dbo.Orders', qualified: 'AppData.dbo.Orders', bracketed: '[AppData].[dbo].[Orders]' })
    // A column, key or trigger is named through its parent; a space, a reserved word or a `]` is bracketed, `]` doubled.
    expect(searchHitNames(column)).toEqual({ name: 'UnitPrice', schema: 'dbo.[Order Details].UnitPrice', qualified: 'AppData.dbo.[Order Details].UnitPrice', bracketed: '[AppData].[dbo].[Order Details].[UnitPrice]' })
    expect(searchHitNames({ kind: 'table', database: 'my db', schema: 'select', name: 'a]b' })).toMatchObject({ qualified: '[my db].[select].[a]]b]', bracketed: '[my db].[select].[a]]b]' })
    // Outside a schema there is only the name.
    expect(searchHitNames(login)).toEqual({ name: 'app_reader', bracketed: '[app_reader]' })
    expect(searchHitNames({ kind: 'database', name: 'AppData' })).toEqual({ name: 'AppData', bracketed: '[AppData]' })
  })
})

describe('a Search Objects result\'s context menu', () => {
  function connected() {
    const fixture = workbenchFixture()
    cleanups.push(fixture.dispose)
    fixture.api.push(readyBackend())
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    return fixture
  }
  const lines = (items: readonly ResolvedMenuItem[], depth = 0): string[] => items.flatMap(item => item.kind === 'separator' ? ['  '.repeat(depth) + '---']
    : item.kind === 'submenu' ? [`${'  '.repeat(depth)}${item.title} >${item.enabled ? '' : ' (disabled)'}`, ...depth < 1 ? lines(item.items, depth + 1) : []]
      : [`${'  '.repeat(depth)}${item.title}${item.enabled ? '' : ' (disabled)'}`])

  it('offers Object Explorer\'s commands for the result\'s kind, whatever the tree has selected', () => {
    const { menus, explorer } = connected()
    // The tree has its server selected, which has no Script as and no Select Top N Rows: the result's own keys offer them.
    expect(explorer.menuNode(explorer.getSnapshot().selected)?.kind).toBe('server')
    const menu = (object: ObjectRef, extra: Partial<ObjectSearchHit> = {}) => lines(menus.resolve('search.hit.context', searchHitTarget(explorer, 'server-a', 'search-1', 0, hitOf(object, extra), false)))
    // Script Table as greys the verbs a table does not support, as Object Explorer's own menu does.
    expect(menu(table)).toEqual(['Reveal in Object Explorer', '---', 'Select Top 1000 Rows', '---', 'Script Table as >', '  CREATE To >', '  ALTER To > (disabled)', '  CREATE OR ALTER To > (disabled)',
      '  DROP To >', '  DROP And CREATE To >', '  ---', '  SELECT To >', '  INSERT To >', '  UPDATE To >', '  DELETE To >', '  ---', '  EXECUTE To > (disabled)',
      '---', 'Copy >', '  Name', '  Schema-Qualified Name', '  Fully Qualified Name', '  ---', '  Bracketed Name'])
    // The index reports a module's subtype: a T-SQL procedure offers Modify; a CLR one cannot be altered.
    expect(menu(procedure, { subtype: 'sql' }).slice(0, 5)).toEqual(['Reveal in Object Explorer', '---', 'Modify', '---', 'Script Stored Procedure as >'])
    expect(menu(procedure, { subtype: 'clr' })).not.toContain('Modify')
    // A login has no schema, so Copy offers its name and bracketed name only; it never offers Rename or Delete here.
    expect(menu(login)).toEqual(['Reveal in Object Explorer', '---', 'Script Login as >', '  CREATE To >', '  DROP To >', '  DROP And CREATE To >', '---', 'Copy >', '  Name', '  ---', '  Bracketed Name'])
  })

  it('reads the result\'s keys in preconditions, and copies its names', async () => {
    const { commands, explorer, api } = connected()
    const args = argsFor(searchHitTarget(explorer, 'server-a', 'search-1', 0, hitOf(column), false))
    expect(commands.isEnabled('explorer.selectTopRows', args)).toBe(false)
    expect(commands.isEnabled('explorer.selectTopRows', argsFor(searchHitTarget(explorer, 'server-a', 'search-1', 0, hitOf(table), false)))).toBe(true)
    // The same command with no target reads the tree's selection, the server.
    expect(commands.isEnabled('explorer.selectTopRows')).toBe(false)
    for (const [id, text] of [['search.copyName', 'UnitPrice'], ['search.copySchemaName', 'dbo.[Order Details].UnitPrice'], ['search.copyQualifiedName', 'AppData.dbo.[Order Details].UnitPrice'],
      ['search.copyBracketedName', '[AppData].[dbo].[Order Details].[UnitPrice]']] as const) {
      expect(await commands.execute(id, args, 'menu'), id).toBe(true)
      expect(vi.mocked(api.writeClipboardText).mock.calls.at(-1), id).toEqual([text])
    }
  })

  it('acts on the focused list\'s selected result from a key, and on nothing once the server is gone', async () => {
    const { commands, objectSearch, api, connections } = connected()
    expect(commands.isEnabled('search.copyQualifiedName')).toBe(false)
    vi.spyOn(objectSearch, 'focusedHit').mockReturnValue({ searchId: 'search-1', connectionId: 'server-a', index: 0, hit: hitOf(table) })
    expect(await commands.execute('search.copyQualifiedName', undefined, 'keybinding')).toBe(true)
    expect(vi.mocked(api.writeClipboardText).mock.calls.at(-1)).toEqual(['AppData.dbo.Orders'])
    connections.remove('server-a')
    expect(commands.isEnabled('search.copyQualifiedName')).toBe(false)
  })
})

describe('a Search Objects result\'s Copy key', () => {
  const key = (init: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>, value = 'c') => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init })
  it('is ⌘C on macOS, where Ctrl+C is not Copy, and Ctrl+C elsewhere', () => {
    expect(isCopyKey(key({ metaKey: true }), 'darwin')).toBe(true)
    expect(isCopyKey(key({ ctrlKey: true }), 'darwin')).toBe(false)
    for (const platform of ['win32', 'linux'] as const) {
      expect(isCopyKey(key({ ctrlKey: true }), platform)).toBe(true)
      expect(isCopyKey(key({ ctrlKey: true }, 'C'), platform)).toBe(true)
      expect(isCopyKey(key({ metaKey: true }), platform)).toBe(false)
      // Ctrl+Shift+C is Copy Fully Qualified Name, a keybinding of its own.
      expect(isCopyKey(key({ ctrlKey: true, shiftKey: true }), platform)).toBe(false)
      expect(isCopyKey(key({ ctrlKey: true, altKey: true }), platform)).toBe(false)
    }
  })
})

describe('keys on a result in Object Explorer\'s search', () => {
  it('never reach the tree\'s selection: Delete, F2, Properties and Peek act only in the tree', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const rules = defaultRules(platform).filter(rule => ['explorer.delete', 'explorer.rename', 'explorer.properties', 'explorer.peek'].includes(rule.command))
      expect(rules.length, platform).toBeGreaterThan(0)
      for (const rule of rules) {
        expect(evaluateWhen(rule.when!, contextRecord(platform, { activePanel: 'explorer' })), `${platform} ${rule.command}`).toBe(true)
        expect(evaluateWhen(rule.when!, contextRecord(platform, { activePanel: 'explorer', searchHitsFocus: true })), `${platform} ${rule.command}`).toBe(false)
      }
    }
  })
})
