// Object Explorer actions: Select Top 1000 Rows, Rename, Delete and Properties, which kinds and subtypes offer each, the object
// dialogs and their pages, error codes and limits. It is the only declaration of what an action may touch: menus,
// context keys, the palette and docs/object-actions.md read it, and the backend embeds actionsCatalogJson() as
// Actions/actions-catalog.json (a vitest file snapshot keeps that copy in sync), so a stale tree cannot ask the backend
// for an action its catalogue does not offer. Erasable TypeScript (no enums), so Node's type stripping can load it too.
import { kindSpecs, nodeKinds, nodeStatuses, serverEngines, type FolderId, type NodeKind, type NodeStatus, type NodeSubtype, type ServerEngine } from '../explorer/catalog.ts'
import type { DatabaseRuntime } from '../explorer/status.ts'
import type { IconId } from '../icons.ts'
import type { ScriptDestination } from '../scripting/catalog.ts'
import { compatibilityLevels, databaseOptionDefs, ownerNotOn, scopedConfigurationDefs, type DatabaseOptionDef } from './database.ts'
import type { LongRunKind } from '../long-runs.ts'
import { loginsCatalog } from './logins.ts'

// One entry per line, so later actions and dialogs append cleanly.
export const objectActions = [
  'selectTop',
  'rename',
  'delete',
  'properties'
] as const
export type ObjectAction = typeof objectActions[number]
/** `query` opens and runs a query, `inline` edits the tree row, `dialog` opens an object dialog. */
export type ActionClass = 'query' | 'inline' | 'dialog'
export const dialogIds = [
  'deleteObject',
  'databaseProperties',
  'newDatabase'
] as const
export type DialogId = typeof dialogIds[number]
/** The menus an action can be placed in: Object Explorer's context menu and its Tasks submenus (src/shared/commands/menus.ts). */
export const actionMenus = ['explorer.context', 'explorer.tasks', 'explorer.tasks.restore'] as const
export type ActionMenuId = typeof actionMenus[number]
export interface ObjectActionSpec {
  /** The palette's title, and the menu's unless `menuTitle` is set. */
  readonly title: string
  /** The menu's title when it is shorter than the palette's (SSMS's "Disable" for "Disable Login"). */
  readonly menuTitle?: string
  readonly mnemonic: string
  /** Where the item is: Object Explorer's context menu unless it names a Tasks submenu. */
  readonly menu?: ActionMenuId
  readonly group: string
  readonly order: number
  readonly class: ActionClass
  readonly dialog?: DialogId
  readonly command: `explorer.${string}`
  /** Offered on SQL Server's own objects too (SSMS's Properties on master, model, msdb and tempdb). */
  readonly systemObjects?: boolean
  /** The servers that offer it (critic A1). On another, the menu hides the item, and the backend refuses a request for it
   *  before opening a connection (it reads this list from actions-catalog.json). */
  readonly engines: readonly ServerEngine[]
  /** How long its compensation and cleanup steps may run after a failure or Stop, in ms (default actionLimits.cleanupMs); a
   *  Stop's reply waits stopGraceMs plus this, so it never answers an unknown outcome while Varia's own cleanup runs. */
  readonly cleanupMs?: number
  /** A long job (a restore, a verify, a backup): its DDL takes the long gate (`longPerConnection`, `longTotal`) instead of the
   *  execute gate, so other actions on the connection stay available; it reports SQL Server's STATS progress as action.progress
   *  EVENTs; and a closing generation waits for it to stop and clean up (`actionDrainMs`). */
  readonly long?: boolean
}
/** Box editions and Managed Instance: Azure SQL Database reaches one database per connection and refuses USE, so its
 *  actions are a follow-up. */
const onServers: readonly ServerEngine[] = ['box', 'managedInstance']
const actionSpecData = {
  selectTop: { title: 'Select Top 1000 Rows', mnemonic: 'w', group: '1_query', order: 3, class: 'query', command: 'explorer.selectTopRows', engines: serverEngines },
  rename: { title: 'Rename', mnemonic: 'm', group: '7_edit', order: 1, class: 'inline', command: 'explorer.rename', engines: onServers },
  // SSMS underlines D, which Disconnect has in Varia's one Object Explorer menu (access keys are unique per menu).
  delete: { title: 'Delete', mnemonic: 'e', group: '7_edit', order: 2, class: 'dialog', dialog: 'deleteObject', command: 'explorer.delete', engines: onServers },
  // SSMS 22's access key for Properties is unverified; P is free in Varia's Object Explorer menu.
  properties: { title: 'Properties', mnemonic: 'p', group: '9_properties', order: 1, class: 'dialog', dialog: 'databaseProperties', command: 'explorer.properties', systemObjects: true, engines: onServers }
} as const satisfies { readonly [A in ObjectAction]: ObjectActionSpec }
export const objectActionSpecs: { readonly [A in ObjectAction]: ObjectActionSpec & { readonly command: typeof actionSpecData[A]['command'] } } = actionSpecData
/** The action commands' ids, derived from the specs, so a new action declares its command in one place. */
export type ActionCommandId = typeof actionSpecData[ObjectAction]['command']

