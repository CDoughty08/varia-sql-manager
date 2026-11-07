import type { CommandId } from './catalog'
import type { Platform } from './keybindings'

/**
 * Mouse gestures: the pointer behaviours that read a modifier, are bound to a command, or are fixed by the platform or a
 * library. Handlers never read `ctrlKey`, `metaKey`, `altKey` or `shiftKey` on a pointer event themselves; they ask
 * `GestureService.matches` (`src/renderer/src/core/gestures.ts`), so a remapped modifier (PR D2) applies everywhere at
 * once (`tests/gesture-lint.test.ts`). Gestures are a catalogue of their own, not tokens in the key grammar.
 */

/** `mod` is Ctrl on Windows and Linux and ⌘ on macOS; `ctrl` is Control on every platform. */
export type GestureModifier = 'mod' | 'ctrl' | 'alt' | 'shift' | 'meta'
export const gestureModifiers: readonly GestureModifier[] = ['mod', 'ctrl', 'alt', 'shift', 'meta']
/** A gesture's modifiers, all held (other modifiers do not matter, as before the catalogue); empty means none needed. */
export type GestureModifiers = readonly GestureModifier[]
export type PointerAction = 'click' | 'doubleClick' | 'hover' | 'drag' | 'wheel'
/**
 * - `modifier`: a behaviour the modifier switches on while pointing, not a command.
 * - `pointerCommand`: a pointer action that runs a command, which also has a keyboard path (`keyboard`).
 * - `fixed`: decided by the platform, Chromium or a library; listed so the Mouse view can show it, never remapped.
 */
export type GestureKind = 'modifier' | 'pointerCommand' | 'fixed'

/** Where a gesture works; titles follow the Shortcuts page's scopes. */
export const gestureScopes = {
  global: 'Global',
  resultsGrid: 'Results Grid',
  tableDesigner: 'Table Designer',
  objectExplorer: 'Object Explorer',
  panels: 'Panels and Editor Tabs',
  popouts: 'Popout Windows',
  documentTabs: 'Document Tabs'
} as const
export type GestureScope = keyof typeof gestureScopes

export interface GestureDescriptor {
  readonly title: string
  /** One sentence for the Mouse view and docs. */
  readonly description: string
  readonly kind: GestureKind
  readonly scope: GestureScope
  /** Other scopes that share this gesture (one setting moves both). */
  readonly alsoIn?: readonly GestureScope[]
  readonly action: PointerAction
  /** What is pointed at, for labels: "a dock tab", "a column border". */
  readonly target: string
  readonly modifiers: GestureModifiers
  /** The gesture exists only on these platforms. */
  readonly platforms?: readonly Platform[]
  /** The modifier sets the user may choose, the default first; `[]` is "no modifier" where the action alone is free. */
  readonly choices?: readonly GestureModifiers[]
  /** Why the gesture cannot be remapped; every gesture without `choices` has one. */
  readonly locked?: string
  /** Commands that do the same from the keyboard (a key, or a context menu that Shift+F10 opens). Required for `pointerCommand`. */
  readonly keyboard?: readonly CommandId[]
}

const fixedNotYet = 'Only modifier gestures can be remapped in this version; F2 renames a focused tab.'

export const gestureCatalog = {
  'grid.addToSelection': {
    title: 'Add to Selection', description: 'Adds a block of cells, rows or columns to the selection instead of replacing it.',
    kind: 'modifier', scope: 'resultsGrid', alsoIn: ['tableDesigner'], action: 'click', target: 'a cell or header', modifiers: ['mod'],
    choices: [['mod'], ['alt']]
  },
  'grid.extendSelection': {
    title: 'Extend Selection', description: 'Extends the selection from the active cell to the pressed one.',
    kind: 'fixed', scope: 'resultsGrid', alsoIn: ['tableDesigner'], action: 'click', target: 'a cell or header', modifiers: ['shift'],
    locked: 'Shift extends a selection everywhere, as in SSMS and the operating system.'
  },
  'grid.secondaryClick': {
    title: 'Context Menu Click', description: 'Control+click is a right-click on macOS: it opens the context menu and keeps a selected block.',
    kind: 'fixed', scope: 'resultsGrid', alsoIn: ['tableDesigner'], action: 'click', target: 'a cell or header', modifiers: ['ctrl'], platforms: ['darwin'],
    locked: 'macOS treats Control+click as a right-click.'
  },
  'grid.fitColumn': {
    title: 'Fit Column', description: 'Fits a column to its widest loaded value.',
    kind: 'fixed', scope: 'resultsGrid', action: 'doubleClick', target: 'a column border', modifiers: [],
    locked: 'Double-clicking a column border fits it, as in SSMS.'
  },
  'global.wheelZoom': {
    title: 'Zoom', description: 'Zooms the window. The results grid and Object Explorer leave the wheel to Chromium while Control is held.',
    kind: 'fixed', scope: 'global', action: 'wheel', target: 'anywhere', modifiers: ['ctrl'], keyboard: ['view.zoomIn', 'view.zoomOut', 'view.resetZoom'],
    locked: 'Chromium zooms the window with Control+wheel and with a trackpad pinch.'
  },
  'explorer.peekHover': {
    title: 'Peek on Hover', description: 'Peeks a table, view, procedure or function while the pointer rests on its row.',
    kind: 'modifier', scope: 'objectExplorer', action: 'hover', target: 'an object', modifiers: ['mod'],
    // Not Alt: hovering presses nothing, so releasing Alt afterwards would count as a bare-Alt tap and focus the menu bar.
    choices: [['mod'], ['shift']], keyboard: ['explorer.peek']
  },
  'explorer.dragName': {
    title: 'Insert Name', description: 'Dropping an object in a query inserts its quoted name.',
    kind: 'fixed', scope: 'objectExplorer', action: 'drag', target: 'an object', modifiers: [], keyboard: ['explorer.copyName'],
    locked: 'Dragging is the only way to drop text; Copy Name does the same from the keyboard.'
  },
  'dock.floatWhileDragging': {
    title: 'Float While Dragging', description: 'Holding the modifier while dragging a tab floats it instead of docking it on a guide.',
    kind: 'modifier', scope: 'panels', action: 'drag', target: 'a tab', modifiers: ['ctrl'],
    choices: [['ctrl'], ['alt']], keyboard: ['pane.float', 'editor.float']
  },
  'dock.dragFloatingTitleBar': {
    title: 'Drag Floating Panel', description: 'Shift-dragging a floating panel\'s title bar hands the drag to Dockview instead of Varia\'s docking guides.',
    kind: 'fixed', scope: 'panels', action: 'drag', target: 'a floating title bar', modifiers: ['shift'],
    locked: 'Dockview\'s own gesture.'
  },
  'dock.toggleFloat': {
    title: 'Toggle Docking', description: 'Floats a docked panel, or docks a floating one.',
    kind: 'pointerCommand', scope: 'panels', action: 'doubleClick', target: 'a panel tab', modifiers: ['ctrl'],
    choices: [['ctrl'], ['alt'], ['shift']], keyboard: ['pane.float', 'pane.dock']
  },
  'popout.returnToMain': {
    title: 'Move Back into Main Window', description: 'Docks a popout window\'s panel back into the main window.',
    kind: 'pointerCommand', scope: 'popouts', action: 'doubleClick', target: 'a popout tab', modifiers: ['ctrl'],
    choices: [['ctrl'], ['alt'], ['shift']], keyboard: ['pane.moveToMainWindow']
  },
  'documentTabs.rename': {
    title: 'Rename Tab', description: 'Opens the rename box on a query tab.',
    kind: 'pointerCommand', scope: 'documentTabs', action: 'doubleClick', target: 'a query tab', modifiers: [],
    locked: fixedNotYet, keyboard: ['document.rename']
  }
} as const satisfies Record<string, GestureDescriptor>

