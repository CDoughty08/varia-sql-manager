import type { ConnectionOptions } from '../../../shared/contracts'
import { changedConnectionDetails, type ConnectionDetails } from '../../../shared/connection-targets'
import { detailsOf, type ConnectionAttempt, type ConnectionService, type LiveConnection, type TargetConnectionInfo } from './connections'
import type { ConnectionCompletion } from './connection-targets'

export interface OpenedConnection {
  readonly id: string
  readonly targetId?: string
  readonly generation: number
  readonly previousId?: string
  readonly reused: boolean
  readonly current: ConnectionDetails
  readonly selected: ConnectionDetails
}

/** A successful main receipt is the sole equivalence evidence. Never compare profile keys or submitted settings here. */
export function adoptConnection(connections: ConnectionService, info: TargetConnectionInfo, options: ConnectionOptions, selected = detailsOf(options), attempt?: ConnectionAttempt, legacyReconnect?: string, rejected?: (completion: ConnectionCompletion) => void): OpenedConnection | undefined {
  const authoritativeTarget = info.authentication ? info.targetId ?? connections.get(info.id)?.targetId ?? attempt?.operation.targetId : info.targetId
  const previous = connections.get(authoritativeTarget ?? info.id) ?? (legacyReconnect ? connections.get(legacyReconnect) : undefined)
  const current = previous ? connections.details(previous.id)! : selected
  if (authoritativeTarget && info.authentication) {
    const result = connections.accept(info, options, authoritativeTarget, info.authentication, attempt)
    if (result.status !== 'accepted' && result.status !== 'already-current') { if (attempt) connections.failAttempt(attempt); rejected?.(result); return undefined }
  } else {
    if (info.targetId) return undefined
    if (attempt && connections.connectionTargets.operation(attempt.operation.targetId) !== attempt.operation) return undefined
    if (attempt) connections.cancelAttempt(attempt)
    // Compatibility with the old IPC response. It can reuse the exact live handle, never infer a matching account.
    if (previous && !legacyReconnect && (previous.id !== info.id || previous.generation !== info.generation || previous.lost)) return undefined
    // Preserve the pre-migration explicit reconnect flow until the main request owner supplies target receipts.
    if (legacyReconnect && connections.get(legacyReconnect)?.lost) connections.replace(legacyReconnect, { ...info, displayName: current.displayName, color: current.color }, { ...options, displayName: current.displayName, color: current.color, environment: current.environment })
    else if (!previous) connections.add(info, options)
  }
  const connection = connections.get(authoritativeTarget ?? info.id)
  if (!connection || connection.lost) return undefined
  const reused = (!!previous && !(attempt?.created && previous.targetId === attempt.operation.targetId)) || !!legacyReconnect
  if (!reused) connections.setDetails(connection.id, selected)
  return { id: connection.id, targetId: connection.targetId, generation: connection.generation, previousId: reused ? previous?.id ?? legacyReconnect : undefined, reused, current, selected }
}

export function needsDetailsConfirmation(opened: OpenedConnection): boolean {
  return opened.reused && changedConnectionDetails(opened.current, opened.selected).length > 0
}

/** A dialog may outlive a disconnect, removal, backend loss or replacement connect. None may resurrect its target. */
export function finishConnectionDetails(connections: ConnectionService, opened: OpenedConnection, choice: 'selected' | 'current' | 'cancel'): LiveConnection | undefined {
  if (choice === 'cancel') return undefined
  const connection = connections.get(opened.targetId ?? opened.id)
  if (!connection || !connections.isLive(connection.id) || connection.inExplorer === false || connection.id !== opened.id || connection.generation !== opened.generation) return undefined
  if (changedConnectionDetails(connections.details(connection.id)!, opened.current).length && opened.reused) return undefined
  if (choice === 'selected') connections.setDetails(connection.id, opened.selected)
  return connections.get(connection.id)
}