// Server-scope actions: no object's row offers them, since what they make does not exist yet. A folder's menu and its
// nodes' menus place them, the server is their describe's target, and OK runs them with the new object's name (New
// Database; Attach and Restore Database follow in later PRs). One entry per line, so later actions append cleanly.
export const serverActions = [
  'createDatabase'
] as const
export type ServerAction = typeof serverActions[number]
/** Every action actions.execute runs from this catalogue (the table designer's createTable is the designer catalogue's). */
export type CatalogAction = ObjectAction | ServerAction
export interface ServerActionSpec {
  /** The palette's and the menu's title. */
  readonly title: string
  readonly mnemonic: string
  readonly group: string
  readonly order: number
  /** The document or dialog the command opens; its OK runs the action. */
  readonly dialog: DialogId
  readonly command: `explorer.${string}`
  /** The servers it runs on (critic A1); elsewhere the menu hides it and the backend refuses it. */
  readonly engines: readonly ServerEngine[]
  /** The folders whose menu offers it (in `group` at `order`), and the node kinds whose menu does (SSMS offers New Database on a database too). */
  readonly folders: readonly FolderId[]
  readonly kinds: readonly NodeKind[]
  /**
   * Where a node of `kinds` places it instead, when SSMS groups it with the node's own items there. The catalogue places a
   * command once per menu (macOS's native context menus show a command wherever it is placed, since main sees no target),
   * so this place is a menu-only command of its own that runs the same; the palette offers only `command`.
   */
  readonly nodePlace?: { readonly command: `explorer.${string}`; readonly group: string; readonly order: number }
  /** It registers with the long-run registry while OK runs, never with the document task. */
  readonly longRun: LongRunKind
  /** As ObjectActionSpec.cleanupMs. */
  readonly cleanupMs?: number
}
const serverActionSpecData = {
  // SSMS 22's Databases menu: New Database…, Attach…, Restore Database…, Restore Files and Filegroups…; its access key for New
  // Database is recalled as N. On a database SSMS's first group is New Database…, New Query and Script Database as (Microsoft
  // Learn's SSMS 17 and 19 screenshots), so there it joins New Query's group, first. Azure SQL Managed Instance creates
  // databases without files, so it is a follow-up.
  createDatabase: {
    title: 'New Database…', mnemonic: 'n', group: '0_new', order: 1, dialog: 'newDatabase', command: 'explorer.newDatabase', engines: ['box'], folders: ['databases'], kinds: ['database'],
    nodePlace: { command: 'explorer.newDatabaseOnDatabase', group: '1_query', order: 1 }, longRun: 'newDatabase'
  }
} as const satisfies { readonly [A in ServerAction]: ServerActionSpec }
export const serverActionSpecs: { readonly [A in ServerAction]: ServerActionSpec & { readonly command: typeof serverActionSpecData[A]['command'] } } = serverActionSpecData
type NodePlaceCommands = { readonly [A in ServerAction]: typeof serverActionSpecData[A] extends { readonly nodePlace: { readonly command: infer C } } ? C : never }[ServerAction]
export type ServerActionCommandId = typeof serverActionSpecData[ServerAction]['command'] | NodePlaceCommands
export const isServerAction = (action: string): action is ServerAction => (serverActions as readonly string[]).includes(action)
/** An action's servers, from whichever list declares it. */
export const catalogActionEngines = (action: CatalogAction): readonly ServerEngine[] => isServerAction(action) ? serverActionSpecs[action].engines : objectActionSpecs[action].engines

/** '' = not offered (hidden); 'disabled' = shown greyed, as SSMS shows Rename and Delete on system objects. */
export type ActionState = '' | 'disabled' | 'enabled'
export type ActionRow = Partial<Record<ObjectAction, 'enabled' | 'disabled'>>
/** A status's change to a row: each action it names takes that state, and '' takes the action away. */
export type ActionRowOverlay = Partial<Record<ObjectAction, ActionState>>
export interface ActionKindSpec {
  /** A node without a subtype, and subtypes `subtypes` does not list. */
  readonly row: ActionRow
  readonly subtypes?: Partial<Record<NodeSubtype, ActionRow>>
  /** Overlaid on the subtype's row for a node with that status (a disabled login offers Enable in place of Disable). */
  readonly statuses?: Partial<Record<NodeStatus, ActionRowOverlay>>
}
const all: ActionRow = { selectTop: 'enabled', rename: 'enabled', delete: 'enabled' }
const selectOnly: ActionRow = { selectTop: 'enabled', rename: 'disabled', delete: 'disabled' }
const editable: ActionRow = { rename: 'enabled', delete: 'enabled' }
const locked: ActionRow = { rename: 'disabled', delete: 'disabled' }
// Temporal, ledger, FileTable and external tables need SYSTEM_VERSIONING and ledger handling before they can be renamed
// or dropped (a follow-up); a dropped ledger table or view can be neither selected from nor changed.
export const actionKindSpecs: { readonly [K in NodeKind]?: ActionKindSpec } = {
  table: {
    row: all,
    subtypes: {
      system: selectOnly, systemVersioned: selectOnly, history: selectOnly, updatableLedger: selectOnly, appendOnlyLedger: selectOnly, ledgerHistory: selectOnly,
      fileTable: selectOnly, external: selectOnly, droppedLedger: locked
    }
  },
  view: { row: all, subtypes: { system: selectOnly, ledger: selectOnly, droppedLedger: locked } },
  procedure: { row: editable, subtypes: { system: locked, extended: locked, replicationFilter: locked } },
  // DROP AGGREGATE is a follow-up; sp_rename renames an aggregate like any object.
  function: { row: editable, subtypes: { aggregate: { rename: 'enabled', delete: 'disabled' } } },
  // Properties opens for every database, SQL Server's own included; a snapshot's opens read-only.
  database: { row: { ...editable, properties: 'enabled' }, subtypes: { system: { ...locked, properties: 'enabled' }, snapshot: { rename: 'disabled', delete: 'enabled', properties: 'enabled' } } }
}

