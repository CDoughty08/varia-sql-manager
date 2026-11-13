import type { BackendConnectionHandle } from '../../../shared/connection-targets'
import type { SessionEnd } from '../../../shared/sessions'
import type { DisconnectPromptRequest, DisconnectChoice } from '../disconnect/DisconnectPromptService'
import type { ConnectionOperation, ConnectionTargetService } from './connection-targets'
import type { PreparedQueryClose } from './files'
import type { PreparedSessions } from './queries'

export type DisconnectMode = 'disconnect' | 'remove-from-explorer'
export interface DisconnectDocument {
  readonly id: string
  readonly name: string
  readonly targetId?: string
  readonly connectionId?: string
  readonly database: string
  readonly revision: number
  readonly dirty: boolean
  readonly query: boolean
  readonly running: boolean
}
export type DisconnectResult =
  | { readonly status: 'disconnected'; readonly closed: readonly string[]; readonly removed: boolean; readonly warning?: string }
  | { readonly status: 'cancelled' | 'not-connected' | 'busy' }
  | { readonly status: 'failed' | 'stale' | 'blocked'; readonly error: string }

/** One workbench owns this host, including popouts. It adapts durable target IDs to transport/session APIs. */
export interface DisconnectHost {
  readonly targets: Pick<ConnectionTargetService, 'get' | 'operation' | 'subscribe' | 'beginDisconnect' | 'completeDisconnect' | 'failDisconnect' | 'removeFromExplorer' | 'cancelConnect'>
  documents(): readonly DisconnectDocument[]
  busy(): boolean
  runTask(action: () => Promise<void>): Promise<void>
  refusal(targetId: string, handle: BackendConnectionHandle): string | undefined
  confirm(request: DisconnectPromptRequest): Promise<DisconnectChoice>
  prepareClose(ids: readonly string[]): Promise<PreparedQueryClose | undefined>
  validateClose(plan: PreparedQueryClose): void
  prepareSessions(ids: readonly string[]): Promise<PreparedSessions | undefined>
  cancelSessions(plan: PreparedSessions): Promise<void>
  endSession(id: string, transaction: SessionEnd): Promise<void>
  disconnect(handle: BackendConnectionHandle): Promise<void>
  /** Clear transport/session bindings, stop dependent work, and keep target/database/text/dirty state/results. No await. */
  detached(targetId: string, handle: BackendConnectionHandle): void
  /** Atomic local close after successful transport teardown. Normal close events must release results and file leases. */
  closeQueries(plan: PreparedQueryClose): void
}

const sameHandle = (a: BackendConnectionHandle, b: BackendConnectionHandle) => a.id === b.id && a.generation === b.generation
const sameDocuments = (a: readonly DisconnectDocument[], b: readonly DisconnectDocument[]) => {
  if (a.length !== b.length) return false
  const current = new Map(b.map(document => [document.id, document]))
  return a.every(document => {
    const next = current.get(document.id)
    return next && document.targetId === next.targetId && document.connectionId === next.connectionId && document.database === next.database &&
      document.name === next.name && document.revision === next.revision && document.dirty === next.dirty && document.query === next.query
  })
}
const message = (error: unknown) => error instanceof Error ? error.message : 'The disconnect failed.'

/** Complete review first, then session changes, then teardown, then local close. No user cancellation after mutation. */
export class DisconnectCoordinator {
  private readonly pending = new Map<string, { readonly mode: DisconnectMode; readonly promise: Promise<DisconnectResult> }>()
  constructor(private readonly host: DisconnectHost, private readonly attemptId: () => string = () => crypto.randomUUID()) {}

  disconnect(targetId: string, mode: DisconnectMode = 'disconnect'): Promise<DisconnectResult> {
    const pending = this.pending.get(targetId)
    if (pending) return pending.mode === mode ? pending.promise : Promise.resolve({ status: 'busy' })
    const promise = this.perform(targetId, mode)
    this.pending.set(targetId, { mode, promise })
    void promise.finally(() => { if (this.pending.get(targetId)?.promise === promise) this.pending.delete(targetId) })
    return promise
  }