export type GestureId = keyof typeof gestureCatalog
export const gestureIds = Object.keys(gestureCatalog) as GestureId[]
export const isGestureId = (value: unknown): value is GestureId => typeof value === 'string' && Object.hasOwn(gestureCatalog, value)
export const gestureDescriptor = (id: GestureId): GestureDescriptor => gestureCatalog[id]
export const gestureAvailable = (id: GestureId, platform: Platform): boolean => gestureDescriptor(id).platforms?.includes(platform) ?? true

/** The modifier an event field reports, after `mod` is resolved for the platform. */
export type PhysicalModifier = 'ctrl' | 'alt' | 'shift' | 'meta'
const physicalOrder: readonly PhysicalModifier[] = ['ctrl', 'shift', 'alt', 'meta']
export function physicalModifiers(modifiers: GestureModifiers, platform: Platform): readonly PhysicalModifier[] {
  const held = new Set(modifiers.map(modifier => modifier === 'mod' ? (platform === 'darwin' ? 'meta' : 'ctrl') : modifier))
  return physicalOrder.filter(modifier => held.has(modifier))
}

const actionWords: Readonly<Record<PointerAction, string>> = { click: 'Click', doubleClick: 'Double-click', hover: 'Hover', drag: 'Drag', wheel: 'Wheel' }
const shortNames = (platform: Platform): Readonly<Record<PhysicalModifier, string>> =>
  platform === 'darwin' ? { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' } : { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: platform === 'win32' ? 'Win' : 'Super' }
const longNames = (platform: Platform): Readonly<Record<PhysicalModifier, string>> =>
  platform === 'darwin' ? { ctrl: 'Control', alt: 'Option', shift: 'Shift', meta: 'Command' } : { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: platform === 'win32' ? 'Win' : 'Super' }
const macOrder: readonly PhysicalModifier[] = ['ctrl', 'alt', 'shift', 'meta']

/** A modifier set as shown in a dropdown: `Ctrl`, `⌘`, or `None`. */
export function modifiersLabel(modifiers: GestureModifiers, platform: Platform): string {
  const held = physicalModifiers(modifiers, platform), names = shortNames(platform)
  if (!held.length) return 'None'
  return platform === 'darwin' ? macOrder.filter(modifier => held.includes(modifier)).map(modifier => names[modifier]).join('') : held.map(modifier => names[modifier]).join('+')
}

/** A gesture as shown in a table: `Ctrl+Double-click`, `⌘ Click`, `Double-click`. */
export function gestureLabel(action: PointerAction, modifiers: GestureModifiers, platform: Platform): string {
  if (!modifiers.length) return actionWords[action]
  return modifiersLabel(modifiers, platform) + (platform === 'darwin' ? ' ' : '+') + actionWords[action]
}

/** A gesture in a sentence or tooltip: `Ctrl-drag`, `Command-click`, `double-click`. */
export function gesturePhrase(action: PointerAction, modifiers: GestureModifiers, platform: Platform): string {
  const held = physicalModifiers(modifiers, platform), names = longNames(platform)
  const order = platform === 'darwin' ? macOrder.filter(modifier => held.includes(modifier)) : held
  const word = actionWords[action]
  return order.length ? [...order.map(modifier => names[modifier]), word.toLowerCase()].join('-') : word.toLowerCase()
}