/** A row with an overlay applied: the actions it names take its state, and '' removes them. */
export function overlayRow(row: ActionRow, overlay: ActionRowOverlay | undefined): ActionRow {
  if (!overlay) return row
  return Object.fromEntries(objectActions.flatMap(action => { const state = action in overlay ? overlay[action] : row[action]; return state ? [[action, state]] : [] })) as ActionRow
}
/**
 * The row of a kind, subtype and status, or undefined when the kind offers no actions (or the subtype is not the kind's).
 * A status the kind has no overlay for leaves the subtype's row as it is. `specs` is for tests, until a kind declares overlays.
 */
export function actionRow(kind: NodeKind, subtype?: NodeSubtype, status?: NodeStatus, specs: { readonly [K in NodeKind]?: ActionKindSpec } = actionKindSpecs): ActionRow | undefined {
  const spec = specs[kind]
  if (!spec || subtype !== undefined && !kindSpecs[kind].subtypes?.includes(subtype)) return undefined
  const row = (subtype && spec.subtypes?.[subtype]) || spec.row
  return status ? overlayRow(row, spec.statuses?.[status]) : row
}
/** The statuses a kind has overlays for, in `nodeStatuses` order. */
export const actionStatuses = (kind: NodeKind): NodeStatus[] => nodeStatuses.filter(status => actionKindSpecs[kind]?.statuses?.[status])

/** sys.databases.state by name; values SQL Server may add later are `other`. */
export const databaseStateIds = { 0: 'online', 1: 'restoring', 2: 'recovering', 3: 'recoveryPending', 4: 'suspect', 5: 'emergency', 6: 'offline', 7: 'copying', 10: 'offlineSecondary' } as const
export type DatabaseStateId = typeof databaseStateIds[keyof typeof databaseStateIds] | 'other'
export const databaseStateOf = (state: number): DatabaseStateId => (databaseStateIds as Readonly<Record<number, DatabaseStateId>>)[state] ?? 'other'
/** sys.databases.user_access by name. */
export type DatabaseAccessId = 'multi' | 'single' | 'restricted'
export const databaseAccessOf = (userAccess: number): DatabaseAccessId => userAccess === 1 ? 'single' : userAccess === 2 ? 'restricted' : 'multi'
/**
 * A rule that narrows an enabled database action by the database's runtime state. It applies when the state is one of
 * `states`, the access one of `access`, or (`readOnly`) the database is read-only or standby, and then greys the action, or
 * hides it (`hide`). The first rule that applies wins; its `reason` is why the action is unavailable.
 */
export interface DatabaseActionRule {
  readonly action: ObjectAction
  readonly states?: readonly DatabaseStateId[]
  readonly access?: readonly DatabaseAccessId[]
  readonly readOnly?: true
  readonly hide?: true
  readonly reason: string
}
/** The database rules, in order. Wave 5's database actions (Take Offline, Bring Online, Detach, Restore) add theirs here;
 *  the backend's preflight re-derives the state before any DDL runs. */
export const databaseActionRules: readonly DatabaseActionRule[] = []
const ruleApplies = (rule: DatabaseActionRule, runtime: DatabaseRuntime) =>
  !!(rule.states?.includes(databaseStateOf(runtime.state)) || rule.access?.includes(databaseAccessOf(runtime.userAccess)) || rule.readOnly && (runtime.readOnly || runtime.standby))
/**
 * A database's row narrowed by its runtime state, and why each narrowed action is unavailable. Without a runtime (the
 * state is unknown) the row stands: better a working item whose preflight refuses with the server's reason than a
 * missing one.
 */
export function databaseActionState(row: ActionRow, runtime: DatabaseRuntime | undefined, rules: readonly DatabaseActionRule[] = databaseActionRules): { readonly row: ActionRow; readonly reasons: Partial<Record<ObjectAction, string>> } {
  if (!runtime) return { row, reasons: {} }
  const narrowed: ActionRow = {}, reasons: Partial<Record<ObjectAction, string>> = {}
  for (const action of objectActions) {
    const state = row[action]
    if (!state) continue
    const rule = state === 'enabled' ? rules.find(item => item.action === action && ruleApplies(item, runtime)) : undefined
    if (rule) reasons[action] = rule.reason
    if (!rule?.hide) narrowed[action] = rule ? 'disabled' : state
  }
  return { row: narrowed, reasons }
}

/**
 * What the selection is: a folder, or an object with its subtype, its status badge, a database's runtime state, and the
 * kind of server it is on. Each fact narrows the menu only when it is known.
 */
export interface ActionTarget {
  readonly kind: NodeKind | 'folder'
  readonly subtype?: NodeSubtype
  readonly status?: NodeStatus
  readonly database?: DatabaseRuntime
  readonly engine?: ServerEngine
}
const noActions = Object.freeze(Object.fromEntries(objectActions.map(action => [action, '']))) as Readonly<Record<ObjectAction, ActionState>>
/** Whether an action with these `engines` is offered on a server of `engine`; an unknown engine offers it. */
export const offeredOnEngine = (engines: readonly ServerEngine[] | undefined, engine: ServerEngine | undefined): boolean => !engine || !engines || engines.includes(engine)
/** What `actionMenuState` reads, for tests until the catalogue declares engines, overlays and database rules. */
export interface ActionMenuSources {
  readonly kinds?: { readonly [K in NodeKind]?: ActionKindSpec }
  readonly actions?: { readonly [A in ObjectAction]?: Pick<ObjectActionSpec, 'engines'> }
  readonly rules?: readonly DatabaseActionRule[]
}
/**
 * Each action's state for a node: 'enabled', 'disabled' (greyed) or '' (not offered). The kind's row with its status
 * overlay, narrowed for a database by its runtime state, then hidden on a server whose engine the action does not serve.
 */
