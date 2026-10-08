import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ApiResult, BackendHealth, ConnectionInfo, ConnectionOptions, DatabaseInfo, TableInfo } from '../../shared/contracts'
import { isCommandId } from '../../shared/commands/catalog'
import { shellContribution, type ShellHost } from './contributions/shell'
import type { QueryTab } from './documents'
import { useConnectionAccent, useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { useCommandEnabled, useKeybindingLabel } from './core/useCommand'
import type { CommandId } from './core/types'
import QueryEditor from './QueryEditor'
import Icon from './Icon'
import ServerExplorer from './ServerExplorer'
import QueryOutput from './QueryOutput'
import TitleBar from './TitleBar'
import DockWorkspace, { type WorkspaceHandle } from './DockWorkspace'
import ConnectDialog from './ConnectDialog'
import ThemeNotice from './ThemeNotice'
import QuickInput from './quickinput/QuickInput'
import MenuLayer from './menus/MenuLayer'
import { connectionDefaults } from '../../shared/connections'

const emptyTab: QueryTab = { id: '', name: '', dirty: false, savedVersionId: null, database: 'master' }
function unwrap<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(result.error); return result.value }
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The operation failed.' }
/** Tooltip text with the command's key on this platform, such as "Open SQL files (Ctrl+O)". */
function withKey(text: string, label: { text: string } | undefined): string { return label ? `${text} (${label.text})` : text }
/** A callback with a stable identity that always runs the latest render's logic, so memoized panes skip unrelated renders. */
function useStableCallback<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
  const latest = useRef(callback)
  latest.current = callback
  return useCallback((...args: A) => latest.current(...args), [])
}

