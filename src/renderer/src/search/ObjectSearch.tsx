import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import DocumentFrame from '../kit/DocumentFrame'
import SearchPanel from './SearchPanel'

export { indexSummary } from './SearchPanel'

/** Search Objects: a server's object index searched by name and inside module definitions, with Match Case, Whole Word and Regex,
 *  as Object Explorer's box searches it, in a tab of its own with a server picker. */
export default function ObjectSearch({ documentId }: { readonly documentId: string }) {
  const { objectSearch, connections } = useWorkbench()
  const snapshot = useServiceSnapshot(objectSearch)
  const connectionList = useServiceSnapshot(connections)
  const state = snapshot.documents[documentId]
  if (!state) return null
  const connection = connectionList.find(item => item.id === state.connectionId)
  const server = connection?.displayName || connection?.server || 'Disconnected'
  const live = connectionList.filter(item => !item.lost)
  return <DocumentFrame id={`object-search-${documentId}`} title="Search Objects" crumbs={[{ label: server, ...connection ? { title: `${connection.server} · ${connection.serverVersion}` } : {} }]}
    verbs={[{ command: 'explorer.rebuildIndex' }]} attributes={{ 'data-object-search': documentId }}>
    <SearchPanel searchId={documentId} layout="tab" options={live.length > 1 && <label className="object-search-server">Server <select value={state.connectionId} onChange={event => objectSearch.setConnection(documentId, event.target.value)}>
      {live.map(item => <option key={item.id} value={item.id}>{item.displayName || item.server}</option>)}
    </select></label>} />
  </DocumentFrame>
}