export function actionMenuState(target: ActionTarget | undefined, sources: ActionMenuSources = {}): Readonly<Record<ObjectAction, ActionState>> {
  if (!target || target.kind === 'folder') return noActions
  const status = target.status && (nodeStatuses as readonly string[]).includes(target.status) ? target.status : undefined
  const listed = actionRow(target.kind, target.subtype, status, sources.kinds)
  if (!listed) return noActions
  const row = target.kind === 'database' ? databaseActionState(listed, target.database, sources.rules).row : listed
  const specs: { readonly [A in ObjectAction]?: Pick<ObjectActionSpec, 'engines'> } = sources.actions ?? objectActionSpecs
  return Object.fromEntries(objectActions.map(action => [action, offeredOnEngine(specs[action]?.engines, target.engine) ? row[action] ?? '' : ''])) as Record<ObjectAction, ActionState>
}
/** Whether some row of the kind enables the action: what main checks before the backend re-derives the subtype. */
export function actionOffered(kind: NodeKind, action: ObjectAction): boolean {
  const statuses = [undefined, ...actionStatuses(kind)]
  return [undefined, ...kindSpecs[kind].subtypes ?? []].some(subtype => statuses.some(status => actionRow(kind, subtype, status)?.[action] === 'enabled'))
}

const pascal = <S extends string>(text: S) => (text.charAt(0).toUpperCase() + text.slice(1)) as Capitalize<S>
export type ActionContextKey = `explorerAction${Capitalize<ObjectAction>}`
export const actionContextKey = (action: ObjectAction): ActionContextKey => `explorerAction${pascal(action)}`
export type ActionContextValues = { readonly [K in ActionContextKey]: ActionState }
/** The state context keys a selection publishes: `explorerAction<Action>`. */
export const actionContextValues = (state: Readonly<Record<ObjectAction, ActionState>>): ActionContextValues =>
  Object.fromEntries(objectActions.map(action => [actionContextKey(action), state[action]])) as ActionContextValues

/** Keys only while Object Explorer has focus and no text field does (the inline rename box, a filter field). */
export const explorerKeyWhen = "activePanel == 'explorer' && !textInputFocus"
export interface ActionKeybinding { readonly key?: string; readonly win?: string; readonly linux?: string; readonly mac?: string; readonly when: string }
/** Where an action command appears, in the shape of `MenuPlacement`. */
export interface ActionMenuPlacement {
  readonly menu: ActionMenuId
  readonly group: string
  readonly order: number
  /** The menu's title when it differs from the palette's. */
  readonly title?: string
  readonly mnemonic: string
  readonly when: string
}
/** A command catalogue entry, in the shape of `CommandDescriptor`. */
export interface ActionCommandEntry {
  readonly title: string
  readonly category: 'Object Explorer'
  readonly icon: IconId
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly titleSetting?: { readonly setting: 'objectExplorer.selectTopRows'; readonly template: string }
  readonly keybindings?: readonly ActionKeybinding[]
  readonly menus: readonly [ActionMenuPlacement, ...ActionMenuPlacement[]]
  /** Only a server action's menu-only command for its node place (ServerActionSpec.nodePlace) sets it. */
  readonly palette?: false
}
const commandData: { readonly [A in ObjectAction]: Omit<ActionCommandEntry, 'title' | 'category' | 'precondition' | 'menus'> & { readonly documentTask: boolean } } = {
  selectTop: {
    icon: 'table', keywords: ['select', 'rows', 'query', 'view'], documentTask: true, unavailableHint: 'Select a table or view in Object Explorer.',
    titleSetting: { setting: 'objectExplorer.selectTopRows', template: 'Select Top {n} Rows' }
  },
  rename: { icon: 'edit', keywords: ['name'], documentTask: false, unavailableHint: 'Select a table, view, stored procedure, function, or user database.', keybindings: [{ key: 'f2', when: explorerKeyWhen }] },
  // ⌘⌫ deletes in macOS's Finder; the forward Delete key works there too.
  delete: {
    icon: 'close', keywords: ['drop', 'remove'], documentTask: false, unavailableHint: 'Select a table, view, stored procedure, function, user database, or database snapshot.',
    keybindings: [{ win: 'delete', linux: 'delete', mac: 'mod+backspace', when: explorerKeyWhen }, { mac: 'delete', when: explorerKeyWhen }]
  },
  // ⌘I is Finder's Get Info. Alt+Enter is reserved on Windows and Linux, and SSMS 22's binding is unverified, so there is no key there.
  properties: {
    icon: 'settings-gear', keywords: ['options', 'files', 'filegroups', 'recovery', 'compatibility', 'collation', 'settings'], documentTask: false,
    unavailableHint: 'Select a database in Object Explorer.', keybindings: [{ mac: 'meta+i', when: explorerKeyWhen }]
  }
}
/**
 * The action commands, keyed by their command ids (explorer.selectTopRows keeps PR4's id). A long-running action (a
 * restore, New Database) never sets `documentTask`: it registers with the renderer's long-run registry, so closing the
 * window is refused with a message instead of waiting on it.
 */
