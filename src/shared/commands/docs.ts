import { scriptAsSubmenuId, scriptSubmenuIds } from '../scripting/catalog.ts'
import { defaultThemePreference } from '../theme/format'
import { themeMenuModel } from '../theme/menu'
import { commandDescriptor, commandIds, type Category, type CommandId, type MenuPlacement } from './catalog'
import { contextKeyNames, contextKeys, type ContextKeyDeclaration } from './context-keys'
import { keybindingLabel, platforms, reservedChords, resolveKeybinding, type Platform } from './keybindings'
import {
  applicationMenus, assignMnemonics, buildMenuModel, isContextMenuId, menuExtras, menuIds, menuRoots, menuTitle, mnemonicIndex, submenuIds, submenus,
  type ContextMenuId, type MenuId
} from './menus'

const categories: readonly (Category | undefined)[] = ['File', 'Edit', 'View', 'Query', 'Connection', 'Object Explorer', 'Preferences', 'Developer', undefined]
const platformNames: Readonly<Record<Platform, string>> = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }
const menuNames: Readonly<Record<MenuId, string>> = {
  ...Object.fromEntries(applicationMenus.map(menu => [menu.id, menu.label])) as Record<typeof applicationMenus[number]['id'], string>,
  theme: 'View › Theme', 'query.connection': 'Query › Connection', 'editor.context': 'Editor context menu', 'explorer.context': 'Object Explorer context menu',
  ...Object.fromEntries(scriptSubmenuIds.map(id => [id, 'Object Explorer context menu › Script … as' + (id === scriptAsSubmenuId ? '' : ` › ${submenus[id].title}`)])) as Record<typeof scriptSubmenuIds[number], string>,
  'documentTab.context': 'Query tab context menu', 'output.context': 'Query Output context menu', 'dockTab.context': 'Panel tab context menu', 'input.context': 'Text field context menu'
}
/** How each context menu opens, and what its items act on. */
const contextMenuUses: Readonly<Record<ContextMenuId, string>> = {
  'editor.context': 'Right-click the query editor, or press Shift+F10 or the context-menu key in it. A right-click outside the selection moves the caret there first.',
  'explorer.context': 'Right-click an Object Explorer node (which selects it) or the empty area below the servers, or press Shift+F10 or the context-menu key in the tree for the selected node. Items act on that node. Script … as names the node\'s kind (Script Table as, Script View as, …) and greys the verbs it does not support; docs/scripting.md lists them.',
  'documentTab.context': 'Right-click a query tab, or press Shift+F10 or the context-menu key on a focused tab. Items act on that tab\'s query.',
  'output.context': 'Right-click the results grid or Messages, or press Shift+F10 or the context-menu key where it has focus. A right-click outside the grid\'s selection selects that cell first.',
  'dockTab.context': 'Right-click a panel\'s tab (Object Explorer, Query editor, or Query output), or press Shift+F10 or the context-menu key on a focused tab.',
  'input.context': 'Right-click a text field, including those in dialogs and the editor\'s find widget, or press Shift+F10 or the context-menu key in it. It is the only menu that opens while a dialog is open; the command palette\'s field has none.'
}
// The theme items need no real theme list: only their fixed labels and commands are documented.
const themeItems = themeMenuModel({ preference: defaultThemePreference, themes: [] })
const cell = (value: string) => value.replaceAll('|', '\\|')
const row = (cells: readonly string[]) => '| ' + cells.map(cell).join(' | ') + ' |'
const code = (value: string) => '`' + value + '`'

function keys(id: CommandId, platform: Platform): string {
  const labels = (commandDescriptor(id).keybindings ?? []).flatMap(spec => {
    const rule = resolveKeybinding(id, spec, platform)
    if (!rule) return []
    return [keybindingLabel(rule.chords, platform).text + (rule.native ? ' *' : '') + (rule.whenSource ? ` (${code(rule.whenSource)})` : '')]
  })
  return labels.join(', ') || '—'
}

/** A placement's titles and the platforms showing each: one, unless it reads differently, as Exit on Windows and Quit on Linux. */
function placementTitles(id: CommandId, placement: MenuPlacement): [string, Platform[]][] {
  const titles = new Map<string, Platform[]>()
  for (const platform of placement.platforms ?? platforms) { const title = menuTitle(id, platform, placement.title); titles.set(title, [...titles.get(title) ?? [], platform]) }
  return [...titles]
}
const only = (shown: readonly Platform[]) => shown.length < platforms.length ? `${shown.map(platform => platformNames[platform]).join(', ')} only` : ''

/** Menu items built from the theme state rather than placed in the catalogue. */
function themePlacements(id: CommandId): string[] {
  if (id === 'preferences.setTheme') {
    const modes = themeItems.flatMap(item => item.kind === 'radio' ? [item.label] : [])
    return [`${menuNames.theme} › ${modes.join(', ')}, and each theme under ${themeItems.flatMap(item => item.kind === 'submenu' ? [item.label] : []).join(' and ')}`]
  }
  return themeItems.flatMap(item => item.kind === 'action' && item.command === id ? [`${menuNames.theme} › ${item.label}`] : [])
}

