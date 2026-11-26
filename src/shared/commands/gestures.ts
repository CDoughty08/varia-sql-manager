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
export type PointerAction = 'click' | 'doubleClick' | 'hover' | 'drag' | 'wheel' | 'backButton' | 'forwardButton'
/**
 * - `modifier`: a behaviour the modifier switches on while pointing, not a command.
 * - `pointerCommand`: a pointer action that runs a command, which also has a keyboard path (`keyboard`).
 * - `fixed`: decided by the platform, Chromium or a library; listed so the Mouse view can show it, never remapped.
 */
export type GestureKind = 'modifier' | 'pointerCommand' | 'fixed'

/** Where a gesture works; titles follow the Shortcuts page's scopes. */
export const gestureScopes = {
  global: 'Global',
  queryEditor: 'SQL Query Editor',
  resultsGrid: 'Results Grid',
  messages: 'Query Messages',
  tableDesigner: 'Table Designer',
  objectExplorer: 'Object Explorer',
  panels: 'Panels and Editor Tabs',
  popouts: 'Popout Windows',
  documentTabs: 'Document Tabs',
  integrationServices: 'Integration Services',
  connectionDialog: 'Connect Dialog'
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
  /**
   * macOS's own default and choices, where the others' would not work there: Control+click is a right-click on macOS,
   * so a Control+double-click opens the context menu and never arrives as a double-click, and a Control-drag opens it
   * instead of starting.
   */
  readonly darwin?: { readonly modifiers: GestureModifiers; readonly choices?: readonly GestureModifiers[] }
  /** Why the gesture cannot be remapped; every gesture without `choices` has one. */
  readonly locked?: string
  /** Commands that do the same from the keyboard (a key, or a context menu that Shift+F10 opens). Required for `pointerCommand`. */
  readonly keyboard?: readonly CommandId[]
  /** A control the gesture's press lands on, which takes the press for itself (a header's sort button): gestures with different
   *  places never start on one press. Undefined is the scope's surface. */
  readonly place?: string
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
    kind: 'fixed', scope: 'resultsGrid', alsoIn: ['tableDesigner', 'objectExplorer'], action: 'click', target: 'a cell or header', modifiers: ['ctrl'], platforms: ['darwin'],
    locked: 'macOS treats Control+click as a right-click.'
  },
  'grid.addSortKey': {
    title: 'Add Sort Column', description: 'Adds the column to the grid\'s sort after the columns it already sorts by, or changes its direction there.',
    kind: 'modifier', scope: 'resultsGrid', place: 'sortButton', action: 'click', target: 'a column header\'s sort button', modifiers: ['shift'],
    choices: [['shift'], ['mod']], keyboard: ['output.thenSortAscending', 'output.thenSortDescending']
  },
  'grid.fitColumn': {
    title: 'Fit Column', description: 'Fits a column to its widest loaded value.',
    kind: 'fixed', scope: 'resultsGrid', action: 'doubleClick', target: 'a column border', modifiers: [],
    locked: 'Double-clicking a column border fits it, as in SSMS; Fit Column in the grid menu also works from the keyboard.', keyboard: ['output.fitColumn']
  },
  'global.wheelZoom': {
    title: 'Zoom', description: 'Zooms the window outside surfaces with their own wheel gestures.',
    kind: 'fixed', scope: 'global', action: 'wheel', target: 'the workbench', modifiers: ['ctrl'], keyboard: ['view.zoomIn', 'view.zoomOut', 'view.resetZoom'],
    locked: 'Chromium zooms the window with Control+wheel and with a trackpad pinch.'
  },
  'editor.wheelZoom': {
    title: 'Zoom Editor Text', description: 'Scroll up to enlarge editor text or down to shrink it for this session.',
    kind: 'fixed', scope: 'queryEditor', action: 'wheel', target: 'editor text', modifiers: ['ctrl'],
    locked: 'Monaco handles editor zoom. On macOS, Command+wheel and trackpad pinch also work.'
  },
  'connections.connect': {
    title: 'Connect to Saved Connection', description: 'Connects to the saved connection in the Connect dialog.',
    kind: 'fixed', scope: 'connectionDialog', action: 'doubleClick', target: 'a saved connection', modifiers: [],
    locked: 'Double-clicking submits the Connect dialog; Enter on a focused saved connection also connects, while Space selects it for editing.'
  },
  'explorer.peekHover': {
    title: 'Peek on Hover', description: 'Peeks the object (a table, procedure, index, login and so on) while the pointer rests on its row.',
    kind: 'modifier', scope: 'objectExplorer', action: 'hover', target: 'an object', modifiers: ['mod'],
    // Not Alt: hovering presses nothing, so releasing Alt afterwards would count as a bare-Alt tap and focus the menu bar.
    choices: [['mod'], ['shift']], keyboard: ['explorer.peek']
  },
  'explorer.openPeekTab': {
    title: 'Open Peek as Tab', description: 'Opens Peek on the object (a table, procedure, index, login and so on) in a document tab.',
    kind: 'pointerCommand', scope: 'objectExplorer', action: 'click', target: 'an object', modifiers: ['mod'],
    choices: [['mod'], ['shift']], keyboard: ['explorer.openPeekTab']
  },
  // The column profile's peek: while held over the panel, it shows the other list (only the selected columns, or every column
  // when Selected Columns Only is on). Scoped to the panel: over the grid the same Ctrl is Add to Selection and Ctrl+C.
  'output.profilePeekHover': {
    title: 'Peek at Selected Columns', description: 'Shows only the selected columns\' cards in the column profile (or every column when Selected Columns Only is on) while the pointer rests on the panel.',
    kind: 'modifier', scope: 'resultsGrid', action: 'hover', target: 'the column profile', modifiers: ['mod'],
    // Not Alt: hovering presses nothing, so releasing Alt afterwards would count as a bare-Alt tap and focus the menu bar.
    choices: [['mod'], ['shift']], keyboard: ['output.toggleProfileSelectedColumns']
  },
  // Object Explorer's Peek on Hover in the query editor: the same card, anchored at the name.
  'editor.peekHover': {
    title: 'Peek Definition on Hover', description: 'Peeks the object whose name the pointer rests on (a table, view, procedure, function and so on) in a card beside it.',
    kind: 'modifier', scope: 'queryEditor', action: 'hover', target: 'an object name', modifiers: ['mod'],
    // Not Alt: hovering presses nothing, so releasing Alt afterwards would count as a bare-Alt tap and focus the menu bar.
    choices: [['mod'], ['shift']], keyboard: ['edit.peekDefinition']
  },
  // Ctrl+click (⌘-click on macOS) opens a Peek tab, as on an Object Explorer row; Alt for those who moved Monaco's multi-cursor
  // click to Ctrl (textEditor.multiCursorModifier). The id is Go To Definition's click's, so a choice made for it carries over.
  'editor.goToDefinition': {
    title: 'Open Definition in Peek Tab', description: 'Opens Peek on the object whose name is clicked (a table, view, procedure, function and so on) in a document tab.',
    kind: 'pointerCommand', scope: 'queryEditor', action: 'click', target: 'an object name', modifiers: ['mod'],
    choices: [['mod'], ['alt']], keyboard: ['edit.openPeekTab']
  },
  'explorer.dragName': {
    title: 'Insert Name', description: 'Dropping an object in a query inserts its quoted name.',
    kind: 'fixed', scope: 'objectExplorer', action: 'drag', target: 'an object', modifiers: [], keyboard: ['explorer.copyName'],
    locked: 'Dragging is the only way to drop text; Copy Name does the same from the keyboard.'
  },
  'explorer.reorderServer': {
    title: 'Reorder Servers', description: 'Dropping a server above or below another server, or below the last row, moves it where its line shows; the order is kept for the next start.',
    kind: 'fixed', scope: 'objectExplorer', action: 'drag', target: 'a server', modifiers: [], keyboard: ['explorer.moveServerUp', 'explorer.moveServerDown'],
    locked: 'Dragging is the pointer\'s way to reorder; Move Up and Move Down in the server\'s menu do the same from the keyboard.'
  },
  'explorer.moveQueryToServer': {
    title: 'Move Query to Server', description: 'Dropping a server or database on a query\'s tab or editor moves the query there, as Change Connection does; on a tab strip\'s empty space it opens a new query.',
    // Not listed in the query editor: Insert Server Name's modifier is that drop's variant there, and the Mouse view would call a shared scope a clash.
    kind: 'fixed', scope: 'objectExplorer', alsoIn: ['documentTabs'], action: 'drag', target: 'a server or database', modifiers: [],
    locked: 'Dragging is the pointer\'s way to move a query; Change Connection does the same from the keyboard.'
  },
  'explorer.dropServerName': {
    title: 'Insert Server Name', description: 'Holding the modifier while dropping a server or database on a query\'s editor inserts its name at the caret instead of moving the query.',
    kind: 'modifier', scope: 'queryEditor', action: 'drag', target: 'a server or database', modifiers: ['ctrl'],
    // macOS: ⌥, its own copy modifier while dragging (Control-drag opens the context menu there).
    choices: [['ctrl'], ['alt'], ['shift']], darwin: { modifiers: ['alt'], choices: [['alt'], ['shift'], ['meta']] }, keyboard: ['explorer.copyName']
  },
  'dock.floatWhileDragging': {
    title: 'Float While Dragging', description: 'Holding the modifier while dragging a tab floats it instead of docking it on a guide.',
    kind: 'modifier', scope: 'panels', action: 'drag', target: 'a tab', modifiers: ['ctrl'],
    // macOS: Control+press is a right-click there, so the tab's menu would open instead of the drag starting.
    choices: [['ctrl'], ['alt']], darwin: { modifiers: ['meta'], choices: [['meta'], ['alt']] }, keyboard: ['pane.float', 'editor.float']
  },
  'dock.dragFloatingTitleBar': {
    title: 'Drag Floating Panel', description: 'Shift-dragging a floating panel\'s title bar hands the drag to Dockview instead of Varia\'s docking guides.',
    kind: 'fixed', scope: 'panels', action: 'drag', target: 'a floating title bar', modifiers: ['shift'],
    locked: 'Dockview\'s own gesture.'
  },
  'dock.toggleFloat': {
    title: 'Toggle Docking', description: 'Floats a docked panel, or docks a floating one.',
    kind: 'pointerCommand', scope: 'panels', action: 'doubleClick', target: 'a panel tab', modifiers: ['ctrl'],
    choices: [['ctrl'], ['alt'], ['shift'], []], darwin: { modifiers: ['meta'], choices: [['meta'], ['alt'], ['shift'], []] }, keyboard: ['pane.float', 'pane.dock']
  },
  'popout.returnToMain': {
    title: 'Move Back into Main Window', description: 'Docks a popout window\'s panel back into the main window.',
    kind: 'pointerCommand', scope: 'popouts', action: 'doubleClick', target: 'a popout tab', modifiers: ['ctrl'],
    choices: [['ctrl'], ['alt'], ['shift'], []], darwin: { modifiers: ['meta'], choices: [['meta'], ['alt'], ['shift'], []] }, keyboard: ['pane.moveToMainWindow']
  },
  'resultTabs.scroll': {
    title: 'Scroll Result Tabs', description: 'Scrolls the row of result tabs sideways when the pane is too narrow to show them all, in the Tabs layout.',
    kind: 'fixed', scope: 'resultsGrid', action: 'wheel', target: 'the result tabs', modifiers: [],
    locked: 'Wheel input scrolls the result tabs sideways; Control+wheel still zooms. Arrow keys, Home and End on a focused tab also reach every tab.'
  },
  'documentTabs.scroll': {
    title: 'Scroll Tabs', description: 'Scrolls one-row shelves horizontally, or an expanded tab header vertically when its rows extend beyond the editor group.',
    kind: 'fixed', scope: 'documentTabs', action: 'wheel', target: 'a tab shelf', modifiers: [],
    locked: 'Wheel input scrolls tabs horizontally or vertically through an expanded header. Arrow keys, Home and End on a focused tab also reach every tab.'
  },
  'documentTabs.rows': {
    title: 'Change Tab Rows', description: 'Scrolling down adds rows to the pinned or unpinned shelf under the pointer, and scrolling up removes rows from that shelf alone.',
    kind: 'fixed', scope: 'documentTabs', action: 'wheel', target: 'a tab shelf', modifiers: ['ctrl'],
    locked: 'Control+wheel changes shelf rows. Increase Tab Stack Height and Decrease Tab Stack Height in the tab menu and command palette provide the same action from the keyboard.',
    keyboard: ['editor.increaseTabRows', 'editor.decreaseTabRows']
  },
  'documentTabs.rename': {
    title: 'Rename Tab', description: 'Opens the rename box on a query tab.',
    kind: 'pointerCommand', scope: 'documentTabs', action: 'doubleClick', target: 'a query tab', modifiers: [],
    locked: fixedNotYet, keyboard: ['document.rename']
  },
  'documentTabs.newQuery': {
    title: 'New Query in Group', description: 'Creates a query in the editor group whose empty tab strip is double-clicked.',
    kind: 'fixed', scope: 'documentTabs', place: 'emptyTabStrip', action: 'doubleClick', target: 'empty query tab strip space', modifiers: [], keyboard: ['file.new'],
    locked: 'Double-clicking empty tab strip space creates a query; the New Query button and command provide the keyboard path.'
  },
  'messages.revealError': {
    title: 'Go to Error Line', description: 'Reveals an SQL error\'s line in the query that produced it, while its text is unchanged.',
    kind: 'fixed', scope: 'messages', action: 'doubleClick', target: 'a query error', modifiers: [],
    locked: 'Double-clicking an error reveals its source; its Go to line button also works from the keyboard.'
  },
  'ssis.mouseBack': {
    title: 'Go Back', description: 'Goes back to the place an Integration Services document showed before: the list, a package or a run.',
    kind: 'fixed', scope: 'integrationServices', action: 'backButton', target: 'an Integration Services document', modifiers: [], keyboard: ['ssis.goBack'],
    locked: "The mouse's back button walks the document's history, as a browser's does; Go Back's keys also work."
  },
  'ssis.mouseForward': {
    title: 'Go Forward', description: 'Goes forward again to the place an Integration Services document went back from.',
    kind: 'fixed', scope: 'integrationServices', action: 'forwardButton', target: 'an Integration Services document', modifiers: [], keyboard: ['ssis.goForward'],
    locked: "The mouse's forward button walks the document's history, as a browser's does; Go Forward's keys also work."
  }
} as const satisfies Record<string, GestureDescriptor>

