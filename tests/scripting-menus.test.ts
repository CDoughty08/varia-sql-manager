import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { commandDescriptor, type CommandId } from '../src/shared/commands/catalog'
import { contextRecord, type ContextKeys } from '../src/shared/commands/context-keys'
import type { Platform } from '../src/shared/commands/keybindings'
import { contextMenuRequestSchema, submenuTitle } from '../src/shared/commands/menus'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'
import { kindSpecs, nodeKinds, parentKinds, type NodeKind, type NodeSubtype, type ParentKind } from '../src/shared/explorer/catalog'
import { contextMenuTemplate } from '../src/main/context-menu'
import { hoverDelay, MenuController, type MenuKey } from '../src/renderer/src/menus/MenuController'
import { nativeMenuRequest } from '../src/renderer/src/menus/native'
import { resolveMenu, type ResolvedMenuItem } from '../src/renderer/src/menus/resolve'
import { scriptAsTitles, scriptCommandIds, scriptContextValues, scriptKindSpecs, scriptMenuState, type ScriptTarget } from '../src/shared/scripting/catalog'
import { actionContextValues, actionMenuState } from '../src/shared/actions/catalog'
import { manualTimers } from './fixtures/workbench'

/** The state a right-click on a node of this kind leaves: the backend is ready, a server is connected, and the node is selected. */
const stateFor = (platform: Platform, target: ScriptTarget, extra: Partial<ContextKeys> = {}) =>
  contextRecord(platform, { backendReady: true, hasConnection: true, ...scriptContextValues(scriptMenuState(target)), ...actionContextValues(actionMenuState(target)), ...extra })
/** Object Explorer's menu for a node, with enablement from each command's precondition, as the workbench resolves it. */
function resolveFor(platform: Platform, target: ScriptTarget, extra: Partial<ContextKeys> = {}): readonly ResolvedMenuItem[] {
  const state = stateFor(platform, target, extra)
  const enabled = (id: CommandId) => { const { precondition } = commandDescriptor(id); return precondition === undefined || evaluateWhen(compileWhen(precondition), state) }
  return resolveMenu('explorer.context', {
    platform, state, target: { explorerNode: target.kind }, commands: { isEnabled: enabled, isToggled: () => false }, keybindings: { lookup: () => undefined }
  })
}
/** One line per item, `&` before its access key, with `(disabled)` on items that cannot run or open. */
function describe_(items: readonly ResolvedMenuItem[], depth = 0): string[] {
  return items.flatMap(item => {
    const indent = '  '.repeat(depth)
    if (item.kind === 'separator') return [indent + '---']
    const title = item.mnemonic < 0 ? item.title : item.title.slice(0, item.mnemonic) + '&' + item.title.slice(item.mnemonic)
    const flag = item.enabled ? '' : ' (disabled)'
    return item.kind === 'submenu' ? [`${indent}${title} >${flag}`, ...describe_(item.items, depth + 1)] : [`${indent}${title}${flag}`]
  })
}
/** Every kind, subtype and allowed parent the catalogue describes, deferred ones included. */
function allTargets(): ScriptTarget[] {
  return nodeKinds.flatMap(kind => {
    const spec = scriptKindSpecs[kind]
    const parents: (ParentKind | undefined)[] = spec?.phase === 'pr5' && spec.parents ? [...parentKinds] : [undefined]
    return [undefined, ...kindSpecs[kind].subtypes ?? []].flatMap(subtype => parents.map(parentKind => ({ kind, ...(subtype ? { subtype } : {}), ...(parentKind ? { parentKind } : {}) })))
  })
}
const examples: [string, NodeKind, NodeSubtype?, ParentKind?][] = [
  ['a table', 'table'], ['a history table', 'table', 'history'], ['a ledger history table', 'table', 'ledgerHistory'], ['a view', 'view'], ['a ledger view', 'view', 'ledger'],
  ['a T-SQL procedure', 'procedure', 'sql'], ['a CLR procedure', 'procedure', 'clr'], ['an inline table-valued function', 'function', 'inline'], ['a scalar function', 'function', 'scalar'],
  ['an aggregate', 'function', 'aggregate'],
  ['a DML trigger', 'trigger', undefined, 'table'], ['a database', 'database'], ['a database snapshot', 'database', 'snapshot'], ['an index', 'index', 'nonclustered', 'view'],
  ['a foreign key', 'key', 'foreign', 'table'], ['a user', 'user'], ['a login', 'login'], ['a linked server', 'linkedServer'], ['a certificate (deferred)', 'certificate'],
  ['an extended procedure (deferred)', 'procedure', 'extended'], ['a table type\'s index (not scriptable)', 'index', 'nonclustered', 'tableType']
]

