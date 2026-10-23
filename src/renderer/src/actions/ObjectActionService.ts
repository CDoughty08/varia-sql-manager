import { actionLimits, actionMenuState, unknownOutcomeMessage, type ActionState, type ActionTarget, type ObjectAction } from '../../../shared/actions/catalog.ts'
import type { ActionExecuteResult } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { displayText, type ExplorerNodeRef, type ObjectRef } from '../../../shared/explorer/refs.ts'
import { ident } from '../../../shared/explorer/schema.ts'
import { selectTopRowsScript } from '../../../shared/sql/identifiers'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'
import { scriptObjectLabel } from '../scripting/ScriptingService'
import type { LiveConnection } from '../services/connections'

export interface ObjectActionServiceOptions {
  readonly api: Pick<VariaApi, 'tableColumns' | 'executeObjectAction' | 'cancelObjectActions'>
  readonly explorer: {
    beginRename(nodeId: number): boolean
    endRename(): void
    listingFolderOf(nodeId: number): number | undefined
    reconcile(nodeId: number, options?: { readonly select?: ExplorerNodeRef }): void
  }
  readonly documents: { newQuery(sql: string, name: string | undefined, connectionId: string, database: string, unsaved: boolean): unknown }
  readonly queries: { canExecute(): boolean; execute(): Promise<unknown> }
  readonly connections: ExternalStore<readonly LiveConnection[]>
  /** The command banner: a failed rename's message, or sp_rename's caution. */
  readonly report: { error(message: string): void; warning(message: string): void }
  /** Tools › Options › SQL Server Object Explorer › Commands: Select Top <n> Rows. */
  readonly selectTopCount: () => number
  readonly timers?: Timers
  readonly newId?: () => string
}

/** A running rename, shown in the status bar with Stop once it has run for `actionLimits.statusDelayMs`. */
export interface RenameJob { readonly id: string; readonly label: string; readonly newName: string; readonly visible: boolean; readonly stopping: boolean }
export interface ObjectActionSnapshot { readonly renames: readonly RenameJob[] }

/** sp_rename leaves a module's definition text with its old name, as SQL Server does. */
export const moduleRenameNote = 'The definition text keeps the old name; script the object with CREATE OR ALTER to update it.'
export const renameMessages = {
  running: (label: string) => `A rename of ${label} is already running. Wait for it, or stop it in the status bar.`,
  stoppedUnknown: 'The rename was stopped, but SQL Server did not confirm it in time, so whether it completed is unknown. Refresh Object Explorer to check.'
} as const
const maxNewName = 400
const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const objectOf = (node: Pick<ExplorerMenuNode, 'ref'>): ObjectRef | undefined => node.ref.type === 'object' ? node.ref.object : undefined

interface Job { readonly connectionId: string; readonly requestId: string; readonly label: string; readonly newName: string; dropped: boolean; stopped: boolean; visible: boolean; timer?: unknown }

/**
 * Object Explorer's actions in the renderer: Select Top 1000 Rows for tables and views, and inline Rename (Delete and
 * the other dialogs are ObjectDialogService's). A rename runs at once, as SSMS's does, with no confirmation; its
 * failure goes to the command banner and the label shows the old name again. DDL waits for locks without a timeout, as
 * SSMS's does, so a rename that runs for a moment appears in the status bar with Stop, which cancels it in SQL Server.
 * At most one rename is in flight per node; a server that disconnects drops its renames and cancels them in the backend.
 */
