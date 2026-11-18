// What a server dragged from Object Explorer shows over the editor area: the card under a query's tab, the overlay on its
// editor, the chip that flies into the tab on a drop, and the tab's swap once the query has moved. ServerDropService
// holds the state; bindServerDrop turns the native drag events into it.
import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import type { Disposable } from '../core/types'
import Icon from '../Icon'
import EnvironmentTag from '../EnvironmentTag'
import { explorerTargetDragType, type DropHover, type DropLanding, type DropPlace, type DropRect, type DropVerdict, type ServerDrag, type ServerDropService } from './server-drop'

/** Whether motion is reduced (the Options setting that follows the system, when it is on). */
const reducedMotion = (): boolean => document.documentElement.classList.contains('varia-reduced-motion')
const rectOf = (element: Element): DropRect => { const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, width: box.width, height: box.height } }
const pointRect = (event: DragEvent): DropRect => ({ left: event.clientX - 40, top: event.clientY - 12, width: 80, height: 24 })

interface Place { readonly place: DropPlace; readonly tabId?: string; readonly element: HTMLElement }
/** The tab, strip or query editor under a drag event inside the editor area. */
export function placeOf(root: HTMLElement, target: EventTarget | null): Place | undefined {
  if (!(target instanceof Element) || !root.contains(target)) return undefined
  const tab = target.closest<HTMLElement>('.dv-tab')
  if (tab) {
    const tabId = tab.querySelector<HTMLElement>('[data-tab-id]')?.dataset.tabId
    return tabId ? { place: 'tab', tabId, element: tab } : undefined
  }
  const strip = target.closest<HTMLElement>('.dv-tabs-and-actions-container')
  if (strip) return target.closest('button, a, input, [role="menu"]') ? undefined : { place: 'strip', element: strip }
  const editor = target.closest<HTMLElement>('[data-document-id]')
  return editor?.dataset.documentId ? { place: 'editor', tabId: editor.dataset.documentId, element: editor } : undefined
}

export interface ServerDropBindings {
  /** Whether the drag holds the modifier that inserts the name instead (the explorer.dropServerName gesture). */
  insertHeld(event: DragEvent): boolean
  /** Makes the group a strip belongs to the active one, so a new query opens there. */
  activateGroupOf(element: Element): void
  reportError(error: unknown): void
}
/**
 * Listens on the editor area, in the capture phase so a move never reaches Monaco's own drop (which would insert the
 * name): over a query's tab or editor the drop moves the query; with the insert modifier over the editor it passes through, and
 * Monaco with bindExplorerDrop inserts the name. Over a strip's empty space it opens a new query.
 */
export function bindServerDrop(root: HTMLElement, service: ServerDropService, bindings: ServerDropBindings): Disposable {
  const carried = (event: DragEvent): ServerDrag | undefined => event.dataTransfer && Array.from(event.dataTransfer.types).includes(explorerTargetDragType) ? service.drag : undefined
  const resolve = (event: DragEvent): (DropHover & { element: HTMLElement }) | undefined => {
    const at = placeOf(root, event.target)
    if (!at) return undefined
    const verdict: DropVerdict = at.place === 'strip' ? service.stripVerdict() : service.verdict(at.tabId)
    return { place: at.place, tabId: at.tabId, verdict, insert: at.place === 'editor' && bindings.insertHeld(event), rect: rectOf(at.element), element: at.element }
  }
  const over = (event: DragEvent) => {
    if (!carried(event)) return
    const at = resolve(event)
    if (!at) { service.hover(undefined); return }
    const { element: _element, ...hover } = at
    service.hover(hover)
    if (at.insert) return
    event.stopPropagation()
    if (at.verdict.accept) { event.preventDefault(); event.dataTransfer!.dropEffect = 'move' }
  }
  // Chromium's dragleave rarely names where the pointer went, so only a pointer outside the area clears what is shown.
  const leave = (event: DragEvent) => {
    if (!carried(event)) return
    const box = root.getBoundingClientRect()
    if (event.clientX <= box.left || event.clientY <= box.top || event.clientX >= box.right || event.clientY >= box.bottom) service.hover(undefined)
  }
  const drop = (event: DragEvent) => {
    const drag = carried(event)
    if (!drag) return
    const at = resolve(event)
    if (!at || at.insert) return
    event.stopPropagation()
    event.preventDefault()
    if (!at.verdict.accept) { service.end(); return }
    if (at.place === 'strip') { bindings.activateGroupOf(at.element); service.openQuery(drag); return }
    const plate = at.place === 'editor' ? document.querySelector('.server-drop-plate') : null
    service.moveQuery(at.tabId!, plate ? rectOf(plate) : pointRect(event), drag).catch(bindings.reportError)
  }
  root.addEventListener('dragover', over, true)
  root.addEventListener('dragleave', leave, true)
  root.addEventListener('drop', drop, true)
  return { dispose: () => { root.removeEventListener('dragover', over, true); root.removeEventListener('dragleave', leave, true); root.removeEventListener('drop', drop, true) } }
}

