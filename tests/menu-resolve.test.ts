import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandId } from '../src/shared/commands/catalog'
import { contextRecord } from '../src/shared/commands/context-keys'
import type { Platform } from '../src/shared/commands/keybindings'
import type { MenuEntry, MenuId, SubmenuId } from '../src/shared/commands/menus'
import { compileWhen } from '../src/shared/commands/when'
import type { CommandArgs } from '../src/renderer/src/core/types'
import { KeybindingService } from '../src/renderer/src/core/keybindings'
import { resolveMenu, type DynamicMenuItem, type ResolveOptions, type ResolvedMenuItem } from '../src/renderer/src/menus/resolve'

afterEach(() => { vi.restoreAllMocks() })

function options(overrides: Omit<Partial<ResolveOptions>, 'commands' | 'keybindings'> & { disabled?: readonly CommandId[]; toggled?: readonly CommandId[]; platform?: Platform } = {}) {
  const platform = overrides.platform ?? 'win32'
  const isEnabled = vi.fn((id: CommandId, _args?: CommandArgs) => !overrides.disabled?.includes(id))
  const isToggled = vi.fn((id: CommandId) => !!overrides.toggled?.includes(id))
  const keybindings = new KeybindingService({ platform, commands: { execute: vi.fn() }, context: { get: () => contextRecord(platform) }, modalOpen: () => false, editorHasTextFocus: () => false })
  return { platform, state: contextRecord(platform), commands: { isEnabled, isToggled }, keybindings, ...overrides }
}
/** Titles with the mnemonic marked by `&`, as the spec's menu tables write them. */
const marked = (items: readonly ResolvedMenuItem[]): string[] => items.map(item => item.kind === 'separator' ? '-' : item.mnemonic < 0 ? item.title : item.title.slice(0, item.mnemonic) + '&' + item.title.slice(item.mnemonic))
const command = (id: CommandId, title: string = id, extra: Partial<Extract<MenuEntry, { kind: 'command' }>> = {}): MenuEntry => ({ kind: 'command', id, nativeId: id, title, toggle: false, ...extra })

