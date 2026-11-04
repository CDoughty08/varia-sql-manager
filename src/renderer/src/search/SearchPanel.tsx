import { useId, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from 'react'
import { folderSpecs, kindSpecs } from '../../../shared/explorer/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { objectSearchLimits, type ObjectIndexStatus, type ObjectSearchHit, type SearchScope } from '../../../shared/explorer/search.ts'
import type { ExplorerTarget } from '../../../shared/explorer/refs.ts'
import { onUnexpectedError } from '../core/errors'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import ExplorerIcon from '../explorer/ExplorerIcon'
import Icon from '../Icon'
import EmptyState from '../kit/EmptyState'
import Segmented from '../kit/Segmented'
import type { IndexEntry, SearchQueryState } from './ObjectSearchService'
import { paneBandDrag, paneBandKey, paneBandLimits } from './pane-band'

const numbers = new Intl.NumberFormat('en-US')
const count = (value: number, noun: string) => `${numbers.format(value)} ${noun}${value === 1 ? '' : 's'}`
const scopes: readonly { readonly value: SearchScope; readonly label: string }[] = [{ value: 'all', label: 'Names and definitions' }, { value: 'names', label: 'Names' }, { value: 'definitions', label: 'Definitions' }]
const dragEnds = ['pointerup', 'pointercancel', 'lostpointercapture'] as const
/** The splitter's pane (Object Explorer's column) and the band's own box. */
const paneBox = (band: HTMLElement) => band.parentElement?.getBoundingClientRect()

/** The same scopes in a narrow pane, where "Names and definitions" would be cut. */
const paneScopes: readonly { readonly value: SearchScope; readonly label: string }[] = [{ value: 'all', label: 'All' }, ...scopes.slice(1)]

/** `text` with [start, length] marked; names keep displayText's markers for hidden characters. */
function Marked({ text, range }: { readonly text: string; readonly range?: readonly [number, number] }): ReactNode {
  if (!range || range[1] <= 0) return displayText(text)
  const [start, length] = range
  return <>{displayText(text.slice(0, start))}<mark>{displayText(text.slice(start, start + length))}</mark>{displayText(text.slice(start + length))}</>
}

/** What the index holds, for the summary line. */
export function indexSummary(entry: IndexEntry | undefined, status: ObjectIndexStatus | undefined): string {
  if (entry?.requestId) return `Indexing ${numbers.format(entry.done)} of ${count(entry.total, 'database')} (${count(entry.objects, 'object')} so far)…`
  if (entry?.error) return `The index could not be built: ${entry.error}`
  if (!status || status.state === 'none') return 'This server has no index yet.'
  const skipped = status.skipped.length ? ` · ${count(status.skipped.length, 'database')} skipped` : ''
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
 * Word and Use Regular Expression, the scope (names, definitions or both), what the index holds, and the hits, which reveal
 * their object in Object Explorer or script it to a new query.
 */
export default function SearchPanel({ searchId, layout, inputRef, onLeave, options }: SearchPanelProps) {
  const { objectSearch, explorer, scripting, commands } = useWorkbench()
  const snapshot = useServiceSnapshot(objectSearch)
  const scopeLabel = useId()
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const state = snapshot.documents[searchId]
  if (!state) return null
  const entry = snapshot.indexes[state.connectionId]
  const result = state.result
  const pane = layout === 'pane'
  const set = (patch: Partial<SearchQueryState>) => objectSearch.setQuery(searchId, patch)
  const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regex', label: string, icon: 'case-sensitive' | 'whole-word' | 'regex') =>
    <button type="button" className="icon-button object-search-toggle" aria-pressed={state[key]} aria-label={label} title={label} onClick={() => set({ [key]: !state[key] })}><Icon name={icon} /></button>
  const rows = () => [...(list.current?.querySelectorAll<HTMLElement>('[data-hit]') ?? [])]
  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    if (event.key === 'Enter' && state.text.trim()) objectSearch.search(searchId)
    else if (event.key === 'ArrowDown' && rows().length) rows()[0]?.focus()
    else if (event.key === 'Escape' && state.text) set({ text: '' })
    else if (onLeave && (event.key === 'Escape' || event.key === 'ArrowDown' || event.key === 'Enter')) onLeave()
    else return
    event.preventDefault()
    event.stopPropagation()
  }
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const all = rows(), at = all.findIndex(row => row === document.activeElement)
    if (at < 0) return
    const next = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : undefined
    if (next === undefined) return
    event.preventDefault()
    if (next < 0) root.current?.querySelector<HTMLElement>('[data-object-search-focus]')?.focus()
    else all[Math.min(next, all.length - 1)]?.focus()
  }
  const target = (hit: ObjectSearchHit): ExplorerTarget => ({ connectionId: state.connectionId, ref: { type: 'object', object: hit.object }, kind: hit.object.kind, label: hit.label })
  // Object Explorer shows at once and follows the seek as it expands and pages its way to the object.
  const reveal = (hit: ObjectSearchHit) => {
    if (!pane) void commands.execute('window.explorer', undefined, 'toolbar')
    void objectSearch.reveal(explorer, state.connectionId, hit).then(outcome => { if (!outcome.ok && !outcome.cancelled) commands.reportError(outcome.message) }, onUnexpectedError)
  }
  const script = (hit: ObjectSearchHit) => {
    const verb = hit.definition && scripting.canRun('alter', target(hit)) ? 'alter' : 'create'
    void scripting.run(verb, 'newQuery', target(hit)).catch(error => commands.reportError(error instanceof Error ? error.message : 'The object could not be scripted.'))
  }
  const asked = !!(result && state.asked?.text)
  const summary = state.requestId ? 'Searching…'
    : state.error ? state.error
    : result?.problem ? result.problem
    : result && asked ? `${count(result.total, 'result')}${result.total > result.hits.length ? `, showing the first ${numbers.format(result.hits.length)}` : ''}${result.partial ? ' (the search stopped early; narrow it to see everything)' : ''} · ${numbers.format(result.elapsedMs)} ms`
    : ''
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
        {toggle('caseSensitive', 'Match Case', 'case-sensitive')}
        {toggle('wholeWord', 'Match Whole Word', 'whole-word')}
        {toggle('regex', 'Use Regular Expression', 'regex')}
      </div>
      {showHits && <>
        <div className="object-search-options">
          <span id={scopeLabel} className="visually-hidden">Search in</span>
          <Segmented id={`${searchId}-scope`} labelledBy={scopeLabel} segments={pane ? paneScopes : scopes} value={state.scope} onChange={value => set({ scope: value as SearchScope })} />
          {options}
        </div>
        <p className="object-search-index">{indexSummary(entry, entry?.status ?? result?.index)}</p>
      </>}
      <p className={`object-search-summary${state.error || result?.problem ? ' error' : ''}`} role="status">{showHits ? summary : ''}</p>
    </div>
    {showHits && (asked && !result!.problem && result!.hits.length === 0 && !state.requestId
      ? <EmptyState icon="search" title="No objects match" detail={entry?.requestId ? 'The index is still being built; results update when it finishes.' : 'Try another spelling, turn off Match Case or Whole Word, or search names and definitions.'} />
      : <ul ref={list} className="object-search-hits" aria-label={pane ? 'Search results' : 'Results'} onKeyDown={onListKey}>
        {result?.hits.map(hit => {
          const spec = kindSpecs[hit.object.kind]
          const path = `${hit.object.database} › ${folderSpecs[hit.folder].label}`
          const key = JSON.stringify([hit.object, hit.folder])
          return <li key={key} className="object-search-hit">
            <button type="button" className="object-search-open" data-hit title={`Reveal in Object Explorer: ${displayText(hit.label)}`} onClick={() => reveal(hit)}>
              <ExplorerIcon name={spec.icon} />
              <span className="object-search-name"><Marked text={hit.label} range={hit.range} /></span>
              <span className="object-search-path">{displayText(path)}</span>
              {hit.definition && <span className="object-search-line">
                <span className="object-search-line-number">{hit.definition.line}:</span>
                {hit.definition.before && '…'}<Marked text={hit.definition.preview} range={hit.definition.range} />{hit.definition.after && '…'}
                {hit.definition.matches > 1 && <span className="object-search-more"> (+{numbers.format(hit.definition.matches - 1)}{hit.definition.matches >= 999 ? '+' : ''} more)</span>}
              </span>}
            </button>
            <button type="button" className="icon-button" tabIndex={-1} aria-label={`Script ${displayText(hit.label)} to a new query`} title="Script to New Query Window" onClick={() => script(hit)}>
              <Icon name="go-to-file" />
            </button>
          </li>
        })}
      </ul>)}
    {pane && showHits && <div className="object-search-splitter" role="separator" aria-orientation="horizontal" aria-label="Resize search results" tabIndex={0}
      title="Drag to resize; double-click to fit the results" aria-valuemin={Math.round(paneBandLimits.minimum * 100)} aria-valuemax={Math.round(paneBandLimits.maximum * 100)}
      aria-valuenow={snapshot.paneSize === undefined ? undefined : Math.round(snapshot.paneSize * 100)} aria-valuetext={snapshot.paneSize === undefined ? 'Fits the results' : undefined} onPointerDown={drag} onKeyDown={splitterKey} onDoubleClick={() => objectSearch.setPaneSize(undefined)} />}
  </div>
}