function menus(id: CommandId): string {
  const placements = (commandDescriptor(id).menus ?? []).flatMap(placement =>
    placementTitles(id, placement).map(([title, shown]) => `${menuNames[placement.menu]} › ${title}${only(shown) ? ` (${only(shown)})` : ''}`))
  return [...placements, ...themePlacements(id)].join('; ') || '—'
}

/** Items without their own letter take the first free one in their menu, as the menus assign them. */
function assignedMnemonic(menu: MenuId, platform: Platform, title: string): number {
  const items = buildMenuModel(menu, platform).map(entry => entry.kind === 'command' || entry.kind === 'submenu' ? { title: entry.title, mnemonic: entry.mnemonic } : null)
  return assignMnemonics(items)[items.findIndex(item => item?.title === title)] ?? -1
}
/** `title` with its access key in bold, as Windows and Linux underline it; macOS shows none. */
function withAccessKey(menu: MenuId, title: string, mnemonic: string | undefined, shown: readonly Platform[]): string {
  const platform = shown.find(value => value !== 'darwin')
  if (!platform) return title
  const index = mnemonic ? mnemonicIndex(title, mnemonic) : assignedMnemonic(menu, platform, title)
  return index < 0 ? title : `${title.slice(0, index)}**${title[index]}**${title.slice(index + 1)}`
}

/** One menu's items in order: their group (a separator divides groups), title, command, and where they show. */
function menuTable(menu: MenuId): string[] {
  const items: { group: string; order: number; title: string; cells: string[] }[] = []
  const shownWhen = (shown: readonly Platform[], when?: string) => [only(shown), when ? code(when) : ''].filter(Boolean).join('; ') || 'Always'
  for (const id of commandIds) {
    for (const placement of commandDescriptor(id).menus ?? []) {
      if (placement.menu !== menu) continue
      for (const [title, shown] of placementTitles(id, placement)) {
        items.push({ group: placement.group, order: placement.order, title, cells: [code(placement.group), withAccessKey(menu, title, placement.mnemonic, shown), code(id), shownWhen(shown, placement.when)] })
      }
    }
  }
  for (const id of submenuIds) {
    for (const placement of submenus[id].placements) {
      if (placement.menu !== menu) continue
      const shown = placement.platforms ?? platforms, title = submenus[id].dynamicTitle === 'scriptAs' ? 'Script … as' : submenus[id].title
      items.push({ group: placement.group, order: placement.order, title, cells: [code(placement.group), withAccessKey(menu, title, placement.mnemonic, shown) + ' ›', `Submenu: ${menuNames[id]}`, shownWhen(shown, placement.when)] })
    }
  }
  for (const extra of menuExtras[menu] ?? []) {
    items.push({ group: extra.group, order: extra.order, title: extra.role, cells: [code(extra.group), extra.role[0].toUpperCase() + extra.role.slice(1), `Electron role ${code(extra.role)}`, shownWhen(extra.platforms ?? platforms)] })
  }
  items.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) || a.order - b.order || a.title.localeCompare(b.title))
  const lines = [row(['Group', 'Item', 'Command', 'Shown']), row(['---', '---', '---', '---']), ...items.map(item => row(item.cells))]
  if (submenuIds.some(id => id === menu && submenus[id].dynamic === 'theme')) {
    const label = (item: { label: string; mnemonic?: string }) => item.mnemonic ? withAccessKey(menu, item.label, item.mnemonic, platforms) : item.label
    lines.push(
      row(['theme items', themeItems.flatMap(item => item.kind === 'radio' ? [label(item)] : []).join(', '), code('preferences.setTheme'), 'Always']),
      row(['theme items', themeItems.flatMap(item => item.kind === 'submenu' ? [label(item) + ' ›'] : []).join(', ') + ': one item per theme', code('preferences.setTheme'), 'Always']),
      ...themeItems.flatMap(item => item.kind === 'action' ? [row(['theme items', label(item), code(item.command), 'Always'])] : []))
  }
  return lines
}

/** Each menu once: the title-bar menus with their submenus (Connection is also in the editor's menu), then the context menus. */
function menuSections(): string[] {
  const lines: string[] = []
  const inMenubar = (menu: MenuId) => menuRoots(menu).some(root => !isContextMenuId(root))
  lines.push('', '### Title-bar menus')
  for (const menu of menuIds.filter(inMenubar)) {
    const bar = applicationMenus.find(item => item.id === menu)
    lines.push('', bar ? `#### ${bar.label} (Alt+${bar.mnemonic.toUpperCase()})` : `#### ${menuNames[menu]}`, '', ...menuTable(menu))
  }
  lines.push('', '### Context menus')
  for (const menu of menuIds.filter(menu => !inMenubar(menu))) {
    lines.push('', isContextMenuId(menu) ? `#### ${menuNames[menu]} (${code(menu)})` : `#### ${menuNames[menu]}`, '', ...isContextMenuId(menu) ? [contextMenuUses[menu], ''] : [], ...menuTable(menu))
  }
  return lines
}

