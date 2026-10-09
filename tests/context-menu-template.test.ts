import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { CommandId } from '../src/shared/commands/catalog'
import { buildMenuModel, contextCommandIds, contextMenuIds, type ContextMenuId, type ContextMenuRequest, type MenuEntry, type MenuId } from '../src/shared/commands/menus'
import { menuStyleArgument, menuStyleFor, menuStyleFromArgv } from '../src/shared/menu-style'
import { ContextMenuPopups, contextMenuTemplate, type PopupMenu, type PopupWindow } from '../src/main/context-menu'

const request = (menu: ContextMenuId, change: Partial<ContextMenuRequest> = {}): ContextMenuRequest =>
  ({ token: 1, menu, x: 0, y: 0, visible: [...contextCommandIds(menu)], disabled: [], checked: [], ...change })
/** One line per item: its label, then its role or click, its key, and whether it is disabled or checked. */
function describeTemplate(items: readonly MenuItemConstructorOptions[], depth = 0): string[] {
  return items.flatMap(item => {
    const indent = '  '.repeat(depth)
    if (item.type === 'separator') return [indent + '---']
    if (Array.isArray(item.submenu)) return [`${indent}${item.label} >`, ...describeTemplate(item.submenu, depth + 1)]
    const action = item.role ? `role ${item.role}` : typeof item.click === 'function' ? 'click' : 'nothing'
    const flags = [item.accelerator ? item.accelerator : '', item.enabled === false ? 'disabled' : '', item.type === 'checkbox' ? (item.checked ? '[x]' : '[ ]') : ''].filter(Boolean)
    return [`${indent}${item.label} (${action}${flags.length ? ', ' + flags.join(', ') : ''})`]
  })
}
function find(items: readonly MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.id === id) return item
    const inner = Array.isArray(item.submenu) ? find(item.submenu, id) : undefined
    if (inner) return inner
  }
  return undefined
}

