import type { ThemeType } from './types'

/**
 * The palette slots, what they drive, and the built-in Varia Dark and Varia Light values: graphite neutrals, one iris
 * accent, status colors kept for state, and a separate categorical set for charts. This is the only place built-in
 * colors are written down; every registry default refers to a slot or another key.
 */
const slots = {
  canvas: ['Editor, active document tab, dock group, app root, and window background.', '#16181d', '#ffffff'],
  panel: ['Output panel, its tab bar, and the results grid and its headers.', '#16181d', '#ffffff'],
  sideBar: ['Object Explorer.', '#111317', '#f7f8fa'],
  chrome: ['Title bar, toolbar, tab strips, and the status bar.', '#111317', '#f7f8fa'],
  raised: ['The quick-input title.', '#1c1f25', '#f1f3f6'],
  overlay: ['Dialogs, menus, editor widgets, toasts, and docking compass cells.', '#1d2026', '#ffffff'],
  input: ['Inputs and selects.', '#101216', '#ffffff'],
  accentSurface: ['Tinted chrome: the status bars while a query runs, and the active connection row.', '#1c2136', '#eef0fd'],
  hover: ['Hover fill.', '#262a32', '#dfe2e7'],
  active: ['Pressed button, open menu, highlighted menu item, and badge fill.', '#30343e', '#d6dae0'],
  selection: ['Unfocused selection, and the headers of selected cells.', '#21273b', '#e7ebfc'],
  selectionStrong: ['Focused selection, and the docking compass cell under the pointer.', '#29314f', '#d9e0fb'],
  textSelection: ['Editor text selection.', '#2f3b66', '#c8d2fa'],
  text: ['Body text.', '#d9dce3', '#1c1f26'],
  textStrong: ['Hover and emphasis text.', '#f5f6f8', '#0a0c10'],
  textSecondary: ['Buttons, labels, and headings.', '#bcc1cb', '#3a404b'],
  textTertiary: ['Captions and section titles.', '#a3a9b5', '#4d5461'],
  textMuted: ['Hints, counts, and inactive tabs; the lowest text tier that passes AA on every surface, hover included.', '#9298a4', '#5c6370'],
  textAccent: ['Selected or active labels.', '#bcc5ff', '#3240b0'],
  accentMuted: ['A muted accent for text and glyphs; no built-in key uses it, so themes can point keys at it.', '#aab3d9', '#3d4887'],
  border: ['Chrome borders and tab dividers.', '#262a31', '#e3e6eb'],
  borderSubtle: ['Section headers and grid lines.', '#1f2228', '#eceef2'],
  borderStrong: ['Dock splitters.', '#2e323a', '#d4d8df'],
  separator: ['Toolbar, menu, and dialog separators; the keyboard shortcut outline.', '#30343c', '#dcdfe5'],
  controlBorder: ['Outlined buttons, the Dark dialog border, result splitters, and docking compass borders.', '#6b7286', '#878e9b'],
  inputBorder: ['Input borders.', '#6a7184', '#878e9b'],
  accent: ['Primary button, active indicators, the brand icon, and the docking compass.', '#8f9cff', '#4453d0'],
  accentHover: ['Primary button hover.', '#a8b2ff', '#3744b8'],
  onAccent: ['Text on the accent color.', '#0e1230', '#ffffff'],
  focus: ['Focus rings and the active sash.', '#8f9cff', '#4453d0'],
  error: ['Error text.', '#f39a9a', '#b42229'],
  warning: ['Warning text.', '#e4bb6a', '#875800'],
  success: ['Success text.', '#74d19c', '#146f3b'],
  info: ['Information text.', '$accent', '$accent'],
  errorSurface: ['Error banner and the status bar error state.', '#3a1d22', '#fdecec'],
  errorSurfaceText: ['Text on the error surface.', '#f6bcc1', '#8f1d24'],
  warningSurface: ['Warning banner.', '#33291a', '#fff5dc'],
  warningSurfaceText: ['Text on the warning surface.', '#f0d49e', '#6b4400'],
  icon: ['Glyphs, Object Explorer object icons included.', '#a3a9b5', '#4d5461'],
  iconMuted: ['Secondary glyphs such as tree chevrons.', '#7f8694', '#6b7280'],
  iconFolder: ['Folder glyphs.', '#bfa878', '#7d6532'],
  red: ['Red connection preset; categorical color.', '#e66767', '#c42b3c'],
  orange: ['Orange connection preset; categorical color.', '#e09358', '#b45309'],
  yellow: ['Yellow connection preset; categorical color.', '#d8bf5e', '#8f6b00'],
  green: ['Green connection preset; categorical color.', '#6fbf8a', '#2e7d4f'],
  blue: ['Blue connection preset; categorical color.', '#6ea4ea', '#2563a8'],
  purple: ['Purple connection preset; categorical color.', '#ab95ea', '#7a4bbf'],
  neutral: ['The "no color" connection swatch.', '#8d939f', '#6b7280'],
  chart1: ['First chart series (blue). The five chart slots are one categorical set, checked for color-vision deficiencies and 3:1 on the editor and widget backgrounds; they color chart series only, never state.', '#3987e5', '#2a78d6'],
  chart2: ['Second chart series (orange).', '#d95926', '#d4581f'],
  chart3: ['Third chart series (green).', '#199e70', '#12936a'],
  chart4: ['Fourth chart series (yellow).', '#c98500', '#a87200'],
  chart5: ['Fifth chart series (purple).', '#9085e9', '#6250d6'],
  syntaxKeyword: ['SQL keywords.', '#93a4ff', '#3442c2'],
  syntaxString: ['SQL strings.', '#9fd4a9', '#2c7440'],
  syntaxComment: ['SQL comments.', '#868e9b', '#636a76'],
  syntaxNumber: ['SQL numbers.', '#e8b97d', '#965700'],
  syntaxOperator: ['SQL operators.', '#9ea6b4', '#575e6b'],
  syntaxFunction: ['SQL built-in functions and variables.', '#d4a9f2', '#8338b4'],
  syntaxIdentifier: ['SQL identifiers and default editor text.', '#d9dce3', '#1c1f26'],
  syntaxDelimiter: ['SQL commas, semicolons, and dots.', '#9ea6b4', '#575e6b'],
  syntaxBracket1: ['SQL brackets at the outermost level; the editor colors matched brackets by depth.', '#dcc06a', '#7a5c00'],
  syntaxBracket2: ['SQL brackets one level in.', '#cd9ff0', '#8338b4'],
  syntaxBracket3: ['SQL brackets two levels in; deeper brackets repeat the three colors.', '#74b4ef', '#1d68ad'],
  shadow: ['Shadows.', '#00000085', '#10182824'],
  backdrop: ['Modal scrim.', '#0a0c10b3', '#1c1f2652']
} as const satisfies Record<string, readonly [string, string, string]>

export type PaletteSlot = keyof typeof slots
export const paletteSlots = Object.keys(slots) as PaletteSlot[]
export const paletteDescriptions = Object.fromEntries(paletteSlots.map(slot => [slot, slots[slot][0]])) as Record<PaletteSlot, string>
const variant = (index: 1 | 2) => Object.fromEntries(paletteSlots.map(slot => [slot, slots[slot][index]])) as Record<PaletteSlot, string>
/** Literals plus `info: "$accent"`; tests keep both free of cycles. */
export const builtinPalettes: Readonly<Record<ThemeType, Readonly<Record<PaletteSlot, string>>>> = { dark: variant(1), light: variant(2) }
export const builtinThemes: Readonly<Record<ThemeType, { id: string; name: string }>> = { dark: { id: 'varia-dark', name: 'Varia Dark' }, light: { id: 'varia-light', name: 'Varia Light' } }
export const isPaletteSlot = (name: string): name is PaletteSlot => Object.hasOwn(slots, name)
