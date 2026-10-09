import type { CommandId } from '../commands/catalog'
import { themeChoice } from './choice'
import { sanitizeLabel } from './format'
import { builtinThemes } from './palette'
import type { ThemePreference, ThemePreferencePatch, ThemeState, ThemeType } from './types'

/**
 * The theme items of View › Theme, after its catalogue commands: the mode, each theme list, and the theme-file actions.
 * Main renders them as native items and the renderer as commands, so both show the same labels and choices. Labels
 * are plain text; whoever renders them escapes what its menus treat specially.
 */
export type ThemeMenuItem =
  | { readonly kind: 'radio'; readonly id: string; readonly label: string; readonly mnemonic?: string; readonly checked: boolean; readonly enabled: boolean; readonly patch?: ThemePreferencePatch }
  | { readonly kind: 'submenu'; readonly id: 'theme.dark' | 'theme.light'; readonly label: string; readonly mnemonic: string; readonly items: readonly ThemeMenuItem[] }
  | { readonly kind: 'action'; readonly id: 'theme.create' | 'theme.openFolder' | 'theme.reload'; readonly label: string; readonly mnemonic: string; readonly command: Extract<CommandId, 'preferences.createTheme' | 'preferences.openThemesFolder' | 'preferences.reloadThemes'> }
  | { readonly kind: 'separator' }

const themeLabelLength = 48
const slotOf = (type: ThemeType) => type === 'dark' ? 'darkTheme' as const : 'lightTheme' as const

/** Theme names come from user files: sanitized and cut to 48 characters. */
export function themeLabel(name: string): string {
  const characters = [...sanitizeLabel(name, Infinity)]
  return characters.length > themeLabelLength ? characters.slice(0, themeLabelLength - 1).join('') + '…' : characters.join('')
}
/** How a label reads on screen: compatibility forms folded (a no-break space is a space) and blank runs collapsed and trimmed. */
export const lookalike = (label: string) => [...label.normalize('NFKC').replace(/[\s⠀]+/gu, ' ').trim()]
/**
 * Labels that could pass for each other: the same length, and every difference pairs an ASCII character with a
 * non-ASCII one, as a Cyrillic а does with a Latin a. Names in one script that merely differ are left alone.
 */
export const confusable = (a: string[], b: string[]) => a.length === b.length && a.every((character, index) => character === b[index] || (character < '\x80') !== (b[index] < '\x80'))

function themeList(theme: Pick<ThemeState, 'preference' | 'themes'>, list: ThemeType): ThemeMenuItem[] {
  const { preference, themes } = theme
  const selected = preference[slotOf(list)], fallback = builtinThemes[list].name
  const shown = themes.filter(summary => summary.types.includes(list) || !summary.usable || summary.id === selected)
  const labels = shown.map(summary => themeLabel(summary.name)), looks = labels.map(lookalike)
  const items = shown.map((summary, index): ThemeMenuItem => {
    const supported = summary.usable && summary.types.includes(list), checked = summary.id === selected
    let label = looks.some((look, other) => other !== index && confusable(look, looks[index])) ? `${labels[index]} (${summary.id})` : labels[index]
    if (!summary.usable) label += checked ? ` (invalid: using ${fallback})` : ' (invalid)'
    else if (!supported) label += ` (no ${list} variant: using ${fallback})`
    return { kind: 'radio', id: `theme.${list}.${summary.id}`, label, checked, enabled: supported, patch: themeChoice(preference, summary, list) }
  })
  if (!shown.some(summary => summary.id === selected)) items.push({ kind: 'radio', id: `theme.${list}.${selected}`, label: `${selected} (missing: using ${fallback})`, checked: true, enabled: false })
  return items
}

export function themeMenuModel(theme: Pick<ThemeState, 'preference' | 'themes'>): ThemeMenuItem[] {
  const mode = theme.preference.mode
  const modeItem = (value: ThemePreference['mode'], label: string, mnemonic: string): ThemeMenuItem =>
    ({ kind: 'radio', id: 'theme.mode.' + value, label, mnemonic, checked: mode === value, enabled: true, patch: { mode: value } })
  return [
    modeItem('dark', 'Dark', 'd'), modeItem('light', 'Light', 'l'), modeItem('system', 'Follow System', 's'),
    { kind: 'separator' },
    { kind: 'submenu', id: 'theme.dark', label: 'Dark Theme', mnemonic: 'k', items: themeList(theme, 'dark') },
    { kind: 'submenu', id: 'theme.light', label: 'Light Theme', mnemonic: 'g', items: themeList(theme, 'light') },
    { kind: 'separator' },
    { kind: 'action', id: 'theme.create', label: 'Create Custom Theme…', mnemonic: 't', command: 'preferences.createTheme' },
    { kind: 'action', id: 'theme.openFolder', label: 'Open Themes Folder', mnemonic: 'o', command: 'preferences.openThemesFolder' },
    { kind: 'action', id: 'theme.reload', label: 'Reload Themes', mnemonic: 'r', command: 'preferences.reloadThemes' }
  ]
}
