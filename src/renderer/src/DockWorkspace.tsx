import { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { DockviewDefaultTab, DockviewReact, themeDark, themeLight, type DockviewApi, type DockviewGroupPanel, type DockviewReadyEvent, type FloatingGroupDragContext, type IDockviewPanelHeaderProps, type IDockviewPanelProps, type Position } from 'dockview-react'
import { canPopOut, dockReference, emptyLayoutState, hidesHeader, isOutputPane, outputIndex, outputPaneIds, paneIds, paneTitles, parseWorkspaceLayout, withoutHeaderState, type LayoutLoad, type LayoutState, type OutputPaneId, type PaneId, type PopoutLayout, type PopoutPaneId, type WorkspaceLayout } from '../../shared/layouts'
import { popoutLimits } from '../../shared/popouts'
import type { ThemeType } from '../../shared/theme/types'
import { DockingGuides } from './docking-guides'
import Icon from './Icon'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { useMenuTarget } from './menus/useMenuTarget'
import EmptyState from './kit/EmptyState'
import type { PaneLocation } from './services/panes'
import type { DockSide } from './contributions/shell'
import { preparePopoutDocument, type PopoutDocument } from './popouts/popout-document'
import PopoutFrame, { type PopoutCommands } from './popouts/PopoutFrame'
import { placeHost } from './popouts/place'
import { paneDrag } from './popouts/drag'
import { watchModals, windows } from './core/windows'
import { focusToReturn, returnFocusTo } from './core/focus'

interface PaneHosts { hosts: Record<PaneId, HTMLElement>; parking: RefObject<HTMLDivElement | null> }
interface PaneCommands { close(id: PaneId): void; float(id: PaneId): void; toggle(id: PaneId): void; reveal(id: PaneId): void }
const PaneContext = createContext<PaneHosts | null>(null)
const PaneCommandContext = createContext<PaneCommands | null>(null)
// Whether the saved layout has been applied; until then the workspace has no panels, and none were closed.
const RestoredContext = createContext(false)
function Pane({ api }: IDockviewPanelProps) {
  const content = useContext(PaneContext)!, slot = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const host = content.hosts[api.id as PaneId], element = slot.current
    if (element) placeHost(host, element)
    // Parked only if it is still here: a panel moving into a popout window has already gone there.
    return () => { const parking = content.parking.current; if (element && parking && host.parentElement === element) placeHost(host, parking) }
  }, [api.id, content])
  return <div className="dock-slot" ref={slot} />
}
const components = { workbench: Pane }
// A floating panel may hang past the window's edges, as far as keeps this much of it, titlebar included, to grab.
const floatingBounds = { minimumWidthWithinViewport: 120, minimumHeightWithinViewport: 60 }
// Never past the top edge, where its titlebar would go: it hangs off the left, right and bottom only.
const keepTitlebar = ({ proposed }: FloatingGroupDragContext) => ({ top: Math.max(0, proposed.top), left: proposed.left })
// Dockview splits className, so `varia-dock` lands on its shell next to the theme class (see styles.css).
const dockThemes = {
  dark: { ...themeDark, name: 'varia-dark', className: 'dockview-theme-dark varia-dock' },
  light: { ...themeLight, name: 'varia-light', className: 'dockview-theme-light varia-dock' }
} satisfies Record<ThemeType, typeof themeDark>
/** A popout window, open: its layout, the window, and the root its frame renders into. */
interface PopoutRecord extends PopoutLayout { readonly window: Window; readonly root: HTMLElement; title(value: string): void; dispose(): void }
const clampSize = (value: number, min: number) => Math.min(popoutLimits.maxSize, Math.max(min, Math.round(Number.isFinite(value) ? value : min)))
const clampCoordinate = (value: number) => Math.min(32_000, Math.max(-32_000, Math.round(Number.isFinite(value) ? value : 0)))
const windowTitle = (pane: PaneId) => paneTitles[pane] + ' - Varia SQL Manager'
const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
function paneHost(id: PaneId) { const host = document.createElement('div'); host.className = 'dock-pane'; host.dataset.pane = id; return host }
function EmptyWorkspace() {
  const commands = useContext(PaneCommandContext)!, restored = useContext(RestoredContext)
  if (!restored) return null
  return <EmptyState className="dock-empty" icon="layout" title="All panels are closed." detail="Open a panel from the Window menu." actions={[{ label: 'Open Query editor', run: () => commands.reveal('editor') }]} />
}
function PaneTab(props: IDockviewPanelHeaderProps) {
  const commands = useContext(PaneCommandContext)!, element = useRef<HTMLDivElement>(null)
  const { results, documents } = useWorkbench()
  // An output panel's dock tab chosen by the user is the active query's view, as its toolbar tab is.
  const choose = () => { const id = props.api.id, tabId = documents.getSnapshot().activeId; if (isOutputPane(id) && tabId) results.setView(tabId, id) }
  // The tab's menu (Float or Dock, and Close) replaces Dockview's own, which shows only when it has items.
  const menuTarget = useMenuTarget<HTMLDivElement>(() => ({ kind: 'dockTab', pane: props.api.id as PaneId, floating: props.api.location.type === 'floating', popout: false }))
  const ref = useCallback((node: HTMLDivElement | null) => { element.current = node; menuTarget(node) }, [menuTarget])
  useEffect(() => { element.current?.querySelector('button')?.setAttribute('aria-label', 'Close ' + paneTitles[props.api.id as PaneId]) }, [props.api.id])
  return <div ref={ref} className="pane-tab" data-pane-tab={props.api.id} onClick={event => { if (!(event.target as HTMLElement).closest('button')) choose() }}><DockviewDefaultTab {...props}
    closeActionOverride={() => commands.close(props.api.id as PaneId)} title="Drag to dock; Ctrl-drag to float; Ctrl-double-click to toggle docking"
    onDoubleClick={event => { if (event.ctrlKey && !(event.target as HTMLElement).closest('button')) commands.toggle(props.api.id as PaneId) }} /></div>
}
function value<T>(result: { ok: true; value: T } | { ok: false; error: string }): T { if (!result.ok) throw new Error(result.error); return result.value }
const message = (error: unknown) => error instanceof Error ? error.message : 'The layout operation failed.'

