import type { ApiResult, ConnectionOptions } from '../../../shared/contracts'
import type { ConnectionDetails } from '../../../shared/connection-targets'
import { adoptConnection, type OpenedConnection } from './connection-opening'
import type { ConnectionAttempt, ConnectionService, TargetConnectionInfo } from './connections'

interface ConnectionReceiptApi {
  acceptConnectionRequest(requestId: string): Promise<ApiResult<{ readonly accepted: boolean; readonly retained: boolean }>>
  cancelConnectionRequests(requestIds: string[]): Promise<unknown>
}

/** Main retains transport ownership until this receipt is accepted. Renderer cancellation never closes a handle. */
export async function acceptConnectionReceipt({ api, connections, info, options, details, attempt, requestId, current = () => true, explicitlyCancelled = () => false, onAdopted, signal }: {
  api: ConnectionReceiptApi
  connections: ConnectionService
  info: TargetConnectionInfo & { readonly credentialUpdated?: true }
  options: ConnectionOptions
  details: ConnectionDetails
  attempt: ConnectionAttempt
  requestId: string
  current?: () => boolean
  /** The picker's Stop/close intent, distinct from a foreground lease aborting background work. */
  explicitlyCancelled?: () => boolean
  /** Synchronous canonical ownership notification, before main's asynchronous receipt acknowledgement. */
  onAdopted?: (connection: OpenedConnection) => void
  signal?: AbortSignal
}): Promise<OpenedConnection | undefined> {
  const release = () => api.cancelConnectionRequests([requestId]).catch(() => {})
  if (!current() || signal?.aborted || !info.targetId || !info.authentication) {
    connections.failAttempt(attempt, 'cancelled')
    await release()
    return
  }
  const abort = () => association.abandon(explicitlyCancelled())
  const association = connections.beginAssociationHandoff(attempt, { id: info.id, generation: info.generation, targetId: info.targetId }, () => signal?.removeEventListener('abort', abort))
  signal?.addEventListener('abort', abort, { once: true })
  let transferred = false
  try {
    let adopted: OpenedConnection | undefined
    try { adopted = adoptConnection(connections, info, options, details, attempt) }
    finally { association.adopted(info.targetId) }
    if (!adopted) { connections.failAttempt(attempt); await release(); return }
    const opened = { ...adopted, association }
    if (signal?.aborted) { association.abandon(explicitlyCancelled()); await release(); return }
    if (info.credentialUpdated && !connections.connectionTargets.reconcileAuthentication({ id: info.id, generation: info.generation }, info.authentication)) {
      await release()
      return
    }
    onAdopted?.(opened)
    const accepted = await api.acceptConnectionRequest(requestId)
    // A failed IPC says nothing about shared transport ownership. Only main's explicit retained:false is proof of loss.
    if (!accepted.ok) throw new Error(accepted.error)
    if (!accepted.value.retained) {
      const registry = connections.connectionTargets, target = opened.targetId ? registry.get(opened.targetId) : undefined
      const state = target?.lifecycle
      if (explicitlyCancelled() && target && state?.state === 'connected' && state.handle.id === info.id && state.handle.generation === info.generation) {
        // Main proved nobody retained this transport. Persist Stop without changing any joined caller's connection.
        const operation = registry.beginDisconnect(target.id, crypto.randomUUID())
        if (operation) registry.completeDisconnect(operation)
        if (attempt.created && attempt.operation.targetId === target.id) registry.removeFromExplorer(target.id)
      } else registry.markHandleLost({ id: info.id, generation: info.generation }, 'cancelled')
    }
    if (!accepted.value.accepted || !accepted.value.retained || !current() || signal?.aborted) return
    const connection = connections.get(opened.targetId ?? opened.id)
    if (!connection || !connections.isLive(connection.id) || connection.id !== opened.id || connection.generation !== opened.generation) return
    if (connections.bindingRevision(connection) !== opened.bindingRevision) return
    transferred = true
    return opened
  } finally {
    if (!transferred) association.abandon(explicitlyCancelled())
  }
}
