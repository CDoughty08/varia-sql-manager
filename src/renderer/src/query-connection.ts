import type { ConnectionTarget } from '../../shared/connection-targets'
import type { QueryDocument } from './documents'
import type { LiveConnection } from './services/connections'

/** Remembered metadata is presentation only. A live handle must still be attached to this document. */
export function queryConnectionPresentation(document: Pick<QueryDocument, 'targetId' | 'lastServer'>, connection?: LiveConnection, target?: ConnectionTarget) {
  const remembered = target?.id === document.targetId ? target : undefined
  const server = remembered?.options.server ?? connection?.server ?? document.lastServer
  const displayName = remembered ? remembered.details.displayName : connection?.displayName
  const lifecycle = remembered?.lifecycle
  const disconnected = !connection || !!connection.lost || !!lifecycle && (!(lifecycle.state === 'connected' || lifecycle.state === 'disconnecting') || lifecycle.handle.id !== connection.id || lifecycle.handle.generation !== connection.generation)
  return {
    server, displayName, disconnected,
    environment: remembered ? remembered.details.environment : connection?.options.environment,
    color: remembered ? remembered.details.color : connection?.color,
    label: server ? `${displayName ? `${displayName} (${server})` : server}${disconnected ? ' Disconnected' : ''}` : 'Disconnected'
  }
}
