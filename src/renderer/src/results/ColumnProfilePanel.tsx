import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ColumnProfile, ProfileLengths } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { sqlTypeLabel } from '../grid/measure'
import Icon from '../Icon'
import type { ResultHandle, ResultSnapshot, ResultView } from './ResultClient'
import { entryOf, filtersIdentity, type EntryKey, type ResultSetEntry, type TabResults } from './ResultsService'
import { chunked, histogramCaptions, histogramHeights, profileLines, rowSizeText } from './profile-format'
import { formatCount, plural } from './status'

interface Profiled { readonly profile: ColumnProfile; readonly rows: number }

interface Profiles {
  /** The result the figures are of (its own handle, never a view's) and the rows they describe there (`profiledRows`). */
  readonly base: ResultHandle
  readonly of: ProfiledRows
  readonly rows?: number
  readonly complete?: boolean
  readonly rowBytes?: ProfileLengths
  /** Each column's figures with the rows they were computed over: requests of 32 columns each see the rows sealed when
   *  they ran, so a set still loading gives each chunk its own count. */
  readonly columns: ReadonlyMap<number, Profiled>
  readonly loading: boolean
  readonly error?: string
  /** The handle the failed request read through: another view of the same rows asks again. */
  readonly failed?: ResultHandle
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
 * last had focus, computed in the backend over the rows its grid shows (results.profile through its view), 32 columns a
 * request. Its figures belong to those rows, not their order: it asks again when the grid's filters keep other rows or the
 * set finishes loading, never for a sort alone (a column, direction or Sort Text By change builds a new view of the same
 * rows). A newer request cancels the older. It holds only aggregates, never rows.
 */
/** The grid a profile follows: its entry, and for a query's own result its number in the run. */
export interface ProfileTarget { readonly entry: EntryKey; readonly ordinal?: number }
/** The target for the grid that took the focus. */
export const profileTarget = (sets: readonly ResultSetEntry[], entry: EntryKey): ProfileTarget => {
  const ordinal = entryOf(sets, entry)?.ordinal
  return ordinal === undefined ? { entry } : { entry, ordinal }
}
/** The entry of a run a target names: the entry itself, else the run's result of that number, so a query run again is
 *  profiled on the same result once it arrives (as its highlights follow it). A derived entry is found only by itself. */
export const profiledEntry = (sets: readonly ResultSetEntry[], target: ProfileTarget | undefined): ResultSetEntry | undefined =>
  target === undefined ? undefined : entryOf(sets, target.entry) ?? (target.ordinal === undefined ? undefined : sets.find(set => set.ordinal === target.ordinal))

/** Which of a result's rows a profile describes, whatever their order: the filters of the view the grid shows (none for
 *  the result's own rows), and `settled`, the rows those filters were applied to. A loading set is profiled once and again
 *  when it completes; a complete one, or a view, by the rows it was built from. A view without filters over every row has
 *  the result's own rows, so going from SQL Server's order to a sort (or back) keeps the profile too. Every profile figure
 *  is order-free (results.profile reads rows in base order through a bitmap of the view's), and neither a filter nor a
 *  profile compares text by the sort's mode, so Sort Text By changes neither. */
export interface ProfiledRows { readonly filters: string; readonly settled: string }
export const profiledRows = (snapshot: ResultSnapshot | undefined, view: ResultView | undefined): ProfiledRows => ({
  filters: view ? filtersIdentity(view.filters) : '',
  settled: !snapshot ? '' : view ? (view.complete ? 'complete:' : 'partial:') + view.baseRows : snapshot.state === 'complete' ? 'complete:' + snapshot.rowsAvailable : snapshot.state
})

export default function ColumnProfilePanel({ tabId, tab, shown: shownEntry }: { tabId: string; tab: TabResults; shown?: EntryKey }) {
  const { results, commands } = useWorkbench()
  useServiceSnapshot(results)
  // The grid the pane last saw take the focus, else the one the stack says had it (the first, before any did).
  const entry = entryOf(tab.sets, shownEntry) ?? entryOf(tab.sets, results.focusedEntry(tabId)?.key)
  const base = entry?.handle
  const view = entry ? results.sortOf(tabId, entry.key)?.view : undefined
  const handle = view ?? base
  const snapshot = useSyncExternalStore(handle?.subscribe ?? noSubscribe, handle?.getSnapshot ?? noSnapshot)
  const [profiles, setProfiles] = useState<Profiles | undefined>(undefined)
  // The latest profiles, read when a new request starts: asking again for the same rows keeps the cards shown until each
  // chunk's new figures arrive, rather than going back to "Profiling…".
  const latest = useRef(profiles)
  latest.current = profiles
  const columns = entry ? entry.descriptor.columns.flatMap((column, at) => column.role === 'tone' ? [] : [at]) : []
  const columnKey = columns.join(',')
  const held = snapshot && snapshot.state !== 'released' && snapshot.state !== 'lost'
  const { filters, settled } = profiledRows(snapshot, view)
  // What a request reads through, read when one starts: a sort alone changes the view but not the rows, so starts none.
  const reading = useRef({ handle, view, key: entry?.key, rows: filters + ' @ ' + settled })
  reading.current = { handle, view, key: entry?.key, rows: filters + ' @ ' + settled }
  // A profile that failed is asked again when the grid shows another view of the same rows (a sort after closing other
  // results, say), as a new view always did before sorts kept the profile.
  const [retry, setRetry] = useState(0)
  useEffect(() => { if (latest.current?.error && latest.current.failed !== handle) setRetry(count => count + 1) }, [handle])
  useEffect(() => {
    const { handle, view, key } = reading.current
    if (!base || !handle || !held || key === undefined) return
    const abort = new AbortController()
    const of: ProfiledRows = { filters, settled }
    // The same filters over more rows (the set completed): the cards stay until their new figures arrive.
    const previous = latest.current?.base === base && latest.current.of.filters === filters ? latest.current : undefined
    let current: Profiles = previous ? { ...previous, of, loading: true, error: undefined, failed: undefined } : { base, of, columns: new Map(), loading: true }
    setProfiles(current)
    // The grid may sort again while this reads its view: the view stays open until the profile is done with it.
    let reader = handle
    let release = view ? results.holdView(tabId, key, view) : undefined
    const done = () => { release?.(); release = undefined }
    const wanted = columnKey ? columnKey.split(',').map(Number) : []
    void (async () => {
      try {
        for (const part of wanted.length ? chunked(wanted, wire.profile.maxColumns) : [[]]) {
          let result
          try { result = await reader.profile(part, abort.signal) }
          catch (error) {
            // The backend may still drop a held view (its views per result are bounded): the grid's newer view has the
            // same rows (else this profile would have been cancelled), so the rest is read through it.
            const now = reading.current
            if (abort.signal.aborted || !now.handle || now.handle === reader || now.key === undefined || now.rows !== filters + ' @ ' + settled) throw error
            done()
            reader = now.handle
            release = now.view ? results.holdView(tabId, now.key, now.view) : undefined
            result = await reader.profile(part, abort.signal)
          }
          if (abort.signal.aborted) return
          const merged = new Map(current.columns)
          for (const column of result.columns) merged.set(column.column, { profile: column, rows: result.rows })
          current = { base, of, rows: result.rows, complete: result.complete, rowBytes: result.rowBytes, columns: merged, loading: true }
          setProfiles(current)
        }
        setProfiles({ ...current, loading: false })
      } catch (error) {
        if (abort.signal.aborted) return
        setProfiles({ ...current, loading: false, error: error instanceof Error ? error.message : String(error), failed: reader })
      } finally { done() }
    })()
    return () => { abort.abort(); done() }
  }, [results, tabId, base, held, filters, settled, columnKey, retry])
  const shown = profiles && profiles.base === base && profiles.of.filters === filters ? profiles : undefined
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
