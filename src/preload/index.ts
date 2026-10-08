import { contextBridge, ipcRenderer } from 'electron'
import type { ApiResult, AppMenu, RpcMethod, RpcMethods, VariaApi, WorkbenchCommand } from '../shared/contracts'

const request = <M extends RpcMethod>(method: M, params: RpcMethods[M]['params']): Promise<ApiResult<RpcMethods[M]['result']>> => ipcRenderer.invoke('varia:request', method, params)

const api: VariaApi = {
  platform: process.platform,
  showMenu: options => ipcRenderer.invoke('varia:menu-popup', options),
  onMenuFocus: callback => {
    const listener = (_event: Electron.IpcRendererEvent, menu: AppMenu | null) => callback(menu)
    ipcRenderer.on('varia:menu-focus', listener)
    return () => { ipcRenderer.removeListener('varia:menu-focus', listener) }
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
  serverObjects: (connectionId, kind) => request('server.objects.list', { connectionId, kind }),
  tables: (connectionId, database) => request('tables.list', { connectionId, database }),
  scriptTable: (connectionId, database, schema, name) => request('tables.script', { connectionId, database, schema, name }),
  execute: options => request('query.execute', options),
  cancel: queryId => request('query.cancel', { queryId }),
  closeQuerySession: sessionId => request('query.session.close', { sessionId }),
  openSqlFiles: () => ipcRenderer.invoke('varia:files-open'),
  saveSqlFile: options => ipcRenderer.invoke('varia:files-save', options),
  releaseSqlFile: fileId => ipcRenderer.invoke('varia:files-release', fileId),
  confirmClose: name => ipcRenderer.invoke('varia:confirm-close', name),
  closeWindow: () => ipcRenderer.invoke('varia:close-window'),
  loadLayouts: () => ipcRenderer.invoke('varia:layouts-load'),
  saveLayouts: state => ipcRenderer.invoke('varia:layouts-save', state),
  importLayout: () => ipcRenderer.invoke('varia:layout-import'),
  exportLayout: layout => ipcRenderer.invoke('varia:layout-export', layout),
  onCommand: callback => {
    const listener = (_event: Electron.IpcRendererEvent, command: WorkbenchCommand) => callback(command)
    ipcRenderer.on('varia:command', listener)
    // Main runs the unsaved-query exit flow only while the workbench is subscribed to commands.
    ipcRenderer.send('varia:commands-ready', true)
    return () => {
      ipcRenderer.removeListener('varia:command', listener)
      if (!ipcRenderer.listenerCount('varia:command')) ipcRenderer.send('varia:commands-ready', false)
    }
  }
}
contextBridge.exposeInMainWorld('varia', api)
