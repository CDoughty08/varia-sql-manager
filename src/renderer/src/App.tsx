import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ApiResult, BackendHealth, BackendState, ConnectionInfo, ConnectionOptions } from '../../shared/contracts'
import { isCommandId } from '../../shared/commands/catalog'
import { shellContribution, type ShellHost } from './contributions/shell'
import { documentKind, isQueryDocument, kindInfo, type QueryTab } from './documents'
import { useConnectionAccent, useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { useCommandEnabled, useKeybindingLabel } from './core/useCommand'
import type { CommandArgs, CommandId } from './core/types'
import QueryEditor from './QueryEditor'
import QueryStatusBar from './QueryStatusBar'
import EditorStatus from './EditorStatus'
import Icon from './Icon'
import ExplorerPane from './explorer/ExplorerPane'
import FilterDialog from './explorer/FilterDialog'
import OptionsDialog from './settings/OptionsDialog'
import ScriptingStatus from './scripting/ScriptingStatus'
import BackendBanner from './BackendBanner'
import OutputPane from './results/OutputPane'
import MemoryIndicator from './results/MemoryIndicator'
import TitleBar from './TitleBar'
import DockWorkspace, { type WorkspaceHandle } from './DockWorkspace'
import ConnectDialog from './ConnectDialog'
import ThemeNotice from './ThemeNotice'
import QuickInput from './quickinput/QuickInput'
import MenuLayer from './menus/MenuLayer'
import { useMenuTarget } from './menus/useMenuTarget'
import { connectionDefaults } from '../../shared/connections'

const emptyTab: QueryTab = { id: '', name: '', dirty: false, savedVersionId: null, database: 'master' }
function unwrap<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(result.error); return result.value }
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The operation failed.' }
const lostHint = "This query's connection was lost when the SQL backend restarted. Reconnect to run queries."
function backendStatusText(state: BackendState): string {
  switch (state.status) {
    case 'starting': return 'Starting SQL backend…'
    case 'ready': return `${state.runtime} · Ready`
    case 'unresponsive': return 'SQL backend not responding…'
    case 'restarting': return 'Restarting SQL backend…'
    default: return 'SQL backend unavailable'
  }
}
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
  const { state: backendState } = useServiceSnapshot(workbench.backend)
  const [health, setHealth] = useState<BackendHealth>()
  const databaseLists = useServiceSnapshot(workbench.databaseList)
  const filterFolder = useServiceSnapshot(workbench.explorer.filterDialog)
  const optionsDialog = useServiceSnapshot(workbench.settings.dialog)
  const { values: settings } = useServiceSnapshot(workbench.settings)
  const [explorerError, setExplorerError] = useState('')
  const [showConnect, setShowConnect] = useState(false)
  const [options, setOptions] = useState<ConnectionOptions>(() => connectionDefaults(workbench.platform))
  // The lost connection that the open Connect dialog replaces.
  const [reconnecting, setReconnecting] = useState<string>()
  // The query that Execute opened the Connect dialog for: it runs once connected.
  const [pendingExecute, setPendingExecute] = useState<string>()
  const { error: fileError, kind: fileKind } = useServiceSnapshot(files)
  const { error: commandError, kind: commandKind } = useServiceSnapshot(commands)
  const workspaceRef = useRef<WorkspaceHandle | null>(null)
  const enabled = {
    connect: useCommandEnabled('connection.connect'), newQuery: useCommandEnabled('file.new'), open: useCommandEnabled('file.open'), save: useCommandEnabled('file.save'), saveAll: useCommandEnabled('file.saveAll'),
    execute: useCommandEnabled('query.execute'), cancel: useCommandEnabled('query.cancel')
  }
  const keys = { open: useKeybindingLabel('file.open'), save: useKeybindingLabel('file.save'), saveAll: useKeybindingLabel('file.saveAll'), execute: useKeybindingLabel('query.execute') }
  const run = (id: CommandId, args?: CommandArgs) => { void commands.execute(id, args, 'toolbar') }
  const active: QueryTab = tabs.find(tab => tab.id === activeId) ?? emptyTab
  // An XML, JSON or plan value opened from the results: no server, database, or results of its own.
  const activeKind = documentKind(active), isQuery = activeKind === 'sql'
  const windowTitle = active.id ? `${active.dirty ? '* ' : ''}${active.name} — Varia SQL Manager` : 'Varia SQL Manager'
  const connection = connections.find(value => value.id === active.connectionId)
  const liveConnection = connection?.lost ? undefined : connection
  const readyGeneration = backendState.status === 'ready' ? backendState.generation : 0
  const backendDown = backendState.status !== 'ready' && backendState.status !== 'starting'
  const activeRunning = queryState[active.id]?.running
  // Also re-renders App when the theme changes, which the per-tab accents below rely on.
  const accent = useConnectionAccent(connection?.color)
  const databases = liveConnection ? databaseLists.get(liveConnection.id) ?? [] : []
  const availableDatabases = databases.some(value => value.name === active.database) ? databases : [{ name: active.database, isSystem: false }, ...databases]

  // SSMS's query window status bar, below the query unless Options puts it above; its tooltip names the SMO and SqlClient versions.
  const statusTop = settings['textEditor.statusBar.location'] === 'top'
  const statusBar = active.id ? <QueryStatusBar tab={active} connection={connection} versions={health ? `SMO ${health.smoVersion} / SqlClient ${health.sqlClientVersion}` : undefined} /> : null

  function activate(id: string) { documents.activate(id) }
  const disconnectServer = useStableCallback((id: string) => disconnect(id))
  // Stable for the app's lifetime; it reaches the dock workspace through its ref.
  const shellHost = useMemo<ShellHost>(() => ({
    disconnect: disconnectServer,
    reveal: (pane, options) => workspaceRef.current?.reveal(pane, options),
    manageLayouts: mode => workspaceRef.current?.manage(mode),
    resetLayout: () => workspaceRef.current?.reset(),
    flushLayout: async () => { await workspaceRef.current?.flush() },
    showConnect: () => { setReconnecting(undefined); setPendingExecute(undefined); setShowConnect(true) },
    reconnect: id => {
      const lost = workbench.connections.get(id)
      if (!lost?.lost) return
      setReconnecting(id)
      setPendingExecute(undefined)
      setOptions(lost.options)
      setShowConnect(true)
    },
    closePane: pane => workspaceRef.current?.close(pane),
    paneLocation: pane => workspaceRef.current?.location(pane) ?? 'closed',
    floatPane: pane => workspaceRef.current?.float(pane),
    dockPane: pane => workspaceRef.current?.dock(pane)
  }), [disconnectServer, workbench])
  // One callback for every query tab: the tab names its query.
  const tabTarget = useMenuTarget<HTMLDivElement>(element => {
    const tabId = element.dataset.tabId
    return tabId && documents.get(tabId) ? { kind: 'documentTab', tabId } : null
  })

  // Readiness comes from main's backend state; health only fills the status bar tooltip, once per generation.
  useEffect(() => {
    if (!readyGeneration) return
    let disposed = false
    void window.varia.health().then(result => { if (!disposed && result.ok) setHealth(result.value) }, () => {})
    return () => { disposed = true }
  }, [readyGeneration])
  useEffect(() => {
    // Registering the shell commands and subscribing to main in one effect keeps main's exit flow (which waits for the
    // subscription) from ever sending window.close before its handler exists.
    const contribution = shellContribution(workbench, shellHost)
    // Main hands over files from the command line and drops once the page subscribes to commands, so this comes first.
    const opened = window.varia.onFilesOpened(files => { void workbench.files.adopt(files) })
    const unsubscribe = window.varia.onCommand(id => { if (isCommandId(id)) void workbench.commands.execute(id, undefined, 'menu') })
    const publishing = workbench.menuState.start()
    return () => { publishing.dispose(); unsubscribe(); opened(); contribution.dispose() }
  }, [workbench, shellHost])
  useEffect(() => {
    const subscription = workbench.events.subscribe(event => {
      // As in SSMS, executing shows the results (even when Ctrl+R hid them); background tabs must not steal the editor.
      if ((event.type === 'query.started' || event.type === 'query.finished') && event.tabId === documents.getSnapshot().activeId) workspaceRef.current?.reveal('output')
      if (event.type === 'documents.activated' || event.type === 'documents.closed') workspaceRef.current?.reveal('editor')
      // Execute on a query with no connection: connect first, as SSMS does, then run it.
      if (event.type === 'query.connectRequested') { setReconnecting(undefined); setPendingExecute(event.tabId); setShowConnect(true) }
    })
    return () => subscription.dispose()
  }, [workbench, documents])
  useEffect(() => {
    document.title = windowTitle
  }, [windowTitle])
  // A query opened or chosen from elsewhere (Script As, Go to Query, a menu) must not stay hidden past the strip's edge.
  useEffect(() => {
    const tab = activeId ? document.getElementById(`tab-${activeId}`)?.parentElement : undefined, strip = tab?.parentElement
    if (!tab || !strip) return
    const box = tab.getBoundingClientRect(), view = strip.getBoundingClientRect()
    if (box.left < view.left) strip.scrollLeft -= view.left - box.left
    else if (box.right > view.right) strip.scrollLeft += box.right - view.right
  }, [activeId, tabs.length])

  function connected(info: ConnectionInfo, chosen: ConnectionOptions) {
    setOptions(chosen)
    setExplorerError(info.historyWarning ?? '')
    setShowConnect(false)
    setReconnecting(undefined)
    setPendingExecute(undefined)
    // Only this explicit reconnect moves a lost connection's queries to a new session.
    if (reconnecting && workbench.connections.get(reconnecting)?.lost) {
      workbench.connections.replace(reconnecting, info, chosen)
      targets.retarget(reconnecting, info.id)
      return
    }
    workbench.connections.add(info, chosen)
    const waiting = pendingExecute ? documents.get(pendingExecute) : undefined
    if (waiting && !workbench.connections.isLive(waiting.connectionId ?? '') && isQueryDocument(waiting) && !queries.isRunning(waiting.id)) {
      targets.update(waiting.id, { connectionId: info.id, database: info.database })
      void queries.execute(waiting.id)
      return
    }
    const tab = documents.active
    // Connecting a second server must not silently retarget an existing query, and a value's document never connects.
    if (tab && !tab.connectionId && isQueryDocument(tab) && !queries.isRunning(tab.id)) targets.update(tab.id, { connectionId: info.id, database: info.database })
    else documents.newQuery('', undefined, info.id, info.database)
  }

  async function disconnect(id: string) {
    if (queries.isConnectionRunning(id)) return
    try {
      await documents.runTask(async () => {
        // Its queries' open transactions are asked about once, then each is committed or rolled back in its own session;
        // disconnecting closes every session of the connection, so the rest end with it.
        const plan = await queries.confirmSessions('disconnect', documents.getSnapshot().documents.filter(tab => tab.connectionId === id).map(tab => tab.id))
        if (!plan) return
        for (const [tabId, transaction] of plan) await documents.endSession(tabId, transaction)
        unwrap(await window.varia.disconnect(id))
        workbench.connections.remove(id)
        for (const tab of documents.getSnapshot().documents) if (tab.connectionId === id) targets.update(tab.id, { connectionId: undefined })
        setExplorerError('')
      })
    } catch (error) { setExplorerError(errorText(error)) }
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
        <button className="primary" disabled={!enabled.connect} onClick={() => run('connection.connect')}><Icon name="plus" />Connect</button>
        <span className="toolbar-divider" />
        <button disabled={!enabled.newQuery} onClick={() => run('file.new')}><Icon name="plus" />New query</button>
        <button disabled={!enabled.open} onClick={() => run('file.open')} title={withKey('Open SQL files', keys.open)}><Icon name="open" />Open</button>
        <button disabled={!enabled.save} onClick={() => run('file.save')} title={withKey('Save SQL query', keys.save)}><Icon name="save" />Save</button>
        <button disabled={!enabled.saveAll} onClick={() => run('file.saveAll')} title={withKey('Save all queries with unsaved changes', keys.saveAll)}><Icon name="save" />Save All</button>
        <span className="toolbar-divider" />
        <button className="execute" disabled={!enabled.execute} title={connection?.lost ? lostHint : undefined} onClick={() => run('query.execute')}><Icon name="play" />Execute{keys.execute && <kbd>{keys.execute.text}</kbd>}</button>
        <button disabled={!enabled.cancel} onClick={() => run('query.cancel')}><Icon name="stop" />Cancel</button>
        <span className="toolbar-divider" />
        <button onClick={() => run('layout.load')} title="Save, load, or reset panel layouts"><Icon name="layout" />Layouts</button>
      </div>
      <div className="toolbar-context">
        <label className="context-field" htmlFor="query-server">Server</label><select id="query-server" aria-label="Query server" disabled={!active.id || !isQuery || !!activeRunning || documentBusy} value={connection?.id ?? ''} onChange={event => void targets.changeConnection(active.id, event.target.value || undefined)}><option value="">Disconnected</option>{connections.filter(value => !value.lost || value === connection).map(value => <option key={value.id} value={value.id} disabled={value.lost}>{value.displayName ? `${value.displayName} (${value.server})` : value.server}{value.lost ? ' (connection lost)' : ''}</option>)}</select>
        <label className="context-field" htmlFor="query-database">Database</label><select id="query-database" aria-label="Query database" disabled={!liveConnection || !!activeRunning || documentBusy} value={active.database} onChange={event => targets.changeDatabase(active.id, event.target.value)}>{availableDatabases.map(value => <option key={value.name}>{value.name}</option>)}</select>
      </div>
    </div>
    <BackendBanner />
    {fileError && (fileKind === 'warning'
      ? <div className="global-error warning" role="status"><span>{fileError}</span><button aria-label="Dismiss file notice" onClick={() => files.clearError()}><Icon name="close" /></button></div>
      : <div className="global-error" role="alert"><span>{fileError}</span><button aria-label="Dismiss file error" onClick={() => files.clearError()}><Icon name="close" /></button></div>)}
    {commandError && (commandKind === 'warning'
      ? <div className="global-error warning" role="status"><span>{commandError}</span><button aria-label="Dismiss warning" onClick={() => commands.clearError()}><Icon name="close" /></button></div>
      : <div className="global-error" role="alert"><span>{commandError}</span><button aria-label="Dismiss command error" onClick={() => commands.clearError()}><Icon name="close" /></button></div>)}
    <ThemeNotice />
    <DockWorkspace ref={workspaceRef} explorer={<aside className="explorer"><ExplorerPane error={explorerError} activeConnectionId={liveConnection?.id} /></aside>} editor={<main className="workspace">
        <div className="query-tabs" role="tablist" aria-label="Query documents">{tabs.map((tab, index) => <div className={`query-tab ${activeId === tab.id ? 'active' : ''}`} style={{ borderTopColor: workbench.theme.accent(connections.find(value => value.id === tab.connectionId)?.color) }} role="presentation" key={tab.id} ref={tabTarget} data-tab-id={tab.id}>
          <button id={`tab-${tab.id}`} className="tab-select" role="tab" aria-label={tab.name} aria-selected={activeId === tab.id} tabIndex={activeId === tab.id ? 0 : -1} title={`${tab.file?.path ?? tab.name}${tab.file?.readOnly ? ' (read-only)' : ''}${tab.dirty ? ' (unsaved changes)' : ''}`} onClick={() => activate(tab.id)} onKeyDown={event => tabKey(event, index)}><span className="sql-icon">{kindInfo[documentKind(tab)].badge}</span><span className="tab-name">{tab.name}</span>{tab.file?.readOnly && <span className="tab-readonly codicon codicon-lock" aria-label="Read-only" />}{tab.dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}{queryState[tab.id]?.running && <span className="status-dot online" />}</button>
          <button className="tab-close" aria-label={`Close ${tab.name}`} title={queryState[tab.id]?.running ? `Close ${tab.name} (its query is executing)` : `Close ${tab.name}`} disabled={documentBusy} onClick={() => void commands.execute('file.close', { tabId: tab.id }, 'toolbar')}><Icon name="close" /></button>
        </div>)}</div>
        {active.id ? <>
          {statusTop && statusBar}
          <div className="editor-container"><QueryEditor /></div>
          {!statusTop && statusBar}
        </> : <div className="workspace-empty"><p>No open queries</p><div><button onClick={() => run('file.new')}>New query</button><button onClick={() => run('file.open')}>Open SQL file</button></div></div>}
      </main>} output={<OutputPane tabId={active.id} query={isQuery} connected={!!liveConnection} hint={connection?.lost ? lostHint : undefined} />} />
    <footer className="status-bar" data-state={backendDown ? 'error' : activeRunning ? 'executing' : !liveConnection ? 'disconnected' : 'ready'} style={{ borderTop: accent ? `2px solid ${accent}` : undefined }}><span><span className={`status-dot ${backendState.status === 'ready' ? 'online' : ''}`} />{backendStatusText(backendState)}</span><ScriptingStatus /><EditorStatus /><MemoryIndicator /></footer>
    {showConnect && <ConnectDialog initial={options} onConnected={connected} onClose={() => { setShowConnect(false); setReconnecting(undefined); setPendingExecute(undefined) }} />}
    {filterFolder !== undefined && <FilterDialog key={filterFolder} folderId={filterFolder} />}
    {optionsDialog.open && <OptionsDialog page={optionsDialog.page} />}
    <QuickInput />
    <MenuLayer />
  </div>
}
