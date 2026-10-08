import { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { DockviewDefaultTab, DockviewReact, themeDark, themeLight, type DockviewApi, type DockviewReadyEvent, type GetTabContextMenuItemsParams, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type IDockviewPanelProps } from 'dockview-react'
import { emptyLayoutState, paneIds, paneTitles, parseWorkspaceLayout, type LayoutLoad, type LayoutState, type PaneId, type WorkspaceLayout } from '../../shared/layouts'
import type { ThemeType } from '../../shared/theme/types'
import { DockingGuides } from './docking-guides'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'

interface PaneHosts { hosts: Record<PaneId, HTMLElement>; parking: RefObject<HTMLDivElement | null> }
interface PaneCommands { close(id: PaneId): void; float(id: PaneId): void; toggle(id: PaneId): void; reveal(id: PaneId): void }
const PaneContext = createContext<PaneHosts | null>(null)
const PaneCommandContext = createContext<PaneCommands | null>(null)
function Pane({ api }: IDockviewPanelProps) {
  const content = useContext(PaneContext)!, slot = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const host = content.hosts[api.id as PaneId]
    slot.current?.append(host)
    return () => { content.parking.current?.append(host) }
  }, [api.id, content])
  return <div className="dock-slot" ref={slot} />
}
const components = { workbench: Pane }
// Dockview splits className, so `varia-dock` lands on its shell next to the theme class (see styles.css).
const dockThemes = {
  dark: { ...themeDark, name: 'varia-dark', className: 'dockview-theme-dark varia-dock' },
  light: { ...themeLight, name: 'varia-light', className: 'dockview-theme-light varia-dock' }
} satisfies Record<ThemeType, typeof themeDark>
function paneHost(id: PaneId) { const host = document.createElement('div'); host.className = 'dock-pane'; host.dataset.pane = id; return host }
function EmptyWorkspace() {
  const commands = useContext(PaneCommandContext)!
  return <div className="dock-empty"><p>All panels are closed.</p><p>Open a panel from the Window menu.</p><button onClick={() => commands.reveal('editor')}>Open Query editor</button></div>
}
function PaneTab(props: IDockviewPanelHeaderProps) {
  const commands = useContext(PaneCommandContext)!, element = useRef<HTMLDivElement>(null)
  useEffect(() => { element.current?.querySelector('button')?.setAttribute('aria-label', 'Close ' + paneTitles[props.api.id as PaneId]) }, [props.api.id])
  return <div ref={element} className="pane-tab" data-pane-tab={props.api.id}><DockviewDefaultTab {...props}
    closeActionOverride={() => commands.close(props.api.id as PaneId)} title="Drag to dock; Ctrl-drag to float; Ctrl-double-click to toggle docking"
    onDoubleClick={event => { if (event.ctrlKey && !(event.target as HTMLElement).closest('button')) commands.toggle(props.api.id as PaneId) }} /></div>
}
function PaneActions({ activePanel, containerApi }: IDockviewHeaderActionsProps) {
  const commands = useContext(PaneCommandContext)!
  if (!activePanel) return null
  const available = paneIds.filter(id => id !== activePanel.id && containerApi.getPanel(id))
  return <select className="dock-move" aria-label={'Move ' + activePanel.title} value="" onChange={event => {
    const action = event.target.value
    const reference = containerApi.getPanel(activePanel.id === 'editor' ? 'explorer' : 'editor') ?? containerApi.getPanel(available[0])
    if (action === 'float') commands.float(activePanel.id as PaneId)
    else if (action === 'close') commands.close(activePanel.id as PaneId)
    else if (action.startsWith('tab:')) activePanel.api.moveTo({ group: containerApi.getPanel(action.slice(4))!.group, position: 'center' })
    else if (action && reference) activePanel.api.moveTo({ group: reference.group, position: action as 'left' | 'right' | 'top' | 'bottom' })
    else if (action) activePanel.group.api.moveTo({ position: action as 'left' | 'right' | 'top' | 'bottom' })
  }} title="Move or float this panel">
    <option value="">Move…</option>
    <option value="left">Dock left</option><option value="right">Dock right</option><option value="top">Dock top</option><option value="bottom">Dock bottom</option>
    {available.map(id => <option key={id} value={'tab:' + id}>Tab with {paneTitles[id]}</option>)}
    <option value="float">Float inside window</option>
    <option value="close">Close panel</option>
  </select>
}
function value<T>(result: { ok: true; value: T } | { ok: false; error: string }): T { if (!result.ok) throw new Error(result.error); return result.value }
const message = (error: unknown) => error instanceof Error ? error.message : 'The layout operation failed.'

