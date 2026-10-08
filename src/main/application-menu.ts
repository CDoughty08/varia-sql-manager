import type { MenuItemConstructorOptions } from 'electron'
import type { CommandId } from '../shared/commands/catalog'
import { toPlatform } from '../shared/commands/keybindings'
import { applicationMenus, buildMenuModel, pruneMenu, type MenuEntry, type MenuId } from '../shared/commands/menus'
import { themeMenuModel, type ThemeMenuItem } from '../shared/theme/menu'
import type { ThemePreferencePatch, ThemeState } from '../shared/theme/types'

export interface ApplicationMenuModel { theme: Pick<ThemeState, 'preference' | 'themes'> }
export interface ApplicationMenuActions {
  command(id: CommandId): void
  /** Whether the renderer last reported the command as checked. */
  isChecked(id: CommandId): boolean
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

function commandItem(entry: Extract<MenuEntry, { kind: 'command' }>, actions: ApplicationMenuActions): MenuItemConstructorOptions {
  const { id, toggle } = entry
  // Main never resolves keys (the renderer's dispatcher owns them), so the accelerator is only a label.
  return {
    id: entry.nativeId, label: entry.title, ...(entry.accelerator ? { accelerator: entry.accelerator } : {}), registerAccelerator: false, type: toggle ? 'checkbox' : 'normal',
    // Electron flips a checkbox before calling click; the renderer owns the state, so the item keeps showing what it last sent.
    click: item => { if (toggle) item.checked = actions.isChecked(id); actions.command(id) }
  }
}

function menuItems(menu: MenuId, model: ApplicationMenuModel, actions: ApplicationMenuActions, platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const entries = (id: MenuId) => buildMenuModel(id, toPlatform(platform))
  // Menubar placements have no `when`, so pruning only leaves out submenus with nothing in them.
  return pruneMenu(entries(menu), () => true, entries).map((entry): MenuItemConstructorOptions => {
    if (entry.kind === 'separator') return { type: 'separator' }
    if (entry.kind === 'role') return { role: entry.role }
    if (entry.kind === 'command') return commandItem(entry, actions)
    const commands = menuItems(entry.id, model, actions, platform)
    const dynamic = entry.dynamic === 'theme' ? themeItems(themeMenuModel(model.theme), actions, platform) : []
    return { id: entry.nativeId, label: entry.title, submenu: [...commands, ...(commands.length && dynamic.length ? [{ type: 'separator' as const }] : []), ...dynamic] }
  })
}

/**
 * The application menu, generated from the command catalogue. On Windows and Linux the title bar shows its submenus as
 * popups; on macOS it is the menu bar, after the app menu. Labels are catalogue constants or sanitized theme names.
 */
export function applicationMenuTemplate(model: ApplicationMenuModel, actions: ApplicationMenuActions, platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const menus = applicationMenus.map((menu): MenuItemConstructorOptions => ({
    id: 'menu.' + menu.id, label: menu.label, ...(platform === 'darwin' && menu.id === 'window' ? { role: 'window' as const } : {}), submenu: menuItems(menu.id, model, actions, platform)
  }))
  return platform === 'darwin' ? [{ role: 'appMenu' }, ...menus] : menus
}
