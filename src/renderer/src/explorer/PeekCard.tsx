import {
  Component, createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode, type Ref
} from 'react'
import { createPortal } from 'react-dom'
import { kindSpecs } from '../../../shared/explorer/catalog.ts'
import { isPeekListTab, peekTabsOf, peekTabTitle, type PeekDependency, type PeekList, type PeekListId, type PeekTab } from '../../../shared/explorer/peek.ts'
import { displayText, insertTextFor, type ObjectRef } from '../../../shared/explorer/refs.ts'
import { scriptCommandId } from '../../../shared/scripting/catalog.ts'
import { onUnexpectedError } from '../core/errors'
import type { CommandArgs } from '../core/types'
import { useKeybindingsRevision } from '../core/useCommand'
import { useServiceSelector, useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { createQueryEditor } from '../editor/create-editor'
import type { LocalGridPreset } from '../grid/LocalGrid'
import ResultsStack from '../grid/ResultsStack'
import Icon from '../Icon'
import CapabilityChips from '../kit/CapabilityChips'
import type { Crumb, HeaderVerb, Verb } from '../kit/DocumentFrame'
import FactGrid from '../kit/FactGrid'
import ObjectInspectorFrame, { ObjectInspectorFrameView, type InspectorTab } from '../kit/ObjectInspectorFrame'
import type { InspectorSurface } from '../kit/object-inspector'
import RatioBar from '../kit/RatioBar'
import StatusPill from '../kit/StatusPill'
import { selectedFacts as selectedPaneFacts } from '../menus/selected-facts'
import type { PeekPropertiesTarget } from '../menus/targets'
import { useMenuTarget } from '../menus/useMenuTarget'
import { settingsDocumentOptions } from '../services/documents'
import ExplorerIcon from './ExplorerIcon'
import { selectionContextOf } from './ExplorerService'
import { inPeekEditorWidgets, PeekEditor, peekEditorUse } from './peek-editor'
import { formatPeekValue, peekObjectName, peekPropertiesText, placePeek, placePeekAt } from './peek-format'
import {
  peekHeroKpis, peekOverviewModel, peekStatePills, peekStorageModel, peekTabCount,
  peekUsageModel, peekVitalsModel, visiblePeekGroups
} from './peek-inspector'
import { PeekListGrid } from './PeekListGrid'
import { copyableDefinition, peekMessages, tooLongToCopy, type OpenPeek, type PeekAnchor, type PeekDefinition, type PeekDependencies, type PeekPart, type PeekRows, type PeekView } from './PeekService'

/** The view the parts below read and act on: the card's (the Peek service) or a promoted tab's. */
const PeekViewContext = createContext<PeekView | undefined>(undefined)
export function usePeekView(): PeekView {
  const view = useContext(PeekViewContext)
  if (!view) throw new Error('A Peek part is drawn outside a Peek view.')
  return view
}

/**
 * The definition in Peek's editor: the query editor (`createQueryEditor`), read-only, so Tools › Options, Find and the SQL
 * language features reach it as they reach a query. The view's editor moves into this slot while Definition shows.
 */
function Definition({ part, editor, open }: { part: PeekPart<PeekDefinition>; editor: PeekEditor | undefined; open: OpenPeek }) {
  const slot = useRef<HTMLDivElement>(null)
  const text = part.status === 'ready' ? part.value.text : undefined
  const object = open.node.ref.type === 'object' ? open.node.ref.object : undefined
  useLayoutEffect(() => {
    const here = slot.current
    if (!here || !editor || text === undefined) return
    try { editor.show(here, { key: String(open.id), text, connectionId: open.node.connectionId, ...object?.database === undefined ? {} : { database: object.database } }) } catch (error) { onUnexpectedError(error) }
    return () => editor.hide(here)
  }, [editor, text, open.id, open.node.connectionId, object?.database])
  if (part.status === 'loading') return <p className="peek-note" role="status">{definitionLoading(part.progress)}</p>
  if (part.status === 'error') return <p className="peek-note error" role="alert">{part.message}</p>
  if (text === undefined) return <p className="peek-note">{peekMessages.noDefinition}</p>
  return <div ref={slot} className="peek-editor" />
}

/** The Definition tab's loading line; a long text's pages say how much has come. */
export const definitionLoading = (progress?: number): string =>
  progress === undefined ? 'Loading the definition…' : `Loading the definition… ${Math.floor(progress * 100)}%`

/**
 * The card's tab stops in order: its buttons and tabbable elements, without those Monaco keeps in the DOM but hides (a closed
 * Find widget slides out of view, aria-hidden, yet stays focusable), so the loop never hands focus to them or out of the card.
 */
export function cardStops(card: Element): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]')].filter(shown)
}

