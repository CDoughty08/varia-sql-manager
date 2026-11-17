import type { ConnectionProfile } from '../../../shared/connections'
import { changedConnectionDetails, type ConnectionDetails } from '../../../shared/connection-targets'
import { entryKey } from './environments'
import { detailsOf, type ConnectionService } from './connections'

const presentation = (details: ConnectionDetails) => JSON.stringify([details.displayName ?? '', details.color ?? '', details.environment ?? ''])

/**
 * A saved History entry's Name, Color, Environment and Reconnect on startup now label every Explorer connection with the
 * same server, database, login and settings, so a save shows at once in Object Explorer, query badges and the status bar.
 * Only a save that changes the entry's labels (`before` holds the previous ones) reaches them; when aliases share those
 * settings, only connections still showing this entry's previous labels follow it.
 * Returns how many connections changed.
 */
export function applySavedDetails(connections: Pick<ConnectionService, 'getSnapshot' | 'details' | 'setDetails'>, profiles: readonly ConnectionProfile[], saved: ConnectionProfile, before?: ConnectionDetails): number {
  const key = entryKey(saved.options)
  if (key === undefined) return 0
  const aliased = profiles.filter(profile => entryKey(profile.options) === key).length > 1
  if (aliased && !before) return 0
  const next = detailsOf(saved.options, saved.autoReconnect ?? 'inherit')
  // A save that changed no labels (a History row's star, Register server) must not undo a connection-only label set
  // from the server menu.
  if (before && !changedConnectionDetails(before, next).length) return 0
  let changed = 0
  for (const connection of connections.getSnapshot()) {
    const current = connections.details(connection.id)
    if (!current || entryKey(connection.options) !== key) continue
    if (aliased && presentation(current) !== presentation(before!)) continue
    if (!changedConnectionDetails(current, next).length) continue
    if (connections.setDetails(connection.id, next)) changed++
  }
  return changed
}
