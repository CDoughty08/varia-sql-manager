import type { Platform } from './keybindings'
import { comparisons, parseWhen, referencedKeys, type ContextRecord } from './when'

/**
 * `static` keys never change while the app runs, `state` keys come from service snapshots, `focus` keys from the
 * focused element, and `target` keys from the item a context menu opens for. Preconditions and toggled state may use
 * only static and state keys, so menus, the toolbar, and the palette agree on enablement wherever focus is; keybinding
 * `when` clauses may use static, state, and focus keys; context-menu placements may use static, state, and target keys.
 */
export type ContextKeyScope = 'static' | 'state' | 'focus' | 'target'
interface Declared { readonly scope: Exclude<ContextKeyScope, 'target'>; readonly description: string; readonly menu?: undefined }
/** A target key describes one kind of context-menu target, so it may appear only in that context menu's placements. */
interface DeclaredTarget { readonly scope: 'target'; readonly description: string; readonly menu: 'explorer.context' | 'output.context' | 'dockTab.context' }
export type ContextKeyDeclaration =
  | ({ readonly type: 'boolean' } & (Declared | DeclaredTarget))
  | ({ readonly type: 'enum'; readonly values: readonly string[] } & (Declared | DeclaredTarget))

export const contextKeys = {
  isMac: { type: 'boolean', scope: 'static', description: 'The app runs on macOS.' },
  isWindows: { type: 'boolean', scope: 'static', description: 'The app runs on Windows.' },
  isLinux: { type: 'boolean', scope: 'static', description: 'The app runs on Linux or another platform treated like it.' },
  editorFocus: { type: 'boolean', scope: 'focus', description: 'Focus is in the query editor, including its find widget.' },
  editorTextFocus: { type: 'boolean', scope: 'focus', description: "The query editor's text has focus." },
  inputFocus: { type: 'boolean', scope: 'focus', description: 'Focus is on an input, text area, select, or editable element other than the editor text. The find widget\'s inputs count.' },
  textInputFocus: { type: 'boolean', scope: 'focus', description: '`editorTextFocus || inputFocus`.' },
  activePanel: { type: 'enum', scope: 'focus', values: ['explorer', 'editor', 'output', ''], description: "The pane that holds focus: Object Explorer, the query editor, Query Output, or '' for none." },
  outputGridFocus: { type: 'boolean', scope: 'focus', description: 'Focus is in a results grid, which copies its selected cells rather than text.' },
  quickInputVisible: { type: 'boolean', scope: 'state', description: 'The command palette or a picker is open.' },
  backendReady: { type: 'boolean', scope: 'state', description: 'The backend has answered its health check.' },
  hasActiveDocument: { type: 'boolean', scope: 'state', description: 'A query is open.' },
  multipleDocuments: { type: 'boolean', scope: 'state', description: 'Two or more queries are open.' },
  documentBusy: { type: 'boolean', scope: 'state', description: 'A document task is in progress: opening, saving, or closing a query, or changing its connection.' },
  hasConnection: { type: 'boolean', scope: 'state', description: 'At least one server is connected.' },
  activeDocumentConnected: { type: 'boolean', scope: 'state', description: "The active query's server is connected." },
  queryRunning: { type: 'boolean', scope: 'state', description: 'The active query is running.' },
  anyDocumentConnected: { type: 'boolean', scope: 'state', description: "Some open query's server is connected." },
  outputPaneVisible: { type: 'boolean', scope: 'state', description: 'The Query Output panel is open and showing: its tab is selected, and no other panel is maximized.' },
  editorWordWrap: { type: 'boolean', scope: 'state', description: 'Word wrap is on in the query editor.' },
  explorerNode: {
    type: 'enum', scope: 'target', menu: 'explorer.context', description: "The kind of Object Explorer node the menu is for: the empty area ('background'), a server, folder, database, table, or server-level object.",
    values: ['background', 'server', 'databasesFolder', 'systemDatabasesFolder', 'snapshotsFolder', 'database', 'tablesFolder', 'table', 'securityFolder', 'serverObjectsFolder', 'serverObject', '']
  },
  outputView: { type: 'enum', scope: 'target', menu: 'output.context', values: ['grid', 'messages', 'plan', ''], description: 'The Query Output view the menu is for: a results grid, the messages, or an execution plan.' },
  paneFloating: { type: 'boolean', scope: 'target', menu: 'dockTab.context', description: 'The panel whose tab the menu is for is floating.' }
} as const satisfies Record<string, ContextKeyDeclaration>

