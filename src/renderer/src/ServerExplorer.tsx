import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ApiResult, ConnectionInfo, DatabaseInfo, ServerObjectInfo, ServerObjectKind, TableInfo } from '../../shared/contracts'
import Icon from './Icon'
import { useConnectionAccent } from './core/WorkbenchContext'

interface Props {
  connection: ConnectionInfo
  selectedDatabase?: string
  refresh: number
  canDisconnect: boolean
  onDatabases(id: string, databases: DatabaseInfo[]): void
  onSelect(id: string, database: string): void
  onScript(id: string, database: string, table: TableInfo): void
  onDisconnect(id: string): void
}

function useCatalogue<T>(enabled: boolean, refresh: number, load: () => Promise<ApiResult<T[]>>) {
  const [values, setValues] = useState<T[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const cache = useRef<{ refresh: number; load: typeof load } | null>(null)

  useEffect(() => {
    if (!enabled) { setBusy(false); return }
    if (cache.current?.refresh === refresh && cache.current.load === load) return
    let disposed = false
    setBusy(true)
    setError('')
    setReady(false)
    void load().then(result => {
      if (disposed) return
      if (!result.ok) throw new Error(result.error)
      setValues(result.value)
      setReady(true)
      cache.current = { refresh, load }
    }).catch(reason => {
      if (!disposed) {
        setValues([])
        setError(reason instanceof Error ? reason.message : 'Could not load objects.')
      }
    }).finally(() => { if (!disposed) setBusy(false) })
    return () => { disposed = true }
  }, [enabled, refresh, load])

  return { values, busy, error, ready }
}

function Folder({ label, count, defaultExpanded = false, reveal, children }: {
  label: string
  count?: number | string
  defaultExpanded?: boolean
  reveal?: string
  children: (expanded: boolean) => ReactNode
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  useEffect(() => { if (reveal) setExpanded(true) }, [reveal])
  return <div className="tree-folder" data-folder={label}>
    <button className="tree-heading" aria-label={label} aria-expanded={expanded} title={label} onClick={() => setExpanded(value => !value)}>
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

function DatabaseNode({ connectionId, value, selected, visible, refresh, onSelect, onScript }: {
  connectionId: string
  value: DatabaseInfo
  selected: boolean
  visible: boolean
  refresh: number
  onSelect: Props['onSelect']
  onScript: Props['onScript']
}) {
  const [expanded, setExpanded] = useState(selected)
  const [tablesExpanded, setTablesExpanded] = useState(true)
  useEffect(() => { if (selected) setExpanded(true) }, [selected])
  const load = useCallback(() => window.varia.tables(connectionId, value.name), [connectionId, value.name])
  const tables = useCatalogue(visible && expanded && tablesExpanded, refresh, load)

  return <div className="database-branch" data-database={value.name}>
    <div className={'database-row' + (selected ? ' selected' : '')}>
      <button className="node-toggle" aria-label={(expanded ? 'Collapse ' : 'Expand ') + value.name} aria-expanded={expanded} onClick={() => setExpanded(open => !open)}>
        <Icon name="chevron" className={expanded ? 'expanded' : ''} />
      </button>
      <button className="tree-node database-node" title={value.name} onClick={() => { setExpanded(true); onSelect(connectionId, value.name) }}>
        <Icon name="database" /><span className="node-label">{value.name}</span>
      </button>
    </div>
    <div className="database-objects tree-children" hidden={!expanded}>
      <button className="tree-heading" aria-label={'Tables in ' + value.name} aria-expanded={tablesExpanded} onClick={() => setTablesExpanded(open => !open)}>
        <Icon name="chevron" className={tablesExpanded ? 'expanded' : ''} /><Icon name="folder" className="folder-icon" />
        <span className="node-label">Tables</span><span className="tree-count">{tables.busy ? '…' : tables.ready ? tables.values.length : ''}</span>
      </button>
      <div className="tree-children" hidden={!tablesExpanded}>
        <CatalogueState {...tables} empty="No visible user tables." />
        {tables.ready && tables.values.map(table => <button key={JSON.stringify([table.schema, table.name])} className="tree-node table-node" title={'Script ' + table.schema + '.' + table.name + ' as CREATE using SMO'} onClick={() => onScript(connectionId, value.name, table)}>
          <Icon name="table" /><span className="node-label">{table.schema}.{table.name}</span>
        </button>)}
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

function SecurityFolder({ connectionId, kind, label, icon, visible, refresh }: typeof securityFolders[number] & {
  connectionId: string; visible: boolean; refresh: number
}) {
  const [expanded, setExpanded] = useState(false)
  const load = useCallback(() => window.varia.serverObjects(connectionId, kind), [connectionId, kind])
  const objects = useCatalogue<ServerObjectInfo>(visible && expanded, refresh, load)
  return <div className="tree-folder" data-folder={label}>
    <button className="tree-heading" aria-label={label} aria-expanded={expanded} title={label} onClick={() => setExpanded(open => !open)}>
      <Icon name="chevron" className={expanded ? 'expanded' : ''} /><Icon name="folder" className="folder-icon" />
      <span className="node-label">{label}</span>
      {(objects.busy || objects.ready) && <span className="tree-count">{objects.busy ? '…' : objects.values.length}</span>}
    </button>
    <div className="tree-children" hidden={!expanded}>
      <CatalogueState {...objects} empty="No visible objects." />
      {objects.ready && objects.values.map(object => <div key={object.name} className="tree-node object-node" title={object.name + ' — ' + object.description}>
        <Icon name={icon} /><span className="node-label">{object.name}</span>
      </div>)}
    </div>
  </div>
}

function ServerExplorer({ connection, selectedDatabase, refresh, canDisconnect, onDatabases, onSelect, onScript, onDisconnect }: Props) {
  const [expanded, setExpanded] = useState(true)
  const accent = useConnectionAccent(connection.color)
  const load = useCallback(() => window.varia.databases(connection.id), [connection.id])
  const databases = useCatalogue(true, refresh, load)
  useEffect(() => {
    if (databases.ready) onDatabases(connection.id, databases.values)
  }, [connection.id, databases.ready, databases.values, onDatabases])
  const systemDatabases = databases.values.filter(value => value.isSystem && !value.isSnapshot)
  const snapshots = databases.values.filter(value => value.isSnapshot)
  const userDatabases = databases.values.filter(value => !value.isSystem && !value.isSnapshot)
  const selectedSystem = systemDatabases.find(value => value.name === selectedDatabase)?.name
  const selectedSnapshot = snapshots.find(value => value.name === selectedDatabase)?.name
  const nodes = (values: DatabaseInfo[], visible: boolean) => values.map(value => <DatabaseNode key={value.name} connectionId={connection.id} value={value} selected={selectedDatabase === value.name} visible={visible} refresh={refresh} onSelect={onSelect} onScript={onScript} />)

  return <section className="server-section" aria-label={'Server ' + connection.server} style={{ borderLeft: accent ? `3px solid ${accent}` : undefined }}>
    <div className={'server-row' + (selectedDatabase ? ' selected' : '')}>
      <button className="server-toggle" data-pane-focus={selectedDatabase ? 'selected' : 'server'} aria-expanded={expanded} onClick={() => setExpanded(value => !value)} title={connection.server + ' (SQL Server ' + connection.serverVersion + ')'}>
        <Icon name="chevron" className={expanded ? 'expanded' : ''} /><Icon name="server" /><span>{connection.displayName || connection.server}</span>
      </button>
      <button className="icon-button" aria-label={'Disconnect ' + connection.server} title="Disconnect server" disabled={!canDisconnect} onClick={() => onDisconnect(connection.id)}><Icon name="disconnect" /></button>
    </div>
    <div className="server-objects tree-children" hidden={!expanded}>
      <Folder label="Databases" defaultExpanded count={databases.busy ? '…' : databases.ready ? databases.values.length : undefined} reveal={selectedDatabase}>
        {databasesExpanded => <>
          <CatalogueState {...databases} empty="No accessible databases." />
          <Folder label="System Databases" count={databases.ready ? systemDatabases.length : undefined} reveal={selectedSystem}>
            {systemExpanded => <>
              {databases.ready && !systemDatabases.length && <p className="explorer-hint">No accessible system databases.</p>}
              {nodes(systemDatabases, expanded && databasesExpanded && systemExpanded)}
            </>}
          </Folder>
          <Folder label="Database Snapshots" count={databases.ready ? snapshots.length : undefined} reveal={selectedSnapshot}>
            {snapshotsExpanded => <>
              {databases.ready && !snapshots.length && <p className="explorer-hint">No accessible database snapshots.</p>}
              {nodes(snapshots, expanded && databasesExpanded && snapshotsExpanded)}
            </>}
          </Folder>
          {nodes(userDatabases, expanded && databasesExpanded)}
        </>}
      </Folder>
      <Folder label="Security">
        {securityExpanded => securityFolders.map(folder => <SecurityFolder key={folder.kind} {...folder} connectionId={connection.id} visible={expanded && securityExpanded} refresh={refresh} />)}
      </Folder>
    </div>
  </section>
}

export default memo(ServerExplorer)
