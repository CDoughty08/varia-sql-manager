import { composite, ensureContrast, hexColor, opaqueHex, parseHex, type Rgba } from './color'
import { cssVariable, type ColorKey } from './registry'
import type { ResolvedTheme } from './types'

export const connectionColorNames = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const
export type ConnectionColorName = typeof connectionColorNames[number]
export interface ConnectionPreset { name: ConnectionColorName; label: string; stored: string; key: ColorKey }
/**
 * What connections.json holds for each preset: an identifier, never painted. They are the first Varia Dark values and
 * stay fixed when the palette changes, so saved profiles keep their preset and follow the active theme.
 */
const storedPresets: Readonly<Record<ConnectionColorName, string>> = { red: '#e66b73', orange: '#e6a15c', yellow: '#dec766', green: '#79bb8b', blue: '#71a7df', purple: '#ad8bd8' }
/** The connection dialog presets, in its order. */
export const connectionPresets: readonly ConnectionPreset[] = connectionColorNames.map(name => ({
  name, label: name[0].toUpperCase() + name.slice(1), stored: storedPresets[name], key: `connection.${name}` as ColorKey
}))
/**
 * The surfaces a connection accent is drawn on: Object Explorer, query tab strip, editor, and both status bars in every
 * state, since their connection edge stays while a query runs or fails.
 */
export const connectionAccentSurfaces: readonly ColorKey[] = ['sideBar.background', 'documentTabs.background', 'editor.background', 'statusBar.background',
  'statusBar.executingBackground', 'statusBar.disconnectedBackground', 'statusBar.errorBackground', 'queryStatusBar.background', 'queryStatusBar.executingBackground',
  'queryStatusBar.errorBackground']

/**
 * The CSS color for a stored connection color: a preset becomes its theme variable (so it switches live), a custom
 * color is moved toward the foreground until it reaches 3:1 on every accent surface, and no color is undefined.
 */
const presetOf = (color: Rgba) => color.a === 255 ? connectionPresets.find(entry => entry.stored === opaqueHex(color)) : undefined

export function connectionAccent(stored: string | undefined, active: ResolvedTheme): string | undefined {
  const color = stored ? parseHex(stored) : undefined
  if (!color) return undefined
  const preset = presetOf(color)
  if (preset) return `var(${cssVariable(preset.key)})`
  const editor = hexColor(active.colors['editor.background'])
  const surfaces = connectionAccentSurfaces.map(key => opaqueHex(composite(hexColor(active.colors[key]), editor)))
  return ensureContrast(opaqueHex(color), surfaces, 3, opaqueHex(composite(hexColor(active.colors.foreground), editor)))
}

/**
 * The `#rrggbb` the color picker shows: a preset (or no color, which the picker offers as blue) as the active theme
 * paints it, a custom color as stored. Only what is shown changes; the stored value stays the preset's.
 */
export function connectionPickerColor(stored: string | undefined, active: ResolvedTheme): string {
  const color = stored ? parseHex(stored) : undefined
  const preset = color ? presetOf(color) : connectionPresets.find(entry => entry.name === 'blue')
  if (color && !preset) return opaqueHex(color)
  return opaqueHex(composite(hexColor(active.colors[preset!.key]), hexColor(active.colors['editor.background'])))
}
