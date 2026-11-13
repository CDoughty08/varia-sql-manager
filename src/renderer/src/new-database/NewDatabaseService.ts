import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
import { actionLimits, dialogSpecs } from '../../../shared/actions/catalog.ts'
import type { Growth } from '../../../shared/actions/database.ts'
import type { ServerPathSeparator } from '../../../shared/actions/files.ts'
import {
  changedFrom, defaultFileName, folderOf, newDatabaseBaseline, newDatabaseProblems, primaryFilegroup, separatorOf, type ContainmentType, type NewDatabaseDesign, type NewDatabaseFacts,
  type NewDatabaseModel, type NewDatabaseProblem, type NewFilegroupType, type NewFileType
} from '../../../shared/actions/new-database.ts'
import type { ActionError, ActionExecuteResult, ActionStep, CreateDatabaseRequest } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { ExplorerNodeRef } from '../../../shared/explorer/refs.ts'
import type { ScriptDestination } from '../../../shared/scripting/catalog.ts'
import type { NewDatabaseContextState, NewDatabaseKeys } from '../core/contextkeys'
import { dialogEnter, type EnterTarget } from '../dialogs/dialog-keys'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import { initialFrameState, type FrameState } from '../kit/document-frame'
import type { ScriptContent } from '../kit/ScriptDrawer'
import type { ExplorerMenuNode } from '../menus/targets'
import { deliverScript, type DeliverScriptDeps } from '../scripting/deliver'
import type { LiveConnection } from '../services/connections'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import type { LongRunService } from '../services/long-runs'
import type { ServerFilePick } from '../server-files/ServerFilePickerService'

/** A file row: `named` once its logical name was typed (until then the primary and log files follow the database's name), and
 *  its file name as typed, or undefined for SSMS's default (shown in italics). */
export interface NewFileRow {
  readonly key: number
  readonly name: string
  readonly named: boolean
  readonly type: NewFileType
  readonly filegroup?: string
  readonly sizeMb?: number
  readonly growth: Growth
  readonly path: string
  readonly fileName?: string
}
export interface NewGroupRow { readonly key: number; readonly name: string; readonly type: NewFilegroupType; readonly readOnly: boolean; readonly isDefault: boolean; readonly autogrowAllFiles: boolean }
/** loading → ready (or loadFailed); OK: ready → creating → closed, or back to ready with the error and steps. */
export type NewDatabasePhase = 'loading' | 'loadFailed' | 'ready' | 'creating'
export interface NewDatabaseState {
  readonly id: string
  /** The tab's title: New Database, then New Database (2) and on while others are open (D1 §2). */
  readonly title: string
  readonly server: string
  readonly login?: string
  /** The Databases folder a success reloads and selects the new database in. */
  readonly folderNodeId?: number
  readonly phase: NewDatabasePhase
  readonly model?: NewDatabaseModel
  readonly name: string
  /** '' for <default>: the login that creates it. */
  readonly owner: string
  readonly files: readonly NewFileRow[]
  readonly filegroups: readonly NewGroupRow[]
  /** '' for <server default>. */
  readonly collation: string
  readonly containment: ContainmentType
  readonly ledger: boolean
  /** Every option and scoped configuration New Database sends, starting from the baseline (model's). */
  readonly options: Readonly<Record<string, string>>
  readonly scoped: Readonly<Record<string, string>>
  /** Moves with every edit: which design the Script preview shows. */
  readonly revision: number
  /** Problems show once OK or Script was tried, or the field was edited (`touched`). */
  readonly touched: boolean
  readonly error?: ActionError
  readonly steps?: readonly ActionStep[]
  readonly frame: FrameState
  readonly script: ScriptContent
  readonly scriptRevision?: number
  readonly scriptNotice?: string
}
export interface NewDatabaseSnapshot { readonly documents: Readonly<Record<string, NewDatabaseState>> }

export interface NewDatabaseServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'writeClipboardText'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'update' | 'activate' | 'getSnapshot' | 'close'> & DeliverScriptDeps['documents']
  readonly files: DeliverScriptDeps['files']
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly explorer: { databasesFolderOf(nodeId: number): number | undefined; reconcile(nodeId: number, options?: { readonly select?: ExplorerNodeRef }): void }
  readonly longRuns?: Pick<LongRunService, 'begin'>
  readonly serverFiles?: { pick(request: ServerFilePick): Promise<string | undefined> }
  readonly focusEditor?: () => void
  readonly focus?: (id: string) => void
  readonly timers?: Timers
  readonly newId?: () => string
}

