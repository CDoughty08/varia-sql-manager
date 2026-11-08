import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import DocumentFrame from '../kit/DocumentFrame'
import SearchPanel from './SearchPanel'

export { indexSummary, searchHitPath } from './SearchPanel'

/** The server picker's value for All servers. */
const allServersValue = '*'

/** Search Objects: a server's object index searched by name and inside module definitions, with Match Case, Whole Word and Regex,
 *  as Object Explorer's box searches it, in a tab of its own with a server picker, which can also search all connected servers. */
export default function ObjectSearch({ documentId }: { readonly documentId: string }) {
  const { objectSearch, connections } = useWorkbench()
  const snapshot = useServiceSnapshot(objectSearch)
  const connectionList = useServiceSnapshot(connections)
  const state = snapshot.documents[documentId]
  if (!state) return null
  const connection = connectionList.find(item => item.id === state.connectionId)
  const live = connectionList.filter(item => !item.lost)
  const server = state.allServers ? 'All servers' : connection?.displayName || connection?.server || 'Disconnected'
  const crumb = state.allServers ? { label: server, title: live.map(item => item.displayName || item.server).join(', ') } : { label: server, ...connection ? { title: `${connection.server} · ${connection.serverVersion}` } : {} }
  // The picker shows once there is a choice: several servers, or an All servers search (which may have one server left).
  const picker = (live.length > 1 || state.allServers) && <label className="object-search-server">Server <select value={state.allServers ? allServersValue : state.connectionId}
    onChange={event => { if (event.target.value === allServersValue) objectSearch.setAllServers(documentId); else objectSearch.setConnection(documentId, event.target.value) }}>
    <option value={allServersValue}>{`All servers (${live.length})`}</option>
    {live.map(item => <option key={item.id} value={item.id}>{item.displayName || item.server}</option>)}
  </select></label>
  return <DocumentFrame id={`object-search-${documentId}`} title="Search Objects" crumbs={[crumb]}
    verbs={[{ command: 'explorer.rebuildIndex' }]} attributes={{ 'data-object-search': documentId }}>
    <SearchPanel searchId={documentId} layout="tab" options={picker} />
  </DocumentFrame>
}
