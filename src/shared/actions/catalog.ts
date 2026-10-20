// Object Explorer actions: Select Top 1000 Rows, Rename and Delete, which kinds and subtypes offer each, the object
// dialogs and their pages, error codes and limits. It is the only declaration of what an action may touch: menus,
// context keys, the palette and docs/object-actions.md read it, and the backend embeds actionsCatalogJson() as
// Actions/actions-catalog.json (a vitest file snapshot keeps that copy in sync), so a stale tree cannot ask the backend
// for an action its catalogue does not offer. Erasable TypeScript (no enums), so Node's type stripping can load it too.
import { kindSpecs, nodeKinds, type NodeKind, type NodeSubtype } from '../explorer/catalog.ts'
import type { ScriptDestination } from '../scripting/catalog.ts'

export const objectActions = ['selectTop', 'rename', 'delete'] as const
export type ObjectAction = typeof objectActions[number]
/** `query` opens and runs a query, `inline` edits the tree row, `dialog` opens an object dialog. */
export type ActionClass = 'query' | 'inline' | 'dialog'
export const dialogIds = ['deleteObject'] as const
export type DialogId = typeof dialogIds[number]
export type ActionCommandId = 'explorer.selectTopRows' | 'explorer.rename' | 'explorer.delete'
export interface ObjectActionSpec {
  readonly title: string
  readonly mnemonic: string
  readonly group: string
  readonly order: number
  readonly class: ActionClass
  readonly dialog?: DialogId
  readonly command: ActionCommandId
}
export const objectActionSpecs: { readonly [A in ObjectAction]: ObjectActionSpec } = {
  selectTop: { title: 'Select Top 1000 Rows', mnemonic: 'w', group: '1_query', order: 2, class: 'query', command: 'explorer.selectTopRows' },
  rename: { title: 'Rename', mnemonic: 'm', group: '7_edit', order: 1, class: 'inline', command: 'explorer.rename' },
  // SSMS underlines D, which Disconnect has in Varia's one Object Explorer menu (access keys are unique per menu).
  delete: { title: 'Delete', mnemonic: 'e', group: '7_edit', order: 2, class: 'dialog', dialog: 'deleteObject', command: 'explorer.delete' }
}

/** '' = not offered (hidden); 'disabled' = shown greyed, as SSMS shows Rename and Delete on system objects. */
export type ActionState = '' | 'disabled' | 'enabled'
export type ActionRow = Partial<Record<ObjectAction, 'enabled' | 'disabled'>>
export interface ActionKindSpec {
  /** A node without a subtype, and subtypes `subtypes` does not list. */
  readonly row: ActionRow
  readonly subtypes?: Partial<Record<NodeSubtype, ActionRow>>
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
  database: { row: editable, subtypes: { system: locked, snapshot: { rename: 'disabled', delete: 'enabled' } } }
}

/** The row of a kind and subtype, or undefined when the kind offers no actions (or the subtype is not the kind's). */
export function actionRow(kind: NodeKind, subtype?: NodeSubtype): ActionRow | undefined {
  const spec = actionKindSpecs[kind]
  if (!spec || subtype !== undefined && !kindSpecs[kind].subtypes?.includes(subtype)) return undefined
  return (subtype && spec.subtypes?.[subtype]) || spec.row
}
/** What the selection is: a folder, or an object with its subtype. */
export interface ActionTarget { readonly kind: NodeKind | 'folder'; readonly subtype?: NodeSubtype }
const noActions = Object.freeze(Object.fromEntries(objectActions.map(action => [action, '']))) as Readonly<Record<ObjectAction, ActionState>>
/** Each action's state for a node: 'enabled', 'disabled' (greyed) or '' (not offered). */
export function actionMenuState(target: ActionTarget | undefined): Readonly<Record<ObjectAction, ActionState>> {
  const row = target && target.kind !== 'folder' ? actionRow(target.kind, target.subtype) : undefined
  return row ? Object.fromEntries(objectActions.map(action => [action, row[action] ?? ''])) as Record<ObjectAction, ActionState> : noActions
}
/** Whether some row of the kind enables the action: what main checks before the backend re-derives the subtype. */
export function actionOffered(kind: NodeKind, action: ObjectAction): boolean {
  return [undefined, ...kindSpecs[kind].subtypes ?? []].some(subtype => actionRow(kind, subtype)?.[action] === 'enabled')
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
/** A command catalogue entry, in the shape of `CommandDescriptor`. */
export interface ActionCommandEntry {
  readonly title: string
  readonly category: 'Object Explorer'
  readonly icon: 'table' | 'edit' | 'close'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly titleSetting?: { readonly setting: 'objectExplorer.selectTopRows'; readonly template: string }
  readonly keybindings?: readonly ActionKeybinding[]
  readonly menus: readonly [{ readonly menu: 'explorer.context'; readonly group: string; readonly order: number; readonly mnemonic: string; readonly when: string }]
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
  }
}
/** The three action commands, keyed by their command ids (explorer.selectTopRows keeps PR4's id). */
export function actionCommandEntries(): { readonly [K in ActionCommandId]: ActionCommandEntry } {
  return Object.fromEntries(objectActions.map(action => {
    const spec = objectActionSpecs[action], { documentTask, ...data } = commandData[action], key = actionContextKey(action)
    const entry: ActionCommandEntry = {
      title: spec.title, category: 'Object Explorer', ...data,
      precondition: `backendReady && ${key} == 'enabled'` + (documentTask ? ' && !documentBusy' : ''),
      // The keys describe the selection, which a node's menu has just selected; the empty area's menu keeps it, so it opts out.
      menus: [{ menu: 'explorer.context', group: spec.group, order: spec.order, mnemonic: spec.mnemonic, when: `${key} != '' && explorerNode != 'background'` }]
    }
    return [spec.command, entry]
  })) as { readonly [K in ActionCommandId]: ActionCommandEntry }
}