export type GestureId = keyof typeof gestureCatalog
export const gestureIds = Object.keys(gestureCatalog) as GestureId[]
export const isGestureId = (value: unknown): value is GestureId => typeof value === 'string' && Object.hasOwn(gestureCatalog, value)
export const gestureDescriptor = (id: GestureId): GestureDescriptor => gestureCatalog[id]
export const gestureAvailable = (id: GestureId, platform: Platform): boolean => gestureDescriptor(id).platforms?.includes(platform) ?? true

/** A gesture's modifiers on a platform until the user chooses others. */
export const gestureDefault = (id: GestureId, platform: Platform): GestureModifiers => {
  const gesture = gestureDescriptor(id)
  return platform === 'darwin' && gesture.darwin ? gesture.darwin.modifiers : gesture.modifiers
}
/** The modifier sets a gesture offers on a platform, its default first; undefined when it is locked. */
export const gestureChoices = (id: GestureId, platform: Platform): readonly GestureModifiers[] | undefined => {
  const gesture = gestureDescriptor(id)
  return platform === 'darwin' && gesture.darwin ? gesture.darwin.choices ?? gesture.choices : gesture.choices
}
/** Only a modifier behaviour can be turned off: a pointer command always keeps a gesture (and its keyboard path). */
export const gestureCanTurnOff = (id: GestureId): boolean => gestureDescriptor(id).kind === 'modifier' && !!gestureDescriptor(id).choices
/** A user's choice for a gesture: a modifier set, or null for Off. */
export type GestureChoice = GestureModifiers | null
export const sameModifiers = (a: GestureModifiers, b: GestureModifiers): boolean => a.length === b.length && a.every(modifier => b.includes(modifier))
export const sameChoice = (a: GestureChoice, b: GestureChoice): boolean => a === null || b === null ? a === b : sameModifiers(a, b)
/** What a gesture's dropdown offers on a platform: its choices, then Off where allowed; empty when it is locked. */
export function gestureOptions(id: GestureId, platform: Platform): readonly GestureChoice[] {
  const choices = gestureChoices(id, platform)
  if (!choices) return []
  return gestureCanTurnOff(id) ? [...choices, null] : choices
}

/** The modifier an event field reports, after `mod` is resolved for the platform. */
export type PhysicalModifier = 'ctrl' | 'alt' | 'shift' | 'meta'
const physicalOrder: readonly PhysicalModifier[] = ['ctrl', 'shift', 'alt', 'meta']
export function physicalModifiers(modifiers: GestureModifiers, platform: Platform): readonly PhysicalModifier[] {
  const held = new Set(modifiers.map(modifier => modifier === 'mod' ? (platform === 'darwin' ? 'meta' : 'ctrl') : modifier))
  return physicalOrder.filter(modifier => held.has(modifier))
}

const actionWords: Readonly<Record<PointerAction, string>> = { click: 'Click', doubleClick: 'Double-click', hover: 'Hover', drag: 'Drag', wheel: 'Wheel', backButton: 'Back button', forwardButton: 'Forward button' }
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