function enablement(id: CommandId): string {
  const { precondition, toggled } = commandDescriptor(id)
  return [precondition ? code(precondition) : 'Always', toggled ? `; checked when ${code(toggled)}` : ''].join('')
}

function contextKeyType(info: ContextKeyDeclaration): string {
  return info.type === 'enum' ? info.values.map(value => code(`'${value}'`)).join(', ') : 'boolean'
}

function reservedTable(): string[] {
  const reasons = [...new Set(platforms.flatMap(platform => [...reservedChords(platform).values()]))]
  const lines = [row(['Reason', ...platforms.map(platform => platformNames[platform])]), row(['---', ...platforms.map(() => '---')])]
  for (const reason of reasons) {
    lines.push(row([reason, ...platforms.map(platform => [...reservedChords(platform)].filter(([, value]) => value === reason).map(([chord]) => keybindingLabel([chord], platform).text).join(', ') || '—')]))
  }
  lines.push(row(['AltGr types characters with Ctrl+Alt', 'Ctrl+Alt+any letter', 'Ctrl+Alt+any letter', '—']))
  lines.push(row(['⌥ types characters on macOS', '—', '—', '⌥ with any character key or Space']))
  return lines
}

/** docs/commands.md: every command with its keys on each platform, enablement, and menus; every menu's items; context keys; reserved keys. */
export function renderCommandDocs(): string {
  const lines = [
    '# Varia commands and keyboard shortcuts',
    '',
    '<!-- Generated by renderCommandDocs() in src/shared/commands/docs.ts. Update with: npx vitest run tests/commands-docs.test.ts -u -->',
    '',
    'Every command, keybinding, and menu placement is declared in `src/shared/commands/catalog.ts`. A condition after a key',
    'limits where the key works; for example, `editorFocus` means the query editor has focus. Keys marked * belong to the',
    'editor, the browser engine, or Electron (zoom, full screen, quit): menus show them, but Varia does not dispatch them.',
    '"Available when" is the condition under which menus, the toolbar, and the keyboard can run the command; the context',
    'keys it uses are listed below.',
    '',
    `## Commands (${commandIds.length})`
  ]
  for (const category of categories) {
    const ids = commandIds.filter(id => commandDescriptor(id).category === category)
    if (!ids.length) continue
    lines.push('', `### ${category ?? 'Other'}`, '', row(['Command', 'Id', ...platforms.map(platform => platformNames[platform]), 'Available when', 'Menus']), row(['---', '---', ...platforms.map(() => '---'), '---', '---']))
    for (const id of ids) {
      const command = commandDescriptor(id)
      lines.push(row([command.title + (command.palette === false ? ' (not in the palette)' : ''), code(id), ...platforms.map(platform => keys(id, platform)), enablement(id), menus(id)]))
    }
  }
  lines.push('', '## Menus', '',
    'Windows and Linux draw these menus in the window\'s theme. A title-bar menu opens from the menu bar, from F10 or a tap of',
    'Alt, or with Alt and its letter; a context menu opens from a right-click, Shift+F10, or the context-menu key. macOS',
    'shows the title-bar menus in its menu bar (without Exit or Quit: the application menu has Quit) and the context menus',
    'as native menus. The bold letter is an item\'s access key on Windows and Linux: with its menu open, press the letter to',
    'choose the item. Items are listed in menu order, and a separator divides groups. "Shown" limits an item to some',
    'platforms or, in a context menu, to targets that match its condition; an item that cannot run is dimmed, not hidden.',
    ...menuSections())
  lines.push('', `## Context keys (${contextKeyNames.length})`, '',
    '`static` keys never change while Varia runs, `state` keys follow the open queries and connections, `focus` keys follow',
    'keyboard focus, and `target` keys describe what a context menu was opened for. "Available when" conditions use only',
    'static and state keys, so a command is enabled the same way in every menu wherever focus is; key conditions may also',
    'use focus keys, and context-menu items may also use the target keys of their own menu.', '',
    row(['Key', 'Values', 'Scope', 'Meaning']), row(['---', '---', '---', '---']),
    ...contextKeyNames.map(key => { const info: ContextKeyDeclaration = contextKeys[key]; return row([code(key), contextKeyType(info), info.scope, info.description]) }),
    '', '## Reserved keys', '',
    'Workbench keybindings never use these keys, because menus, Electron, the operating system, or the editor already own them.', '',
    ...reservedTable(), '')
  return lines.join('\n')
}
