import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { kindSpecs, type KindSpec } from '../../../shared/explorer/catalog.ts'
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
import { peekMessages } from '../explorer/PeekService'
import Icon from '../Icon'
import Segmented from '../kit/Segmented'
import { argsFor } from '../menus/targets'
import { searchHitTarget } from './hit-actions'
import { columnsOf, type DefinitionPart, type SearchDetails as Details } from './SearchDetailsService'

/** Lines of a definition that are coloured; longer text shows the rest plain, so a huge module never stalls the pane. */
const colouredLines = 3000

/** A run of definition text in one SQL scope's colour. */
interface Run { readonly text: string; readonly style?: SyntaxStyle }

/**
 * Monaco's SQL tokens for the first `colouredLines` lines, merged into runs; the rest of the text is one plain run. SQL's
 * tokenizer loads lazily (start.tsx registers it), and tokenize answers plain text until it has: colorize waits for it,
 * and the runs are made again once it is there.
 */
function useRuns(text: string | undefined): readonly Run[] {
  const { monaco, theme } = useWorkbench()
  const { active } = useServiceSnapshot(theme)
  const [sqlLoaded, setSqlLoaded] = useState(false)
  useEffect(() => {
    let live = true
    monaco.editor.colorize('', 'sql', {}).then(() => { if (live) setSqlLoaded(true) }, onUnexpectedError)
    return () => { live = false }
  }, [monaco])
  return useMemo(() => {
    if (text === undefined) return []
    try {
      const lines = text.split('\n')
      const head = lines.slice(0, colouredLines), tokens = monaco.editor.tokenize(head.join('\n'), 'sql')
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
          const scope = token.type.replace(/\.sql$/, '')
          push(line.slice(token.offset, end), isSqlScope(scope) ? active.syntax[scope] : undefined)
        })
        if (!lineTokens.length) push(line)
        if (index < lines.length - 1) push('\n')
      })
      if (lines.length > colouredLines) push(lines.slice(colouredLines).join('\n'))
      return runs
    } catch (error) {
      onUnexpectedError(error)
      return [{ text }]
    }
  }, [text, monaco, active, sqlLoaded])
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
  if (exact && match.line >= 1 && match.line <= lines.length && (!wanted || lines[match.line - 1]!.includes(wanted))) return match.line
  if (!wanted) return undefined
  let best: number | undefined
  lines.forEach((line, index) => {
    if (line.includes(wanted) && (best === undefined || Math.abs(index + 1 - match.line) < Math.abs(best - match.line))) best = index + 1
  })
  return best
}

/**
 * What the definition last scrolled for: a read (`id`) and its matched line. A new answer's hit for the same object keeps the
 * read but may match another line, which is scrolled to in turn.
 */
export const scrollKey = (id: number, line: number | undefined): string => `${id}:${line ?? ''}`

/** A hit's kind as this build's catalogue has it; a kind it does not know (a newer backend's) shows as a plain object. */
export function hitKindSpec(kind: string): Pick<KindSpec, 'title' | 'icon' | 'subtypeIcons'> {
  return Object.hasOwn(kindSpecs, kind) ? kindSpecs[kind as keyof typeof kindSpecs] : unknownKindSpec
}
const unknownKindSpec: Pick<KindSpec, 'title' | 'icon'> = { title: 'Object', icon: 'file' }

/** The hit's own properties, known before anything is read: its type, and where it is. */
export function hitProperties(hit: ObjectSearchHit): readonly { readonly label: string; readonly value: string }[] {
  const { object } = hit
  return [
    { label: 'Type', value: hitKindSpec(object.kind).title },
    ...object.database === undefined ? [] : [{ label: 'Database', value: object.database }],
    ...object.parent ? [{ label: 'Schema', value: object.parent.schema ?? '' }, { label: hitKindSpec(object.parent.kind).title, value: object.parent.name }]
      : object.schema === undefined ? [] : [{ label: 'Schema', value: object.schema }]
  ].filter(row => row.value !== '')
}

