import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ApiResult, BackendState, OpenedFiles, RecentFile, ResultsJobProgress, RpcMethod, RpcMethods, VariaApi } from '../shared/contracts'
import type { CommandId } from '../shared/commands/catalog'
import type { ContextMenuCommand } from '../shared/commands/menus'
import { menuStyleFromArgv } from '../shared/menu-style'
import type { ThemeState } from '../shared/theme/types'
import type { SettingsState } from '../shared/settings/schema'
// Bundled into this one file: a sandboxed preload can require only electron and a few Node built-ins.
import { installFileDrop } from './drop'

const request = <M extends RpcMethod>(method: M, params: RpcMethods[M]['params']): Promise<ApiResult<RpcMethods[M]['result']>> => ipcRenderer.invoke('varia:request', method, params)

const api: VariaApi = {
  platform: process.platform,
  setMenuState: state => { ipcRenderer.send('varia:menu-state', state) },
  runRole: role => ipcRenderer.invoke('varia:run-role', role),
  // Main passes its choice as a renderer argument; anything else there means the platform's default.
  menuStyle: menuStyleFromArgv(process.argv, process.platform),
  showContextMenu: request => ipcRenderer.invoke('varia:context-menu', request),
  onContextMenuCommand: callback => {
    const listener = (_event: Electron.IpcRendererEvent, command: ContextMenuCommand) => callback(command)
    ipcRenderer.on('varia:context-menu-command', listener)
    return () => { ipcRenderer.removeListener('varia:context-menu-command', listener) }
  },
  health: () => request('system.health', {}),
  connect: options => request('connections.connect', options),
  discoverDatabases: options => request('connections.databases', options),
  discoverServers: scope => request('connections.discover', { scope }),
  previewConnection: options => request('connections.preview', options),
  loadConnectionLibrary: () => ipcRenderer.invoke('varia:connections-load'),
  integratedIdentity: () => request('connections.identity', {}),
  saveConnectionProfile: profile => ipcRenderer.invoke('varia:connections-save', profile),
  removeConnectionProfile: id => ipcRenderer.invoke('varia:connections-remove', id),
  disconnect: connectionId => request('connections.disconnect', { connectionId }),
  databases: connectionId => request('databases.list', { connectionId }),
  tableColumns: (connectionId, database, schema, name) => request('tables.columns', { connectionId, database, schema, name }),
  explorerChildren: params => request('explorer.children', params),
  explorerCancel: requestIds => ipcRenderer.invoke('varia:explorer-cancel', { requestIds }),
  scriptObjects: params => request('scripting.script', params),
  cancelScripting: requestIds => ipcRenderer.invoke('varia:scripting-cancel', { requestIds }),
  describeObject: params => request('actions.describe', params),
  scriptObjectAction: params => request('actions.script', params),
  executeObjectAction: params => request('actions.execute', params),
  cancelObjectActions: requestIds => ipcRenderer.invoke('varia:actions-cancel', { requestIds }),
  getSettings: () => ipcRenderer.invoke('varia:settings-get'),
  updateSettings: patch => ipcRenderer.invoke('varia:settings-update', patch),
  onSettingsChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: SettingsState) => callback(state)
    ipcRenderer.on('varia:settings-changed', listener)
    return () => { ipcRenderer.removeListener('varia:settings-changed', listener) }
  },
  execute: options => request('query.execute', options),
  cancel: queryId => request('query.cancel', { queryId }),
  closeQuerySession: (sessionId, transaction) => request('query.session.close', transaction ? { sessionId, transaction } : { sessionId }),
  querySessionState: sessionId => request('query.session.state', { sessionId }),
  getBackendState: () => ipcRenderer.invoke('varia:backend-state-get'),
  onBackendState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: BackendState) => callback(state)
    ipcRenderer.on('varia:backend-state', listener)
    return () => { ipcRenderer.removeListener('varia:backend-state', listener) }
  },
  restartBackend: () => ipcRenderer.invoke('varia:backend-restart'),
  openResultsPort: () => ipcRenderer.invoke('varia:results-port-open'),
  copyResults: request => ipcRenderer.invoke('varia:results-copy', request),
  saveResults: request => ipcRenderer.invoke('varia:results-save', request),
  cancelResultsJob: jobId => ipcRenderer.invoke('varia:results-job-cancel', jobId),
  onResultsJob: callback => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ResultsJobProgress) => callback(progress)
    ipcRenderer.on('varia:results-job', listener)
    return () => { ipcRenderer.removeListener('varia:results-job', listener) }
  },
  testMode: process.argv.includes('--varia-test-mode'),
  openSqlFiles: () => ipcRenderer.invoke('varia:files-open'),
  saveSqlFile: options => ipcRenderer.invoke('varia:files-save', options),
  releaseSqlFile: fileId => ipcRenderer.invoke('varia:files-release', fileId),
  revealSqlFile: fileId => ipcRenderer.invoke('varia:files-reveal', fileId),
  onFilesOpened: callback => {
    const listener = (_event: Electron.IpcRendererEvent, opened: OpenedFiles) => callback(opened)
    ipcRenderer.on('varia:files-opened', listener)
    return () => { ipcRenderer.removeListener('varia:files-opened', listener) }
  },
  checkSqlFiles: () => ipcRenderer.invoke('varia:files-check'),
  reloadSqlFile: fileId => ipcRenderer.invoke('varia:files-reload', fileId),
  confirmReload: prompt => ipcRenderer.invoke('varia:confirm-reload', prompt),
  recentFiles: () => ipcRenderer.invoke('varia:recent-files'),
  openRecentFile: id => ipcRenderer.invoke('varia:recent-files-open', id),
  clearRecentFiles: () => ipcRenderer.invoke('varia:recent-files-clear'),
  onRecentFiles: callback => {
    const listener = (_event: Electron.IpcRendererEvent, files: RecentFile[]) => callback(files)
    ipcRenderer.on('varia:recent-files-changed', listener)
    return () => { ipcRenderer.removeListener('varia:recent-files-changed', listener) }
  },
  writeRecovery: record => ipcRenderer.invoke('varia:recovery-write', record),
  discardRecovery: ids => ipcRenderer.invoke('varia:recovery-discard', { ids }),
  listRecovery: () => ipcRenderer.invoke('varia:recovery-list'),
  takeRecovery: id => ipcRenderer.invoke('varia:recovery-take', { id }),
  writeClipboardText: text => ipcRenderer.invoke('varia:clipboard-write', text),
  confirmClose: name => ipcRenderer.invoke('varia:confirm-close', name),
  confirmSessions: request => ipcRenderer.invoke('varia:confirm-sessions', request),
  closeWindow: () => ipcRenderer.invoke('varia:close-window'),
  closeWindowCancelled: () => { ipcRenderer.send('varia:close-cancelled') },
  loadLayouts: () => ipcRenderer.invoke('varia:layouts-load'),
  saveLayouts: state => ipcRenderer.invoke('varia:layouts-save', state),
  importLayout: () => ipcRenderer.invoke('varia:layout-import'),
  exportLayout: layout => ipcRenderer.invoke('varia:layout-export', layout),
  onCommand: callback => {
    const listener = (_event: Electron.IpcRendererEvent, command: CommandId) => callback(command)
    ipcRenderer.on('varia:command', listener)
    // Main runs the unsaved-query exit flow only while the workbench is subscribed to commands.
    ipcRenderer.send('varia:commands-ready', true)
    return () => {
      ipcRenderer.removeListener('varia:command', listener)
      if (!ipcRenderer.listenerCount('varia:command')) ipcRenderer.send('varia:commands-ready', false)
    }
  },
  getThemeState: () => ipcRenderer.invoke('varia:theme-state'),
  setThemePreference: patch => ipcRenderer.invoke('varia:theme-set', patch),
  previewTheme: selection => ipcRenderer.invoke('varia:theme-preview', selection),
  createCustomTheme: () => ipcRenderer.invoke('varia:themes-create'),
  reloadThemes: () => ipcRenderer.invoke('varia:themes-reload'),
  openThemesFolder: () => ipcRenderer.invoke('varia:themes-open-folder'),
  onThemeChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: ThemeState) => callback(state)
    ipcRenderer.on('varia:theme-changed', listener)
    return () => { ipcRenderer.removeListener('varia:theme-changed', listener) }
  }
}
contextBridge.exposeInMainWorld('varia', api)
// Files dropped on the window open as queries. The paths go straight to main: window.varia has no drop or path method,
// so page script can name no path.
installFileDrop(window, { pathForFile: file => webUtils.getPathForFile(file), send: paths => { ipcRenderer.send('varia:files-dropped', paths) } })
// The results port goes to the page itself (window message, then ResultClient hands it to the results worker); no port,
// postMessage or invoke is ever exposed on window.varia.
ipcRenderer.on('varia:results-port', event => { window.postMessage({ type: 'varia:results-port' }, '*', event.ports) })
