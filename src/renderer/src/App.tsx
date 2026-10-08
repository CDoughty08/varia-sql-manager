import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ApiResult, BackendHealth, ConnectionInfo, ConnectionOptions, DatabaseInfo, TableInfo, WorkbenchCommand } from '../../shared/contracts'
import { bindFileShortcuts } from './contributions/files'
import type { QueryDocument, QueryTab } from './documents'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import QueryEditor from './QueryEditor'
import Icon from './Icon'
import ServerExplorer from './ServerExplorer'
import QueryOutput from './QueryOutput'
import TitleBar from './TitleBar'
import DockWorkspace, { type WorkspaceHandle } from './DockWorkspace'
import ConnectDialog from './ConnectDialog'
import { connectionDefaults } from '../../shared/connections'

const emptyTab: QueryTab = { id: '', name: '', dirty: false, savedVersionId: null, database: 'master' }
const shellCommands: WorkbenchCommand[] = ['edit.undo', 'edit.redo', 'window.close', 'window.explorer', 'window.editor', 'window.output', 'layout.save', 'layout.load', 'layout.reset']
function unwrap<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(result.error); return result.value }
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The operation failed.' }
// Shortcuts and menus forwarded by main must not act on the workbench behind an open dialog.
const modalOpen = () => !!document.querySelector('[aria-modal="true"]')
const modalSafeCommands: readonly WorkbenchCommand[] = ['edit.undo', 'edit.redo', 'window.close']
/** A callback with a stable identity that always runs the latest render's logic, so memoized panes skip unrelated renders. */
function useStableCallback<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
  const latest = useRef(callback)
  latest.current = callback
  return useCallback((...args: A) => latest.current(...args), [])
}

