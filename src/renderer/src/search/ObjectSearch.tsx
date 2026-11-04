import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { folderSpecs, kindSpecs } from '../../../shared/explorer/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { objectSearchLimits, type ObjectIndexStatus, type ObjectSearchHit, type SearchScope } from '../../../shared/explorer/search.ts'
import type { ExplorerTarget } from '../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import ExplorerIcon from '../explorer/ExplorerIcon'
import Icon from '../Icon'
import DocumentFrame from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import Segmented from '../kit/Segmented'
import type { IndexEntry, SearchQueryState } from './ObjectSearchService'

const numbers = new Intl.NumberFormat('en-US')
const count = (value: number, noun: string) => `${numbers.format(value)} ${noun}${value === 1 ? '' : 's'}`
const scopes: readonly { readonly value: SearchScope; readonly label: string }[] = [{ value: 'all', label: 'Names and definitions' }, { value: 'names', label: 'Names' }, { value: 'definitions', label: 'Definitions' }]

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

/** Search Objects: a server's object index searched by name and inside module definitions, with Match Case, Whole Word and Regex. */
export default function ObjectSearch({ documentId }: { readonly documentId: string }) {
  const workbench = useWorkbench()
  const { objectSearch, connections, explorer, scripting, commands } = workbench
  const snapshot = useServiceSnapshot(objectSearch)
  const connectionList = useServiceSnapshot(connections)
  const scopeLabel = useId()
  const list = useRef<HTMLUListElement>(null)
  const state = snapshot.documents[documentId]
  if (!state) return null
  const entry = snapshot.indexes[state.connectionId]
  const connection = connectionList.find(item => item.id === state.connectionId)
  const server = connection?.displayName || connection?.server || 'Disconnected'
  const live = connectionList.filter(item => !item.lost)
  const result = state.result
  const set = (patch: Partial<SearchQueryState>) => objectSearch.setQuery(documentId, patch)
  const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regex', label: string, icon: 'case-sensitive' | 'whole-word' | 'regex') =>
    <button type="button" className="icon-button object-search-toggle" aria-pressed={state[key]} aria-label={label} title={label} onClick={() => set({ [key]: !state[key] })}><Icon name={icon} /></button>
  const rows = () => [...(list.current?.querySelectorAll<HTMLElement>('[data-hit]') ?? [])]
  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'Enter') objectSearch.search(documentId)
    else if (event.key === 'ArrowDown') rows()[0]?.focus()
    else if (event.key === 'Escape' && state.text) set({ text: '' })
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
    if (next < 0) document.querySelector<HTMLElement>(`[data-object-search="${CSS.escape(documentId)}"] [data-object-search-focus]`)?.focus()
    else all[Math.min(next, all.length - 1)]?.focus()
  }
  const target = (hit: ObjectSearchHit): ExplorerTarget => ({ connectionId: state.connectionId, ref: { type: 'object', object: hit.object }, kind: hit.object.kind, label: hit.label })
  const reveal = (hit: ObjectSearchHit) => {
    if (objectSearch.reveal(explorer, state.connectionId, hit)) void commands.execute('window.explorer', undefined, 'toolbar')
    else commands.reportError('Object Explorer has not loaded this server yet. Connect it in Object Explorer, then try again.')
  }
  const script = (hit: ObjectSearchHit) => {
    const verb = hit.definition && scripting.canRun('alter', target(hit)) ? 'alter' : 'create'
    void scripting.run(verb, 'newQuery', target(hit)).catch(error => commands.reportError(error instanceof Error ? error.message : 'The object could not be scripted.'))
  }
  const summary = state.requestId ? 'Searching…'
    : state.error ? state.error
    : result?.problem ? result.problem
    : result && state.asked?.text ? `${count(result.total, 'result')}${result.total > result.hits.length ? `, showing the first ${numbers.format(result.hits.length)}` : ''}${result.partial ? ' (the search stopped early; narrow it to see everything)' : ''} · ${numbers.format(result.elapsedMs)} ms`
    : ''
  return <DocumentFrame id={`object-search-${documentId}`} title="Search Objects" crumbs={[{ label: server, ...connection ? { title: `${connection.server} · ${connection.serverVersion}` } : {} }]}
    verbs={[{ command: 'explorer.rebuildIndex' }]} attributes={{ 'data-object-search': documentId }}>
    <div className="object-search">
      <div className="object-search-query">
        <div className="object-search-field" role="search">
          <Icon name="search" />
          <input type="text" data-object-search-focus aria-label="Search objects" placeholder={state.regex ? 'Regular expression' : 'Object name or text in definitions'} maxLength={objectSearchLimits.text}
            spellCheck={false} autoComplete="off" value={state.text} onChange={event => set({ text: event.target.value })} onKeyDown={onInputKey} />
          {toggle('caseSensitive', 'Match Case', 'case-sensitive')}
          {toggle('wholeWord', 'Match Whole Word', 'whole-word')}
          {toggle('regex', 'Use Regular Expression', 'regex')}
        </div>
        <div className="object-search-options">
          <span id={scopeLabel} className="visually-hidden">Search in</span>
          <Segmented id={`${documentId}-scope`} labelledBy={scopeLabel} segments={scopes} value={state.scope} onChange={value => set({ scope: value as SearchScope })} />
          {live.length > 1 && <label className="object-search-server">Server <select value={state.connectionId} onChange={event => objectSearch.setConnection(documentId, event.target.value)}>
            {live.map(item => <option key={item.id} value={item.id}>{item.displayName || item.server}</option>)}
          </select></label>}
        </div>
        <p className="object-search-index">{indexSummary(entry, entry?.status ?? result?.index)}</p>
        <p className={`object-search-summary${state.error || result?.problem ? ' error' : ''}`} role="status">{summary}</p>
      </div>
      {result && state.asked?.text && !result.problem && result.hits.length === 0 && !state.requestId
        ? <EmptyState icon="search" title="No objects match" detail={entry?.requestId ? 'The index is still being built; results update when it finishes.' : 'Try another spelling, turn off Match Case or Whole Word, or search names and definitions.'} />
        : <ul ref={list} className="object-search-hits" aria-label="Results" onKeyDown={onListKey}>
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
        </ul>}
    </div>
  </DocumentFrame>
}
