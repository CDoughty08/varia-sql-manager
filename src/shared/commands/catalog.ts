import type { Platform } from './keybindings'
import type { MenuId } from './menus'

export type Category = 'File' | 'Edit' | 'View' | 'Query' | 'Connection' | 'Object Explorer' | 'Preferences' | 'Developer'
/** Codicon names (bundled with Monaco) that commands and pickers may show; `tests/command-catalog.test.ts` checks each exists. */
export const codicons = ['new-file', 'folder-opened', 'save', 'save-as', 'close', 'discard', 'redo', 'play', 'debug-stop', 'plug', 'debug-disconnect', 'refresh',
  'database', 'server', 'search', 'replace', 'comment', 'word-wrap', 'layout', 'list-tree', 'output', 'window', 'go-to-file', 'symbol-color', 'copy', 'clippy',
  'zoom-in', 'zoom-out', 'screen-full', 'tools', 'close-all', 'check', 'circle-filled', 'chevron-right'] as const
export type Codicon = typeof codicons[number]
/** Electron roles a command can stand for: native menus show `{ role }`, while custom menus and the palette run its handler. */
export type RoleName = 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll' | 'reload' | 'toggleDevTools' | 'resetZoom' | 'zoomIn' | 'zoomOut' | 'togglefullscreen' | 'quit'
/** The roles the renderer may ask main to run (`varia:run-role`); quitting goes through the renderer's own close flow instead. */
export const rendererRoles = ['cut', 'copy', 'paste', 'delete', 'selectAll', 'reload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen'] as const satisfies readonly RoleName[]
export type RendererRole = typeof rendererRoles[number]

/**
 * One keybinding. `key` applies to every platform unless `win`, `linux`, or `mac` overrides it (`null` leaves that
 * platform unbound). Specs follow `parseKeySpec`: `mod+shift+p`, or a two-part chord such as `mod+k mod+c`.
 */
export interface KeybindingSpec {
  readonly key?: string
  readonly win?: string | null
  readonly linux?: string | null
  readonly mac?: string | null
  /** Any context key, focus keys included. */
  readonly when?: string
  /** Monaco or Chromium dispatches the key; the catalogue uses it only for labels, menus, and conflict checks. */
  readonly native?: true
  /** Auto-repeat runs the command again; otherwise a repeated key is consumed without running it. */
  readonly allowRepeat?: true
  /** The key also works while a modal dialog is open. Only `allowInModal` commands may have such a key. */
  readonly modal?: true
}
export interface MenuPlacement {
  readonly menu: MenuId
  /** `<digit or z>_<name>`: groups sort by name and are separated in the menu. */
  readonly group: string
  readonly order: number
  /** The menu label when it differs from the palette title. */
  readonly title?: string
  readonly platforms?: readonly Platform[]
  /**
   * The access key in Windows and Linux menus: a letter or digit of the shown title, underlined at its first occurrence
   * that starts a word, else at its first occurrence. Without one, `assignMnemonics` picks a free letter.
   */
  readonly mnemonic?: string
  /**
   * Context menus only, over static, state, and target keys; menubar placements never have one, so native menus need
   * no focus state.
   */
  readonly when?: string
}
export interface CommandDescriptor {
  readonly title: string
  readonly category?: Category
  readonly icon?: Codicon
  readonly keywords?: readonly string[]
  /** Static and state context keys only. */
  readonly precondition?: string
  /** Static and state context keys only; a command with `toggled` is a checkbox in menus. */
  readonly toggled?: string
  /** Shown when someone picks the command while it is unavailable. */
  readonly unavailableHint?: string
  readonly keybindings?: readonly KeybindingSpec[]
  readonly menus?: readonly MenuPlacement[]
  readonly palette?: false
  /** The command still runs while a modal dialog is open. */
  readonly allowInModal?: true
  /** The Electron role native menus show for this command; it then has only native keybindings. */
  readonly role?: RoleName
  /** The title on one platform when no placement title applies, such as macOS's "Reveal in Finder". */
  readonly platformTitles?: Partial<Record<Platform, string>>
}

const openFirst = 'Open a query first.'
const noServer = 'No server is connected.'
const secondQuery = 'Open a second query first.'

/**
 * Every command, with its keys, menu placements, and enablement. Main builds native menus from its own compiled copy,
 * so neither structure nor strings cross IPC; the renderer registers a handler for each id.
 */
