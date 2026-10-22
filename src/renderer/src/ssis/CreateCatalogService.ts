import type { ActionStep } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { SsisCatalogSetup, SsisError, SsisExecuteResult } from '../../../shared/ssis/schema.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'
import type { LiveConnection } from '../services/connections'

/** loading → ready, or loadFailed; Create → executing → closed, or failed (or stopped); a lost server → disconnected. */
export type CreateCatalogPhase = 'loading' | 'ready' | 'loadFailed' | 'executing' | 'failed' | 'stopped' | 'disconnected'
export interface OpenCreateCatalog {
  /** Changes with every dialog, so the form remounts (and its password fields start empty). */
  readonly id: number
  readonly connectionId: string
  /** The Integration Services Catalogs folder it was opened from, which reloads after the catalog is created. */
  readonly nodeId: number
  readonly server: string
  readonly login?: string
  readonly phase: CreateCatalogPhase
  readonly setup?: SsisCatalogSetup
  /** The CLR checkbox: checked, and fixed, when CLR integration is already in use. */
  readonly enableClr: boolean
  /** "Enable automatic execution of Integration Services stored procedure at SQL Server startup". */
  readonly startupProcedure: boolean
  /** Stop was pressed: from the restore on Create Catalog finishes instead, so the dialog waits for its answer. */
  readonly stopping?: boolean
  readonly error?: SsisError
  readonly steps?: readonly ActionStep[]
  /** What the form needs before Create can run (SSMS's own words); the password never appears in it. */
  readonly problem?: string
}
export interface CreateCatalogSnapshot { readonly open?: OpenCreateCatalog }
export interface CreateCatalogServiceOptions {
  readonly api: Pick<VariaApi, 'catalogSetupSsis' | 'executeSsis' | 'cancelSsis'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly explorer: { refresh(id?: number): void }
  readonly newId?: () => string
}

/** SSMS's Create Catalog messages, and Varia's for outcomes SSMS has none for. */
export const createCatalogMessages = {
  clr: 'CLR integration is not enabled. Enable CLR integration first.',
  empty: 'The password field cannot be empty. Input the password and try again.',
  mismatch: 'Passwords you have typed do not match. Retype the password.',
  disconnected: 'The server was disconnected.',
  unknown: 'The connection to the server was lost while Create Catalog ran, so whether the catalog was created is not known. Refresh Integration Services Catalogs to check.',
  stopped: 'Create Catalog was stopped before SQL Server confirmed it. Refresh Integration Services Catalogs to see whether the catalog exists.'
} as const
const failure = (code: SsisError['code'], message: string, retryable = true): SsisError => ({ code, message, retryable })

/**
 * The Create Catalog dialog's state (S9a): at most one open. Opening reads what Create Catalog would do on the server
 * (`ssis.catalogSetup`), or why it cannot; Create checks the form as SSMS does and runs `ssis.execute`'s createCatalog, and on
 * success reloads Integration Services Catalogs and closes. The password is never kept here: the form passes it to
 * `create` and forgets it with the dialog. Failures are values in the snapshot; nothing throws into React.
 */
export class CreateCatalogService extends SnapshotStore<CreateCatalogSnapshot> implements Disposable {
  private readonly newId: () => string
  private readonly unsubscribe: () => void
  private dialogs = 0
  private request?: { readonly id: string; readonly dialog: number }
  private disposed = false