describe('native context menu template', () => {
  it('shows the catalogue\'s labels and keys on macOS, with Electron roles for the clipboard and keys that never register', () => {
    const editor = contextMenuTemplate(request('editor.context', { disabled: ['query.execute', 'edit.cut'] }), 'darwin', () => {})
    expect(describeTemplate(editor)).toEqual([
      'Connection >', '  Connect… (click)', '  Disconnect (click)', '  Disconnect All Queries (click)', '  Reconnect… (click)', '  ---', '  Change Connection… (click)', '---',
      'Execute (click, F5, disabled)', 'Cancel Executing Query (click)', '---', 'Cut (role cut, Cmd+X, disabled)', 'Copy (role copy, Cmd+C)', 'Paste (role paste, Cmd+V)', '---',
      'Command Palette… (click, Cmd+Shift+P)'
    ])
    const all = (items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => items.flatMap(item => [item, ...Array.isArray(item.submenu) ? all(item.submenu) : []])
    for (const item of all(editor)) if (item.accelerator !== undefined) expect(item.registerAccelerator, item.label).toBe(false)
    // Role items keep the catalogue's key or none, never Electron's default.
    expect(find(editor, 'edit.copy@editor.context')).toMatchObject({ role: 'copy', accelerator: 'Cmd+C' })
    expect(describeTemplate(contextMenuTemplate(request('documentTab.context', { disabled: ['file.copyPath', 'file.revealInFolder'] }), 'darwin', () => {}))).toEqual([
      'Save (click, Cmd+S)', 'Save As… (click, Cmd+Shift+S)', '---', 'Close (click, Cmd+W)', 'Close All But This (click)', 'Close All (click)', '---',
      'Copy Full Path (click, disabled)', 'Reveal in Finder (click, disabled)'
    ])
    expect(describeTemplate(contextMenuTemplate(request('input.context'), 'darwin', () => {}))).toEqual([
      'Undo (click, Cmd+Z)', 'Redo (click, Cmd+Shift+Z)', '---', 'Cut (role cut, Cmd+X)', 'Copy (role copy, Cmd+C)', 'Paste (role paste, Cmd+V)', 'Delete (role delete, Delete)', '---',
      'Select All (role selectAll, Cmd+A)'
    ])
    expect(find(contextMenuTemplate(request('documentTab.context'), 'linux', () => {}), 'file.revealInFolder')?.label).toBe('Open Containing Folder')
  })
  it('shows only the visible commands, without empty submenus or stray separators', () => {
    const table: CommandId[] = ['explorer.selectTopRows', 'explorer.scriptCreateToNewQuery', 'explorer.scriptCreateToFile', 'explorer.scriptCreateToClipboard', 'explorer.copyName']
    expect(describeTemplate(contextMenuTemplate(request('explorer.context', { visible: table }), 'darwin', () => {}))).toEqual([
      'Select Top 1000 Rows (click)', '---', 'Script Table as >', '  CREATE To >', '    New Query Editor Window (click)', '    File… (click)', '    Clipboard (click)', '---', 'Copy Name (click)'
    ])
    expect(describeTemplate(contextMenuTemplate(request('explorer.context', { visible: ['explorer.copyName', 'explorer.refresh'] }), 'darwin', () => {}))).toEqual(['Copy Name (click)', '---', 'Refresh (click, F5)'])
    expect(describeTemplate(contextMenuTemplate(request('editor.context', { visible: ['query.changeConnection', 'workbench.showCommands'] }), 'darwin', () => {}))).toEqual([
      'Connection >', '  Change Connection… (click)', '---', 'Command Palette… (click, Cmd+Shift+P)'
    ])
  })
  it('sends a chosen command\'s id, and keeps native item ids', () => {
    const send = vi.fn<(id: CommandId) => void>()
    const items = contextMenuTemplate(request('explorer.context'), 'darwin', send)
    const clipboard = find(items, 'explorer.scriptCreateToClipboard'), connect = find(items, 'connection.connect@explorer.context')
    ;(clipboard?.click as () => void)()
    ;(connect?.click as () => void)()
    expect(send.mock.calls).toEqual([['explorer.scriptCreateToClipboard'], ['connection.connect']])
    expect(find(items, 'explorer.scriptTableAs.create')?.label).toBe('CREATE To')
  })
  it('shows toggles as checkboxes, and escapes access-key markers outside macOS', () => {
    const model = (menu: MenuId): readonly MenuEntry[] => menu === 'editor.context'
      ? [{ kind: 'command', id: 'editor.toggleWordWrap', nativeId: 'editor.toggleWordWrap@editor.context', title: 'Word Wrap & More', toggle: true }, { kind: 'separator' }, ...buildMenuModel('editor.context', 'linux')]
      : buildMenuModel(menu, 'linux')
    const checked = request('editor.context', { visible: ['editor.toggleWordWrap', 'query.execute'], checked: ['editor.toggleWordWrap'] })
    expect(describeTemplate(contextMenuTemplate(checked, 'linux', () => {}, model))).toEqual(['Word Wrap && More (click, Alt+Z, [x])', '---', 'Execute (click, F5)'])
    // Word Wrap has no key on macOS.
    expect(describeTemplate(contextMenuTemplate({ ...checked, checked: [] }, 'darwin', () => {}, model))[0]).toBe('Word Wrap & More (click, [ ])')
  })
  it('has every context menu\'s commands somewhere in its template', () => {
    for (const menu of contextMenuIds) {
      const items = contextMenuTemplate(request(menu), 'darwin', () => {})
      const ids = (list: readonly MenuItemConstructorOptions[]): string[] => list.flatMap(item => [...item.id && !Array.isArray(item.submenu) ? [item.id.split('@')[0]] : [], ...Array.isArray(item.submenu) ? ids(item.submenu) : []])
      expect(ids(items).sort(), menu).toEqual([...contextCommandIds(menu)].sort())
    }
  })
})

/** A window and menus that record what the popups do. */
function popups(style: 'native' | 'custom' = 'native', zoom = 1.25) {
  const sent: unknown[][] = [], shown: { menu: number; x: number; y: number; callback: () => void }[] = [], closed: number[] = []
  let destroyed = false, built = 0
  const window: PopupWindow = {
    isDestroyed: () => destroyed, getContentBounds: () => ({ width: 1024, height: 700 }),
    webContents: { getZoomFactor: () => zoom, send: (...args: unknown[]) => { sent.push(args) } }
  }
  const templates: MenuItemConstructorOptions[][] = []
  const build = (template: MenuItemConstructorOptions[]): PopupMenu<PopupWindow> => {
    const menu = ++built
    templates.push(template)
    return { popup: options => { shown.push({ menu, x: options.x, y: options.y, callback: options.callback }) }, closePopup: () => { closed.push(menu) } }
  }
  const service = new ContextMenuPopups<PopupWindow>({ style, platform: 'darwin', build })
  return { service, window, sent, shown, closed, templates, destroy: () => { destroyed = true } }
}
const valid = { token: 7, menu: 'explorer.context', x: 100, y: 40, visible: ['explorer.copyName', 'explorer.refresh'], disabled: ['explorer.refresh'], checked: [] }

describe('context menu popups', () => {
  it('pops up at the request\'s point in window pixels, sends a choice with its token, and settles when the menu closes', async () => {
    const { service, window, sent, shown, templates } = popups()
    let settled = false
    const showing = service.show(valid, window).then(() => { settled = true })
    expect(shown).toEqual([{ menu: 1, x: 125, y: 50, callback: expect.any(Function) }])
    ;(find(templates[0], 'explorer.copyName')?.click as () => void)()
    expect(sent).toEqual([['varia:context-menu-command', { token: 7, id: 'explorer.copyName' }]])
    await Promise.resolve()
    expect(settled).toBe(false)
    shown[0].callback()
    await showing
    expect(settled).toBe(true)
  })
  it('keeps the point inside the window', async () => {
    const { service, window, shown } = popups('native', 2)
    void service.show({ ...valid, x: 32767, y: 32767 }, window)
    expect(shown[0]).toMatchObject({ x: 1023, y: 699 })
  })
  it('closes the open menu for a new one, a reset, or nothing at all', async () => {
    const { service, window, shown, closed } = popups()
    const first = service.show(valid, window)
    void service.show({ ...valid, token: 8 }, window)
    expect(closed).toEqual([1])
    shown[0].callback()
    await first
    service.close()
    expect(closed).toEqual([1, 2])
    service.close()
    expect(closed).toEqual([1, 2])
  })
  it('refuses unless context menus are native, and refuses foreign or malformed requests without touching the open menu', async () => {
    await expect(popups('custom').service.show(valid, popups().window)).rejects.toThrow('Native context menus are not in use.')
    const { service, window, shown, closed } = popups()
    void service.show(valid, window)
    for (const change of [{ visible: ['file.save'] }, { disabled: ['explorer.newQuery'] }, { x: -1 }, { token: 0 }, { menu: 'theme' }, { label: 'Format C:' }]) {
      await expect(service.show({ ...valid, ...change }, window), JSON.stringify(change)).rejects.toThrow()
    }
    expect([shown.length, closed]).toEqual([1, []])
  })
  it('sends nothing to a closed window, and forgets a menu that could not pop up', async () => {
    const { service, window, sent, templates, closed, destroy } = popups()
    void service.show(valid, window)
    destroy()
    ;(find(templates[0], 'explorer.copyName')?.click as () => void)()
    service.close()
    expect([sent, closed]).toEqual([[], []])
    const failing = new ContextMenuPopups<PopupWindow>({ style: 'native', platform: 'darwin', build: () => ({ popup: () => { throw new Error('No popup.') }, closePopup: () => { closed.push(0) } }) })
    await expect(failing.show(valid, popups().window)).rejects.toThrow('No popup.')
    failing.close()
    expect(closed).toEqual([])
  })
})

describe('menu style', () => {
  it('is native on macOS only, unless a smoke test chooses', () => {
    expect([menuStyleFor('darwin', {}), menuStyleFor('win32', {}), menuStyleFor('linux', {})]).toEqual(['native', 'custom', 'custom'])
    expect(menuStyleFor('linux', { VARIA_SMOKE_TEST: '1', VARIA_SMOKE_MENU_STYLE: 'native' })).toBe('native')
    expect(menuStyleFor('darwin', { VARIA_SMOKE_TEST: '1', VARIA_SMOKE_MENU_STYLE: 'custom' })).toBe('custom')
    expect(menuStyleFor('linux', { VARIA_SMOKE_MENU_STYLE: 'native' })).toBe('custom')
    expect(menuStyleFor('linux', { VARIA_SMOKE_TEST: '1', VARIA_SMOKE_MENU_STYLE: 'other' })).toBe('custom')
  })
  it('reaches the preload as one argument, read strictly', () => {
    expect(menuStyleFromArgv(['electron', '.', menuStyleArgument('native')], 'linux')).toBe('native')
    expect(menuStyleFromArgv(['electron', '.', menuStyleArgument('custom')], 'darwin')).toBe('custom')
    for (const argv of [[], ['--varia-menu-style=Native'], ['--varia-menu-style='], ['--varia-menu-style=native', '--varia-menu-style=custom'], ['--varia-menu-style-native']]) {
      expect(menuStyleFromArgv(argv, 'darwin'), argv.join(' ')).toBe('native')
      expect(menuStyleFromArgv(argv, 'win32'), argv.join(' ')).toBe('custom')
    }
  })
})
