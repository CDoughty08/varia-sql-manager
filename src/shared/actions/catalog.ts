// Object Explorer actions: Select Top 1000 Rows, Rename, Delete, Properties, Restore Database and Restore Files and Filegroups, which kinds, subtypes and folders offer each, the object
// dialogs and their pages, error codes and limits. It is the only declaration of what an action may touch: menus,
// context keys, the palette and docs/object-actions.md read it, and the backend embeds actionsCatalogJson() as
// Actions/actions-catalog.json (a vitest file snapshot keeps that copy in sync), so a stale tree cannot ask the backend
// for an action its catalogue does not offer. Erasable TypeScript (no enums), so Node's type stripping can load it too.
import { kindSpecs, nodeKinds, nodeStatuses, serverEngines, type FolderId, type NodeKind, type NodeStatus, type NodeSubtype, type ServerEngine } from '../explorer/catalog.ts'
import type { DatabaseRuntime } from '../explorer/status.ts'
import type { IconId } from '../icons.ts'
import type { ScriptDestination } from '../scripting/catalog.ts'
import { compatibilityLevels, databaseOptionDefs, ownerNotOn, scopedConfigurationDefs, type DatabaseOptionDef } from './database.ts'
import { loginsCatalog } from './logins.ts'
import { restoreCatalog, restoreMessages } from './restore.ts'