export const newDatabaseMessages = {
  title: 'New Database',
  readFailed: 'The server could not be read.',
  disconnected: 'The server was disconnected. Connect to it again and choose New Database… there.',
  creating: 'The database is being created. Stop it, or wait for it to finish.',
  cannotCreate: 'You do not have permission to create a database on this server (CREATE ANY DATABASE).',
  stopped: 'Creating the database was stopped, but SQL Server did not confirm it in time, so whether it was created is unknown. Refresh the Databases folder to check.',
  connectionLost: 'The server was disconnected while the database was being created, so whether it was created is unknown. Refresh the Databases folder to check.',
  backendLost: 'The SQL backend stopped while the database was being created, so whether it was created is unknown. Refresh the Databases folder to check.',
  noScript: 'Enter a database name to script it.',
  emptyFilegroup: 'Remove its files first.'
} as const
/** How long the Script preview waits after the last edit before it asks the backend. */
export const previewDelayMs = 300
const sections = dialogSpecs.newDatabase.pages
const error = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: true })
const megabytes = (size: number) => Math.min(actionLimits.dataFileMb, Math.max(1, Math.ceil(size)))

/** The server's facts for the rules only it decides. */
export function newDatabaseFacts(model: NewDatabaseModel): NewDatabaseFacts {
  const server = model.model.server
  return { level: server.level, separator: model.linux ? '/' : '\\', linux: model.linux, filestreamLevel: server.filestreamLevel, containedAuthentication: server.containedAuthentication }
}
const separatorFor = (state: NewDatabaseState): ServerPathSeparator => state.model?.linux ? '/' : state.model ? '\\' : separatorOf(state.files[0]?.path ?? '')

/**
 * A row's File Type choices: ROWS Data and LOG, and FILESTREAM Data (the container of a FILESTREAM or memory-optimized
 * filegroup) where the server has FILESTREAM or the database has a memory-optimized filegroup, whose container needs no
 * FILESTREAM (on Linux too). A row keeps the type it has.
 */
export function fileTypesFor(state: NewDatabaseState, row: Pick<NewFileRow, 'type'>): NewFileType[] {
  const containers = filestreamOn(state) || state.filegroups.some(group => group.type === 'memoryOptimized')
  return (['rows', 'log', 'filestream'] as const).filter(type => type !== 'filestream' || containers || row.type === 'filestream')
}
/** Whether the server can hold FILESTREAM data: not on Linux, and only where FILESTREAM is enabled. */
export const filestreamOn = (state: NewDatabaseState): boolean => !!state.model && !state.model.linux && state.model.model.server.filestreamLevel > 0
/** The filegroups a row of this type can go in: rows filegroups for ROWS Data; FILESTREAM ones (where the server has it) and the
 *  memory-optimized one for a container. */
export function filegroupsFor(state: NewDatabaseState, type: NewFileType): readonly NewGroupRow[] {
  return state.filegroups.filter(group => type === 'rows' ? group.type === 'rows' : group.type === 'memoryOptimized' || group.type === 'filestream' && filestreamOn(state))
}

/**
 * Enter and Escape in the document, as in SSMS's dialog (D1 §2): Escape cancels, and Enter is OK, but where the key is the
 * focused control's own: a button, a drop-down, a grid cell (Enter edits there), a field with suggestions (Enter picks one), and
 * the Script drawer's editor.
 */
export function newDatabaseKey(key: string, target: (EnterTarget & { hasAttribute?(name: string): boolean }) | null): 'ok' | 'cancel' | undefined {
  if (target?.closest?.('.monaco-editor')) return undefined
  if (key === 'Escape') return 'cancel'
  if (key !== 'Enter' || target?.hasAttribute?.('list')) return undefined
  return dialogEnter(target) === 'ok' ? 'ok' : undefined
}

/** The file name a row has: as typed, or SSMS's default for its logical name. The first file is the primary data file. */
export function rowFileName(state: NewDatabaseState, row: NewFileRow): string {
  return row.fileName ?? defaultFileName(row.name, row.type, state.files[0]?.key === row.key, separatorFor(state))
}

