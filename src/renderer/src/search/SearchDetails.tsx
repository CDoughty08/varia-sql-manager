import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BigQueryProperties } from '../../../shared/bigquery/objects'
import { peekSpecs } from '../../../shared/explorer/peek.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import type { ObjectSearchHit } from '../../../shared/explorer/search.ts'
import { scriptCommandId } from '../../../shared/scripting/catalog.ts'
import { isSqlScope } from '../../../shared/theme/registry'
import type { SyntaxStyle } from '../../../shared/theme/types'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { onUnexpectedError } from '../core/errors'
import ExplorerIcon from '../explorer/ExplorerIcon'
import { formatPeekValue } from '../explorer/peek-format'
import { PeekListGrid } from '../explorer/PeekListGrid'
import { LocalGrid } from '../grid/LocalGrid'
import { peekMessages } from '../explorer/PeekService'
import Icon from '../Icon'
import FactGrid, { type FactItem } from '../kit/FactGrid'
import Segmented from '../kit/Segmented'
import { argsFor } from '../menus/targets'
import { hitIcon, hitKindSpec, searchHitTarget } from './hit-actions'

export { hitKindSpec }
import { columnsOf, shownChars, type DefinitionPart, type SearchDetails as Details } from './SearchDetailsService'

/** Lines of a definition that are coloured; longer text shows the rest plain, so a huge module never stalls the pane. */
const colouredLines = 3000
/** Characters coloured at most, so a module of millions of characters (Peek's definitions are never cut) is not split or tokenized whole. */
const colouredChars = 1_000_000
export { shownChars }

/** The part of `text` the pane shows, never ending inside a surrogate pair. */
export function shownText(text: string): string {
  if (text.length <= shownChars) return text
  const code = text.charCodeAt(shownChars - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? shownChars - 1 : shownChars)
}

/** A run of definition text in one SQL scope's colour. */
export interface Run { readonly text: string; readonly style?: SyntaxStyle }

/**
 * Monaco's SQL tokens for the first `colouredLines` lines (at most `colouredChars`), merged into runs; the rest of the text is one plain run. SQL's
 * tokenizer loads lazily (start.tsx registers it), and tokenize answers plain text until it has: colorize waits for it,
 * and the runs are made again once it is there.
 */
/** Where the coloured head ends: after `colouredLines` lines, or at `colouredChars` (never inside a surrogate pair). */
export function colouredEnd(text: string): number {
  let end = 0
  for (let line = 0; line < colouredLines && end < text.length; line++) {
    const next = text.indexOf('\n', end)
    end = next < 0 ? text.length : next + 1
  }
  if (end <= colouredChars) return end
  const code = text.charCodeAt(colouredChars - 1)
  return code >= 0xd800 && code <= 0xdbff ? colouredChars - 1 : colouredChars
}

/** A token's theme scope: T-SQL's and GoogleSQL's grammars both end their tokens with `.sql` (tokenPostfix). */
export const sqlScopeOf = (type: string): string => type.replace(/\.sql$/, '')

/** `language`: Monaco's language id (Job History's details pane colours GoogleSQL). */
export function useRuns(text: string | undefined, language = 'sql'): readonly Run[] {
  const { monaco, theme } = useWorkbench()
  const { active } = useServiceSnapshot(theme)
  const [sqlLoaded, setSqlLoaded] = useState(false)
  useEffect(() => {
    let live = true
    monaco.editor.colorize('', language, {}).then(() => { if (live) setSqlLoaded(true) }, onUnexpectedError)
    return () => { live = false }
  }, [monaco, language])
  return useMemo(() => {
    if (text === undefined) return []
    try {
      const cut = colouredEnd(text)
      const head = text.slice(0, cut).split('\n'), tokens = monaco.editor.tokenize(head.join('\n'), language)
      const runs: Run[] = []
      const push = (piece: string, style?: SyntaxStyle) => {
        const last = runs[runs.length - 1]
        if (last && last.style === style) runs[runs.length - 1] = { text: last.text + piece, ...(style ? { style } : {}) }
        else runs.push({ text: piece, ...(style ? { style } : {}) })
      }
      head.forEach((line, index) => {
        const lineTokens = tokens[index] ?? []
        lineTokens.forEach((token, at) => {
          const end = lineTokens[at + 1]?.offset ?? line.length
          const scope = sqlScopeOf(token.type)
          push(line.slice(token.offset, end), isSqlScope(scope) ? active.syntax[scope] : undefined)
        })
        if (!lineTokens.length) push(line)
        if (index < head.length - 1) push('\n')
      })
      if (cut < text.length) push(text.slice(cut))
      return runs
    } catch (error) {
      onUnexpectedError(error)
      return [{ text }]
    }
  }, [text, monaco, active, sqlLoaded, language])
}