export function actionCommandEntries(): { readonly [K in ActionCommandId]: ActionCommandEntry } {
  return Object.fromEntries(objectActions.map(action => {
    const spec: ObjectActionSpec = objectActionSpecs[action], { documentTask, ...data } = commandData[action], key = actionContextKey(action)
    const placement: ActionMenuPlacement = {
      menu: spec.menu ?? 'explorer.context', group: spec.group, order: spec.order, ...spec.menuTitle ? { title: spec.menuTitle } : {}, mnemonic: spec.mnemonic,
      // The keys describe the selection, which a node's menu has just selected; the empty area's menu keeps it, so it opts out.
      when: `${key} != '' && explorerNode != 'background'`
    }
    const entry: ActionCommandEntry = {
      title: spec.title, category: 'Object Explorer', ...data,
      precondition: `backendReady && ${key} == 'enabled'` + (documentTask ? ' && !documentBusy' : ''),
      menus: [placement]
    }
    return [spec.command, entry]
  })) as { readonly [K in ActionCommandId]: ActionCommandEntry }
}

const anyOf = (clauses: readonly string[]) => clauses.length === 1 ? clauses[0] : `(${clauses.join(' || ')})`
const serverCommandData: { readonly [A in ServerAction]: Pick<ActionCommandEntry, 'icon' | 'keywords' | 'unavailableHint'> } = {
  createDatabase: { icon: 'database', keywords: ['create', 'database', 'add', 'files'], unavailableHint: 'Select the Databases folder, or a database, of a SQL Server in Object Explorer.' }
}
/**
 * The server actions' commands. The menu offers one on its folders and node kinds, on a server it serves that is not lost;
 * the palette, on a selection of the same kind. Like a long-running object action, none holds the document task. An action
 * with a node place has a second, menu-only command for it, with the same title, precondition and handler.
 */
export function serverActionCommandEntries(): { readonly [K in ServerActionCommandId]: ActionCommandEntry } {
  return Object.fromEntries(serverActions.flatMap(action => {
    const spec: ServerActionSpec = serverActionSpecs[action], { nodePlace } = spec
    const engines = (key: string) => anyOf(spec.engines.map(engine => `${key} == '${engine}'`))
    const folderPlaces = spec.folders.map(folder => `explorerNode == 'folder' && explorerFolder == '${folder}'`), kindPlaces = spec.kinds.map(kind => `explorerNode == '${kind}'`)
    const selectionPlaces = anyOf([...spec.folders.map(folder => `explorerSelectionFolder == '${folder}'`), ...spec.kinds.map(kind => `explorerSelectionKind == '${kind}'`)])
    const entry = (group: string, order: number, places: readonly string[]): ActionCommandEntry => ({
      title: spec.title, category: 'Object Explorer', ...serverCommandData[action],
      precondition: `backendReady && ${selectionPlaces} && ${engines('explorerSelectionServerEngine')}`,
      menus: [{ menu: 'explorer.context', group, order, mnemonic: spec.mnemonic, when: `${anyOf(places)} && !explorerServerLost && ${engines('explorerServerEngine')}` }]
    })
    if (!nodePlace) return [[spec.command, entry(spec.group, spec.order, [...folderPlaces, ...kindPlaces])]]
    return [[spec.command, entry(spec.group, spec.order, folderPlaces)], [nodePlace.command, { ...entry(nodePlace.group, nodePlace.order, kindPlaces), palette: false }]]
  })) as { readonly [K in ServerActionCommandId]: ActionCommandEntry }
}

/** The New Database document's header verbs: catalogue commands, so the palette offers them too. */
export type NewDatabaseCommandId = 'newDatabase.ok' | 'newDatabase.cancel' | 'newDatabase.stop'
export interface NewDatabaseCommandEntry {
  readonly title: string
  readonly category: 'New Database'
  readonly icon: 'check' | 'close' | 'debug-stop'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
}
/**
 * OK creates the database and closes the document; Cancel closes it; Stop cancels a running OK in SQL Server. The header
 * shows SSMS's OK and Cancel, while the palette's titles say what they do: a bare "Cancel", the shorter label, would rank
 * above Cancel Executing Query wherever both are unavailable.
 */
export function newDatabaseCommandEntries(): { readonly [K in NewDatabaseCommandId]: NewDatabaseCommandEntry } {
  return {
    'newDatabase.ok': {
      title: 'Create Database', category: 'New Database', icon: 'check', keywords: ['ok', 'create', 'new', 'database'],
      precondition: 'activeDocumentIsNewDatabase && newDatabaseCreatable', unavailableHint: 'Fill in the New Database document on a connected server first.'
    },
    'newDatabase.cancel': {
      title: 'Cancel New Database', category: 'New Database', icon: 'close', keywords: ['close', 'discard'],
      precondition: 'activeDocumentIsNewDatabase && !newDatabaseCreating', unavailableHint: 'Stop the database being created first.'
    },
    'newDatabase.stop': {
      title: 'Stop', category: 'New Database', icon: 'debug-stop', keywords: ['cancel', 'create'],
      precondition: 'activeDocumentIsNewDatabase && newDatabaseCreating', unavailableHint: 'The database is not being created.'
    }
  }
}