  constructor(private readonly options: CreateCatalogServiceOptions) {
    super({})
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.unsubscribe = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (error) { onUnexpectedError(error) } })
  }

  get current(): OpenCreateCatalog | undefined { return this.getSnapshot().open }

  /** Opens the dialog for an Integration Services Catalogs folder; refused while one is open or without a live server. */
  open(node: ExplorerMenuNode): void {
    if (this.disposed) return
    if (this.current) throw new Error('Close the open dialog first.')
    const connection = this.options.connections.getSnapshot().find(item => item.id === node.connectionId && !item.lost)
    if (!connection || node.ref.type !== 'folder' || node.folder !== 'integrationServicesCatalogs') throw new Error('Select Integration Services Catalogs on a connected server.')
    const open: OpenCreateCatalog = {
      id: ++this.dialogs, connectionId: node.connectionId, nodeId: node.id, server: connection.server, ...(connection.login ? { login: connection.login } : {}),
      phase: 'loading', enableClr: false, startupProcedure: false
    }
    this.publish({ open })
    void this.load(open)
  }

  /** The CLR checkbox, while CLR integration is not in use (it is fixed otherwise). */
  setEnableClr(value: boolean): void {
    const open = this.current
    if (open && this.editable(open) && !open.setup?.clrEnabled) this.update(open, { enableClr: value, problem: undefined })
  }
  setStartupProcedure(value: boolean): void {
    const open = this.current
    if (open && this.editable(open)) this.update(open, { startupProcedure: value })
  }

  /** Create: checks the form as SSMS does (CLR agreed, a password, retyped alike), then runs Create Catalog. */
  async create(password: string, retyped: string): Promise<void> {
    const open = this.current
    if (!open || !open.setup || !this.editable(open)) return
    const problem = !open.enableClr ? createCatalogMessages.clr : password === '' ? createCatalogMessages.empty : password !== retyped ? createCatalogMessages.mismatch : undefined
    if (problem) { this.update(open, { problem }); return }
    const requestId = this.begin(open)
    this.update(open, { phase: 'executing', problem: undefined, error: undefined, steps: undefined, stopping: undefined })
    const result = await this.call<SsisExecuteResult>(() => this.options.api.executeSsis({
      connectionId: open.connectionId, requestId, action: { verb: 'createCatalog', password, enableClr: open.enableClr, startupProcedure: open.startupProcedure }
    }))
    if (!this.end(open, requestId)) return
    const value = result.ok ? result.value : undefined
    if (value && !value.error) {
      this.publish({})
      try { this.options.explorer.refresh(open.nodeId) } catch (error) { onUnexpectedError(error) }
      return
    }
    // A failure after the restore was undone, or Create Catalog stopped after enabling CLR: the folder shows what is there now.
    if (value?.steps.some(step => step.status === 'done')) this.refresh(open)
    if (value?.error?.code === 'CANCELLED') { this.update(open, { phase: 'stopped', error: value.error, steps: value.steps, stopping: undefined }); return }
    if (!result.ok && result.code === 'CANCELLED') { this.update(open, { phase: 'stopped', error: failure('CANCELLED', createCatalogMessages.stopped), stopping: undefined }); this.refresh(open); return }
    const error = value?.error ?? (!result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST') ? failure('CONNECTION_LOST', createCatalogMessages.unknown)
      : failure('SQL_ERROR', result.ok ? 'Create Catalog failed.' : result.error))
    if (!value) this.refresh(open)
    this.update(open, { phase: 'failed', error, stopping: undefined, ...(value ? { steps: value.steps } : {}) })
  }

  /** Stop: ends Create Catalog at once until its restore starts; after that the backend finishes and answers, which the dialog waits for. */
  stop(): void {
    const open = this.current, request = this.request
    if (!open || !request || request.dialog !== open.id || open.phase !== 'executing' || open.stopping) return
    this.update(open, { stopping: true })
    this.cancel([request.id])
  }

  /** Cancel or Escape. Refused while Create Catalog runs (Stop first); returns whether the dialog closed. */
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

  private editable(open: OpenCreateCatalog): boolean { return open.phase === 'ready' || open.phase === 'failed' || open.phase === 'stopped' }

  private async load(open: OpenCreateCatalog): Promise<void> {
    const requestId = this.begin(open)
    const result = await this.call(() => this.options.api.catalogSetupSsis({ connectionId: open.connectionId, requestId }))
    if (!this.end(open, requestId)) return
    const setup = result.ok ? result.value.setup : undefined
    if (!setup) { this.update(open, { phase: 'loadFailed', error: result.ok ? result.value.error ?? failure('SQL_ERROR', 'The server could not be read.') : failure('SQL_ERROR', result.error) }); return }
    // SSMS: the CLR box is checked and fixed when CLR integration is on; the startup box follows "scan for startup procs".
    this.update(open, { phase: 'ready', setup, enableClr: setup.clrEnabled, startupProcedure: setup.startupDefault })
  }
  private async call<T>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try { return await send() } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'The request failed.' } }
  }
  private begin(open: OpenCreateCatalog): string {
    const id = this.newId()
    this.request = { id, dialog: open.id }
    return id
  }
  /** Whether the answer still matters: its dialog is open and not disconnected. */
  private end(open: OpenCreateCatalog, requestId: string): boolean {
    if (this.request?.id === requestId) this.request = undefined
    const current = this.current
    return !this.disposed && current?.id === open.id && current.phase !== 'disconnected'
  }
  private update(open: OpenCreateCatalog, patch: Partial<OpenCreateCatalog>): void {
    const current = this.current
    if (this.disposed || current?.id !== open.id) return
    const next = { ...current, ...patch } as OpenCreateCatalog & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.publish({ open: next })
  }
  private refresh(open: OpenCreateCatalog): void {
    try { this.options.explorer.refresh(open.nodeId) } catch (error) { onUnexpectedError(error) }
  }
  /** A server that disconnects leaves only Close; its request is cancelled. */
  private connectionsChanged(): void {
    const open = this.current
    if (!open || open.phase === 'disconnected' || this.options.connections.getSnapshot().some(item => item.id === open.connectionId && !item.lost)) return
    if (this.request?.dialog === open.id) { this.cancel([this.request.id]); this.request = undefined }
    this.update(open, { phase: 'disconnected', stopping: undefined, error: failure('CONNECTION_LOST', open.phase === 'executing' ? createCatalogMessages.unknown : createCatalogMessages.disconnected) })
  }
  private cancel(ids: readonly string[]): void {
    try { void this.options.api.cancelSsis(ids).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (error) { onUnexpectedError(error) }
  }
}