const views = [{ value: 'definition', label: 'Definition' }, { value: 'columns', label: 'Columns' }] as const

/**
 * The 1-based line of `text` that holds a definition hit's match: the line the index reported when the text is the module's own
 * (`exact`), else (a CREATE script, whose header lines move it) the line holding the match's preview nearest that line.
 * Undefined when the hit matched no definition, or the text no longer holds the preview.
 */
export function matchedLine(text: string, hit: ObjectSearchHit, exact: boolean): number | undefined {
  const match = hit.definition
  if (!match) return undefined
  const lines = text.split('\n')
  const wanted = match.preview.trim()
  // IndexSearch displays each tab as one space in its preview. Keep the original source for rendering.
  const matches = (line: string) => line.includes(wanted) || line.includes('\t') && line.replaceAll('\t', ' ').includes(wanted)
  if (exact && match.line >= 1 && match.line <= lines.length && matches(lines[match.line - 1]!)) return match.line
  if (!wanted) return undefined
  let best: number | undefined
  lines.forEach((line, index) => {
    if (matches(line) && (best === undefined || Math.abs(index + 1 - match.line) < Math.abs(best - match.line))) best = index + 1
  })
  return best
}

/**
 * What the definition last scrolled for: a read (`id`) and its matched line. A new answer's hit for the same object keeps the
 * read but may match another line, which is scrolled to in turn.
 */
export const scrollKey = (id: number, line: number | undefined): string => `${id}:${line ?? ''}`

/** The hit's own properties, known before anything is read: its type, and where it is. */
export function hitProperties(hit: ObjectSearchHit): readonly { readonly label: string; readonly value: string }[] {
  const { object } = hit
  return [
    { label: 'Type', value: hitKindSpec(object.kind).title },
    ...object.project === undefined ? [] : [{ label: 'Project', value: object.project }],
    ...object.dataset === undefined ? [] : [{ label: 'Dataset', value: object.dataset }],
    ...object.database === undefined ? [] : [{ label: 'Database', value: object.database }],
    ...object.parent ? [{ label: 'Schema', value: object.parent.schema ?? '' }, { label: hitKindSpec(object.parent.kind).title, value: object.parent.name }]
      : object.schema === undefined ? [] : [{ label: 'Schema', value: object.schema }]
  ].filter(row => row.value !== '')
}

/** A BigQuery object's facts as the pane lists them: every group's, but its full name and type, which the head and the strip already show. */
export function bigQueryFacts(value: BigQueryProperties): readonly { readonly label: string; readonly value: string }[] {
  return value.groups.flatMap(group => group.facts).filter(fact => fact.label !== 'Full name' && fact.label !== 'Type')
}

/** A BigQuery table's columns and nested fields as the pane's grid shows them: path, type and description. */
export function bigQueryColumnsTable(value: BigQueryProperties) {
  return { columns: [{ name: 'Name' }, { name: 'Type' }, { name: 'Description' }], rows: (value.columns ?? []).map(column => [column.name, column.type, column.description ?? null]) }
}

/** A BigQuery table's CREATE statement, which a billed query reads: offered on a button that goes through the estimate and the cost prompts. */
function BilledCreate({ searchId }: { readonly searchId: string }) {
  const { searchDetails } = useWorkbench()
  return <div className="peek-note">
    <p>BigQuery bills the query that reads a table’s CREATE statement, so the pane reads it only when you ask, after its estimate.</p>
    <button type="button" className="peek-action" disabled={!searchDetails.canReadCreate(searchId)} onClick={() => { void searchDetails.readCreate(searchId).catch(onUnexpectedError) }}>Show CREATE Statement</button>
  </div>
}

