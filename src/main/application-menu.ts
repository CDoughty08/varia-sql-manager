import type { MenuItemConstructorOptions } from 'electron'
import type { WorkbenchCommand } from '../shared/contracts'
import { sanitizeLabel } from '../shared/theme/format'
import { builtinThemes } from '../shared/theme/palette'
import type { ThemePreference, ThemePreferencePatch, ThemeState, ThemeSummary, ThemeType } from '../shared/theme/types'

export interface ApplicationMenuModel { theme: Pick<ThemeState, 'preference' | 'themes'> }
export interface ApplicationMenuActions {
  command(command: WorkbenchCommand): void
  setTheme(patch: ThemePreferencePatch): void
  createTheme(): void
  openThemesFolder(): void
  reloadThemes(): void
}

const themeLabelLength = 48
const slotOf = (type: ThemeType) => type === 'dark' ? 'darkTheme' as const : 'lightTheme' as const

/** The preference change for a click in a theme list: a dual theme fills both slots, and a fixed mode follows the list. */
export function themeChoice(preference: ThemePreference, theme: Pick<ThemeSummary, 'id' | 'types'>, list: ThemeType): ThemePreferencePatch {
  const patch: ThemePreferencePatch = theme.types.length > 1 ? { darkTheme: theme.id, lightTheme: theme.id } : list === 'dark' ? { darkTheme: theme.id } : { lightTheme: theme.id }
  if (preference.mode !== 'system' && preference.mode !== list) patch.mode = list
  return patch
}

/** Theme names come from user files: sanitized, cut to 48 characters, and `&` escaped where Electron reads mnemonics. */
export function themeLabel(name: string): string {
  const characters = [...sanitizeLabel(name, Infinity)]
  return characters.length > themeLabelLength ? characters.slice(0, themeLabelLength - 1).join('') + '…' : characters.join('')
}
const mnemonicSafe = (label: string, platform: NodeJS.Platform) => platform === 'darwin' ? label : label.replaceAll('&', '&&')
/** How a label reads on screen: compatibility forms folded (a no-break space is a space) and runs of spaces collapsed. */
const lookalike = (label: string) => label.normalize('NFKC').replace(/\s+/gu, ' ')

function themeList(model: ApplicationMenuModel, list: ThemeType, actions: ApplicationMenuActions, platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const { preference, themes } = model.theme
  const selected = preference[slotOf(list)], fallback = builtinThemes[list].name
  const shown = themes.filter(theme => theme.types.includes(list) || !theme.usable || theme.id === selected)
  const labels = shown.map(theme => themeLabel(theme.name)), looks = labels.map(lookalike)
  const items = shown.map((theme, index): MenuItemConstructorOptions => {
    const supported = theme.usable && theme.types.includes(list), checked = theme.id === selected
    let label = looks.indexOf(looks[index]) !== looks.lastIndexOf(looks[index]) ? `${labels[index]} (${theme.id})` : labels[index]
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

/** The application menu. On Windows and Linux the title bar shows its submenus as popups; on macOS it is the menu bar. */
export function applicationMenuTemplate(model: ApplicationMenuModel, actions: ApplicationMenuActions, platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const { command } = actions
  return [
    { id: 'menu.file', label: 'File', submenu: [
      { id: 'file.new', label: 'New Query', accelerator: 'CmdOrCtrl+N', click: () => command('file.new') },
      { id: 'file.open', label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => command('file.open') },
      { id: 'file.save', label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => command('file.save') },
      { id: 'file.saveAs', label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => command('file.saveAs') },
      { type: 'separator' },
      { id: 'file.close', label: 'Close Query', accelerator: 'CmdOrCtrl+W', click: () => command('file.close') },
      { type: 'separator' }, { role: 'quit' }
    ] },
    { id: 'menu.edit', label: 'Edit', submenu: [
      { id: 'edit.undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => command('edit.undo') },
      { id: 'edit.redo', label: 'Redo', accelerator: platform === 'darwin' ? 'Cmd+Shift+Z' : 'Ctrl+Y', registerAccelerator: false, click: () => command('edit.redo') },
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
    ] },
    { id: 'menu.view', label: 'View', submenu: [
      { id: 'layout.save', label: 'Save Layout…', click: () => command('layout.save') },
      { id: 'layout.load', label: 'Load Layout…', click: () => command('layout.load') },
      { id: 'layout.reset', label: 'Reset Layout', click: () => command('layout.reset') },
      { type: 'separator' },
      { id: 'view.theme', label: 'Theme', submenu: themeMenu(model, actions, platform) },
      { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }
    ] },
    { id: 'menu.window', label: 'Window', submenu: [
      { id: 'window.explorer', label: 'Object Explorer', click: () => command('window.explorer') },
      { id: 'window.editor', label: 'Query Editor', click: () => command('window.editor') },
      { id: 'window.output', label: 'Query Output', click: () => command('window.output') },
      { type: 'separator' },
      { label: 'Save Window Layout…', click: () => command('layout.save') },
      { label: 'Load Window Layout…', click: () => command('layout.load') },
      { label: 'Reset Window Layout', click: () => command('layout.reset') }
    ] }
  ]
}
