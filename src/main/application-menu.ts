import type { MenuItemConstructorOptions } from 'electron'
import type { CommandId } from '../shared/commands/catalog'
import { toPlatform } from '../shared/commands/keybindings'
import { applicationMenus, buildMenuModel, type MenuEntry, type MenuId } from '../shared/commands/menus'
import { themeChoice } from '../shared/theme/choice'
import { sanitizeLabel } from '../shared/theme/format'
import { builtinThemes } from '../shared/theme/palette'
import type { ThemePreference, ThemePreferencePatch, ThemeState, ThemeType } from '../shared/theme/types'

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

const themeLabelLength = 48
const slotOf = (type: ThemeType) => type === 'dark' ? 'darkTheme' as const : 'lightTheme' as const

/** Theme names come from user files: sanitized, cut to 48 characters, and `&` escaped where Electron reads mnemonics. */
export function themeLabel(name: string): string {
  const characters = [...sanitizeLabel(name, Infinity)]
  return characters.length > themeLabelLength ? characters.slice(0, themeLabelLength - 1).join('') + '…' : characters.join('')
}
const mnemonicSafe = (label: string, platform: NodeJS.Platform) => platform === 'darwin' ? label : label.replaceAll('&', '&&')
/** How a label reads on screen: compatibility forms folded (a no-break space is a space) and blank runs collapsed and trimmed. */
const lookalike = (label: string) => [...label.normalize('NFKC').replace(/[\s\u2800]+/gu, ' ').trim()]
/**
 * Labels that could pass for each other: the same length, and every difference pairs an ASCII character with a
 * non-ASCII one, as a Cyrillic а does with a Latin a. Names in one script that merely differ are left alone.
 */
const confusable = (a: string[], b: string[]) => a.length === b.length && a.every((character, index) => character === b[index] || (character < '\x80') !== (b[index] < '\x80'))

function themeList(model: ApplicationMenuModel, list: ThemeType, actions: ApplicationMenuActions, platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const { preference, themes } = model.theme
  const selected = preference[slotOf(list)], fallback = builtinThemes[list].name
  const shown = themes.filter(theme => theme.types.includes(list) || !theme.usable || theme.id === selected)
  const labels = shown.map(theme => themeLabel(theme.name)), looks = labels.map(lookalike)
  const items = shown.map((theme, index): MenuItemConstructorOptions => {
    const supported = theme.usable && theme.types.includes(list), checked = theme.id === selected
    let label = looks.some((look, other) => other !== index && confusable(look, looks[index])) ? `${labels[index]} (${theme.id})` : labels[index]
    if (!theme.usable) label += checked ? ` (invalid: using ${fallback})` : ' (invalid)'
    else if (!supported) label += ` (no ${list} variant: using ${fallback})`
    return { id: `theme.${list}.${theme.id}`, label: mnemonicSafe(label, platform), type: 'radio', checked, enabled: supported, click: () => actions.setTheme(themeChoice(preference, theme, list)) }
  })
  if (!shown.some(theme => theme.id === selected)) items.push({ id: `theme.${list}.${selected}`, label: mnemonicSafe(`${selected} (missing: using ${fallback})`, platform), type: 'radio', checked: true, enabled: false })
  return items
}

function themeMenu(model: ApplicationMenuModel, actions: ApplicationMenuActions, platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const mode = model.theme.preference.mode
  const modeItem = (value: ThemePreference['mode'], label: string): MenuItemConstructorOptions => ({ id: 'theme.mode.' + value, label, type: 'radio', checked: mode === value, click: () => actions.setTheme({ mode: value }) })
  return [
    modeItem('dark', 'Dark'), modeItem('light', 'Light'), modeItem('system', 'Follow System'),
    { type: 'separator' },
    { id: 'theme.dark', label: 'Dark Theme', submenu: themeList(model, 'dark', actions, platform) },
    { id: 'theme.light', label: 'Light Theme', submenu: themeList(model, 'light', actions, platform) },
    { type: 'separator' },
    { id: 'theme.create', label: 'Create Custom Theme…', click: () => actions.createTheme() },
    { id: 'theme.openFolder', label: 'Open Themes Folder', click: () => actions.openThemesFolder() },
    { id: 'theme.reload', label: 'Reload Themes', click: () => actions.reloadThemes() }
  ]
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
  return buildMenuModel(menu, toPlatform(platform)).map((entry): MenuItemConstructorOptions => {
    if (entry.kind === 'separator') return { type: 'separator' }
    if (entry.kind === 'role') return { role: entry.role }
    if (entry.kind === 'command') return commandItem(entry, actions)
    const commands = menuItems(entry.menu, model, actions, platform)
    return { id: entry.id, label: entry.title, submenu: [...commands, ...(commands.length ? [{ type: 'separator' as const }] : []), ...themeMenu(model, actions, platform)] }
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