const shown = (element: HTMLElement): boolean => !element.closest('[aria-hidden="true"]') && element.checkVisibility?.({ visibilityProperty: true }) !== false

/**
 * Whether Tab (Shift+Tab when `back`) from `at` leaves Monaco's Find widget: `at` is its last shown control (its first, going
 * back). Monaco moves Tab itself only from Close to Replace, which a read-only editor never shows, so past the edge the
 * browser would take focus out of the card.
 */
export function leavesFind(widget: Element, at: Element, back: boolean): boolean {
  const own = [...widget.querySelectorAll<HTMLElement>('textarea, [tabindex="0"]')].filter(shown)
  return !own.length || (back ? own[0] : own[own.length - 1]) === at
}

/**
 * Where Tab (Shift+Tab when `back`) moves from `at` within the card's `stops`: the next stop in document order, wrapping at
 * either end, so focus stays in the card. Focus on the definition's text (not itself a stop) moves to the stop after or before
 * it. 'native' leaves the key to the browser inside Monaco's Find widget, whose inputs and buttons Tab walks by themselves, until
 * `leaving` it from its edge (`leavesFind`).
 */
export function nextStop(stops: readonly HTMLElement[], at: Element | null, back: boolean, onCard: boolean, leaving = false): HTMLElement | undefined | 'native' {
  if (!stops.length) return undefined
  if (onCard || !at) return back ? stops[stops.length - 1] : stops[0]
  if (at.closest('.find-widget') && !leaving) return 'native'
  const index = stops.indexOf(at as HTMLElement)
  if (index >= 0) return stops[(index + (back ? -1 : 1) + stops.length) % stops.length]
  // DOCUMENT_POSITION_FOLLOWING (4): the stop comes after `at`.
  const after = (stop: HTMLElement) => (at.compareDocumentPosition(stop) & 4) !== 0
  return back ? [...stops].reverse().find(stop => !after(stop)) ?? stops[stops.length - 1] : stops.find(after) ?? stops[0]
}

const factRowSelector = '.peek-fact, .fact-grid-row'
const selectedFacts = (pane: HTMLElement) => selectedPaneFacts(pane, factRowSelector)
const factRowText = (fact: HTMLElement): readonly [string, string] => [
  fact.querySelector('dt')?.textContent ?? '',
  fact.querySelector('.fact-grid-val')?.textContent ?? fact.querySelector('dd')?.textContent ?? ''
]

/**
 * The Properties menu's target: Copy writes the facts whose text is selected in the pane, else every fact it shows, as
 * Name<TAB>Value lines with the platform's line breaks (as a grid copies); none while the facts load or failed.
 * A right-click (or Ctrl+click) on macOS selects the word under it before the menu opens, so a menu opened while a press is
 * down (macOS, Linux) reads the selection as that press began (`press`). The press ends wherever the pointer is released,
 * and then a menu (Windows opens it on release; Shift+F10 and the menu key, which KeybindingService takes before the pane
 * sees them) reads the selection as it is.
 */
export function propertiesMenu(crlf: boolean) {
  let pressed: HTMLElement[] | undefined
  return {
    press(pane: HTMLElement) {
      pressed = selectedFacts(pane)
      const doc = pane.ownerDocument
      const release = () => { pressed = undefined; doc.removeEventListener('pointerup', release, true); doc.removeEventListener('pointercancel', release, true) }
      doc.addEventListener('pointerup', release, true)
      doc.addEventListener('pointercancel', release, true)
    },
    target(pane: HTMLElement): PeekPropertiesTarget | null {
      const facts = [...pane.querySelectorAll<HTMLElement>(factRowSelector)]
      if (!facts.length) return null
      const picked = (pressed ?? selectedFacts(pane)).filter(fact => facts.includes(fact))
      pressed = undefined
      const lines = (picked.length ? picked : facts).map(factRowText)
      return { kind: 'peekProperties', text: peekPropertiesText(lines, crlf) }
    }
  }
}

