import { actionLimits, actionMenuState, unknownOutcomeMessage, type ActionState, type ActionTarget, type ObjectAction } from '../../../shared/actions/catalog.ts'
import type { ActionExecuteResult } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { ExplorerNodeRef, ObjectRef } from '../../../shared/explorer/refs.ts'
import { ident } from '../../../shared/explorer/schema.ts'
import { selectTopRowsScript } from '../../../shared/sql/identifiers'
import { onUnexpectedError } from '../core/errors'
import type { Disposable, ExternalStore } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'
import type { LiveConnection } from '../services/connections'

export interface ObjectActionServiceOptions {
  readonly api: Pick<VariaApi, 'tableColumns' | 'executeObjectAction' | 'cancelObjectActions'>
  readonly explorer: {
    beginRename(nodeId: number): boolean
    endRename(): void
    listingFolderOf(nodeId: number): number | undefined
    refreshAndSelect(folderNodeId: number, ref: ExplorerNodeRef): void
  }
  readonly documents: { newQuery(sql: string, name: string | undefined, connectionId: string, database: string, unsaved: boolean): unknown }
  readonly queries: { canExecute(): boolean; execute(): Promise<unknown> }
  readonly connections: ExternalStore<readonly LiveConnection[]>
  /** The command banner: a failed rename's message, or sp_rename's caution. */
  readonly report: { error(message: string): void; warning(message: string): void }
  /** Tools › Options › SQL Server Object Explorer › Commands: Select Top <n> Rows. */
  readonly selectTopCount: () => number
  readonly newId?: () => string
}

/** sp_rename leaves a module's definition text with its old name, as SQL Server does. */
export const moduleRenameNote = 'The definition text keeps the old name; script the object with CREATE OR ALTER to update it.'
const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const objectOf = (node: Pick<ExplorerMenuNode, 'ref'>): ObjectRef | undefined => node.ref.type === 'object' ? node.ref.object : undefined

/**
 * Object Explorer's actions in the renderer: Select Top 1000 Rows for tables and views, and inline Rename (Delete and
 * the other dialogs are ObjectDialogService's). A rename runs at once, as SSMS's does, with no confirmation; its
 * failure goes to the command banner and the label shows the old name again. At most one rename is in flight per node,
 * and a server that disconnects drops its renames and cancels them in the backend.
 */
export class ObjectActionService implements Disposable {
  private readonly renames = new Map<number, { readonly connectionId: string; readonly requestId: string; dropped: boolean }>()
  private readonly newId: () => string
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly options: ObjectActionServiceOptions) {
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
   * (false). Otherwise the box ends and the rename runs; on success the listing folder reloads with the new name selected.
   */
  async commitRename(node: ExplorerMenuNode, text: string): Promise<boolean> {
    const object = objectOf(node)
    if (!object || text === '' || text === object.name) { this.cancelRename(); return true }
    const parsed = ident.safeParse(text)
    if (!parsed.success) { this.options.report.error(parsed.error.issues[0]?.message ?? 'The name is not valid.'); return false }
    this.cancelRename()
    if (this.disposed || this.renames.has(node.id) || !this.isLive(node.connectionId)) return true
    const job = { connectionId: node.connectionId, requestId: this.newId(), dropped: false }
    this.renames.set(node.id, job)
    const folder = this.options.explorer.listingFolderOf(node.id)
    let result: ApiResult<ActionExecuteResult>
    try {
      result = await this.options.api.executeObjectAction({ action: 'rename', connectionId: node.connectionId, requestId: job.requestId, target: object, newName: text })
    } catch (error) {
      if (!job.dropped) this.options.report.error(error instanceof Error ? error.message : 'The rename failed.')
      return true
    } finally { if (this.renames.get(node.id) === job) this.renames.delete(node.id) }
    if (job.dropped || this.disposed) return true
    if (!result.ok) {
      if (result.code === 'CANCELLED') return true
      this.options.report.error(result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST' ? unknownOutcomeMessage : `Rename failed for ${node.label}: ${result.error}`)
      return true
    }
    if (result.value.error) { this.options.report.error(`Rename failed for ${node.label}: ${result.value.error.message}`); return true }
    if (folder !== undefined) this.options.explorer.refreshAndSelect(folder, { type: 'object', object: { ...object, name: text } })
    const caution = result.value.messages.join(' ')
    if (caution) this.options.report.warning(object.kind === 'table' || object.kind === 'database' ? caution : `${caution} ${moduleRenameNote}`)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.drop([...this.renames.keys()])
  }

  private isLive(connectionId: string): boolean {
    return this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }
  /** A disconnected or lost server's renames: their outcome is dropped, and the backend is told to stop them. */
  private connectionsChanged(): void {
    this.drop([...this.renames].filter(([, job]) => !this.isLive(job.connectionId)).map(([key]) => key))
  }
  private drop(keys: readonly number[]): void {
    const ids: string[] = []
    for (const key of keys) {
      const job = this.renames.get(key)
      if (!job || job.dropped) continue
      job.dropped = true
      this.renames.delete(key)
      ids.push(job.requestId)
    }
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (error) { onUnexpectedError(error) }
    }
  }
}
