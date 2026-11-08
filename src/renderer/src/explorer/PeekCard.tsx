import { Component, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { kindSpecs } from '../../../shared/explorer/catalog.ts'
import { peekSpecs, peekTabsOf, peekTabTitle, type PeekDependency, type PeekTab } from '../../../shared/explorer/peek.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { scriptCommandId } from '../../../shared/scripting/catalog.ts'
import { isSqlScope } from '../../../shared/theme/registry'
import type { SyntaxStyle } from '../../../shared/theme/types'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { onUnexpectedError } from '../core/errors'
import ResultsStack from '../grid/ResultsStack'
import Icon from '../Icon'
import { useKeybindingsRevision } from '../core/useCommand'
import ExplorerIcon from './ExplorerIcon'
import { formatPeekValue, placePeek } from './peek-format'
import { peekMessages, type OpenPeek, type PeekDependencies, type PeekMembers, type PeekPart, type PeekRows, type PeekView } from './PeekService'

/** Lines of a definition that are coloured; longer text shows the rest plain, so a huge module never stalls the card. */
const colouredLines = 3000

/** The view the parts below read and act on: the card's (the Peek service) or a promoted tab's. */
const PeekViewContext = createContext<PeekView | undefined>(undefined)
export function usePeekView(): PeekView {
  const view = useContext(PeekViewContext)
  if (!view) throw new Error('A Peek part is drawn outside a Peek view.')
  return view
}

/** A run of definition text in one SQL scope's colour. */
export interface Run { readonly text: string; readonly style?: SyntaxStyle }

/**
 * Monaco's SQL tokens for the first `colouredLines` lines, merged into runs; the rest of the text is one plain run. SQL's
 * tokenizer loads lazily (start.tsx registers it), and tokenize answers plain text until it has: colorize waits for it,
 * and the runs are made again once it is there.
 */
export function useRuns(text: string | undefined): readonly Run[] {
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

function Definition({ part }: { part: PeekPart<{ readonly text?: string; readonly truncated?: boolean }> }) {
  const text = part.status === 'ready' ? part.value.text : undefined
  const runs = useRuns(text)
  if (part.status === 'loading') return <p className="peek-note" role="status">Loading the definition…</p>
  if (part.status === 'error') return <p className="peek-note error" role="alert">{part.message}</p>
  if (text === undefined) return <p className="peek-note">{peekMessages.noDefinition}</p>
  return <>
    <pre className="peek-definition" tabIndex={0} aria-label="Definition text">{runs.map((run, index) => run.style
      ? <span key={index} style={{ color: run.style.foreground, fontStyle: run.style.fontStyle.includes('italic') ? 'italic' : undefined, fontWeight: run.style.fontStyle.includes('bold') ? 'bold' : undefined }}>{run.text}</span>
      : run.text)}</pre>
    {part.value.truncated && <p className="peek-note">The definition is longer than Peek shows. Script it to see all of it.</p>}
  </>
}

function Properties({ peek }: { peek: OpenPeek }) {
  const { facts } = peek
  if (facts.status === 'loading') return <p className="peek-note" role="status">Loading properties…</p>
  if (facts.status === 'error') return <p className="peek-note error" role="alert">{facts.message}</p>
  return <div className="peek-properties">
    {peekSpecs[peek.kind].groups.map(group => {
      const shown = group.facts.filter(fact => Object.hasOwn(facts.value, fact.id))
      return shown.length > 0 && <section key={group.id} aria-label={group.title}>
        <h3 className="peek-group">{group.title}</h3>
        <dl className="peek-facts">{shown.map(fact => <div key={fact.id} className="peek-fact"><dt>{fact.label}</dt><dd title={formatPeekValue(fact, facts.value[fact.id])}>{formatPeekValue(fact, facts.value[fact.id])}</dd></div>)}</dl>
      </section>
    })}
  </div>
}

/** A tab's part that is still loading or failed, in Peek's words, with Retry for a failed read; nothing once it is ready. */
function Pending({ part, loading }: { part: PeekPart<unknown> | undefined; loading: string }) {
  const view = usePeekView()
  if (!part || part.status === 'loading') return <p className="peek-note" role="status">{loading}</p>
  if (part.status === 'error') return <div className="peek-note error" role="alert">{part.message}
    <button type="button" className="peek-action" disabled={!view.connected} onClick={event => {
      // The button goes away as the read starts again: focus moves to the shown tab, so it stays in the view and Esc reaches it.
      event.currentTarget.closest('.peek-view')?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
      const open = view.getSnapshot().open
      if (open) view.selectTab(open.tab)
    }}>Retry</button></div>
  return null
}

/** The Columns or Parameters folder as the tree lists it, with the tree's icons and labels. */
function Members({ part }: { part: PeekPart<PeekMembers> | undefined }) {
  if (part?.status !== 'ready') return <Pending part={part} loading="Loading…" />
  const { nodes, more } = part.value
  if (!nodes.length) return <p className="peek-note">{peekMessages.noMembers}</p>
  return <>
    <ul className="peek-list" aria-label="Members">{nodes.map((node, index) => <li key={index} className="peek-item">
      <ExplorerIcon name={node.icon} /><bdi className="peek-item-name">{node.label}</bdi>{node.sublabel && <span className="peek-item-note">{node.sublabel}</span>}
    </li>)}</ul>
    {more && <p className="peek-note">There are more; Object Explorer lists them all.</p>}
  </>
}

const dependencyName = (dependency: PeekDependency) => displayText([dependency.server, dependency.database, dependency.schema, dependency.name].filter(part => part !== undefined).join('.'))

function DependencyList({ title, items, truncated, follow, canFollow }: { title: string; items: readonly PeekDependency[]; truncated: boolean; follow: (dependency: PeekDependency) => void; canFollow: (dependency: PeekDependency) => boolean }) {
  return <section aria-label={title}>
    <h3 className="peek-group">{title}</h3>
    {items.length === 0 ? <p className="peek-note">{peekMessages.noDependencies}</p> : <ul className="peek-list">{items.map((dependency, index) => {
      const icon = <ExplorerIcon name={dependency.kind ? kindSpecs[dependency.kind].icon : 'references'} />
      const note = dependency.foreignKey ? 'Foreign key' : dependency.kind ? kindSpecs[dependency.kind].title : undefined
      const body = <>{icon}<bdi className="peek-item-name">{dependencyName(dependency)}</bdi>{note && <span className="peek-item-note">{note}</span>}</>
      return <li key={index} className="peek-item">{canFollow(dependency)
        ? <button type="button" className="peek-follow" aria-label={`Peek ${dependencyName(dependency)}`} title={`Peek ${dependencyName(dependency)}`} onClick={() => follow(dependency)}>{body}</button>
        : body}</li>
    })}</ul>}
    {truncated && <p className="peek-note">There are more than Peek lists.</p>}
  </section>
}

function Dependencies({ part }: { part: PeekPart<PeekDependencies> | undefined }) {
  const view = usePeekView()
  if (part?.status !== 'ready') return <Pending part={part} loading="Loading dependencies…" />
  const { uses, usesTruncated, usedBy, usedByTruncated } = part.value
  const follow = (dependency: PeekDependency) => view.follow(dependency), canFollow = (dependency: PeekDependency) => view.canFollow(dependency)
  return <div className="peek-properties">
    <DependencyList title="Uses" items={uses} truncated={usesTruncated} follow={follow} canFollow={canFollow} />
    <DependencyList title="Used by" items={usedBy} truncated={usedByTruncated} follow={follow} canFollow={canFollow} />
  </div>
}

/**
 * The first rows in the results grid, as Select Top N Rows shows them: the view's run is a ResultsService entry under its own
 * key, so the grid's selection, Copy, Save Results As and Open Value work as in a query's results.
 */
export function PeekRowsPart({ part }: { part: PeekPart<PeekRows> | undefined }) {
  const { results } = useWorkbench()
  const all = useServiceSnapshot(results)
  if (part?.status !== 'ready') return <Pending part={part} loading="Reading the top rows…" />
  const tab = all[part.value.key]
  if (!tab?.sets.length) return <p className="peek-note">{peekMessages.rowsUnavailable}</p>
  const read = tab.summary?.resultSets[0]?.rowsRead
  return <div className="peek-rows" data-peek-rows="">
    <ResultsStack tabId={part.value.key} tab={tab} />
    {read === 0 && <p className="peek-note">{peekMessages.noRows}</p>}
  </div>
}

/**
 * The left pane's tabs: Left and Right (Home, End) move focus between them, and Enter or Space shows the focused one. Tabs
 * are chosen, not shown as focus passes them, since Top rows reads the table or view.
 */
function Tabs({ peek, idPrefix }: { peek: OpenPeek; idPrefix: string }) {
  const view = usePeekView()
  const tabs = peekTabsOf(peek.kind)
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = (event.target as HTMLElement).dataset.peekPart as PeekTab | undefined
    const at = tabs.indexOf(focused && tabs.includes(focused) ? focused : peek.tab)
    const next = event.key === 'ArrowRight' ? tabs[(at + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(at - 1 + tabs.length) % tabs.length]
      : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : undefined
    if (!next) return
    event.preventDefault()
    event.currentTarget.querySelector<HTMLElement>(`[data-peek-part="${next}"]`)?.focus()
  }
  return <div className="peek-tabs" role="tablist" aria-label="Peek" onKeyDown={keyDown}>
    {tabs.map(tab => <button key={tab} type="button" role="tab" className="peek-tab" id={`${idPrefix}-tab-${tab}`} data-peek-part={tab} aria-selected={peek.tab === tab} aria-controls={`${idPrefix}-panel`}
      tabIndex={peek.tab === tab ? 0 : -1} onClick={() => view.selectTab(tab)}>{peekTabTitle(peek.kind, tab)}</button>)}
  </div>
}

function PaneTitle({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="peek-pane-title"><span>{title}</span><span className="peek-spacer" />{children}</div>
}

function panel(open: OpenPeek): ReactNode {
  const tab: PeekTab = open.tab
  return tab === 'definition' ? <Definition part={open.definition} /> : tab === 'members' ? <Members part={open.members} />
    : tab === 'dependencies' ? <Dependencies part={open.dependencies} /> : <PeekRowsPart part={open.rows} />
}

/** An Object Explorer node's display name for Peek's header: its schema and name. */
export function peekName(open: OpenPeek): string {
  const object = open.node.ref.type === 'object' ? open.node.ref.object : undefined
  return object ? displayText(object.schema === undefined ? object.name ?? '' : `${object.schema}.${object.name ?? ''}`) : ''
}

/**
 * Peek's body, the card's and a promoted tab's alike: the tabs (Definition, Columns or Parameters, Dependencies, Top rows) on
 * the left, with Copy and Script to New Query over the definition, and the properties on the right. `beforeScript` runs before
 * Script to New Query (the card closes itself first). `idPrefix` keeps each body's tab ids its own.
 */
export function PeekBody({ view, open, idPrefix, beforeScript }: { view: PeekView; open: OpenPeek; idPrefix: string; beforeScript?: () => void }) {
  const { commands } = useWorkbench()
  const node = open.node
  const definition = open.definition.status === 'ready' ? open.definition.value : undefined
  const copyable = definition?.text !== undefined && !definition.truncated
  const script = scriptCommandId('create', 'newQuery')
  const target = { target: { kind: 'explorer' as const, node } }
  return <PeekViewContext.Provider value={view}>
    <div className="peek-body">
      <div className="peek-pane">
        <div className="peek-pane-title">
          <Tabs peek={open} idPrefix={idPrefix} />
          <span className="peek-spacer" />
          {open.tab === 'definition' && <>
            <button type="button" className="peek-action" disabled={!copyable} title={definition?.truncated ? 'The definition is cut; Script to New Query has all of it.' : undefined} onClick={() => { view.copyDefinition().catch(onUnexpectedError) }}>Copy</button>
            <button type="button" className="peek-action" disabled={!commands.isEnabled(script, target)}
              onClick={() => { beforeScript?.(); void commands.execute(script, target, 'toolbar') }}>Script to New Query</button>
          </>}
        </div>
        <div key={`${open.id}:${open.tab}`} className={open.tab === 'rows' ? 'peek-scroll peek-grid' : 'peek-scroll'} id={`${idPrefix}-panel`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${open.tab}`}>{panel(open)}</div>
      </div>
      <div className="peek-pane peek-side">
        <PaneTitle title="Properties" />
        <div className="peek-scroll"><Properties peek={open} /></div>
      </div>
    </div>
  </PeekViewContext.Provider>
}

/**
 * The card's own lifetime and faults: it closes the peek when Object Explorer's pane goes away (so no card or read outlives
 * it), and a rendering fault in the card closes the card instead of taking the tree's error boundary, and with it the
 * tree. The next peek (`peekId`) draws again.
 */
export class PeekBoundary extends Component<{ readonly peekId?: number; readonly close: () => void; readonly children: ReactNode }, { readonly failed: boolean }> {
  state: { readonly failed: boolean } = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(error: unknown): void {
    onUnexpectedError(error)
    this.props.close()
  }
  componentDidUpdate(previous: { readonly peekId?: number }): void {
    if (this.state.failed && previous.peekId !== this.props.peekId) this.setState({ failed: false })
  }
  componentWillUnmount(): void { this.props.close() }
  render(): ReactNode { return this.state.failed ? null : this.props.children }
}

export default function PeekCard() {
  const { peek: service } = useWorkbench()
  const { open } = useServiceSnapshot(service)
  return <PeekBoundary peekId={open?.id} close={() => service.close()}><PeekCardView /></PeekBoundary>
}

/**
 * The Peek card: the object's definition on the left, its properties on the right, floating beside Object Explorer in the
 * window the pane is in (docs/popout-windows.md), so it is drawn into that window's body. Esc, a click outside it or
 * another peek closes it; a peek from the keyboard or the menu focuses it, a hover does not. Open as Tab (Ctrl+Enter, ⌘↩ on
 * macOS) moves it to a document tab.
 */
function PeekCardView() {
  const { peek: service, commands, keybindings } = useWorkbench()
  const { open } = useServiceSnapshot(service)
  // The tooltip names Open as Tab's key, which the Shortcuts page can change.
  useKeybindingsRevision()
  const tabKey = keybindings.lookup('explorer.openPeekTab')
  const anchor = useRef<HTMLSpanElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<ReturnType<typeof placePeek> | undefined>(undefined)
  const doc = anchor.current?.ownerDocument

  // Placed again as the tree scrolls or the window resizes; a row scrolled out of the window keeps the card where it was.
  useLayoutEffect(() => {
    const here = anchor.current
    if (!open || !here) { setPlace(undefined); return }
    const view = here.ownerDocument.defaultView, tree = here.ownerDocument.querySelector<HTMLElement>('[data-explorer-tree]')
    if (!view) return
    let frame = 0
    const measure = () => {
      frame = 0
      const pane = (tree ?? here).getBoundingClientRect(), row = here.ownerDocument.getElementById(`oe-${open.rowId}`)?.getBoundingClientRect()
      setPlace(last => placePeek(row && row.bottom > pane.top && row.top < pane.bottom ? row : undefined, pane, { width: view.innerWidth, height: view.innerHeight }, last))
    }
    const schedule = () => { if (!frame) frame = view.requestAnimationFrame(measure) }
    measure()
    tree?.addEventListener('scroll', schedule, { passive: true })
    view.addEventListener('resize', schedule)
    return () => { if (frame) view.cancelAnimationFrame(frame); tree?.removeEventListener('scroll', schedule); view.removeEventListener('resize', schedule) }
  }, [open?.id, open?.rowId])

  // The keyboard and the menu move focus into the card (once per peek), so Esc and screen readers reach it.
  const focused = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!open || open.source === 'hover' || focused.current === open.id || !place) return
    focused.current = open.id
    card.current?.focus({ preventScroll: true })
  }, [open?.id, open?.source, place])

  // A press outside the card closes it; a press on a row then selects that row as usual.
  useEffect(() => {
    if (!open || !doc) return
    const press = (event: PointerEvent) => { if (!card.current?.contains(event.target as Node)) service.close() }
    doc.addEventListener('pointerdown', press, true)
    return () => doc.removeEventListener('pointerdown', press, true)
  }, [open?.id, doc, service])

  const close = (refocus: boolean) => {
    const tree = card.current?.ownerDocument.querySelector<HTMLElement>('[data-explorer-tree]')
    service.close()
    if (refocus) tree?.focus({ preventScroll: true })
  }
  // Tab stays within the card, so Esc keeps reaching it; Esc or Close returns to the tree.
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key !== 'Tab' || !card.current) return
    const stops = [...card.current.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]')]
    const first = stops[0], last = stops[stops.length - 1], at = card.current.ownerDocument.activeElement
    if (!first || !last) { event.preventDefault(); return }
    if (event.shiftKey && (at === first || at === card.current)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && at === last) { event.preventDefault(); first.focus() }
  }
  const node = open?.node
  const name = open ? peekName(open) : ''
  return <span ref={anchor} className="peek-anchor" hidden>
    {open && node && place && doc && createPortal(
      <div ref={card} className="peek-card peek-view" role="dialog" aria-modal="false" aria-label={`Peek: ${name}`} tabIndex={-1} onKeyDown={keyDown} data-peek-source={open.source} data-peek-card=""
        style={{ left: place.left, top: place.top, width: place.width, height: place.height }}>
        <div className="peek-head">
          {open.back.length > 0 && <button type="button" className="icon-button" aria-label="Back" title="Back" onClick={() => service.goBack()}><Icon name="arrow-left" /></button>}
          <ExplorerIcon name={kindSpecs[open.kind].icon} />
          <bdi className="peek-name" title={name}>{name}</bdi>
          <span className="peek-kind">{kindSpecs[open.kind].title}</span>
          <span className="peek-spacer" />
          <button type="button" className="icon-button" aria-label="Open as Tab" title={tabKey ? `Open as Tab (${tabKey.text})` : 'Open as Tab'}
            onClick={() => { void commands.execute('explorer.openPeekTab', undefined, 'toolbar') }}><Icon name="link-external" /></button>
          <button type="button" className="icon-button" aria-label="Refresh" title="Refresh" onClick={() => service.refresh()}><Icon name="refresh" /></button>
          <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={() => close(true)}><Icon name="close" /></button>
        </div>
        <PeekBody view={service} open={open} idPrefix="peek" beforeScript={() => close(false)} />
      </div>, doc.body)}
  </span>
}
