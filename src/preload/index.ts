import { contextBridge, ipcRenderer } from 'electron'
import type { ApiResult, RpcMethod, RpcMethods, VariaApi } from '../shared/contracts'
import type { CommandId } from '../shared/commands/catalog'
import type { ThemeState } from '../shared/theme/types'

const request = <M extends RpcMethod>(method: M, params: RpcMethods[M]['params']): Promise<ApiResult<RpcMethods[M]['result']>> => ipcRenderer.invoke('varia:request', method, params)

const api: VariaApi = {
  platform: process.platform,
  setMenuState: state => { ipcRenderer.send('varia:menu-state', state) },
  runRole: role => ipcRenderer.invoke('varia:run-role', role),
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
  serverObjects: (connectionId, kind) => request('server.objects.list', { connectionId, kind }),
  tables: (connectionId, database) => request('tables.list', { connectionId, database }),
  scriptTable: (connectionId, database, schema, name) => request('tables.script', { connectionId, database, schema, name }),
  execute: options => request('query.execute', options),
  cancel: queryId => request('query.cancel', { queryId }),
  closeQuerySession: sessionId => request('query.session.close', { sessionId }),
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
