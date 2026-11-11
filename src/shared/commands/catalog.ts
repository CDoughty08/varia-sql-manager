import type { Platform } from './keybindings'
import type { MenuId } from './menus'
import type { SettingKey } from '../settings/catalog'
import { actionCommandEntries, newDatabaseCommandEntries, propertiesCommandEntries, restoreCommandEntries, serverActionCommandEntries } from '../actions/catalog.ts'
import { designerCommandEntries } from '../designer/catalog.ts'
import { scriptCommandEntries, scriptUnavailableHint } from '../scripting/catalog.ts'
import { operationsCommandEntries } from '../ssis/operations.ts'
import type { IconId } from '../icons.ts'
import { ssisCommandEntries } from '../ssis/catalog.ts'

export type Category = 'File' | 'Edit' | 'View' | 'Query' | 'Connection' | 'Object Explorer' | 'Table Designer' | 'Database Properties' | 'New Database' | 'Restore Database' | 'Integration Services' | 'Tools' | 'Activity Monitor' | 'Preferences' | 'Developer' | 'Help'
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
  /**
   * Varia registers this two-part chord with Monaco (`registerEditorBridge`), which dispatches it in editor text, chord
   * mode included. It requires `native`, a `mod+k` first part, and no `when`.
   */
  readonly bridge?: true
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
  readonly icon?: IconId
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
  /** The title follows an integer setting: `{n}` in `template` is its value (`commandTitle`); `title` is the default's. */
  readonly titleSetting?: { readonly setting: SettingKey; readonly template: string }
}

