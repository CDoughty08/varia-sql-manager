import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import type { IndexEntry } from './ObjectSearchService'

const numbers = new Intl.NumberFormat('en-US')

/** What a build's done / total counts: SQL Server's databases (and BigQuery's other phases) read as "objects", a BigQuery names
 *  pass counts datasets listed, its details pass objects read. */
const counted = (entry: IndexEntry) => entry.phase === 'names' ? 'Listing BigQuery datasets' : entry.phase === 'details' ? 'Reading BigQuery object details' : 'Indexing objects'

/** Status bar label for running object index builds: what the numbers count (BigQuery's names and details passes say which), a
 *  "~" total while BigQuery projects still being listed may add to it, and "(rate limited)" while BigQuery refuses calls. Builds
 *  counting different things are not summed. */
export function indexStatusText(running: readonly IndexEntry[]): string {
  const done = running.reduce((sum, entry) => sum + entry.done, 0), total = running.reduce((sum, entry) => sum + entry.total, 0)
  const servers = running.length > 1 ? ` on ${running.length} servers` : ''
  const limited = running.some(entry => entry.throttled) ? ' (rate limited)' : ''
  const labels = new Set(running.map(counted))
  if (total && labels.size === 1) {
    const approx = running.some(entry => entry.growing) ? '~' : ''
    return `${counted(running[0]!)} ${numbers.format(done)} / ${approx}${numbers.format(total)}${servers}${limited}`
  }
  if (!total && running.some(entry => entry.phase === 'projects')) return `Discovering BigQuery projects${servers}…${limited}`
  return `Indexing objects${servers}…${limited}`
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