export interface WorkspaceHandle {
  manage(mode?: 'save' | 'load'): void
  reset(): void
  reveal(id: PaneId): void
  flush(): Promise<void>
}

const DockWorkspace = forwardRef<WorkspaceHandle, Record<PaneId, ReactNode>>(function DockWorkspace(panes, ref) {
  const themeType = useServiceSnapshot(useWorkbench().theme).active.type
  const [state, setState] = useState<LayoutState>(emptyLayoutState)
  const stateRef = useRef(state)
  const apiRef = useRef<DockviewApi | null>(null)
  const defaultRef = useRef<WorkspaceLayout | null>(null)
  const subscription = useRef<{ dispose(): void } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoring = useRef(false)
  const ready = useRef(false)
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
  const [paneHosts] = useState<PaneHosts>(() => ({ parking, hosts: { explorer: paneHost('explorer'), editor: paneHost('editor'), output: paneHost('output') } }))
  const guides = useRef<DockingGuides | null>(null)
  const returnLocations = useRef<Partial<Record<PaneId, { reference?: PaneId; position: 'center' | 'left' | 'right' | 'top' | 'bottom'; edge?: boolean; width: number; height: number }>>>({})
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
    returnLocations.current[id] = { reference: reference?.id as PaneId | undefined, position, edge, width: box.width, height: box.height }
  }
  function close(id: PaneId) { rememberDock(id); apiRef.current?.getPanel(id)?.api.close() }
  function float(id: PaneId) { rememberDock(id); const panel = apiRef.current?.getPanel(id); if (panel) apiRef.current!.addFloatingGroup(panel, { width: 520, height: 360, x: 60, y: 60 }) }
  function toggle(id: PaneId) {
    const panel = apiRef.current?.getPanel(id)
    if (!panel) { reveal(id); return }
    if (panel.api.location.type === 'grid') { float(id); return }
    const previous = returnLocations.current[id], reference = previous?.reference && apiRef.current?.getPanel(previous.reference)
    if (previous?.edge) {
      const group = apiRef.current!.addGroup({ direction: previous.position === 'top' ? 'above' : previous.position === 'bottom' ? 'below' : previous.position === 'center' ? 'right' : previous.position })
      panel.api.moveTo({ group, position: 'center' })
    } else if (reference?.api.location.type === 'grid') panel.api.moveTo({ group: reference.group, position: previous!.position })
    else panel.group.api.moveTo({ position: id === 'explorer' ? 'left' : id === 'output' ? 'bottom' : 'right' })
    if (previous && previous.position !== 'center') panel.api.setSize({ width: previous.width, height: previous.height })
  }
  function reveal(id: PaneId) {
    const api = apiRef.current
    if (!api || !ready.current) return
    let panel = api.getPanel(id)
    if (!panel) {
      const previous = returnLocations.current[id], preferred = previous?.reference && api.getPanel(previous.reference)
      const explorer = api.getPanel('explorer')
      const fillEditor = id === 'editor' && !previous && explorer?.api.location.type === 'grid' && Math.abs(explorer.group.api.width - api.width) < 2
      const reference = preferred ?? api.getPanel('editor') ?? api.panels.find(item => item.api.location.type === 'grid')
      const position = reference ? { referencePanel: reference.id, direction: previous?.position === 'center' ? 'within' as const : previous?.position === 'top' ? 'above' as const : previous?.position === 'bottom' ? 'below' as const : previous?.position ?? (id === 'explorer' ? 'left' as const : id === 'output' ? 'below' as const : 'right' as const) } : undefined
      panel = api.addPanel({ id, title: paneTitles[id], component: 'workbench', renderer: 'always', minimumWidth: id === 'editor' ? 320 : 200, minimumHeight: id === 'editor' ? 180 : 100,
        initialWidth: previous?.width ?? (id === 'explorer' ? 278 : undefined), initialHeight: previous?.height ?? (id === 'output' ? 240 : undefined), position })
      if (previous?.edge) panel.group.api.moveTo({ position: previous.position })
      if (fillEditor) explorer?.api.setSize({ width: 278 })
    }
    // Only change what differs, so revealing an already-active panel does not rewrite the layout file.
    if (!panel.group.api.isVisible) panel.group.api.setVisible(true)
    if (api.hasMaximizedGroup()) api.exitMaximizedGroup()
    if (!panel.api.isActive) panel.api.setActive()
  }

  function cancelTimer() { if (timer.current) clearTimeout(timer.current); timer.current = null }
  function snapshot() { return parseWorkspaceLayout(apiRef.current!.toJSON()) }
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
    if (restoring.current || !ready.current) return
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
      api.layout(width, height)
    } catch (error) {
      api.fromJSON(previous, { reuseExistingPanels: true })
      throw error
    } finally { restoring.current = false }
    changed()
  }
  function manage(mode: 'save' | 'load' = 'load') {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setName(mode === 'save' ? '' : stateRef.current.saved[0]?.name ?? '')
    setSelected(stateRef.current.saved[0]?.id ?? '')
    setDialogError(''); setNotice(''); setShowManager(true)
  }
  useImperativeHandle(ref, () => ({ manage, flush, reset: () => {
    if (!defaultRef.current) return
    try { apply(defaultRef.current) } catch (error) { setError(message(error)) }
  }, reveal }))
  useEffect(() => () => { cancelTimer(); subscription.current?.dispose(); guides.current?.dispose(); ready.current = false; apiRef.current = null }, [])
  useEffect(() => {
    if (!showManager) return
    return () => { if (previousFocus.current?.isConnected) previousFocus.current.focus() }
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
      api.addPanel({ id: 'output', title: paneTitles.output, component: 'workbench', renderer: 'always', minimumWidth: 200, minimumHeight: 100, initialHeight: Math.max(180, Math.round(api.height * .34)), position: { referencePanel: 'editor', direction: 'below' } })
      api.getPanel('editor')!.api.setActive()
      defaultRef.current = snapshot()
      update(loaded.state)
      if (!persistBlocked.current) lastPersisted.current = JSON.stringify(loaded.state)
      // A saved layout that cannot be applied leaves the default arrangement; the workspace stays usable.
      if (loaded.state.current) { try { apply(loaded.state.current) } catch (error) { setError('Could not restore the saved workspace layout: ' + message(error)) } }
      if (loaded.warning) setError(loaded.warning)
      ready.current = true
      subscription.current = api.onDidLayoutChange(changed)
      guides.current = new DockingGuides(api, root.current!, ids => ids.forEach(id => rememberDock(id as PaneId)), error => setError(message(error)))
      api.updateOptions({ dropPositionResolver: guides.current })
    })()
  }

  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setDialogError(''); setNotice('')
    try { await work() } catch (error) { setDialogError(message(error)) } finally { setBusy(false) }
  }
  // Pane commands only read refs, so stable identities keep dockview from re-applying options on every render.
  const paneCommands = useMemo<PaneCommands>(() => ({ close, float, toggle, reveal }), [])
  const tabContextMenu = useCallback(({ panel }: GetTabContextMenuItemsParams) => [
    { label: panel.api.location.type === 'grid' ? 'Float' : 'Dock', action: () => toggle(panel.id as PaneId) },
    { label: 'Close panel', action: () => close(panel.id as PaneId) }
  ], [])
  return <>
    {error && <div className="global-error layout-error" role="alert"><span>{error}</span><button aria-label="Dismiss layout error" onClick={() => setError('')}>×</button></div>}
    <PaneContext.Provider value={paneHosts}><PaneCommandContext.Provider value={paneCommands}>
      <div hidden ref={parking} />
      {paneIds.map(id => createPortal(panes[id], paneHosts.hosts[id], id))}
      <div className="workbench" ref={root}><DockviewReact className="dock-workbench" theme={dockThemes[themeType]} components={components} defaultTabComponent={PaneTab} watermarkComponent={EmptyWorkspace}
        rightHeaderActionsComponent={PaneActions} defaultRenderer="always" floatingGroupBounds="boundedWithinViewport" floatingGroupDragHandle="titlebar"
        dndStrategy="pointer" proportionalLayout={false} getTabContextMenuItems={tabContextMenu} onReady={onReady} /></div>
    </PaneCommandContext.Provider></PaneContext.Provider>
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
        <div className="dialog-heading"><h2 id="layout-title">Workspace layouts</h2><button aria-label="Close layout manager" disabled={busy} onClick={() => setShowManager(false)}>×</button></div>
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