function Definition({ details, part }: { readonly details: Details; readonly part: DefinitionPart }) {
  const whole = part.status === 'ready' ? part.value.text : undefined
  // A long module comes only as far as the pane shows, with its whole length.
  const length = part.status === 'ready' ? part.value.length ?? whole?.length : undefined
  const text = useMemo(() => whole === undefined ? undefined : shownText(whole), [whole])
  const runs = useRuns(text)
  const pre = useRef<HTMLPreElement>(null)
  // Found once per text and hit, not on every render (a sash drag renders the pane on each move).
  const module = !!details.kind && peekSpecs[details.kind].definition === 'module'
  const line = useMemo(() => text === undefined ? undefined : matchedLine(text, details.hit, module), [text, details.hit, module])
  // The matched line comes into view once per hit and match (a third of the way down), not again as the user scrolls.
  const scrolled = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const element = pre.current, scroller = element?.parentElement
    if (!element || !scroller || text === undefined) return
    const key = scrollKey(details.id, line)
    if (scrolled.current === key) return
    scrolled.current = key
    if (line === undefined) { scroller.scrollTop = 0; return }
    const height = parseFloat(getComputedStyle(element).lineHeight) || 0
    scroller.scrollTop = Math.max(0, element.offsetTop + (line - 1) * height - scroller.clientHeight / 3)
  }, [details.id, text, line])
  if (part.status === 'none') return <p className="peek-note">{hitKindSpec(details.hit.object.kind).title} has no definition to show.</p>
  if (part.status === 'billed') return null
  if (part.status === 'loading') return <p className="peek-note">Loading the definition…</p>
  if (part.status === 'error') return <p className="peek-note error" role="alert">{part.message}</p>
  if (text === undefined) return <p className="peek-note">{peekMessages.noDefinition}</p>
  return <>
    <pre ref={pre} className="peek-definition search-details-definition" tabIndex={0} aria-label="Definition">
      {line !== undefined && <span className="search-details-match" aria-hidden="true" style={{ top: `calc(${line - 1} * var(--varia-line-sm) + var(--varia-space-1))` }} />}
      {runs.map((run, index) => run.style
        ? <span key={index} style={{ color: run.style.foreground, fontStyle: run.style.fontStyle.includes('italic') ? 'italic' : undefined, fontWeight: run.style.fontStyle.includes('bold') ? 'bold' : undefined }}>{run.text}</span>
        : run.text)}</pre>
    {length !== undefined && length > text.length && <p className="peek-note">The definition is longer than this pane shows ({length.toLocaleString('en-US')} characters). Peek or Script to New Query shows all of it.</p>}
    {details.bigQuery?.status === 'ready' && details.bigQuery.value.definitionCut && <p className="peek-note">The definition is longer than this pane shows. Script to New Query shows all of it.</p>}
  </>
}

/** A table's or view's columns: Peek's Columns list, which came with its properties, in a card grid as Peek shows it. Properties above already announces a failed read, so its words here are not a second alert. */
export function Columns({ details }: { readonly details: Details }) {
  if (details.hit.object.project !== undefined) return <BigQueryColumns details={details} />
  const facts = details.facts, list = details.lists?.columns
  if (!facts || facts.status === 'loading') return <p className="peek-note">Loading the columns…</p>
  if (facts.status === 'error') return <p className="peek-note error">{facts.message}</p>
  return <div className="search-details-columns">
    <PeekListGrid id="columns" list={list} preset="card" objectName={displayText(details.hit.label)} />
    {list?.truncated && <p className="peek-note">There are more columns than the pane lists.</p>}
  </div>
}

/** A BigQuery table's columns and nested fields with their descriptions, from the free facts. */
function BigQueryColumns({ details }: { readonly details: Details }) {
  const part = details.bigQuery
  const table = useMemo(() => part?.status === 'ready' ? bigQueryColumnsTable(part.value) : undefined, [part])
  if (!part || part.status === 'loading') return <p className="peek-note">Loading the columns…</p>
  if (part.status === 'error') return <p className="peek-note error">{part.message}</p>
  const name = displayText(details.hit.label)
  return <div className="search-details-columns">
    <LocalGrid table={table!} label="Columns" preset="card" empty="This object has no columns." suggestedName={`${name} Columns`} />
    {part.value.columnsCut && <p className="peek-note">There are more columns than the pane lists.</p>}
  </div>
}

