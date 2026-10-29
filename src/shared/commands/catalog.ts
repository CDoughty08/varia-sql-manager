import type { Platform } from './keybindings'
import type { MenuId } from './menus'
import type { SettingKey } from '../settings/catalog'
import { actionCommandEntries, propertiesCommandEntries } from '../actions/catalog.ts'
import { designerCommandEntries } from '../designer/catalog.ts'
import { scriptCommandEntries, scriptUnavailableHint } from '../scripting/catalog.ts'
import type { IconId } from '../icons.ts'
import { ssisCommandEntries } from '../ssis/catalog.ts'

export type Category = 'File' | 'Edit' | 'View' | 'Query' | 'Connection' | 'Object Explorer' | 'Table Designer' | 'Database Properties' | 'Integration Services' | 'Preferences' | 'Developer' | 'Help'
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
const noServer = 'No server is connected.'
const secondQuery = 'Open a second query first.'
const noFile = 'Save this query to a file first.'
const noBookmarks = 'No bookmarks are set.'
const noDocumentBookmarks = 'This query has no bookmarks.'

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
  'file.close': {
    title: 'Close Query', category: 'File', icon: 'close', precondition: 'hasActiveDocument && !documentBusy', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+w' }, { win: 'ctrl+f4', linux: 'ctrl+f4' }],
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
  'window.output': {
    title: 'Show Query Output', category: 'View', icon: 'output', keywords: ['results', 'messages'],
    menus: [{ menu: 'window', group: '1_panes', order: 3, title: 'Query Output', mnemonic: 'u' }]
  },
  // SSMS's Ctrl+R: hides the results (closing the panel keeps them) or shows them again. It never reloads the window.
  'view.toggleResultsPane': {
    title: 'Toggle Results Pane', category: 'View', icon: 'output', keywords: ['results', 'output', 'hide', 'show'], toggled: 'outputPaneVisible',
    keybindings: [{ key: 'mod+r' }], menus: [{ menu: 'window', group: '1_panes', order: 4, title: 'Show Results Pane', mnemonic: 'h' }]
  },
  // SSMS's F6: between the query editor and its results (the grid that last had focus, else the first, else Messages).
  'window.switchPane': {
    title: 'Switch Between Query and Results', category: 'View', icon: 'output', keywords: ['results', 'editor', 'focus'], precondition: 'activeDocumentIsText', unavailableHint: openFirst,
    keybindings: [{ key: 'f6' }, { key: 'shift+f6' }]
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
    keybindings: [{ key: 'f5', when: 'editorFocus' }, { key: 'mod+enter', when: 'editorFocus' }, { win: 'ctrl+e', linux: 'ctrl+e', when: 'editorFocus' }],
    menus: [{ menu: 'query', group: '1_execute', order: 1, mnemonic: 'x' }, { menu: 'editor.context', group: '2_execute', order: 1, mnemonic: 'x' }]
  },
  'query.cancel': {
    title: 'Cancel Executing Query', category: 'Query', icon: 'debug-stop', precondition: 'queryRunning', unavailableHint: 'No query is running in this tab.',
    keybindings: [{ win: 'alt+pause', linux: 'alt+pause' }],
    menus: [{ menu: 'query', group: '1_execute', order: 2, mnemonic: 'c' }, { menu: 'editor.context', group: '2_execute', order: 2, mnemonic: 'n' }]
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
  'explorer.removeFilter': {
    title: 'Remove Filter', category: 'Object Explorer', icon: 'clear-all', keywords: ['filter', 'clear'], precondition: 'hasConnection', unavailableHint: 'This folder has no filter.',
    menus: [{ menu: 'explorer.context', group: '3_filter', order: 2, mnemonic: 'v', when: 'explorerFolderFiltered' }]
  },
  'explorer.stop': { title: 'Stop', category: 'Object Explorer', icon: 'debug-stop', keywords: ['cancel'], precondition: 'explorerLoading', unavailableHint: 'Nothing is loading.' },
  'explorer.collapseAll': { title: 'Collapse All', category: 'Object Explorer', icon: 'collapse-all', precondition: 'hasConnection', unavailableHint: noServer },
  'explorer.newQuery': {
    title: 'New Query', category: 'Object Explorer', icon: 'new-file', precondition: '!documentBusy', unavailableHint: 'Select a server or database in Object Explorer.',
    menus: [{ menu: 'explorer.context', group: '1_query', order: 1, mnemonic: 'q', when: "(explorerNode == 'server' && !explorerServerLost) || explorerNode == 'database'" }]
  },
  // Select Top 1000 Rows, Rename and Delete: generated from src/shared/actions/catalog.ts. Each acts on its menu's node,
  // else the selection; explorer.selectTopRows keeps PR4's id.
  ...actionCommandEntries(),
  // The Database Properties document's verbs (Apply, Discard, Refresh, Stop): also from src/shared/actions/catalog.ts.
  ...propertiesCommandEntries(),
  // New › Table… and the table designer's commands: generated from src/shared/designer/catalog.ts.
  ...designerCommandEntries(),
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
    menus: [{ menu: 'explorer.context', group: '1_query', order: 3, mnemonic: 'y', when: "explorerSelectionModifiable && explorerNode != 'background'" }]
  },
  'explorer.cancelScripting': { title: 'Cancel Scripting', category: 'Object Explorer', icon: 'debug-stop', keywords: ['script', 'stop'], precondition: 'scriptingRunning', unavailableHint: 'Nothing is being scripted.' },
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
  'developer.reloadWindow': { title: 'Reload Window', category: 'Developer', role: 'reload', menus: [{ menu: 'view', group: 'z_developer', order: 1, mnemonic: 'e' }] },
  'developer.toggleDevTools': {
    title: 'Toggle Developer Tools', category: 'Developer', icon: 'tools', role: 'toggleDevTools', keybindings: [{ win: 'ctrl+shift+i', linux: 'ctrl+shift+i', mac: 'alt+meta+i', native: true }],
    menus: [{ menu: 'view', group: 'z_developer', order: 2, mnemonic: 'd' }]
  },
  // SSMS 22's Help › Clear Entra ID Token Cache: main asks first, then the backend forgets every Microsoft Entra token.
  'help.clearEntraTokenCache': {
    title: 'Clear Entra ID Token Cache', category: 'Help', icon: 'discard', keywords: ['entra', 'azure', 'token', 'signin', 'login', 'mfa'],
    menus: [{ menu: 'help', group: '1_entra', order: 1, mnemonic: 'e' }]
  },
  // The Query Output menu and the results grid's keys: the grid copies its selected cells (Ctrl+C reaches its copy
  // event, and Ctrl+A is its own), and Messages its selected text.
  'output.copy': {
    title: 'Copy', category: 'Query', icon: 'copy', palette: false,
    keybindings: [{ key: 'mod+c', when: 'outputGridFocus', native: true }], menus: [{ menu: 'output.context', group: '1_copy', order: 1, mnemonic: 'c' }]
  },
  'output.copyWithHeaders': {
    title: 'Copy with Headers', category: 'Query', palette: false,
    keybindings: [{ key: 'mod+shift+c', when: 'outputGridFocus' }], menus: [{ menu: 'output.context', group: '1_copy', order: 2, mnemonic: 'h', when: "outputView == 'grid'" }]
  },
  'output.selectAll': {
    title: 'Select All', category: 'Query', palette: false,
    keybindings: [{ key: 'mod+a', when: 'outputGridFocus', native: true }], menus: [{ menu: 'output.context', group: '2_select', order: 1, mnemonic: 'a' }]
  },
  // The grid the menu was opened for, else the focused grid, else the grid that last had focus (the only one, often).
  'output.saveResultsAs': {
    title: 'Save Results As…', category: 'Query', icon: 'save-as', keywords: ['export', 'csv', 'json', 'tab', 'grid'], precondition: 'hasResults',
    unavailableHint: 'Execute a query that returns results first.',
    keybindings: [{ key: 'mod+s', when: 'outputGridFocus' }], menus: [{ menu: 'output.context', group: '3_save', order: 1, mnemonic: 'v', when: "outputView == 'grid'" }]
  },
  // Frees the active query's results in the backend; Messages stay.
  'output.closeResults': {
    title: 'Close Results', category: 'Query', icon: 'close', keywords: ['free', 'memory', 'release', 'clear'], precondition: 'hasResults && !queryRunning',
    unavailableHint: 'There are no results to close, or the query is still running.'
  },
  // A click or Enter on an XML, JSON or plan cell opens its whole value, formatted, in a new tab (the grid runs it).
  'output.openValue': { title: 'Open Value in New Tab', category: 'Query', icon: 'go-to-file', palette: false },
  // A panel tab's menu: the panel comes from the menu's target, so these have no keys and are not in the palette.
  'pane.float': { title: 'Float', category: 'View', icon: 'multiple-windows', palette: false, menus: [{ menu: 'dockTab.context', group: '1_dock', order: 1, mnemonic: 'f', when: '!paneFloating' }] },
  'pane.dock': { title: 'Dock', category: 'View', palette: false, menus: [{ menu: 'dockTab.context', group: '1_dock', order: 2, mnemonic: 'd', when: 'paneFloating' }] },
  'pane.close': { title: 'Close', category: 'View', icon: 'close', palette: false, menus: [{ menu: 'dockTab.context', group: '2_close', order: 1, mnemonic: 'c' }] }
} as const satisfies Record<string, CommandDescriptor>

export type CommandId = keyof typeof commandCatalog
export const commandIds = Object.keys(commandCatalog) as CommandId[]
export const isCommandId = (value: unknown): value is CommandId => typeof value === 'string' && Object.hasOwn(commandCatalog, value)
/** Widens a catalogue entry so optional fields can be read without narrowing on the literal type. */
export const commandDescriptor = (id: CommandId): CommandDescriptor => commandCatalog[id]
export const paletteLabel = (id: CommandId): string => { const command = commandDescriptor(id); return command.category ? `${command.category}: ${command.title}` : command.title }
