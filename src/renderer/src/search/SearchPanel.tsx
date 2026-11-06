import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from 'react'
import { folderSpecs, kindSpecs, type FolderId } from '../../../shared/explorer/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { childrenLeftOut, objectSearchLimits, type ObjectIndexStatus, type ObjectSearchHit } from '../../../shared/explorer/search.ts'
import { onUnexpectedError } from '../core/errors'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import ExplorerIcon from '../explorer/ExplorerIcon'
import Icon from '../Icon'
import EmptyState from '../kit/EmptyState'
import { useMenuTarget } from '../menus/useMenuTarget'
import { hitKey, type IndexEntry, type SearchQueryState } from './ObjectSearchService'
import { revealHit, searchHitTarget } from './hit-actions'
import SearchFilters from './SearchFilters'
import PaneSearchFilters from './PaneSearchFilters'
import SearchPopover from './SearchPopover'
import { paneBandDrag, paneBandKey, paneBandLimits } from './pane-band'

const numbers = new Intl.NumberFormat('en-US')
/** The hit Page Down (`direction` 1) or Page Up (-1) selects from `at`, as lists do: the last (first) hit fully in view, or when
 *  `at` is already there, the furthest whose rows from `at` fit in the list's height, at least one away. Rows differ in height
 *  (a definition hit has a second line), so it adds up the rows it passes. */
function pageFrom(rows: readonly HTMLElement[], at: number, direction: 1 | -1): number {
  const list = rows[at]?.closest('ul')
  if (!list) return at
  const top = list.getBoundingClientRect().top + list.clientTop, height = list.clientHeight, bottom = top + height
  let edge = at
  for (let index = at + direction; index >= 0 && index < rows.length; index += direction) {
    const box = rows[index]!.parentElement!.getBoundingClientRect()
    if (direction > 0 ? box.bottom > bottom + 0.5 : box.top < top - 0.5) break
    edge = index
  }
  if (edge !== at) return edge
  let to = at, used = rows[at]?.parentElement?.offsetHeight ?? 0
  while (to + direction >= 0 && to + direction < rows.length) {
    used += rows[to + direction]!.parentElement?.offsetHeight ?? 0
    if (used > height && to !== at) break
    to += direction
  }
  return to
}
const count = (value: number, noun: string) => `${numbers.format(value)} ${noun}${value === 1 ? '' : 's'}`
const dragEnds = ['pointerup', 'pointercancel', 'lostpointercapture'] as const
/** The splitter's pane (Object Explorer's column) and the band's own box. */
const paneBox = (band: HTMLElement) => band.parentElement?.getBoundingClientRect()

/** `text` with [start, length] marked; names keep displayText's markers for hidden characters. */
function Marked({ text, range }: { readonly text: string; readonly range?: readonly [number, number] }): ReactNode {
  if (!range || range[1] <= 0) return displayText(text)
  const [start, length] = range
  return <>{displayText(text.slice(0, start))}<mark>{displayText(text.slice(start, start + length))}</mark>{displayText(text.slice(start + length))}</>
}

/**
 * Where a hit is, for its row: a server object's folders below the server (Security › Logins), a database's Databases folder,
 * and anything else its database and folder (Sales › Columns; the label names a child's parent).
 */
export function searchHitPath(hit: ObjectSearchHit): string {
  if (hit.object.database === undefined) {
    const labels: string[] = []
    for (let at: FolderId | undefined = hit.folder; at; at = folderSpecs[at].parent) labels.unshift(folderSpecs[at].label)
    return labels.join(' › ')
  }
  return `${hit.object.database} › ${folderSpecs[hit.folder].label}`
}