export function Properties({ details }: { readonly details: Details }) {
  const facts = details.facts, spec = details.kind && peekSpecs[details.kind], subtype = details.hit.subtype
  // The card's groups: those of the hit's subtype, and none the login was refused (said below instead).
  const groups = spec ? spec.groups.filter(group => (!group.subtypes || (subtype !== undefined && group.subtypes.includes(subtype))) && !(group.refused && details.refused?.includes(group.id))) : []
  const refused = spec ? spec.groups.filter(group => group.refused && details.refused?.includes(group.id)) : []
  const shown = facts?.status === 'ready' ? groups.flatMap(group => group.facts).filter(fact => fact.id !== 'schema' && Object.hasOwn(facts.value, fact.id)) : []
  const bigQuery = details.bigQuery
  const items: FactItem[] = [
    ...hitProperties(details.hit).map(row => ({
      id: `hit-${row.label}`,
      label: row.label,
      value: displayText(row.value),
      ...(row.label !== 'Type' ? { mono: true } : {})
    })),
    ...(facts?.status === 'ready' ? shown.map(fact => {
      const raw = facts.value[fact.id]!
      return {
        id: `peek-${fact.id}`,
        label: fact.label,
        value: raw === null ? '' : formatPeekValue(fact, raw)
      }
    }) : []),
    ...(bigQuery?.status === 'ready' ? bigQueryFacts(bigQuery.value).map((fact, index) => ({
      id: `bq-${index}-${fact.label}`,
      label: fact.label,
      value: fact.value === '—' ? '' : fact.value
    })) : [])
  ]
  return <div className="search-details-properties">
    <FactGrid key={details.key} compact ariaLabel="Properties" facts={items} />
    {facts?.status === 'ready' && refused.map(group => <p key={group.id} className="peek-note">{group.refused}</p>)}
    {(facts?.status === 'loading' || bigQuery?.status === 'loading') && <p className="peek-note">Loading properties…</p>}
    {facts?.status === 'error' && <p className="peek-note error" role="alert">{facts.message}</p>}
    {bigQuery?.status === 'error' && <p className="peek-note error" role="alert">{bigQuery.message}</p>}
  </div>
}

/**
 * A Search Objects tab's details pane: the selected hit's name, its properties (a strip above, Peek's facts for tables, views,
 * procedures and functions), and its definition with the matched line marked and in view, or a table's or view's columns.
 */
export default function SearchDetails({ searchId }: { readonly searchId: string }) {
  const { searchDetails, explorer, commands } = useWorkbench()
  const snapshot = useServiceSnapshot(searchDetails)
  const details = snapshot.documents[searchId]
  if (!details) return <section className="search-details" aria-label="Details"><p className="peek-note search-details-empty">Select a result to see its definition and properties.</p></section>
  const { hit } = details
  const spec = hitKindSpec(hit.object.kind)
  const name = displayText(hit.label)
  const columns = columnsOf(hit.object) && snapshot.view === 'columns'
  const script = scriptCommandId('create', 'newQuery')
  const args = argsFor(searchHitTarget(explorer, details.connectionId, searchId, -1, hit, false))
  return <section className="search-details" aria-label={`Details: ${name}`}>
    <div className="peek-head search-details-head">
      <ExplorerIcon name={hitIcon(hit)} />
      <bdi className="peek-name" title={name}>{name}</bdi>
      <span className="peek-kind">{spec.title}</span>
      <span className="peek-spacer" />
      <button type="button" className="peek-action" disabled={!commands.isEnabled(script, args)} onClick={() => { void commands.execute(script, args, 'toolbar') }}>Script to New Query</button>
      <button type="button" className="icon-button" aria-label="Refresh details" title="Refresh" onClick={() => searchDetails.refresh(searchId)}><Icon name="refresh" /></button>
      <button type="button" className="icon-button" aria-label="Hide details" title="Hide details" onClick={() => searchDetails.setHidden(true)}><Icon name="close" /></button>
    </div>
    <Properties details={details} />
    {columnsOf(hit.object) && <div className="search-details-views">
      <span id={`${searchId}-details-view`} hidden>Show</span>
      <Segmented id={`${searchId}-details-views`} labelledBy={`${searchId}-details-view`} segments={views} value={snapshot.view} onChange={value => searchDetails.setView(value as 'definition' | 'columns')} />
    </div>}
    <div className="peek-scroll search-details-scroll">{columns ? <Columns details={details} /> : details.definition.status === 'billed' ? <BilledCreate searchId={searchId} /> : <Definition details={details} part={details.definition} />}</div>
  </section>
}
