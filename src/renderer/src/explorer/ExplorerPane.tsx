import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { useCommandEnabled, useKeybindingLabel } from '../core/useCommand'
import type { CommandArgs, CommandId } from '../core/types'
import { useMenuTarget } from '../menus/useMenuTarget'
import Icon from '../Icon'
import ExplorerErrorBoundary, { FaultProbe } from './ExplorerErrorBoundary'
import ExplorerTree from './ExplorerTree'

function ToolbarButton({ id, icon, label, args }: { id: CommandId; icon: string; label: string; args?: CommandArgs }) {
  const { commands } = useWorkbench()
  const enabled = useCommandEnabled(id, args), key = useKeybindingLabel(id)
  const title = key ? `${label} (${key.text})` : label
  return <button className="icon-button" aria-label={label} title={title} disabled={!enabled} onClick={() => void commands.execute(id, args, 'toolbar')}>
    <span className={`codicon codicon-${icon}`} aria-hidden="true" />
  </button>
}

/**
 * Object Explorer: SSMS's toolbar (Connect, Disconnect, Stop, Filter, Refresh, Collapse All) over the tree of connected
 * servers, or a prompt to connect. Disconnect acts on the selected node's server; with nothing selected it asks which.
 * Filter shows a filled funnel while the selected folder has a filter.
 */
export default function ExplorerPane({ error, activeConnectionId }: { readonly error?: string; readonly activeConnectionId?: string }) {
  const { explorer, connections, commands } = useWorkbench()
  const { selected } = useServiceSnapshot(explorer)
  const { explorerSelectionFiltered: filtered } = useServiceSnapshot(explorer.context)
  const servers = useServiceSnapshot(connections)
  const connect = useCommandEnabled('connection.connect')
  const selectedServer = explorer.menuNode(selected)?.connectionId
  const serverNode = selectedServer === undefined ? undefined : explorer.menuNode(explorer.rootIds.find(id => explorer.node(id)?.connectionId === selectedServer))
  const disconnectArgs: CommandArgs | undefined = serverNode ? { target: { kind: 'explorer', node: serverNode } } : undefined
  // The empty area below the servers: Connect… and Refresh. Rows register their own menus.
  const background = useMenuTarget<HTMLDivElement>(() => ({ kind: 'explorer' }))
  const live = servers.filter(value => !value.lost).length
  return <>
    <div className="explorer-toolbar" role="toolbar" aria-label="Object Explorer toolbar">
      <ToolbarButton id="connection.connect" icon="plug" label="Connect Object Explorer" />
      <ToolbarButton id="connection.disconnect" icon="debug-disconnect" label="Disconnect" args={disconnectArgs} />
      <ToolbarButton id="explorer.stop" icon="debug-stop" label="Stop" />
      <ToolbarButton id="explorer.filter" icon={filtered ? 'filter-filled' : 'filter'} label="Filter Settings" />
      <ToolbarButton id="explorer.refresh" icon="refresh" label="Refresh" />
      <ToolbarButton id="explorer.collapseAll" icon="collapse-all" label="Collapse All" />
    </div>
    <div className="explorer-body" ref={background}>
      {servers.length ? <ExplorerErrorBoundary onReload={() => explorer.reset()}><FaultProbe /><ExplorerTree activeConnectionId={activeConnectionId} /></ExplorerErrorBoundary>
        : <div className="explorer-empty"><Icon name="server" /><p>Connect to SQL Server to browse databases and objects.</p><button disabled={!connect} onClick={() => void commands.execute('connection.connect', undefined, 'toolbar')}>Connect to server</button></div>}
      {error && <p className="explorer-error" role="alert">{error}</p>}
    </div>
    <div className="explorer-footer">{live ? `${live} connected server${live === 1 ? '' : 's'}` : servers.length ? 'No connected servers' : 'Windows & SQL authentication'}</div>
  </>
}