describe('Script As in Object Explorer\'s context menu', () => {
  it.each(['win32', 'linux'] as const)('is pinned on %s for one node of each kind', async platform => {
    const lines = examples.flatMap(([label, kind, subtype, parentKind]) => [`explorer.context, for ${label}`, ...describe_(resolveFor(platform, { kind, subtype, parentKind }), 1)])
    // Review against the spec's B3 verb matrix; regenerate deliberately with `npx vitest run tests/scripting-menus.test.ts -u`.
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot(`fixtures/scripting-menus.${platform}.txt`)
  })
  it('titles the submenu by kind, offers the verbs B3 lists, and greys the ones a kind does not support', () => {
    const table = resolveFor('win32', { kind: 'table' })
    const scriptAs = table.find(item => item.key === 'explorer.scriptAs')
    expect(scriptAs).toMatchObject({ kind: 'submenu', title: 'Script Table as', enabled: true, scriptAsTitle: 'table' })
    const verbs = scriptAs?.kind === 'submenu' ? scriptAs.items.flatMap(item => item.kind === 'submenu' ? [[item.title, item.enabled]] : item.kind === 'separator' ? [['-']] : []) : []
    expect(verbs).toEqual([['CREATE To', true], ['ALTER To', false], ['CREATE OR ALTER To', false], ['DROP To', true], ['DROP And CREATE To', true], ['-'],
      ['SELECT To', true], ['INSERT To', true], ['UPDATE To', true], ['DELETE To', true], ['-'], ['EXECUTE To', false]])
    const procedure = resolveFor('linux', { kind: 'procedure', subtype: 'sql' })
    expect(describe_(procedure).filter(line => !line.startsWith('  '))).toEqual(['Modif&y', '---', '&Script Stored Procedure as >', '---', 'Copy N&ame', '---', 'Rena&me', 'D&elete', '---', 'Re&fresh'])
    expect(resolveFor('linux', { kind: 'procedure', subtype: 'clr' }).some(item => item.kind === 'command' && item.id === 'explorer.modify')).toBe(false)
    for (const [kind, subtype, title] of [['type', 'clr', 'Script User-Defined Type as'], ['type', 'alias', 'Script User-Defined Data Type as'], ['tableType', undefined, 'Script User-Defined Table Type as']] as const) {
      expect(resolveFor('win32', { kind, subtype }).find(item => item.key === 'explorer.scriptAs'), `${kind} ${subtype}`).toMatchObject({ title })
    }
    // While the backend restarts every verb is greyed, so the whole submenu is.
    expect(resolveFor('win32', { kind: 'table' }, { backendReady: false }).find(item => item.key === 'explorer.scriptAs')).toMatchObject({ enabled: false })
    // New Query, file destinations and Modify wait for a document task; the clipboard does not.
    const busy = resolveFor('win32', { kind: 'view' }, { documentBusy: true }).find(item => item.key === 'explorer.scriptAs')
    const create = busy?.kind === 'submenu' ? busy.items.find(item => item.key === 'explorer.scriptAs.create') : undefined
    expect(create?.kind === 'submenu' && create.items.map(item => item.kind !== 'separator' && [item.title, item.enabled])).toEqual([['New Query Editor Window', false], ['File…', false], ['Clipboard', true]])
  })
  it('shows no Script submenu on the empty area, a folder, or a kind with nothing to script', () => {
    const scripted = (items: readonly ResolvedMenuItem[]) => items.some(item => item.key === 'explorer.scriptAs')
    expect(scripted(resolveFor('win32', { kind: 'table' }))).toBe(true)
    // The empty area keeps the selection's keys, so its placement opts out.
    const state = stateFor('win32', { kind: 'table' })
    expect(scripted(resolveMenu('explorer.context', { platform: 'win32', state, target: { explorerNode: 'background' }, commands: { isEnabled: () => true, isToggled: () => false }, keybindings: { lookup: () => undefined } }))).toBe(false)
    for (const target of [{ kind: 'folder' }, { kind: 'server' }, { kind: 'column', parentKind: 'table' }, { kind: 'certificate' }, { kind: 'table', subtype: 'droppedLedger' }] as const) expect(scripted(resolveFor('win32', target)), JSON.stringify(target)).toBe(false)
    // System Stored Procedures marks sys.xp_msver 'extended' and an RF procedure 'replicationFilter' (a live .NET check pins
    // the tree's subtypes); those are deferred, while the folder's other rows ('system') script.
    for (const subtype of ['extended', 'replicationFilter'] as const) expect(scripted(resolveFor('win32', { kind: 'procedure', subtype })), subtype).toBe(false)
    expect(scripted(resolveFor('win32', { kind: 'procedure', subtype: 'system' }))).toBe(true)
  })
  it('never opens a disabled verb submenu by hover, →, Enter, a mnemonic or a click, while enabled ones open', () => {
    const { timers, advance } = manualTimers()
    const controller = new MenuController({ timers, menubar: () => [], menubarRect: () => undefined, activate: () => {}, closed: () => {} })
    const key = (name: string): MenuKey => ({ key: name, code: name, alt: false, ctrl: false, meta: false, shift: false, repeat: false })
    const items = resolveFor('win32', { kind: 'table' })
    controller.openContext(items, { kind: 'point', x: 0, y: 0 }, { keyboard: true, label: 'Object Explorer' })
    const level = () => controller.view.levels.at(-1)!, activeTitle = () => { const item = level().items[level().active]; return item?.kind === 'separator' ? '' : item?.title }
    // Select Top 1000 Rows, then the Script submenu.
    controller.key(key('ArrowDown'))
    expect(activeTitle()).toBe('Script Table as')
    controller.key(key('ArrowRight'))
    expect(controller.view.levels).toHaveLength(2)
    expect(activeTitle()).toBe('CREATE To')
    controller.key(key('ArrowDown'))
    expect(activeTitle()).toBe('ALTER To')
    for (const name of ['ArrowRight', 'Enter', ' ']) {
      controller.key(key(name))
      expect(controller.view.levels, name).toHaveLength(2)
    }
    const alter = level().active
    controller.click(1, alter)
    controller.pointerEnterItem(1, alter, { x: 1, y: 1 })
    advance(hoverDelay * 2)
    expect(controller.view.levels).toHaveLength(2)
    expect(level().items[alter]).toMatchObject({ title: 'ALTER To', enabled: false })
    // The mnemonic focuses it without opening it; DROP's opens.
    controller.key(key('Home'))
    controller.key(key('a'))
    expect([activeTitle(), controller.view.levels.length]).toEqual(['ALTER To', 2])
    controller.key(key('d'))
    expect(controller.view.levels).toHaveLength(3)
    expect(level().items.map(item => item.kind !== 'separator' && item.title)).toEqual(['New Query Editor Window', 'File…', 'Clipboard'])
    controller.dispose()
  })
  it('sends main the title key and builds the native menu from catalogue titles, disabling verbs whose items all are', () => {
    const items = resolveFor('darwin', { kind: 'table' })
    const request = nativeMenuRequest(3, 'explorer.context', items, { x: 1, y: 2 })
    expect(request.scriptAsTitle).toBe('table')
    expect(contextMenuRequestSchema.parse(request)).toEqual(request)
    expect(request.disabled).toEqual(expect.arrayContaining(['explorer.scriptAlterToNewQuery', 'explorer.scriptCreateOrAlterToClipboard', 'explorer.scriptExecuteToFile']))
    const template = contextMenuTemplate(contextMenuRequestSchema.parse(request), 'darwin', () => {})
    const scriptAs = template.find(item => item.id === 'explorer.scriptAs')
    expect(scriptAs).toMatchObject({ label: 'Script Table as', enabled: true })
    const verbs = (scriptAs?.submenu as MenuItemConstructorOptions[]).flatMap(item => item.type === 'separator' ? [] : [[item.label, item.enabled]])
    expect(verbs).toEqual([['CREATE To', true], ['ALTER To', false], ['CREATE OR ALTER To', false], ['DROP To', true], ['DROP And CREATE To', true],
      ['SELECT To', true], ['INSERT To', true], ['UPDATE To', true], ['DELETE To', true], ['EXECUTE To', false]])
    // Every title comes from its key; the descriptor's own title is the fallback.
    for (const key of Object.keys(scriptAsTitles) as (keyof typeof scriptAsTitles)[]) expect(submenuTitle({ title: 'Script as', dynamicTitle: 'scriptAs' }, { explorerScriptTitle: key })).toBe(scriptAsTitles[key])
    expect(submenuTitle({ title: 'Script as', dynamicTitle: 'scriptAs' }, { explorerScriptTitle: '__proto__' })).toBe('Script as')
    expect(submenuTitle({ title: 'Connection' }, { explorerScriptTitle: 'table' })).toBe('Connection')
  })
  it('accepts a title key exactly when a script command is visible, and only a known one', () => {
    const base = { token: 1, menu: 'explorer.context', x: 0, y: 0, disabled: [], checked: [] }
    const scripts = { ...base, visible: ['explorer.copyName', 'explorer.scriptCreateToClipboard'] }, plain = { ...base, visible: ['explorer.copyName'] }
    expect(contextMenuRequestSchema.safeParse({ ...scripts, scriptAsTitle: 'view' }).success).toBe(true)
    expect(contextMenuRequestSchema.safeParse(plain).success).toBe(true)
    for (const value of [scripts, { ...plain, scriptAsTitle: 'table' }, { ...scripts, scriptAsTitle: 'Script Table as' }, { ...scripts, scriptAsTitle: '' }, { ...scripts, scriptAsTitle: '__proto__' }, { ...scripts, scriptAsTitle: 1 }]) {
      expect(contextMenuRequestSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
    }
  })
  it('keeps every row\'s native request within 64 visible commands, all of them script commands or the menu\'s own', () => {
    let largest = 0
    for (const target of allTargets()) for (const platform of ['win32', 'darwin'] as const) {
      const request = nativeMenuRequest(1, 'explorer.context', resolveFor(platform, target), { x: 0, y: 0 })
      largest = Math.max(largest, request.visible.length)
      const parsed = contextMenuRequestSchema.safeParse(request)
      expect(parsed.success, `${JSON.stringify(target)} on ${platform}`).toBe(true)
      expect(request.scriptAsTitle ?? '', JSON.stringify(target)).toBe(scriptMenuState(target).title)
      expect(request.visible.filter(id => (scriptCommandIds as readonly string[]).includes(id)).length, JSON.stringify(target)).toBe(Object.values(scriptMenuState(target).verbs).filter(Boolean).length * 3)
    }
    // A table: 30 script commands (its greyed verbs too), Select Top 1000 Rows, Copy Name, Rename, Delete and Refresh.
    expect(largest).toBeLessThanOrEqual(64)
    expect(largest).toBe(35)
  })
})