export default function App() {
  const workbench = useWorkbench()
  const { documents, queries, commands, files, targets } = workbench
  const { documents: tabs, activeId, busy: documentBusy } = useServiceSnapshot(documents)
  const queryState = useServiceSnapshot(queries)
  const connections = useServiceSnapshot(workbench.connections)
  const [health, setHealth] = useState<BackendHealth>()
  const [backendError, setBackendError] = useState('')
  const [databasesById, setDatabasesById] = useState<Record<string, DatabaseInfo[]>>({})
  const [explorerError, setExplorerError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [showConnect, setShowConnect] = useState(false)
  const [options, setOptions] = useState<ConnectionOptions>(connectionDefaults)
  const { error: fileError } = useServiceSnapshot(files)
  const { error: commandError } = useServiceSnapshot(commands)
  const workspaceRef = useRef<WorkspaceHandle | null>(null)
  const enabled = {
    connect: useCommandEnabled('connection.connect'), newQuery: useCommandEnabled('file.new'), open: useCommandEnabled('file.open'), save: useCommandEnabled('file.save'),
    execute: useCommandEnabled('query.execute'), cancel: useCommandEnabled('query.cancel'), refresh: useCommandEnabled('explorer.refresh')
  }
  const keys = { open: useKeybindingLabel('file.open'), save: useKeybindingLabel('file.save'), execute: useKeybindingLabel('query.execute'), refresh: useKeybindingLabel('explorer.refresh') }
  const run = (id: CommandId) => { void commands.execute(id, undefined, 'toolbar') }
  const active: QueryTab = { ...(tabs.find(tab => tab.id === activeId) ?? emptyTab), result: queryState[activeId]?.result, error: queryState[activeId]?.error }
  const windowTitle = active.id ? `${active.dirty ? '* ' : ''}${active.name} — Varia SQL Manager` : 'Varia SQL Manager'
  const connection = connections.find(value => value.id === active.connectionId)
  const activeRunning = queryState[active.id]?.running
  // Also re-renders App when the theme changes, which the per-tab accents below rely on.
  const accent = useConnectionAccent(connection?.color)
  const databases = connection ? databasesById[connection.id] ?? [] : []
  const availableDatabases = databases.some(value => value.name === active.database) ? databases : [{ name: active.database, isSystem: false }, ...databases]

  function activate(id: string) { documents.activate(id) }
  const disconnectServer = useStableCallback((id: string) => disconnect(id))
  // Stable for the app's lifetime; it reaches the dock workspace through its ref.
  const shellHost = useMemo<ShellHost>(() => ({
    disconnect: disconnectServer,
    reveal: (pane, options) => workspaceRef.current?.reveal(pane, options),
    manageLayouts: mode => workspaceRef.current?.manage(mode),
    resetLayout: () => workspaceRef.current?.reset(),
    flushLayout: async () => { await workspaceRef.current?.flush() },
    showConnect: () => setShowConnect(true),
    refreshExplorer: () => setRefresh(value => value + 1),
    closePane: pane => workspaceRef.current?.close(pane)
  }), [disconnectServer])

  useEffect(() => {
    let disposed = false
    void window.varia.health().then(result => {
      if (disposed) return
      if (result.ok) { setHealth(result.value); workbench.context.set({ backendReady: true }) }
      else setBackendError(result.error)
    }).catch(error => { if (!disposed) setBackendError(errorText(error)) })
    return () => { disposed = true }
  }, [workbench])
  useEffect(() => {
    // Registering the shell commands and subscribing to main in one effect keeps main's exit flow (which waits for the
    // subscription) from ever sending window.close before its handler exists.
    const contribution = shellContribution(workbench, shellHost)
    const unsubscribe = window.varia.onCommand(id => { if (isCommandId(id)) void workbench.commands.execute(id, undefined, 'menu') })
    const publishing = workbench.menuState.start()
    return () => { publishing.dispose(); unsubscribe(); contribution.dispose() }
  }, [workbench, shellHost])
  useEffect(() => {
    const subscription = workbench.events.subscribe(event => {
      // Failures without a result also need the output panel; background tabs must not steal the editor.
      if (event.type === 'query.finished' && event.tabId === documents.getSnapshot().activeId) workspaceRef.current?.reveal('output')
      if (event.type === 'documents.activated' || event.type === 'documents.closed') workspaceRef.current?.reveal('editor')
    })
    return () => subscription.dispose()
  }, [workbench, documents])
  useEffect(() => {
    document.title = windowTitle
  }, [windowTitle])

  const onDatabases = useCallback((id: string, values: DatabaseInfo[]) => { setDatabasesById(current => ({ ...current, [id]: values })) }, [])

  function connected(info: ConnectionInfo, chosen: ConnectionOptions) {
    workbench.connections.add(info)
    const tab = documents.active
    // Connecting a second server must not silently retarget an existing query.
    if (tab && !tab.connectionId && !queries.isRunning(tab.id)) targets.update(tab.id, { connectionId: info.id, database: info.database })
    else documents.newQuery('', undefined, info.id, info.database)
    setOptions(chosen)
    setExplorerError(info.historyWarning ?? '')
    setShowConnect(false)
  }

  async function disconnect(id: string) {
    if (queries.isConnectionRunning(id)) return
    try {
      await documents.runTask(async () => {
        unwrap(await window.varia.disconnect(id))
        workbench.connections.remove(id)
        for (const tab of documents.getSnapshot().documents) if (tab.connectionId === id) targets.update(tab.id, { connectionId: undefined })
        setDatabasesById(current => { const next = { ...current }; delete next[id]; return next })
        setExplorerError('')
      })
    } catch (error) { setExplorerError(errorText(error)) }
  }

  const selectDatabase = useStableCallback((id: string, database: string) => {
    if (documents.getSnapshot().busy) return
    if (!active.id || (active.connectionId && active.connectionId !== id) || activeRunning) documents.newQuery('', undefined, id, database)
    else targets.update(active.id, { connectionId: id, database })
  })

  const script = useStableCallback(async (id: string, database: string, table: TableInfo) => {
    try {
      const result = unwrap(await window.varia.scriptTable(id, database, table.schema, table.name))
      documents.newQuery(result.sql, `${table.schema}.${table.name}.sql`, id, database, true)
      setExplorerError('')
    } catch (error) { setExplorerError(errorText(error)) }
  })
  const onScript = useCallback((id: string, database: string, table: TableInfo) => { void script(id, database, table) }, [script])
  const onDisconnect = useStableCallback((id: string) => { void disconnect(id) })

  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const destination = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined
    if (destination === undefined) return
    event.preventDefault()
    activate(tabs[destination].id)
    document.getElementById(`tab-${tabs[destination].id}`)?.focus()
  }

  return <div className="app">
    <TitleBar title={windowTitle} />
    <div className="toolbar">
      <div className="toolbar-actions">
        <button className="primary" disabled={!enabled.connect} onClick={() => run('connection.connect')}><Icon name="plus" />Connect</button>
        <span className="toolbar-divider" />
        <button disabled={!enabled.newQuery} onClick={() => run('file.new')}><Icon name="plus" />New query</button>
        <button disabled={!enabled.open} onClick={() => run('file.open')} title={withKey('Open SQL files', keys.open)}><Icon name="open" />Open</button>
        <button disabled={!enabled.save} onClick={() => run('file.save')} title={withKey('Save SQL query', keys.save)}><Icon name="save" />Save</button>
        <span className="toolbar-divider" />
        <button className="execute" disabled={!enabled.execute} onClick={() => run('query.execute')}><Icon name="play" />Execute{keys.execute && <kbd>{keys.execute.text}</kbd>}</button>
        <button disabled={!enabled.cancel} onClick={() => run('query.cancel')}><Icon name="stop" />Cancel</button>
        <span className="toolbar-divider" />
        <button onClick={() => run('layout.load')} title="Save, load, or reset panel layouts"><Icon name="layout" />Layouts</button>
      </div>
      <div className="toolbar-context">
        <label className="context-field" htmlFor="query-server">Server</label><select id="query-server" aria-label="Query server" disabled={!active.id || !!activeRunning || documentBusy} value={connection?.id ?? ''} onChange={event => void targets.changeConnection(active.id, event.target.value || undefined)}><option value="">Disconnected</option>{connections.map(value => <option key={value.id} value={value.id}>{value.displayName ? `${value.displayName} (${value.server})` : value.server}</option>)}</select>
        <label className="context-field" htmlFor="query-database">Database</label><select id="query-database" aria-label="Query database" disabled={!connection || !!activeRunning || documentBusy} value={active.database} onChange={event => targets.changeDatabase(active.id, event.target.value)}>{availableDatabases.map(value => <option key={value.name}>{value.name}</option>)}</select>
      </div>
    </div>
    {backendError && <div className="global-error" role="alert">{backendError}</div>}
    {fileError && <div className="global-error" role="alert"><span>{fileError}</span><button aria-label="Dismiss file error" onClick={() => files.clearError()}><Icon name="close" /></button></div>}
    {commandError && <div className="global-error" role="alert"><span>{commandError}</span><button aria-label="Dismiss command error" onClick={() => commands.clearError()}><Icon name="close" /></button></div>}
    <ThemeNotice />
    <DockWorkspace ref={workspaceRef} explorer={<aside className="explorer">
        <div className="panel-heading"><span>SERVERS</span><button className="icon-button" aria-label="Refresh Object Explorer" title={withKey('Refresh', keys.refresh)} disabled={!enabled.refresh} onClick={() => run('explorer.refresh')}><Icon name="refresh" /></button></div>
        <div className="explorer-scroll">{connections.length ? connections.map(value => <ServerExplorer key={value.id} connection={value} selectedDatabase={active.connectionId === value.id ? active.database : undefined} refresh={refresh} canDisconnect={!documentBusy && !queries.isConnectionRunning(value.id)} onDatabases={onDatabases} onSelect={selectDatabase} onScript={onScript} onDisconnect={onDisconnect} />)
          : <div className="explorer-empty"><Icon name="server" /><p>Connect to SQL Server to browse databases and script tables.</p><button disabled={!enabled.connect} onClick={() => run('connection.connect')}>Connect to server</button></div>}
          {explorerError && <p className="explorer-error" role="alert">{explorerError}</p>}
        </div>
        <div className="explorer-footer">{connections.length ? `${connections.length} connected server${connections.length === 1 ? '' : 's'}` : 'Windows & SQL authentication'}</div>
      </aside>} editor={<main className="workspace">
        <div className="query-tabs" role="tablist" aria-label="Query documents">{tabs.map((tab, index) => <div className={`query-tab ${activeId === tab.id ? 'active' : ''}`} style={{ borderTopColor: workbench.theme.accent(connections.find(value => value.id === tab.connectionId)?.color) }} role="presentation" key={tab.id}>
          <button id={`tab-${tab.id}`} className="tab-select" role="tab" aria-label={tab.name} aria-selected={activeId === tab.id} tabIndex={activeId === tab.id ? 0 : -1} title={`${tab.file?.path ?? tab.name}${tab.dirty ? ' (unsaved changes)' : ''}`} onClick={() => activate(tab.id)} onKeyDown={event => tabKey(event, index)}><span className="sql-icon">SQL</span><span className="tab-name">{tab.name}</span>{tab.dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}{queryState[tab.id]?.running && <span className="status-dot online" />}</button>
          <button className="tab-close" aria-label={`Close ${tab.name}`} title={queryState[tab.id]?.running ? 'Cancel the running query before closing' : `Close ${tab.name}`} disabled={!!queryState[tab.id]?.running || documentBusy} onClick={() => void commands.execute('file.close', { tabId: tab.id }, 'toolbar')}><Icon name="close" /></button>
        </div>)}</div>
        {active.id ? <>
          <div className="query-context" style={{ borderBottom: accent ? `3px solid ${accent}` : undefined }}><span>{connection?.displayName || connection?.server || 'Disconnected'} <span className="breadcrumb">/</span> {active.database}</span><span>Transact-SQL · {activeRunning ? 'Executing…' : 'Ready'}</span></div>
          <div className="editor-container"><QueryEditor /></div>
        </> : <div className="workspace-empty"><p>No open queries</p><div><button onClick={() => run('file.new')}>New query</button><button onClick={() => run('file.open')}>Open SQL file</button></div></div>}
      </main>} output={<QueryOutput tabId={active.id} result={active.result} error={active.error} running={!!activeRunning} connected={!!connection} />} />
    <footer className="status-bar" data-state={backendError ? 'error' : activeRunning ? 'executing' : !connection ? 'disconnected' : 'ready'} style={{ borderTop: accent ? `2px solid ${accent}` : undefined }}><span><span className={`status-dot ${health ? 'online' : ''}`} />{health ? `${health.runtime} · Ready` : backendError ? 'Backend unavailable' : 'Starting backend…'}</span><span title={health ? `SMO ${health.smoVersion} / SqlClient ${health.sqlClientVersion}` : ''}>{connection?.server ?? 'Disconnected'}<span className="status-divider">|</span>{active.id ? active.database : 'No query'}<span className="status-divider">|</span>1,000 row display limit</span></footer>
    {showConnect && <ConnectDialog initial={options} onConnected={connected} onClose={() => setShowConnect(false)} />}
    <QuickInput />
    <MenuLayer />
  </div>
}
