import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BackendHealth, BackendState, ConnectionOptions } from '../../shared/contracts'
import type { ConnectionDetails } from '../../shared/connection-targets'
import { isCommandId } from '../../shared/commands/catalog'
import { shellContribution, type ShellHost } from './contributions/shell'
import { documentKind, isCustomKind, isQueryDocument, type QueryTab } from './documents'
import { useConnectionAccent, useServiceSelector, useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import QueryStatusBar from './QueryStatusBar'
import EditorStatus from './EditorStatus'
import Icon from './Icon'
import ExplorerPane from './explorer/ExplorerPane'
import FilterDialog from './explorer/FilterDialog'
import OptionsDialog from './settings/OptionsDialog'
import ObjectDialog from './dialogs/ObjectDialog'
import CreateCatalogDialog from './ssis/CreateCatalogDialog'
import ServerFilePicker from './server-files/ServerFilePicker'
import GoToLineDialog from './editor/GoToLineDialog'
import RecoveryDialog from './RecoveryDialog'
import ScriptingStatus from './scripting/ScriptingStatus'
import BackendBanner from './BackendBanner'
import OutputPane, { OutputAnnouncer, OutputViewSync, outputViewOf } from './results/OutputPane'
import MemoryIndicator from './results/MemoryIndicator'
import IndexStatus from './search/IndexStatus'
import UpdateStatus from './updates/UpdateStatus'
import AboutDialog from './about/AboutDialog'
import TitleBar from './TitleBar'
import StandardToolbar, { CommandCentre } from './ShellToolbar'
import QueryBar from './QueryBar'
import { lostHint } from './query-context'
import EditorArea from './editor-groups/EditorArea'
import DockWorkspace, { type WorkspaceHandle } from './DockWorkspace'
import ConnectDialog from './ConnectDialog'
import ConnectionDetailsDialog from './ConnectionDetailsDialog'
import DisconnectDialog from './disconnect/DisconnectDialog'
import { detailsOf, type ConnectionAttempt, type TargetConnectionInfo } from './services/connections'
import { finishConnectionDetails, needsDetailsConfirmation, type OpenedConnection } from './services/connection-opening'
import { acceptConnectionReceipt } from './services/connection-receipts'
import { focusWhenDrawn } from './core/modal'
import { nextFrame } from './core/frame'
import EnvironmentDialog from './EnvironmentDialog'
import EnvironmentTag from './EnvironmentTag'
import { environmentTag } from '../../shared/environments'
import ThemeNotice from './ThemeNotice'
import QuickInput from './quickinput/QuickInput'
import MenuLayer from './menus/MenuLayer'
import Toasts from './kit/Toasts'
import { connectionDefaults } from '../../shared/connections'

const emptyTab: QueryTab = { id: '', name: '', dirty: false, savedVersionId: null, database: 'master' }
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The operation failed.' }
/** The status bar's backend segment: Ready (the runtime is in its tooltip), or what the backend is doing. */
function backendStatusText(state: BackendState): string {
  switch (state.status) {
    case 'starting': return 'Starting SQL backend…'
    case 'ready': return 'Ready'
    case 'unresponsive': return 'SQL backend not responding…'
    case 'restarting': return 'Restarting SQL backend…'
    default: return 'SQL backend unavailable'
  }
}
/** A callback with a stable identity that always runs the latest render's logic, so memoized panes skip unrelated renders. */
function useStableCallback<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
  const latest = useRef(callback)
  latest.current = callback
  return useCallback((...args: A) => latest.current(...args), [])
}