export interface WorkspaceHandle {
  manage(mode?: 'save' | 'load'): void
  reset(): void
  /** Shows a pane, and with `focus` moves keyboard focus into it; `raise` (or `focus`) brings a popout window that holds it to the front. */
  reveal(id: PaneId, options?: { focus?: boolean; raise?: boolean; raiseHidden?: boolean }): void
  /** Closes a panel as its × does, remembering where it was docked. */
  close(id: PaneId): void
  location(id: PaneId): PaneLocation
  float(id: PaneId): void
  /** Returns a floating panel to where it was docked. */
  dock(id: PaneId): void
  /** Moves a panel into a new OS window of its own (Move into New Window); the query editor stays in the main window. */
  moveToWindow(id: PaneId): void
  /** Docks a popped-out panel back in the main window, where it was before it popped out. */
  moveToMainWindow(id: PaneId): void
  /** Docks a panel at a side of the query editor (of Object Explorer, for the editor itself). */
  dockAt(id: PaneId, side: DockSide): void
  /** Moves a panel into another panel's group, as a tab beside it. */
  tabWith(id: PaneId, other: PaneId): void
  /**
   * Shows the query output: `view`'s panel if it is open, else an output panel already showing, else one open; with every
   * output panel closed, it reopens the ones Ctrl+R hid (all three, if it hid none).
   */
  revealOutput(view: OutputPaneId | undefined, options?: { focus?: boolean }): void
  /** SSMS's Ctrl+R: closes every open output panel while one shows, else reveals the output. */
  toggleOutput(view: OutputPaneId | undefined): 'hidden' | 'shown'
  /**
   * Writes the layout now. With `closing` it is the window's last write before it closes: popout windows that close after
   * it (a quit closes every window, in any order) leave the saved layout as it is, unless `closeCancelled` follows.
   */
  flush(closing?: boolean): Promise<void>
  /** The close that `flush(true)` prepared for did not happen: panels whose windows closed meanwhile dock back. */
  closeCancelled(): void
}