/** The design OK and Script send, from the document's state: only the options that differ from the baseline (owner decision). */
export function newDatabaseDesign(state: NewDatabaseState): NewDatabaseDesign {
  const baseline = state.model ? newDatabaseBaseline(state.model.model) : { options: {}, scoped: {} }
  return {
    ...state.owner === '' ? {} : { owner: state.owner },
    files: state.files.map(row => ({
      name: row.name, type: row.type, ...row.type === 'log' ? {} : { filegroup: row.filegroup ?? primaryFilegroup }, ...row.type === 'filestream' ? {} : { sizeMb: row.sizeMb ?? 1 },
      growth: row.growth, path: row.path, fileName: rowFileName(state, row)
    })),
    filegroups: state.filegroups.map(group => ({
      name: group.name, type: group.type, ...group.readOnly ? { readOnly: true } : {}, ...group.isDefault ? { isDefault: true } : {}, ...group.autogrowAllFiles ? { autogrowAllFiles: true } : {}
    })),
    ...state.collation === '' ? {} : { collation: state.collation },
    containment: state.containment,
    ...state.ledger ? { ledger: true } : {},
    options: changedFrom(baseline.options, state.options),
    scoped: changedFrom(baseline.scoped, state.scoped)
  }
}
/** Every problem with the document's design, the server's rules included once it was read. */
export function newDatabaseStateProblems(state: NewDatabaseState): readonly NewDatabaseProblem[] {
  return newDatabaseProblems(state.name, newDatabaseDesign(state), state.model ? newDatabaseFacts(state.model) : undefined)
}

/**
 * New Database as a document (D1b, mock-up M5): one tab per New Database…, its General, Options and Filegroups pages as
 * sections, and the Script drawer, which previews what OK runs. The design lives here, so the tab can be switched away from
 * and back; the view only renders it. OK creates the database as a long run (never holding the document task), then the tab
 * closes and Object Explorer selects the new database. The document has nothing to save and is never dirty: closing it
 * discards it, as SSMS's Cancel does. Failures are values in the snapshot; nothing throws into React.
 */
