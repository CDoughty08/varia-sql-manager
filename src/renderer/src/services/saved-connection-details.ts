import type { ConnectionProfile } from '../../../shared/connections'
import { changedConnectionDetails, type ConnectionDetails } from '../../../shared/connection-targets'
import { entryKey } from './environments'
import { detailsOf, type ConnectionService } from './connections'

const presentation = (details: ConnectionDetails) => JSON.stringify([details.displayName ?? '', details.color ?? '', details.environment ?? ''])

/**
 * A saved History entry's Name, Color, Environment and Reconnect on startup now label every Explorer connection with the
 * same server, database, login and settings, so a save shows at once in Object Explorer, query badges and the status bar.
 * Only the labels a save changes (`before` holds the previous ones) reach them; when aliases share those
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
  const fields = before ? changedConnectionDetails(before, next) : undefined
  if (fields && !fields.length) return 0
  let changed = 0
  for (const connection of connections.getSnapshot()) {
    const current = connections.details(connection.id)
    if (!current || entryKey(connection.options) !== key) continue
    if (aliased && presentation(current) !== presentation(before!)) continue
    // Only the labels this save changed: a connection-only environment survives a rename of its entry.
    const applied = fields ? { ...current, ...Object.fromEntries(fields.map(field => [field, next[field]])) } : next
    if (!changedConnectionDetails(current, applied).length) continue
    if (connections.setDetails(connection.id, applied)) changed++
  }
  return changed
}