export default function App() {
  const workbench = useWorkbench()
  const { documents, queries, commands, files } = workbench
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
  const commandRef = useRef<(command: WorkbenchCommand) => void | Promise<void>>(() => {})
  const workspaceRef = useRef<WorkspaceHandle | null>(null)
  const active: QueryTab = { ...(tabs.find(tab => tab.id === activeId) ?? emptyTab), result: queryState[activeId]?.result, error: queryState[activeId]?.error }
  const windowTitle = active.id ? `${active.dirty ? '* ' : ''}${active.name} — Varia SQL Manager` : 'Varia SQL Manager'
  const connection = connections.find(value => value.id === active.connectionId)
  const activeRunning = queryState[active.id]?.running
  const databases = connection ? databasesById[connection.id] ?? [] : []
  const availableDatabases = databases.some(value => value.name === active.database) ? databases : [{ name: active.database, isSystem: false }, ...databases]

  function activate(id: string) { documents.activate(id) }
  function updateTarget(id: string, patch: Partial<Pick<QueryDocument, 'connectionId' | 'database'>>) {
    const current = documents.get(id)
    // Re-selecting the current target keeps the query's results.
    if (current && Object.entries(patch).every(([key, value]) => current[key as keyof typeof patch] === value)) return
    documents.update(id, patch); queries.clear(id)
  }

  useEffect(() => {
    let disposed = false
    void window.varia.health().then(result => {
      if (disposed) return
      if (result.ok) setHealth(result.value)
      else setBackendError(result.error)
    }).catch(error => { if (!disposed) setBackendError(errorText(error)) })
    return () => { disposed = true }
  }, [])
  useEffect(() => {
    const registrations = shellCommands.map(id => commands.register(id, { run: () => commandRef.current(id) }))
    const unsubscribe = window.varia.onCommand(value => { if (!modalOpen() || modalSafeCommands.includes(value)) void commands.run(value) })
    return () => { unsubscribe(); registrations.forEach(registration => registration.dispose()) }
  }, [commands])
  useEffect(() => {
    const subscription = workbench.events.subscribe(event => {
      // Failures without a result also need the output panel; background tabs must not steal the editor.
      if (event.type === 'query.finished' && event.tabId === documents.getSnapshot().activeId) workspaceRef.current?.reveal('output')
      if (event.type === 'documents.activated' || event.type === 'documents.closed') workspaceRef.current?.reveal('editor')
    })
    return () => subscription.dispose()
  }, [workbench, documents])
  useEffect(() => {
    const binding = bindFileShortcuts(document, window.varia.platform, commands)
    return () => binding.dispose()
  }, [commands])
  useEffect(() => {
    document.title = windowTitle
  }, [windowTitle])

  const onDatabases = useCallback((id: string, values: DatabaseInfo[]) => { setDatabasesById(current => ({ ...current, [id]: values })) }, [])

  function connected(info: ConnectionInfo, chosen: ConnectionOptions) {
    workbench.connections.add(info)
    const tab = documents.active
    // Connecting a second server must not silently retarget an existing query.
    if (tab && !tab.connectionId && !queries.isRunning(tab.id)) updateTarget(tab.id, { connectionId: info.id, database: info.database })
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
        for (const tab of documents.getSnapshot().documents) if (tab.connectionId === id) updateTarget(tab.id, { connectionId: undefined })
        setDatabasesById(current => { const next = { ...current }; delete next[id]; return next })
        setExplorerError('')
      })
    } catch (error) { setExplorerError(errorText(error)) }
  }

  const selectDatabase = useStableCallback((id: string, database: string) => {
    if (documents.getSnapshot().busy) return
    if (!active.id || (active.connectionId && active.connectionId !== id) || activeRunning) documents.newQuery('', undefined, id, database)
    else updateTarget(active.id, { connectionId: id, database })
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

  async function documentTask(action: () => Promise<void>) {
    if (documents.getSnapshot().busy) return
    files.clearError()
    try { await documents.runTask(action) }
    catch (error) { files.reportError(errorText(error)) }
  }
  function edit(command: 'undo' | 'redo') {
    const focused = document.activeElement
    const textInput = focused instanceof HTMLElement && (focused.matches('input, textarea') || focused.isContentEditable)
    if (textInput && !focused.closest('.monaco-editor')) { document.execCommand(command); return }
    if (!documents.getSnapshot().documents.length) return
    documents.boundEditor?.focus()
    documents.boundEditor?.trigger('menu', command, null)
  }
  commandRef.current = value => {
    if (value === 'window.explorer' || value === 'window.editor' || value === 'window.output') { workspaceRef.current?.reveal(value.slice(7) as 'explorer' | 'editor' | 'output'); return }
    if (value === 'layout.save' || value === 'layout.load') { workspaceRef.current?.manage(value === 'layout.save' ? 'save' : 'load'); return }
    if (value === 'layout.reset') { workspaceRef.current?.reset(); return }
    if (value === 'edit.undo' || value === 'edit.redo') { edit(value === 'edit.undo' ? 'undo' : 'redo'); return }
    // Remembering the layout is best-effort; a failed preferences write must never prevent exit.
    if (value === 'window.close') return files.closeWindow(async () => { await workspaceRef.current?.flush().catch(() => {}) })
  }
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
        <button className="primary" disabled={!health} onClick={() => setShowConnect(true)}><Icon name="plus" />Connect</button>
        <span className="toolbar-divider" />
        <button disabled={documentBusy} onClick={() => void commands.run('file.new')}><Icon name="plus" />New query</button>
        <button disabled={documentBusy} onClick={() => void commands.run('file.open')} title="Open SQL files (Ctrl+O)"><Icon name="open" />Open</button>
        <button disabled={!active.id || documentBusy} onClick={() => void commands.run('file.save')} title="Save SQL query (Ctrl+S)"><Icon name="save" />Save</button>
        <span className="toolbar-divider" />
        <button className="execute" disabled={!connection || !!activeRunning || documentBusy} onClick={() => void commands.run('query.execute')}><Icon name="play" />Execute<kbd>F5</kbd></button>
        <button disabled={!activeRunning} onClick={() => void commands.run('query.cancel')}><Icon name="stop" />Cancel</button>
        <span className="toolbar-divider" />
        <button onClick={() => void commands.run('layout.load')} title="Save, load, or reset panel layouts"><Icon name="layout" />Layouts</button>
      </div>
      <div className="toolbar-context">
        <label className="context-field" htmlFor="query-server">Server</label><select id="query-server" aria-label="Query server" disabled={!active.id || !!activeRunning || documentBusy} value={connection?.id ?? ''} onChange={event => {
          const next = connections.find(value => value.id === event.target.value)
          void documentTask(async () => {
            unwrap(await window.varia.closeQuerySession(active.id))
            updateTarget(active.id, { connectionId: next?.id, database: next?.database ?? active.database })
          })
        }}><option value="">Disconnected</option>{connections.map(value => <option key={value.id} value={value.id}>{value.displayName ? `${value.displayName} (${value.server})` : value.server}</option>)}</select>
        <label className="context-field" htmlFor="query-database">Database</label><select id="query-database" aria-label="Query database" disabled={!connection || !!activeRunning || documentBusy} value={active.database} onChange={event => updateTarget(active.id, { database: event.target.value })}>{availableDatabases.map(value => <option key={value.name}>{value.name}</option>)}</select>
      </div>
    </div>
    {backendError && <div className="global-error" role="alert">{backendError}</div>}
    {fileError && <div className="global-error" role="alert"><span>{fileError}</span><button aria-label="Dismiss file error" onClick={() => files.clearError()}><Icon name="close" /></button></div>}
    <DockWorkspace ref={workspaceRef} explorer={<aside className="explorer">
        <div className="panel-heading"><span>SERVERS</span><button className="icon-button" aria-label="Refresh Object Explorer" disabled={!connections.length} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" /></button></div>
        <div className="explorer-scroll">{connections.length ? connections.map(value => <ServerExplorer key={value.id} connection={value} selectedDatabase={active.connectionId === value.id ? active.database : undefined} refresh={refresh} canDisconnect={!documentBusy && !queries.isConnectionRunning(value.id)} onDatabases={onDatabases} onSelect={selectDatabase} onScript={onScript} onDisconnect={onDisconnect} />)
          : <div className="explorer-empty"><Icon name="server" /><p>Connect to SQL Server to browse databases and script tables.</p><button disabled={!health} onClick={() => setShowConnect(true)}>Connect to server</button></div>}
          {explorerError && <p className="explorer-error" role="alert">{explorerError}</p>}
        </div>
        <div className="explorer-footer">{connections.length ? `${connections.length} connected server${connections.length === 1 ? '' : 's'}` : 'Windows & SQL authentication'}</div>
      </aside>} editor={<main className="workspace">
        <div className="query-tabs" role="tablist" aria-label="Query documents">{tabs.map((tab, index) => <div className={`query-tab ${activeId === tab.id ? 'active' : ''}`} style={{ borderTopColor: connections.find(value => value.id === tab.connectionId)?.color }} role="presentation" key={tab.id}>
          <button id={`tab-${tab.id}`} className="tab-select" role="tab" aria-label={tab.name} aria-selected={activeId === tab.id} tabIndex={activeId === tab.id ? 0 : -1} title={`${tab.file?.path ?? tab.name}${tab.dirty ? ' (unsaved changes)' : ''}`} onClick={() => activate(tab.id)} onKeyDown={event => tabKey(event, index)}><span className="sql-icon">SQL</span><span className="tab-name">{tab.name}</span>{tab.dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}{queryState[tab.id]?.running && <span className="status-dot online" />}</button>
          <button className="tab-close" aria-label={`Close ${tab.name}`} title={queryState[tab.id]?.running ? 'Cancel the running query before closing' : `Close ${tab.name}`} disabled={!!queryState[tab.id]?.running || documentBusy} onClick={() => void commands.run('file.close', { tabId: tab.id })}><Icon name="close" /></button>
        </div>)}</div>
        {active.id ? <>
          <div className="query-context" style={{ borderBottom: connection?.color ? `3px solid ${connection.color}` : undefined }}><span>{connection?.displayName || connection?.server || 'Disconnected'} <span className="breadcrumb">/</span> {active.database}</span><span>Transact-SQL · {activeRunning ? 'Executing…' : 'Ready'}</span></div>
          <div className="editor-container"><QueryEditor /></div>
        </> : <div className="workspace-empty"><p>No open queries</p><div><button onClick={() => void commands.run('file.new')}>New query</button><button onClick={() => void commands.run('file.open')}>Open SQL file</button></div></div>}
      </main>} output={<QueryOutput tabId={active.id} result={active.result} error={active.error} running={!!activeRunning} connected={!!connection} />} />
    <footer className="status-bar" style={{ borderTop: connection?.color ? `2px solid ${connection.color}` : undefined }}><span><span className={`status-dot ${health ? 'online' : ''}`} />{health ? `${health.runtime} · Ready` : backendError ? 'Backend unavailable' : 'Starting backend…'}</span><span title={health ? `SMO ${health.smoVersion} / SqlClient ${health.sqlClientVersion}` : ''}>{connection?.server ?? 'Disconnected'}<span className="status-divider">|</span>{active.id ? active.database : 'No query'}<span className="status-divider">|</span>1,000 row display limit</span></footer>
    {showConnect && <ConnectDialog initial={options} onConnected={connected} onClose={() => setShowConnect(false)} />}
  </div>
}