/** What the index holds, for the summary line. */
export function indexSummary(entry: IndexEntry | undefined, status: ObjectIndexStatus | undefined): string {
  if (entry?.requestId) return `Indexing ${numbers.format(entry.done)} of ${count(entry.total, 'database')} (${count(entry.objects, 'object')} so far)…`
  if (entry?.error) return `The index could not be built: ${entry.error}`
  if (!status || status.state === 'none') return 'This server has no index yet.'
  // The server's own objects are reported under an empty database name; a database kept without its children is still indexed.
  const partial = status.skipped.filter(skip => skip.code === childrenLeftOut).length
  const databases = status.skipped.filter(skip => skip.database && skip.code !== childrenLeftOut).length
  const server = status.skipped.some(skip => !skip.database)
  const skipped = (databases ? ` · ${count(databases, 'database')} skipped` : '') + (server ? ' · server objects skipped' : '')
    + (partial ? ` · columns and other children left out of ${count(partial, 'large database')}` : '')
  const modules = status.definitions ? `, ${count(status.modules, 'definition')}` : ' (names only)'
  return `Index: ${count(status.objects, 'object')}${modules} in ${count(status.indexed, 'database')}${skipped}`
}

export interface SearchPanelProps {
  /** The search's id in ObjectSearchService: a tab's document id, or `explorerSearchId`. */
  readonly searchId: string
  /** `tab`: the Search Objects tab, its hits filling the rest of it. `pane`: Object Explorer's box, its hits in a band above the
   *  tree, shown only while there is text. */
  readonly layout: 'tab' | 'pane'
  readonly inputRef?: Ref<HTMLInputElement>
  /** Escape in an empty box, or ↓ with no hits (the pane returns to its tree). */
  readonly onLeave?: () => void
  /** Controls after the scope (the tab's server picker). */
  readonly options?: ReactNode
}

/**
 * One object index search, as the Search Objects tab and Object Explorer's box both show it: the text with Match Case, Whole
 * Word and Use Regular Expression, the filters (names, definitions or both, and the object types), what the index holds, and the hits, which reveal
 * their object in Object Explorer, and whose context menu (search.hit.context) selects, scripts and copies it.
 */