export class ObjectActionService extends SnapshotStore<ObjectActionSnapshot> implements Disposable {
  private readonly renames = new Map<number, Job>()
  private readonly timers: Timers
  private readonly newId: () => string
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly options: ObjectActionServiceOptions) {
    super({ renames: [] })
    this.timers = options.timers ?? browserTimers
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.unsubscribe = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (error) { onUnexpectedError(error) } })
  }

  /** Each action's state for a node: what the context keys say for the selection. */
  state(target: ActionTarget | undefined): Readonly<Record<ObjectAction, ActionState>> { return actionMenuState(target) }
  /** Whether `action` is enabled for the node now: its kind and subtype offer it, and its server is live. */
  canRun(action: ObjectAction, node: ExplorerMenuNode | undefined): node is ExplorerMenuNode {
    return !!node && !node.lost && node.ref.type === 'object' && actionMenuState(node)[action] === 'enabled' && this.isLive(node.connectionId)
  }

  /** SSMS's Select Top N Rows: the columns, one per line, in a new unmarked query on the object's database, run at once. */
  async selectTop(node: ExplorerMenuNode): Promise<void> {
    const object = objectOf(node)
    if (!this.canRun('selectTop', node) || !object?.database || object.schema === undefined || object.name === undefined) throw new Error('Select a table or view in Object Explorer.')
    const name = { connectionId: node.connectionId, database: object.database, schema: object.schema, name: object.name }
    const { columns, truncated } = unwrap(await this.options.api.tableColumns(name.connectionId, name.database, name.schema, name.name))
    if (!this.isLive(name.connectionId)) return
    // Not dirty: the menu can always produce it again.
    this.options.documents.newQuery(selectTopRowsScript({ ...name, columns, truncated }, this.options.selectTopCount()), undefined, name.connectionId, name.database, false)
    if (this.options.queries.canExecute()) await this.options.queries.execute()
  }

  /** F2 or Rename: the node's label becomes the Rename box. */
  beginRename(node: ExplorerMenuNode): void {
    if (!this.canRun('rename', node) || !this.options.explorer.beginRename(node.id)) throw new Error('This object cannot be renamed.')
  }
  /** Escape, or a box that went away: nothing is sent. */
  cancelRename(): void { this.options.explorer.endRename() }

  /**
   * Enter or leaving the box. An unchanged or empty name ends it silently; an invalid one reports why and keeps the box
   * (false). Otherwise the box ends and the rename runs; on success the listing folder is reconciled, with the new name selected.
   */
  async commitRename(node: ExplorerMenuNode, text: string): Promise<boolean> {
    const object = objectOf(node)
    if (!object || text === '' || text === object.name) { this.cancelRename(); return true }
    const parsed = ident.safeParse(text)
    if (!parsed.success) { this.options.report.error(parsed.error.issues[0]?.message ?? 'The name is not valid.'); return false }
    this.cancelRename()
    if (this.disposed || !this.isLive(node.connectionId)) return true
    const running = this.renames.get(node.id)
    if (running) { this.options.report.error(renameMessages.running(running.label)); return true }
    const characters = [...displayText(text)]
    const job: Job = {
      connectionId: node.connectionId, requestId: this.newId(), label: scriptObjectLabel(object), dropped: false, stopped: false, visible: false,
      newName: characters.length > maxNewName ? characters.slice(0, maxNewName - 1).join('') + '…' : characters.join('')
    }
    job.timer = this.timers.setTimeout(() => { if (this.renames.get(node.id) === job) { job.visible = true; this.changed() } }, actionLimits.statusDelayMs)
    this.renames.set(node.id, job)
    this.changed()
    const folder = this.options.explorer.listingFolderOf(node.id)
    let result: ApiResult<ActionExecuteResult>
    try {
      result = await this.options.api.executeObjectAction({ action: 'rename', connectionId: node.connectionId, requestId: job.requestId, target: object, newName: text })
    } catch (error) {
      if (!job.dropped) this.options.report.error(error instanceof Error ? error.message : 'The rename failed.')
      return true
    } finally { this.finish(node.id, job) }
    if (job.dropped || this.disposed) return true
    if (!result.ok) {
      // A Stop the backend could not confirm in time; otherwise CANCELLED is a disconnect, which drops the job first.
      if (result.code === 'CANCELLED') { if (job.stopped) this.options.report.error(renameMessages.stoppedUnknown); return true }
      this.options.report.error(result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST' ? unknownOutcomeMessage : `Rename failed for ${node.label}: ${result.error}`)
      return true
    }
    // Stop cancelled the statement in SQL Server, so the object keeps its name, as the label already shows.
    if (result.value.error?.code === 'CANCELLED') return true
    if (result.value.error) { this.options.report.error(`Rename failed for ${node.label}: ${result.value.error.message}`); return true }
    if (folder !== undefined) this.options.explorer.reconcile(folder, { select: { type: 'object', object: { ...object, name: text } } })
    // sp_rename's caution is a warning; MODIFY NAME's "The database name 'x' has been set." only confirms the rename.
    const caution = object.kind === 'database' ? '' : result.value.messages.join(' ')
    if (caution) this.options.report.warning(object.kind === 'table' ? caution : `${caution} ${moduleRenameNote}`)
    return true
  }

  /** The status bar's Stop: cancels the renames in SQL Server; each answers when its statement has ended. */
  stopRenames(requestIds: readonly string[]): void {
    const wanted = new Set(requestIds), ids: string[] = []
    for (const job of this.renames.values()) {
      if (!wanted.has(job.requestId) || job.stopped || job.dropped) continue
      job.stopped = true
      ids.push(job.requestId)
    }
    if (!ids.length) return
    this.changed()
    this.cancel(ids)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.drop([...this.renames.keys()])
    this.clearListeners()
  }

  private isLive(connectionId: string): boolean {
    return this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }
  /** A disconnected or lost server's renames: their outcome is dropped, and the backend is told to stop them. */
  private connectionsChanged(): void {
    this.drop([...this.renames].filter(([, job]) => !this.isLive(job.connectionId)).map(([key]) => key))
  }
  private finish(key: number, job: Job): void {
    this.timers.clearTimeout(job.timer)
    if (this.renames.get(key) !== job) return
    this.renames.delete(key)
    this.changed()
  }
  private drop(keys: readonly number[]): void {
    const ids: string[] = []
    for (const key of keys) {
      const job = this.renames.get(key)
      if (!job || job.dropped) continue
      job.dropped = true
      this.timers.clearTimeout(job.timer)
      this.renames.delete(key)
      if (!job.stopped) ids.push(job.requestId)
    }
    if (keys.length && !this.disposed) this.changed()
    this.cancel(ids)
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (error) { onUnexpectedError(error) }
    }
  }
  private changed(): void {
    this.publish({ renames: [...this.renames.values()].map(job => ({ id: job.requestId, label: job.label, newName: job.newName, visible: job.visible, stopping: job.stopped })) })
  }
}