export const commandCatalog = {
  'file.new': {
    title: 'New Query', category: 'File', icon: 'new-file', precondition: '!documentBusy',
    keybindings: [{ key: 'mod+n' }], menus: [{ menu: 'file', group: '1_file', order: 1, mnemonic: 'n' }]
  },
  'file.open': {
    title: 'Open File…', category: 'File', icon: 'folder-opened', precondition: '!documentBusy',
    keybindings: [{ key: 'mod+o' }], menus: [{ menu: 'file', group: '1_file', order: 2, title: 'Open…', mnemonic: 'o' }]
  },
  'file.save': {
    title: 'Save', category: 'File', icon: 'save', precondition: 'hasActiveDocument && !documentBusy', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+s' }], menus: [{ menu: 'file', group: '1_file', order: 3, mnemonic: 's' }]
  },
  'file.saveAs': {
    title: 'Save As…', category: 'File', icon: 'save-as', precondition: 'hasActiveDocument && !documentBusy', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+shift+s' }], menus: [{ menu: 'file', group: '1_file', order: 4, mnemonic: 'a' }]
  },
  'file.close': {
    title: 'Close Query', category: 'File', icon: 'close', precondition: 'hasActiveDocument && !documentBusy', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+w' }, { win: 'ctrl+f4', linux: 'ctrl+f4' }], menus: [{ menu: 'file', group: '2_close', order: 1, mnemonic: 'c' }]
  },
  'file.closeAll': {
    title: 'Close All', category: 'File', icon: 'close-all', precondition: 'hasActiveDocument && !documentBusy', unavailableHint: openFirst,
    menus: [{ menu: 'window', group: '2_documents', order: 3, title: 'Close All Documents', mnemonic: 'l' }]
  },
  // Custom menus run the renderer's close flow; native menus show Electron's quit role. Exit and Quit pick their own mnemonic.
  'window.close': {
    title: 'Close Window', palette: false, allowInModal: true, role: 'quit', platformTitles: { win32: 'Exit', linux: 'Quit' },
    keybindings: [{ win: 'alt+f4', native: true }, { linux: 'ctrl+q', native: true }], menus: [{ menu: 'file', group: 'z_quit', order: 1, platforms: ['win32', 'linux'] }]
  },
  'edit.undo': {
    title: 'Undo', category: 'Edit', icon: 'discard', allowInModal: true,
    keybindings: [{ key: 'mod+z', native: true }], menus: [{ menu: 'edit', group: '1_undo', order: 1, mnemonic: 'u' }]
  },
  'edit.redo': {
    title: 'Redo', category: 'Edit', icon: 'redo', allowInModal: true,
    keybindings: [{ win: 'ctrl+y', linux: 'ctrl+y', mac: 'mod+shift+z', native: true }, { win: 'ctrl+shift+z', linux: 'ctrl+shift+z', native: true }],
    menus: [{ menu: 'edit', group: '1_undo', order: 2, mnemonic: 'r' }]
  },
  // Electron's roles: Chromium edits text fields and the editor's EditContext itself, so these keys are only labels here.
  'edit.cut': {
    title: 'Cut', category: 'Edit', palette: false, allowInModal: true, role: 'cut',
    keybindings: [{ key: 'mod+x', native: true }], menus: [{ menu: 'edit', group: '2_clipboard', order: 1, mnemonic: 't' }]
  },
  'edit.copy': {
    title: 'Copy', category: 'Edit', icon: 'copy', palette: false, allowInModal: true, role: 'copy',
    keybindings: [{ key: 'mod+c', native: true }], menus: [{ menu: 'edit', group: '2_clipboard', order: 2, mnemonic: 'c' }]
  },
  'edit.paste': {
    title: 'Paste', category: 'Edit', icon: 'clippy', palette: false, allowInModal: true, role: 'paste',
    keybindings: [{ key: 'mod+v', native: true }], menus: [{ menu: 'edit', group: '2_clipboard', order: 3, mnemonic: 'p' }]
  },
  'edit.delete': {
    title: 'Delete', category: 'Edit', palette: false, allowInModal: true, role: 'delete',
    keybindings: [{ key: 'delete', native: true }], menus: [{ menu: 'edit', group: '2_clipboard', order: 4, mnemonic: 'd' }]
  },
  'edit.selectAll': {
    title: 'Select All', category: 'Edit', palette: false, allowInModal: true, role: 'selectAll',
    keybindings: [{ key: 'mod+a', native: true }], menus: [{ menu: 'edit', group: '2_clipboard', order: 5, mnemonic: 'a' }]
  },
  'window.explorer': {
    title: 'Show Object Explorer', category: 'View', icon: 'list-tree', keywords: ['servers', 'tree'], keybindings: [{ key: 'f8' }],
    menus: [{ menu: 'window', group: '1_panes', order: 1, title: 'Object Explorer', mnemonic: 'o' }]
  },
  'window.editor': {
    title: 'Show Query Editor', category: 'View', icon: 'window',
    menus: [{ menu: 'window', group: '1_panes', order: 2, title: 'Query Editor', mnemonic: 'e' }]
  },
  'window.output': {
    title: 'Show Query Output', category: 'View', icon: 'output', keywords: ['results', 'messages'],
    menus: [{ menu: 'window', group: '1_panes', order: 3, title: 'Query Output', mnemonic: 'u' }]
  },
  // SSMS's Ctrl+R: hides the results (closing the panel keeps them) or shows them again. It never reloads the window.
  'view.toggleResultsPane': {
    title: 'Toggle Results Pane', category: 'View', icon: 'output', keywords: ['results', 'output', 'hide', 'show'], toggled: 'outputPaneVisible',
    keybindings: [{ key: 'mod+r' }], menus: [{ menu: 'window', group: '1_panes', order: 4, title: 'Show Results Pane', mnemonic: 'h' }]
  },
  'layout.save': {
    title: 'Save Layout…', category: 'View', icon: 'layout',
    menus: [{ menu: 'view', group: '1_layout', order: 1, mnemonic: 's' }, { menu: 'window', group: '3_layout', order: 1, title: 'Save Window Layout…', mnemonic: 's' }]
  },
  'layout.load': {
    title: 'Load Layout…', category: 'View', icon: 'layout',
    menus: [{ menu: 'view', group: '1_layout', order: 2, mnemonic: 'l' }, { menu: 'window', group: '3_layout', order: 2, title: 'Load Window Layout…', mnemonic: 'a' }]
  },
  'layout.reset': {
    title: 'Reset Layout', category: 'View', icon: 'layout',
    menus: [{ menu: 'view', group: '1_layout', order: 3, mnemonic: 'r' }, { menu: 'window', group: '3_layout', order: 3, title: 'Reset Window Layout', mnemonic: 'r' }]
  },
  'query.execute': {
    title: 'Execute', category: 'Query', icon: 'play', keywords: ['run', 'go'],
    precondition: 'activeDocumentConnected && !queryRunning && !documentBusy',
    unavailableHint: 'Connect this query to a server and wait for its running query to finish.',
    keybindings: [{ key: 'f5', when: 'editorFocus' }, { key: 'mod+enter', when: 'editorFocus' }, { win: 'ctrl+e', linux: 'ctrl+e', when: 'editorFocus' }],
    menus: [{ menu: 'query', group: '1_execute', order: 1, mnemonic: 'x' }]
  },
  'query.cancel': {
    title: 'Cancel Executing Query', category: 'Query', icon: 'debug-stop', precondition: 'queryRunning', unavailableHint: 'No query is running in this tab.',
    keybindings: [{ win: 'alt+pause', linux: 'alt+pause' }], menus: [{ menu: 'query', group: '1_execute', order: 2, mnemonic: 'c' }]
  },
  'workbench.showCommands': {
    title: 'Show All Commands', palette: false,
    keybindings: [{ key: 'mod+shift+p' }, { key: 'f1' }], menus: [{ menu: 'view', group: '0_palette', order: 1, title: 'Command Palette…', mnemonic: 'c' }]
  },
  'workbench.quickOpen': {
    title: 'Go to Query…', icon: 'go-to-file', precondition: 'hasActiveDocument', unavailableHint: 'No queries are open.',
    keybindings: [{ key: 'mod+p' }], menus: [{ menu: 'view', group: '0_palette', order: 2, mnemonic: 'g' }]
  },
  'connection.connect': {
    title: 'Connect to Server…', category: 'Connection', icon: 'plug', keywords: ['login', 'server'], precondition: 'backendReady',
    unavailableHint: 'The backend is still starting.',
    menus: [{ menu: 'file', group: '0_connect', order: 1, mnemonic: 'e' }, { menu: 'query.connection', group: '1_connect', order: 1, title: 'Connect…', mnemonic: 'c' }]
  },
  'connection.disconnect': {
    title: 'Disconnect from Server…', category: 'Connection', icon: 'debug-disconnect', precondition: 'hasConnection && !documentBusy', unavailableHint: noServer,
    menus: [{ menu: 'file', group: '0_connect', order: 2, mnemonic: 'd' }]
  },
  'explorer.refresh': {
    title: 'Refresh', category: 'Object Explorer', icon: 'refresh', precondition: 'hasConnection', unavailableHint: noServer,
    keybindings: [{ key: 'f5', when: "activePanel == 'explorer' && !inputFocus" }]
  },
  'query.changeConnection': {
    title: 'Change Connection…', category: 'Query', icon: 'server', precondition: 'hasActiveDocument && !queryRunning && !documentBusy',
    menus: [{ menu: 'query.connection', group: '2_change', order: 1, mnemonic: 'h' }]
  },
  'query.disconnect': {
    title: 'Disconnect', category: 'Query', icon: 'debug-disconnect', precondition: 'activeDocumentConnected && !queryRunning && !documentBusy',
    unavailableHint: 'This query is not connected.', menus: [{ menu: 'query.connection', group: '1_connect', order: 2, mnemonic: 'd' }]
  },
  'query.disconnectAll': {
    title: 'Disconnect All Queries', category: 'Query', precondition: 'anyDocumentConnected && !documentBusy', unavailableHint: 'No query is connected.',
    menus: [{ menu: 'query.connection', group: '1_connect', order: 3, mnemonic: 'a' }]
  },
  'query.changeDatabase': {
    title: 'Change Database…', category: 'Query', icon: 'database', keywords: ['use', 'catalog'],
    precondition: 'activeDocumentConnected && !queryRunning && !documentBusy', unavailableHint: 'Connect this query to a server first.',
    // SSMS's Change Database key; Ctrl/⌘+K Ctrl/⌘+U in editor text still reaches Monaco (the dispatcher passes the chord through).
    keybindings: [{ key: 'mod+u' }], menus: [{ menu: 'query', group: '0_connection', order: 2, mnemonic: 'd' }]
  },
  'document.next': {
    title: 'Next Query', category: 'View', precondition: 'multipleDocuments', unavailableHint: secondQuery,
    keybindings: [{ key: 'ctrl+tab', allowRepeat: true }, { win: 'ctrl+pagedown', linux: 'ctrl+pagedown', allowRepeat: true }],
    menus: [{ menu: 'window', group: '2_documents', order: 1, mnemonic: 'n' }]
  },
  'document.previous': {
    title: 'Previous Query', category: 'View', precondition: 'multipleDocuments', unavailableHint: secondQuery,
    keybindings: [{ key: 'ctrl+shift+tab', allowRepeat: true }, { win: 'ctrl+pageup', linux: 'ctrl+pageup', allowRepeat: true }],
    menus: [{ menu: 'window', group: '2_documents', order: 2, mnemonic: 'p' }]
  },
  'editor.toggleWordWrap': {
    title: 'Toggle Word Wrap', category: 'View', icon: 'word-wrap', toggled: 'editorWordWrap',
    // ⌥Z types Ω on macOS.
    keybindings: [{ win: 'alt+z', linux: 'alt+z' }], menus: [{ menu: 'view', group: '2_editor', order: 1, title: 'Word Wrap', mnemonic: 'w' }]
  },
  'edit.find': {
    title: 'Find', category: 'Edit', icon: 'search', precondition: 'hasActiveDocument', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+f', native: true }], menus: [{ menu: 'edit', group: '3_find', order: 1, mnemonic: 'f' }]
  },
  'edit.replace': {
    title: 'Replace', category: 'Edit', icon: 'replace', precondition: 'hasActiveDocument', unavailableHint: openFirst,
    keybindings: [{ win: 'ctrl+h', linux: 'ctrl+h', mac: 'alt+mod+f', native: true }], menus: [{ menu: 'edit', group: '3_find', order: 2, mnemonic: 'e' }]
  },
  'edit.toggleLineComment': {
    title: 'Toggle Line Comment', category: 'Edit', icon: 'comment', precondition: 'hasActiveDocument', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+/', native: true }], menus: [{ menu: 'edit', group: '4_comment', order: 1, mnemonic: 'l' }]
  },
  'edit.commentLines': {
    title: 'Comment Selection', category: 'Edit', precondition: 'hasActiveDocument', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+k mod+c', native: true }], menus: [{ menu: 'edit', group: '4_comment', order: 2, mnemonic: 'm' }]
  },
  'edit.uncommentLines': {
    title: 'Uncomment Selection', category: 'Edit', precondition: 'hasActiveDocument', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+k mod+u', native: true }], menus: [{ menu: 'edit', group: '4_comment', order: 3, mnemonic: 'n' }]
  },
  // Not theme.*: PR1's theme menu items (theme.mode.*, theme.create, …) come from themeMenuModel and keep those ids.
  'preferences.colorTheme': {
    title: 'Color Theme…', category: 'Preferences', icon: 'symbol-color', keywords: ['dark', 'light', 'appearance'],
    menus: [{ menu: 'theme', group: '0_pick', order: 1, mnemonic: 'c' }]
  },
  'preferences.createTheme': { title: 'Create Custom Theme…', category: 'Preferences', icon: 'new-file', keywords: ['color'] },
  'preferences.openThemesFolder': { title: 'Open Themes Folder', category: 'Preferences', icon: 'folder-opened', keywords: ['color'] },
  'preferences.reloadThemes': { title: 'Reload Themes', category: 'Preferences', icon: 'refresh', keywords: ['color'] },
  // View › Theme's theme and mode items in custom menus: the choice travels as the item's arguments.
  'preferences.setTheme': { title: 'Set Color Theme', category: 'Preferences', palette: false },
  'view.zoomIn': {
    title: 'Zoom In', category: 'View', icon: 'zoom-in', role: 'zoomIn', keybindings: [{ key: 'mod+=', native: true }], menus: [{ menu: 'view', group: '4_zoom', order: 1, mnemonic: 'i' }]
  },
  'view.zoomOut': {
    title: 'Zoom Out', category: 'View', icon: 'zoom-out', role: 'zoomOut', keybindings: [{ key: 'mod+-', native: true }], menus: [{ menu: 'view', group: '4_zoom', order: 2, mnemonic: 'o' }]
  },
  'view.resetZoom': {
    title: 'Reset Zoom', category: 'View', role: 'resetZoom', keybindings: [{ key: 'mod+0', native: true }], menus: [{ menu: 'view', group: '4_zoom', order: 3, mnemonic: 'z' }]
  },
  'view.toggleFullScreen': {
    title: 'Toggle Full Screen', category: 'View', icon: 'screen-full', role: 'togglefullscreen', keybindings: [{ win: 'f11', linux: 'f11', mac: 'ctrl+meta+f', native: true }],
    menus: [{ menu: 'view', group: '4_zoom', order: 4, title: 'Full Screen', mnemonic: 'f' }]
  },
  // No key: Ctrl+R and ⌘R toggle the results pane, as in SSMS.
  'developer.reloadWindow': { title: 'Reload Window', category: 'Developer', role: 'reload', menus: [{ menu: 'view', group: 'z_developer', order: 1, mnemonic: 'e' }] },
  'developer.toggleDevTools': {
    title: 'Toggle Developer Tools', category: 'Developer', icon: 'tools', role: 'toggleDevTools', keybindings: [{ win: 'ctrl+shift+i', linux: 'ctrl+shift+i', mac: 'alt+meta+i', native: true }],
    menus: [{ menu: 'view', group: 'z_developer', order: 2, mnemonic: 'd' }]
  }
} as const satisfies Record<string, CommandDescriptor>

export type CommandId = keyof typeof commandCatalog
export const commandIds = Object.keys(commandCatalog) as CommandId[]
export const isCommandId = (value: unknown): value is CommandId => typeof value === 'string' && Object.hasOwn(commandCatalog, value)
/** Widens a catalogue entry so optional fields can be read without narrowing on the literal type. */
export const commandDescriptor = (id: CommandId): CommandDescriptor => commandCatalog[id]
export const paletteLabel = (id: CommandId): string => { const command = commandDescriptor(id); return command.category ? `${command.category}: ${command.title}` : command.title }