// One entry per line, so later actions and dialogs append cleanly.
export const objectActions = [
  'selectTop',
  'rename',
  'delete',
  'properties',
  'restore',
  'restoreFiles'
] as const
export type ObjectAction = typeof objectActions[number]
/** `query` opens and runs a query, `inline` edits the tree row, `dialog` opens an object dialog. */
export type ActionClass = 'query' | 'inline' | 'dialog'
export const dialogIds = [
  'deleteObject',
  'databaseProperties'
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
  /** Offered on this Object Explorer folder (SSMS's Databases › Restore Database…): the placement above is the folder's context
   *  menu, and the action opens on the folder's server. Rows offer it only where `rows` places it and their kind's row enables it. */
  readonly folder?: FolderId
  /** With `folder`, its placement on the rows whose kind offers it too (SSMS's database Tasks › Restore › Database…), as a command of
   *  its own that the palette leaves out: one context menu shows each command once (macOS's native menus answer by id). */
  readonly rows?: { readonly command: `explorer.${string}`; readonly menu: ActionMenuId; readonly title: string; readonly group: string; readonly order: number; readonly mnemonic: string }
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
  selectTop: { title: 'Select Top 1000 Rows', mnemonic: 'w', group: '1_query', order: 2, class: 'query', command: 'explorer.selectTopRows', engines: serverEngines },
  rename: { title: 'Rename', mnemonic: 'm', group: '7_edit', order: 1, class: 'inline', command: 'explorer.rename', engines: onServers },
  // SSMS underlines D, which Disconnect has in Varia's one Object Explorer menu (access keys are unique per menu).
  delete: { title: 'Delete', mnemonic: 'e', group: '7_edit', order: 2, class: 'dialog', dialog: 'deleteObject', command: 'explorer.delete', engines: onServers },
  // SSMS 22's access key for Properties is unverified; P is free in Varia's Object Explorer menu.
  properties: { title: 'Properties', mnemonic: 'p', group: '9_properties', order: 1, class: 'dialog', dialog: 'databaseProperties', command: 'explorer.properties', systemObjects: true, engines: onServers },
  // SSMS: right-click Databases › Restore Database… (R), and a database's Tasks › Restore › Database… (D), both recalled. A document
  // (src/renderer/src/restore), not an object dialog. Box editions only: Managed Instance restores from URL only. Its cleanup drops a
  // partly restored database this request created, which a large one can take a while to do.
  restore: {
    title: 'Restore Database…', mnemonic: 'r', group: '0_new', order: 3, class: 'dialog', command: 'explorer.restoreDatabase', folder: 'databases',
    rows: { command: 'explorer.tasks.restoreDatabase', menu: 'explorer.tasks.restore', title: 'Database…', group: '1_restore', order: 1, mnemonic: 'd' }, engines: ['box'], cleanupMs: 30_000, long: true
  },
  // SSMS: right-click Databases › Restore Files and Filegroups… (E, recalled), and a database's Tasks › Restore › Files and Filegroups… (F;
  // Learn documents this one). The same document in its files mode. It never drops a database, so it has no cleanup of its own.
  restoreFiles: {
    title: 'Restore Files and Filegroups…', mnemonic: 'e', group: '0_new', order: 4, class: 'dialog', command: 'explorer.restoreFiles', folder: 'databases',
    rows: { command: 'explorer.tasks.restoreFiles', menu: 'explorer.tasks.restore', title: 'Files and Filegroups…', group: '1_restore', order: 2, mnemonic: 'f' }, engines: ['box'], long: true
  }
} as const satisfies { readonly [A in ObjectAction]: ObjectActionSpec }
export const objectActionSpecs: { readonly [A in ObjectAction]: ObjectActionSpec & { readonly command: typeof actionSpecData[A]['command'] } } = actionSpecData
type RowCommandOf<S> = S extends { readonly rows: { readonly command: infer C } } ? C : never
/** The action commands' ids, derived from the specs, so a new action declares its commands in one place. */
export type ActionCommandId = typeof actionSpecData[ObjectAction]['command'] | RowCommandOf<typeof actionSpecData[ObjectAction]>

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
  // Restoring SQL Server's own databases, or their files, is greyed in wave 5 (critic A19, restoreMessages.systemDatabase); a snapshot cannot be restored over.
  database: {
    row: { ...editable, properties: 'enabled', restore: 'enabled', restoreFiles: 'enabled' },
    subtypes: { system: { ...locked, properties: 'enabled', restore: 'disabled', restoreFiles: 'disabled' }, snapshot: { rename: 'disabled', delete: 'enabled', properties: 'enabled' } }
  }
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
  /** A folder's id: the folder actions (`ObjectActionSpec.folder`) are offered on it. */
  readonly folder?: FolderId
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
  readonly actions?: { readonly [A in ObjectAction]?: Pick<ObjectActionSpec, 'engines' | 'folder' | 'rows'> }
  readonly rules?: readonly DatabaseActionRule[]
}
/**
 * Each action's state for a node: 'enabled', 'disabled' (greyed) or '' (not offered). The kind's row with its status
 * overlay, narrowed for a database by its runtime state, then hidden on a server whose engine the action does not serve.
 * A folder offers the actions declared on it (`ObjectActionSpec.folder`), on the engines they serve; a row offers a folder's
 * action only where the action places it on rows (`rows`).
 */