/** Wires the Peek Properties context menu (Copy selected facts or all facts as TSV) onto a fact-bearing container. */
function PeekFactMenuScope({ children, className, label }: { readonly children: ReactNode; readonly className?: string; readonly label?: string }) {
  const { platform } = useWorkbench()
  const [copy] = useState(() => propertiesMenu(platform === 'win32'))
  const menu = useMenuTarget<HTMLDivElement>(pane => copy.target(pane))
  return <div ref={menu} className={className} tabIndex={label ? 0 : undefined} role={label ? 'region' : undefined} aria-label={label}
    onPointerDownCapture={event => copy.press(event.currentTarget)}>{children}</div>
}

/** The Properties pane: its facts (`Properties`), focusable, with a menu whose Copy writes them. */
export function PropertiesPane({ peek }: { peek: OpenPeek }) {
  return <PeekFactMenuScope className="peek-flow-body peek-properties-pane" label="Properties"><Properties peek={peek} /></PeekFactMenuScope>
}

/** All subtype-matching fact groups for `peek`, rendered via `FactGrid` with refused-group notices where applicable. */
export function Properties({ peek }: { peek: OpenPeek }) {
  const { facts } = peek
  if (facts.status === 'loading') return <p className="peek-note" role="status">Loading properties…</p>
  if (facts.status === 'error') return <p className="peek-note error" role="alert">{facts.message}</p>
  return <div className="peek-overview">
    {visiblePeekGroups(peek).map(group => {
      if (group.refused && peek.refused?.includes(group.id)) return <section key={group.id} className="peek-section" aria-label={group.title}>
        <h3 className="peek-section-title">{group.title}</h3>
        <p className="peek-note">{group.refused}</p>
      </section>
      const shown = group.facts.filter(fact => Object.hasOwn(facts.value, fact.id))
      if (!shown.length) return null
      return <section key={group.id} className="peek-section" aria-label={group.title}>
        <h3 className="peek-section-title">{group.title}</h3>
        <FactGrid facts={shown.map(fact => ({
          id: fact.id,
          label: fact.label,
          value: facts.value[fact.id] === null ? '' : formatPeekValue(fact, facts.value[fact.id])
        }))} />
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
      event.currentTarget.closest('[data-object-inspector], .peek-view')?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
      const open = view.getSnapshot().open
      if (open) view.selectTab(open.tab)
    }}>Retry</button></div>
  return null
}

/** Overview tab: Identity FactGrid sections (with copy & cross-object links) + signal-first CapabilityChips. */
function OverviewTab({ open, onFollow }: { readonly open: OpenPeek; readonly onFollow?: (target: ObjectRef, label: string) => void }) {
  if (open.facts.status !== 'ready') return <Pending part={open.facts} loading="Loading properties…" />
  const { sections, capabilities } = peekOverviewModel(open, onFollow)
  return <PeekFactMenuScope className="peek-flow-body peek-properties-pane" label="Properties">
    <div className="peek-overview">
      {sections.map(section => <section key={section.id} className="peek-section" aria-label={section.title}>
        <h3 className="peek-section-title">{section.title}</h3>
        {section.refused ? <p className="peek-note">{section.refused}</p> : <FactGrid facts={section.facts} />}
      </section>)}
      {capabilities.length > 0 && <section className="peek-section" aria-label="Capabilities">
        <h3 className="peek-section-title">Capabilities</h3>
        <CapabilityChips items={capabilities} label="Capabilities" />
      </section>}
    </div>
  </PeekFactMenuScope>
}

/** Storage & Layout tab (`table`): Data vs. Index RatioBar + storage FactGrid. */
function StorageTab({ open }: { readonly open: OpenPeek }) {
  if (open.facts.status !== 'ready') return <Pending part={open.facts} loading="Loading storage…" />
  const { meter, facts } = peekStorageModel(open)
  return <PeekFactMenuScope className="peek-flow-body">
    <section className="peek-section" aria-label="Storage">
      {meter && <RatioBar title={meter.title} totalLabel={meter.totalLabel} segments={meter.segments} />}
      {facts.length > 0 ? <FactGrid facts={facts} /> : <p className="peek-note">No storage details available.</p>}
    </section>
  </PeekFactMenuScope>
}

/** Usage Telemetry tab (`index`): Seeks/Scans vs. Updates RatioBar + usage FactGrid or permission refusal notice. */
function UsageTab({ open }: { readonly open: OpenPeek }) {
  if (open.facts.status !== 'ready') return <Pending part={open.facts} loading="Loading usage…" />
  const { meter, facts, refused } = peekUsageModel(open)
  return <PeekFactMenuScope className="peek-flow-body">
    <section className="peek-section" aria-label="Usage since the server started">
      {refused ? <p className="peek-note">{refused}</p> : <>
        {meter && <RatioBar title={meter.title} totalLabel={meter.totalLabel} segments={meter.segments} />}
        {facts.length > 0 ? <FactGrid facts={facts} /> : <p className="peek-note">No usage recorded since the server started.</p>}
      </>}
    </section>
  </PeekFactMenuScope>
}

/** Right Vitals rail body: flat RatioBar (where applicable), compact At a Glance FactGrid, and notable capability chips. */
function PeekVitals({ open, onFollow }: { readonly open: OpenPeek; readonly onFollow?: (target: ObjectRef, label: string) => void }) {
  if (open.facts.status === 'loading') return <div className="vitals-block"><p className="peek-note">Loading…</p></div>
  if (open.facts.status === 'error') return <div className="vitals-block"><p className="peek-note error">{open.facts.message}</p></div>
  const { meter, facts, notableFlags } = peekVitalsModel(open, onFollow)
  return <PeekFactMenuScope className="peek-vitals-scope">
    {meter && <div className="vitals-block">
      <RatioBar flat title={meter.title} totalLabel={meter.totalLabel} segments={meter.segments} />
    </div>}
    {facts.length > 0 && <div className="vitals-block">
      <h4 className="vitals-block-title">At a glance</h4>
      <FactGrid compact facts={facts} />
    </div>}
    {notableFlags.length > 0 && <div className="vitals-block">
      <h4 className="vitals-block-title">Notable</h4>
      <ul className="cap-chips" aria-label="Notable capabilities">
        {notableFlags.map(item => (
          <li key={item.id} className="cap-chip on" data-tone={item.tone} title={item.title}>
            <span className="cap-chip-label">{item.label}</span>
            {item.value !== undefined && <span className="cap-chip-value">{item.value}</span>}
          </li>
        ))}
      </ul>
    </div>}
  </PeekFactMenuScope>
}

const dependencyName = (dependency: PeekDependency) => displayText([dependency.server, dependency.database, dependency.schema, dependency.name].filter(part => part !== undefined).join('.'))

function DependencyList({ title, items, truncated, follow, canFollow }: { title: string; items: readonly PeekDependency[]; truncated: boolean; follow: (dependency: PeekDependency) => void; canFollow: (dependency: PeekDependency) => boolean }) {
  return <section className="peek-dep-section" aria-label={title}>
    <h3 className="peek-section-title">{title}{items.length > 0 && <span className="peek-section-count">{items.length}{truncated ? '+' : ''}</span>}</h3>
    {items.length === 0 ? <p className="peek-note">{peekMessages.noDependencies}</p> : <ul className="peek-dep-list">{items.map((dependency, index) => {
      const icon = <ExplorerIcon name={dependency.kind ? kindSpecs[dependency.kind].icon : 'references'} />
      const note = dependency.foreignKey ? 'Foreign key' : dependency.kind ? kindSpecs[dependency.kind].title : undefined
      const body = <>{icon}<bdi className="peek-item-name">{dependencyName(dependency)}</bdi>{note && <span className="peek-item-note">{note}</span>}</>
      return <li key={index} className="peek-dep-item">{canFollow(dependency)
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
  return <div className="peek-dep-cols">
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
  // Only this run's entry: other tabs' results streaming do not draw the card again.
  const key = part?.status === 'ready' ? part.value.key : undefined
  const tab = useServiceSelector(results, all => key === undefined ? undefined : all[key])
  if (part?.status !== 'ready') return <Pending part={part} loading="Reading the top rows…" />
  if (!tab?.sets.length) return <p className="peek-note">{peekMessages.rowsUnavailable}</p>
  const read = tab.summary?.resultSets[0]?.rowsRead
  return <div className="peek-rows" data-peek-rows="">
    <ResultsStack tabId={part.value.key} tab={tab} />
    {read === 0 && <p className="peek-note">{peekMessages.noRows}</p>}
  </div>
}

/**
 * One of the kind's lists (`peekLists`: Columns or Parameters, an index's columns, a trigger's events …), which come with the
 * facts, as a local grid: a card's in the hover card, a page's (with Save Results As) in a promoted tab.
 */
export function PeekListView({ id, part, list, preset, objectName }: { id: PeekListId; part: OpenPeek['facts']; list: PeekList | undefined; preset: LocalGridPreset; objectName: string }) {
  if (part.status !== 'ready') return <Pending part={part} loading="Loading…" />
  return <div className="peek-list-fill">
    <PeekListGrid id={id} list={list} preset={preset} fill={preset === 'card'} objectName={objectName} />
    {list?.truncated && <p className="peek-note">There are more than the card lists.</p>}
    {list?.unread !== undefined && <p className="peek-note">{list.unread === 1 ? '1 database' : `${list.unread.toLocaleString()} databases`} could not be read.</p>}
  </div>
}

/** An Object Explorer node's display name for Peek's header: its schema and name, a child's (an index, a trigger) below its parent's. */
export function peekName(open: OpenPeek): string {
  return open.node.ref.type === 'object' ? peekObjectName(open.node.ref.object) : ''
}

export interface PeekInspectorProps {
  readonly view: PeekView
  readonly open: OpenPeek
  readonly idPrefix: string
  readonly surface?: InspectorSurface
  readonly crumbs?: readonly Crumb[]
  readonly tools?: ReactNode
  readonly verbs?: readonly Verb[]
  readonly extraVerbs?: readonly HeaderVerb[]
  readonly beforeScript?: () => void
  readonly inEditorPane?: boolean
  readonly attributes?: Readonly<Record<`data-${string}`, string>>
  readonly className?: string
  readonly style?: CSSProperties
  readonly role?: 'region' | 'dialog'
  readonly ariaLabel?: string
  readonly ariaModal?: boolean
  readonly tabIndex?: number
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  readonly rootRef?: Ref<HTMLDivElement>
}

/**
 * Unified Peek inspector body shared by both floating Peek Card (`surface="peek"`) and promoted Peek Tab (`surface="full"`).
 * Renders connected `ObjectInspectorFrame` (falling back to `ObjectInspectorFrameView` in minimal test harnesses without
 * `workbench.inspector`), owns the single read-only `PeekEditor` instance per view, and maps canonical tabs onto single-scroll
 * `flow` and `fill` pane archetypes with a resizable right Vitals rail.
 */
export function PeekBody({
  view, open, idPrefix, surface, crumbs, tools, verbs, extraVerbs, beforeScript, inEditorPane = false,
  attributes, className, style, role, ariaLabel, ariaModal, tabIndex, onKeyDown, rootRef
}: PeekInspectorProps) {
  const workbench = useWorkbench(), { commands } = workbench
  const resolvedSurface: InspectorSurface = surface ?? (inEditorPane ? 'full' : 'peek')
  const node = open.node
  const name = peekName(open)
  const definition = open.definition.status === 'ready' ? open.definition.value : undefined
  const copyable = copyableDefinition(definition?.text)
  const script = scriptCommandId('create', 'newQuery')
  // The node's own selection keys, as a Peek tab's verbs pass them: the shown object may be a followed dependency, not the tree's selection.
  const target: CommandArgs = { target: { kind: 'explorer', node }, state: selectionContextOf(node, { insertable: insertTextFor(node.ref) !== undefined }) }
  const modifiable = !!target.state?.explorerSelectionModifiable
  // Made in an effect, not during render, so StrictMode's replayed effects never leave the body with a disposed editor.
  const [editor, setEditor] = useState<PeekEditor | undefined>(undefined)
  useEffect(() => {
    if (!workbench.monaco) return
    // A promoted tab lives in the Query editor pane, so its widgets hide with that pane; the card floats outside every pane.
    const made = new PeekEditor({ monaco: workbench.monaco, create: container => createQueryEditor(workbench, container, { ...peekEditorUse, inEditorPane }),
      modelOptions: settingsDocumentOptions(() => workbench.settings.getSnapshot().values).modelOptions })
    setEditor(made)
    return () => made.dispose()
  }, [workbench, inEditorPane])
  // The model of a definition the view has moved on from goes at once, even while another tab shows.
  const shownKey = definition?.text === undefined ? undefined : String(open.id)
  useEffect(() => { editor?.keep(shownKey) }, [editor, shownKey])

  // Preserve keyboard focus inside the inspector when in-place navigation (followObject, goBack, refresh) replaces the
  // keyed active pane or unmounts the Back button while this inspector owned focus.
  const frameEl = useRef<HTMLDivElement | null>(null)
  const [frameNode, setFrameNode] = useState<HTMLDivElement | null>(null)
  const hadFocus = useRef(false)
  const lastOpenId = useRef(open.id)
  const assignRoot = useCallback((el: HTMLDivElement | null) => {
    frameEl.current = el
    setFrameNode(el)
    if (typeof rootRef === 'function') rootRef(el)
    else if (rootRef && 'current' in rootRef) (rootRef as { current: HTMLDivElement | null }).current = el
  }, [rootRef])
  useEffect(() => {
    if (!frameNode) return
    const onFocusIn = () => { hadFocus.current = true }
    const isDomNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && 'nodeType' in value
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget
      if (isDomNode(next) && frameNode.contains(next)) return
      if (next === null && isDomNode(event.target) && !event.target.isConnected) return
      hadFocus.current = false
    }
    frameNode.addEventListener('focusin', onFocusIn)
    frameNode.addEventListener('focusout', onFocusOut)
    const active = frameNode.ownerDocument.activeElement
    hadFocus.current = !!active && frameNode.contains(active)
    return () => {
      frameNode.removeEventListener('focusin', onFocusIn)
      frameNode.removeEventListener('focusout', onFocusOut)
    }
  }, [frameNode])
  useLayoutEffect(() => {
    if (lastOpenId.current === open.id) return
    lastOpenId.current = open.id
    const el = frameEl.current
    if (!el || !hadFocus.current) return
    const active = el.ownerDocument.activeElement
    if (!active || active === el.ownerDocument.body || !el.contains(active)) {
      const target = el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? el
      target.focus({ preventScroll: true })
    }
  }, [open.id])

  const preset: LocalGridPreset = inEditorPane ? 'page' : 'card'
  const onFollow = view.connected ? (object: ObjectRef, label: string) => view.followObject(object, label) : undefined
  const pills = peekStatePills(open)
  const state = pills.length > 0 ? <span className="peek-state-pills">{pills.map(pill => <StatusPill key={pill.id} tone={pill.tone} label={pill.label} size="small" title={pill.title} />)}</span> : undefined
  const kpis = resolvedSurface === 'full' ? peekHeroKpis(open) : []

  const renderTabContent = (tab: PeekTab): ReactNode => {
    if (tab === 'overview') return <OverviewTab key={`${open.id}:overview`} open={open} onFollow={onFollow} />
    if (tab === 'definition') return <div key={`${open.id}:definition`} className="peek-definition-pane">
      <div className="peek-definition-bar">
        <span className="peek-definition-label">T-SQL Definition</span>
        <div className="peek-actions">
          <button type="button" className="peek-action" disabled={!copyable} title={definition?.text !== undefined && !copyable ? tooLongToCopy : undefined}
            onClick={() => { view.copyDefinition().catch(onUnexpectedError) }}>Copy</button>
          <button type="button" className="peek-action" disabled={!commands.isEnabled(script, target)}
            onClick={() => { beforeScript?.(); void commands.execute(script, target, 'toolbar') }}>Script to New Query</button>
          {modifiable && <button type="button" className="peek-action" disabled={!commands.isEnabled('explorer.modify', target)}
            onClick={() => { beforeScript?.(); void commands.execute('explorer.modify', target, 'toolbar') }}>Modify</button>}
        </div>
      </div>
      <Definition part={open.definition} editor={editor} open={open} />
    </div>
    if (tab === 'storage') return <StorageTab key={`${open.id}:storage`} open={open} />
    if (tab === 'usage') return <UsageTab key={`${open.id}:usage`} open={open} />
    if (isPeekListTab(tab)) return <PeekListView key={`${open.id}:${tab}`} id={tab} part={open.facts} list={open.lists?.[tab]} preset={preset} objectName={name} />
    if (tab === 'dependencies') return <Dependencies key={`${open.id}:dependencies`} part={open.dependencies} />
    return <PeekRowsPart key={`${open.id}:rows`} part={open.rows} />
  }

  const tabs: InspectorTab[] = peekTabsOf(open.kind).map(tab => {
    const layout: 'flow' | 'fill' = tab === 'definition' || tab === 'rows' || isPeekListTab(tab) ? 'fill' : 'flow'
    const count = peekTabCount(open, tab)
    return {
      id: tab,
      title: peekTabTitle(open.kind, tab),
      layout,
      ...(count !== undefined ? { count } : {}),
      content: open.tab === tab ? renderTabContent(tab) : null
    }
  })

  const vitals = <PeekVitals open={open} onFollow={onFollow} />
  const frameProps = {
    id: idPrefix,
    title: name,
    subtitle: kindSpecs[open.kind].title,
    crumbs,
    state,
    tools,
    surface: resolvedSurface,
    kpis,
    tabs,
    activeTab: open.tab,
    onSelectTab: (id: string) => view.selectTab(id as PeekTab),
    vitals,
    attributes,
    className: ['peek-view', className].filter(Boolean).join(' '),
    style,
    role,
    ariaLabel,
    ariaModal,
    tabIndex,
    onKeyDown,
    rootRef: assignRoot
  }

  return <PeekViewContext.Provider value={view}>
    {workbench.inspector
      ? <ObjectInspectorFrame {...frameProps} verbs={verbs} extraVerbs={extraVerbs} />
      : <ObjectInspectorFrameView {...frameProps} verbs={extraVerbs} />}
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

/**
 * Places a card at its anchor, again as the anchor moves (the editor scrolls) or the window resizes, once a frame; the anchor
 * going away (its text changed, its editor closed) closes the card. Returns the cleanup.
 */
function placeAtAnchor(anchor: PeekAnchor, setPlace: (update: (last: ReturnType<typeof placePeek> | undefined) => ReturnType<typeof placePeek>) => void, close: () => void): () => void {
  const view = anchor.document.defaultView
  if (!view) return () => {}
  let frame = 0
  const measure = () => { frame = 0; setPlace(last => placePeekAt(anchor.rect(), { width: view.innerWidth, height: view.innerHeight }, last)) }
  const schedule = () => { if (!frame) frame = view.requestAnimationFrame(measure) }
  measure()
  const unwatch = anchor.watch(schedule, close)
  view.addEventListener('resize', schedule)
  return () => { if (frame) view.cancelAnimationFrame(frame); unwatch(); view.removeEventListener('resize', schedule) }
}

/**
 * Where a card is drawn: `explorer` beside Object Explorer's rows (in its pane), `editor` beside a name in a query editor
 * (the workbench's, `PeekAnchor`). Each placement draws only its own cards and closes only its own as it goes away.
 */
export type PeekPlacement = 'explorer' | 'editor'
const ownCard = (open: OpenPeek | undefined, placement: PeekPlacement): open is OpenPeek => !!open && !!open.anchor === (placement === 'editor')

export default function PeekCard({ placement = 'explorer' }: { readonly placement?: PeekPlacement }) {
  const { peek: service } = useWorkbench()
  const { open } = useServiceSnapshot(service)
  return <PeekBoundary peekId={open?.id} close={() => { if (ownCard(service.getSnapshot().open, placement)) service.close() }}><PeekCardView placement={placement} /></PeekBoundary>
}

/**
 * The floating Peek Card: renders connected `ObjectInspectorFrame` (`surface="peek"`) beside Object Explorer in the window
 * the pane is in (docs/popout-windows.md), or below a name in a query editor (its anchor's window). Esc, a click outside it
 * or another peek closes it; a peek from the keyboard or the menu focuses it, a hover does not. Open as Tab (Ctrl+Enter,
 * ⌘↩ on macOS) promotes it to a document tab.
 */
function PeekCardView({ placement }: { readonly placement: PeekPlacement }) {
  const { peek: service, commands, keybindings } = useWorkbench()
  const snapshot = useServiceSnapshot(service)
  const open = ownCard(snapshot.open, placement) ? snapshot.open : undefined
  // The tooltip names Open as Tab's key, which the Shortcuts page can change.
  useKeybindingsRevision()
  const tabKey = keybindings.lookup('explorer.openPeekTab')
  const anchor = useRef<HTMLSpanElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<ReturnType<typeof placePeek> | undefined>(undefined)
  const doc = open?.anchor?.document ?? anchor.current?.ownerDocument

  // Placed again as the tree scrolls or the window resizes; a row scrolled out of the window keeps the card where it was.
  useLayoutEffect(() => {
    const here = anchor.current
    if (!open || !here) { setPlace(undefined); return }
    if (open.anchor) return placeAtAnchor(open.anchor, setPlace, () => service.close())
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
  }, [open?.id, open?.rowId, open?.anchor])

  // The keyboard and the menu move focus into the card (once per peek), so Esc and screen readers reach it.
  const focused = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!open || open.source === 'hover' || focused.current === open.id || !place) return
    focused.current = open.id
    card.current?.focus({ preventScroll: true })
  }, [open?.id, open?.source, place])

  // A press outside the card closes it; a press on a row then selects that row as usual. The definition editor's widgets
  // (hover, read-only message) live outside the card, in a host of their own, and count as inside, as do the menus its grids
  // and Properties open (MenuLayer draws them in the window's menu layer).
  useEffect(() => {
    if (!open || !doc) return
    const press = (event: PointerEvent) => {
      if (card.current?.contains(event.target as Node) || inPeekEditorWidgets(event.target, card.current) || (event.target as Element | null)?.closest?.('.menu-layer')) return
      service.close()
    }
    doc.addEventListener('pointerdown', press, true)
    return () => doc.removeEventListener('pointerdown', press, true)
  }, [open?.id, doc, service])

  const close = (refocus: boolean) => {
    const tree = card.current?.ownerDocument.querySelector<HTMLElement>('[data-explorer-tree]'), editor = open?.anchor
    service.close()
    if (!refocus) return
    if (editor) editor.focus()
    else tree?.focus({ preventScroll: true })
  }
  // Tab stays within the card, so Esc keeps reaching it; Esc or Close returns to the tree, or to the editor the name is in.
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key !== 'Tab' || !card.current) return
    const at = card.current.ownerDocument.activeElement
    const find = at?.closest('.find-widget')
    const next = nextStop(cardStops(card.current), at, event.shiftKey, at === card.current, !!find && !!at && leavesFind(find, at, event.shiftKey))
    if (next === 'native') return
    event.preventDefault()
    next?.focus()
  }

  const name = open ? peekName(open) : ''
  const back = open && open.back.length > 0
    ? <button type="button" className="icon-button" aria-label="Back" title="Back" onClick={() => service.goBack()}><Icon name="arrow-left" /></button>
    : undefined
  const extraVerbs: HeaderVerb[] = [
    { key: 'open-tab', label: 'Open as Tab', title: tabKey ? `Open as Tab (${tabKey.text})` : 'Open as Tab', icon: 'link-external', disabled: false,
      run: () => { void commands.execute('explorer.openPeekTab', undefined, 'toolbar') } },
    { key: 'refresh', label: 'Refresh', title: 'Refresh', icon: 'refresh', disabled: !service.connected,
      run: () => service.refresh() },
    { key: 'close', label: 'Close', title: 'Close (Esc)', icon: 'close', disabled: false,
      run: () => close(true) }
  ]

  return <span ref={anchor} className="peek-anchor" hidden>
    {open && place && doc && createPortal(
      <PeekBody
        view={service}
        open={open}
        idPrefix="peek"
        surface="peek"
        tools={back}
        extraVerbs={extraVerbs}
        beforeScript={() => close(false)}
        rootRef={card}
        className="peek-card"
        role="dialog"
        ariaModal={false}
        ariaLabel={`Peek: ${name}`}
        tabIndex={-1}
        onKeyDown={keyDown}
        attributes={{ 'data-peek-source': open.source, 'data-peek-card': '', 'data-peek-placement': placement }}
        style={{ left: place.left, top: place.top, width: place.width, height: place.height }}
      />, doc.body)}
  </span>
}
