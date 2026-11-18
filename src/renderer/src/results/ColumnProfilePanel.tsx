import { memo, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ColumnProfile, ProfileLengths } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { sqlTypeLabel } from '../grid/measure'
import { selectedColumns } from '../grid/selection'
import Icon from '../Icon'
import { ResultError, type OperationProgressListener, type ResultHandle, type ResultSnapshot, type ResultView } from './ResultClient'
import { entryOf, entryTitle, filtersIdentity, type EntryKey, type ResultSetEntry, type TabResults } from './ResultsService'
import { chunked, histogramCaptions, histogramHeights, profileLines, profileList, profileStrip, rowSizeText } from './profile-format'
import { measureCards, playCardMoves, revealCard, type CardPlace } from './profile-motion'
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
 *  figures say what it shows). A selected column's card is tinted and the active cell's column's is shaded (colour only,
 *  cross-faded); a click or Enter selects its column in the grid. */
interface CardProps {
  readonly column: number; readonly name: string; readonly type: string; readonly profile: ColumnProfile | undefined; readonly rows: number
  readonly selected: boolean; readonly current: boolean; readonly tabStop: boolean; readonly cardRef: (element: HTMLElement | null) => void; readonly onPick: (column: number) => void
  /** The id of the panel's hidden hint that a card selects its column (Enter). */
  readonly hint: string
}
// Memoised: a selection move re-renders the panel, and only the cards whose highlight or Tab stop changed redraw.
const ProfileCard = memo(function ProfileCard({ column, name, type, profile, rows, selected, current, tabStop, cardRef, onPick, hint }: CardProps) {
  const histogram = profile?.histogram
  return <section ref={cardRef} className={'profile-card' + (selected ? ' selected' : '') + (current ? ' current' : '')} aria-label={name}
    aria-current={current || undefined} aria-describedby={hint} data-column={column} tabIndex={tabStop ? 0 : -1} onClick={() => onPick(column)}>
    <div className="profile-card-title"><b>{name}</b>{selected && <span className="visually-hidden">Selected</span>}<span>{type}</span></div>
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
})

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
  const { results, commands, settings, profilePeek, gestures } = useWorkbench()
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
    const ticket = results.operations.begin(tabId, { kind: 'profile', target: entryTitle(entry!), entry: entry!.key, cancel: () => { cancelled = true; abort.abort() } })
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
  const name = entry ? entryTitle(entry) : ''
  // A comparison's name is long and is what the panel is about: it stands on its own line under the title ("Column
  // profile", then "Differences: Result 1 → Result 3"), and the facts beside the title keep only the rows.
  const subject = entry?.descriptor.kind === 'diff' ? name : undefined
  const facts = shown?.rows === undefined ? '' : `${formatCount(shown.rows)} ${plural(shown.rows, 'row')}${shown.complete ? '' : ' so far'}`
  const sizes = rowSizeText(shown?.rowBytes)

  // The grid's selection: its columns' cards are highlighted, its active cell's column's card is kept in view, and Selected
  // Columns Only lists just them. A peek (the gesture's modifier held over the panel) shows the other list while held.
  useSyncExternalStore(results.selections.subscribe, results.selections.getSnapshot)
  const selection = entry ? results.selection(tabId, entry.key) : undefined
  const selected = selectedColumns(selection, entry?.descriptor.columns.length ?? 0)
  const active = selection?.active.column
  const selectedOnly = !!useServiceSnapshot(settings).values['queryResults.grid.columnProfileSelectedOnly']
  const peeking = useSyncExternalStore(profilePeek.subscribe, profilePeek.getSnapshot) === tabId
  useServiceSnapshot(gestures)
  const list = profileList(held ? columns : [], selected, selectedOnly, peeking)
  const strip = held ? profileStrip(list, columns.length, peeking) : undefined
  const tabStop = active !== undefined && list.columns.includes(active) ? active : list.columns[0]

  // Motion: the cards' places are read before a change to the list reaches the page (here, while rendering: the page
  // still shows the last list), and played from there once it has (playCardMoves). Another result's cards never move.
  const scroller = useRef<HTMLDivElement>(null), ghosts = useRef<HTMLDivElement>(null)
  const cardEls = useRef(new Map<number, HTMLElement>()), left = useRef(new Map<number, HTMLElement>())
  const refs = useRef(new Map<number, (element: HTMLElement | null) => void>())
  const cardRef = (column: number) => {
    let ref = refs.current.get(column)
    if (!ref) refs.current.set(column, ref = element => {
      const old = cardEls.current.get(column)
      if (element) cardEls.current.set(column, element)
      else if (old) { left.current.set(column, old); cardEls.current.delete(column) }
    })
    return ref
  }
  const motionKey = `${list.only ? 1 : 0}|${strip ? 1 : 0}|${list.columns.join(',')}`
  const last = useRef({ key: motionKey, entry: entry?.key })
  const before = useRef<Map<number, CardPlace> | undefined>(undefined)
  // Whether a card had the focus before the change: one that leaves the list hands it to the cards' Tab stop, not the page.
  const focused = useRef(false)
  if (last.current.key !== motionKey || last.current.entry !== entry?.key) {
    before.current = last.current.entry === entry?.key && scroller.current ? measureCards(cardEls.current) : undefined
    focused.current = !!scroller.current?.contains(scroller.current.ownerDocument.activeElement)
    last.current = { key: motionKey, entry: entry?.key }
  }
  useLayoutEffect(() => {
    const places = before.current
    before.current = undefined
    if (places && scroller.current && ghosts.current) playCardMoves({ before: places, cards: cardEls.current, left: left.current, scroller: scroller.current, ghosts: ghosts.current })
    left.current.clear()
    if (focused.current && scroller.current && !scroller.current.contains(scroller.current.ownerDocument.activeElement)) cardEls.current.get(tabStop ?? -1)?.focus({ preventScroll: true })
    focused.current = false
  }, [motionKey, entry?.key])
  // The active cell's column's card scrolls into view as the selection moves (as little as it takes).
  useLayoutEffect(() => {
    const card = active === undefined ? undefined : cardEls.current.get(active)
    if (card && scroller.current) revealCard(card, scroller.current)
  }, [active, entry?.key, motionKey])
  // Said once when the list narrows or widens, not at every selection move (the grid reads out the selection itself).
  const [said, setSaid] = useState('')
  const count = useRef(list.columns.length)
  count.current = list.columns.length
  const saidOnly = useRef(list.only)
  useEffect(() => {
    if (saidOnly.current === list.only) return
    saidOnly.current = list.only
    setSaid(list.only ? `Showing ${formatCount(count.current)} of ${formatCount(columns.length)} columns` : 'Showing all columns')
  }, [list.only, columns.length])

  // A panel that goes away under the pointer (its Close button) gets no pointerleave: the peek forgets it here.
  useEffect(() => () => profilePeek.leave(tabId), [profilePeek, tabId])
  // Stable for the memoised cards: it reads the entry the panel shows when called.
  const picking = useRef<(column: number) => void>(() => {})
  picking.current = column => { if (entry) results.selectColumn(tabId, entry.key, column) }
  const [pick] = useState(() => (column: number) => picking.current(column))
  // The cards are one Tab stop (the active column's card); arrows, Home and End move between them, Enter or Space selects one.
  const cardKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('.profile-card[data-column]')
    if (!card || event.altKey || event.ctrlKey || event.metaKey) return
    const order = list.columns.map(column => cardEls.current.get(column)).filter((element): element is HTMLElement => !!element)
    const at = order.indexOf(card)
    const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : undefined
    if (to !== undefined) {
      event.preventDefault()
      order[Math.max(0, Math.min(order.length - 1, to))]?.focus()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pick(Number(card.dataset.column))
    }
  }
  const hint = useId()
  const peekWords = gestures.phrase('output.profilePeekHover')
  const toggleTitle = peekWords === 'off' ? 'Selected Columns Only' : `Selected Columns Only (${peekWords} the panel to peek)`
  return <aside className="profile-panel" aria-label="Column profile" {...subject ? { 'aria-description': subject } : {}} aria-busy={shown?.loading || undefined}
    onPointerMove={event => profilePeek.pointer(tabId, gestures.matches('output.profilePeekHover', event))} onPointerLeave={() => profilePeek.pointer(undefined)}>
    <div className={'profile-head' + (subject ? ' with-subject' : '')}>
      <span className="profile-title">Column profile</span>
      <span className="profile-facts">{[subject ? '' : name, facts].filter(Boolean).join(' · ')}</span>
      <button type="button" className="icon-button" aria-label="Selected Columns Only" title={toggleTitle} aria-pressed={selectedOnly}
        onClick={() => void commands.execute('output.toggleProfileSelectedColumns', undefined, 'toolbar')}><Icon name="filter" /></button>
      <button type="button" className="icon-button" aria-label="Close Column Profile" title="Close Column Profile"
        onClick={() => void commands.execute('output.toggleColumnProfile', undefined, 'toolbar')}><Icon name="close" /></button>
    </div>
    {subject && <div className="profile-subject" title={subject}>{subject}</div>}
    {strip && <div className={'profile-strip' + (peeking ? ' peek' : '')}>
      {peeking && <Icon name="eye" />}<span>{strip}</span>
      {!peeking && <button type="button" className="profile-strip-action" onClick={() => void commands.execute('output.toggleProfileSelectedColumns', undefined, 'toolbar')}>Show all</button>}
    </div>}
    {sizes && <div className="profile-note">{sizes}</div>}
    {!held ? <div className="profile-note">{snapshot?.state === 'lost' ? 'These results are no longer available.' : 'These results were closed.'}</div>
      : shown?.error ? <div className="profile-note error" role="status">The profile could not be computed: {shown.error}</div>
      : list.only && list.columns.length === 0 ? <div className="profile-note">Select cells or columns in the grid to see their profiles here.</div> : null}
    <div className="profile-cards" ref={scroller} onKeyDown={cardKeys}>
      <div className="profile-ghosts" ref={ghosts} aria-hidden="true" />
      {entry && held && list.columns.map(column => {
        const info = entry.descriptor.columns[column]
        const profiled = shown?.columns.get(column)
        return <ProfileCard key={column} column={column} name={info.name || '(No column name)'} type={sqlTypeLabel(info)} profile={profiled?.profile} rows={profiled?.rows ?? 0}
          selected={selected.has(column)} current={column === active} tabStop={column === tabStop} cardRef={cardRef(column)} onPick={pick} hint={hint} />
      })}
    </div>
    <div className="visually-hidden" role="status">{said}</div>
    <span id={hint} hidden>Enter selects this column in the grid.</span>
  </aside>
}

const noSubscribe = () => () => {}
const noSnapshot = () => undefined