export function actionMenuState(target: ActionTarget | undefined, sources: ActionMenuSources = {}): Readonly<Record<ObjectAction, ActionState>> {
  if (!target) return noActions
  const specs: { readonly [A in ObjectAction]?: Pick<ObjectActionSpec, 'engines' | 'folder' | 'rows'> } = sources.actions ?? objectActionSpecs
  if (target.kind === 'folder') {
    if (!target.folder || !objectActions.some(action => specs[action]?.folder === target.folder)) return noActions
    return Object.fromEntries(objectActions.map(action => [action, specs[action]?.folder === target.folder && offeredOnEngine(specs[action]?.engines, target.engine) ? 'enabled' : ''])) as Record<ObjectAction, ActionState>
  }
  const status = target.status && (nodeStatuses as readonly string[]).includes(target.status) ? target.status : undefined
  const listed = actionRow(target.kind, target.subtype, status, sources.kinds)
  if (!listed) return noActions
  const row = target.kind === 'database' ? databaseActionState(listed, target.database, sources.rules).row : listed
  const onRows = (action: ObjectAction) => specs[action]?.folder === undefined || specs[action]?.rows !== undefined
  return Object.fromEntries(objectActions.map(action => [action, onRows(action) && offeredOnEngine(specs[action]?.engines, target.engine) ? row[action] ?? '' : ''])) as Record<ObjectAction, ActionState>
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
  /** A row placement's own command (`rows`): the palette offers the action once, through its main command. */
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
  },
  // No key, as in SSMS. A restore is a long run (LongRunService), never a document task.
  restore: {
    icon: 'history', keywords: ['backup', 'recover', 'recovery', 'bak', 'tail', 'log'], documentTask: false,
    unavailableHint: `Select the Databases folder or a user database on SQL Server. ${restoreMessages.systemDatabase}`
  },
  restoreFiles: {
    icon: 'history', keywords: ['backup', 'recover', 'file', 'filegroup', 'piecemeal', 'online'], documentTask: false,
    unavailableHint: `Select the Databases folder or a user database on SQL Server. ${restoreMessages.systemDatabase}`
  }
}
/**
 * The action commands, keyed by their command ids (explorer.selectTopRows keeps PR4's id). A long-running action (a
 * restore, New Database) never sets `documentTask`: it registers with the renderer's long-run registry, so closing the
 * window is refused with a message instead of waiting on it.
 */
