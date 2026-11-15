import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ColumnProfile, ProfileLengths } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { sqlTypeLabel } from '../grid/measure'
import Icon from '../Icon'
import { ResultError, type OperationProgressListener, type ResultHandle, type ResultSnapshot, type ResultView } from './ResultClient'
import { entryOf, filtersIdentity, resultTitle, type EntryKey, type ResultSetEntry, type TabResults } from './ResultsService'
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
  /** The handle the grid showed when the request failed: a view of the same rows shown after that asks again. */
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
 * set finishes loading (a sort of a set still loading builds its view over more rows), not for a sort of a loaded set (a
 * column, direction or Sort Text By change builds a new view of the same rows) unless the last profile failed. A newer
 * request cancels the older. It holds only aggregates, never rows.
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
/** A view's filters never change: their identity (which sorts each filter's rows) is worked out once, not every render. */
const identities = new WeakMap<ResultView, string>()
const viewFilters = (view: ResultView): string => {
  let identity = identities.get(view)
  if (identity === undefined) identities.set(view, identity = filtersIdentity(view.filters))
  return identity
}
export const profiledRows = (snapshot: ResultSnapshot | undefined, view: ResultView | undefined): ProfiledRows => ({
  filters: view ? viewFilters(view) : '',
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
  const reading = useRef({ base, handle, view, key: entry?.key, filters, settled })
  reading.current = { base, handle, view, key: entry?.key, filters, settled }
  // A profile that failed is asked again when the grid shows another view of the same rows (a sort after closing other
  // results, say), as a new view always did before sorts kept the profile. Other rows start a request anyway.
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const last = latest.current
    if (last?.error && last.failed !== handle && last.base === base && last.of.filters === filters && last.of.settled === settled) setRetry(count => count + 1)
  }, [handle])
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
    // The toolbar's strip and the grid's bar show it; their Cancel (or Escape in the grid) stops it, keeping the cards it has.
    let cancelled = false, outcome: 'done' | 'dropped' = 'dropped'
    const ticket = results.operations.begin(tabId, { kind: 'profile', target: resultTitle(entry!), entry: entry!.key, cancel: () => { cancelled = true; abort.abort() } })
    const parts = wanted.length ? chunked(wanted, wire.profile.maxColumns) : [[]]
    void (async () => {
      try {
        for (const [at, part] of parts.entries()) {
          // Each request reports its own 0 – 100: the strip shows the share of every chunk.
          const onProgress: OperationProgressListener = (phase, percent) => ticket.progress(phase, percent === undefined ? undefined : Math.floor((at * 100 + percent) / parts.length))
          let result
          try { result = await reader.profile(part, abort.signal, onProgress) }
          catch (error) {
            // The backend may still drop a held view (its views per result are bounded): the rest is read through the
            // grid's newer view of the same rows, as a pivot build does. Any other failure is reported, never sent again.
            const now = reading.current
            if (abort.signal.aborted || !(error instanceof ResultError) || error.code !== 'VIEW_NOT_FOUND' || !now.handle || now.handle === reader
              || now.key === undefined || now.base !== base || now.filters !== filters || now.settled !== settled) throw error
            done()
            reader = now.handle
            release = now.view ? results.holdView(tabId, now.key, now.view) : undefined
            result = await reader.profile(part, abort.signal, onProgress)
          }
          if (abort.signal.aborted) return
          const merged = new Map(current.columns)
          for (const column of result.columns) merged.set(column.column, { profile: column, rows: result.rows })
          current = { base, of, rows: result.rows, complete: result.complete, rowBytes: result.rowBytes, columns: merged, loading: true }
          setProfiles(current)
        }
        setProfiles({ ...current, loading: false })
        outcome = 'done'
      } catch (error) {
        if (abort.signal.aborted) { if (cancelled) setProfiles({ ...current, loading: false }); return }
        setProfiles({ ...current, loading: false, error: error instanceof Error ? error.message : String(error), failed: reading.current.handle })
      } finally { done(); ticket.end(cancelled ? 'cancelled' : outcome) }
    })()
    return () => { abort.abort(); done() }
  }, [results, tabId, base, held, filters, settled, columnKey, retry])
  const shown = profiles && profiles.base === base && profiles.of.filters === filters ? profiles : undefined
  const name = entry ? resultTitle(entry) : ''
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