export type PageId = 'general'
export interface DialogPageSpec { readonly id: PageId; readonly title: string; readonly icon: 'settings-gear' }
export interface DialogSpec { readonly title: string; readonly pages: readonly DialogPageSpec[] }
/** SSMS's dialogs: a "Select a page" list, Connection and Progress boxes, a Script button, and OK and Cancel. */
export const dialogSpecs: { readonly [D in DialogId]: DialogSpec } = {
  deleteObject: { title: 'Delete Object', pages: [{ id: 'general', title: 'General', icon: 'settings-gear' }] }
}
/** The Script button's destinations, as SSMS words them; delivery is Script As's (deliverScript). */
export const scriptActionTitles: { readonly [D in ScriptDestination]: string } = {
  newQuery: 'Script Action to New Query Window', file: 'Script Action to File', clipboard: 'Script Action to Clipboard'
}

/** Why an action failed, as a value; `retryable` says whether trying again can help. */
export const actionErrorRetryable = {
  NOT_FOUND: false, NOT_SUPPORTED: false, PERMISSION_DENIED: true, IN_USE: true, BLOCKED: true, DEPENDENTS: false, NAME_IN_USE: false,
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
  dependents: 100, messageChars: 2_048, infoMessages: 32, infoMessageChars: 512, scriptChars: 65_536, newName: 128,
  /** How long a stopped action's reply waits for SQL Server to end the statement, then answers CANCELLED (outcome unknown). */
  stopGraceMs: 10_000,
  /** When a running rename appears in the status bar, with Stop. */
  statusDelayMs: 300
} as const

/** What a renderer says when the backend stopped (or its connection broke) while DDL ran: the outcome is unknown. */
export const unknownOutcomeMessage = 'The SQL backend stopped while the action ran, so whether it completed is unknown. Refresh Object Explorer to check.'

// Compact sorted-key JSON, as in scriptingCatalogJson(), so each entry diffs as one line.
const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortKeys(item)]))
  : value
const line = (value: unknown) => JSON.stringify(sortKeys(value))
const block = (items: readonly unknown[]) => '[\n' + items.map(item => '    ' + line(item)).join(',\n') + '\n  ]'
const byState = (row: ActionRow, state: 'enabled' | 'disabled') => objectActions.filter(action => row[action] === state)

/**
 * The catalogue as the backend embeds it, keys sorted and everything resolved, so C# needs no rules of its own: `rows`
 * has one row per kind with actions and each of its subtypes ('' for none).
 */
export function actionsCatalogJson(): string {
  const rows = nodeKinds.flatMap(kind => actionKindSpecs[kind]
    ? [undefined, ...kindSpecs[kind].subtypes ?? []].map(subtype => { const row = actionRow(kind, subtype)!; return { kind, subtype: subtype ?? '', enabled: byState(row, 'enabled'), disabled: byState(row, 'disabled') } })
    : [])
  return [
    '{',
    `  "actions": ${block(objectActions.map(action => ({ action, class: objectActionSpecs[action].class, title: objectActionSpecs[action].title })))},`,
    `  "dialogs": ${block(dialogIds.map(dialog => ({ dialog, pages: dialogSpecs[dialog].pages.map(page => page.id) })))},`,
    `  "errors": ${block(actionErrorCodes.map(code => ({ code, retryable: actionErrorRetryable[code] })))},`,
    `  "limits": ${line(actionLimits)},`,
    `  "rows": ${block(rows)},`,
    '  "version": 1',
    '}',
    ''
  ].join('\n')
}
