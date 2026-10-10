import type { ServerObjectKind } from '../../../shared/contracts'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ExplorerNode } from '../menus/targets'

/**
 * Where an Object Explorer list sits: `['s', connectionId]` is a server, `[…, 'd']` its databases and
 * `[…, 'd', database, 't']` a database's tables, `[…, 'x']` its security folders and `[…, 'x', kind]` one of them.
 */
export type ExplorerPath = readonly string[]
/** The lists Object Explorer loads, by path. */
export const explorerPaths = {
  databases: (connectionId: string): ExplorerPath => ['s', connectionId, 'd'],
  tables: (connectionId: string, database: string): ExplorerPath => ['s', connectionId, 'd', database, 't'],
  serverObjects: (connectionId: string, kind: ServerObjectKind): ExplorerPath => ['s', connectionId, 'x', kind]
}

/**
 * The path Refresh reloads for a node: its own lists, a leaf's parent list (until leaves have children), and
 * everything for the empty area or no node.
 */
export function refreshPath(node: ExplorerNode | undefined): ExplorerPath | undefined {
  switch (node?.kind) {
    case 'server': return ['s', node.connectionId]
    case 'databasesFolder': case 'systemDatabasesFolder': case 'snapshotsFolder': return explorerPaths.databases(node.connectionId)
    case 'database': return ['s', node.connectionId, 'd', node.database]
    case 'tablesFolder': case 'table': return explorerPaths.tables(node.connectionId, node.database)
    case 'securityFolder': return ['s', node.connectionId, 'x']
    case 'serverObjectsFolder': case 'serverObject': return explorerPaths.serverObjects(node.connectionId, node.objectKind)
    default: return undefined
  }
}

/** Beyond this many refreshed paths, the next refresh reloads everything and forgets them. */
const maxRefreshedPaths = 10_000
// JSON keeps names with any character (dots, quotes, brackets) apart.
const keyOf = (path: ExplorerPath) => JSON.stringify(path)

/**
 * Which Object Explorer lists to load again. Each list reads `version(path)`, which changes when its path or any
 * prefix of it is refreshed, so refreshing a Tables folder reloads only that list while refreshing its server reloads
 * every list below the server. Versions are revisions of one counter, so a refreshed list never sees an old version again.
 */
export class ExplorerService extends SnapshotStore<{ readonly revision: number }> implements Disposable {
  private revision = 0
  /** Every list is at least this version: the revision of the latest refresh of everything. */
  private epoch = 0
  private readonly refreshed = new Map<string, number>()
  constructor() { super({ revision: 0 }) }

  version(path: ExplorerPath): number {
    let version = this.epoch
    for (let length = 1; length <= path.length; length++) version = Math.max(version, this.refreshed.get(keyOf(path.slice(0, length))) ?? 0)
    return version
  }
  /** Reloads the lists at and below `path`; without one, every list. */
  refresh(path?: ExplorerPath): void {
    this.revision++
    if (!path?.length || this.refreshed.size >= maxRefreshedPaths) { this.refreshed.clear(); this.epoch = this.revision }
    else this.refreshed.set(keyOf(path), this.revision)
    this.publish({ revision: this.revision })
  }
  /** Drops what a disconnected server's lists remembered; its explorer is gone with it. */
  forget(connectionId: string): void {
    const server = keyOf(['s', connectionId]), below = server.slice(0, -1) + ','
    for (const key of [...this.refreshed.keys()]) if (key === server || key.startsWith(below)) this.refreshed.delete(key)
  }
  dispose(): void { this.clearListeners(); this.refreshed.clear() }
}