export function actionCommandEntries(): { readonly [K in ActionCommandId]: ActionCommandEntry } {
  return Object.fromEntries(objectActions.flatMap(action => {
    const spec: ObjectActionSpec = objectActionSpecs[action], { documentTask, ...data } = commandData[action], key = actionContextKey(action)
    // The keys describe the selection, which a node's menu has just selected; the empty area's menu keeps it, so it opts out. A
    // folder's action places itself on its folder, and on rows only through `rows`, so each placement names the nodes it is for.
    const placement: ActionMenuPlacement = {
      menu: spec.menu ?? 'explorer.context', group: spec.group, order: spec.order, ...spec.menuTitle ? { title: spec.menuTitle } : {}, mnemonic: spec.mnemonic,
      when: spec.folder ? `${key} != '' && explorerNode == 'folder'` : `${key} != '' && explorerNode != 'background'`
    }
    const precondition = `backendReady && ${key} == 'enabled'` + (documentTask ? ' && !documentBusy' : '')
    const entry: ActionCommandEntry = { title: spec.title, category: 'Object Explorer', ...data, precondition, menus: [placement] }
    if (!spec.rows) return [[spec.command, entry]]
    const { command, ...rows } = spec.rows
    const row: ActionCommandEntry = { ...entry, palette: false, menus: [{ ...rows, when: `${key} != '' && explorerNode != 'folder' && explorerNode != 'background'` }] }
    return [[spec.command, entry], [command, row]]
  })) as { readonly [K in ActionCommandId]: ActionCommandEntry }
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

/** The Restore Database document's header verbs (D1f): catalogue commands, so the palette offers them too. */
export type RestoreCommandId = 'restoreDatabase.run' | 'restoreDatabase.stop' | 'restoreDatabase.refresh'
export interface RestoreCommandEntry {
  readonly title: string
  readonly category: 'Restore Database'
  readonly icon: 'history' | 'debug-stop' | 'refresh'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
}
/**
 * Restore is SSMS's OK: it asks first where the facts call for it (owner decision 4), then runs, and the document stays open with
 * the steps. Stop has no documentBusy: a restore never holds the document task (it is a long run, src/shared/long-runs.ts).
 */
export function restoreCommandEntries(): { readonly [K in RestoreCommandId]: RestoreCommandEntry } {
  return {
    'restoreDatabase.run': {
      title: 'Restore', category: 'Restore Database', icon: 'history', keywords: ['ok', 'run', 'restore', 'recover', 'backup'],
      precondition: 'activeDocumentIsRestore && restoreRunnable', unavailableHint: 'Choose what to restore, and where, on a connected server.'
    },
    'restoreDatabase.stop': {
      title: 'Stop', category: 'Restore Database', icon: 'debug-stop', keywords: ['cancel', 'restore'],
      precondition: 'activeDocumentIsRestore && restoreRunning', unavailableHint: 'No restore is running.'
    },
    'restoreDatabase.refresh': {
      title: 'Refresh', category: 'Restore Database', icon: 'refresh', keywords: ['reload', 'read', 'backups'],
      precondition: 'activeDocumentIsRestore && restoreRefreshable', unavailableHint: 'Wait for the restore to finish, on a connected server.'
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
  /** The action OK runs and Script scripts; its catalogue row decides where the dialog opens. */
  readonly action: ObjectAction
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
  // Restore Database: a backup file SQL Server's account may not open (5120, 3201 with operating system error 5), and backup
  // media that are not what a restore needs (a family missing or misformed, a damaged set: 3241, 3242, 3183, 3189).
  FILE_ACCESS: false, MEDIA: false,
  // A restore over a database it was not backed up from without WITH REPLACE (3154); over the database itself without its tail-log
  // backup (3159); and backup sets that do not chain (RestoreChain, and SQL Server's 4305, 4326 and 3117).
  BACKUP_MISMATCH: false, TAIL_LOG_NEEDED: false, RESTORE_SEQUENCE: false,
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
  /** The default budget of an action's compensation and cleanup steps (ObjectActionSpec.cleanupMs). */
  cleanupMs: 10_000,
  /** The server file picker: UTF-16 units in a server path (sys.master_files.physical_name is nvarchar(260)), entries one folder
   *  lists (one more is read to set `truncated`), the backend's budget for one listing in ms (main's deadline is 15 s), and
   *  listings at once per server under a gate of their own: SQL Server ends a listing of an unreachable share only once the
   *  file system answers, so it must not hold a gate that Database Properties or Delete Object waits for. */
  serverPath: 260, browseEntries: 2_000, browseMs: 10_000, browsePerConnection: 1,
  /** A long step's progress (SQL Server's 3211 STATS messages): EVENTs at most this often, pushed to the page at most this many a second. */
  progressEventMs: 250, progressPerSecond: 4,
  /** The long-job gate, per Varia connection and in all (critic A26): long actions take it instead of the execute gate. */
  longPerConnection: 1, longTotal: 2,
  /** What a closing generation's grace adds to a long action's own Stop wait (stopGraceMs plus its cleanup budget). */
  drainMarginMs: 5_000
} as const

/** Whether an action runs on a server of this engine. */
export const actionServes = (action: ObjectAction, engine: ServerEngine): boolean => objectActionSpecs[action].engines.includes(engine)

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
  return [
    '{',
    `  "actions": ${block(objectActions.map(actionJson))},`,
    `  "compatibilityLevels": ${line(compatibilityLevels)},`,
    `  "databaseOptions": ${block(databaseOptionDefs.map(optionJson))},`,
    `  "dialogs": ${block(dialogIds.map(dialog => ({ dialog, action: dialogSpecs[dialog].action, pages: dialogSpecs[dialog].pages.map(page => page.id) })))},`,
    `  "errors": ${block(actionErrorCodes.map(code => ({ code, retryable: actionErrorRetryable[code] })))},`,
    `  "limits": ${line(actionLimits)},`,
    `  "logins": ${line(loginsCatalog())},`,
    `  "ownerNotOn": ${line(ownerNotOn)},`,
    `  "restore": ${line(restoreCatalog())},`,
    `  "rows": ${block(rows)},`,
    `  "scopedConfigurations": ${block(scopedConfigurationDefs.map(optionJson))},`,
    `  "serverFiles": ${block(serverFilePurposes.map(purpose => ({ purpose, extensions: serverFilePurposeSpecs[purpose].extensions })))},`,
    '  "version": 4',
    '}',
    ''
  ].join('\n')
}