/** Marks the tabs while a drag is in flight (`data-server-drag` on the area, `data-server-drop` on the tab under it). */
function useTabMarks(root: HTMLElement | null, dragging: boolean, hover: DropHover | undefined): void {
  useEffect(() => {
    if (!root) return
    if (dragging) root.dataset.serverDrag = ''
    else delete root.dataset.serverDrag
  }, [root, dragging])
  const tabId = hover?.place === 'tab' ? hover.tabId : undefined, accept = hover?.verdict.accept
  useEffect(() => {
    const tab = tabId && root ? root.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`)?.closest<HTMLElement>('.dv-tab') : undefined
    if (!tab) return
    tab.dataset.serverDrop = accept ? 'accept' : 'refuse'
    return () => { delete tab.dataset.serverDrop }
  }, [root, tabId, accept])
}

const refusal: Record<Exclude<DropVerdict, { accept: true }>['reason'], (name: string, server: string) => string> = {
  notQuery: () => 'Only a query can move to another server; this document keeps the server it was opened for.',
  running: name => `${name} is executing. Stop the query to move it to another server.`,
  same: (_name, server) => `This query is already on ${server}; its session is kept.`,
  disconnected: (_name, server) => `${server} is not connected.`,
  busy: () => 'Wait for the current operation to finish.'
}

/** The card under a tab, the plate on an editor and the line under a strip: what the drop will do. */
function DropCard({ hover, drag, mode }: { hover: DropHover; drag: ServerDrag; mode: 'card' | 'plate' }) {
  const { documents, connections, gestures } = useWorkbench()
  const all = useServiceSnapshot(connections)
  const document = hover.tabId ? documents.get(hover.tabId) : undefined
  const from = all.find(connection => connection.id === document?.connectionId), to = all.find(connection => connection.id === drag.connectionId)
  const toName = drag.server, fromName = from ? from.displayName ?? from.server : 'Disconnected'
  const environment = to?.options.environment
  let title: string, body: React.ReactNode = null
  if (hover.place === 'strip') title = `Open a new query on ${toName}${drag.database ? ` · ${drag.database}` : ''}`
  else if (!hover.verdict.accept) title = refusal[hover.verdict.reason](document?.name ?? 'This query', toName)
  else if (hover.verdict.action === 'database') title = `Change ${document?.name ?? 'this query'}'s database to ${drag.database}`
  else {
    title = `Move ${document?.name ?? 'this query'} to ${toName}`
    body = <>
      <div className="server-drop-move"><span className="server-drop-from">{fromName}</span><Icon name="arrow-right" /><span className="server-drop-to">{toName}</span>{environment && <EnvironmentTag environment={environment} place="list" />}</div>
      <div className="server-drop-note">{drag.database ? `Database: ${drag.database}.` : `Database: ${to?.database ?? 'the server\'s default'} (its default).`}{from ? ` The query's session on ${fromName} ends.` : ''}</div>
    </>
  }
  const insert = gestures.modifiers('explorer.dropServerName') ? gestures.phrase('explorer.dropServerName') : undefined
  const hint = mode === 'plate' && insert ? `${insert[0].toUpperCase()}${insert.slice(1)} to insert the name instead` : undefined
  return <div className={mode === 'plate' ? 'server-drop-plate' : 'server-drop-card'} role="status" aria-label="Server drop" data-refused={!hover.verdict.accept || undefined}>
    {mode === 'plate' && <span className="server-drop-plug" aria-hidden="true"><Icon name={!hover.verdict.accept ? 'circle-slash' : drag.database ? 'database' : 'server'} /></span>}
    <div className="server-drop-title">{title}</div>
    {body}
    {hint && <div className="server-drop-hint">{hint}</div>}
  </div>
}

/** The chip that flies from the drop point into the tab; then the tab plays its swap. */
function Landing({ landing, root, service }: { landing: DropLanding; root: HTMLElement; service: ServerDropService }) {
  const chip = useRef<HTMLDivElement>(null)
  const tabOf = () => root.querySelector(`[data-tab-id="${CSS.escape(landing.tabId)}"]`)?.closest<HTMLElement>('.dv-tab') ?? undefined
  useLayoutEffect(() => {
    const element = chip.current, tab = tabOf()
    if (!element || !tab || reducedMotion()) { if (element) element.hidden = true; return }
    const to = tab.getBoundingClientRect(), from = landing.from
    const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2)
    // A slight arc: it rises faster than it moves across, shrinking as it goes, and fades as it reaches the tab.
    const flight = element.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 1, easing: 'cubic-bezier(0.3, 0, 0.6, 1)' },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.78}px) scale(0.45)`, opacity: 1, offset: 0.55, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' },
      { transform: `translate(${dx}px, ${dy}px) scale(0.1)`, opacity: 0 }
    ], { duration: 460, fill: 'forwards' })
    return () => flight.cancel()
    // The flight runs once per drop.
  }, [landing.seq])
  useEffect(() => {
    if (!landing.arrived) return
    const tab = tabOf()
    if (!tab || reducedMotion()) { service.finishLanding(landing.seq); return }
    tab.dataset.serverLanding = ''
    // The swap's last animation (the wash) ends the landing.
    const ended = (event: AnimationEvent) => { if (event.animationName === 'server-drop-wash') service.finishLanding(landing.seq) }
    tab.addEventListener('animationend', ended)
    return () => { tab.removeEventListener('animationend', ended); delete tab.dataset.serverLanding }
  }, [landing.seq, landing.arrived])
  const { left, top, width, height } = landing.from
  return <div ref={chip} className="server-drop-chip" aria-hidden="true" style={{ left: left + width / 2, top: top + height / 2 }}><Icon name="server" />{landing.label}</div>
}

/** The editor area's drop layer. */
export default function ServerDropLayer({ root }: { root: HTMLElement | null }) {
  const { serverDrop } = useWorkbench()
  const { drag, hover, landing } = useServiceSnapshot(serverDrop)
  useTabMarks(root, !!drag, drag ? hover : undefined)
  if (!root) return null
  const show = drag && hover && !hover.insert ? hover : undefined
  return createPortal(<>
    {show && show.place !== 'editor' && <div className="server-drop-anchor" style={{ left: Math.max(4, show.rect.left), top: show.rect.top + show.rect.height + 6 }}><DropCard hover={show} drag={drag!} mode="card" /></div>}
    {show && show.place === 'editor' && <div className="server-drop-overlay" data-refused={!show.verdict.accept || undefined} style={{ left: show.rect.left, top: show.rect.top, width: show.rect.width, height: show.rect.height }}>
      <DropCard hover={show} drag={drag!} mode="plate" />
    </div>}
    {drag && hover?.insert && <div className="server-drop-anchor server-drop-insert" style={{ left: hover.rect.left + hover.rect.width / 2, top: hover.rect.top + hover.rect.height - 48 }}>
      <div className="server-drop-card" role="status" aria-label="Server drop">Insert the name at the caret · release the key to move the query instead</div>
    </div>}
    {landing && <Landing key={landing.seq} landing={landing} root={root} service={serverDrop} />}
  </>, document.body)
}
