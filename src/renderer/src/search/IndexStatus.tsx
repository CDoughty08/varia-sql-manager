import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'

const numbers = new Intl.NumberFormat('en-US')

/** The status bar's "Indexing objects 3 / 12": the object index builds running, with Stop; hidden while none runs. */
export default function IndexStatus() {
  const { objectSearch, commands } = useWorkbench()
  const { indexes } = useServiceSnapshot(objectSearch)
  const running = Object.values(indexes).filter(entry => entry.requestId)
  if (!running.length) return null
  const done = running.reduce((sum, entry) => sum + entry.done, 0), total = running.reduce((sum, entry) => sum + entry.total, 0)
  const objects = running.reduce((sum, entry) => sum + entry.objects, 0)
  const servers = running.length > 1 ? ` on ${running.length} servers` : ''
  const text = total ? `Indexing objects ${numbers.format(done)} / ${numbers.format(total)}${servers}` : `Indexing objects${servers}…`
  return <span className="index-status" role="status" title={`Search Objects is reading object names and definitions, one database at a time: ${numbers.format(objects)} objects so far.`}>
    <Icon name="search" />
    <button type="button" className="index-status-text" onClick={() => void commands.execute('explorer.searchObjects', undefined, 'toolbar')}>{text}</button>
    <button type="button" onClick={() => void commands.execute('explorer.stopIndexing', undefined, 'toolbar')}>Stop</button>
  </span>
}