const DockWorkspace = forwardRef<WorkspaceHandle, Record<PaneId, ReactNode>>(function DockWorkspace(panes, ref) {
  const workbench = useWorkbench()
  const { theme, panes: shown, shellOptions } = workbench
  // Popout windows: a ref for the commands, state for rendering their frames.
  const popoutsRef = useRef<readonly PopoutRecord[]>([])
  const [popouts, setPopouts] = useState<readonly PopoutRecord[]>([])
  // The page is going: its popout windows go with it and their panels stay where the saved layout put them.
  const unloading = useRef(false)
  // The window's last layout write is done and it is closing: popouts closing now change nothing (`flush(true)`).
  const closing = useRef(false)
  const closedWhileClosing = useRef<PopoutPaneId[]>([])
  const themeType = useServiceSnapshot(theme).active.type
  const { panelTabs } = useServiceSnapshot(shellOptions)
  const panelTabsRef = useRef(panelTabs)
  panelTabsRef.current = panelTabs
  const [state, setState] = useState<LayoutState>(emptyLayoutState)
  const stateRef = useRef(state)
  const apiRef = useRef<DockviewApi | null>(null)
  const defaultRef = useRef<WorkspaceLayout | null>(null)
  const subscription = useRef<{ dispose(): void } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoring = useRef(false)
  const ready = useRef(false)
  const [restored, setRestored] = useState(false)
  // Panes asked for while the saved layout loads (a Window menu choice, the palette), shown once it has.
  const pendingReveals = useRef(new Map<PaneId, { focus?: boolean }>())
  // After a failed preferences load, writing would replace the unread file and its saved layouts.
  const persistBlocked = useRef(false)
  const lastPersisted = useRef('')
  const [error, setError] = useState('')
  const [showManager, setShowManager] = useState(false)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const [notice, setNotice] = useState('')
  const previousFocus = useRef<HTMLElement | null>(null)
  const dialog = useRef<HTMLElement | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const parking = useRef<HTMLDivElement>(null)
  const [paneHosts] = useState<PaneHosts>(() => ({ parking, hosts: Object.fromEntries(paneIds.map(id => [id, paneHost(id)])) as unknown as Record<PaneId, HTMLElement> }))
  const guides = useRef<DockingGuides | null>(null)
  // `index` is the tab's place in its group, for a panel closed beside others.
  const returnLocations = useRef<Partial<Record<PaneId, { reference?: PaneId; position: 'center' | 'left' | 'right' | 'top' | 'bottom'; index?: number; edge?: boolean; width: number; height: number }>>>({})
  // The output panels Ctrl+R last closed, and which of them showed in their groups, for the Ctrl+R that brings them back.
  const hiddenOutput = useRef<{ ids: OutputPaneId[]; shown: OutputPaneId[] } | null>(null)
  useLayoutEffect(() => { for (const host of Object.values(paneHosts.hosts)) if (!host.parentElement) parking.current?.append(host) }, [paneHosts])

  function rememberDock(id: PaneId) {
    const panel = apiRef.current?.getPanel(id)
    if (!panel || panel.api.location.type !== 'grid') return
    const box = panel.group.element.getBoundingClientRect(), sibling = panel.group.panels.find(item => item.id !== id)
    const reference = sibling ?? apiRef.current?.panels.filter(item => item.group !== panel.group && item.api.location.type === 'grid').sort((a, b) => {
      const score = (item: typeof a) => { const other = item.group.element.getBoundingClientRect()
        const horizontalOverlap = Math.max(0, Math.min(box.right, other.right) - Math.max(box.x, other.x))
        const verticalOverlap = Math.max(0, Math.min(box.bottom, other.bottom) - Math.max(box.y, other.y))
        const gap = Math.min(Math.abs(box.right - other.x), Math.abs(box.x - other.right), Math.abs(box.bottom - other.y), Math.abs(box.y - other.bottom))
        return gap * 1000 - Math.max(horizontalOverlap, verticalOverlap)
      }; return score(a) - score(b)
    })[0]
    const other = reference?.group.element.getBoundingClientRect()
    const position = sibling ? 'center' : other ? (box.right <= other.x + 2 ? 'left' : box.x >= other.right - 2 ? 'right' : box.bottom <= other.y + 2 ? 'top' : 'bottom') : 'right'
    const workspace = root.current!.getBoundingClientRect()
    const edge = position !== 'center' && (position === 'left' || position === 'right'
      ? Math.abs(box.y - workspace.y) < 2 && Math.abs(box.bottom - workspace.bottom) < 2
      : Math.abs(box.x - workspace.x) < 2 && Math.abs(box.right - workspace.right) < 2)
    returnLocations.current[id] = { reference: reference?.id as PaneId | undefined, position, ...sibling ? { index: panel.group.panels.indexOf(panel) } : {}, edge, width: box.width, height: box.height }
  }
  function close(id: PaneId) {
    if (recordOf(id)) { removeFromWindow(id); return }
    rememberDock(id); apiRef.current?.getPanel(id)?.api.close()
  }
  function location(id: PaneId): PaneLocation {
    if (recordOf(id)) return 'window'
    const panel = apiRef.current?.getPanel(id)
    return !panel ? 'closed' : panel.api.location.type === 'floating' ? 'floating' : 'grid'
  }

  // Popout windows (docs/popout-windows.md): each is the page's own same-origin about:blank child, so a panel's content
  // (its pane host, with the React tree portalled into it) moves there as it is, and back.
  const recordOf = (id: string) => popoutsRef.current.find(record => (record.panes as readonly string[]).includes(id))
  function setRecords(next: readonly PopoutRecord[]) {
    popoutsRef.current = next
    setPopouts(next)
    for (const record of next) record.title(windowTitle(record.active))
    if (apiRef.current && ready.current) publishVisibility(apiRef.current)
    changed()
  }
  function parkFrom(record: PopoutRecord, id: PaneId) {
    const host = paneHosts.hosts[id]
    if (record.root.contains(host) && parking.current) placeHost(host, parking.current)
  }
  function endWindow(record: PopoutRecord) {
    record.dispose()
    if (!record.window.closed) record.window.close()
  }
  /** Opens a popout window for `layout`; when main refuses it (off every display, too many) its panels dock back instead. */
  function openWindow(layout: PopoutLayout, restoring: boolean): boolean {
    const { x, y, width, height } = layout.bounds
    let child: Window | null = null
    // A fresh name each time, never the layout's id: a window that had it may still be closing, and window.open would
    // hand that window back instead of opening one.
    try { child = window.open('about:blank', 'varia-popout-' + crypto.randomUUID(), `left=${x},top=${y},width=${width},height=${height}`) } catch { child = null }
    let prepared: PopoutDocument | undefined, attached: { dispose(): void } | undefined
    try {
      if (!child) throw new Error('The window was refused.')
      prepared = preparePopoutDocument(child, document, windowTitle(layout.active))
      attached = workbench.attachWindow(child)
    } catch {
      prepared?.dispose(); attached?.dispose(); if (child && !child.closed) child.close()
      if (!restoring) setError('Could not open a new window for ' + layout.panes.map(id => paneTitles[id]).join(', ') + '. The panel stays in the main window.')
      for (const id of layout.panes) reveal(id)
      return false
    }
    const target = child, frame = prepared, listeners = attached
    const closed = () => windowClosed(layout.id), resized = () => changed()
    target.addEventListener('pagehide', closed)
    target.addEventListener('resize', resized)
    const record: PopoutRecord = { id: layout.id, panes: [...layout.panes], active: layout.active, bounds: layout.bounds, window: target, root: frame.root, title: frame.setTitle,
      dispose: () => { target.removeEventListener('pagehide', closed); target.removeEventListener('resize', resized); listeners.dispose(); frame.dispose() } }
    setRecords([...popoutsRef.current, record])
    return true
  }
  /** The user closed a popout window: its panels dock back where they were. */
  function windowClosed(id: string) {
    const record = popoutsRef.current.find(item => item.id === id)
    if (!record || unloading.current) return
    record.dispose()
    // Their content comes home before the window's document goes.
    for (const pane of record.panes) parkFrom(record, pane)
    if (closing.current) {
      // Closed by the quit after the last write: the saved layout keeps the window, and the panels wait to see if the close happens.
      popoutsRef.current = popoutsRef.current.filter(item => item !== record)
      setPopouts(popoutsRef.current)
      closedWhileClosing.current.push(...record.panes)
      return
    }
    setRecords(popoutsRef.current.filter(item => item !== record))
    for (const pane of record.panes) reveal(pane)
  }
  function closeCancelled() {
    closing.current = false
    const panes = closedWhileClosing.current
    closedWhileClosing.current = []
    for (const pane of panes) reveal(pane)
    if (apiRef.current && ready.current) publishVisibility(apiRef.current)
    changed()
  }
  /** Moves panels (the ones that can pop out) into a new window: where they were on screen, or at a screen point (a drag out). */
  function popOut(ids: readonly string[], at?: { x: number; y: number }): boolean {
    const api = apiRef.current
    if (!api || !ready.current || popoutsRef.current.length >= popoutLimits.maxWindows) return false
    const panes = ids.filter(canPopOut).filter(id => !recordOf(id) && api.getPanel(id))
    if (!panes.length) return false
    const first = api.getPanel(panes[0])!, box = first.group.element.getBoundingClientRect(), shownId = first.group.activePanel?.id
    const bounds = { x: clampCoordinate(at ? at.x - 80 : window.screenX + box.x), y: clampCoordinate(at ? at.y - 16 : window.screenY + box.y),
      width: clampSize(box.width, popoutLimits.minWidth), height: clampSize(box.height, popoutLimits.minHeight) }
    const active = panes.find(id => id === shownId) ?? panes[0]
    for (const id of panes) { rememberDock(id); api.getPanel(id)?.api.close() }
    return openWindow({ id: crypto.randomUUID(), panes, active, bounds }, false)
  }
  function moveToWindow(id: PaneId) { popOut([id]) }
  /** Takes a panel out of its window (closing the window when it was the last), its content back in the main window. */
  function removeFromWindow(id: PaneId) {
    const record = recordOf(id)
    if (!record) return
    parkFrom(record, id)
    const panes = record.panes.filter(pane => pane !== id)
    if (!panes.length) { endWindow(record); setRecords(popoutsRef.current.filter(item => item !== record)); return }
    setRecords(popoutsRef.current.map(item => item === record ? { ...record, panes, active: panes.includes(record.active) ? record.active : panes[0] } : item))
  }
  /** Docks a popped-out panel back: where it was, or where a popout tab was dropped on the main window. */
  function moveToMainWindow(id: PaneId, drop?: { group?: DockviewGroupPanel; position: Position }) {
    if (!recordOf(id)) return
    removeFromWindow(id)
    reveal(id)
    const api = apiRef.current, panel = api?.getPanel(id)
    if (!drop || !api || !panel) return
    try {
      if (drop.group) { if (drop.group !== panel.group || drop.position !== 'center') panel.api.moveTo({ group: drop.group, position: drop.position }) }
      else {
        const group = api.addGroup({ direction: drop.position === 'top' ? 'above' : drop.position === 'bottom' ? 'below' : drop.position === 'center' ? 'right' : drop.position })
        panel.api.moveTo({ group, position: 'center' })
      }
    } catch (error) { setError(message(error)) }
  }
  function selectInWindow(windowId: string, pane: PopoutPaneId) {
    if (popoutsRef.current.some(record => record.id === windowId && record.active !== pane && record.panes.includes(pane)))
      setRecords(popoutsRef.current.map(record => record.id === windowId ? { ...record, active: pane } : record))
  }
  /** Makes the open popout windows those of a layout being applied: the same windows stay, others close or open. */
  function syncWindows(target: readonly PopoutLayout[]) {
    const kept = popoutsRef.current.filter(record => target.some(item => item.id === record.id && item.panes.join() === record.panes.join()))
    for (const record of popoutsRef.current) if (!kept.includes(record)) { for (const pane of record.panes) parkFrom(record, pane); endWindow(record) }
    setRecords(kept.map(record => ({ ...record, active: target.find(item => item.id === record.id)!.active })))
    for (const item of target) if (!kept.some(record => record.id === item.id)) openWindow(item, true)
  }
  /** Where a popout window is now (its content size), for the saved layout. */
  function windowBounds(record: PopoutRecord): PopoutLayout['bounds'] {
    const view = record.window
    if (view.closed) return record.bounds
    return { x: clampCoordinate(view.screenX), y: clampCoordinate(view.screenY), width: clampSize(view.innerWidth, popoutLimits.minWidth), height: clampSize(view.innerHeight, popoutLimits.minHeight) }
  }

  function dock(id: PaneId) { if (location(id) === 'floating') toggle(id) }
  function dockAt(id: PaneId, side: DockSide) {
    if (recordOf(id)) moveToMainWindow(id)
    const api = apiRef.current, panel = api?.getPanel(id)
    if (!api || !panel) return
    const reference = dockReference(id, api.panels.map(item => ({ id: item.id, location: item.api.location.type, panel: item })))?.panel
    if (reference) { panel.api.moveTo({ group: reference.group, position: side }); return }
    // Nothing else is docked: a group of its own at the grid's edge, leaving any panels it floated with behind.
    const group = api.addGroup({ direction: side === 'top' ? 'above' : side === 'bottom' ? 'below' : side })
    panel.api.moveTo({ group, position: 'center' })
  }
  function tabWith(id: PaneId, other: PaneId) {
    if (recordOf(other)) return
    if (recordOf(id)) moveToMainWindow(id)
    const panel = apiRef.current?.getPanel(id), target = apiRef.current?.getPanel(other)
    if (!panel || !target || id === other) return
    // An output panel goes among the group's output panels in their order, Results, Messages, Execution plan; others go last.
    const index = isOutputPane(id) ? outputIndex(id, target.group.panels.map(item => item.id).filter(item => item !== id)) : undefined
    panel.api.moveTo({ group: target.group, position: 'center', ...index !== undefined ? { index } : {} })
  }
  /** Hides the header of each docked group that holds one panel, unless Window › Panel Tabs shows them; the panel's own header has its ⋯ menu. */
  function syncHeaders(api: DockviewApi) {
    for (const group of api.groups) {
      const hidden = hidesHeader({ location: group.api.location.type, panels: group.panels.map(panel => panel.id) }, panelTabsRef.current)
      // Dockview caches the header's height for the content below it; relayout measures it again at once rather than a frame later.
      if (group.header.hidden !== hidden) { group.header.hidden = hidden; group.relayout() }
    }
  }
  function float(id: PaneId) { if (recordOf(id)) moveToMainWindow(id); rememberDock(id); const panel = apiRef.current?.getPanel(id); if (panel) apiRef.current!.addFloatingGroup(panel, { width: 520, height: 360, x: 60, y: 60 }) }
  function toggle(id: PaneId) {
    if (recordOf(id)) { moveToMainWindow(id); return }
    const panel = apiRef.current?.getPanel(id)
    if (!panel) { reveal(id); return }
    if (panel.api.location.type === 'grid') { float(id); return }
    const previous = returnLocations.current[id], reference = previous?.reference && apiRef.current?.getPanel(previous.reference)
    if (previous?.edge) {
      const group = apiRef.current!.addGroup({ direction: previous.position === 'top' ? 'above' : previous.position === 'bottom' ? 'below' : previous.position === 'center' ? 'right' : previous.position })
      panel.api.moveTo({ group, position: 'center' })
    } else if (reference?.api.location.type === 'grid') panel.api.moveTo({ group: reference.group, position: previous!.position, ...previous!.position === 'center' && previous!.index !== undefined ? { index: Math.min(previous!.index, reference.group.panels.length) } : {} })
    else panel.group.api.moveTo({ position: id === 'explorer' ? 'left' : isOutputPane(id) ? 'bottom' : 'right' })
    if (previous && previous.position !== 'center') panel.api.setSize({ width: previous.width, height: previous.height })
  }
  function reveal(id: PaneId, options?: { focus?: boolean; raise?: boolean; raiseHidden?: boolean }) {
    const api = apiRef.current
    // In a popout window its tab is selected; the window comes to the front only when asked, since a query's output
    // showing must not take focus from the editor.
    const record = recordOf(id)
    if (record) {
      selectInWindow(record.id, id as PopoutPaneId)
      if (options?.focus || options?.raise || (options?.raiseHidden && record.window.document.visibilityState === 'hidden')) record.window.focus()
      if (options?.focus) focusPane(id)
      return
    }
    if (!api || !ready.current) {
      const focus = pendingReveals.current.get(id)?.focus || options?.focus
      pendingReveals.current.set(id, focus ? { focus } : {})
      return
    }
    let panel = api.getPanel(id)
    if (!panel) {
      const previous = returnLocations.current[id], preferred = previous?.reference && api.getPanel(previous.reference)
      const explorer = api.getPanel('explorer')
      const fillEditor = id === 'editor' && !previous && explorer?.api.location.type === 'grid' && Math.abs(explorer.group.api.width - api.width) < 2
      // An output panel with nowhere to return to joins an open output panel docked in the grid, as a tab.
      const outputPeer = !preferred && isOutputPane(id) ? outputPaneIds.map(other => api.getPanel(other)).find(other => other?.api.location.type === 'grid') : undefined
      const reference = preferred || outputPeer || api.getPanel('editor') || api.panels.find(item => item.api.location.type === 'grid')
      const direction = outputPeer || previous?.position === 'center' ? 'within' as const : previous?.position === 'top' ? 'above' as const : previous?.position === 'bottom' ? 'below' as const
        : previous?.position ?? (id === 'explorer' ? 'left' as const : isOutputPane(id) ? 'below' as const : 'right' as const)
      // Within a group, back at its tab's place, or among output panels at its place in Results, Messages, Execution plan.
      const index = !reference || direction !== 'within' ? undefined : previous?.index !== undefined ? Math.min(previous.index, reference.group.panels.length)
        : outputPeer && isOutputPane(id) ? outputIndex(id, reference.group.panels.map(item => item.id)) : undefined
      const position = reference ? { referencePanel: reference.id, direction, ...index !== undefined ? { index } : {} } : undefined
      panel = api.addPanel({ id, title: paneTitles[id], component: 'workbench', renderer: 'always', minimumWidth: id === 'editor' ? 320 : 200, minimumHeight: id === 'editor' ? 180 : 100,
        initialWidth: previous?.width ?? (id === 'explorer' ? 278 : undefined), initialHeight: previous?.height ?? (isOutputPane(id) ? 240 : undefined), position })
      if (previous?.edge) panel.group.api.moveTo({ position: previous.position })
      if (fillEditor) explorer?.api.setSize({ width: 278 })
    }
    // Only change what differs, so revealing an already-active panel does not rewrite the layout file.
    if (!panel.group.api.isVisible) panel.group.api.setVisible(true)
    if (api.hasMaximizedGroup()) api.exitMaximizedGroup()
    if (!panel.api.isActive) panel.api.setActive()
    if (options?.focus) focusPane(id)
  }
  /** Moves focus into a pane unless it is already there: to its `data-pane-focus` element (the selected one first), else its first control. */
  function focusPane(id: PaneId) {
    const host = paneHosts.hosts[id]
    // In the window the pane is in now.
    const attempt = () => {
      if (host.contains(host.ownerDocument.activeElement)) return true
      const target = host.querySelector<HTMLElement>('[data-pane-focus="selected"]') ?? host.querySelector<HTMLElement>('[data-pane-focus]') ?? host.querySelector<HTMLElement>(focusableSelector)
      target?.focus()
      return host.contains(host.ownerDocument.activeElement)
    }
    // A panel that was closed mounts its content on a later frame.
    if (!attempt()) requestAnimationFrame(() => { attempt() })
  }
  /** Showing as `publishVisibility` means it: its tab selected in a visible group, not behind another maximized group. */
  function showing(api: DockviewApi, id: PaneId) {
    const record = recordOf(id)
    if (record) return record.active === id
    const panel = api.getPanel(id)
    return !!panel && panel.group.activePanel?.id === id && panel.group.api.isVisible && (!api.hasMaximizedGroup() || panel.group.api.isMaximized())
  }
  function revealOutput(view: OutputPaneId | undefined, options?: { focus?: boolean }) {
    const api = apiRef.current
    if (!api || !ready.current) { reveal(view ?? 'results', options); return }
    if (view && location(view) !== 'closed') { reveal(view, options); return }
    const open = outputPaneIds.filter(id => location(id) !== 'closed')
    const target = open.find(id => showing(api, id)) ?? open[0]
    if (target) { hiddenOutput.current = null; reveal(target, options); return }
    const hidden = hiddenOutput.current
    hiddenOutput.current = null
    // Reopened in the reverse of the order they closed in, so each returns beside the one it was closed beside.
    for (const id of [...hidden?.ids ?? outputPaneIds].reverse()) reveal(id)
    for (const id of hidden?.shown ?? []) selectOutput(id)
    const shown = view && api.getPanel(view) ? view : (hidden?.shown[0] ?? 'results')
    if (api.getPanel(shown)) reveal(shown, options)
  }
  function toggleOutput(view: OutputPaneId | undefined): 'hidden' | 'shown' {
    const api = apiRef.current
    // Panels in popout windows stay: Ctrl+R hides and shows the main window's output panels.
    if (!api || !outputPaneIds.some(id => showing(api, id) && !recordOf(id))) { revealOutput(view); return 'shown' }
    const ids = outputPaneIds.filter(id => api.getPanel(id)), shown = ids.filter(id => api.getPanel(id)!.group.activePanel?.id === id)
    for (const id of ids) close(id)
    hiddenOutput.current = { ids, shown }
    return 'hidden'
  }
  /** Shows an output panel's tab in its group when the group shows another output panel, without activating the group. */
  function selectOutput(id: OutputPaneId) {
    const record = recordOf(id)
    if (record) { if (isOutputPane(record.active)) selectInWindow(record.id, id); return }
    const panel = apiRef.current?.getPanel(id), current = panel?.group.activePanel
    if (!panel || !current || current.id === id || !isOutputPane(current.id)) return
    panel.group.model.openPanel(panel, { skipSetGroupActive: true })
    publishVisibility(apiRef.current!)
    changed()
  }

  function cancelTimer() { if (timer.current) clearTimeout(timer.current); timer.current = null }
  function snapshot() {
    const popped = popoutsRef.current.map(record => ({ id: record.id, panes: [...record.panes], active: record.active, bounds: windowBounds(record) }))
    return withoutHeaderState(parseWorkspaceLayout({ ...apiRef.current!.toJSON(), ...popped.length ? { windows: popped } : {} }))
  }
  function update(next: LayoutState) { stateRef.current = next; setState(next) }
  async function persist(next = stateRef.current) {
    cancelTimer()
    if (persistBlocked.current) throw new Error('Workspace preferences could not be loaded, so layouts cannot be saved in this session.')
    const text = JSON.stringify(next)
    if (text === lastPersisted.current) return
    value(await window.varia.saveLayouts(next))
    lastPersisted.current = text
    setError('')
  }
  async function flush() {
    if (!ready.current || persistBlocked.current) return
    const next = { ...stateRef.current, current: snapshot() }
    update(next)
    await persist(next)
  }
  function changed() {
    if (restoring.current || !ready.current || closing.current) return
    cancelTimer()
    timer.current = setTimeout(() => {
      void flush().catch(error => setError('Could not remember workspace layout: ' + message(error)))
    }, 250)
  }
  function apply(layout: WorkspaceLayout) {
    const api = apiRef.current!
    const validated = parseWorkspaceLayout(layout)
    const previous = snapshot()
    const width = api.width, height = api.height
    restoring.current = true
    try {
      // Reuse live panels so layout changes never recreate Monaco or lose its undo history.
      api.fromJSON(validated, { reuseExistingPanels: true })
      syncHeaders(api)
      api.layout(width, height)
    } catch (error) {
      api.fromJSON(previous, { reuseExistingPanels: true })
      throw error
    } finally { restoring.current = false }
    syncWindows(validated.windows ?? [])
    changed()
  }
  function manage(mode: 'save' | 'load' = 'load') {
    previousFocus.current = focusToReturn()
    setName(mode === 'save' ? '' : stateRef.current.saved[0]?.name ?? '')
    setSelected(stateRef.current.saved[0]?.id ?? '')
    setDialogError(''); setNotice(''); setShowManager(true)
  }
  useImperativeHandle(ref, () => ({ manage, flush: async closingNow => { if (closingNow) { cancelTimer(); closing.current = true } await flush() }, closeCancelled, reset: () => {
    if (!defaultRef.current) return
    try { apply(defaultRef.current) } catch (error) { setError(message(error)) }
  }, reveal, close, location, float, dock, moveToWindow, moveToMainWindow: id => moveToMainWindow(id), dockAt, tabWith, revealOutput, toggleOutput }))
  /** Showing: open, its tab selected in a visible group, and not behind another maximized group. */
  function publishVisibility(api: DockviewApi) {
    const where = (id: PaneId): PaneLocation => location(id)
    // A popout window's own tabs switch its panels, so an output panel there lists only itself.
    const peers = (id: OutputPaneId) => recordOf(id) ? [id] : api.getPanel(id)?.group.panels.map(panel => panel.id).filter(isOutputPane) ?? []
    const each = <T,>(value: (id: PaneId) => T) => Object.fromEntries(paneIds.map(id => [id, value(id)])) as Record<PaneId, T>
    shown.set(each(id => showing(api, id)), each(where), { results: peers('results'), messages: peers('messages'), plan: peers('plan') })
  }
  useEffect(() => {
    const selector = shown.bindSelector(selectOutput)
    return () => { selector.dispose(); cancelTimer(); subscription.current?.dispose(); guides.current?.dispose(); ready.current = false; apiRef.current = null }
  }, [])
  useEffect(() => {
    unloading.current = false
    const unload = () => { unloading.current = true }
    window.addEventListener('pagehide', unload)
    return () => {
      window.removeEventListener('pagehide', unload)
      unloading.current = true
      for (const record of popoutsRef.current) endWindow(record)
      popoutsRef.current = []
    }
  }, [])
  // While popouts are open, one timer notices a window torn down without its pagehide (by the OS, or a crash) and a window
  // moved, which no DOM event reports; a moved window's place is saved as a resize's is.
  const anyPopout = popouts.length > 0
  useEffect(() => {
    if (!anyPopout) return
    const places = new Map<PopoutRecord, string>()
    const poll = setInterval(() => {
      let moved = false
      for (const record of popoutsRef.current) {
        if (record.window.closed) { windowClosed(record.id); continue }
        const place = record.window.screenX + ',' + record.window.screenY
        if (places.has(record) && places.get(record) !== place) moved = true
        places.set(record, place)
      }
      if (moved) changed()
    }, 1000)
    // Dialogs open in the main window: one opened from a popout brings the main window to the front, or the popout would
    // look frozen behind it while the dialog holds the keyboard.
    const raise = watchModals(document, () => { if (windows.active() !== window) window.focus() })
    return () => { clearInterval(poll); raise.dispose() }
  }, [anyPopout])
  useEffect(() => { if (apiRef.current) syncHeaders(apiRef.current) }, [panelTabs])
  useEffect(() => {
    if (!showManager) return
    return () => returnFocusTo(previousFocus.current)
  }, [showManager])

  function onReady(event: DockviewReadyEvent) {
    const api = event.api
    apiRef.current = api
    ready.current = false
    subscription.current?.dispose()
    guides.current?.dispose()
    void (async () => {
      let loaded: LayoutLoad = { state: emptyLayoutState() }
      try { loaded = value(await window.varia.loadLayouts()) }
      catch (error) {
        persistBlocked.current = true
        setError('Could not load workspace preferences: ' + message(error) + ' Layout changes will not be remembered in this session.')
      }
      if (apiRef.current !== api) return
      api.addPanel({ id: 'editor', title: paneTitles.editor, component: 'workbench', renderer: 'always', minimumWidth: 320, minimumHeight: 180 })
      api.addPanel({ id: 'explorer', title: paneTitles.explorer, component: 'workbench', renderer: 'always', minimumWidth: 200, minimumHeight: 100, initialWidth: 278, position: { referencePanel: 'editor', direction: 'left' } })
      // The output panels share one group below the editor, Results selected; their toolbar tabs between them.
      api.addPanel({ id: 'results', title: paneTitles.results, component: 'workbench', renderer: 'always', minimumWidth: 200, minimumHeight: 100, initialHeight: Math.max(180, Math.round(api.height * .34)), position: { referencePanel: 'editor', direction: 'below' } })
      for (const id of ['messages', 'plan'] as const) api.addPanel({ id, title: paneTitles[id], component: 'workbench', renderer: 'always', minimumWidth: 200, minimumHeight: 100, inactive: true, position: { referencePanel: 'results', direction: 'within' } })
      api.getPanel('results')!.api.setActive()
      api.getPanel('editor')!.api.setActive()
      defaultRef.current = snapshot()
      update(loaded.state)
      if (!persistBlocked.current) lastPersisted.current = JSON.stringify(loaded.state)
      // A saved layout that cannot be applied leaves the default arrangement; the workspace stays usable.
      if (loaded.state.current) { try { apply(loaded.state.current) } catch (error) { setError('Could not restore the saved workspace layout: ' + message(error)) } }
      if (loaded.warning) setError(loaded.warning)
      ready.current = true
      const layout = api.onDidLayoutChange(() => { syncHeaders(api); changed(); publishVisibility(api) }), maximized = api.onDidMaximizedGroupChange(() => publishVisibility(api))
      const panels = [api.onDidAddPanel(() => syncHeaders(api)), api.onDidRemovePanel(() => syncHeaders(api)), api.onDidAddGroup(() => syncHeaders(api))]
      subscription.current = { dispose: () => { layout.dispose(); maximized.dispose(); panels.forEach(item => item.dispose()) } }
      syncHeaders(api)
      publishVisibility(api)
      guides.current = new DockingGuides(api, root.current!, ids => ids.forEach(id => rememberDock(id as PaneId)), error => setError(message(error)), (ids, at) => popOut(ids, at))
      api.updateOptions({ dropPositionResolver: guides.current })
      // A popout window's tab dragged onto the workbench docks there (the compass shows where), or where it was.
      const workbenchRoot = root.current!
      const carried = (event: DragEvent) => { const pane = paneDrag.carried(event.dataTransfer); return pane && recordOf(pane) ? pane : undefined }
      const over = (event: DragEvent) => {
        const pane = carried(event)
        if (!pane) return
        event.preventDefault(); event.stopPropagation()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        guides.current?.dragOver([pane], event.clientX, event.clientY)
      }
      const leave = (event: DragEvent) => {
        const box = workbenchRoot.getBoundingClientRect()
        if (event.clientX <= box.left || event.clientY <= box.top || event.clientX >= box.right || event.clientY >= box.bottom) guides.current?.dragLeave()
      }
      const drop = (event: DragEvent) => {
        const pane = carried(event)
        if (!pane) return
        event.preventDefault(); event.stopPropagation()
        paneDrag.end()
        moveToMainWindow(pane, guides.current?.dragDrop(event.clientX, event.clientY))
        window.focus()
      }
      workbenchRoot.addEventListener('dragover', over, true)
      workbenchRoot.addEventListener('dragleave', leave, true)
      workbenchRoot.addEventListener('drop', drop, true)
      const dragDispose = { dispose: () => { workbenchRoot.removeEventListener('dragover', over, true); workbenchRoot.removeEventListener('dragleave', leave, true); workbenchRoot.removeEventListener('drop', drop, true) } }
      const previous = subscription.current
      subscription.current = { dispose: () => { previous?.dispose(); dragDispose.dispose() } }
      setRestored(true)
      const pending = [...pendingReveals.current]
      pendingReveals.current.clear()
      for (const [id, options] of pending) reveal(id, options)
    })()
  }

  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setDialogError(''); setNotice('')
    try { await work() } catch (error) { setDialogError(message(error)) } finally { setBusy(false) }
  }
  // Pane commands only read refs, so stable identities keep dockview from re-applying options on every render.
  const paneCommands = useMemo<PaneCommands>(() => ({ close, float, toggle, reveal }), [])
  const popoutCommands = useMemo<PopoutCommands>(() => ({ select: selectInWindow, moveToMain: id => moveToMainWindow(id), close: id => close(id), dragEnded: () => guides.current?.dragLeave() }), [])
  return <>
    {error && <div className="global-error layout-error" role="alert"><span>{error}</span><button aria-label="Dismiss layout error" onClick={() => setError('')}><Icon name="close" /></button></div>}
    <PaneContext.Provider value={paneHosts}><PaneCommandContext.Provider value={paneCommands}><RestoredContext.Provider value={restored}>
      <div hidden ref={parking} />
      {paneIds.map(id => createPortal(panes[id], paneHosts.hosts[id], id))}
      <div className="workbench" ref={root}><DockviewReact className="dock-workbench" theme={dockThemes[themeType]} components={components} defaultTabComponent={PaneTab} watermarkComponent={EmptyWorkspace}
        defaultRenderer="always" floatingGroupBounds={floatingBounds} transformFloatingGroupDrag={keepTitlebar} floatingGroupDragHandle="titlebar"
        dndStrategy="pointer" proportionalLayout={false} onReady={onReady} /></div>
      {popouts.map(record => createPortal(<PopoutFrame view={record} hosts={paneHosts.hosts} parking={parking.current} commands={popoutCommands} />, record.root, record.id))}
    </RestoredContext.Provider></PaneCommandContext.Provider></PaneContext.Provider>
    {showManager && <div className="modal-backdrop" onKeyDown={event => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); setShowManager(false) }
      if (event.key === 'Tab') {
        const targets = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? [])
        const first = targets[0], last = targets.at(-1)
        if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus() }
      }
    }}>
      <section ref={dialog} className="layout-dialog" role="dialog" aria-modal="true" aria-labelledby="layout-title">
        <div className="dialog-heading"><h2 id="layout-title">Workspace layouts</h2><button aria-label="Close layout manager" disabled={busy} onClick={() => setShowManager(false)}><Icon name="close" /></button></div>
        <p className="field-note">Drag panel headers to dock or tab them together. Splitters and floating panels resize by dragging their edges. Your current layout is remembered automatically.</p>
        <label htmlFor="layout-name">Layout name</label>
        <div className="layout-row"><input id="layout-name" autoFocus maxLength={64} value={name} placeholder="e.g. Query analysis" disabled={busy} onChange={event => setName(event.target.value)} />
          <button className="primary" disabled={busy || !name.trim()} onClick={() => void action(async () => {
            const existing = stateRef.current.saved.find(saved => saved.name.toLowerCase() === name.trim().toLowerCase())
            if (!existing && stateRef.current.saved.length >= 20) throw new Error('Delete a saved layout first (maximum 20).')
            const saved = { id: existing?.id ?? crypto.randomUUID(), name: name.trim(), layout: snapshot() }
            const next = { ...stateRef.current, current: saved.layout, saved: [...stateRef.current.saved.filter(item => item.id !== saved.id), saved] }
            update(next); await persist(next); setSelected(saved.id); setNotice('Layout saved.')
          })}>Save layout</button></div>
        {state.saved.some(saved => saved.name.toLowerCase() === name.trim().toLowerCase()) && <p className="field-note">Saving replaces the layout with this name.</p>}
        <label htmlFor="saved-layout">Saved layouts</label>
        <div className="layout-row"><select id="saved-layout" value={selected} disabled={busy || !state.saved.length} onChange={event => { setSelected(event.target.value); setName(state.saved.find(saved => saved.id === event.target.value)?.name ?? '') }}>
          <option value="">Choose a layout</option>{state.saved.map(saved => <option key={saved.id} value={saved.id}>{saved.name}</option>)}</select>
          <button disabled={busy || !selected} onClick={() => void action(async () => { apply(stateRef.current.saved.find(saved => saved.id === selected)!.layout); await flush(); setNotice('Layout loaded.') })}>Load layout</button>
          <button disabled={busy || !selected} onClick={() => void action(async () => { const next = { ...stateRef.current, current: snapshot(), saved: stateRef.current.saved.filter(saved => saved.id !== selected) }; update(next); await persist(next); setSelected(''); setNotice('Saved layout deleted.') })}>Delete</button></div>
        <div className="layout-file-actions">
          <button disabled={busy} onClick={() => void action(async () => { const layout = value(await window.varia.importLayout()); if (layout) { apply(layout); await flush(); setNotice('Layout imported. Give it a name to keep a saved copy.') } })}>Import layout…</button>
          <button disabled={busy} onClick={() => void action(async () => { if (value(await window.varia.exportLayout(snapshot()))) setNotice('Current layout exported.') })}>Export current layout…</button>
          <button disabled={busy} onClick={() => void action(async () => { apply(defaultRef.current!); await flush(); setNotice('Default layout restored.') })}>Reset default layout</button>
        </div>
        {dialogError && <p className="connect-error" role="alert">{dialogError}</p>}
        {notice && <p className="layout-notice" role="status">{notice}</p>}
        <div className="dialog-actions"><button disabled={busy} onClick={() => setShowManager(false)}>Done</button></div>
      </section>
    </div>}
  </>
})
export default DockWorkspace