/** The Database Properties document's header verbs: catalogue commands, so the palette offers them too. */
export type PropertiesCommandId = 'databaseProperties.apply' | 'databaseProperties.discard' | 'databaseProperties.refresh' | 'databaseProperties.stop'
export interface PropertiesCommandEntry {
  readonly title: string
  readonly category: 'Database Properties'
  readonly icon: 'check' | 'discard' | 'refresh' | 'debug-stop'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
}
/**
 * Apply is SSMS's OK without closing: the document stays open and reads the database again. File › Save (Ctrl+S) and
 * the close prompt's Save apply too, as a document's save does. Stop has no documentBusy, so it works while the close
 * prompt's Save holds the document task.
 */
export function propertiesCommandEntries(): { readonly [K in PropertiesCommandId]: PropertiesCommandEntry } {
  return {
    'databaseProperties.apply': {
      title: 'Apply Changes', category: 'Database Properties', icon: 'check', keywords: ['ok', 'save', 'alter', 'database', 'options'],
      precondition: 'activeDocumentIsProperties && propertiesApplicable', unavailableHint: 'Change a database property first.'
    },
    'databaseProperties.discard': {
      title: 'Discard Changes', category: 'Database Properties', icon: 'discard', keywords: ['revert', 'undo', 'cancel'],
      precondition: 'activeDocumentIsProperties && propertiesChanged && !propertiesApplying', unavailableHint: 'There are no changes to discard.'
    },
    'databaseProperties.refresh': {
      title: 'Refresh', category: 'Database Properties', icon: 'refresh', keywords: ['reload', 'read'],
      precondition: 'activeDocumentIsProperties && propertiesRefreshable', unavailableHint: 'Apply or discard the changes first, on a connected server.'
    },
    'databaseProperties.stop': {
      title: 'Stop', category: 'Database Properties', icon: 'debug-stop', keywords: ['cancel', 'apply'],
      precondition: 'activeDocumentIsProperties && propertiesApplying', unavailableHint: 'The changes are not being applied.'
    }
  }
}

// One page id per line, so later dialogs append cleanly.
export const pageIds = [
  'general',
  'files',
  'filegroups',
  'options'
] as const
export type PageId = typeof pageIds[number]
export interface DialogPageSpec {
  readonly id: PageId
  readonly title: string
  /** The icon beside the title in the page list. */
  readonly icon: IconId
  /**
   * The page stays mounted, hidden, while another is shown, so what it holds outside the draft (a password field, a grid
   * cell being edited, its scroll position) survives a page switch. Other pages mount when shown.
   */
  readonly keepMounted?: true
}
/**
 * Where a dialog opens: 'modal' over the workbench (Delete Object, a confirmation), or 'document', a non-modal tab whose
 * pages are sections in one scrolling column (Database Properties), as U1 D2 asks instead of SSMS's "Select a page".
 */
export type DialogSurface = 'modal' | 'document'
export interface DialogSpec {
  readonly title: string
  readonly surface: DialogSurface
  /** 'withName': SSMS's "Database Properties - AppData". */
  readonly titleFormat: 'plain' | 'withName'
  readonly size: 'compact' | 'large'
  /** The action OK runs and Script scripts; its catalogue row (or, for a server action, its folders) decides where the dialog opens. */
  readonly action: CatalogAction
  readonly pages: readonly DialogPageSpec[]
  /** A modal dialog whose run has several steps lists them under its message bar once the run reports them. */
  readonly steps?: true
}
const page = (id: PageId, title: string, options: { readonly icon?: IconId; readonly keepMounted?: true } = {}): DialogPageSpec =>
  ({ id, title, icon: options.icon ?? 'settings-gear', ...options.keepMounted ? { keepMounted: true } : {} })
/** SSMS's dialogs. A modal one has a "Select a page" list, Connection and Progress boxes, a Script button, and OK and
 *  Cancel; a document has its pages as sections, a Script drawer, and Apply (DatabasePropertiesService). SSMS's
 *  later Database Properties pages (Change Tracking, Permissions, Extended Properties, Mirroring, Transaction Log
 *  Shipping, Query Store) are listed once they exist. */
const dialogSpecData = {
  deleteObject: { title: 'Delete Object', surface: 'modal', titleFormat: 'plain', size: 'compact', action: 'delete', pages: [page('general', 'General')] },
  databaseProperties: {
    title: 'Database Properties', surface: 'document', titleFormat: 'withName', size: 'large', action: 'properties',
    pages: [page('general', 'General'), page('files', 'Files'), page('filegroups', 'Filegroups'), page('options', 'Options')]
  },
  // SSMS's New Database pages: General (the name, the owner and the files), Options and Filegroups.
  newDatabase: {
    title: 'New Database', surface: 'document', titleFormat: 'plain', size: 'large', action: 'createDatabase',
    pages: [page('general', 'General'), page('options', 'Options'), page('filegroups', 'Filegroups')]
  }
} as const satisfies { readonly [D in DialogId]: DialogSpec }
export const dialogSpecs: { readonly [D in DialogId]: DialogSpec } = dialogSpecData
/** The dialogs that open over the workbench (ObjectDialogService), derived from their surface; the others are documents. */
export type ModalDialogId = { readonly [D in DialogId]: typeof dialogSpecData[D]['surface'] extends 'modal' ? D : never }[DialogId]
export type DocumentDialogId = Exclude<DialogId, ModalDialogId>
export const isModalDialog = (dialog: DialogId): dialog is ModalDialogId => dialogSpecs[dialog].surface === 'modal'
/** A dialog's title bar: its title, and for 'withName' dialogs the object as Object Explorer shows it. */
export const dialogTitle = (dialog: DialogId, label: string): string => dialogSpecs[dialog].titleFormat === 'withName' ? `${dialogSpecs[dialog].title} - ${label}` : dialogSpecs[dialog].title
/** The Script button's destinations, as SSMS words them; delivery is Script As's (deliverScript). */
export const scriptActionTitles: { readonly [D in ScriptDestination]: string } = {
  newQuery: 'Script Action to New Query Window', file: 'Script Action to File', clipboard: 'Script Action to Clipboard'
}

