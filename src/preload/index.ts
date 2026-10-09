import { contextBridge, ipcRenderer } from 'electron'
import type { ApiResult, BackendState, RpcMethod, RpcMethods, VariaApi } from '../shared/contracts'
import type { CommandId } from '../shared/commands/catalog'
import type { ContextMenuCommand } from '../shared/commands/menus'
import { menuStyleFromArgv } from '../shared/menu-style'
import type { ThemeState } from '../shared/theme/types'

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
  saveConnectionProfile: profile => ipcRenderer.invoke('varia:connections-save', profile),
  removeConnectionProfile: id => ipcRenderer.invoke('varia:connections-remove', id),
  disconnect: connectionId => request('connections.disconnect', { connectionId }),
  databases: connectionId => request('databases.list', { connectionId }),
  scriptTable: (connectionId, database, schema, name) => request('tables.script', { connectionId, database, schema, name }),
  tableColumns: (connectionId, database, schema, name) => request('tables.columns', { connectionId, database, schema, name }),
  explorerChildren: params => request('explorer.children', params),
  explorerCancel: requestIds => ipcRenderer.invoke('varia:explorer-cancel', { requestIds }),
  scriptObjects: params => request('scripting.script', params),
  cancelScripting: requestIds => ipcRenderer.invoke('varia:scripting-cancel', { requestIds }),
  getScriptingOptions: () => ipcRenderer.invoke('varia:scripting-options-get'),
  setScriptingOptions: options => ipcRenderer.invoke('varia:scripting-options-set', options),
  execute: options => request('query.execute', options),
  cancel: queryId => request('query.cancel', { queryId }),
  closeQuerySession: sessionId => request('query.session.close', { sessionId }),
  getBackendState: () => ipcRenderer.invoke('varia:backend-state-get'),
  onBackendState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: BackendState) => callback(state)
    ipcRenderer.on('varia:backend-state', listener)
    return () => { ipcRenderer.removeListener('varia:backend-state', listener) }
  },
  restartBackend: () => ipcRenderer.invoke('varia:backend-restart'),
  openResultsPort: () => ipcRenderer.invoke('varia:results-port-open'),
  testMode: process.argv.includes('--varia-test-mode'),
  openSqlFiles: () => ipcRenderer.invoke('varia:files-open'),
  saveSqlFile: options => ipcRenderer.invoke('varia:files-save', options),
  releaseSqlFile: fileId => ipcRenderer.invoke('varia:files-release', fileId),
  revealSqlFile: fileId => ipcRenderer.invoke('varia:files-reveal', fileId),
  writeClipboardText: text => ipcRenderer.invoke('varia:clipboard-write', text),
  confirmClose: name => ipcRenderer.invoke('varia:confirm-close', name),
  closeWindow: () => ipcRenderer.invoke('varia:close-window'),
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
// The results port goes to the page itself (window message, then ResultClient hands it to the results worker); no port,
// postMessage or invoke is ever exposed on window.varia.
ipcRenderer.on('varia:results-port', event => { window.postMessage({ type: 'varia:results-port' }, '*', event.ports) })
