import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import type { IndexEntry } from './ObjectSearchService'

const numbers = new Intl.NumberFormat('en-US')

/** Status bar label for running object index builds, handling BigQuery project discovery before dataset counts arrive. */
export function indexStatusText(running: readonly IndexEntry[]): string {
  const done = running.reduce((sum, entry) => sum + entry.done, 0), total = running.reduce((sum, entry) => sum + entry.total, 0)
  const servers = running.length > 1 ? ` on ${running.length} servers` : ''
  if (total) return `Indexing objects ${numbers.format(done)} / ${numbers.format(total)}${servers}`
  if (running.some(entry => entry.phase === 'projects')) return `Discovering BigQuery projects${servers}…`
  return `Indexing objects${servers}…`
}

/** The status bar's "Indexing objects 3 / 12": the object index builds running, with Stop; hidden while none runs. */
export default function IndexStatus() {
  const { objectSearch, commands } = useWorkbench()
  const { indexes } = useServiceSnapshot(objectSearch)
  const running = Object.values(indexes).filter(entry => entry.requestId)
  if (!running.length) return null
  const objects = running.reduce((sum, entry) => sum + entry.objects, 0)
  const text = indexStatusText(running)
  return <span className="index-status" role="status" title={`Search Objects is reading object names and definitions, database by database (BigQuery: dataset by dataset, then each object's details): ${numbers.format(objects)} objects so far.`}>
    <Icon name="search" />
    <button type="button" className="index-status-text" onClick={() => void commands.execute('explorer.searchObjects', undefined, 'toolbar')}>{text}</button>
    <button type="button" onClick={() => void commands.execute('explorer.stopIndexing', undefined, 'toolbar')}>Stop</button>
  </span>
}