  private async perform(targetId: string, mode: DisconnectMode): Promise<DisconnectResult> {
    const { host } = this, target = host.targets.get(targetId)
    if (!target) return { status: 'not-connected' }
    if (target.lifecycle.state === 'connecting') {
      host.targets.cancelConnect(targetId)
      const removed = mode === 'remove-from-explorer' && host.targets.removeFromExplorer(targetId)
      return { status: 'disconnected', closed: [], removed }
    }
    if (target.lifecycle.state !== 'connected') {
      if (mode === 'remove-from-explorer' && host.targets.removeFromExplorer(targetId)) return { status: 'disconnected', closed: [], removed: true }
      return { status: 'not-connected' }
    }
    if (host.busy()) return { status: 'busy' }
    const handle = target.lifecycle.handle
    const attached = () => host.documents().filter(document => document.targetId === targetId || !document.targetId && document.connectionId === handle.id)
    const live = () => {
      const current = host.targets.get(targetId)
      return current?.lifecycle.state === 'connected' && sameHandle(current.lifecycle.handle, handle) && !host.targets.operation(targetId)
    }
    // A disconnect/reconnect during a prompt must invalidate it even if the backend reuses a handle value.
    let invalidated = false
    const unsubscribe = host.targets.subscribe(() => { if (!live()) invalidated = true })
    let operation: ConnectionOperation | undefined, completed = false, teardownRequested = false
    const ended: string[] = []
    let result: DisconnectResult = { status: 'busy' }
    try {
      await host.runTask(async () => {
        let approved = attached()
        const validate = (sessions?: PreparedSessions) => {
          if (invalidated || !live()) throw new Error('The connection changed while confirming disconnect. Review its current state before trying again.')
          const refusal = host.refusal(targetId, handle)
          if (refusal) throw new Error(refusal)
          if (!sameDocuments(approved, attached()) || sessions && !sessions.current()) throw new Error('An affected document or query session changed while confirming disconnect. Review the latest state before trying again.')
        }
        const refusal = host.refusal(targetId, handle)
        if (refusal) { result = { status: 'blocked', error: refusal }; return }
        // A query-only Disconnect retains target context but is not attached to this transport.
        const queries = approved.filter(document => document.query && document.connectionId === handle.id)
        const choice = queries.length ? await host.confirm({ targetId, name: target.details.displayName ?? target.options.server, tabs: queries.map(({ id, name, dirty, running }) => ({ id, name, dirty, running })) }) : 'keep-tabs'
        if (choice === 'cancel') { result = { status: 'cancelled' }; return }
        validate()
        let close: PreparedQueryClose | undefined
        if (choice === 'close-query-tabs') {
          close = await host.prepareClose(queries.map(document => document.id))
          if (!close) { result = { status: 'cancelled' }; return }
          // Only queries in the close plan may change through Save. Other drafts and remembered refs stay as reviewed.
          const now = attached()
          const closing = new Set(queries.map(document => document.id))
          if (!sameDocuments(approved.filter(document => !closing.has(document.id)), now.filter(document => !closing.has(document.id)))) throw new Error('A dependent document changed while confirming disconnect. Review the latest state before trying again.')
          const expected = new Set(approved.map(document => document.id))
          if (now.length !== approved.length || now.some(document => !expected.has(document.id))) throw new Error('The affected documents changed. Review the disconnect again.')
          approved = now
        }
        const sessions = await host.prepareSessions(queries.map(document => document.id))
        if (!sessions) { result = { status: 'cancelled' }; return }
        validate(sessions)
        if (close) host.validateClose(close)
        // From here choices are final. Failed cancellation/commit still leaves every tab open.
        await host.cancelSessions(sessions)
        validate(sessions)
        for (const [id, transaction] of sessions.plan) {
          validate(sessions)
          await host.endSession(id, transaction)
          ended.push(id)
        }
        validate(sessions)
        if (close) host.validateClose(close)
        unsubscribe()
        operation = host.targets.beginDisconnect(targetId, this.attemptId())
        if (!operation) throw new Error('The connection changed before disconnect could start.')
        if (host.targets.operation(targetId) !== operation) throw new Error('The disconnect operation was replaced before it reached the backend.')
        teardownRequested = true
        await host.disconnect(handle)
        if (!host.targets.completeDisconnect(operation)) {
          result = { status: 'stale', error: 'The backend or connection changed during disconnect. No tabs were closed; review the connection state.' }
          return
        }
        completed = true
        // Check before detaching: detach intentionally changes transport fields and provider revisions.
        const stillDisconnected = () => host.targets.get(targetId)?.lifecycle.state === 'disconnected' && !host.targets.operation(targetId)
        let warning = stillDisconnected() ? undefined : 'The old connection disconnected, but the target changed again. All query tabs stayed open.'
        if (close && !warning) {
          try {
            if (!sameDocuments(approved, attached())) throw new Error('An affected document changed during disconnect.')
            host.validateClose(close)
          } catch (error) { warning = `${message(error)} The server disconnected, and all query tabs stayed open.` }
        }
        if (close && !warning) host.closeQueries(close)
        host.detached(targetId, handle)
        const removed = mode === 'remove-from-explorer' && stillDisconnected() && host.targets.removeFromExplorer(targetId)
        result = { status: 'disconnected', closed: close && !warning ? queries.map(document => document.id) : [], removed, ...warning ? { warning } : {} }
      })
      return result
    } catch (error) {
      if (operation && !completed) host.targets.failDisconnect(operation)
      const partial = ended.length ? ` ${ended.length} query session${ended.length === 1 ? ' already ended' : 's already ended'} as selected; those changes cannot be undone.` : ''
      const uncertain = teardownRequested && !completed ? ' The disconnect outcome may be unknown. No tabs were closed; verify the connection before retrying.' : ''
      return { status: completed ? 'failed' : invalidated ? 'stale' : 'failed', error: `${message(error)}${uncertain}${partial}` }
    } finally { unsubscribe() }
  }
}
