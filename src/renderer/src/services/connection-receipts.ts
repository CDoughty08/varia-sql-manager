import type { ApiResult, ConnectionOptions } from '../../../shared/contracts'
import type { ConnectionDetails } from '../../../shared/connection-targets'
import { adoptConnection, type OpenedConnection } from './connection-opening'
import type { ConnectionAttempt, ConnectionService, TargetConnectionInfo } from './connections'

interface ConnectionReceiptApi {
  acceptConnectionRequest(requestId: string): Promise<ApiResult<{ readonly accepted: boolean; readonly retained: boolean }>>
  cancelConnectionRequests(requestIds: string[]): Promise<unknown>
}

/** Main retains transport ownership until this receipt is accepted. Renderer cancellation never closes a handle. */
export async function acceptConnectionReceipt({ api, connections, info, options, details, attempt, requestId, current = () => true, explicitlyCancelled = () => false }: {
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
}): Promise<OpenedConnection | undefined> {
  const release = () => api.cancelConnectionRequests([requestId]).catch(() => {})
  if (!current() || !info.targetId || !info.authentication) {
    connections.failAttempt(attempt, 'cancelled')
    await release()
    return
  }
  const opened = adoptConnection(connections, info, options, details, attempt)
  if (!opened) { connections.failAttempt(attempt); await release(); return }
  if (info.credentialUpdated && !connections.connectionTargets.reconcileAuthentication({ id: info.id, generation: info.generation }, info.authentication)) {
    await release()
    return
  }
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
  if (!accepted.value.accepted || !accepted.value.retained || !current()) return
  const connection = connections.get(opened.targetId ?? opened.id)
  if (!connection || !connections.isLive(connection.id) || connection.id !== opened.id || connection.generation !== opened.generation) return
  return opened
}
