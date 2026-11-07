import { altGrReason, characterKeys, splitChord, type Platform } from './keybindings'

/**
 * Keys the operating system or desktop may take before Varia sees them. `refused` keys never reach the page (or type
 * characters), so a shortcut on them could never run; `warning` keys reach it on some systems, so the user may keep
 * them. `reservedReason` (keybindings.ts) holds the keys Varia and Electron themselves keep.
 */
export interface OsKeyVerdict { readonly level: 'refused' | 'warning'; readonly reason: string }

type Entry = readonly [chord: string, level: OsKeyVerdict['level'], reason: string]
const functionKeys = Array.from({ length: 12 }, (_, index) => `f${index + 1}`)
const arrows = ['up', 'down', 'left', 'right']

/** Exact chords, in canonical form. */
export const osKeys: Readonly<Record<Platform, readonly Entry[]>> = {
  win32: [
    ['ctrl+alt+delete', 'refused', 'Windows keeps Ctrl+Alt+Delete'],
    ['ctrl+shift+escape', 'refused', 'opens Task Manager'],
    ['ctrl+escape', 'refused', 'opens the Start menu'],
    ['alt+tab', 'refused', 'switches windows'],
    ['shift+alt+tab', 'refused', 'switches windows'],
    ['alt+escape', 'refused', 'switches windows'],
    ['meta+l', 'refused', 'locks the computer'],
    ['alt+space', 'warning', 'opens the window menu']
  ],
  linux: [
    ...functionKeys.map((key): Entry => [`ctrl+alt+${key}`, 'refused', 'switches virtual terminals']),
    ['alt+tab', 'refused', 'switches windows'],
    ['shift+alt+tab', 'refused', 'switches windows'],
    ['ctrl+alt+t', 'warning', 'opens a terminal on many desktops'],
    ['ctrl+alt+l', 'warning', 'locks the screen on many desktops'],
    ['ctrl+alt+delete', 'warning', 'logs out or restarts on many desktops'],
    ['ctrl+alt+backspace', 'warning', 'may stop the display server'],
    ['alt+f1', 'warning', 'opens the desktop menu on some desktops'],
    ['alt+f2', 'warning', 'opens the run dialog on some desktops'],
    ['alt+space', 'warning', 'opens the window menu on some desktops'],
    ...arrows.map((key): Entry => [`ctrl+alt+${key}`, 'warning', 'switches workspaces on some desktops'])
  ],
  darwin: [
    ['meta+tab', 'refused', 'switches apps'],
    ['shift+meta+tab', 'refused', 'switches apps'],
    ['alt+meta+escape', 'refused', 'opens Force Quit'],
    ['ctrl+meta+q', 'refused', 'locks the screen'],
    ['meta+space', 'warning', 'opens Spotlight'],
    ['ctrl+space', 'warning', 'switches the input source'],
    ['ctrl+meta+space', 'warning', 'opens the Character Viewer'],
    ['alt+meta+d', 'warning', 'shows or hides the Dock'],
    ...['3', '4', '5'].map((key): Entry => [`shift+meta+${key}`, 'warning', 'takes a screenshot']),
    ...arrows.map((key): Entry => [`ctrl+${key}`, 'warning', 'Mission Control may take it'])
  ]
}
const table = (entries: readonly Entry[]): ReadonlyMap<string, OsKeyVerdict> => new Map(entries.map(([chord, level, reason]) => [chord, { level, reason }]))
const tables: Readonly<Record<Platform, ReadonlyMap<string, OsKeyVerdict>>> = { win32: table(osKeys.win32), linux: table(osKeys.linux), darwin: table(osKeys.darwin) }

/**
 * What the system may do with `chord` on `platform`. AltGr is Ctrl+Alt on Windows, so Ctrl+Alt with a character is
 * refused there; Linux reports AltGr as its own key, so Ctrl+Alt+character only may clash with a layout or desktop.
 */
export function osKeyVerdict(chord: string, platform: Platform): OsKeyVerdict | undefined {
  const listed = tables[platform].get(chord)
  if (listed) return listed
  const { modifiers, key } = splitChord(chord)
  const ctrlAlt = modifiers.has('ctrl') && modifiers.has('alt') && !modifiers.has('meta') && characterKeys.includes(key)
  if (platform === 'win32' && ctrlAlt) return { level: 'refused', reason: altGrReason }
  if (platform === 'linux' && ctrlAlt) return { level: 'warning', reason: 'some keyboard layouts or desktops use Ctrl+Alt with a character' }
  if (platform === 'win32' && modifiers.has('meta')) return { level: 'warning', reason: 'Windows keeps many Windows-key shortcuts' }
  if (platform === 'linux' && modifiers.has('meta')) return { level: 'warning', reason: 'the desktop may keep Super shortcuts' }
  return undefined
}
