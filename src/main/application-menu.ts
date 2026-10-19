import type { MenuItemConstructorOptions } from 'electron'
import type { CommandId } from '../shared/commands/catalog'
import { defaultRules, toAccelerator, toPlatform, type Platform } from '../shared/commands/keybindings'
import { applicationMenus, buildMenuModel, menuMayShowChords, pruneMenu, type MenuEntry, type MenuId } from '../shared/commands/menus'
import { themeMenuModel, type ThemeMenuItem } from '../shared/theme/menu'
import type { ThemePreferencePatch, ThemeState } from '../shared/theme/types'

export interface ApplicationMenuModel {
  theme: Pick<ThemeState, 'preference' | 'themes'>
  /** A command's title with its setting filled in (`commandTitle` over main's validated settings); the catalogue's otherwise. */
  title?(id: CommandId, title: string): string
}
export interface ApplicationMenuActions {
  command(id: CommandId): void
  /** Whether the renderer last reported the command as checked. */
  isChecked(id: CommandId): boolean
  /** macOS: whether the page has the keyboard: its window is key (no sheet over it) and DevTools is not focused. */
  pageHasKeyFocus(): boolean
  /** macOS: sends an action selector to the key window's first responder, as a role item does. */
  sendActionToFirstResponder(action: string): void
  setTheme(patch: ThemePreferencePatch): void
  createTheme(): void
  openThemesFolder(): void
  reloadThemes(): void
}

const mnemonicSafe = (label: string, platform: NodeJS.Platform) => platform === 'darwin' ? label : label.replaceAll('&', '&&')
const themeActions: Readonly<Record<Extract<ThemeMenuItem, { kind: 'action' }>['id'], (actions: ApplicationMenuActions) => void>> = {
  'theme.create': actions => actions.createTheme(), 'theme.openFolder': actions => actions.openThemesFolder(), 'theme.reload': actions => actions.reloadThemes()
}

/** View › Theme's theme items as native items, keeping PR1's ids; theme names are escaped where Electron reads mnemonics. */
function themeItems(items: readonly ThemeMenuItem[], actions: ApplicationMenuActions, platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    if (item.kind === 'separator') return { type: 'separator' }
    if (item.kind === 'submenu') return { id: item.id, label: item.label, submenu: themeItems(item.items, actions, platform) }
    if (item.kind === 'action') return { id: item.id, label: item.label, click: () => themeActions[item.id](actions) }
    const { patch } = item
    return { id: item.id, label: mnemonicSafe(item.label, platform), type: 'radio', checked: item.checked, enabled: item.enabled, ...(patch ? { click: () => actions.setTheme(patch) } : {}) }
  })
}

/**
 * Role commands whose handlers reach the query editor and the results grid, which their roles cannot (Delete and Select
 * All act on the page's DOM selection, not Monaco's), with their roles' actions. The macOS menu bar runs the handlers, as
 * it does Undo's: an NSMenu leaves DOM focus where it was. ⌘A is still the item's key equivalent (Electron cannot show a
 * key without one), so while a Save sheet or DevTools has the keyboard the item sends its role's action there instead.
 * Elsewhere this menu is hidden and serves only the roles' keys.
 */
const macHandlerRoles: Readonly<Partial<Record<CommandId, string>>> = { 'edit.delete': 'delete:', 'edit.selectAll': 'selectAll:' }
/** A role command's further keys (Zoom In's Ctrl+Shift+=): an item has one accelerator, so hidden copies carry the rest. */
const extraAccelerators = (id: CommandId, platform: Platform): string[] => defaultRules(platform)
  .filter(rule => rule.command === id && rule.chords.length === 1 && menuMayShowChords(rule.chords, platform)).slice(1)
  .flatMap(rule => toAccelerator(rule.chords, platform) ?? [])

function commandItems(entry: Extract<MenuEntry, { kind: 'command' }>, actions: ApplicationMenuActions, platform: NodeJS.Platform, title: string): MenuItemConstructorOptions[] {
  const { id, toggle, role } = entry
  const nativeAction = platform === 'darwin' ? macHandlerRoles[id] : undefined
  // Electron performs a role natively. Its accelerator is always the catalogue's, or none: Electron's own defaults would
  // give Reload Ctrl+R and ⌘R, which toggle the results pane.
  if (role && !nativeAction) {
    const hidden = extraAccelerators(id, toPlatform(platform)).map((accelerator): MenuItemConstructorOptions =>
      ({ role, accelerator, visible: false, ...(platform === 'darwin' ? { acceleratorWorksWhenHidden: true } : {}) }))
    return [{ id: entry.nativeId, label: title, role, accelerator: entry.accelerator ?? '' }, ...hidden]
  }
  // Main never resolves keys (the renderer's dispatcher owns them), so the accelerator is only a label.
  return [{
    id: entry.nativeId, label: title, ...(entry.accelerator ? { accelerator: entry.accelerator } : {}), registerAccelerator: false, type: toggle ? 'checkbox' : 'normal',
    // Electron flips a checkbox before calling click; the renderer owns the state, so the item keeps showing what it last sent.
    click: item => {
      if (toggle) item.checked = actions.isChecked(id)
      if (nativeAction && !actions.pageHasKeyFocus()) actions.sendActionToFirstResponder(nativeAction)
      else actions.command(id)
    }
  }]
}

function menuItems(menu: MenuId, model: ApplicationMenuModel, actions: ApplicationMenuActions, platform: NodeJS.Platform, packaged: boolean): MenuItemConstructorOptions[] {
  const entries = (id: MenuId) => buildMenuModel(id, toPlatform(platform), packaged)
  // Menubar placements have no `when`, so pruning only leaves out submenus with nothing in them.
  return pruneMenu(entries(menu), () => true, entries).flatMap((entry): MenuItemConstructorOptions[] => {
    if (entry.kind === 'separator') return [{ type: 'separator' }]
    if (entry.kind === 'role') return [{ role: entry.role }]
    if (entry.kind === 'command') return commandItems(entry, actions, platform, model.title?.(entry.id, entry.title) ?? entry.title)
    const commands = menuItems(entry.id, model, actions, platform, packaged)
    const dynamic = entry.dynamic === 'theme' ? themeItems(themeMenuModel(model.theme), actions, platform) : []
    return [{ id: entry.nativeId, label: entry.title, submenu: [...commands, ...(commands.length && dynamic.length ? [{ type: 'separator' as const }] : []), ...dynamic] }]
  })
}

/**
 * The application menu, generated from the command catalogue. On Windows and Linux the title bar shows its submenus as
 * popups; on macOS it is the menu bar, after the app menu. Labels are catalogue constants or sanitized theme names. A
 * packaged build has no development commands, so neither their items nor their keys.
 */
export function applicationMenuTemplate(model: ApplicationMenuModel, actions: ApplicationMenuActions, platform: NodeJS.Platform, packaged = false): MenuItemConstructorOptions[] {
  const menus = applicationMenus.map((menu): MenuItemConstructorOptions => ({
    id: 'menu.' + menu.id, label: menu.label, ...(platform === 'darwin' && menu.id === 'window' ? { role: 'window' as const } : {}), submenu: menuItems(menu.id, model, actions, platform, packaged)
  }))
  return platform === 'darwin' ? [{ role: 'appMenu' }, ...menus] : menus
}
