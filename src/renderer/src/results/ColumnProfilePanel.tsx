import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ColumnProfile, ProfileLengths } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { sqlTypeLabel } from '../grid/measure'
import Icon from '../Icon'
import type { ResultHandle } from './ResultClient'
import { entryOf, type EntryKey, type TabResults } from './ResultsService'
import { chunked, histogramCaptions, histogramHeights, profileLines, rowSizeText } from './profile-format'
import { formatCount, plural } from './status'

interface Profiled { readonly profile: ColumnProfile; readonly rows: number }

interface Profiles {
  readonly handle: ResultHandle
  readonly rows?: number
  readonly complete?: boolean
  readonly rowBytes?: ProfileLengths
  /** Each column's figures with the rows they were computed over: requests of 32 columns each see the rows sealed when
   *  they ran, so a set still loading gives each chunk its own count. */
  readonly columns: ReadonlyMap<number, Profiled>
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
export default function ColumnProfilePanel({ tabId, tab, shown: shownEntry }: { tabId: string; tab: TabResults; shown?: EntryKey }) {
  const { results, commands } = useWorkbench()
  useServiceSnapshot(results)
  // The grid the pane last saw take the focus, else the one the stack says had it (the first, before any did).
  const entry = entryOf(tab.sets, shownEntry) ?? entryOf(tab.sets, results.focusedEntry(tabId)?.key)
  const handle = entry ? results.sortOf(tabId, entry.key)?.view ?? entry.handle : undefined
  const snapshot = useSyncExternalStore(handle?.subscribe ?? noSubscribe, handle?.getSnapshot ?? noSnapshot)
  const [profiles, setProfiles] = useState<Profiles | undefined>(undefined)
  // The latest profiles, read when a new request starts: asking again for the same rows keeps the cards shown until each
  // chunk's new figures arrive, rather than going back to "Profiling…".
  const latest = useRef(profiles)
  latest.current = profiles
  const columns = entry ? entry.descriptor.columns.flatMap((column, at) => column.role === 'tone' ? [] : [at]) : []
  const columnKey = columns.join(',')
  const held = snapshot && snapshot.state !== 'released' && snapshot.state !== 'lost'
  // A set still loading is profiled once and again when it completes; a complete one when its rows (a view's) change.
  const settled = !snapshot ? '' : snapshot.state === 'complete' ? 'complete:' + snapshot.rowsAvailable : snapshot.state
  useEffect(() => {
    if (!handle || !held) return
    const abort = new AbortController()
    const previous = latest.current?.handle === handle ? latest.current : undefined
    let current: Profiles = previous ? { ...previous, loading: true, error: undefined } : { handle, columns: new Map(), loading: true }
    setProfiles(current)
    const wanted = columnKey ? columnKey.split(',').map(Number) : []
    void (async () => {
      try {
        for (const part of wanted.length ? chunked(wanted, wire.profile.maxColumns) : [[]]) {
          const result = await handle.profile(part, abort.signal)
          if (abort.signal.aborted) return
          const merged = new Map(current.columns)
          for (const column of result.columns) merged.set(column.column, { profile: column, rows: result.rows })
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
  const name = entry ? `Result ${entry.number}` : ''
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
        const profiled = shown?.columns.get(column)
        return <ProfileCard key={column} name={info.name || '(No column name)'} type={sqlTypeLabel(info)} profile={profiled?.profile} rows={profiled?.rows ?? 0} />
      })}
    </div>
  </aside>
}

const noSubscribe = () => () => {}
const noSnapshot = () => undefined
