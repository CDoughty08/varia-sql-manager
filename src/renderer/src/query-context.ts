import type { DatabaseInfo } from '../../shared/contracts'
import type { LiveConnection } from './services/connections'

/** Tooltip text with the command's key on this platform, such as "Open File… (Ctrl+O)". */
export function withKey(text: string, label: { text: string } | undefined): string { return label ? `${text} (${label.text})` : text }
export const lostHint = "This query's connection was lost when the SQL backend restarted. Reconnect to run queries."

/** What a query's server and database lists show and allow: the same in its query bar and in the classic toolbar. */
export interface QueryContextInput {
  /** The document's connection, absent while disconnected. */
  readonly connectionId: string | undefined
  readonly database: string
  readonly connections: readonly LiveConnection[]
  /** The databases listed for the document's connection, when it is live. */
  readonly databases: readonly DatabaseInfo[]
  /** A query document: a value opened from the results or a table designer keeps its own server and database. */
  readonly query: boolean
  readonly running: boolean
  /** A document task (saving, closing, ending sessions) is under way. */
  readonly busy: boolean
}
export interface ServerOption { readonly id: string; readonly label: string; readonly disabled: boolean }
export interface QueryContextModel {
  readonly connection: LiveConnection | undefined
  /** The connection can run queries: it exists and was not lost with its backend. */
  readonly live: boolean
  /** Disconnected first, then every live connection, and the document's own lost one, which cannot be chosen again. */
  readonly servers: readonly ServerOption[]
  readonly serverDisabled: boolean
  /** The document's database first when the list lacks it (still loading, or dropped since). */
  readonly databases: readonly string[]
  readonly database: string
  readonly databaseDisabled: boolean
  /** The connection's name as the lists show it, for tooltips: `name (server)` or the server. */
  readonly serverName: string | undefined
}

export const serverLabel = (connection: Pick<LiveConnection, 'displayName' | 'server'>): string => connection.displayName ? `${connection.displayName} (${connection.server})` : connection.server

export function queryContextModel({ connectionId, database, connections, databases, query, running, busy }: QueryContextInput): QueryContextModel {
  const connection = connectionId ? connections.find(value => value.id === connectionId) : undefined
  const live = !!connection && !connection.lost
  const servers = [{ id: '', label: 'Disconnected', disabled: false }, ...connections.filter(value => !value.lost || value === connection)
    .map(value => ({ id: value.id, label: `${serverLabel(value)}${value.lost ? ' (connection lost)' : ''}`, disabled: !!value.lost }))]
  const listed = live ? databases.map(value => value.name) : []
  return {
    connection, live, servers, serverDisabled: !query || running || busy,
    databases: listed.includes(database) ? listed : [database, ...listed], database, databaseDisabled: !query || !live || running || busy,
    serverName: connection && serverLabel(connection)
  }
}

/** A control of a toolbar with one tab stop, as the toolbar sees it. */
export interface ToolbarControl { readonly disabled: boolean }
/**
 * The ARIA toolbar's one tab stop: the control used last while it is enabled, else the first enabled one. Undefined when
 * every control is disabled.
 */
export function toolbarStop<T extends ToolbarControl>(controls: readonly T[], last: T | undefined): T | undefined {
  return last && controls.includes(last) && !last.disabled ? last : controls.find(control => !control.disabled)
}
/** Where an arrow key, Home or End moves from `from` among the enabled controls, wrapping at the ends. */
export function toolbarMove<T extends ToolbarControl>(controls: readonly T[], from: T, key: string): T | undefined {
  const enabled = controls.filter(control => !control.disabled), at = enabled.indexOf(from)
  if (!enabled.length) return undefined
  switch (key) {
    case 'ArrowRight': return enabled[(at + 1) % enabled.length]
    case 'ArrowLeft': return enabled[at < 0 ? enabled.length - 1 : (at - 1 + enabled.length) % enabled.length]
    case 'Home': return enabled[0]
    case 'End': return enabled[enabled.length - 1]
    default: return undefined
  }
}
/**
 * Where focus goes when the focused control turns disabled (Execute once the query starts, Cancel once it ends): the
 * nearest enabled control, the one before it when two are as near, so Cancel hands focus back to Execute and Execute
 * on to Cancel.
 */
export function toolbarRescue<T extends ToolbarControl>(controls: readonly T[], lost: T): T | undefined {
  const at = controls.indexOf(lost)
  if (at < 0) return controls.find(control => !control.disabled)
  for (let distance = 1; distance < controls.length; distance++) {
    for (const index of [at - distance, at + distance]) if (index >= 0 && index < controls.length && !controls[index].disabled) return controls[index]
  }
  return undefined
}
