import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ColumnProfile, ProfileLengths } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { sqlTypeLabel } from '../grid/measure'
import Icon from '../Icon'
import type { ResultHandle } from './ResultClient'
import type { TabResults } from './ResultsService'
import { chunked, histogramCaptions, histogramHeights, profileLines, rowSizeText } from './profile-format'
import { formatCount, plural } from './status'

interface Profiles {
  readonly handle: ResultHandle
  readonly rows?: number
  readonly complete?: boolean
  readonly rowBytes?: ProfileLengths
  readonly columns: ReadonlyMap<number, ColumnProfile>
  readonly loading: boolean
  readonly error?: string
}

/** One column's card: its name and type, its figures, and its histogram (drawn from theme colours, decorative: the
 *  figures say what it shows). */
function ProfileCard({ name, type, profile, rows }: { name: string; type: string; profile: ColumnProfile | undefined; rows: number }) {
  const histogram = profile?.histogram
  return <section className="profile-card" aria-label={name}>
    <div className="profile-card-title"><b>{name}</b><span>{type}</span></div>
    {profile ? <dl className="profile-figures">
      {profileLines(profile, rows).map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}
    </dl> : <div className="profile-pending">Profiling…</div>}
    {histogram && <>
      <div className="profile-histogram" aria-hidden="true" title={`Histogram ${histogramCaptions[histogram.basis]}`}>
        {histogramHeights(histogram.counts).map((height, index) => <i key={index} style={{ height: height + '%' }} />)}
      </div>
      <div className="profile-caption">{histogramCaptions[histogram.basis]}</div>
    </>}
  </section>
}

/**
 * The column profile panel (queryResults.grid.columnProfile), beside the stacked grids: a card per column of the set that
 * last had focus, computed in the backend over the rows its grid shows (results.profile through its sorted view), 32
 * columns a request. It asks again when the grid shows another view or the set finishes loading; a newer request cancels
 * the older. It holds only aggregates, never rows.
 */
export default function ColumnProfilePanel({ tabId, tab, index }: { tabId: string; tab: TabResults; index: number }) {
  const { results, commands } = useWorkbench()
  useServiceSnapshot(results)
  const entry = tab.sets.find(set => set.index === index) ?? tab.sets[0]
  const handle = entry ? results.sortOf(tabId, entry.index)?.view ?? entry.handle : undefined
  const snapshot = useSyncExternalStore(handle?.subscribe ?? noSubscribe, handle?.getSnapshot ?? noSnapshot)
  const [profiles, setProfiles] = useState<Profiles | undefined>(undefined)
  const columns = entry ? entry.descriptor.columns.flatMap((column, at) => column.role === 'tone' ? [] : [at]) : []
  const columnKey = columns.join(',')
  const held = snapshot && snapshot.state !== 'released' && snapshot.state !== 'lost'
  // A set still loading is profiled once and again when it completes; a complete one when its rows (a view's) change.
  const settled = !snapshot ? '' : snapshot.state === 'complete' ? 'complete:' + snapshot.rowsAvailable : snapshot.state
  useEffect(() => {
    if (!handle || !held) return
    const abort = new AbortController()
    let current: Profiles = { handle, columns: new Map(), loading: true }
    setProfiles(previous => previous?.handle === handle ? { ...previous, loading: true, error: undefined } : current)
    const wanted = columnKey ? columnKey.split(',').map(Number) : []
    void (async () => {
      try {
        for (const part of wanted.length ? chunked(wanted, wire.profile.maxColumns) : [[]]) {
          const result = await handle.profile(part, abort.signal)
          if (abort.signal.aborted) return
          const merged = new Map(current.columns)
          for (const column of result.columns) merged.set(column.column, column)
          current = { handle, rows: result.rows, complete: result.complete, rowBytes: result.rowBytes, columns: merged, loading: true }
          setProfiles(current)
        }
        setProfiles({ ...current, loading: false })
      } catch (error) {
        if (abort.signal.aborted) return
        setProfiles({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => abort.abort()
  }, [handle, held, settled, columnKey])
  const shown = profiles?.handle === handle ? profiles : undefined
  const rows = shown?.rows ?? snapshot?.rowsAvailable ?? 0
  const name = entry ? `Result ${entry.index + 1}` : ''
  const facts = shown?.rows === undefined ? '' : `${formatCount(shown.rows)} ${plural(shown.rows, 'row')}${shown.complete ? '' : ' so far'}`
  const sizes = rowSizeText(shown?.rowBytes)
  return <aside className="profile-panel" aria-label="Column profile" aria-busy={shown?.loading || undefined}>
    <div className="profile-head">
      <span className="profile-title">Column profile</span>
      <span className="profile-facts">{[name, facts].filter(Boolean).join(' · ')}</span>
      <button type="button" className="icon-button" aria-label="Close Column Profile" title="Close Column Profile"
        onClick={() => void commands.execute('output.toggleColumnProfile', undefined, 'toolbar')}><Icon name="close" /></button>
    </div>
    {sizes && <div className="profile-note">{sizes}</div>}
    {!held ? <div className="profile-note">{snapshot?.state === 'lost' ? 'These results are no longer available.' : 'These results were closed.'}</div>
      : shown?.error ? <div className="profile-note error" role="status">The profile could not be computed: {shown.error}</div> : null}
    <div className="profile-cards">
      {entry && held && columns.map(column => {
        const info = entry.descriptor.columns[column]
        return <ProfileCard key={column} name={info.name || '(No column name)'} type={sqlTypeLabel(info)} profile={shown?.columns.get(column)} rows={rows} />
      })}
    </div>
  </aside>
}

const noSubscribe = () => () => {}
const noSnapshot = () => undefined
