import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ApiResult, ConnectionInfo, DatabaseInfo, ServerObjectInfo, ServerObjectKind, TableInfo } from '../../shared/contracts'
import Icon from './Icon'
import { useConnectionAccent, useWorkbench } from './core/WorkbenchContext'
import { useCommandEnabled } from './core/useCommand'
import type { LiveConnection } from './services/connections'
import type { ExplorerNode, MenuTarget } from './menus/targets'
import { useMenuTarget } from './menus/useMenuTarget'
import { explorerPaths, type ExplorerPath } from './services/explorer'

interface Props {
  connection: ConnectionInfo
  selectedDatabase?: string
  canDisconnect: boolean
  onDatabases(id: string, databases: DatabaseInfo[]): void
  onSelect(id: string, database: string): void
  onDisconnect(id: string): void
}

const explorerTarget = (node: ExplorerNode): MenuTarget => ({ kind: 'explorer', node })
/** Gives a node's element its Object Explorer context menu. */
const useNodeTarget = <T extends Element>(node: () => ExplorerNode) => useMenuTarget<T>(() => explorerTarget(node()))

/** A list that loads while `enabled`, again whenever Refresh reaches `path` (the node itself or one above it). */
function useCatalogue<T>(enabled: boolean, path: ExplorerPath, load: () => Promise<ApiResult<T[]>>) {
  const { explorer } = useWorkbench()
  const version = useSyncExternalStore(explorer.subscribe, () => explorer.version(path))
  const [values, setValues] = useState<T[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const cache = useRef<{ version: number; load: typeof load } | null>(null)

  useEffect(() => {
    if (!enabled) { setBusy(false); return }
    if (cache.current?.version === version && cache.current.load === load) return
    let disposed = false
    setBusy(true)
    setError('')
    setReady(false)
    void load().then(result => {
      if (disposed) return
      if (!result.ok) throw new Error(result.error)
      setValues(result.value)
      setReady(true)
      cache.current = { version, load }
    }).catch(reason => {
      if (!disposed) {
        setValues([])
        setError(reason instanceof Error ? reason.message : 'Could not load objects.')
      }
    }).finally(() => { if (!disposed) setBusy(false) })
    return () => { disposed = true }
  }, [enabled, version, load])

  return { values, busy, error, ready }
}

function Folder({ label, node, count, defaultExpanded = false, reveal, children }: {
  label: string
  node: ExplorerNode
  count?: number | string
  defaultExpanded?: boolean
  reveal?: string
  children: (expanded: boolean) => ReactNode
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const target = useNodeTarget<HTMLButtonElement>(() => node)
  useEffect(() => { if (reveal) setExpanded(true) }, [reveal])
  return <div className="tree-folder" data-folder={label}>
    <button ref={target} className="tree-heading" aria-label={label} aria-expanded={expanded} title={label} onClick={() => setExpanded(value => !value)}>
      <Icon name="chevron" className={expanded ? 'expanded' : ''} /><Icon name="folder" className="folder-icon" />
      <span className="node-label">{label}</span>{count !== undefined && <span className="tree-count">{count}</span>}
    </button>
    <div className="tree-children" hidden={!expanded}>{children(expanded)}</div>
  </div>
}

function CatalogueState({ busy, error, ready, values, empty }: {
  busy: boolean; error: string; ready: boolean; values: unknown[]; empty: string
}) {
  return <>
    {busy && <p className="explorer-hint">Loading…</p>}
    {error && <p className="explorer-error" role="alert">{error}</p>}
    {ready && !busy && !values.length && <p className="explorer-hint">{empty}</p>}
  </>
}

/** A table: clicking it scripts CREATE in a new query; its menu has Select Top 1000 Rows and Script Table as. */
const TableNode = memo(function TableNode({ connectionId, database, table }: { connectionId: string; database: string; table: TableInfo }) {
  const { commands } = useWorkbench()
  const node = (): ExplorerNode => ({ kind: 'table', connectionId, database, schema: table.schema, name: table.name })
  const target = useNodeTarget<HTMLButtonElement>(node)
  return <button ref={target} className="tree-node table-node" title={'Script ' + table.schema + '.' + table.name + ' as CREATE using SMO'}
    onClick={() => void commands.execute('explorer.scriptCreateToNewQuery', { target: explorerTarget(node()) }, 'toolbar')}>
    <Icon name="table" /><span className="node-label">{table.schema}.{table.name}</span>
  </button>
})

function DatabaseNode({ connectionId, value, selected, visible, onSelect }: {
  connectionId: string
  value: DatabaseInfo
  selected: boolean
  visible: boolean
  onSelect: Props['onSelect']
}) {
  const [expanded, setExpanded] = useState(selected)
  const [tablesExpanded, setTablesExpanded] = useState(true)
  useEffect(() => { if (selected) setExpanded(true) }, [selected])
  const load = useCallback(() => window.varia.tables(connectionId, value.name), [connectionId, value.name])
  const tables = useCatalogue(visible && expanded && tablesExpanded, explorerPaths.tables(connectionId, value.name), load)
  // The whole row, so its expand button has the database's menu too.
  const row = useNodeTarget<HTMLDivElement>(() => ({ kind: 'database', connectionId, database: value.name }))
  const tablesFolder = useNodeTarget<HTMLButtonElement>(() => ({ kind: 'tablesFolder', connectionId, database: value.name }))

  return <div className="database-branch" data-database={value.name}>
    <div ref={row} className={'database-row' + (selected ? ' selected' : '')}>
      <button className="node-toggle" aria-label={(expanded ? 'Collapse ' : 'Expand ') + value.name} aria-expanded={expanded} onClick={() => setExpanded(open => !open)}>
        <Icon name="chevron" className={expanded ? 'expanded' : ''} />
      </button>
      <button className="tree-node database-node" title={value.name} onClick={() => { setExpanded(true); onSelect(connectionId, value.name) }}>
        <Icon name="database" /><span className="node-label">{value.name}</span>
      </button>
    </div>
    <div className="database-objects tree-children" hidden={!expanded}>
      <button ref={tablesFolder} className="tree-heading" aria-label={'Tables in ' + value.name} aria-expanded={tablesExpanded} onClick={() => setTablesExpanded(open => !open)}>
        <Icon name="chevron" className={tablesExpanded ? 'expanded' : ''} /><Icon name="folder" className="folder-icon" />
        <span className="node-label">Tables</span><span className="tree-count">{tables.busy ? '…' : tables.ready ? tables.values.length : ''}</span>
      </button>
      <div className="tree-children" hidden={!tablesExpanded}>
        <CatalogueState {...tables} empty="No visible user tables." />
        {/* The previous list stays while a refresh loads, so a focused table keeps focus through F5. */}
        {tables.values.map(table => <TableNode key={JSON.stringify([table.schema, table.name])} connectionId={connectionId} database={value.name} table={table} />)}
      </div>
    </div>
  </div>
}

const securityFolders: { kind: ServerObjectKind; label: string; icon: 'login' | 'role' | 'key' | 'shield' }[] = [
  { kind: 'logins', label: 'Logins', icon: 'login' },
  { kind: 'serverRoles', label: 'Server Roles', icon: 'role' },
  { kind: 'credentials', label: 'Credentials', icon: 'key' },
  { kind: 'cryptographicProviders', label: 'Cryptographic Providers', icon: 'key' },
  { kind: 'audits', label: 'Audits', icon: 'shield' },
  { kind: 'serverAuditSpecifications', label: 'Server Audit Specifications', icon: 'shield' }
]

function ObjectNode({ connectionId, kind, icon, object }: { connectionId: string; kind: ServerObjectKind; icon: typeof securityFolders[number]['icon']; object: ServerObjectInfo }) {
  const target = useNodeTarget<HTMLDivElement>(() => ({ kind: 'serverObject', connectionId, objectKind: kind, name: object.name }))
  return <div ref={target} className="tree-node object-node" title={object.name + ' — ' + object.description}>
    <Icon name={icon} /><span className="node-label">{object.name}</span>
  </div>
}

function SecurityFolder({ connectionId, kind, label, icon, visible }: typeof securityFolders[number] & { connectionId: string; visible: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const load = useCallback(() => window.varia.serverObjects(connectionId, kind), [connectionId, kind])
  const objects = useCatalogue<ServerObjectInfo>(visible && expanded, explorerPaths.serverObjects(connectionId, kind), load)
  const target = useNodeTarget<HTMLButtonElement>(() => ({ kind: 'serverObjectsFolder', connectionId, objectKind: kind }))
  return <div className="tree-folder" data-folder={label}>
    <button ref={target} className="tree-heading" aria-label={label} aria-expanded={expanded} title={label} onClick={() => setExpanded(open => !open)}>
      <Icon name="chevron" className={expanded ? 'expanded' : ''} /><Icon name="folder" className="folder-icon" />
      <span className="node-label">{label}</span>
      {(objects.busy || objects.ready) && <span className="tree-count">{objects.busy ? '…' : objects.values.length}</span>}
    </button>
    <div className="tree-children" hidden={!expanded}>
      <CatalogueState {...objects} empty="No visible objects." />
      {objects.values.map(object => <ObjectNode key={object.name} connectionId={connectionId} kind={kind} icon={icon} object={object} />)}
    </div>
  </div>
}

function ServerExplorer({ connection, selectedDatabase, canDisconnect, onDatabases, onSelect, onDisconnect }: Props) {
  const [expanded, setExpanded] = useState(true)
  const accent = useConnectionAccent(connection.color)
  const load = useCallback(() => window.varia.databases(connection.id), [connection.id])
  const databases = useCatalogue(true, explorerPaths.databases(connection.id), load)
  // The whole row, so the Disconnect button has the server's menu too.
  const row = useNodeTarget<HTMLDivElement>(() => ({ kind: 'server', connectionId: connection.id }))
  useEffect(() => {
    if (databases.ready) onDatabases(connection.id, databases.values)
  }, [connection.id, databases.ready, databases.values, onDatabases])
  const systemDatabases = databases.values.filter(value => value.isSystem && !value.isSnapshot)
  const snapshots = databases.values.filter(value => value.isSnapshot)
  const userDatabases = databases.values.filter(value => !value.isSystem && !value.isSnapshot)
  const selectedSystem = systemDatabases.find(value => value.name === selectedDatabase)?.name
  const selectedSnapshot = snapshots.find(value => value.name === selectedDatabase)?.name
  const nodes = (values: DatabaseInfo[], visible: boolean) => values.map(value => <DatabaseNode key={value.name} connectionId={connection.id} value={value} selected={selectedDatabase === value.name} visible={visible} onSelect={onSelect} />)
  const folderNode = (kind: 'databasesFolder' | 'systemDatabasesFolder' | 'snapshotsFolder' | 'securityFolder'): ExplorerNode => ({ kind, connectionId: connection.id })

  return <section className="server-section" aria-label={'Server ' + connection.server} style={{ borderLeft: accent ? `3px solid ${accent}` : undefined }}>
    <div ref={row} className={'server-row' + (selectedDatabase ? ' selected' : '')}>
      <button className="server-toggle" data-pane-focus={selectedDatabase ? 'selected' : 'server'} aria-expanded={expanded} onClick={() => setExpanded(value => !value)} title={connection.server + ' (SQL Server ' + connection.serverVersion + ')'}>
        <Icon name="chevron" className={expanded ? 'expanded' : ''} /><Icon name="server" /><span>{connection.displayName || connection.server}</span>
      </button>
      <button className="icon-button" aria-label={'Disconnect ' + connection.server} title="Disconnect server" disabled={!canDisconnect} onClick={() => onDisconnect(connection.id)}><Icon name="disconnect" /></button>
    </div>
    <div className="server-objects tree-children" hidden={!expanded}>
      <Folder label="Databases" node={folderNode('databasesFolder')} defaultExpanded count={databases.busy ? '…' : databases.ready ? databases.values.length : undefined} reveal={selectedDatabase}>
        {databasesExpanded => <>
          <CatalogueState {...databases} empty="No accessible databases." />
          <Folder label="System Databases" node={folderNode('systemDatabasesFolder')} count={databases.ready ? systemDatabases.length : undefined} reveal={selectedSystem}>
            {systemExpanded => <>
              {databases.ready && !systemDatabases.length && <p className="explorer-hint">No accessible system databases.</p>}
              {nodes(systemDatabases, expanded && databasesExpanded && systemExpanded)}
            </>}
          </Folder>
          <Folder label="Database Snapshots" node={folderNode('snapshotsFolder')} count={databases.ready ? snapshots.length : undefined} reveal={selectedSnapshot}>
            {snapshotsExpanded => <>
              {databases.ready && !snapshots.length && <p className="explorer-hint">No accessible database snapshots.</p>}
              {nodes(snapshots, expanded && databasesExpanded && snapshotsExpanded)}
            </>}
          </Folder>
          {nodes(userDatabases, expanded && databasesExpanded)}
        </>}
      </Folder>
      <Folder label="Security" node={folderNode('securityFolder')}>
        {securityExpanded => securityFolders.map(folder => <SecurityFolder key={folder.kind} {...folder} connectionId={connection.id} visible={expanded && securityExpanded} />)}
      </Folder>
    </div>
  </section>
}

/** A connection lost with its backend generation: collapsed, loading nothing, until it is reconnected or removed. */
export const LostServer = memo(function LostServer({ connection, canRemove, onReconnect, onRemove }: { connection: LiveConnection; canRemove: boolean; onReconnect(id: string): void; onRemove(id: string): void }) {
  const accent = useConnectionAccent(connection.color)
  // Disabled while the backend is not ready: connecting would only wait or fail.
  const canReconnect = useCommandEnabled('connection.reconnect')
  const name = connection.displayName || connection.server
  return <section className="server-section lost-server" aria-label={'Server ' + connection.server} style={{ borderLeft: accent ? `3px solid ${accent}` : undefined }}>
    <div className="server-row">
      <span className="lost-server-label" title={connection.server + ' — the connection was lost when the SQL backend restarted'}><span className="codicon codicon-debug-disconnect" aria-hidden="true" /><span className="node-label">{name} — connection lost</span></span>
    </div>
    <div className="lost-server-actions">
      <button disabled={!canReconnect} aria-label={'Reconnect ' + connection.server} onClick={() => onReconnect(connection.id)}>Reconnect…</button>
      <button disabled={!canRemove} aria-label={'Remove ' + connection.server} onClick={() => onRemove(connection.id)}>Remove</button>
    </div>
  </section>
})

export default memo(ServerExplorer)