function Definition({ details, part }: { readonly details: Details; readonly part: DefinitionPart }) {
  const text = part.status === 'ready' ? part.value.text : undefined
  const runs = useRuns(text)
  const pre = useRef<HTMLPreElement>(null)
  const line = text === undefined ? undefined : matchedLine(text, details.hit, !!details.kind && peekSpecs[details.kind].definition === 'module')
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
  if (part.status === 'loading') return <p className="peek-note">Loading the definition…</p>
  if (part.status === 'error') return <p className="peek-note error" role="alert">{part.message}</p>
  if (text === undefined) return <p className="peek-note">{peekMessages.noDefinition}</p>
  return <>
    <pre ref={pre} className="peek-definition search-details-definition" tabIndex={0} aria-label="Definition">
      {line !== undefined && <span className="search-details-match" aria-hidden="true" style={{ top: `calc(${line - 1} * var(--varia-line-sm) + var(--varia-space-1))` }} />}
      {runs.map((run, index) => run.style
        ? <span key={index} style={{ color: run.style.foreground, fontStyle: run.style.fontStyle.includes('italic') ? 'italic' : undefined, fontWeight: run.style.fontStyle.includes('bold') ? 'bold' : undefined }}>{run.text}</span>
        : run.text)}</pre>
  </>
}

function Columns({ details }: { readonly details: Details }) {
  const columns = details.columns
  if (!columns || columns.status === 'loading') return <p className="peek-note">Loading the columns…</p>
  if (columns.status === 'error') return <p className="peek-note error" role="alert">{columns.message}</p>
  if (!columns.value.length) return <p className="peek-note">No columns.</p>
  return <ul className="search-details-columns" aria-label="Columns">
    {columns.value.map((column, index) => <li key={index}><bdi className="search-details-column">{displayText(column.name)}</bdi>{column.detail && <span className="search-details-column-type">{displayText(column.detail)}</span>}</li>)}
  </ul>
}

export function Properties({ details }: { readonly details: Details }) {
  const facts = details.facts, spec = details.kind && peekSpecs[details.kind], subtype = details.hit.subtype
  // The card's groups: those of the hit's subtype, and none the login was refused (said below instead).
  const groups = spec ? spec.groups.filter(group => (!group.subtypes || (subtype !== undefined && group.subtypes.includes(subtype))) && !(group.refused && details.refused?.includes(group.id))) : []
  const refused = spec ? spec.groups.filter(group => group.refused && details.refused?.includes(group.id)) : []
  const shown = facts?.status === 'ready' ? groups.flatMap(group => group.facts).filter(fact => fact.id !== 'schema' && Object.hasOwn(facts.value, fact.id)) : []
  return <div className="search-details-properties">
    <dl className="search-details-facts" aria-label="Properties">
      {hitProperties(details.hit).map(row => <div key={row.label} className="search-details-fact"><dt>{row.label}</dt><dd title={displayText(row.value)}>{displayText(row.value)}</dd></div>)}
      {facts?.status === 'ready' && shown.map(fact => {
        const value = formatPeekValue(fact, facts.value[fact.id]!)
        return <div key={fact.id} className="search-details-fact"><dt>{fact.label}</dt><dd title={value}>{value}</dd></div>
      })}
    </dl>
    {facts?.status === 'ready' && refused.map(group => <p key={group.id} className="peek-note">{group.refused}</p>)}
    {facts?.status === 'loading' && <p className="peek-note">Loading properties…</p>}
    {facts?.status === 'error' && <p className="peek-note error" role="alert">{facts.message}</p>}
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
      <ExplorerIcon name={(hit.subtype && spec.subtypeIcons?.[hit.subtype]) || spec.icon} />
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
    <div className="peek-scroll search-details-scroll">{columns ? <Columns details={details} /> : <Definition details={details} part={details.definition} />}</div>
  </section>
}
