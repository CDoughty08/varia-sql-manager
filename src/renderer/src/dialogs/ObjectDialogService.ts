import { actionLimits, dialogSpecs, unknownOutcomeMessage, type DialogId, type PageId } from '../../../shared/actions/catalog.ts'
import type { ActionError, ActionExecuteResult, ActionRequest, ActionStep } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import type { ScriptDestination } from '../../../shared/scripting/catalog.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'
import { deliverScript, type DeliverScriptDeps } from '../scripting/deliver'
import { scriptFileName, scriptObjectLabel } from '../scripting/ScriptingService'
import type { LiveConnection } from '../services/connections'
import { dialogDefinitions, type DialogDraft, type DialogModel } from './definitions'

/** loading → ready, or loadFailed; OK → executing → closed, or failed (or stopped); a lost server → disconnected. */
export type DialogPhase = 'loading' | 'ready' | 'loadFailed' | 'scripting' | 'executing' | 'failed' | 'stopped' | 'disconnected'
export interface OpenObjectDialog {
  /** Changes with every dialog, so the frame remounts. */
  readonly id: number
  readonly dialog: DialogId
  readonly connectionId: string
  /** The tree node it was opened for, which focus returns to. */
  readonly nodeId: number
  readonly target: ObjectRef
  /** The object as Object Explorer shows it. */
  readonly label: string
  /** The Connection box: the server as connected to and the login. */
  readonly server: string
  readonly login?: string
  readonly page: PageId
  readonly phase: DialogPhase
  readonly model?: DialogModel
  readonly draft?: DialogDraft
  readonly error?: ActionError
  readonly steps?: readonly ActionStep[]
  /** An info line for the message bar (a script delivered, informational messages). */
  readonly notice?: string
}
export interface ObjectDialogSnapshot { readonly open?: OpenObjectDialog }
export interface ObjectDialogServiceOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'writeClipboardText'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly explorer: { listingFolderOf(nodeId: number): number | undefined; refresh(id?: number): void }
  readonly documents: DeliverScriptDeps['documents']
  readonly files: DeliverScriptDeps['files']
  readonly focusEditor?: () => void
  readonly newId?: () => string
}

export const dialogMessages = {
  disconnected: 'The server was disconnected.',
  /** Stop, when the backend could not confirm in time that SQL Server ended the statement. */
  stopped: 'The action was stopped, but SQL Server did not confirm it in time, so whether it completed is unknown. Refresh Object Explorer to check.',
  busy: 'Wait for the action to finish, or stop it first.'
} as const
const error = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: true })

/**
 * The object dialogs (SSMS's Delete Object, and later Database Properties): at most one open. Opening describes the
 * object in the backend; OK builds the definition's request and executes it, closing on success; the Script button
 * scripts the same request to a new query, a file or the clipboard and leaves the dialog open, as SSMS does. Stop
 * cancels a running action in SQL Server. Failures are values in the snapshot; nothing throws into React.
 */
export class ObjectDialogService extends SnapshotStore<ObjectDialogSnapshot> implements Disposable {
  private readonly newId: () => string
  private readonly unsubscribe: () => void
  private dialogs = 0
  /** The request in flight (describe, script or execute), so Stop and a disconnect can cancel it. */
  private request?: { readonly id: string; readonly dialog: number }
  private disposed = false