export class NewDatabaseService extends SnapshotStore<NewDatabaseSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'newDatabase' as const
  readonly inSaveAll = false
  private readonly newId: () => string
  private readonly timers: Timers
  private readonly registration: Disposable
  private readonly unsubscribe: () => void
  private readonly contextStore = new (class extends SnapshotStore<NewDatabaseContextState> { set(value: NewDatabaseContextState) { this.publish(value) } clear() { this.clearListeners() } })({ byDocument: {} })
  /** Each document's describe or create in flight, so Stop, a close and a disconnect can cancel it. */
  private readonly requests = new Map<string, { readonly id: string; readonly kind: 'describe' | 'create'; readonly connectionId?: string; dropped: boolean }>()
  private readonly previews = new Map<string, string>()
  private readonly previewTimers = new Map<string, unknown>()
  private readonly creates = new Map<string, Promise<boolean>>()
  private keys = 0
  private readonly targetBindings: CustomDocumentTargets
  private disposed = false

  constructor(private readonly options: NewDatabaseServiceOptions) {
    super({ documents: {} })
    this.targetBindings = new CustomDocumentTargets(options)
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.timers = options.timers ?? browserTimers
    this.registration = options.documents.registerProvider(this)
    this.unsubscribe = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (failure) { onUnexpectedError(failure) } })
  }

  get context(): ExternalStore<NewDatabaseContextState> { return this.contextStore }
  get(id: string): NewDatabaseState | undefined { return this.getSnapshot().documents[id] }

  /** New Database… on the Databases folder or a database: a tab opens at once, reading model and the server. */
  open(node: ExplorerMenuNode): string {
    if (this.disposed) throw new Error('New Database is not available.')
    const folder = node.ref.type === 'folder' && node.ref.folder === 'databases'
    const database = node.ref.type === 'object' && node.ref.object.kind === 'database'
    const connection = this.options.connections.getSnapshot().find(item => item.id === node.connectionId && !item.lost)
    if (!folder && !database) throw new Error('Select the Databases folder in Object Explorer.')
    if (!connection) throw new Error('Connect to the server first.')
    // Tabs that read alike cannot be told apart in the tab strip, the Window menu or a screen reader: a second one is numbered.
    const titles = new Set(Object.values(this.getSnapshot().documents).map(state => state.title))
    let title: string = newDatabaseMessages.title
    for (let n = 2; titles.has(title); n++) title = `${newDatabaseMessages.title} (${n})`
    const document = this.options.documents.openCustom('newDatabase', title, connection.id, 'master')
    this.targetBindings.bind(document.id, connection.id)
    // A database under System Databases or Database Snapshots is listed there, but a new database appears in Databases.
    const folderNodeId = folder ? node.id : this.options.explorer.databasesFolderOf(node.id)
    this.put({
      id: document.id, title, server: connection.server, ...connection.login ? { login: connection.login } : {}, ...folderNodeId === undefined ? {} : { folderNodeId },
      phase: 'loading', name: '', owner: '', files: [], filegroups: [], collation: '', containment: 'NONE', ledger: false, options: {}, scoped: {}, revision: 0, touched: false,
      frame: initialFrameState(sections), script: { state: 'idle', message: newDatabaseMessages.noScript }
    })
    void this.describe(document.id)
    return document.id
  }

  /** Retry after the server could not be read. */
  retry(id: string): void {
    const state = this.get(id)
    if (state?.phase !== 'loadFailed' || !this.live(id)) return
    this.patch(id, { phase: 'loading', error: undefined })
    void this.describe(id)
  }

  private async describe(id: string): Promise<void> {
    const connectionId = this.connectionOf(id)
    if (!this.get(id) || !connectionId) return
    const requestId = this.begin(id, 'describe')
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: 'newDatabase', target: { kind: 'server' } }))
    if (!this.end(id, requestId)) return
    const model = result.ok ? result.value.newDatabase : undefined
    if (!model) { this.patch(id, { phase: 'loadFailed', error: (result.ok ? result.value.error : undefined) ?? error('SQL_ERROR', result.ok ? newDatabaseMessages.readFailed : result.error) }); return }
    const separator: ServerPathSeparator = model.linux ? '/' : '\\'
    const rows = model.model.files.find(file => file.type === 'rows'), log = model.model.files.find(file => file.type === 'log')
    const baseline = newDatabaseBaseline(model.model)
    const growth = (file: typeof rows): Growth => file?.growth ?? { enabled: true, unit: 'mb', by: 64 }
    this.patch(id, {
      phase: 'ready', model, error: undefined,
      files: [
        { key: ++this.keys, name: '', named: false, type: 'rows', filegroup: primaryFilegroup, sizeMb: megabytes(rows?.sizeMb ?? 8), growth: growth(rows), path: folderOf(model.dataPath, separator) },
        { key: ++this.keys, name: '_log', named: false, type: 'log', sizeMb: megabytes(log?.sizeMb ?? 8), growth: growth(log), path: folderOf(model.logPath, separator) }
      ],
      filegroups: [{ key: ++this.keys, name: primaryFilegroup, type: 'rows', readOnly: false, isDefault: true, autogrowAllFiles: false }],
      containment: model.model.options.containmentType === 'PARTIAL' ? 'PARTIAL' : 'NONE', options: { ...baseline.options }, scoped: { ...baseline.scoped }
    })
    this.schedulePreview(id, 0)
    // The name field draws now: it takes focus if the document is still the one in front.
    if (this.options.documents.getSnapshot().activeId === id) this.options.focus?.(id)
  }

  // --- Editing -------------------------------------------------------------------------------------------------------

  canEdit(id: string): boolean { return this.get(id)?.phase === 'ready' }
  /** The database's name; the primary and log files' logical names follow it until they are typed (SSMS's behaviour). */
  setName(id: string, name: string): void {
    const state = this.get(id)
    if (!state || !this.canEdit(id) || state.name === name) return
    const first = state.files[0]?.key, log = state.files.find(row => row.type === 'log')?.key
    this.edit(id, { name, files: state.files.map(row => row.named ? row : row.key === first ? { ...row, name } : row.key === log ? { ...row, name: `${name}_log` } : row) })
  }
  setOwner(id: string, owner: string): void { if (this.canEdit(id) && this.get(id)?.owner !== owner) this.edit(id, { owner }) }
  setCollation(id: string, collation: string): void { if (this.canEdit(id) && this.get(id)?.collation !== collation) this.edit(id, { collation }) }
  setContainment(id: string, containment: ContainmentType): void { if (this.canEdit(id) && this.get(id)?.containment !== containment) this.edit(id, { containment }) }
  setLedger(id: string, ledger: boolean): void { if (this.canEdit(id) && this.get(id)?.ledger !== ledger) this.edit(id, { ledger }) }
  /** The options and scoped configurations as the Options section's fields edited them (tokens). */
  setOptions(id: string, values: { readonly options: Readonly<Record<string, string>>; readonly scoped: Readonly<Record<string, string>> }): void {
    const state = this.get(id)
    if (!state || !this.canEdit(id)) return
    const same = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key])
    if (same(state.options, values.options) && same(state.scoped, values.scoped)) return
    this.edit(id, { options: { ...values.options }, scoped: { ...values.scoped } })
  }

  /** Add: a ROWS data file in the default rows filegroup, sized as model's, in the default data folder (SSMS's new row). Its key,
   *  so the view can put the caret in it. */
  addFile(id: string, type: NewFileType = 'rows'): number | undefined {
    const state = this.get(id)
    if (!state?.model || !this.canEdit(id) || state.files.length >= actionLimits.newDatabaseFiles) return undefined
    const separator: ServerPathSeparator = state.model.linux ? '/' : '\\'
    const template = state.files.find(row => row.type === (type === 'log' ? 'log' : 'rows'))
    const group = type === 'log' ? undefined : type === 'filestream'
      ? filegroupsFor(state, 'filestream')[0]?.name
      : (state.filegroups.find(item => item.type === 'rows' && item.isDefault) ?? state.filegroups[0])?.name
    const row: NewFileRow = {
      key: ++this.keys, name: '', named: true, type, ...group === undefined ? {} : { filegroup: group }, ...type === 'filestream' ? {} : { sizeMb: template?.sizeMb ?? 8 },
      growth: type === 'filestream' ? { enabled: false } : template?.growth ?? { enabled: true, unit: 'mb', by: 64 },
      path: folderOf(type === 'log' ? state.model.logPath : state.model.dataPath, separator)
    }
    this.edit(id, { files: [...state.files, row] })
    return row.key
  }
  /** Whether Remove can take a file: any but the primary data file and the last log file (a database needs both). */
  removable(id: string, key: number | undefined): boolean {
    const state = this.get(id), row = state?.files.find(item => item.key === key)
    return !!state && !!row && state.files[0]?.key !== key && !(row.type === 'log' && state.files.filter(item => item.type === 'log').length === 1)
  }
  /** Remove: a file Remove can take. */
  removeFile(id: string, key: number): void {
    const state = this.get(id)
    if (!state || !this.canEdit(id) || !this.removable(id, key)) return
    this.edit(id, { files: state.files.filter(row => row.key !== key) })
  }
  /** A cell of the files grid. A blank File Name goes back to the default; a type change moves the file to a filegroup of its kind. */
  setFile(id: string, key: number, patch: Partial<Pick<NewFileRow, 'name' | 'type' | 'filegroup' | 'sizeMb' | 'growth' | 'path' | 'fileName'>>): void {
    const state = this.get(id)
    if (!state || !this.canEdit(id)) return
    const files = state.files.map(row => {
      if (row.key !== key) return row
      let next: NewFileRow = { ...row, ...patch, ...patch.name !== undefined ? { named: true } : {} }
      if (patch.fileName !== undefined && patch.fileName.trim() === '') next = { ...next, fileName: undefined }
      if (patch.type !== undefined && patch.type !== row.type) {
        const group = patch.type === 'log' ? undefined : filegroupsFor(state, patch.type)[0]?.name
        next = { ...next, filegroup: group, ...patch.type === 'filestream' ? { sizeMb: undefined, growth: { enabled: false } } : { sizeMb: row.sizeMb ?? 8 } }
      }
      const result = next as NewFileRow & Record<string, unknown>
      for (const name of Object.keys(result)) if (result[name] === undefined) delete result[name]
      return result
    })
    this.edit(id, { files })
  }
  /** Path's "…": the server file picker, for a folder on this server. */
  async choosePath(id: string, key: number): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id), row = state?.files.find(item => item.key === key)
    if (!state?.model || !row || !connectionId || !this.canEdit(id) || !this.options.serverFiles) return
    const chosen = await this.options.serverFiles.pick({ connectionId, purpose: 'folder', initialPath: row.path })
    if (chosen !== undefined && this.get(id)) this.setFile(id, key, { path: folderOf(chosen, state.model.linux ? '/' : '\\') })
  }

  /** Add Filegroup: a new rows, FILESTREAM or memory-optimized filegroup, its name filled in by the person. Its key, so the view
   *  can put the caret in its name. */
  addFilegroup(id: string, type: NewFilegroupType): number | undefined {
    const state = this.get(id)
    if (!state || !this.canEdit(id) || state.filegroups.length >= actionLimits.newDatabaseFilegroups) return undefined
    const key = ++this.keys
    this.edit(id, { filegroups: [...state.filegroups, { key, name: '', type, readOnly: false, isDefault: false, autogrowAllFiles: false }] })
    return key
  }
  /** Remove: a filegroup but PRIMARY, once no file is in it. */
  removeFilegroup(id: string, key: number): void {
    const state = this.get(id), group = state?.filegroups.find(item => item.key === key)
    if (!state || !group || !this.canEdit(id) || state.filegroups[0]?.key === key) return
    if (state.files.some(row => row.filegroup === group.name)) { this.patch(id, { error: error('NOT_SUPPORTED', `${newDatabaseMessages.emptyFilegroup}`) }); return }
    this.edit(id, { filegroups: state.filegroups.filter(item => item.key !== key) })
  }
  /** A filegroup's cell: a rename moves its files with it; Default is one per kind. */
  setFilegroup(id: string, key: number, patch: Partial<Pick<NewGroupRow, 'name' | 'readOnly' | 'isDefault' | 'autogrowAllFiles'>>): void {
    const state = this.get(id), group = state?.filegroups.find(item => item.key === key)
    if (!state || !group || !this.canEdit(id) || (key === state.filegroups[0]?.key && patch.name !== undefined)) return
    const kind = (type: NewFilegroupType) => type === 'rows' ? 'rows' : 'filestream'
    const filegroups = state.filegroups.map(item => item.key === key ? { ...item, ...patch }
      : patch.isDefault && kind(item.type) === kind(group.type) ? { ...item, isDefault: false } : item)
    const files = patch.name === undefined ? state.files : state.files.map(row => row.filegroup === group.name ? { ...row, filegroup: patch.name } : row)
    this.edit(id, { filegroups, files })
  }
  setFrame(id: string, frame: FrameState): void {
    const state = this.get(id)
    if (!state || state.frame === frame) return
    const opened = frame.scriptOpen && !state.frame.scriptOpen
    this.patch(id, { frame })
    if (opened) this.schedulePreview(id, 0)
  }
  dismissError(id: string): void { if (this.get(id)?.error) this.patch(id, { error: undefined }) }

  // --- OK, Stop ------------------------------------------------------------------------------------------------------

  /** Whether OK can run: read, nothing running, its server connected, a login that may create one, and no problem. */
  canCreate(id: string): boolean {
    const state = this.get(id)
    return !!state?.model && state.phase === 'ready' && this.live(id) && state.model.canCreate && newDatabaseStateProblems(state).length === 0
  }
  /** OK: one at a time per document; resolves true once the database was created (and the tab closed). */
  create(id: string): Promise<boolean> {
    const running = this.creates.get(id)
    if (running) return running
    const promise = this.runCreate(id).catch(failure => { onUnexpectedError(failure); return false }).finally(() => { this.creates.delete(id); this.publishContext() })
    this.creates.set(id, promise)
    return promise
  }
  private async runCreate(id: string): Promise<boolean> {
    const state = this.get(id)
    if (!state?.model || state.phase !== 'ready') return false
    if (!this.live(id)) { this.patch(id, { error: error('CONNECTION_LOST', newDatabaseMessages.disconnected) }); return false }
    const problems = newDatabaseStateProblems(state)
    if (problems.length) { this.patch(id, { touched: true, error: error('NOT_SUPPORTED', problems[0].message) }); this.show(id); return false }
    if (!state.model.canCreate) { this.patch(id, { error: error('PERMISSION_DENIED', newDatabaseMessages.cannotCreate) }); return false }
    const connectionId = this.connectionOf(id)!
    const requestId = this.begin(id, 'create'), request = this.requests.get(id)
    const design = newDatabaseDesign(state), name = state.name
    // A long run (critic A6): the window, a Disconnect of its server and Restart are refused while it runs, and the document says
    // so; it never holds the document task, so nothing else waits on it silently.
    let run: Disposable | undefined
    try { run = this.options.longRuns?.begin({ kind: 'newDatabase', connectionId, server: state.server, refused: message => this.patch(id, { error: error('IN_USE', message) }) }) } catch (failure) { onUnexpectedError(failure) }
    this.patch(id, { phase: 'creating', error: undefined, steps: undefined })
    const request_: CreateDatabaseRequest = { action: 'createDatabase', connectionId, requestId, target: { kind: 'database', name }, design }
    const result = await this.call(() => this.options.api.executeObjectAction(request_))
    run?.dispose()
    if (this.requests.get(id)?.id === requestId) this.requests.delete(id)
    this.publishContext()
    // A disconnect while it ran has already said that the outcome is unknown.
    if (this.disposed || !this.get(id) || request?.dropped) return false
    if (this.connectionOf(id) !== connectionId || !this.live(id)) {
      this.patch(id, { phase: 'ready', error: error('CONNECTION_LOST', newDatabaseMessages.connectionLost) })
      return false
    }
    const value: ActionExecuteResult | undefined = result.ok ? result.value : undefined
    const created = !!value?.steps.some(step => step.status === 'done')
    // The Databases folder shows what is there now: the new database, or one a later step failed after.
    if (created) this.refreshListing(this.get(id)!, name)
    if (value && !value.error) {
      try { await this.options.documents.close(id) } catch (failure) { onUnexpectedError(failure) }
      return true
    }
    const lost = !result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST')
    const failure = value?.error
      ?? (!result.ok && result.code === 'CANCELLED' ? error('CANCELLED', newDatabaseMessages.stopped)
        : lost ? error('CONNECTION_LOST', !result.ok && result.code === 'BACKEND_LOST' ? newDatabaseMessages.backendLost : newDatabaseMessages.connectionLost)
          : error('SQL_ERROR', result.ok ? 'The database could not be created.' : result.error))
    this.patch(id, { phase: 'ready', error: failure, ...value ? { steps: value.steps } : {} })
    this.show(id)
    return false
  }
  /** Stop: cancels the running OK in SQL Server; the document says what completed when the answer comes. */
  stop(id: string): void {
    const request = this.requests.get(id)
    if (request?.kind === 'create') this.cancel([request.id])
  }

  // --- Script ----------------------------------------------------------------------------------------------------------

  /** One of the drawer's ways out: the script of the current design, made again if the preview is behind. */
  async deliver(id: string, destination: ScriptDestination): Promise<void> {
    const connectionId = this.connectionOf(id)
    if (!this.get(id) || !connectionId) return
    let text = this.currentScript(id)
    if (text === undefined) { this.clearPreviewTimer(id); text = await this.preview(id) }
    const current = this.get(id)
    if (!current || this.disposed) return
    if (text === undefined) {
      const script = current.script
      this.patch(id, { touched: true, scriptNotice: script.state === 'failed' ? script.error.message : script.state === 'idle' ? script.message : 'No script was produced.' })
      return
    }
    try {
      const notice = await deliverScript({ destination, text, database: 'master', connectionId, fileName: `${current.name || 'New Database'}.sql` }, this.options)
      this.patch(id, { scriptNotice: notice })
    } catch (failure) { this.patch(id, { scriptNotice: failure instanceof Error ? failure.message : 'The script could not be delivered.' }) }
  }
  private schedulePreview(id: string, delay = previewDelayMs): void {
    const state = this.get(id)
    if (!state?.frame.scriptOpen || state.scriptRevision === state.revision && state.script.state !== 'failed') return
    this.clearPreviewTimer(id)
    this.previewTimers.set(id, this.timers.setTimeout(() => { this.previewTimers.delete(id); void this.preview(id) }, delay))
  }
  private clearPreviewTimer(id: string): void {
    const pending = this.previewTimers.get(id)
    if (pending !== undefined) this.timers.clearTimeout(pending)
    this.previewTimers.delete(id)
  }
  private currentScript(id: string): string | undefined {
    const state = this.get(id)
    return state?.script.state === 'ready' && state.scriptRevision === state.revision ? state.script.text : undefined
  }
  /** Scripts the current design into the drawer; resolves to its text, or undefined when there is none. */
  private async preview(id: string): Promise<string | undefined> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state?.model || !connectionId) return undefined
    const revision = state.revision
    const problem = newDatabaseStateProblems(state)[0]
    if (problem) { this.patch(id, { script: { state: 'idle', message: state.name.trim() === '' ? newDatabaseMessages.noScript : problem.message }, scriptRevision: revision }); return undefined }
    if (!this.live(id)) { this.patch(id, { script: { state: 'failed', error: { message: newDatabaseMessages.disconnected, code: 'CONNECTION_LOST' } }, scriptRevision: revision }); return undefined }
    const previous = this.previews.get(id)
    if (previous) this.cancel([previous])
    const requestId = this.newId()
    this.previews.set(id, requestId)
    this.patch(id, { script: { state: 'loading' } })
    const result = await this.call(() => this.options.api.scriptObjectAction({ action: 'createDatabase', connectionId, requestId, target: { kind: 'database', name: state.name }, design: newDatabaseDesign(state) }))
    if (this.previews.get(id) !== requestId) return this.currentScript(id)
    this.previews.delete(id)
    if (this.disposed || !this.get(id) || this.connectionOf(id) !== connectionId || !this.live(id)) return undefined
    const failure = !result.ok ? { message: result.error, ...result.code ? { code: result.code } : {} } : result.value.error ? { message: result.value.error.message, code: result.value.error.code } : undefined
    const text = result.ok ? result.value.text : undefined
    if (failure || text === undefined) { this.patch(id, { script: { state: 'failed', error: failure ?? { message: 'No script was produced.' } }, scriptRevision: revision }); return undefined }
    // Script turns what OK would refuse (a name in use, a missing folder) into warnings, which the drawer's notice line says.
    const warnings = result.ok ? result.value.warnings : []
    this.patch(id, { script: { state: 'ready', text }, scriptRevision: revision, scriptNotice: warnings.length ? warnings.join(' ') : undefined })
    if (this.get(id)?.revision !== revision) this.schedulePreview(id)
    return text
  }

  // --- CustomDocumentProvider ----------------------------------------------------------------------------------------

  /** Ctrl+S (⌘S) is OK, as D1 §2 binds it and Database Properties' Save is Apply. The document is never dirty, so Save All passes
   *  it by and closing it discards it. */
  save(id: string): Promise<boolean> { this.show(id); return this.create(id) }
  canClose(id: string): string | undefined { return this.get(id)?.phase === 'creating' ? newDatabaseMessages.creating : undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.options.focus?.(id) }
  /** A document stays with its server: a reconnect moves it only to a connection to that server. */
  /** Legacy server-name reassociation is refused; reconnect callers must supply durable identity. */
  follows(_id: string, _server: string): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  closed(id: string): void {
    this.targetBindings.forget(id)
    const request = this.requests.get(id), preview = this.previews.get(id)
    this.cancel([request?.id, preview].filter((value): value is string => !!value))
    this.requests.delete(id)
    this.previews.delete(id)
    this.clearPreviewTimer(id)
    this.publish({ documents: Object.fromEntries(Object.entries(this.getSnapshot().documents).filter(([key]) => key !== id)) })
    this.publishContext()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.targetBindings.clear()
    this.cancel([...this.requests.values()].map(request => request.id).concat([...this.previews.values()]))
    for (const timer of this.previewTimers.values()) this.timers.clearTimeout(timer)
    this.requests.clear()
    this.previews.clear()
    this.previewTimers.clear()
    this.registration.dispose()
    this.unsubscribe()
    this.clearListeners()
    this.contextStore.clear()
  }

  // --- Internals -----------------------------------------------------------------------------------------------------

  private refreshListing(state: NewDatabaseState, name: string): void {
    if (state.folderNodeId === undefined) return
    try { this.options.explorer.reconcile(state.folderNodeId, { select: { type: 'object', object: { kind: 'database', name } } }) } catch (failure) { onUnexpectedError(failure) }
  }
  private show(id: string): void { if (this.options.documents.getSnapshot().activeId !== id) this.options.documents.activate(id) }
  private edit(id: string, patch: Partial<NewDatabaseState>): void {
    const state = this.get(id)
    if (!state) return
    this.patch(id, { ...patch, revision: state.revision + 1, touched: true, ...state.error?.code === 'NOT_SUPPORTED' ? { error: undefined } : {} })
    this.schedulePreview(id)
  }
  private patch(id: string, patch: Partial<NewDatabaseState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as NewDatabaseState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: NewDatabaseState): void {
    this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } })
    this.publishContext()
  }
  private publishContext(): void {
    const byDocument: Record<string, NewDatabaseKeys> = {}
    for (const state of Object.values(this.getSnapshot().documents)) byDocument[state.id] = { creatable: this.canCreate(state.id), creating: state.phase === 'creating' }
    const current = this.contextStore.getSnapshot().byDocument
    const same = Object.keys(byDocument).length === Object.keys(current).length
      && Object.entries(byDocument).every(([id, keys]) => current[id]?.creatable === keys.creatable && current[id]?.creating === keys.creating)
    if (!same) this.contextStore.set({ byDocument })
  }
  private connectionOf(id: string): string | undefined { return this.options.documents.get(id)?.connectionId }
  private live(id: string): boolean {
    const connectionId = this.connectionOf(id)
    return this.targetBindings.matchesConnection(id, connectionId) && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }
  private begin(id: string, kind: 'describe' | 'create'): string {
    const requestId = this.newId()
    this.requests.set(id, { id: requestId, kind, connectionId: this.connectionOf(id), dropped: false })
    return requestId
  }
  private end(id: string, requestId: string): boolean {
    const request = this.requests.get(id)
    if (request?.id === requestId) this.requests.delete(id)
    return !this.disposed && !!this.get(id) && request?.id === requestId && !request.dropped && request.connectionId === this.connectionOf(id) && this.live(id)
  }
  private async call<T>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try { return await send() } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } }
  }
  /** A server that disconnects: a running OK's outcome is unknown, a read fails, and their requests are cancelled. A connection
   *  still listed but lost went with its backend (a crash or a restart), not with its server. */
  private connectionsChanged(): void {
    const connections = this.options.connections.getSnapshot()
    for (const state of Object.values(this.getSnapshot().documents)) {
      if (this.live(state.id)) continue
      const connectionId = this.connectionOf(state.id)
      const backendGone = connections.some(connection => connection.id === connectionId && connection.lost)
      const request = this.requests.get(state.id), preview = this.previews.get(state.id)
      if (preview) { this.previews.delete(state.id); this.cancel([preview]); this.patch(state.id, { script: { state: 'failed', error: { message: newDatabaseMessages.disconnected, code: 'CONNECTION_LOST' } } }) }
      if (!request || request.dropped) continue
      request.dropped = true
      this.requests.delete(state.id)
      this.cancel([request.id])
      if (request.kind === 'create') this.patch(state.id, { phase: 'ready', error: error('CONNECTION_LOST', backendGone ? newDatabaseMessages.backendLost : newDatabaseMessages.connectionLost) })
      else this.patch(state.id, { phase: 'loadFailed', error: error('CONNECTION_LOST', newDatabaseMessages.disconnected) })
    }
    this.publishContext()
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