const openFirst = 'Open a query first.'
const tabKeys = 'documentTabFocus && !inputFocus'
const noServer = 'No server is connected.'
const secondQuery = 'Open a second query first.'
const noFile = 'Save this query to a file first.'
const noBookmarks = 'No bookmarks are set.'
const noDocumentBookmarks = 'This query has no bookmarks.'
const openMonitor = 'Open the Activity Monitor first (Tools: Activity Monitor).'

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
    // In a results grid, Ctrl+S saves its results (SSMS).
    keybindings: [{ key: 'mod+s', when: '!outputGridFocus' }], menus: [{ menu: 'file', group: '1_file', order: 3, mnemonic: 's' }, { menu: 'documentTab.context', group: '1_save', order: 1, mnemonic: 's' }]
  },
  // SSMS's Save As has no key on Windows: Ctrl+Shift+S is Save All there. macOS keeps ⇧⌘S, its Save As key.
  'file.saveAs': {
    title: 'Save As…', category: 'File', icon: 'save-as', precondition: 'activeDocumentIsText && !documentBusy', unavailableHint: openFirst,
    keybindings: [{ mac: 'mod+shift+s' }],
    menus: [{ menu: 'file', group: '1_file', order: 4, mnemonic: 'a' }, { menu: 'documentTab.context', group: '1_save', order: 2, mnemonic: 'a' }]
  },
  // The queries with unsaved changes, in tab order; a query never saved asks for its file. ⌥⌘S on macOS, where ⇧⌘S is Save As.
  'file.saveAll': {
    title: 'Save All', category: 'File', icon: 'save-all', precondition: 'anyDocumentDirty && !documentBusy', unavailableHint: 'No query has unsaved changes.',
    keybindings: [{ win: 'ctrl+shift+s', linux: 'ctrl+shift+s', mac: 'alt+mod+s' }], menus: [{ menu: 'file', group: '1_file', order: 5, mnemonic: 'l' }]
  },
  // File › Recent Files' items run this with their entry (`recentFile`); without one, it picks from the list.
  'file.openRecent': {
    title: 'Open Recent File…', category: 'File', icon: 'history', keywords: ['recent', 'mru'], precondition: 'hasRecentFiles && !documentBusy',
    unavailableHint: 'No files were opened recently.'
  },
  'file.clearRecent': { title: 'Clear Recent Files', category: 'File', keywords: ['recent', 'mru'], precondition: 'hasRecentFiles', unavailableHint: 'No files were opened recently.' },
  // The Recover dialog again, for queries AutoRecover kept that were neither recovered nor discarded when it first showed.
  'file.recoverUnsaved': {
    title: 'Recover Unsaved Queries…', category: 'File', icon: 'history', keywords: ['autorecover', 'recover', 'recovery', 'crash', 'unsaved'], precondition: 'hasRecoveryFiles',
    unavailableHint: 'AutoRecover has nothing to recover.'
  },
  // Main runs it as Windows ends the session (shut down, restart, log off): a copy of every unsaved query before the process can be ended.
  'file.autoRecoverNow': {
    title: 'Save AutoRecover Copies Now', category: 'File', palette: false, allowInModal: true
  },
  'file.close': {
    title: 'Close Query', category: 'File', icon: 'close', precondition: 'hasActiveDocument && !documentBusy', unavailableHint: openFirst,
    // Delete and Backspace on a focused tab, as Dockview's tabs close; a key pressed on a tab closes that tab.
    keybindings: [{ key: 'mod+w' }, { win: 'ctrl+f4', linux: 'ctrl+f4' }, { key: 'delete', when: tabKeys }, { key: 'backspace', when: tabKeys }],
    menus: [{ menu: 'file', group: '2_close', order: 1, mnemonic: 'c' }, { menu: 'documentTab.context', group: '2_close', order: 1, title: 'Close', mnemonic: 'c' }]
  },
  // The query tab menu's commands act on the tab it was opened for (`tabId`), otherwise on the active query.
  'file.closeOthers': {
    title: 'Close All But This', category: 'File', precondition: 'multipleDocuments && !documentBusy', unavailableHint: secondQuery,
    menus: [{ menu: 'documentTab.context', group: '2_close', order: 2, mnemonic: 'b' }]
  },
  'file.closeAll': {
    title: 'Close All', category: 'File', icon: 'close-all', precondition: 'hasActiveDocument && !documentBusy', unavailableHint: openFirst,
    menus: [{ menu: 'window', group: '2_documents', order: 3, title: 'Close All Documents', mnemonic: 'l' }, { menu: 'documentTab.context', group: '2_close', order: 3, mnemonic: 'l' }]
  },
  'file.reopenClosed': {
    title: 'Reopen Closed Query', category: 'File', icon: 'history', keywords: ['restore', 'closed', 'undo'], precondition: '!documentBusy',
    unavailableHint: 'There are no closed queries to reopen.', keybindings: [{ key: 'mod+shift+t' }],
    menus: [{ menu: 'documentTab.context', group: '2_close', order: 4, mnemonic: 'q' }, { menu: 'file', group: '2_close', order: 2, mnemonic: 'p' }]
  },
  // Disabled, with the hint, for a query that has never been saved.
  'file.copyPath': {
    title: 'Copy Full Path', category: 'File', precondition: 'hasActiveDocument', unavailableHint: noFile,
    menus: [{ menu: 'documentTab.context', group: '3_file', order: 1, mnemonic: 'p' }]
  },
  'file.revealInFolder': {
    title: 'Open Containing Folder', category: 'File', icon: 'folder-opened', precondition: 'hasActiveDocument', unavailableHint: noFile, platformTitles: { darwin: 'Reveal in Finder' },
    menus: [{ menu: 'documentTab.context', group: '3_file', order: 2, mnemonic: 'o' }]
  },
  // Custom menus run the renderer's close flow; native menus show Electron's quit role. Exit and Quit pick their own mnemonic.
  'window.close': {
    title: 'Close Window', palette: false, allowInModal: true, role: 'quit', platformTitles: { win32: 'Exit', linux: 'Quit' },
    keybindings: [{ win: 'alt+f4', native: true }, { linux: 'ctrl+q', native: true }], menus: [{ menu: 'file', group: 'z_quit', order: 1, platforms: ['win32', 'linux'] }]
  },
  'edit.undo': {
    title: 'Undo', category: 'Edit', icon: 'discard', allowInModal: true,
    keybindings: [{ key: 'mod+z', native: true }], menus: [{ menu: 'edit', group: '1_undo', order: 1, mnemonic: 'u' }, { menu: 'input.context', group: '1_undo', order: 1, mnemonic: 'u' }]
  },
  'edit.redo': {
    title: 'Redo', category: 'Edit', icon: 'redo', allowInModal: true,
    keybindings: [{ win: 'ctrl+y', linux: 'ctrl+y', mac: 'mod+shift+z', native: true }, { win: 'ctrl+shift+z', linux: 'ctrl+shift+z', native: true }],
    menus: [{ menu: 'edit', group: '1_undo', order: 2, mnemonic: 'r' }, { menu: 'input.context', group: '1_undo', order: 2, mnemonic: 'r' }]
  },
  // Electron's roles: Chromium edits text fields and the editor's EditContext itself, so these keys are only labels here.
  'edit.cut': {
    title: 'Cut', category: 'Edit', palette: false, allowInModal: true, role: 'cut',
    keybindings: [{ key: 'mod+x', native: true }],
    menus: [{ menu: 'edit', group: '2_clipboard', order: 1, mnemonic: 't' }, { menu: 'editor.context', group: '3_clipboard', order: 1, mnemonic: 't' }, { menu: 'input.context', group: '2_clipboard', order: 1, mnemonic: 't' }]
  },
  'edit.copy': {
    title: 'Copy', category: 'Edit', icon: 'copy', palette: false, allowInModal: true, role: 'copy',
    keybindings: [{ key: 'mod+c', native: true }],
    menus: [{ menu: 'edit', group: '2_clipboard', order: 2, mnemonic: 'c' }, { menu: 'editor.context', group: '3_clipboard', order: 2, mnemonic: 'c' }, { menu: 'input.context', group: '2_clipboard', order: 2, mnemonic: 'c' }]
  },
  'edit.paste': {
    title: 'Paste', category: 'Edit', icon: 'clippy', palette: false, allowInModal: true, role: 'paste',
    keybindings: [{ key: 'mod+v', native: true }],
    menus: [{ menu: 'edit', group: '2_clipboard', order: 3, mnemonic: 'p' }, { menu: 'editor.context', group: '3_clipboard', order: 3, mnemonic: 'p' }, { menu: 'input.context', group: '2_clipboard', order: 3, mnemonic: 'p' }]
  },
  'edit.delete': {
    title: 'Delete', category: 'Edit', palette: false, allowInModal: true, role: 'delete',
    keybindings: [{ key: 'delete', native: true }], menus: [{ menu: 'edit', group: '2_clipboard', order: 4, mnemonic: 'd' }, { menu: 'input.context', group: '2_clipboard', order: 4, mnemonic: 'd' }]
  },
  'edit.selectAll': {
    title: 'Select All', category: 'Edit', palette: false, allowInModal: true, role: 'selectAll',
    keybindings: [{ key: 'mod+a', native: true }], menus: [{ menu: 'edit', group: '2_clipboard', order: 5, mnemonic: 'a' }, { menu: 'input.context', group: '3_select', order: 1, mnemonic: 'a' }]
  },
  'window.explorer': {
    title: 'Show Object Explorer', category: 'View', icon: 'list-tree', keywords: ['servers', 'tree'], keybindings: [{ key: 'f8' }],
    menus: [{ menu: 'window', group: '1_panes', order: 1, title: 'Object Explorer', mnemonic: 'o' }]
  },
  'window.editor': {
    title: 'Show Query Editor', category: 'View', icon: 'window',
    menus: [{ menu: 'window', group: '1_panes', order: 2, title: 'Query Editor', mnemonic: 'e' }]
  },
  'window.results': {
    title: 'Show Results', category: 'View', icon: 'table', keywords: ['output', 'grid'],
    menus: [{ menu: 'window', group: '1_panes', order: 3, title: 'Results', mnemonic: 'u' }]
  },
  'window.messages': {
    title: 'Show Messages', category: 'View', icon: 'output', keywords: ['output', 'errors', 'print'],
    menus: [{ menu: 'window', group: '1_panes', order: 4, title: 'Messages', mnemonic: 'm' }]
  },
  'window.plan': {
    title: 'Show Execution Plan', category: 'View', icon: 'execution-plan', keywords: ['output', 'showplan', 'plan'],
    menus: [{ menu: 'window', group: '1_panes', order: 5, title: 'Execution Plan', mnemonic: 'x' }]
  },
  'window.statistics': {
    title: 'Show Client Statistics', category: 'View', icon: 'graph', keywords: ['output', 'bytes', 'timing'],
    menus: [{ menu: 'window', group: '1_panes', order: 8, title: 'Client Statistics', mnemonic: 'c' }]
  },
  // SSMS's Ctrl+R: hides the output panels (closing them keeps the results) or shows them again. It never reloads the window.
  'view.toggleResultsPane': {
    title: 'Toggle Results Pane', category: 'View', icon: 'output', keywords: ['results', 'messages', 'output', 'hide', 'show'], toggled: 'outputPaneVisible',
    keybindings: [{ key: 'mod+r' }], menus: [{ menu: 'window', group: '1_panes', order: 6, title: 'Show Results Pane', mnemonic: 'h' }]
  },
  // SSMS's F6: between the query editor and its results (the grid that last had focus, else the first, else Messages).
  'window.switchPane': {
    title: 'Switch Between Query and Results', category: 'View', icon: 'output', keywords: ['results', 'editor', 'focus'], precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ key: 'f6', when: '!activityMonitorFocus' }, { key: 'shift+f6', when: '!activityMonitorFocus' }]
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
    // A disconnected query connects first (the Connect dialog), as in SSMS; a lost connection needs Reconnect.
    precondition: 'activeDocumentIsQuery && !queryRunning && !documentBusy && (activeDocumentConnected || (backendReady && !activeConnectionLost))',
    unavailableHint: 'Open a query, wait for its running query to finish, and reconnect a lost connection.',
    // The query's bar shows F5 on Execute, so its keys work there too, as in SSMS's SQL Editor toolbar.
    keybindings: [{ key: 'f5', when: 'editorFocus || queryBarFocus' }, { key: 'mod+enter', when: 'editorFocus || queryBarFocus' }, { win: 'ctrl+e', linux: 'ctrl+e', when: 'editorFocus || queryBarFocus' }],
    menus: [{ menu: 'query', group: '1_execute', order: 1, mnemonic: 'x' }, { menu: 'editor.context', group: '2_execute', order: 1, mnemonic: 'x' }]
  },
  'query.cancel': {
    title: 'Cancel Executing Query', category: 'Query', icon: 'debug-stop', precondition: 'queryRunning', unavailableHint: 'No query is running in this tab.',
    keybindings: [{ win: 'alt+pause', linux: 'alt+pause' }],
    menus: [{ menu: 'query', group: '1_execute', order: 2, mnemonic: 'c' }, { menu: 'editor.context', group: '2_execute', order: 2, mnemonic: 'n' }]
  },
  'query.includeActualPlan': {
    title: 'Include Actual Execution Plan', category: 'Query', icon: 'execution-plan', keywords: ['statistics', 'xml', 'showplan', 'capture'],
    precondition: 'activeDocumentIsQuery && !queryRunning && !documentBusy', toggled: 'includeActualPlan',
    keybindings: [{ win: 'ctrl+m', linux: 'ctrl+m', when: 'editorFocus || queryBarFocus' }],
    menus: [{ menu: 'query', group: '1_execute', order: 3, mnemonic: 'i' }]
  },
  'query.includeLivePlan': {
    title: 'Include Live Execution Plan', category: 'Query', icon: 'execution-plan', keywords: ['profiling', 'statistics', 'progress'],
    precondition: 'activeDocumentIsQuery && !queryRunning && !documentBusy', toggled: 'includeLivePlan',
    menus: [{ menu: 'query', group: '1_execute', order: 4, mnemonic: 'l' }]
  },
  'query.estimatePlan': {
    title: 'Display Estimated Execution Plan', category: 'Query', icon: 'execution-plan', keywords: ['compile', 'xml', 'showplan'],
    precondition: 'activeDocumentIsQuery && activeDocumentConnected && !queryRunning && !documentBusy',
    unavailableHint: 'Connect an idle query to a server to estimate its execution plan.',
    keybindings: [{ key: 'mod+l', when: 'editorFocus || queryBarFocus' }],
    menus: [{ menu: 'query', group: '1_execute', order: 5, mnemonic: 'e' }, { menu: 'editor.context', group: '2_execute', order: 3, mnemonic: 'd' }]
  },
  'query.estimateSessionPlan': {
    title: 'Display Estimated Plan in Query Session', category: 'Query', icon: 'execution-plan', keywords: ['compile', 'showplan', 'temporary', 'session'],
    precondition: 'activeDocumentIsQuery && activeDocumentConnected && !queryRunning && !documentBusy',
    unavailableHint: 'Connect an idle query to estimate using its SQL session. Capture resets @@ROWCOUNT and @@ERROR.',
    menus: [{ menu: 'query', group: '1_execute', order: 6 }, { menu: 'editor.context', group: '2_execute', order: 4 }]
  },
  'query.includeClientStatistics': {
    title: 'Include Client Statistics', category: 'Query', icon: 'graph', keywords: ['bytes', 'roundtrips', 'timing'],
    precondition: 'activeDocumentIsQuery && !queryRunning && !documentBusy', toggled: 'includeClientStatistics',
    keybindings: [{ win: 'alt+shift+s', linux: 'alt+shift+s', when: 'editorFocus || queryBarFocus' }],
    menus: [{ menu: 'query', group: '1_execute', order: 7, mnemonic: 's' }]
  },
  'query.resetClientStatistics': {
    title: 'Reset Client Statistics', category: 'Query', icon: 'clear-all', precondition: 'activeDocumentIsQuery && !queryRunning && !documentBusy',
    menus: [{ menu: 'query', group: '1_execute', order: 8, mnemonic: 'r' }]
  },
  'workbench.showCommands': {
    title: 'Show All Commands', palette: false,
    keybindings: [{ key: 'mod+shift+p' }, { key: 'f1' }],
    menus: [{ menu: 'view', group: '0_palette', order: 1, title: 'Command Palette…', mnemonic: 'c' }, { menu: 'editor.context', group: '9_palette', order: 1, title: 'Command Palette…', mnemonic: 'a' }]
  },
  // Shift+F10 and the context-menu key open the focused element's context menu, in dialogs too (text fields).
  'workbench.showContextMenu': {
    title: 'Show Context Menu', palette: false, allowInModal: true, precondition: '!quickInputVisible',
    keybindings: [{ key: 'shift+f10', modal: true }, { win: 'contextmenu', linux: 'contextmenu', modal: true }]
  },
  'workbench.quickOpen': {
    title: 'Go to Query…', icon: 'go-to-file', precondition: 'hasActiveDocument', unavailableHint: 'No queries are open.',
    keybindings: [{ key: 'mod+p' }], menus: [{ menu: 'view', group: '0_palette', order: 2, mnemonic: 'g' }]
  },
  'connection.connect': {
    title: 'Connect to Server…', category: 'Connection', icon: 'plug', keywords: ['login', 'server'], precondition: 'backendReady',
    unavailableHint: 'The backend is still starting.',
    menus: [
      { menu: 'file', group: '0_connect', order: 1, mnemonic: 'e' }, { menu: 'query.connection', group: '1_connect', order: 1, title: 'Connect…', mnemonic: 'c' },
      { menu: 'explorer.context', group: '0_connect', order: 1, title: 'Connect…', mnemonic: 'c', when: "explorerNode == 'server' || explorerNode == 'background'" }
    ]
  },
  'connection.disconnect': {
    title: 'Disconnect from Server…', category: 'Connection', icon: 'debug-disconnect', precondition: 'hasConnection && !documentBusy', unavailableHint: noServer,
    // A server node's menu (and Object Explorer's toolbar, for the selected node's server) disconnects that server without asking which.
    menus: [
      { menu: 'file', group: '0_connect', order: 2, mnemonic: 'd' },
      { menu: 'explorer.context', group: '0_connect', order: 2, title: 'Disconnect', mnemonic: 'd', when: "explorerNode == 'server' && !explorerServerLost" }
    ]
  },
  // Not in SSMS: labels a connected server Production, Staging, Test, Development or a custom label, saved with its entry.
  // A server node's menu labels that server; elsewhere, the active query's server or one the user picks.
  'connection.environment': {
    title: 'Set Connection Environment…', category: 'Connection', icon: 'tag', keywords: ['environment', 'production', 'prod', 'staging', 'test', 'development', 'label', 'tag'],
    precondition: 'hasConnection && !documentBusy', unavailableHint: noServer,
    menus: [
      { menu: 'query.connection', group: '2_change', order: 2, title: 'Environment…' },
      { menu: 'explorer.context', group: '0_connect', order: 5, title: 'Environment…', when: "explorerNode == 'server' && !explorerServerLost" }
    ]
  },
  // A lost server's menu reconnects that server; elsewhere, the active query's lost connection or one the user picks.
  'connection.reconnect': {
    title: 'Reconnect…', category: 'Connection', icon: 'plug', keywords: ['lost', 'restart'], precondition: 'hasLostConnection && backendReady',
    unavailableHint: 'No connection was lost.',
    menus: [
      { menu: 'file', group: '0_connect', order: 3, mnemonic: 'r' }, { menu: 'query.connection', group: '1_connect', order: 4, mnemonic: 'r' },
      { menu: 'explorer.context', group: '0_connect', order: 3, mnemonic: 'r', when: 'explorerServerLost' }
    ]
  },
  // Takes a lost connection out of Object Explorer; its queries become disconnected. Its access key leaves M to Rename,
  // which SSMS underlines there.
  'connection.removeLost': {
    title: 'Remove Lost Connection…', category: 'Connection', icon: 'close', keywords: ['lost', 'restart'], precondition: 'hasLostConnection && !documentBusy',
    unavailableHint: 'No connection was lost.', menus: [{ menu: 'explorer.context', group: '0_connect', order: 4, title: 'Remove', mnemonic: 'o', when: 'explorerServerLost' }]
  },
  // Always available: it is also the way out of an unresponsive or failed backend.
  'backend.restart': { title: 'Restart SQL Backend…', category: 'Connection', icon: 'debug-restart', keywords: ['backend', 'restart', 'sidecar'] },
  // Object Explorer's commands act on the node a context menu was opened for, otherwise on the selected node (F5, the
  // toolbar, the palette). Refresh reloads the node (a leaf's parent); without a selection, or from the empty area, every server.
  'explorer.refresh': {
    title: 'Refresh', category: 'Object Explorer', icon: 'refresh', precondition: 'hasConnection', unavailableHint: noServer,
    keybindings: [{ key: 'f5', when: "activePanel == 'explorer' && !inputFocus" }],
    menus: [{ menu: 'explorer.context', group: '8_refresh', order: 1, mnemonic: 'f', when: '!explorerServerLost' }]
  },
  // SSMS's Filter Settings for folders that list objects (Tables, Views, Databases, Logins…); the capped row's Enter opens it too.
  'explorer.filter': {
    title: 'Filter Settings…', category: 'Object Explorer', icon: 'filter', keywords: ['filter', 'narrow', 'search'], precondition: 'hasConnection', unavailableHint: 'Select a folder that can be filtered.',
    menus: [{ menu: 'explorer.context', group: '3_filter', order: 1, mnemonic: 'i', when: 'explorerFolderFilterable' }]
  },
  // Focuses Object Explorer's search box, which searches the selected server's object index as Search Objects does, and
  // selects its text, so typing replaces it and End keeps it. Ctrl+Shift+F is SSMS's Find in Files, which Varia lacks.
  'explorer.focusSearch': {
    title: 'Search in Object Explorer', category: 'Object Explorer', icon: 'search', keywords: ['find', 'search', 'filter', 'quick', 'objects'], precondition: 'hasConnection', unavailableHint: noServer,
    keybindings: [{ key: 'mod+shift+f' }]
  },
  'explorer.removeFilter': {
    title: 'Remove Filter', category: 'Object Explorer', icon: 'clear-all', keywords: ['filter', 'clear'], precondition: 'hasConnection', unavailableHint: 'This folder has no filter.',
    // 'l', not 'v': the menu's mnemonics are checked across every placement at once, and Activity Monitor's 't' leaves
    // Environment… only its 'v' (tests/command-catalog.test.ts).
    menus: [{ menu: 'explorer.context', group: '3_filter', order: 2, mnemonic: 'l', when: 'explorerFolderFiltered' }]
  },
  // SSMS: right-click Integration Services Catalogs › Create Catalog… (S9a). The dialog says why a server cannot have one.
  'explorer.createCatalog': {
    title: 'Create Catalog…', category: 'Object Explorer', icon: 'database', keywords: ['ssis', 'ssisdb', 'integration', 'catalog', 'create'],
    precondition: "backendReady && explorerSelectionFolder == 'integrationServicesCatalogs'", unavailableHint: 'Select Integration Services Catalogs in Object Explorer.',
    menus: [{ menu: 'explorer.context', group: '0_new', order: 2, mnemonic: 't', when: "explorerNode == 'folder' && explorerFolder == 'integrationServicesCatalogs' && !explorerServerLost" }]
  },
  // SSMS: Security › New › Login…, and New Login… on the Logins folder and on a login (learn.microsoft.com: Create a login).
  // SQL Server and Managed Instance (D2e); the dialog says when the server lacks permission or SQL Server authentication.
  'explorer.newLogin': {
    title: 'New Login…', category: 'Object Explorer', icon: 'login', keywords: ['login', 'security', 'user', 'principal', 'create', 'password'],
    precondition: "backendReady && (explorerSelectionFolder == 'logins' || explorerSelectionFolder == 'serverSecurity' || explorerSelectionKind == 'login') && (explorerSelectionServerEngine == 'box' || explorerSelectionServerEngine == 'managedInstance')",
    unavailableHint: 'Select Security or Logins of a SQL Server or Managed Instance in Object Explorer.',
    menus: [
      { menu: 'explorer.context', group: '0_new', order: 1, mnemonic: 'n', when: "((explorerNode == 'folder' && explorerFolder == 'logins') || explorerNode == 'login') && !explorerServerLost && (explorerServerEngine == 'box' || explorerServerEngine == 'managedInstance')" }
    ]
  },
  // The same dialog as Security › New › Login…: a command of its own because macOS context menus show placements by command id,
  // so one command in both menus would show twice on Security. The palette has New Login… for both.
  'explorer.newLoginOnSecurity': {
    title: 'Login…', category: 'Object Explorer', icon: 'login', palette: false,
    precondition: "backendReady && explorerSelectionFolder == 'serverSecurity' && (explorerSelectionServerEngine == 'box' || explorerSelectionServerEngine == 'managedInstance')",
    unavailableHint: 'Select Security of a SQL Server or Managed Instance in Object Explorer.',
    menus: [{ menu: 'explorer.new', group: '1_security', order: 1, mnemonic: 'l', when: "explorerFolder == 'serverSecurity' && (explorerServerEngine == 'box' || explorerServerEngine == 'managedInstance')" }]
  },
  'explorer.stop': { title: 'Stop', category: 'Object Explorer', icon: 'debug-stop', keywords: ['cancel'], precondition: 'explorerLoading', unavailableHint: 'Nothing is loading.' },
  'explorer.collapseAll': { title: 'Collapse All', category: 'Object Explorer', icon: 'collapse-all', precondition: 'hasConnection', unavailableHint: noServer },
  // SSMS 2022's Group by Schema: the toolbar button and the palette flip the objectExplorer.groupBySchema setting.
  'explorer.groupBySchema': {
    title: 'Group by Schema', category: 'Object Explorer', icon: 'symbol-namespace', keywords: ['schema', 'group', 'folders', 'tree'], toggled: 'explorerGroupBySchema'
  },
  'explorer.newQuery': {
    title: 'New Query', category: 'Object Explorer', icon: 'new-file', precondition: '!documentBusy', unavailableHint: 'Select a server or database in Object Explorer.',
    menus: [{ menu: 'explorer.context', group: '1_query', order: 2, mnemonic: 'q', when: "(explorerNode == 'server' && !explorerServerLost) || explorerNode == 'database'" }]
  },
  // Select Top 1000 Rows, Rename and Delete: generated from src/shared/actions/catalog.ts. Each acts on its menu's node,
  // else the selection; explorer.selectTopRows keeps PR4's id.
  ...actionCommandEntries(),
  // The Database Properties document's verbs (Apply, Discard, Refresh, Stop): also from src/shared/actions/catalog.ts.
  ...propertiesCommandEntries(),
  // Databases › New Database…, and the New Database document's verbs (OK, Cancel, Stop): also from src/shared/actions/catalog.ts.
  ...serverActionCommandEntries(),
  ...newDatabaseCommandEntries(),
  // The Restore Database document's verbs (Restore, Stop, Refresh): also from src/shared/actions/catalog.ts.
  ...restoreCommandEntries(),
  // New › Table… and the table designer's commands: generated from src/shared/designer/catalog.ts.
  ...designerCommandEntries(),
  // The Integration Services Operations document: its presets on the SSISDB node and View, and its own commands, generated
  // from src/shared/ssis/operations.ts.
  ...operationsCommandEntries(),
  // Script as › <verb> To › <destination>: 30 commands generated from src/shared/scripting/catalog.ts, which keep the
  // table menu's explorer.scriptCreateTo* ids. Each acts on its menu's node, else the selection.
  ...scriptCommandEntries(),
  // The SSIS Catalog's verbs on its tree nodes (Properties) and the properties documents' Refresh: generated from
  // src/shared/ssis/catalog.ts. Each verb acts on its menu's node, else the selection.
  ...ssisCommandEntries(),
  // The palette's way in: a quick pick of the enabled verbs and destinations for the selected node.
  'explorer.scriptAs': {
    title: 'Script As…', category: 'Object Explorer', icon: 'file-code', keywords: ['script', 'create', 'alter', 'drop', 'select', 'insert', 'update', 'delete', 'execute'],
    precondition: "backendReady && explorerScriptTitle != ''", unavailableHint: scriptUnavailableHint
  },
  // SSMS's Modify: ALTER to a new query window, for modules and triggers.
  'explorer.modify': {
    title: 'Modify', category: 'Object Explorer', icon: 'edit', precondition: "backendReady && explorerSelectionModifiable && explorerScriptAlter == 'enabled' && !documentBusy",
    unavailableHint: 'Select a stored procedure, function, or trigger.',
    menus: [
      { menu: 'explorer.context', group: '1_query', order: 4, mnemonic: 'y', when: "explorerSelectionModifiable && explorerNode != 'background'" },
      { menu: 'search.hit.context', group: '1_query', order: 4, mnemonic: 'y', when: 'explorerSelectionModifiable' }
    ]
  },
  'explorer.cancelScripting': { title: 'Cancel Scripting', category: 'Object Explorer', icon: 'debug-stop', keywords: ['script', 'stop'], precondition: 'scriptingRunning', unavailableHint: 'Nothing is being scripted.' },
  // Peek: the object's definition and properties in a card beside its row (src/shared/explorer/peek.ts). Space on the selected
  // row opens it too, except while type-ahead collects a name with spaces; Ctrl+hover (⌘ on macOS) is the tree's own.
  'explorer.peek': {
    title: 'Peek', category: 'Object Explorer', icon: 'eye', keywords: ['definition', 'properties', 'preview', 'describe'],
    precondition: 'backendReady && explorerSelectionPeekable',
    unavailableHint: 'Select an object Peek describes: a table, view, procedure, function, index, trigger, database, login, synonym, sequence, or type.',
    keybindings: [{ key: 'alt+f12', when: "activePanel == 'explorer' && !inputFocus && !searchHitsFocus" }, { key: 'space', when: 'explorerFocus && !textInputFocus && !explorerTypeAhead' }],
    menus: [{ menu: 'explorer.context', group: '1_query', order: 7, mnemonic: 'k', when: 'explorerNodePeekable && !explorerServerLost' }]
  },
  // Peek promoted to a document tab, with more room: the card's object while the card is open, otherwise the selection. A
  // Ctrl+click (⌘-click on macOS) on a row opens one too (gestures.ts, explorer.openPeekTab).
  'explorer.openPeekTab': {
    title: 'Open Peek as Tab', category: 'Object Explorer', icon: 'link-external', keywords: ['peek', 'definition', 'properties', 'preview', 'document', 'promote'],
    // The open card, else the menu's or Ctrl+click's row, else the selection: the handler's own condition says which applies.
    precondition: 'backendReady',
    unavailableHint: 'Peek or select an object Peek describes, such as a table, procedure, index or login.',
    // Not in the card's grid, whose keys stay the results grid's.
    keybindings: [{ key: 'mod+enter', when: 'peekFocus && !outputGridFocus' }, { key: 'mod+enter', when: "activePanel == 'explorer' && !inputFocus && !searchHitsFocus" }]
  },
  // The Peek card's or the active Peek tab's Refresh: it reads the object again, its script and its top rows included.
  'peek.refresh': {
    title: 'Refresh Peek', category: 'Object Explorer', icon: 'refresh',
    // The card has no state key of its own: the handler's condition asks whether one is open.
    precondition: 'backendReady', unavailableHint: 'Open Peek first.',
    keybindings: [{ key: 'f5', when: 'peekFocus || peekTabFocus' }]
  },
  'explorer.copyName': {
    title: 'Copy Name', category: 'Object Explorer', icon: 'copy', precondition: 'hasConnection', unavailableHint: 'Select an object that has a name.',
    menus: [{ menu: 'explorer.context', group: '5_copy', order: 1, mnemonic: 'a', when: "(explorerNode != 'background' && explorerNode != 'folder' && explorerNode != 'returnValue' && !explorerServerLost) || explorerFolderInsertable" }]
  },
  'query.changeConnection': {
    title: 'Change Connection…', category: 'Query', icon: 'server', precondition: 'hasActiveDocument && activeDocumentIsQuery && !queryRunning && !documentBusy',
    menus: [{ menu: 'query.connection', group: '2_change', order: 1, mnemonic: 'h' }]
  },
  'query.disconnect': {
    title: 'Disconnect', category: 'Query', icon: 'debug-disconnect', precondition: 'activeDocumentIsQuery && activeDocumentConnected && !queryRunning && !documentBusy',
    unavailableHint: 'This query is not connected.', menus: [{ menu: 'query.connection', group: '1_connect', order: 2, mnemonic: 'd' }]
  },
  'query.disconnectAll': {
    title: 'Disconnect All Queries', category: 'Query', precondition: 'anyDocumentConnected && !documentBusy', unavailableHint: 'No query is connected.',
    menus: [{ menu: 'query.connection', group: '1_connect', order: 3, mnemonic: 'a' }]
  },
  'query.changeDatabase': {
    title: 'Change Database…', category: 'Query', icon: 'database', keywords: ['use', 'catalog'],
    precondition: 'activeDocumentIsQuery && activeDocumentConnected && !queryRunning && !documentBusy', unavailableHint: 'Connect this query to a server first.',
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
  // VS Code's Move Editor Left/Right keys; the query tab menu's items move the tab it was opened for.
  'document.moveLeft': {
    title: 'Move Query Left', category: 'View', keywords: ['reorder', 'tab'], precondition: 'multipleDocuments', unavailableHint: secondQuery,
    keybindings: [{ key: 'ctrl+shift+pageup', allowRepeat: true }],
    menus: [{ menu: 'documentTab.context', group: '4_move', order: 1, title: 'Move Left', mnemonic: 'e' }]
  },
  'document.moveRight': {
    title: 'Move Query Right', category: 'View', keywords: ['reorder', 'tab'], precondition: 'multipleDocuments', unavailableHint: secondQuery,
    keybindings: [{ key: 'ctrl+shift+pagedown', allowRepeat: true }],
    menus: [{ menu: 'documentTab.context', group: '4_move', order: 2, title: 'Move Right', mnemonic: 'r' }]
  },
  // Names a tab without saving a file; hot exit keeps the name. F2 on a focused tab, as on a file in VS Code's explorer.
  'document.rename': {
    title: 'Rename Tab…', category: 'View', keywords: ['rename', 'tab', 'name', 'title', 'label'], precondition: 'hasActiveDocument', unavailableHint: openFirst,
    keybindings: [{ key: 'f2', when: 'documentTabFocus && !inputFocus' }],
    menus: [{ menu: 'documentTab.context', group: '4_move', order: 3, mnemonic: 'n' }]
  },
  // VS Code's editor groups (docs/editor-groups.md) and its keys; Ctrl+1 to Ctrl+9 stay free for SSMS's query shortcuts.
  // A document shows in one group at a time, so splitting moves it into the new group; its handler also needs another tab
  // in the document's own group, and says so. The tab menu acts on its tab.
  'editor.splitRight': {
    title: 'Split Editor Right', category: 'View', icon: 'split-horizontal', keywords: ['group', 'side', 'tab', 'move'], precondition: 'multipleDocuments', unavailableHint: secondQuery,
    keybindings: [{ key: 'mod+\\' }],
    menus: [{ menu: 'window', group: '2_groups', order: 1, mnemonic: 'i' }, { menu: 'documentTab.context', group: '5_groups', order: 1, title: 'Split Right', mnemonic: 'i' }]
  },
  'editor.splitDown': {
    title: 'Split Editor Down', category: 'View', keywords: ['group', 'below', 'tab', 'move'], precondition: 'multipleDocuments', unavailableHint: secondQuery,
    keybindings: [{ key: 'mod+k mod+\\', native: true, bridge: true }],
    menus: [{ menu: 'window', group: '2_groups', order: 2, mnemonic: 'w' }, { menu: 'documentTab.context', group: '5_groups', order: 2, title: 'Split Down', mnemonic: 'w' }]
  },
  'editor.moveToNextGroup': {
    title: 'Move Editor into Next Group', category: 'View', keywords: ['group', 'split', 'tab'], precondition: 'hasActiveDocument', unavailableHint: openFirst,
    keybindings: [{ win: 'ctrl+alt+right', linux: 'ctrl+alt+right', mac: 'ctrl+mod+right' }],
    menus: [{ menu: 'documentTab.context', group: '5_groups', order: 3, title: 'Move to Next Group', mnemonic: 'x' }]
  },
  'editor.moveToPreviousGroup': {
    title: 'Move Editor into Previous Group', category: 'View', keywords: ['group', 'split', 'tab'], precondition: 'multipleEditorGroups', unavailableHint: 'Split the editor first.',
    keybindings: [{ win: 'ctrl+alt+left', linux: 'ctrl+alt+left', mac: 'ctrl+mod+left' }],
    menus: [{ menu: 'documentTab.context', group: '5_groups', order: 4, title: 'Move to Previous Group', mnemonic: 'v' }]
  },
  'editor.focusNextGroup': {
    title: 'Focus Next Editor Group', category: 'View', keywords: ['group', 'split'], precondition: 'multipleEditorGroups', unavailableHint: 'Split the editor first.',
    keybindings: [{ key: 'mod+k mod+right', native: true, bridge: true }]
  },
  'editor.focusPreviousGroup': {
    title: 'Focus Previous Editor Group', category: 'View', keywords: ['group', 'split'], precondition: 'multipleEditorGroups', unavailableHint: 'Split the editor first.',
    keybindings: [{ key: 'mod+k mod+left', native: true, bridge: true }]
  },
  'editor.joinGroups': {
    title: 'Join All Editor Groups', category: 'View', keywords: ['group', 'split', 'merge', 'unsplit'], precondition: 'multipleEditorGroups', unavailableHint: 'Split the editor first.',
    menus: [{ menu: 'window', group: '2_groups', order: 3, mnemonic: 'j' }]
  },
  'editor.increaseTabRows': {
    title: 'Increase Tab Stack Height', category: 'View', keywords: ['tab', 'rows', 'shelf', 'stack'], precondition: 'hasActiveDocument', unavailableHint: openFirst,
    menus: [{ menu: 'documentTab.context', group: '4_stack', order: 1, mnemonic: 'h' }]
  },
  'editor.decreaseTabRows': {
    title: 'Decrease Tab Stack Height', category: 'View', keywords: ['tab', 'rows', 'shelf', 'stack'], precondition: 'hasActiveDocument', unavailableHint: openFirst,
    menus: [{ menu: 'documentTab.context', group: '4_stack', order: 2, mnemonic: 't' }]
  },
  // A floating group stays over the editor area; documents do not move into windows of their own (docs/editor-groups.md).
  'editor.float': {
    title: 'Float Editor', category: 'View', keywords: ['group', 'undock', 'tab'], precondition: 'hasActiveDocument', unavailableHint: openFirst,
    menus: [{ menu: 'documentTab.context', group: '5_groups', order: 5, title: 'Float', mnemonic: 'f', when: '!documentTabFloating' }]
  },
  'editor.dock': {
    title: 'Dock Editor', category: 'View', keywords: ['group', 'float', 'tab'], precondition: 'hasActiveDocument', unavailableHint: openFirst,
    menus: [{ menu: 'documentTab.context', group: '5_groups', order: 6, title: 'Dock', mnemonic: 'k', when: 'documentTabFloating' }]
  },
  // Edit › Advanced › Word Wrap, where SSMS has it.
  'editor.toggleWordWrap': {
    title: 'Toggle Word Wrap', category: 'View', icon: 'word-wrap', toggled: 'editorWordWrap',
    // ⌥Z types Ω on macOS.
    keybindings: [{ win: 'alt+z', linux: 'alt+z' }], menus: [{ menu: 'edit.advanced', group: '2_view', order: 2, title: 'Word Wrap', mnemonic: 'w' }]
  },
  // Visual Studio's Insert key: overtype replaces the character after the caret. macOS keyboards have no Insert key.
  'editor.toggleOvertype': {
    title: 'Toggle Insert/Overtype Mode', category: 'Edit', keywords: ['insert', 'overtype', 'overwrite', 'ins', 'ovr'], toggled: 'editorOvertype',
    precondition: 'activeDocumentIsText', unavailableHint: openFirst, keybindings: [{ win: 'insert', linux: 'insert', when: 'editorTextFocus' }]
  },
  'edit.find': {
    title: 'Find', category: 'Edit', icon: 'search', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+f', native: true }], menus: [{ menu: 'edit.findReplace', group: '1_find', order: 1, title: 'Quick Find', mnemonic: 'q' }]
  },
  'edit.replace': {
    title: 'Replace', category: 'Edit', icon: 'replace', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ win: 'ctrl+h', linux: 'ctrl+h', mac: 'alt+mod+f', native: true }], menus: [{ menu: 'edit.findReplace', group: '1_find', order: 2, title: 'Quick Replace', mnemonic: 'r' }]
  },
  'edit.toggleLineComment': {
    title: 'Toggle Line Comment', category: 'Edit', icon: 'comment', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+/', native: true }], menus: [{ menu: 'edit.advanced', group: '3_comment', order: 3, mnemonic: 't' }]
  },
  'edit.commentLines': {
    title: 'Comment Selection', category: 'Edit', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+k mod+c', native: true }], menus: [{ menu: 'edit.advanced', group: '3_comment', order: 1, mnemonic: 'm' }]
  },
  'edit.uncommentLines': {
    title: 'Uncomment Selection', category: 'Edit', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+k mod+u', native: true }], menus: [{ menu: 'edit.advanced', group: '3_comment', order: 2, mnemonic: 'n' }]
  },
  // SSMS's editing commands: Find and Replace, Go To Line, Edit › Advanced, Bookmarks, and IntelliSense's snippets.
  'edit.findNext': {
    title: 'Find Next', category: 'Edit', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ win: 'f3', linux: 'f3', mac: 'mod+g', native: true }, { mac: 'f3', native: true }], menus: [{ menu: 'edit.findReplace', group: '2_next', order: 1, mnemonic: 'n' }]
  },
  'edit.findPrevious': {
    title: 'Find Previous', category: 'Edit', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ win: 'shift+f3', linux: 'shift+f3', mac: 'mod+shift+g', native: true }, { mac: 'shift+f3', native: true }],
    menus: [{ menu: 'edit.findReplace', group: '2_next', order: 2, mnemonic: 'p' }]
  },
  // SSMS's Ctrl+G; ⌘G is Find Next on macOS, so macOS uses ⌃G, as VS Code does.
  'edit.goToLine': {
    title: 'Go To Line…', category: 'Edit', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ win: 'ctrl+g', linux: 'ctrl+g', mac: 'ctrl+g', when: 'editorFocus' }], menus: [{ menu: 'edit', group: '3_find', order: 2, mnemonic: 'g' }]
  },
  'edit.makeUppercase': {
    title: 'Make Uppercase', category: 'Edit', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+shift+u', when: 'editorTextFocus' }], menus: [{ menu: 'edit.advanced', group: '1_case', order: 1, mnemonic: 'u' }]
  },
  'edit.makeLowercase': {
    title: 'Make Lowercase', category: 'Edit', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+shift+l', when: 'editorTextFocus' }], menus: [{ menu: 'edit.advanced', group: '1_case', order: 2, mnemonic: 'l' }]
  },
  // No keys: Tab and Shift+Tab indent selected lines, and SSMS has none for these.
  'edit.increaseIndent': {
    title: 'Increase Line Indent', category: 'Edit', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    menus: [{ menu: 'edit.advanced', group: '4_indent', order: 1, mnemonic: 'i' }]
  },
  'edit.decreaseIndent': {
    title: 'Decrease Line Indent', category: 'Edit', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    menus: [{ menu: 'edit.advanced', group: '4_indent', order: 2, mnemonic: 'd' }]
  },
  // No key: SSMS's Ctrl+R Ctrl+W cannot coexist with Ctrl+R alone toggling the results pane.
  'editor.toggleWhitespace': {
    title: 'View White Space', category: 'View', icon: 'whitespace', toggled: 'editorWhitespace',
    menus: [{ menu: 'edit.advanced', group: '2_view', order: 1, mnemonic: 'h' }]
  },
  'editor.toggleLineNumbers': { title: 'Toggle Line Numbers', category: 'View', toggled: 'editorLineNumbers' },
  'edit.toggleBookmark': {
    title: 'Toggle Bookmark', category: 'Edit', icon: 'bookmark', precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+k mod+k', native: true, bridge: true }], menus: [{ menu: 'edit.bookmarks', group: '1_toggle', order: 1, mnemonic: 't' }]
  },
  'edit.previousBookmark': {
    title: 'Previous Bookmark', category: 'Edit', icon: 'bookmark', precondition: 'hasBookmarks', unavailableHint: noBookmarks,
    keybindings: [{ key: 'mod+k mod+p', native: true, bridge: true }], menus: [{ menu: 'edit.bookmarks', group: '2_navigate', order: 1, mnemonic: 'p' }]
  },
  'edit.nextBookmark': {
    title: 'Next Bookmark', category: 'Edit', icon: 'bookmark', precondition: 'hasBookmarks', unavailableHint: noBookmarks,
    keybindings: [{ key: 'mod+k mod+n', native: true, bridge: true }], menus: [{ menu: 'edit.bookmarks', group: '2_navigate', order: 2, mnemonic: 'n' }]
  },
  'edit.clearBookmarks': {
    title: 'Clear Bookmarks', category: 'Edit', icon: 'bookmark', precondition: 'hasBookmarks', unavailableHint: noBookmarks,
    keybindings: [{ key: 'mod+k mod+l', native: true, bridge: true }], menus: [{ menu: 'edit.bookmarks', group: '3_clear', order: 1, mnemonic: 'c' }]
  },
  'edit.previousBookmarkInDocument': {
    title: 'Previous Bookmark In Document', category: 'Edit', icon: 'bookmark', precondition: 'activeDocumentHasBookmarks', unavailableHint: noDocumentBookmarks,
    menus: [{ menu: 'edit.bookmarks', group: '4_document', order: 1, mnemonic: 'r' }]
  },
  'edit.nextBookmarkInDocument': {
    title: 'Next Bookmark In Document', category: 'Edit', icon: 'bookmark', precondition: 'activeDocumentHasBookmarks', unavailableHint: noDocumentBookmarks,
    menus: [{ menu: 'edit.bookmarks', group: '4_document', order: 2, mnemonic: 'x' }]
  },
  'edit.insertSnippet': {
    title: 'Insert Snippet…', category: 'Edit', icon: 'symbol-snippet', keywords: ['template', 'create'], precondition: 'activeDocumentIsQuery && !documentBusy', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+k mod+x', native: true, bridge: true }],
    menus: [{ menu: 'edit.intellisense', group: '1_snippets', order: 1, mnemonic: 'i' }, { menu: 'editor.context', group: '0_snippets', order: 1, mnemonic: 'i' }]
  },
  'edit.surroundWith': {
    title: 'Surround With…', category: 'Edit', icon: 'symbol-snippet', keywords: ['begin', 'if', 'while', 'snippet'], precondition: 'activeDocumentIsQuery && !documentBusy', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+k mod+s', native: true, bridge: true }],
    menus: [{ menu: 'edit.intellisense', group: '1_snippets', order: 2, mnemonic: 's' }, { menu: 'editor.context', group: '0_snippets', order: 2, mnemonic: 's' }]
  },
  'edit.refreshIntelliSense': {
    title: 'Refresh Local Cache', category: 'Edit', icon: 'refresh', keywords: ['intellisense', 'schema', 'metadata', 'cache'],
    precondition: 'backendReady && !documentBusy', unavailableHint: 'Connect a SQL query to refresh its IntelliSense cache.',
    keybindings: [{ key: 'mod+shift+r', when: 'editorFocus && !inputFocus' }],
    menus: [{ menu: 'edit.intellisense', group: '2_cache', order: 1, mnemonic: 'r' }]
  },
  'edit.nextSqlIssue': {
    title: 'Next SQL Issue', category: 'Edit', keywords: ['error', 'warning', 'diagnostic', 'squiggle'], precondition: 'activeDocumentIsQuery', unavailableHint: openFirst,
    keybindings: [{ key: 'alt+f8', native: true }], menus: [{ menu: 'edit.intellisense', group: '3_issues', order: 1, mnemonic: 'n' }]
  },
  'edit.previousSqlIssue': {
    title: 'Previous SQL Issue', category: 'Edit', keywords: ['error', 'warning', 'diagnostic', 'squiggle'], precondition: 'activeDocumentIsQuery', unavailableHint: openFirst,
    keybindings: [{ key: 'alt+shift+f8', native: true }], menus: [{ menu: 'edit.intellisense', group: '3_issues', order: 2, mnemonic: 'p' }]
  },
  // SSMS's Activity Monitor (docs/activity-monitor.md): one per connection, opened from a server's menu, View or the
  // palette. SSMS's Ctrl+Alt+A is AltGr on Windows and Linux layouts (reservedReason), so only macOS has its key, ⌥⌘A.
  'activity.open': {
    title: 'Activity Monitor', category: 'Tools', icon: 'pulse', keywords: ['activity', 'monitor', 'processes', 'sessions', 'blocking', 'waits', 'performance'],
    precondition: 'backendReady && !documentBusy', unavailableHint: 'Wait for the backend to start and for the open document task to finish.', keybindings: [{ mac: 'alt+mod+a' }],
    menus: [
      // 'm', not 'a': View › Search already has 'a' (tests/command-catalog.test.ts).
      { menu: 'view', group: '2_monitor', order: 1, mnemonic: 'm' },
      { menu: 'explorer.context', group: '1_query', order: 5, mnemonic: 't', when: "explorerNode == 'server' && !explorerServerLost" }
    ]
  },
  // The monitor's header verbs and keys act on the active monitor. Pause stops collecting (no SQL), as SSMS's does.
  'activity.togglePause': {
    title: 'Pause', category: 'Activity Monitor', icon: 'debug-pause', keywords: ['resume', 'stop', 'live'], toggled: 'activityPaused',
    precondition: 'activeDocumentIsActivityMonitor', unavailableHint: openMonitor
  },
  'activity.refresh': {
    title: 'Refresh Now', category: 'Activity Monitor', icon: 'refresh', keywords: ['sample', 'update'], precondition: 'activeDocumentIsActivityMonitor && !activityPaused',
    unavailableHint: 'Open the Activity Monitor and resume it first.', keybindings: [{ key: 'f5', when: 'activityMonitorFocus' }]
  },
  'activity.setInterval': {
    title: 'Set Refresh Interval…', category: 'Activity Monitor', icon: 'watch', keywords: ['interval', 'seconds', 'sample'], precondition: 'activeDocumentIsActivityMonitor', unavailableHint: openMonitor
  },
  'activity.setChartWindow': {
    title: 'Set Chart Window…', category: 'Activity Monitor', icon: 'graph-line', keywords: ['chart', 'history', 'minutes', 'window'], precondition: 'activeDocumentIsActivityMonitor', unavailableHint: openMonitor
  },
  'activity.toggleSplit': {
    title: 'Split View', category: 'Activity Monitor', icon: 'split-horizontal', keywords: ['pane', 'split', 'two'], toggled: 'activitySplit',
    precondition: 'activeDocumentIsActivityMonitor', unavailableHint: openMonitor
  },
  // SSMS's F6 and Shift+F6: the tiles, the charts and each pane in turn.
  'activity.nextPane': {
    title: 'Next Panel', category: 'Activity Monitor', palette: false, precondition: 'activeDocumentIsActivityMonitor', unavailableHint: openMonitor,
    keybindings: [{ key: 'f6', when: 'activityMonitorFocus' }]
  },
  'activity.previousPane': {
    title: 'Previous Panel', category: 'Activity Monitor', palette: false, precondition: 'activeDocumentIsActivityMonitor', unavailableHint: openMonitor,
    keybindings: [{ key: 'shift+f6', when: 'activityMonitorFocus' }]
  },
  // SSMS's Shift+Esc.
  'activity.close': {
    title: 'Close Activity Monitor', category: 'Activity Monitor', icon: 'close', precondition: 'activeDocumentIsActivityMonitor && !documentBusy', unavailableHint: openMonitor,
    keybindings: [{ key: 'shift+escape', when: 'activityMonitorFocus' }]
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
  // SSMS's Tools › Options; ⌘, is the macOS settings key.
  'preferences.options': {
    title: 'Options…', category: 'Preferences', icon: 'settings-gear', keywords: ['settings', 'scripting', 'ssms', 'preferences', 'timeout', 'font', 'tab', 'wrap'],
    keybindings: [{ mac: 'mod+,' }], menus: [{ menu: 'tools', group: '1_options', order: 1, mnemonic: 'o' }]
  },
  // The Options dialog's search box, as Visual Studio's Ctrl+E; the dialog is modal, so its key is too.
  'options.focusSearch': {
    title: 'Search Options', category: 'Preferences', palette: false, allowInModal: true,
    keybindings: [{ key: 'mod+e', when: 'optionsDialogFocus', modal: true }]
  },
  // Ctrl+Shift+= too: Electron's own Zoom In key (Ctrl++, ⌘+), which the menus used before they showed Ctrl+=.
  'view.zoomIn': {
    title: 'Zoom In', category: 'View', icon: 'zoom-in', role: 'zoomIn', keybindings: [{ key: 'mod+=', native: true }, { key: 'mod+shift+=', native: true }],
    menus: [{ menu: 'view', group: '4_zoom', order: 1, mnemonic: 'i' }]
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
  // Toasts never take focus by themselves: this moves it to the newest, where Tab reaches its buttons and Escape dismisses it.
  'notifications.focus': {
    title: 'Focus Notifications', category: 'View', icon: 'bell', keywords: ['toast', 'notification', 'message'], precondition: 'hasNotifications',
    unavailableHint: 'There are no notifications.'
  },
  'notifications.clearAll': {
    title: 'Clear All Notifications', category: 'View', icon: 'clear-all', keywords: ['toast', 'notification', 'dismiss'], precondition: 'hasNotifications',
    unavailableHint: 'There are no notifications.'
  },
  // No key: Ctrl+R and ⌘R toggle the results pane, as in SSMS.
  'developer.reloadWindow': { title: 'Reload Window', category: 'Developer', menus: [{ menu: 'view', group: 'z_developer', order: 1, mnemonic: 'e' }] },
  'developer.toggleDevTools': {
    title: 'Toggle Developer Tools', category: 'Developer', icon: 'tools', role: 'toggleDevTools', keybindings: [{ win: 'ctrl+shift+i', linux: 'ctrl+shift+i', mac: 'alt+meta+i', native: true }],
    menus: [{ menu: 'view', group: 'z_developer', order: 2, mnemonic: 'd' }]
  },
  'help.about': {
    title: 'About Varia', category: 'Help', icon: 'info', keywords: ['version', 'build', 'support', 'product'],
    menus: [{ menu: 'help', group: 'z_about', order: 1, mnemonic: 'a' }]
  },
  'help.openProject': { title: 'Varia on GitHub', category: 'Help', icon: 'link-external', keywords: ['project', 'repository', 'source', 'support'] },
  'help.reportIssue': { title: 'Report an Issue', category: 'Help', icon: 'link-external', keywords: ['bug', 'support', 'problem', 'feedback'] },
  // SSMS 22's Help › Clear Entra ID Token Cache: main asks first, then the backend forgets every Microsoft Entra token.
  'help.clearEntraTokenCache': {
    title: 'Clear Entra ID Token Cache', category: 'Help', icon: 'discard', keywords: ['entra', 'azure', 'token', 'signin', 'login', 'mfa'],
    menus: [{ menu: 'help', group: '1_entra', order: 1, mnemonic: 'e' }]
  },
  // Varia's own updates (src/shared/updates.ts): main checks GitHub's releases, downloads and verifies, then installs once
  // the app has closed. SSMS 22's Check for Updates opens the Visual Studio Installer instead.
  'help.checkForUpdates': {
    title: 'Check for Updates', category: 'Help', icon: 'sync', keywords: ['update', 'upgrade', 'version', 'release', 'latest'], precondition: '!updateBusy',
    unavailableHint: 'An update check or download is already running.', menus: [{ menu: 'help', group: '2_updates', order: 1, mnemonic: 'u' }]
  },
  'help.downloadUpdate': {
    title: 'Download Update', category: 'Help', icon: 'cloud-download', keywords: ['update', 'upgrade', 'download'], precondition: 'updateAvailable',
    unavailableHint: 'No update is waiting to download. Check for updates first.'
  },
  'help.restartToUpdate': {
    title: 'Restart to Update', category: 'Help', icon: 'debug-restart', keywords: ['update', 'upgrade', 'install', 'restart'], precondition: 'updateReady',
    unavailableHint: 'No update has been downloaded yet.', menus: [{ menu: 'help', group: '2_updates', order: 2, mnemonic: 'r' }]
  },
  'help.releaseNotes': {
    title: 'Release Notes', category: 'Help', icon: 'link-external', keywords: ['update', 'changelog', 'news', 'release', 'download', 'github'],
    menus: [{ menu: 'help', group: '2_updates', order: 3, mnemonic: 'n' }]
  },
  // The Query Output menu and the results grid's keys: the grid copies its selected cells, and Messages their selected
  // text (Ctrl+C there is Chromium's copy). Select All selects the grid's cells, or only the text of Messages.
  'output.copy': {
    title: 'Copy', category: 'Query', icon: 'copy', palette: false,
    keybindings: [{ key: 'mod+c', when: 'outputGridFocus' }], menus: [{ menu: 'output.context', group: '1_copy', order: 1, mnemonic: 'c' }]
  },
  'output.copyWithHeaders': {
    title: 'Copy with Headers', category: 'Query', palette: false,
    keybindings: [{ key: 'mod+shift+c', when: 'outputGridFocus' }], menus: [{ menu: 'output.context', group: '1_copy', order: 2, mnemonic: 'h', when: "outputView == 'grid'" }]
  },
  'output.copyColumnName': {
    title: 'Copy Column Name', category: 'Query', icon: 'copy', palette: false,
    menus: [{ menu: 'output.context', group: '1_copy', order: 3, mnemonic: 'n', when: "outputView == 'grid'" }]
  },
  'output.selectAll': {
    title: 'Select All', category: 'Query', palette: false,
    keybindings: [{ key: 'mod+a', when: 'outputGridFocus || messagesFocus' }], menus: [{ menu: 'output.context', group: '2_select', order: 1, mnemonic: 'a' }]
  },
  // The grid the menu was opened for, else the focused grid, else the grid that last had focus (the only one, often).
  'output.saveResultsAs': {
    title: 'Save Results As…', category: 'Query', icon: 'save-as', keywords: ['export', 'csv', 'json', 'tab', 'grid'], precondition: 'hasResults',
    unavailableHint: 'Execute a query that returns results first.',
    keybindings: [{ key: 'mod+s', when: 'outputGridFocus' }], menus: [{ menu: 'output.context', group: '3_save', order: 1, mnemonic: 'v', when: "outputView == 'grid'" }]
  },
  // Frees the active query's results in the backend; Messages stay.
  'output.closeResults': {
    title: 'Close Results', category: 'Query', icon: 'close', keywords: ['free', 'memory', 'release', 'clear'], precondition: '!documentBusy',
    unavailableHint: 'There are no results to close, or the query is still running.',
    menus: [{ menu: 'output.context', group: 'z_close', order: 1, mnemonic: 'l' }]
  },
  // The results toolbar's White space choices; each turns the grid's marks off when it is already on (queryResults.grid.whitespace).
  'output.showSpaces': {
    title: 'Show Spaces and Tabs in Results', category: 'Query', icon: 'whitespace', keywords: ['whitespace', 'spaces', 'tabs', 'grid'], toggled: 'resultsWhitespaceSpaces',
    menus: [{ menu: 'output.context', group: '4_view', order: 1, title: 'Show Spaces and Tabs', mnemonic: 'b', when: "outputView == 'grid'" }]
  },
  'output.showAllWhitespace': {
    title: 'Show All White Space in Results', category: 'Query', icon: 'whitespace', keywords: ['whitespace', 'crlf', 'nbsp', 'invisible', 'grid'],
    toggled: 'resultsWhitespaceAll', menus: [{ menu: 'output.context', group: '4_view', order: 2, title: 'Show All White Space', mnemonic: 'w', when: "outputView == 'grid'" }]
  },
  // Sorting a grid (results.view): the menu's column, else the active cell's. Sort replaces the grid's sort; Then Sort adds
  // the column as a further key. A header's sort button does the same with a click, and Shift+click (grid.addSortKey).
  'output.sortAscending': {
    title: 'Sort Ascending', category: 'Query', icon: 'arrow-up', keywords: ['order', 'sort', 'asc', 'grid', 'column'], palette: false,
    menus: [{ menu: 'output.context', group: '2_sort', order: 1, mnemonic: 'o', when: "outputView == 'grid'" }]
  },
  'output.sortDescending': {
    title: 'Sort Descending', category: 'Query', icon: 'arrow-down', keywords: ['order', 'sort', 'desc', 'grid', 'column'], palette: false,
    menus: [{ menu: 'output.context', group: '2_sort', order: 2, mnemonic: 'd', when: "outputView == 'grid'" }]
  },
  'output.thenSortAscending': {
    title: 'Then Sort Ascending', category: 'Query', keywords: ['order', 'sort', 'secondary', 'grid', 'column'], palette: false,
    menus: [{ menu: 'output.context', group: '2_sort', order: 3, when: "outputView == 'grid'" }]
  },
  'output.thenSortDescending': {
    title: 'Then Sort Descending', category: 'Query', keywords: ['order', 'sort', 'secondary', 'grid', 'column'], palette: false,
    menus: [{ menu: 'output.context', group: '2_sort', order: 4, when: "outputView == 'grid'" }]
  },
  'output.clearSort': {
    title: 'Clear Sort', category: 'Query', keywords: ['order', 'unsort', 'original', 'grid'], palette: false,
    menus: [{ menu: 'output.context', group: '2_sort', order: 5, mnemonic: 'r', when: "outputView == 'grid'" }]
  },
  'output.fitColumn': {
    title: 'Fit Column', category: 'Query', keywords: ['resize', 'width', 'autosize'], palette: false,
    menus: [{ menu: 'output.context', group: '2_width', order: 1, mnemonic: 'i', when: "outputView == 'grid'" }]
  },
  'output.revealError': {
    title: 'Go to Error Line', category: 'Query', icon: 'go-to-file', palette: false, precondition: '!documentBusy',
    unavailableHint: 'The error has no location in this query, or the query text has changed since execution.'
  },
  // Search in results (the results toolbar's search box, results.search): Find in Results puts the focus in the box, as
  // Ctrl+F does in a grid; Find Next and Previous step through the matches of every grid, as F3 and Shift+F3 do there.
  'output.find': {
    title: 'Find in Results', category: 'Query', icon: 'search', keywords: ['search', 'find', 'grid', 'values', 'columns', 'filter'], precondition: 'hasResults',
    unavailableHint: 'Execute a query that returns results first.', keybindings: [{ key: 'mod+f', when: 'outputGridFocus' }]
  },
  'output.findNext': {
    title: 'Find Next in Results', category: 'Query', keywords: ['search', 'next', 'match', 'grid'], precondition: 'hasResults', unavailableHint: 'Execute a query that returns results first.',
    keybindings: [{ win: 'f3', linux: 'f3', mac: 'mod+g', when: 'outputGridFocus' }, { mac: 'f3', when: 'outputGridFocus' }]
  },
  'output.findPrevious': {
    title: 'Find Previous in Results', category: 'Query', keywords: ['search', 'previous', 'match', 'grid'], precondition: 'hasResults', unavailableHint: 'Execute a query that returns results first.',
    keybindings: [{ win: 'shift+f3', linux: 'shift+f3', mac: 'mod+shift+g', when: 'outputGridFocus' }, { mac: 'shift+f3', when: 'outputGridFocus' }]
  },
  // Filtering a grid (results.view, results PR 4): by the selected cells of one column (their values, other values, or the
  // range from their lowest to their highest, equal as the column's collation says), without NULL in the active cell's
  // column, or to the rows that repeat in the selected columns or in every column. Filters show in the result's caption,
  // where each comes off on its own; Clear Filters takes them all off.
  // The header funnel's popover (results.distinct, results PR 4b): the column's distinct values with their counts as a
  // checklist, and custom conditions; Alt+Down in a grid opens it for the active cell's column, as Excel's filter list does.
  'output.filterColumnValues': {
    title: 'Filter Column Values…', category: 'Query', icon: 'filter', keywords: ['filter', 'funnel', 'distinct', 'values', 'checklist', 'where', 'grid', 'column'], palette: false,
    keybindings: [{ key: 'alt+down', when: 'outputGridFocus' }],
    menus: [{ menu: 'output.filter', group: '0_column', order: 1, mnemonic: 'v', when: "outputView == 'grid'" }]
  },
  'output.filterSelection': {
    title: 'Filter for Selected Values', category: 'Query', icon: 'filter', keywords: ['filter', 'in', 'equal', 'where', 'values', 'grid'], palette: false,
    menus: [{ menu: 'output.filter', group: '1_values', order: 1, mnemonic: 's', when: "outputView == 'grid'" }]
  },
  'output.excludeSelection': {
    title: 'Exclude Selected Values', category: 'Query', keywords: ['filter', 'not', 'exclude', 'where', 'values', 'grid'], palette: false,
    menus: [{ menu: 'output.filter', group: '1_values', order: 2, mnemonic: 'e', when: "outputView == 'grid'" }]
  },
  'output.filterBetween': {
    title: 'Filter Between Lowest and Highest Selected', category: 'Query', keywords: ['filter', 'between', 'range', 'min', 'max', 'grid'], palette: false,
    menus: [{ menu: 'output.filter', group: '1_values', order: 3, mnemonic: 'b', when: "outputView == 'grid'" }]
  },
  'output.excludeNulls': {
    title: 'Exclude NULLs', category: 'Query', keywords: ['filter', 'null', 'nulls', 'exclude', 'grid'], palette: false,
    menus: [{ menu: 'output.filter', group: '2_nulls', order: 1, mnemonic: 'n', when: "outputView == 'grid'" }]
  },
  'output.filterDuplicates': {
    title: 'Filter for Duplicates in Selected Columns', category: 'Query', keywords: ['filter', 'duplicates', 'repeated', 'group', 'having', 'grid'], palette: false,
    menus: [{ menu: 'output.filter', group: '3_duplicates', order: 1, mnemonic: 'd', when: "outputView == 'grid'" }]
  },
  'output.filterDuplicateRows': {
    title: 'Filter for Duplicate Rows', category: 'Query', keywords: ['filter', 'duplicates', 'repeated', 'rows', 'distinct', 'grid'], palette: false,
    menus: [{ menu: 'output.filter', group: '3_duplicates', order: 2, mnemonic: 'r', when: "outputView == 'grid'" }]
  },
  'output.clearFilters': {
    title: 'Clear Filters', category: 'Query', icon: 'clear-all', keywords: ['filter', 'unfilter', 'all', 'reset', 'grid'], palette: false,
    menus: [{ menu: 'output.filter', group: '4_clear', order: 1, mnemonic: 'c', when: "outputView == 'grid'" }]
  },
  // The results toolbar's Sort text by choices (queryResults.grid.sortText); each goes back to Value when it is already on.
  'output.sortTextByChars': {
    title: 'Sort Text by Length in Characters', category: 'Query', icon: 'symbol-ruler', keywords: ['sort', 'length', 'len', 'characters', 'text', 'grid'], toggled: 'resultsSortTextChars'
  },
  'output.sortTextByBytes': {
    title: 'Sort Text by Length in Bytes', category: 'Query', icon: 'symbol-ruler', keywords: ['sort', 'length', 'datalength', 'bytes', 'text', 'binary', 'grid'], toggled: 'resultsSortTextBytes'
  },
  // Highlights (results PR 8): the selected rows of a grid whose result has every row take a colour, kept on each row by its
  // identity (a unique key column, else the whole row) through sorts and re-runs. Highlight Rows uses the last colour
  // picked (yellow at first); a colour every selected row already has comes off.
  'output.highlightRows': {
    title: 'Highlight Rows', category: 'Query', icon: 'symbol-color', keywords: ['highlight', 'mark', 'color', 'row', 'grid', 'flag'], palette: false,
    keybindings: [{ key: 'mod+shift+h', when: 'outputGridFocus' }]
  },
  'output.highlightYellow': {
    title: 'Highlight Rows Yellow', category: 'Query', keywords: ['highlight', 'mark', 'color', 'yellow', 'row', 'grid'], palette: false,
    menus: [{ menu: 'output.highlight', group: '1_colors', order: 1, title: 'Yellow', mnemonic: 'y', when: "outputView == 'grid'" }]
  },
  'output.highlightGreen': {
    title: 'Highlight Rows Green', category: 'Query', keywords: ['highlight', 'mark', 'color', 'green', 'row', 'grid'], palette: false,
    menus: [{ menu: 'output.highlight', group: '1_colors', order: 2, title: 'Green', mnemonic: 'g', when: "outputView == 'grid'" }]
  },
  'output.highlightBlue': {
    title: 'Highlight Rows Blue', category: 'Query', keywords: ['highlight', 'mark', 'color', 'blue', 'row', 'grid'], palette: false,
    menus: [{ menu: 'output.highlight', group: '1_colors', order: 3, title: 'Blue', mnemonic: 'b', when: "outputView == 'grid'" }]
  },
  'output.highlightPurple': {
    title: 'Highlight Rows Purple', category: 'Query', keywords: ['highlight', 'mark', 'color', 'purple', 'row', 'grid'], palette: false,
    menus: [{ menu: 'output.highlight', group: '1_colors', order: 4, title: 'Purple', mnemonic: 'p', when: "outputView == 'grid'" }]
  },
  'output.highlightRed': {
    title: 'Highlight Rows Red', category: 'Query', keywords: ['highlight', 'mark', 'color', 'red', 'row', 'grid'], palette: false,
    menus: [{ menu: 'output.highlight', group: '1_colors', order: 5, title: 'Red', mnemonic: 'r', when: "outputView == 'grid'" }]
  },
  'output.clearHighlight': {
    title: 'Clear Highlight', category: 'Query', keywords: ['highlight', 'unmark', 'row', 'grid'], palette: false,
    menus: [{ menu: 'output.highlight', group: '2_clear', order: 1, mnemonic: 'c', when: "outputView == 'grid'" }]
  },
  'output.clearAllHighlights': {
    title: 'Clear All Highlights', category: 'Query', icon: 'clear-all', keywords: ['highlight', 'unmark', 'reset', 'grid'], palette: false,
    menus: [{ menu: 'output.highlight', group: '2_clear', order: 2, mnemonic: 'a', when: "outputView == 'grid'" }]
  },
  // Compares the grid's result with the run's result before it (results.diff) and adds their unified diff as a result.
  'output.compareWithPrevious': {
    title: 'Compare with Previous Result', category: 'Query', icon: 'git-compare', keywords: ['diff', 'compare', 'difference', 'changes', 'grid', 'result'],
    menus: [{ menu: 'output.context', group: '2_sort', order: 8, mnemonic: 'm', when: "outputView == 'grid'" }]
  },
  // Opens the pivot panel on the grid's result (PivotService); Build Pivot there adds the pivot (results.pivot) as a result.
  'output.pivot': {
    title: 'Pivot Results…', category: 'Query', icon: 'pivot', keywords: ['pivot', 'group', 'aggregate', 'summarize', 'crosstab', 'count', 'sum', 'average', 'grid', 'result'],
    menus: [{ menu: 'output.context', group: '2_sort', order: 9, when: "outputView == 'grid'" }]
  },
  // Transposes the grid's rows as it shows them (results.transpose): its columns become rows, its rows columns, added as a
  // result (TransposeService). Selected Rows takes only the selected rows (a record view); Using Column as Headers names the
  // columns by the active cell's column.
  'output.transpose': {
    title: 'Transpose Results', category: 'Query', icon: 'transpose', keywords: ['transpose', 'rotate', 'swap', 'flip', 'columns', 'rows', 'record', 'grid', 'result'],
    menus: [{ menu: 'output.transposeMenu', group: '1_rows', order: 1, title: 'All Rows', mnemonic: 'a', when: 'outputGridTransposable' }]
  },
  'output.transposeSelectedRows': {
    title: 'Transpose Selected Rows', category: 'Query', icon: 'transpose', keywords: ['transpose', 'rotate', 'record', 'selected', 'rows', 'details', 'grid'],
    menus: [{ menu: 'output.transposeMenu', group: '1_rows', order: 2, title: 'Selected Rows', mnemonic: 's', when: 'outputGridTransposable' }]
  },
  'output.transposeWithHeaders': {
    title: 'Transpose Using Column as Headers', category: 'Query', icon: 'transpose', keywords: ['transpose', 'rotate', 'headers', 'names', 'column', 'grid'],
    menus: [{ menu: 'output.transposeMenu', group: '2_headers', order: 1, title: 'Using Column as Headers', mnemonic: 'h', when: 'outputGridTransposable' }]
  },
  'output.compareWithPreviousExact': {
    title: 'Compare with Previous Result (Exact Text)', category: 'Query', icon: 'git-compare', keywords: ['diff', 'compare', 'difference', 'case', 'collation', 'exact', 'grid']
  },
  // The results toolbar's Profile and Row size toggles (queryResults.grid.columnProfile, queryResults.grid.rowSize).
  'output.toggleColumnProfile': {
    title: 'Show Column Profile', category: 'Query', icon: 'graph', keywords: ['profile', 'stats', 'statistics', 'distinct', 'nulls', 'histogram', 'grid', 'column'],
    toggled: 'resultsColumnProfile', menus: [{ menu: 'output.context', group: '4_view', order: 3, title: 'Column Profile', mnemonic: 'f', when: "outputView == 'grid'" }]
  },
  'output.toggleRowSize': {
    title: 'Show Row Size in Results', category: 'Query', icon: 'list-flat', keywords: ['row', 'size', 'bytes', 'datalength', 'bar', 'grid'],
    toggled: 'resultsRowSize', menus: [{ menu: 'output.context', group: '4_view', order: 4, title: 'Show Row Size', mnemonic: 'z', when: "outputView == 'grid'" }]
  },
  // A click or Enter on an XML, JSON or plan cell opens its whole value, formatted, in a new tab (the grid runs it).
  'output.openValue': { title: 'Open Value in New Tab', category: 'Query', icon: 'go-to-file', palette: false },
  // A panel's menu, from its tab or its ⋯ button: the panel comes from the menu's target, so these have no keys and are
  // not in the palette. The Dock and Tab with items replace the panel header's old "Move…" list.
  'pane.dockLeft': { title: 'Dock Left', category: 'View', palette: false, menus: [{ menu: 'dockTab.context', group: '0_move', order: 1, mnemonic: 'l' }] },
  'pane.dockRight': { title: 'Dock Right', category: 'View', palette: false, menus: [{ menu: 'dockTab.context', group: '0_move', order: 2, mnemonic: 'r' }] },
  'pane.dockTop': { title: 'Dock Top', category: 'View', palette: false, menus: [{ menu: 'dockTab.context', group: '0_move', order: 3, mnemonic: 't' }] },
  'pane.dockBottom': { title: 'Dock Bottom', category: 'View', palette: false, menus: [{ menu: 'dockTab.context', group: '0_move', order: 4, mnemonic: 'b' }] },
  'pane.tabWithExplorer': { title: 'Tab with Object Explorer', category: 'View', palette: false, menus: [{ menu: 'dockTab.context', group: '0_tab', order: 1, mnemonic: 'o', when: "pane != 'explorer'" }] },
  'pane.tabWithEditor': { title: 'Tab with Query Editor', category: 'View', palette: false, menus: [{ menu: 'dockTab.context', group: '0_tab', order: 2, mnemonic: 'e', when: "pane != 'editor'" }] },
  'pane.tabWithResults': { title: 'Tab with Results', category: 'View', palette: false, menus: [{ menu: 'dockTab.context', group: '0_tab', order: 3, mnemonic: 'u', when: "pane != 'results'" }] },
  'pane.tabWithMessages': { title: 'Tab with Messages', category: 'View', palette: false, menus: [{ menu: 'dockTab.context', group: '0_tab', order: 4, mnemonic: 'm', when: "pane != 'messages'" }] },
  'pane.tabWithPlan': { title: 'Tab with Execution Plan', category: 'View', palette: false, menus: [{ menu: 'dockTab.context', group: '0_tab', order: 5, mnemonic: 'x', when: "pane != 'plan'" }] },
  'pane.float': { title: 'Float', category: 'View', icon: 'multiple-windows', palette: false, menus: [{ menu: 'dockTab.context', group: '1_dock', order: 1, mnemonic: 'f', when: '!paneFloating' }] },
  'pane.dock': { title: 'Dock', category: 'View', palette: false, menus: [{ menu: 'dockTab.context', group: '1_dock', order: 2, mnemonic: 'd', when: 'paneFloating' }] },
  // A panel in an OS window of its own, as VS Code's Move Editor into New Window (docs/popout-windows.md). The query
  // editor stays in the main window. Dragging a panel's tab out of the window does the same; dragging the popout's tab
  // onto the main window, or closing the popout, docks it back.
  'pane.moveToNewWindow': { title: 'Move into New Window', category: 'View', icon: 'window', palette: false, menus: [{ menu: 'dockTab.context', group: '1_dock', order: 3, mnemonic: 'w', when: "pane != 'editor' && !panePopout" }] },
  'pane.moveToMainWindow': { title: 'Move Back into Main Window', category: 'View', palette: false, menus: [{ menu: 'dockTab.context', group: '1_dock', order: 4, mnemonic: 'a', when: 'panePopout' }] },
  'pane.close': { title: 'Close', category: 'View', icon: 'close', palette: false, menus: [{ menu: 'dockTab.context', group: '2_close', order: 1, mnemonic: 'c' }] },
  // A panel alone in its dock group hides its tab, as VS Code's single views do; this shows those tabs again for dragging.
  'window.togglePanelTabs': {
    title: 'Toggle Panel Tabs', category: 'View', icon: 'layout', keywords: ['panel', 'tab', 'header', 'dock', 'drag'], toggled: 'panelTabsVisible',
    menus: [{ menu: 'window', group: '1_panes', order: 7, title: 'Panel Tabs', mnemonic: 't' }, { menu: 'dockTab.context', group: '3_tabs', order: 1, title: 'Show Panel Tabs', mnemonic: 's' }]
  },
  // The header's search box: open queries, commands, and the servers' objects (Search Objects' search). SSMS 22's search box
  // (the Visual Studio shell's) is Ctrl+Q; Linux and macOS keep that key for quitting.
  'workbench.search': {
    title: 'Search…', category: 'View', icon: 'search', keywords: ['find', 'objects', 'tables', 'goto', 'launch'],
    keybindings: [{ win: 'ctrl+q' }], menus: [{ menu: 'view', group: '0_palette', order: 3, mnemonic: 'a' }]
  },
  // Search Objects: a tab that searches a server's object index (names and module definitions), loaded in the tree or not.
  'explorer.searchObjects': {
    title: 'Search Objects…', category: 'Object Explorer', icon: 'search', keywords: ['find', 'objects', 'definitions', 'text', 'procedures', 'index', 'regex', 'grep'],
    precondition: 'hasConnection', unavailableHint: noServer,
    menus: [
      { menu: 'view', group: '0_palette', order: 4, mnemonic: 'j' },
      { menu: 'explorer.context', group: '1_query', order: 6, mnemonic: 'h', when: "(explorerNode == 'server' && !explorerServerLost) || explorerNode == 'database'" }
    ]
  },
  'explorer.rebuildIndex': {
    title: 'Rebuild Search Index', category: 'Object Explorer', icon: 'refresh', keywords: ['search', 'objects', 'index', 'refresh'],
    precondition: 'hasConnection', unavailableHint: noServer
  },
  'explorer.stopIndexing': { title: 'Stop Indexing', category: 'Object Explorer', icon: 'debug-stop', keywords: ['search', 'index', 'cancel'] },
  // A Search Objects result's menu (search.hit.context) and keys. They act on the result the menu was opened for, else the
  // selected result of the list that has focus; the palette offers none of them, since it has no result to act on.
  'search.revealHit': {
    title: 'Reveal in Object Explorer', category: 'Object Explorer', icon: 'list-tree', palette: false, precondition: 'hasConnection', unavailableHint: 'Select a search result.',
    menus: [{ menu: 'search.hit.context', group: '0_reveal', order: 1, mnemonic: 'r' }]
  },
  // Ctrl+C (and Edit › Copy) on a focused result runs it from SearchPanel's list, as the results grid's does; the rule only labels the key.
  'search.copyName': {
    title: 'Copy Name', category: 'Object Explorer', icon: 'copy', palette: false, precondition: 'hasConnection', unavailableHint: 'Select a search result.',
    keybindings: [{ key: 'mod+c', when: 'searchHitsFocus', native: true }], menus: [{ menu: 'search.copy', group: '1_names', order: 1, title: 'Name', mnemonic: 'n' }]
  },
  'search.copySchemaName': {
    title: 'Copy Schema-Qualified Name', category: 'Object Explorer', palette: false, precondition: 'hasConnection', unavailableHint: 'Select a search result in a schema.',
    menus: [{ menu: 'search.copy', group: '1_names', order: 2, title: 'Schema-Qualified Name', mnemonic: 's', when: 'searchHitSchema' }]
  },
  'search.copyQualifiedName': {
    title: 'Copy Fully Qualified Name', category: 'Object Explorer', palette: false, precondition: 'hasConnection', unavailableHint: 'Select a search result in a schema.',
    keybindings: [{ key: 'mod+shift+c', when: 'searchHitsFocus' }], menus: [{ menu: 'search.copy', group: '1_names', order: 3, title: 'Fully Qualified Name', mnemonic: 'f', when: 'searchHitSchema' }]
  },
  'search.copyBracketedName': {
    title: 'Copy Bracketed Name', category: 'Object Explorer', palette: false, precondition: 'hasConnection', unavailableHint: 'Select a search result.',
    menus: [{ menu: 'search.copy', group: '2_brackets', order: 1, title: 'Bracketed Name', mnemonic: 'b' }]
  }
} as const satisfies Record<string, CommandDescriptor>

export type CommandId = keyof typeof commandCatalog
export const commandIds = Object.keys(commandCatalog) as CommandId[]
export const isCommandId = (value: unknown): value is CommandId => typeof value === 'string' && Object.hasOwn(commandCatalog, value)
/** Widens a catalogue entry so optional fields can be read without narrowing on the literal type. */
export const commandDescriptor = (id: CommandId): CommandDescriptor => commandCatalog[id]
/**
 * Whether the query tab menu has the command, so it can act on a tab other than the shown one: a key pressed on a focused
 * tab passes that tab to these alone. Every other command's keys follow the shown document, as their context keys do.
 */
export const actsOnTab = (id: CommandId): boolean => !!commandDescriptor(id).menus?.some(placement => placement.menu === 'documentTab.context')
export const paletteLabel = (id: CommandId): string => { const command = commandDescriptor(id); return command.category ? `${command.category}: ${command.title}` : command.title }
