import type { Platform } from './keybindings'
import type { MenuId } from './menus'

export type Category = 'File' | 'Edit' | 'View' | 'Query' | 'Connection' | 'Object Explorer' | 'Preferences'
/** Codicon names (bundled with Monaco) that commands and pickers may show; `tests/command-catalog.test.ts` checks each exists. */
export const codicons = ['new-file', 'folder-opened', 'save', 'save-as', 'close', 'discard', 'redo', 'play', 'debug-stop', 'plug', 'debug-disconnect', 'refresh',
  'database', 'server', 'search', 'replace', 'comment', 'word-wrap', 'layout', 'list-tree', 'output', 'window', 'go-to-file', 'symbol-color'] as const
export type Codicon = typeof codicons[number]

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
}
export interface MenuPlacement {
  readonly menu: MenuId
  /** `<digit or z>_<name>`: groups sort by name and are separated in the menu. */
  readonly group: string
  readonly order: number
  /** The menu label when it differs from the palette title. */
  readonly title?: string
  readonly platforms?: readonly Platform[]
  /** Context menus only (PR3); menubar placements never have one, so native menus need no focus state. */
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
    keybindings: [{ key: 'mod+n' }], menus: [{ menu: 'file', group: '1_file', order: 1 }]
  },
  'file.open': {
    title: 'Open File…', category: 'File', icon: 'folder-opened', precondition: '!documentBusy',
    keybindings: [{ key: 'mod+o' }], menus: [{ menu: 'file', group: '1_file', order: 2, title: 'Open…' }]
  },
  'file.save': {
    title: 'Save', category: 'File', icon: 'save', precondition: 'hasActiveDocument && !documentBusy', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+s' }], menus: [{ menu: 'file', group: '1_file', order: 3 }]
  },
  'file.saveAs': {
    title: 'Save As…', category: 'File', icon: 'save-as', precondition: 'hasActiveDocument && !documentBusy', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+shift+s' }], menus: [{ menu: 'file', group: '1_file', order: 4 }]
  },
  'file.close': {
    title: 'Close Query', category: 'File', icon: 'close', precondition: 'hasActiveDocument && !documentBusy', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+w' }, { win: 'ctrl+f4', linux: 'ctrl+f4' }], menus: [{ menu: 'file', group: '2_close', order: 1 }]
  },
  'window.close': { title: 'Close Window', palette: false, allowInModal: true },
  'edit.undo': {
    title: 'Undo', category: 'Edit', icon: 'discard', allowInModal: true,
    keybindings: [{ key: 'mod+z', native: true }], menus: [{ menu: 'edit', group: '1_undo', order: 1 }]
  },
  'edit.redo': {
    title: 'Redo', category: 'Edit', icon: 'redo', allowInModal: true,
    keybindings: [{ win: 'ctrl+y', linux: 'ctrl+y', mac: 'mod+shift+z', native: true }, { win: 'ctrl+shift+z', linux: 'ctrl+shift+z', native: true }],
    menus: [{ menu: 'edit', group: '1_undo', order: 2 }]
  },
  'window.explorer': {
    title: 'Show Object Explorer', category: 'View', icon: 'list-tree', keywords: ['servers', 'tree'], keybindings: [{ key: 'f8' }],
    menus: [{ menu: 'window', group: '1_panes', order: 1, title: 'Object Explorer' }]
  },
  'window.editor': {
    title: 'Show Query Editor', category: 'View', icon: 'window',
    menus: [{ menu: 'window', group: '1_panes', order: 2, title: 'Query Editor' }]
  },
  'window.output': {
    title: 'Show Query Output', category: 'View', icon: 'output', keywords: ['results', 'messages'],
    menus: [{ menu: 'window', group: '1_panes', order: 3, title: 'Query Output' }]
  },
  'layout.save': {
    title: 'Save Layout…', category: 'View', icon: 'layout',
    menus: [{ menu: 'view', group: '1_layout', order: 1 }, { menu: 'window', group: '3_layout', order: 1, title: 'Save Window Layout…' }]
  },
  'layout.load': {
    title: 'Load Layout…', category: 'View', icon: 'layout',
    menus: [{ menu: 'view', group: '1_layout', order: 2 }, { menu: 'window', group: '3_layout', order: 2, title: 'Load Window Layout…' }]
  },
  'layout.reset': {
    title: 'Reset Layout', category: 'View', icon: 'layout',
    menus: [{ menu: 'view', group: '1_layout', order: 3 }, { menu: 'window', group: '3_layout', order: 3, title: 'Reset Window Layout' }]
  },
  'query.execute': {
    title: 'Execute', category: 'Query', icon: 'play', keywords: ['run', 'go'],
    precondition: 'activeDocumentConnected && !queryRunning && !documentBusy',
    unavailableHint: 'Connect this query to a server and wait for its running query to finish.',
    keybindings: [{ key: 'f5', when: 'editorFocus' }, { key: 'mod+enter', when: 'editorFocus' }, { win: 'ctrl+e', linux: 'ctrl+e', when: 'editorFocus' }],
    menus: [{ menu: 'query', group: '1_execute', order: 1 }]
  },
  'query.cancel': {
    title: 'Cancel Executing Query', category: 'Query', icon: 'debug-stop', precondition: 'queryRunning', unavailableHint: 'No query is running in this tab.',
    keybindings: [{ win: 'alt+pause', linux: 'alt+pause' }], menus: [{ menu: 'query', group: '1_execute', order: 2 }]
  },
  'connection.connect': {
    title: 'Connect to Server…', category: 'Connection', icon: 'plug', keywords: ['login', 'server'], precondition: 'backendReady',
    unavailableHint: 'The backend is still starting.', menus: [{ menu: 'file', group: '0_connect', order: 1 }]
  },
  'explorer.refresh': {
    title: 'Refresh', category: 'Object Explorer', icon: 'refresh', precondition: 'hasConnection', unavailableHint: noServer,
    keybindings: [{ key: 'f5', when: "activePanel == 'explorer' && !inputFocus" }]
  },
  'document.next': {
    title: 'Next Query', category: 'View', precondition: 'multipleDocuments', unavailableHint: secondQuery,
    keybindings: [{ key: 'ctrl+tab', allowRepeat: true }, { win: 'ctrl+pagedown', linux: 'ctrl+pagedown', allowRepeat: true }],
    menus: [{ menu: 'window', group: '2_documents', order: 1 }]
  },
  'document.previous': {
    title: 'Previous Query', category: 'View', precondition: 'multipleDocuments', unavailableHint: secondQuery,
    keybindings: [{ key: 'ctrl+shift+tab', allowRepeat: true }, { win: 'ctrl+pageup', linux: 'ctrl+pageup', allowRepeat: true }],
    menus: [{ menu: 'window', group: '2_documents', order: 2 }]
  },
  'editor.toggleWordWrap': {
    title: 'Toggle Word Wrap', category: 'View', icon: 'word-wrap', toggled: 'editorWordWrap',
    // ⌥Z types Ω on macOS.
    keybindings: [{ win: 'alt+z', linux: 'alt+z' }], menus: [{ menu: 'view', group: '2_editor', order: 1, title: 'Word Wrap' }]
  },
  'edit.find': {
    title: 'Find', category: 'Edit', icon: 'search', precondition: 'hasActiveDocument', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+f', native: true }], menus: [{ menu: 'edit', group: '3_find', order: 1 }]
  },
  'edit.replace': {
    title: 'Replace', category: 'Edit', icon: 'replace', precondition: 'hasActiveDocument', unavailableHint: openFirst,
    keybindings: [{ win: 'ctrl+h', linux: 'ctrl+h', mac: 'alt+mod+f', native: true }], menus: [{ menu: 'edit', group: '3_find', order: 2 }]
  },
  'edit.toggleLineComment': {
    title: 'Toggle Line Comment', category: 'Edit', icon: 'comment', precondition: 'hasActiveDocument', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+/', native: true }], menus: [{ menu: 'edit', group: '4_comment', order: 1 }]
  },
  'edit.commentLines': {
    title: 'Comment Selection', category: 'Edit', precondition: 'hasActiveDocument', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+k mod+c', native: true }], menus: [{ menu: 'edit', group: '4_comment', order: 2 }]
  },
  'edit.uncommentLines': {
    title: 'Uncomment Selection', category: 'Edit', precondition: 'hasActiveDocument', unavailableHint: openFirst,
    keybindings: [{ key: 'mod+k mod+u', native: true }], menus: [{ menu: 'edit', group: '4_comment', order: 3 }]
  }
} as const satisfies Record<string, CommandDescriptor>

export type CommandId = keyof typeof commandCatalog
export const commandIds = Object.keys(commandCatalog) as CommandId[]
export const isCommandId = (value: unknown): value is CommandId => typeof value === 'string' && Object.hasOwn(commandCatalog, value)
/** Widens a catalogue entry so optional fields can be read without narrowing on the literal type. */
export const commandDescriptor = (id: CommandId): CommandDescriptor => commandCatalog[id]
export const paletteLabel = (id: CommandId): string => { const command = commandDescriptor(id); return command.category ? `${command.category}: ${command.title}` : command.title }