export default function SearchPanel({ searchId, layout, inputRef, onLeave, options }: SearchPanelProps) {
  const workbench = useWorkbench()
  const { objectSearch, explorer, commands } = workbench
  const snapshot = useServiceSnapshot(objectSearch)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const state = snapshot.documents[searchId]
  // The selected hit (the one Enter or the arrows reached) stays in view in the list.
  const current = state?.current
  // Whether keyboard focus is on a hit (the list's focus and blur events keep it): a new answer that drops the focused hit hands
  // focus to the list's tab stop, or to the box when no hits are left, rather than leaving it on the page, where keys reach nothing.
  const focusInList = useRef(false)
  // A hit's menu is for the hit it opens on, which it selects first, as Object Explorer's does; its Object Explorer commands read
  // the hit's own selection keys, not the tree's.
  const menuTarget = useMenuTarget<HTMLElement>(element => {
    const document = objectSearch.getSnapshot().documents[searchId], index = Number(element.getAttribute('data-index')), hit = document?.result?.hits[index]
    if (!document || !hit) return null
    objectSearch.pick(searchId, index)
    return searchHitTarget(explorer, document.connectionId, searchId, index, hit, layout === 'pane')
  })
  const focusInput = () => root.current?.querySelector<HTMLElement>('[data-object-search-focus]')?.focus()
  // The selected hit's identity: the list scrolls to the selection only when another hit is selected, so a search run again that
  // keeps the selection (at whatever index) leaves the list where the user scrolled it, focused or not.
  const selectedHit = current === undefined ? undefined : state?.result?.hits[current]
  const selectedKey = selectedHit && hitKey(selectedHit)
  const shownKey = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const hits = list.current, rows = hits?.querySelectorAll<HTMLElement>('[data-hit]')
    const focused = !!hits && hits.contains(hits.ownerDocument.activeElement)
    if (current !== undefined && selectedKey !== shownKey.current) rows?.[current]?.scrollIntoView({ block: 'nearest' })
    shownKey.current = selectedKey
    if (!focusInList.current || focused) return
    const row = rows?.[current ?? 0]
    if (row) row.focus()
    else { focusInList.current = false; focusInput() }
  }, [current, selectedKey, state?.result])
  if (!state) return null
  const entry = snapshot.indexes[state.connectionId]
  const result = state.result
  const pane = layout === 'pane'
  const set = (patch: Partial<SearchQueryState>) => objectSearch.setQuery(searchId, patch)
  const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regex', label: string, icon: 'case-sensitive' | 'whole-word' | 'regex') =>
    <button type="button" className="icon-button object-search-toggle" aria-pressed={state[key]} aria-label={label} title={label} onClick={() => set({ [key]: !state[key] })}><Icon name={icon} /></button>
  const rows = () => [...(list.current?.querySelectorAll<HTMLElement>('[data-hit]') ?? [])]
  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && !(pane && event.key === 'Enter'))) return
    // In Object Explorer's box Enter reveals the next hit (Shift+Enter the one before) in the tree below and keeps focus here,
    // so Enter again goes on to the next one. The tab's Enter searches at once; its hits reveal with Enter or a double-click.
    if (event.key === 'Enter' && state.text.trim() && pane) void objectSearch.step(searchId, event.shiftKey ? -1 : 1).then(hit => { if (hit) reveal(hit) }, onUnexpectedError)
    else if (event.key === 'Enter' && state.text.trim()) void objectSearch.search(searchId)
    else if (event.key === 'ArrowDown' && rows().length) (rows()[current ?? 0] ?? rows()[0])?.focus()
    else if (event.key === 'Escape' && state.text) set({ text: '' })
    else if (onLeave && (event.key === 'Escape' || event.key === 'ArrowDown' || event.key === 'Enter')) onLeave()
    else return
    event.preventDefault()
    event.stopPropagation()
  }
  /** The list is one tab stop on the selected hit; the arrows, Page keys, Home and End move the selection and focus with it,
   *  Enter reveals the selected hit (focus stays here), ↑ on the first hit and Escape return to the box. Ctrl+C (⌘C) copies its
   *  name: the key is the clipboard's, so the catalogue's rule only labels it (`native`) and the list runs it. */
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const all = rows(), at = all.findIndex(row => row === event.target)
    if (at < 0) return
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      void commands.execute('search.copyName', undefined, 'keybinding')
      return
    }
    // Shift+Enter reveals too, as in the box (where it goes back a hit).
    if (event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key !== 'Enter')) return
    const next = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'PageDown' ? pageFrom(all, at, 1)
      : event.key === 'PageUp' ? pageFrom(all, at, -1) : event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : undefined
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') focusInput()
      else open(at)
      return
    }
    if (next === undefined) return
    event.preventDefault()
    if (next < 0) { focusInput(); return }
    const index = Math.min(next, all.length - 1)
    objectSearch.pick(searchId, index)
    all[index]?.focus()
  }
  const reveal = (hit: ObjectSearchHit) => revealHit(workbench, state.connectionId, hit, pane)
  /** Selects a hit and reveals it. */
  const open = (index: number) => {
    const hit = result?.hits[index]
    if (!hit) return
    objectSearch.pick(searchId, index)
    reveal(hit)
  }
  const asked = !!(result && state.asked?.text)
  const summary = state.requestId ? 'Searching…'
    : state.error ? state.error
    : result?.problem ? result.problem
    : result && asked ? `${count(result.total, 'result')}${result.total > result.hits.length ? `, showing the first ${numbers.format(result.hits.length)}` : ''}${result.partial ? ' (the search stopped early; narrow it to see everything)' : ''} · ${numbers.format(result.elapsedMs)} ms`
    : ''
  const index = entry?.status ?? result?.index
  const indexText = indexSummary(entry, index)
  // Progress and incomplete indexes stay visible; the healthy index's detail is available from the information button.
  const indexNotice = !!entry?.requestId || !!entry?.error || !index || index.state !== 'ready' || !!index.skipped.length || !index.definitions
  const paneSummary = result && asked && !state.requestId && !state.error && !result.problem && !result.partial
    ? `${count(result.total, 'result')} · ${count(result.index.indexed, 'database')}` : summary
  const showHits = !pane || !!state.text.trim()
  // Object Explorer's band: a splitter under the hits sizes it; until it moves the band sizes by its content.
  const sized = pane && showHits && snapshot.paneSize !== undefined
  const share = () => {
    const band = root.current, box = band && paneBox(band)
    return band && box && box.height > 0 ? band.getBoundingClientRect().height / box.height : paneBandLimits.minimum
  }
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const band = root.current
    if (event.button !== 0 || !band) return
    event.preventDefault()
    const target = event.currentTarget, pointer = event.pointerId
    target.setPointerCapture(pointer)
    const move = (moved: PointerEvent) => {
      const box = paneBox(band)
      if (moved.pointerId === pointer && box) objectSearch.setPaneSize(paneBandDrag(moved.clientY, band.getBoundingClientRect().top, box.top, box.bottom))
    }
    const end = (ended: PointerEvent) => {
      if (ended.pointerId !== pointer) return
      target.removeEventListener('pointermove', move)
      for (const type of dragEnds) target.removeEventListener(type, end)
    }
    target.addEventListener('pointermove', move)
    for (const type of dragEnds) target.addEventListener(type, end)
  }
  const splitterKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    const next = paneBandKey(snapshot.paneSize ?? share(), event.key)
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    objectSearch.setPaneSize(next)
  }
  return <div ref={root} className={`object-search object-search-${layout}`} data-sized={sized ? '' : undefined} style={sized ? { height: `${snapshot.paneSize! * 100}%` } : undefined}>
    <div className="object-search-query">
      <div className="object-search-field" role="search">
        <Icon name="search" />
        <input ref={inputRef} type="text" data-object-search-focus aria-label={pane ? 'Search in Object Explorer' : 'Search objects'} placeholder={state.regex ? 'Regular expression' : pane ? 'Search objects' : 'Object name or text in definitions'}
          maxLength={objectSearchLimits.text} spellCheck={false} autoComplete="off" value={state.text} onChange={event => set({ text: event.target.value })} onKeyDown={onInputKey} />
        {pane && state.text && <button type="button" className="icon-button" tabIndex={-1} aria-label="Clear search" title="Clear search (Escape)" onClick={() => { set({ text: '' }); root.current?.querySelector<HTMLElement>('[data-object-search-focus]')?.focus() }}><Icon name="close" /></button>}
        {pane ? <SearchPopover label={`Search options${state.caseSensitive || state.wholeWord || state.regex ? ': active' : ''}`} title="Search options" icon="settings-gear" compact active={state.caseSensitive || state.wholeWord || state.regex}>
          {(['caseSensitive', 'wholeWord', 'regex'] as const).map((key, index) => <label key={key} className="object-search-check">
            <input type="checkbox" checked={state[key]} onChange={() => set({ [key]: !state[key] })} /><span>{['Match Case', 'Match Whole Word', 'Use Regular Expression'][index]}</span>
          </label>)}
        </SearchPopover> : <>{toggle('caseSensitive', 'Match Case', 'case-sensitive')}{toggle('wholeWord', 'Match Whole Word', 'whole-word')}{toggle('regex', 'Use Regular Expression', 'regex')}</>}
      </div>
      {showHits && <>
        {pane ? <PaneSearchFilters id={searchId} scope={state.scope} types={state.types} onScope={scope => set({ scope })} onTypes={types => set({ types })} />
          : <SearchFilters id={searchId} scope={state.scope} types={state.types} onScope={scope => set({ scope })} onTypes={types => set({ types })} options={options} />}
        {(!pane || indexNotice) && <p className="object-search-index">{indexText}</p>}
      </>}
      {pane ? <div className="object-search-pane-status">
        <p className={`object-search-summary${state.error || result?.problem ? ' error' : ''}`} role="status">{showHits ? paneSummary : ''}</p>
        {showHits && <SearchPopover label="Search and index details" title="Search details" icon="info" compact>
          <p className="object-search-index">{indexText}</p>{summary && <p className="object-search-index">{summary}</p>}
        </SearchPopover>}
      </div> : <p className={`object-search-summary${state.error || result?.problem ? ' error' : ''}`} role="status">{showHits ? summary : ''}</p>}
    </div>
    {showHits && (asked && !result!.problem && result!.hits.length === 0 && !state.requestId
      ? <EmptyState icon="search" title="No objects match" detail={entry?.requestId ? 'The index is still being built; results update when it finishes.' : `Try another spelling, turn off Match Case or Whole Word, or search names and definitions${state.types.length ? ' of every type' : ''}.`} />
      : <ul ref={list} role="listbox" data-search-hits className="object-search-hits" aria-label={pane ? 'Search results' : 'Results'} onKeyDown={onListKey}
        onFocus={() => { focusInList.current = true; objectSearch.listFocused(searchId, true) }}
        onBlur={event => {
          const next = event.relatedTarget
          if (next && event.currentTarget.contains(next as Node)) return
          // A hit a new answer removes may blur as it goes; focus that leaves with its element is still the list's, for the
          // effect above to hand on.
          const left = event.target
          queueMicrotask(() => { if (left.isConnected) { focusInList.current = false; objectSearch.listFocused(searchId, false) } })
        }}>
        {result?.hits.map((hit, index) => {
          const spec = kindSpecs[hit.object.kind]
          const path = searchHitPath(hit)
          const key = hitKey(hit)
          // A click selects; in the tab only a double-click (or Enter) reveals, so a click never takes focus away from the list.
          // Each hit is an option, the tab stop on the selected one, which a screen reader announces as selected.
          return <li key={key} role="presentation" className="object-search-hit">
            <div ref={menuTarget} role="option" className="object-search-open" data-hit data-index={index} tabIndex={index === (current ?? 0) ? 0 : -1} aria-selected={index === current}
              title={`Reveal in Object Explorer: ${displayText(hit.label)}`} onClick={() => { if (pane) open(index); else objectSearch.pick(searchId, index) }} onDoubleClick={pane ? undefined : () => open(index)}>
              <ExplorerIcon name={(hit.subtype && spec.subtypeIcons?.[hit.subtype]) || spec.icon} />
              <span className="object-search-name"><Marked text={hit.label} range={hit.range} /></span>
              <span className="object-search-path">{displayText(path)}</span>
              {hit.definition && <span className="object-search-line">
                <span className="object-search-line-number">{hit.definition.line}:</span>
                {hit.definition.before && '…'}<Marked text={hit.definition.preview} range={hit.definition.range} />{hit.definition.after && '…'}
                {hit.definition.matches > 1 && <span className="object-search-more"> (+{numbers.format(hit.definition.matches - 1)}{hit.definition.matches >= 999 ? '+' : ''} more)</span>}
              </span>}
            </div>
          </li>
        })}
      </ul>)}
    {pane && showHits && <div className="object-search-splitter" role="separator" aria-orientation="horizontal" aria-label="Resize search results" tabIndex={0}
      title="Drag to resize; double-click to fit the results" aria-valuemin={Math.round(paneBandLimits.minimum * 100)} aria-valuemax={Math.round(paneBandLimits.maximum * 100)}
      aria-valuenow={snapshot.paneSize === undefined ? undefined : Math.round(snapshot.paneSize * 100)} aria-valuetext={snapshot.paneSize === undefined ? 'Fits the results' : undefined} onPointerDown={drag} onKeyDown={splitterKey} onDoubleClick={() => objectSearch.setPaneSize(undefined)} />}
  </div>
}