/**
 * The server file picker (SSMS's Locate Backup File, Locate Database Files and Locate Folder): `actions.describe` with this
 * id, the server as the target and a `files` member lists the server's drives and default folders, or one folder. Paths
 * are the server's, never the client's, and the listing's type filter runs in the backend over constant SQL.
 */
export const serverFilesDescribeId = 'serverFiles'
export const serverFilePurposes = ['backup', 'database', 'log', 'folder'] as const
export type ServerFilePurpose = typeof serverFilePurposes[number]
export interface ServerFilePurposeSpec {
  /** The picker's title, before " - <server>" (SSMS's, recalled). */
  readonly title: string
  /** Files of type's first entry, with the extensions in brackets; a folder picker lists folders only. */
  readonly types?: string
  /** Lower-case extensions, dot included, that the type filter keeps (at most two: the listing's SQL binds @e1 and @e2). */
  readonly extensions: readonly string[]
}
export const serverFilePurposeSpecs: { readonly [P in ServerFilePurpose]: ServerFilePurposeSpec } = {
  backup: { title: 'Locate Backup File', types: 'Backup Files', extensions: ['.bak', '.trn'] },
  database: { title: 'Locate Database Files', types: 'Database Data Files', extensions: ['.mdf'] },
  log: { title: 'Locate Database Files', types: 'Database Log Files', extensions: ['.ldf'] },
  folder: { title: 'Locate Folder', extensions: [] }
}
/** Files of type's second entry, which lists every file. */
export const allFilesType = 'All Files(*.*)'
/** Files of type's entry for a purpose, as SSMS words it: "Backup Files(*.bak;*.trn)". */
export const serverFileTypesLabel = (purpose: ServerFilePurpose): string | undefined => {
  const spec = serverFilePurposeSpecs[purpose]
  return spec.types && `${spec.types}(${spec.extensions.map(extension => '*' + extension).join(';')})`
}

/** Why an action failed, as a value; `retryable` says whether trying again can help. */
export const actionErrorRetryable = {
  NOT_FOUND: false, NOT_SUPPORTED: false, PERMISSION_DENIED: true, IN_USE: true, BLOCKED: true, DEPENDENTS: false, NAME_IN_USE: false,
  // The server file picker's folder does not exist, or the server's account cannot see it.
  PATH_NOT_FOUND: false,
  DATABASE_UNAVAILABLE: true, TIMEOUT: true, CONNECTION_LOST: true, SQL_ERROR: true,
  // Stop cancelled the statement in SQL Server; the steps say what completed before it.
  CANCELLED: true,
  // Off Windows, the action's connection could not sign in with Kerberos (run kinit, then retry).
  AUTH_KERBEROS: true, AUTH_UNSUPPORTED: true,
  // The action's connection could not get a Microsoft Entra token: a sign-in that expired (connect again) or a failure
  // that may pass.
  AUTH_ENTRA: true
} as const satisfies Record<string, boolean>
export type ActionErrorCode = keyof typeof actionErrorRetryable
export const actionErrorCodes = Object.keys(actionErrorRetryable) as ActionErrorCode[]

/** Bounds of the action path. DDL itself has no lock timeout (SSMS waits too), but Stop always ends it. */
export const actionLimits = {
  describeMs: 40_000, scriptMs: 25_000, readLockTimeoutMs: 10_000, gateWaitMs: 30_000,
  readPerConnection: 2, readTotal: 4, executePerConnection: 1, executeTotal: 2,
  registered: 128, cancelIds: 16, tombstones: 64, tombstoneMs: 60_000,
  dependents: 100, messageChars: 2_048, infoMessages: 32, infoMessageChars: 512, newName: 128,
  /** Equal to main's maxScriptCharacters, so a script sent to a new query window can always run there. */
  scriptChars: 1_000_000,
  /** Database Properties: rows the describe lists (more set a truncation flag), choices it offers, and statements one request may plan. */
  files: 1_024, filegroups: 256, logins: 1_024, collations: 8_192, statements: 512,
  /** How long a stopped action's reply waits for SQL Server to end the statement, then answers CANCELLED (outcome unknown). */
  stopGraceMs: 10_000,
  /** When a running rename appears in the status bar, with Stop. */
  statusDelayMs: 300,
  /** The server file picker: UTF-16 units in a server path (sys.master_files.physical_name is nvarchar(260)), entries one folder
   *  lists (one more is read to set `truncated`), the backend's budget for one listing in ms (main's deadline is 15 s), and
   *  listings at once per server under a gate of their own: SQL Server ends a listing of an unreachable share only once the
   *  file system answers, so it must not hold a gate that Database Properties or Delete Object waits for. */
  serverPath: 260, browseEntries: 2_000, browseMs: 10_000, browsePerConnection: 1,
  /** The default budget of an action's compensation and cleanup steps (ObjectActionSpec.cleanupMs). */
  cleanupMs: 10_000,
  /** A long step's progress (SQL Server's 3211 STATS messages): EVENTs at most this often, pushed to the page at most this many a second. */
  progressEventMs: 250, progressPerSecond: 4,
  /** The long-job gate, per Varia connection and in all (critic A26): long actions take it instead of the execute gate. */
  longPerConnection: 1, longTotal: 2,
  /** What a closing generation's grace adds to a long action's own Stop wait (stopGraceMs plus its cleanup budget). */
  drainMarginMs: 5_000,
  /** New Database: files and filegroups one design holds, sizes in MB (a data file up to 16 TB, a log file and a growth up to
   *  2 TB, as SQL Server bounds them), and a growth in percent. */
  newDatabaseFiles: 256, newDatabaseFilegroups: 256, dataFileMb: 16_777_215, logFileMb: 2_097_152, growthMb: 2_097_152, growthPercent: 100
} as const

