import type { ConnectionOptions } from '../../../shared/contracts'
import { changedConnectionDetails, type ConnectionDetails } from '../../../shared/connection-targets'
import { detailsOf, type ConnectionAttempt, type ConnectionService, type LiveConnection, type TargetConnectionInfo } from './connections'
import type { ConnectionCompletion } from './connection-targets'

export interface OpenedConnection {
  readonly id: string
  readonly targetId?: string
  readonly generation: number
  readonly previousId?: string
  readonly sourceTargetId?: string
  readonly reused: boolean
  readonly current: ConnectionDetails
  readonly selected: ConnectionDetails
}

/** A successful main receipt is the sole equivalence evidence. Never compare profile keys or submitted settings here. */
export function adoptConnection(connections: ConnectionService, info: TargetConnectionInfo, options: ConnectionOptions, selected = detailsOf(options), attempt?: ConnectionAttempt, rejected?: (completion: ConnectionCompletion) => void): OpenedConnection | undefined {
  if (!info.targetId || !info.authentication) return undefined
  const authoritativeTarget = info.targetId
  const previous = connections.get(authoritativeTarget)
  const current = previous ? connections.details(previous.id)! : selected
  const result = connections.accept(info, options, authoritativeTarget, info.authentication, attempt)
  if (result.status !== 'accepted' && result.status !== 'already-current') { if (attempt) connections.failAttempt(attempt); rejected?.(result); return undefined }
  const connection = connections.get(authoritativeTarget)
  if (!connection || connection.lost) return undefined
  const reused = !!previous && !(attempt?.created && previous.targetId === attempt.operation.targetId)
  if (!reused) connections.setDetails(connection.id, selected)
  return { id: connection.id, targetId: connection.targetId, generation: connection.generation, previousId: reused ? previous?.id : undefined, sourceTargetId: attempt?.operation.targetId, reused, current, selected }
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
