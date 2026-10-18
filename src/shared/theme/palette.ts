import type { ThemeType } from './types'

/**
 * The palette slots, what they drive, and the built-in Varia Dark and Varia Light values. Together with the docking
 * compass literals in registry.ts, this is the only place built-in colors are written down.
 */
const slots = {
  canvas: ['Editor, active document tab, dock group, app root, and window background.', '#11151c', '#ffffff'],
  panel: ['Output panel and results grid.', '#141a23', '#fafbfc'],
  sideBar: ['Object Explorer.', '#151b24', '#f3f5f8'],
  chrome: ['Title bar, toolbar, tab strips, and panel title bar.', '#181f2a', '#e9edf2'],
  raised: ['Grid header, the visible tab of an unfocused group, and the quick-input title.', '#202a39', '#e1e7ee'],
  overlay: ['Dialogs, menus, editor widgets, and toasts.', '#1a2230', '#ffffff'],
  input: ['Inputs and selects.', '#111721', '#ffffff'],
  accentSurface: ['Tinted chrome: the status bar and the active connection row.', '#1d2b40', '#e3ebf5'],
  hover: ['Hover fill.', '#263041', '#d0d8e3'],
  active: ['Pressed button, open menu, and badge fill.', '#2e3c51', '#ccd6e3'],
  selection: ['Unfocused selection and the active dock tab.', '#24324a', '#d6e3f3'],
  selectionStrong: ['Focused selection and menu highlight.', '#2e4058', '#c4daf4'],
  textSelection: ['Editor text selection.', '#264f78', '#add6ff'],
  text: ['Body text.', '#d9e1ec', '#1f2733'],
  textStrong: ['Hover and emphasis text.', '#ffffff', '#0b1220'],
  textSecondary: ['Buttons, labels, and headings.', '#c3cddd', '#2f3a49'],
  textTertiary: ['Captions and section titles.', '#9eafc5', '#465366'],
  textMuted: ['Hints, counts, and inactive tabs; the lowest text tier that passes AA on every surface, hover included.', '#8a9cb3', '#525e72'],
  textAccent: ['Selected or active labels.', '#bcd4fa', '#0b4f99'],
  accentMuted: ['Text and glyphs on tinted chrome (status bar, brand icon, object icons, section headers).', '#a3bbdc', '#2a4f7f'],
  border: ['Chrome borders and tab dividers.', '#2b3443', '#d3d9e2'],
  borderSubtle: ['Section headers and grid lines.', '#252f3d', '#e3e7ed'],
  borderStrong: ['Dock splitters.', '#303b4c', '#c3ccd8'],
  separator: ['Toolbar, menu, and dialog separators; the keyboard shortcut outline.', '#354359', '#cdd4de'],
  controlBorder: ['Outlined buttons and the Dark dialog border.', '#5f7089', '#8792a2'],
  inputBorder: ['Input borders.', '#5d6e88', '#8792a2'],
  accent: ['Primary button and active indicators.', '#8fb7ff', '#005fb8'],
  accentHover: ['Primary button hover.', '#accaff', '#004c94'],
  onAccent: ['Text on the accent color.', '#101b2d', '#ffffff'],
  focus: ['Focus rings and the active sash.', '#76acff', '#005fb8'],
  error: ['Error text.', '#f39c9f', '#ae2117'],
  warning: ['Warning text.', '#dfbd82', '#8a5300'],
  success: ['Success text.', '#8addac', '#146c38'],
  info: ['Information text.', '$accent', '$accent'],
  errorSurface: ['Error banner and the status bar error state.', '#48242d', '#fbe4e6'],
  errorSurfaceText: ['Text on the error surface.', '#f3bac0', '#8a1c25'],
  warningSurface: ['Warning banner.', '#3d3322', '#fff3d6'],
  warningSurfaceText: ['Text on the warning surface.', '#f0d49b', '#6b4400'],
  icon: ['Glyphs.', '#8aa9d4', '#3e6696'],
  iconMuted: ['Secondary glyphs such as tree chevrons.', '#7e93b1', '#637189'],
  iconFolder: ['Folder glyphs.', '#d9b370', '#9a6700'],
  red: ['Red connection preset; categorical color.', '#e66b73', '#c42b3c'],
  orange: ['Orange connection preset; categorical color.', '#e6a15c', '#b45309'],
  yellow: ['Yellow connection preset; categorical color.', '#dec766', '#8f6b00'],
  green: ['Green connection preset; categorical color.', '#79bb8b', '#2e7d4f'],
  blue: ['Blue connection preset; categorical color.', '#71a7df', '#2563a8'],
  purple: ['Purple connection preset; categorical color.', '#ad8bd8', '#7a4bbf'],
  neutral: ['The "no color" connection swatch.', '#8b9bb0', '#6b7789'],
  syntaxKeyword: ['SQL keywords.', '#569cd6', '#0000ff'],
  syntaxString: ['SQL strings.', '#ff4040', '#c41a16'],
  syntaxComment: ['SQL comments.', '#6a9955', '#008000'],
  syntaxNumber: ['SQL numbers.', '#b5cea8', '#097a50'],
  syntaxOperator: ['SQL operators.', '#778899', '#5e6875'],
  syntaxFunction: ['SQL built-in functions and variables.', '#ff00ff', '#b000b0'],
  syntaxIdentifier: ['SQL identifiers and default editor text.', '#d4d4d4', '#1f2733'],
  syntaxDelimiter: ['SQL commas, semicolons, and dots.', '#dcdcdc', '#1f2733'],
  syntaxBracket1: ['SQL brackets at the outermost level; the editor colors matched brackets by depth.', '#ffd700', '#0431fa'],
  syntaxBracket2: ['SQL brackets one level in.', '#da70d6', '#287a28'],
  syntaxBracket3: ['SQL brackets two levels in; deeper brackets repeat the three colors.', '#179fff', '#7b3814'],
  shadow: ['Shadows.', '#00000099', '#0000002e'],
  backdrop: ['Modal scrim.', '#080c14bf', '#1f273366']
} as const satisfies Record<string, readonly [string, string, string]>

export type PaletteSlot = keyof typeof slots
export const paletteSlots = Object.keys(slots) as PaletteSlot[]
export const paletteDescriptions = Object.fromEntries(paletteSlots.map(slot => [slot, slots[slot][0]])) as Record<PaletteSlot, string>
const variant = (index: 1 | 2) => Object.fromEntries(paletteSlots.map(slot => [slot, slots[slot][index]])) as Record<PaletteSlot, string>
/** Literals plus `info: "$accent"`; tests keep both free of cycles. */
export const builtinPalettes: Readonly<Record<ThemeType, Readonly<Record<PaletteSlot, string>>>> = { dark: variant(1), light: variant(2) }
export const builtinThemes: Readonly<Record<ThemeType, { id: string; name: string }>> = { dark: { id: 'varia-dark', name: 'Varia Dark' }, light: { id: 'varia-light', name: 'Varia Light' } }
export const isPaletteSlot = (name: string): name is PaletteSlot => Object.hasOwn(slots, name)
