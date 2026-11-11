import { useId } from 'react'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import DocumentFrame from '../kit/DocumentFrame'
import SearchPanel from './SearchPanel'
import ServerPicker, { allServersValue, serverPickerOptions } from './ServerPicker'

export { indexSummary, searchHitPath, unindexedServers } from './SearchPanel'

/** Search Objects: a server's object index searched by name and inside module definitions, with Match Case, Whole Word and Regex,
 *  as Object Explorer's box searches it, in a tab of its own with a server picker, which can also search all connected servers. */
export default function ObjectSearch({ documentId }: { readonly documentId: string }) {
  const { objectSearch, connections } = useWorkbench()
  const snapshot = useServiceSnapshot(objectSearch)
  const connectionList = useServiceSnapshot(connections)
  const labelId = useId(), pickerId = useId()
  const state = snapshot.documents[documentId]
  if (!state) return null
  const connection = connectionList.find(item => item.id === state.connectionId)
  const live = connectionList.filter(item => !item.lost)
  const server = state.allServers ? 'All servers' : connection?.displayName || connection?.server || 'Disconnected'
  const crumb = state.allServers ? { label: server, title: live.map(item => item.displayName || item.server).join(', ') } : { label: server, ...connection ? { title: `${connection.server} · ${connection.serverVersion}` } : {} }
  // The picker shows once there is a choice: several servers, or an All servers search (which may have one server left). Each
  // server shows its colour, environment and results for the current search; All servers its total.
  const picker = (live.length > 1 || state.allServers) && <div className="object-search-server"><span id={labelId}>Server</span>
    <ServerPicker id={pickerId} labelledBy={labelId} options={serverPickerOptions(state, live)} value={state.allServers ? allServersValue : state.connectionId}
      onChange={value => { if (value === allServersValue) objectSearch.setAllServers(documentId); else objectSearch.setConnection(documentId, value) }} />
  </div>
  return <DocumentFrame id={`object-search-${documentId}`} title="Search Objects" crumbs={[crumb]}
    verbs={[{ command: 'explorer.rebuildIndex' }]} attributes={{ 'data-object-search': documentId }}>
    <SearchPanel searchId={documentId} layout="tab" options={picker} />
  </DocumentFrame>
}