/** Whether an action runs on a server of this engine. */
export const actionServes = (action: CatalogAction, engine: ServerEngine): boolean => catalogActionEngines(action).includes(engine)

/** How long main lets a closing generation run while this action executes (methodPolicies' drainMs): for a long action, the
 *  backend's own wait for it (stopGraceMs, then its cleanup budget) plus a margin; 0 (main's usual grace) for the others. */
export function actionDrainMs(action: string, specs: { readonly [A in ObjectAction]: Pick<ObjectActionSpec, 'long' | 'cleanupMs'> } = objectActionSpecs): number {
  // actions.execute also carries the Table Designer's createTable, which is not a menu action and never long.
  const spec = Object.hasOwn(specs, action) ? specs[action as ObjectAction] : undefined
  return spec?.long ? actionLimits.stopGraceMs + (spec.cleanupMs ?? actionLimits.cleanupMs) + actionLimits.drainMarginMs : 0
}

/** What a renderer says when the backend stopped (or its connection broke) while DDL ran: the outcome is unknown. */
export const unknownOutcomeMessage = 'The SQL backend stopped while the action ran, so whether it completed is unknown. Refresh Object Explorer to check.'

// Compact sorted-key JSON, as in scriptingCatalogJson(), so each entry diffs as one line.
const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortKeys(item)]))
  : value
const line = (value: unknown) => JSON.stringify(sortKeys(value))
const block = (items: readonly unknown[]) => '[\n' + items.map(item => '    ' + line(item)).join(',\n') + '\n  ]'
const byState = (row: ActionRow, state: 'enabled' | 'disabled') => objectActions.filter(action => row[action] === state)
/** What C# needs of an option: its key, the tokens it accepts, how it is written, and where SQL Server refuses it. */
const optionJson = (def: DatabaseOptionDef) => ({
  key: def.key, label: def.label, control: def.control, settable: def.settable, tokens: def.choices?.map(choice => choice.token), range: def.range, since: def.since, notOn: def.notOn,
  exclusive: def.exclusive, refusedReadOnly: def.refusedReadOnly, sql: def.sql, smoOrder: def.smoOrder
})

/**
 * The catalogue as the backend embeds it, keys sorted and everything resolved, so C# needs no rules of its own: `rows`
 * has one row per kind with actions and each of its subtypes ('' for none), then one per subtype and status the kind has an
 * overlay for (with `status`). An action with `engines` lists them.
 */
export function actionsCatalogJson(): string {
  const rows = nodeKinds.flatMap(kind => actionKindSpecs[kind]
    ? [undefined, ...actionStatuses(kind)].flatMap(status => [undefined, ...kindSpecs[kind].subtypes ?? []].map(subtype => {
      const row = actionRow(kind, subtype, status)!
      return { kind, subtype: subtype ?? '', status, enabled: byState(row, 'enabled'), disabled: byState(row, 'disabled') }
    }))
    : [])
  const actionJson = (action: ObjectAction) => {
    const spec: ObjectActionSpec = objectActionSpecs[action]
    return { action, class: spec.class, title: spec.title, systemObjects: spec.systemObjects, engines: spec.engines, cleanupMs: spec.cleanupMs ?? actionLimits.cleanupMs, long: spec.long }
  }
  // A server action belongs to no row: `scope` says so, and C# validates its target itself.
  const serverActionJson = (action: ServerAction) => {
    const spec: ServerActionSpec = serverActionSpecs[action]
    return { action, class: 'dialog', title: spec.title, engines: spec.engines, cleanupMs: spec.cleanupMs ?? actionLimits.cleanupMs, scope: 'server' }
  }
  return [
    '{',
    `  "actions": ${block([...objectActions.map(actionJson), ...serverActions.map(serverActionJson)])},`,
    `  "compatibilityLevels": ${line(compatibilityLevels)},`,
    `  "databaseOptions": ${block(databaseOptionDefs.map(optionJson))},`,
    `  "dialogs": ${block(dialogIds.map(dialog => ({ dialog, action: dialogSpecs[dialog].action, pages: dialogSpecs[dialog].pages.map(page => page.id) })))},`,
    `  "errors": ${block(actionErrorCodes.map(code => ({ code, retryable: actionErrorRetryable[code] })))},`,
    `  "limits": ${line(actionLimits)},`,
    `  "logins": ${line(loginsCatalog())},`,
    `  "ownerNotOn": ${line(ownerNotOn)},`,
    `  "rows": ${block(rows)},`,
    `  "scopedConfigurations": ${block(scopedConfigurationDefs.map(optionJson))},`,
    `  "serverFiles": ${block(serverFilePurposes.map(purpose => ({ purpose, extensions: serverFilePurposeSpecs[purpose].extensions })))},`,
    '  "version": 3',
    '}',
    ''
  ].join('\n')
}