export default function App() {
  const workbench = useWorkbench()
  const { documents, queries, commands, files, targets } = workbench
  const { documents: tabs, activeId } = useServiceSnapshot(documents)
  const queryState = useServiceSnapshot(queries)
  const connections = useServiceSnapshot(workbench.connections)
  const { state: backendState } = useServiceSnapshot(workbench.backend)
  const [health, setHealth] = useState<BackendHealth>()
  const filterFolder = useServiceSnapshot(workbench.explorer.filterDialog)
  const optionsDialog = useServiceSnapshot(workbench.settings.dialog)
  const editorDialogs = useServiceSnapshot(workbench.editorDialogs)
  const { open: recoveryOpen } = useServiceSnapshot(workbench.recovery)
  const { values: settings } = useServiceSnapshot(workbench.settings)
  const shell = useServiceSnapshot(workbench.shellOptions)
  const toasts = useServiceSnapshot(workbench.notifications)
  const [explorerError, setExplorerError] = useState('')
  const [showConnect, setShowConnect] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [options, setOptions] = useState<ConnectionOptions>(() => connectionDefaults(workbench.platform))
  // The lost connection that the open Connect dialog replaces.
  const [reconnecting, setReconnecting] = useState<string>()
  const [detailsReview, setDetailsReview] = useState<OpenedConnection>()
  // The connected server whose Environment dialog is open.
  const [environmentFor, setEnvironmentFor] = useState<string>()
  // The query that Execute opened the Connect dialog for: it runs once connected.
  const [pendingExecute, setPendingExecute] = useState<string>()
  // Activity Monitor ran with no server connected: it opens on the connection the Connect dialog makes.
  const [pendingMonitor, setPendingMonitor] = useState(false)
  const { error: fileError, kind: fileKind } = useServiceSnapshot(files)
  const { error: commandError, kind: commandKind } = useServiceSnapshot(commands)
  const workspaceRef = useRef<WorkspaceHandle | null>(null)
  const active: QueryTab = tabs.find(tab => tab.id === activeId) ?? emptyTab
  // An XML, JSON or plan value opened from the results: no server, database, or results of its own. A table designer,
  // Database Properties, SSIS properties, an Activity Monitor and Integration Services Operations have a server, but it is their own: none has a query bar,
  // and the classic toolbar's lists do not change it.
  const activeKind = documentKind(active), isQuery = activeKind === 'sql'
  const isCustom = isCustomKind(activeKind)
  const queryInSplit = useServiceSelector(workbench.editorGroups, ({ groups }) => groups.length > 1
    && groups.some(group => group.active && isQueryDocument(documents.get(group.active))))
  const windowTitle = active.id ? `${active.dirty ? '* ' : ''}${active.name} — Varia SQL Manager` : 'Varia SQL Manager'
  const connection = connections.find(value => value.id === active.connectionId)
  const liveConnection = connection?.lost ? undefined : connection
  const readyGeneration = backendState.status === 'ready' ? backendState.generation : 0
  const backendDown = backendState.status !== 'ready' && backendState.status !== 'starting'
  const activeRunning = queryState[active.id]?.running
  const accent = useConnectionAccent(connection?.color)
  const versions = health ? `SMO ${health.smoVersion} / SqlClient ${health.sqlClientVersion}` : undefined

  // The active query's facts are in the window's status bar. Options can bring back SSMS's query window status bar, below
  // the query unless it puts it above. Either way the tooltip names the SMO and SqlClient versions.
  const statusTop = settings['textEditor.statusBar.location'] === 'top'
  const queryStatus = active.id && !isCustom ? <QueryStatusBar tab={active} connection={connection} versions={versions} variant={shell.queryStatusBar ? 'bar' : 'segment'} /> : null
  const statusBar = shell.queryStatusBar ? queryStatus : null

  /** The output view the active query shows, whose panel revealing the output shows. */
  const activeOutputView = useStableCallback(() => {
    const tabId = documents.getSnapshot().activeId
    return outputViewOf(workbench.results.getSnapshot()[tabId], workbench.queries.getSnapshot()[tabId]?.estimated, !!workbench.queryPlans.getSnapshot()[tabId])
  })
  const disconnectServer = useStableCallback((id: string, remove?: boolean) => disconnect(id, remove))
  // Stable for the app's lifetime; it reaches the dock workspace through its ref.
  const shellHost = useMemo<ShellHost>(() => ({
    disconnect: disconnectServer,
    removeConnection: id => { void disconnectServer(id, true) },
    reveal: (pane, options) => workspaceRef.current?.reveal(pane, options),
    revealOutput: options => workspaceRef.current?.revealOutput(activeOutputView(), options),
    toggleOutput: () => workspaceRef.current?.toggleOutput(activeOutputView()) ?? 'shown',
    manageLayouts: mode => workspaceRef.current?.manage(mode),
    resetLayout: () => workspaceRef.current?.reset(),
    flushLayout: async () => { await workspaceRef.current?.flush(true) },
    layoutCloseCancelled: () => workspaceRef.current?.closeCancelled(),
    showConnect: () => { setReconnecting(undefined); setPendingExecute(undefined); setPendingMonitor(false); setShowConnect(true) },
    reconnect: id => {
      const lost = workbench.connections.get(id)
      if (!lost) return
      const tab = documents.active
      if (workbench.connections.isLive(lost.id)) {
        if (tab && tab.targetId === lost.targetId && isQueryDocument(tab)) void targets.changeConnection(tab.id, lost.id)
        return
      }
      setReconnecting(id)
      setPendingExecute(undefined)
      setPendingMonitor(false)
      setOptions(lost.options)
      setShowConnect(true)
    },
    editEnvironment: id => setEnvironmentFor(id),
    closePane: pane => workspaceRef.current?.close(pane),
    paneLocation: pane => workspaceRef.current?.location(pane) ?? 'closed',
    floatPane: pane => workspaceRef.current?.float(pane),
    dockPane: pane => workspaceRef.current?.dock(pane),
    dockPaneAt: (pane, side) => workspaceRef.current?.dockAt(pane, side),
    tabPaneWith: (pane, other) => workspaceRef.current?.tabWith(pane, other),
    movePaneToWindow: pane => workspaceRef.current?.moveToWindow(pane),
    movePaneToMainWindow: pane => workspaceRef.current?.moveToMainWindow(pane)
  }), [disconnectServer, workbench, activeOutputView])
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
      if ((event.type === 'query.started' || event.type === 'query.finished') && event.tabId === documents.getSnapshot().activeId) workspaceRef.current?.revealOutput(activeOutputView())
      if (event.type === 'query.estimateStarted' && event.tabId === documents.getSnapshot().activeId) workspaceRef.current?.revealOutput('plan')
      if (event.type === 'documents.activated' || event.type === 'documents.closed') workspaceRef.current?.reveal('editor')
      // Execute on a query with no connection: connect first, as SSMS does, then run it.
      if (event.type === 'query.connectRequested') {
        const tab = documents.get(event.tabId), remembered = tab?.targetId ? workbench.connections.get(tab.targetId) : undefined
        setReconnecting(remembered?.targetId)
        if (remembered) setOptions(remembered.options)
        setPendingExecute(event.tabId); setPendingMonitor(false); setShowConnect(true)
      }
      if (event.type === 'activity.connectRequested') { setReconnecting(undefined); setPendingExecute(undefined); setPendingMonitor(true); setShowConnect(true) }
      if (event.type === 'help.aboutRequested') setShowAbout(true)
    })
    return () => subscription.dispose()
  }, [workbench, documents])
  useEffect(() => {
    document.title = windowTitle
  }, [windowTitle])
  async function connected(info: TargetConnectionInfo, chosen: ConnectionOptions, preference: ConnectionDetails['autoReconnect'], attempt: ConnectionAttempt, requestId: string, signal: AbortSignal) {
    const opened = await acceptConnectionReceipt({ api: window.varia, connections: workbench.connections, info, options: chosen, details: detailsOf(chosen, preference), attempt, requestId,
      current: () => !signal.aborted && !documents.getSnapshot().busy, explicitlyCancelled: () => signal.aborted })
    if (!opened) { setExplorerError('This connection changed while connecting. Select it again to reconnect.'); return }
    setOptions(chosen)
    setExplorerError(info.historyWarning ?? '')
    if (needsDetailsConfirmation(opened)) { setDetailsReview(opened); return }
    await finishConnected(opened, 'current')
  }
  async function finishConnected(opened: OpenedConnection, choice: 'selected' | 'current' | 'cancel') {
    setDetailsReview(undefined)
    if (choice === 'cancel') return
    const info = finishConnectionDetails(workbench.connections, opened, choice)
    if (!info) { setExplorerError('This connection changed while reviewing its details. Select it again to reconnect.'); return }
    setShowConnect(false)
    setReconnecting(undefined)
    setPendingExecute(undefined)
    setPendingMonitor(false)
    // Main has proved exact equivalence. Migrate only those remembered associations, preserving each query's database.
    if (info.targetId) {
      if (opened.sourceTargetId && opened.sourceTargetId !== info.targetId) {
        targets.coalesceTarget(opened.sourceTargetId, info.targetId, info.id, true)
        workbench.connectionTargets.removeFromExplorer(opened.sourceTargetId)
      }
      targets.rememberConnection(info.id, info.targetId)
      targets.attachTarget(info.targetId, info.id, true)
    }
    const root = workbench.explorer.rootIds.find(id => workbench.explorer.node(id)?.connectionId === info.id)
    if (root !== undefined) workbench.explorer.select(root, { reveal: true })
    if (pendingMonitor) {
      try { workbench.activity.open(info.id) } catch (error) { setExplorerError(errorText(error)) }
      return
    }
    const waiting = pendingExecute ? documents.get(pendingExecute) : undefined
    if (waiting && !workbench.connections.isLive(waiting.connectionId ?? '') && isQueryDocument(waiting) && !queries.isRunning(waiting.id)) {
      await targets.changeConnection(waiting.id, info.id)
      const attached = documents.get(waiting.id)
      if (attached?.connectionId === info.id && attached.attachWanted && workbench.connections.isLive(info.id) && !queries.isRunning(waiting.id)) void queries.execute(waiting.id)
      return
    }
    if (pendingExecute) return
    // A provisional root can appear while Connect still holds focus. Transfer it only after the picker has unmounted.
    focusWhenDrawn(nextFrame, () => workspaceRef.current?.reveal('explorer', { focus: true }))
    // Ordinary reuse only selects the existing root. New Query remains an explicit independent command.
    if (opened.reused) return
    const tab = documents.active
    // Connecting a second server must not silently retarget an existing query, and a value's document never connects.
    if (tab && !tab.connectionId && !tab.targetId && isQueryDocument(tab) && !queries.isRunning(tab.id)) await targets.changeConnection(tab.id, info.id)
    else documents.newQuery('', undefined, info.id, info.database)
  }

  async function disconnect(id: string, remove = false) {
    const connection = workbench.connections.get(id)
    if (!connection) return
    if (connection.targetId && workbench.connectionTargets.get(connection.targetId)) {
      const outcome = await workbench.disconnectCoordinator.disconnect(connection.targetId, remove ? 'remove-from-explorer' : 'disconnect')
      setExplorerError('error' in outcome ? outcome.error : 'warning' in outcome ? outcome.warning ?? '' : '')
      return
    }
    setExplorerError('This connection has no verified target. Reconnect it before changing its state.')
  }

  return <div className="app">
    <TitleBar title={windowTitle} center={<CommandCentre />} actions={shell.classicToolbar ? null : <StandardToolbar variant="header" />} />
    {shell.classicToolbar && <StandardToolbar variant="classic" />}
    <BackendBanner />
    {fileError && (fileKind === 'warning'
      ? <div className="global-error warning" role="status"><span>{fileError}</span><button aria-label="Dismiss file notice" onClick={() => files.clearError()}><Icon name="close" /></button></div>
      : <div className="global-error" role="alert"><span>{fileError}</span><button aria-label="Dismiss file error" onClick={() => files.clearError()}><Icon name="close" /></button></div>)}
    {commandError && (commandKind === 'warning'
      ? <div className="global-error warning" role="status"><span>{commandError}</span><button aria-label="Dismiss warning" onClick={() => commands.clearError()}><Icon name="close" /></button></div>
      : <div className="global-error" role="alert"><span>{commandError}</span><button aria-label="Dismiss command error" onClick={() => commands.clearError()}><Icon name="close" /></button></div>)}
    <ThemeNotice />
    <DockWorkspace ref={workspaceRef} explorer={<aside className="explorer"><ExplorerPane error={explorerError} activeConnectionId={liveConnection?.id} activeQueryId={isQuery ? active.id || undefined : undefined} /></aside>} editor={<main className="workspace">
        {/* The active query's own bar, unless the classic toolbar brings back the global lists (for one release). */}
        {!shell.classicToolbar && (active.id && isQuery ? <QueryBar /> : queryInSplit && <div className="query-bar-spacer" aria-hidden="true" />)}
        {statusTop && statusBar}
        {/* Editor groups: each with its tab strip and editor; designers, properties and monitors render in their own panels. */}
        <EditorArea />
        {!statusTop && statusBar}
      </main>} results={<OutputPane pane="results" tabId={active.id} query={isQuery} connected={!!liveConnection} hint={connection?.lost ? lostHint : undefined} />}
      messages={<OutputPane pane="messages" tabId={active.id} query={isQuery} connected={!!liveConnection} hint={connection?.lost ? lostHint : undefined} />}
      plan={<OutputPane pane="plan" tabId={active.id} query={isQuery} connected={!!liveConnection} hint={connection?.lost ? lostHint : undefined} />}
      statistics={<OutputPane pane="statistics" tabId={active.id} query={isQuery} connected={!!liveConnection} />} />
    <OutputViewSync tabId={active.id} />
    <OutputAnnouncer tabId={active.id} />
    {/* Neutral until work runs: tinted while the active query executes, or while the backend is down. */}
    <footer className="status-bar" aria-label="Status bar" data-state={backendDown ? 'error' : activeRunning ? 'executing' : !liveConnection ? 'disconnected' : 'ready'} style={{ borderTop: accent ? `2px solid ${accent}` : undefined }}>
      <span className="backend-status" title={backendState.status === 'ready' ? ['SQL backend: ' + backendState.runtime, versions].filter(Boolean).join('\n') : undefined}><span className={`status-dot ${backendState.status === 'ready' ? 'online' : ''}`} />{backendStatusText(backendState)}</span>
      {environmentTag(connection?.options.environment) && <span className="status-environment"><span className="visually-hidden">Active connection environment: </span><EnvironmentTag environment={connection?.options.environment} place="status" about={connection?.displayName || connection?.server} /></span>}
      {!shell.queryStatusBar && queryStatus}<ScriptingStatus /><IndexStatus /><EditorStatus /><MemoryIndicator /><UpdateStatus />
    </footer>
    {environmentFor && <EnvironmentDialog key={environmentFor} connectionId={environmentFor} onClose={() => setEnvironmentFor(undefined)} />}
    {showConnect && <ConnectDialog initial={options} reviewOpen={!!detailsReview} initialTargetId={reconnecting && workbench.connectionTargets.get(workbench.connections.get(reconnecting)?.targetId ?? '') ? workbench.connections.get(reconnecting)?.targetId : undefined} initialAutoReconnect={reconnecting ? workbench.connections.details(reconnecting)?.autoReconnect : 'inherit'} onConnected={connected} onClose={() => { setDetailsReview(undefined); setShowConnect(false); setReconnecting(undefined); setPendingExecute(undefined); setPendingMonitor(false) }} />}
    {detailsReview && <ConnectionDetailsDialog current={detailsReview.current} selected={detailsReview.selected} server={workbench.connections.get(detailsReview.id)?.server ?? ''} database={workbench.connections.get(detailsReview.id)?.database ?? ''} account={workbench.connections.get(detailsReview.id)?.login} onChoose={choice => { void finishConnected(detailsReview, choice).catch(error => setExplorerError(errorText(error))) }} />}
    <DisconnectDialog service={workbench.disconnectPrompts} />
    {filterFolder !== undefined && <FilterDialog key={filterFolder} folderId={filterFolder} />}
    {optionsDialog.open && <OptionsDialog page={optionsDialog.page} />}
    <ObjectDialog />
    <CreateCatalogDialog />
    <ServerFilePicker />
    {editorDialogs.goToLine && <GoToLineDialog request={editorDialogs.goToLine} />}
    {recoveryOpen && <RecoveryDialog />}
    {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
    <Toasts snapshot={toasts} notifications={workbench.notifications} focusFallback={() => documents.focusActive()} />
    <QuickInput />
    <MenuLayer />
  </div>
}