  constructor(private readonly options: ObjectDialogServiceOptions) {
    super({})
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.unsubscribe = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (failure) { onUnexpectedError(failure) } })
  }

  get current(): OpenObjectDialog | undefined { return this.getSnapshot().open }

  /** Opens `dialog` for an Object Explorer node and describes it; refused while another dialog is open. */
  open(dialog: DialogId, node: ExplorerMenuNode): void {
    if (this.disposed) return
    if (this.current) throw new Error('Close the open dialog first.')
    const target = node.ref.type === 'object' ? node.ref.object : undefined
    const connection = this.options.connections.getSnapshot().find(item => item.id === node.connectionId && !item.lost)
    if (!target || !connection) throw new Error('Connect to the server first.')
    const open: OpenObjectDialog = {
      id: ++this.dialogs, dialog, connectionId: node.connectionId, nodeId: node.id, target, label: scriptObjectLabel(target), server: connection.server,
      ...(connection.login ? { login: connection.login } : {}), page: dialogSpecs[dialog].pages[0].id, phase: 'loading'
    }
    this.publish({ open })
    void this.describe(open)
  }
  setPage(page: PageId): void {
    const open = this.current
    if (open && dialogSpecs[open.dialog].pages.some(item => item.id === page)) this.update(open, { page })
  }
  updateDraft(patch: Partial<DialogDraft>): void {
    const open = this.current
    if (open?.draft && open.phase !== 'executing' && open.phase !== 'disconnected') this.update(open, { draft: { ...open.draft, ...patch } })
  }

  /** The Script button: the action's script to `destination`; the dialog stays open. */
  async script(destination: ScriptDestination): Promise<void> {
    const open = this.current
    if (!open || !open.model || !open.draft || (open.phase !== 'ready' && open.phase !== 'failed' && open.phase !== 'stopped')) return
    const built = dialogDefinitions[open.dialog].request(open.target, open.model, open.draft)
    if (!built || 'problem' in built) { if (built) this.update(open, { error: error('NOT_SUPPORTED', built.problem) }); return }
    const requestId = this.begin(open)
    this.update(open, { phase: 'scripting', error: undefined, notice: undefined })
    const result = await this.call(() => this.options.api.scriptObjectAction({ ...built, connectionId: open.connectionId, requestId } as ActionRequest))
    if (!this.end(open, requestId)) return
    const failure = !result.ok ? error('SQL_ERROR', result.error) : result.value.error
    if (failure || !result.ok || result.value.text === undefined) { this.update(open, { phase: 'ready', error: failure ?? error('SQL_ERROR', 'No script was produced.') }); return }
    try {
      const notice = await deliverScript({ destination, text: result.value.text, database: result.value.database, connectionId: open.connectionId, fileName: scriptFileName(open.target) }, this.options)
      this.update(open, { phase: 'ready', ...(notice ? { notice } : {}) })
    } catch (failure) { this.update(open, { phase: 'ready', error: error('SQL_ERROR', failure instanceof Error ? failure.message : 'The script could not be delivered.') }) }
  }

  /** OK: nothing to do closes; otherwise the action runs, and success closes and runs the definition's afterSuccess. */
  async ok(): Promise<void> {
    const open = this.current
    if (!open || open.phase === 'executing' || open.phase === 'scripting' || open.phase === 'loading') return
    if (open.phase === 'disconnected' || open.phase === 'loadFailed' || !open.model || !open.draft) { this.close(); return }
    const definition = dialogDefinitions[open.dialog]
    const built = definition.request(open.target, open.model, open.draft)
    if (!built) { this.close(); return }
    if ('problem' in built) { this.update(open, { error: error('NOT_SUPPORTED', built.problem) }); return }
    const requestId = this.begin(open)
    this.update(open, { phase: 'executing', error: undefined, notice: undefined, steps: undefined })
    const result = await this.call(() => this.options.api.executeObjectAction({ ...built, connectionId: open.connectionId, requestId } as ActionRequest))
    if (!this.end(open, requestId)) return
    const value: ActionExecuteResult | undefined = result.ok ? result.value : undefined
    if (value && !value.error) {
      this.publish({})
      try { definition.afterSuccess({ refreshListing: () => this.refreshListing(open) }) } catch (failure) { onUnexpectedError(failure) }
      return
    }
    // Steps that completed before a failure or Stop changed the object (a database dropped, then its history step
    // stopped), so the listing shows what is there now.
    if (value?.steps.some(step => step.status === 'done')) this.refreshListing(open)
    // Stop: the backend answers once SQL Server has ended the statement, saying what completed before it.
    if (value?.error?.code === 'CANCELLED') { this.update(open, { phase: 'stopped', error: value.error, steps: value.steps }); return }
    if (!result.ok && result.code === 'CANCELLED') { this.update(open, { phase: 'stopped', error: error('CANCELLED', dialogMessages.stopped) }); return }
    const failure = value?.error ?? (!result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST') ? error('CONNECTION_LOST', unknownOutcomeMessage) : error('SQL_ERROR', result.ok ? 'The action failed.' : result.error))
    this.update(open, { phase: 'failed', error: failure, ...(value ? { steps: value.steps } : {}) })
  }

  /** Stop: cancels the running action in SQL Server; the dialog reports Stopped, with what completed, when its answer comes. */
  stop(): void {
    const open = this.current, request = this.request
    if (!open || !request || request.dialog !== open.id) return
    this.cancel([request.id])
  }

  /** Cancel or Escape. Refused while an action runs (Stop first); returns whether the dialog closed. */
  close(): boolean {
    const open = this.current
    if (!open) return true
    if (open.phase === 'executing') return false
    if (this.request?.dialog === open.id) { this.cancel([this.request.id]); this.request = undefined }
    this.publish({})
    return true
  }

  dispose(): void {
    if (this.disposed) return
    if (this.request) this.cancel([this.request.id])
    this.request = undefined
    this.disposed = true
    this.unsubscribe()
    this.clearListeners()
  }

  private async describe(open: OpenObjectDialog): Promise<void> {
    const requestId = this.begin(open)
    const result = await this.call(() => this.options.api.describeObject({ connectionId: open.connectionId, requestId, dialog: open.dialog, target: open.target }))
    if (!this.end(open, requestId)) return
    const failure = !result.ok ? error('SQL_ERROR', result.error) : result.value.error
    const model = result.ok ? result.value.deleteTarget : undefined
    if (failure || !model) { this.update(open, { phase: 'loadFailed', error: failure ?? error('NOT_FOUND', 'The object could not be read.') }); return }
    this.update(open, { phase: 'ready', model, draft: dialogDefinitions[open.dialog].initialDraft(model, open.target) })
  }
  private async call<T>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try { return await send() } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } }
  }
  private begin(open: OpenObjectDialog): string {
    const id = this.newId()
    this.request = { id, dialog: open.id }
    return id
  }
  /** Whether the answer still matters: its dialog is open and not disconnected. */
  private end(open: OpenObjectDialog, requestId: string): boolean {
    if (this.request?.id === requestId) this.request = undefined
    const current = this.current
    return !this.disposed && current?.id === open.id && current.phase !== 'disconnected'
  }
  private update(open: OpenObjectDialog, patch: Partial<OpenObjectDialog>): void {
    const current = this.current
    if (this.disposed || current?.id !== open.id) return
    const next = { ...current, ...patch } as OpenObjectDialog & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.publish({ open: next })
  }
  private refreshListing(open: OpenObjectDialog): void {
    const folder = this.options.explorer.listingFolderOf(open.nodeId)
    if (folder !== undefined) this.options.explorer.refresh(folder)
  }
  /** A server that disconnects leaves only Close; its request is cancelled. */
  private connectionsChanged(): void {
    const open = this.current
    if (!open || open.phase === 'disconnected' || this.options.connections.getSnapshot().some(item => item.id === open.connectionId && !item.lost)) return
    if (this.request?.dialog === open.id) { this.cancel([this.request.id]); this.request = undefined }
    // An action that was running may or may not have finished.
    this.update(open, { phase: 'disconnected', error: error('CONNECTION_LOST', open.phase === 'executing' ? unknownOutcomeMessage : dialogMessages.disconnected) })
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
