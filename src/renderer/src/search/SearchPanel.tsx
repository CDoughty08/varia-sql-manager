import { useId, useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { folderSpecs, kindSpecs, type FolderId } from '../../../shared/explorer/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { childrenLeftOut, objectSearchLimits, type ObjectIndexStatus, type ObjectSearchHit, type SearchScope } from '../../../shared/explorer/search.ts'
import type { ExplorerTarget } from '../../../shared/explorer/refs.ts'
import { onUnexpectedError } from '../core/errors'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import ExplorerIcon from '../explorer/ExplorerIcon'
import Icon from '../Icon'
import EmptyState from '../kit/EmptyState'
import Segmented from '../kit/Segmented'
import type { IndexEntry, SearchQueryState } from './ObjectSearchService'

const numbers = new Intl.NumberFormat('en-US')
const count = (value: number, noun: string) => `${numbers.format(value)} ${noun}${value === 1 ? '' : 's'}`
const scopes: readonly { readonly value: SearchScope; readonly label: string }[] = [{ value: 'all', label: 'Names and definitions' }, { value: 'names', label: 'Names' }, { value: 'definitions', label: 'Definitions' }]
/** The same scopes in a narrow pane, where "Names and definitions" would be cut. */
const paneScopes: readonly { readonly value: SearchScope; readonly label: string }[] = [{ value: 'all', label: 'All' }, ...scopes.slice(1)]

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
  const target = (hit: ObjectSearchHit): ExplorerTarget => ({ connectionId: state.connectionId, ref: { type: 'object', object: hit.object }, kind: hit.object.kind, label: hit.label, ...hit.subtype ? { subtype: hit.subtype } : {} })
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
  return <div ref={root} className={`object-search object-search-${layout}`}>
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
          const path = searchHitPath(hit)
          const key = JSON.stringify([hit.object, hit.folder])
          return <li key={key} className="object-search-hit">
            <button type="button" className="object-search-open" data-hit title={`Reveal in Object Explorer: ${displayText(hit.label)}`} onClick={() => reveal(hit)}>
              <ExplorerIcon name={(hit.subtype && spec.subtypeIcons?.[hit.subtype]) || spec.icon} />
              <span className="object-search-name"><Marked text={hit.label} range={hit.range} /></span>
              <span className="object-search-path">{displayText(path)}</span>
              {hit.definition && <span className="object-search-line">
                <span className="object-search-line-number">{hit.definition.line}:</span>
                {hit.definition.before && '…'}<Marked text={hit.definition.preview} range={hit.definition.range} />{hit.definition.after && '…'}
                {hit.definition.matches > 1 && <span className="object-search-more"> (+{numbers.format(hit.definition.matches - 1)}{hit.definition.matches >= 999 ? '+' : ''} more)</span>}
              </span>}
            </button>
            {spec.scriptable && <button type="button" className="icon-button" tabIndex={-1} aria-label={`Script ${displayText(hit.label)} to a new query`} title="Script to New Query Window" onClick={() => script(hit)}>
              <Icon name="go-to-file" />
            </button>}
          </li>
        })}
      </ul>)}
  </div>
}