type Declarations = typeof contextKeys
export type ContextKey = keyof Declarations
export type ContextKeyValue<K extends ContextKey> = Declarations[K] extends { readonly values: readonly (infer V)[] } ? V : boolean
export type ContextKeys = { readonly [K in ContextKey]: ContextKeyValue<K> }
type KeysOfScope<S extends ContextKeyScope> = { [K in ContextKey]: Declarations[K]['scope'] extends S ? K : never }[ContextKey]
export type StateKeys = Pick<ContextKeys, KeysOfScope<'static' | 'state'>>
export type FocusKeys = Pick<ContextKeys, KeysOfScope<'focus'>>
export type TargetKeys = Pick<ContextKeys, KeysOfScope<'target'>>

export const contextKeyNames = Object.keys(contextKeys) as ContextKey[]
export const isContextKey = (value: string): value is ContextKey => Object.hasOwn(contextKeys, value)
const declaration = (key: ContextKey): ContextKeyDeclaration => contextKeys[key]
/** The context menu a target key belongs to; undefined for every other scope. */
export const targetKeyMenu = (key: ContextKey): DeclaredTarget['menu'] | undefined => declaration(key).menu
export const keysOfScope = (...scopes: ContextKeyScope[]): ContextKey[] => contextKeyNames.filter(key => scopes.includes(declaration(key).scope))
/** Every value a key can take, for enumerating contexts: both booleans, or the enum's values. */
export const contextKeyValues = (key: ContextKey): readonly (boolean | string)[] => { const info = declaration(key); return info.type === 'enum' ? info.values : [false, true] }

export const staticContextKeys = (platform: Platform): Pick<ContextKeys, 'isMac' | 'isWindows' | 'isLinux'> =>
  ({ isMac: platform === 'darwin', isWindows: platform === 'win32', isLinux: platform === 'linux' })

/**
 * A complete context record with no prototype (so `__proto__` is an ordinary key): every key at its default (false, or
 * the enum's '' value), then the platform's static keys, then `values`.
 */
export function contextRecord(platform: Platform, values: Partial<ContextKeys> = {}): ContextRecord & ContextKeys {
  const record: Record<string, boolean | string> = Object.create(null)
  for (const key of contextKeyNames) { const info = declaration(key); record[key] = info.type === 'enum' ? '' : false }
  Object.assign(record, staticContextKeys(platform))
  for (const key of contextKeyNames) if (Object.hasOwn(values, key) && values[key] !== undefined) record[key] = values[key]
  return record as ContextRecord & ContextKeys
}

/**
 * Problems with a when clause: syntax, keys that are not declared or are outside `scopes`, and comparisons whose literal
 * the key can never hold (a string for a boolean key, or a value outside an enum).
 */
export function whenProblems(source: string, scopes: readonly ContextKeyScope[]): string[] {
  let ast
  try { ast = parseWhen(source) } catch (error) { return [`"${source}": ${error instanceof Error ? error.message : String(error)}`] }
  const problems: string[] = []
  for (const key of referencedKeys(ast)) {
    if (!isContextKey(key)) problems.push(`"${source}": unknown context key "${key}"`)
    else if (!scopes.includes(declaration(key).scope)) problems.push(`"${source}": ${declaration(key).scope} key "${key}" is not allowed here`)
  }
  for (const { key, value } of comparisons(ast)) {
    if (!isContextKey(key)) continue
    if (!contextKeyValues(key).includes(value)) problems.push(`"${source}": "${key}" is never ${JSON.stringify(value)}`)
  }
  return problems
}