describe('menu resolution', () => {
  it('shows a menubar menu with mnemonics, chord labels, icons, and without Electron roles', () => {
    const edit = resolveMenu('edit', options())
    expect(marked(edit)).toEqual(['&Undo', '&Redo', '-', '&Find', 'R&eplace', '-', 'Toggle &Line Comment', 'Co&mment Selection', 'U&ncomment Selection'])
    expect(edit.map(item => item.key)).toEqual(['edit.undo', 'edit.redo', 'sep:0', 'edit.find', 'edit.replace', 'sep:1', 'edit.toggleLineComment', 'edit.commentLines', 'edit.uncommentLines'])
    const [undo] = edit
    expect(undo).toEqual({ kind: 'command', key: 'edit.undo', id: 'edit.undo', title: 'Undo', mnemonic: 0, icon: 'discard', keybinding: { parts: ['Ctrl+Z'], text: 'Ctrl+Z', aria: 'Control+Z' }, enabled: true })
    expect(edit.find(item => item.key === 'edit.commentLines')).toMatchObject({ keybinding: { text: 'Ctrl+K Ctrl+C' } })
    expect(marked(resolveMenu('window', options({ platform: 'linux' })))).toEqual(['&Object Explorer', 'Query &Editor', 'Q&uery Output', '-', '&Next Query', '&Previous Query', '-', '&Save Window Layout…', 'Lo&ad Window Layout…', '&Reset Window Layout'])
    expect(marked(resolveMenu('file', options()))).toEqual(['Conn&ect to Server…', '&Disconnect from Server…', '-', '&New Query', '&Open…', '&Save', 'Save &As…', '-', '&Close Query'])
    expect(Object.isFrozen(edit) && edit.every(item => Object.isFrozen(item))).toBe(true)
  })
  it('takes enablement and checks from the command service, with the menu\'s arguments', () => {
    const args = { tabId: 'tab-2' }
    const resolved = options({ disabled: ['query.execute'], toggled: ['editor.toggleWordWrap'], args })
    const query = resolveMenu('query', resolved)
    expect(query.map(item => item.kind === 'command' ? [item.id, item.enabled, item.args] : item.kind)).toEqual([
      ['query.execute', false, args], ['query.cancel', true, args], 'separator', ['query.changeConnection', true, args], ['query.changeDatabase', true, args]
    ])
    expect(resolved.commands.isEnabled).toHaveBeenCalledWith('query.execute', args)
    const wrap = resolveMenu('view', resolved).find(item => item.key === 'editor.toggleWordWrap')
    expect(wrap).toMatchObject({ checked: true, title: 'Word Wrap', mnemonic: 0, keybinding: { text: 'Alt+Z' } })
    expect(wrap).not.toHaveProperty('icon')
    expect(resolveMenu('file', resolved).find(item => item.key === 'file.new')).not.toHaveProperty('checked')
  })
  it('treats a throwing predicate or lookup as disabled or unlabelled, and reports it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const resolved = options()
    resolved.commands.isEnabled.mockImplementation(id => { if (id === 'file.save') throw new Error('boom'); return true })
    vi.spyOn(resolved.keybindings, 'lookup').mockImplementation(id => { if (id === 'file.new') throw new Error('lookup'); return undefined })
    const file = resolveMenu('file', resolved)
    expect(file.find(item => item.key === 'file.save')).toMatchObject({ enabled: false })
    expect(file.find(item => item.key === 'file.new')).not.toHaveProperty('keybinding')
    expect(error).toHaveBeenCalledTimes(2)
  })
  it('adds a dynamic submenu\'s items after its own, assigning mnemonics across both', () => {
    const provided: DynamicMenuItem[] = [
      { kind: 'command', key: 'theme.mode.dark', id: 'preferences.colorTheme', title: 'Dark', mnemonic: 'd', radio: true, checked: true, args: { tabId: 'dark' } },
      { kind: 'separator' },
      { kind: 'submenu', key: 'theme.dark', title: 'Dark Theme', mnemonic: 'k', items: [
        { kind: 'command', key: 'theme.dark.a', id: 'preferences.colorTheme', title: 'Contrast', mnemonic: null, radio: true, checked: false },
        { kind: 'command', key: 'theme.dark.b', id: 'preferences.colorTheme', title: 'Broken', mnemonic: null, radio: true, checked: false, enabled: false }
      ] },
      { kind: 'submenu', key: 'theme.light', title: 'Light Theme', items: [] },
      { kind: 'command', key: 'theme.create', id: 'preferences.createTheme', title: 'Create Custom Theme…' }
    ]
    const theme = vi.fn(() => provided)
    const view = resolveMenu('view', options({ dynamic: { theme } }))
    const submenu = view.find(item => item.key === 'view.theme')
    if (submenu?.kind !== 'submenu') throw new Error('View › Theme is missing')
    expect(marked(view).at(-1)).toBe('T&heme')
    expect(marked(submenu.items)).toEqual(['&Color Theme…', '-', '&Dark', '-', 'Dar&k Theme', 'Create Custom &Theme…'])
    expect(submenu.items[2]).toEqual({ kind: 'command', key: 'theme.mode.dark', id: 'preferences.colorTheme', title: 'Dark', mnemonic: 0, args: { tabId: 'dark' }, enabled: true, checked: true, radio: true })
    const dark = submenu.items[4]
    expect(dark.kind === 'submenu' && dark.items.map(item => item.kind === 'command' && [item.title, item.mnemonic, item.enabled, item.checked, 'icon' in item])).toEqual([['Contrast', -1, true, false, false], ['Broken', -1, false, false, false]])
    expect(theme).toHaveBeenCalledOnce()
    // Without a provider, or with one that throws, the submenu shows only the catalogue's items.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const dynamic of [undefined, { theme: () => { throw new Error('theme') } }]) {
      const plain = resolveMenu('view', options({ dynamic })).find(item => item.key === 'view.theme')
      expect(plain?.kind === 'submenu' && marked(plain.items)).toEqual(['&Color Theme…'])
    }
    expect(error).toHaveBeenCalledOnce()
  })
  it('applies placement conditions over the state and target keys, and drops what they leave empty', () => {
    const entries: Partial<Record<MenuId, MenuEntry[]>> = {
      'explorer.context': [
        command('connection.connect', 'Connect…', { when: compileWhen("explorerNode == 'server' || explorerNode == 'background'") }), { kind: 'separator' },
        command('file.new', 'New Query', { when: compileWhen("explorerNode == 'server' && hasConnection") }), { kind: 'separator' },
        { kind: 'submenu', id: 'explorer.scriptTableAs', nativeId: 'explorer.scriptTableAs', title: 'Script Table as', when: compileWhen("explorerNode == 'table'") }, { kind: 'separator' },
        { kind: 'role', role: 'copy' }, { kind: 'separator' },
        command('explorer.refresh', 'Refresh', { when: compileWhen("explorerNode != 'table'") })
      ],
      'explorer.scriptTableAs': [{ kind: 'submenu', id: 'explorer.scriptTableAs.create', nativeId: 'explorer.scriptTableAs.create', title: 'CREATE To' }],
      'explorer.scriptTableAs.create': [command('file.saveAs', 'File…', { when: compileWhen('backendReady') })]
    }
    const model = (menu: MenuId) => entries[menu] ?? []
    const resolve = (target: Parameters<typeof resolveMenu>[1]['target'], state = {}) => marked(resolveMenu('explorer.context', options({ model, target, state: contextRecord('win32', state) })))
    expect(resolve({ explorerNode: 'background' })).toEqual(['&Connect…', '-', '&Refresh'])
    expect(resolve({ explorerNode: 'server' })).toEqual(['&Connect…', '-', '&Refresh'])
    expect(resolve({ explorerNode: 'server' }, { hasConnection: true })).toEqual(['&Connect…', '-', '&New Query', '-', '&Refresh'])
    expect(resolve({ explorerNode: 'table' })).toEqual([])
    const table = resolveMenu('explorer.context', options({ model, target: { explorerNode: 'table' }, state: contextRecord('win32', { backendReady: true }) }))
    expect(marked(table)).toEqual(['&Script Table as'])
    const [scriptAs] = table
    expect(scriptAs.kind === 'submenu' && scriptAs.items[0].kind === 'submenu' && marked(scriptAs.items[0].items)).toEqual(['&File…'])
    // A submenu missing from the model has nothing in it.
    expect(marked(resolveMenu('explorer.context', options({ model: menu => menu === 'explorer.context' ? entries[menu]! : [], target: { explorerNode: 'table' } })))).toEqual([])
    // Target keys left out of the target default to empty.
    expect(resolve(undefined)).toEqual(['&Refresh'])
    const unknown: SubmenuId = 'query.connection'
    expect(resolveMenu('editor.context', options({ model: menu => menu === 'editor.context' ? [{ kind: 'submenu', id: unknown, nativeId: unknown, title: 'Connection' }] : [] }))).toEqual([])
  })
})
