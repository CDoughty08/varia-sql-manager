import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DockviewReact, themeDark, themeLight, type DockviewApi, type DockviewGroupPanel, type DockviewReadyEvent, type FloatingGroupDragContext, type IDockviewHeaderActionsProps, type IDockviewPanel, type IDockviewPanelHeaderProps, type IDockviewPanelProps, type IWatermarkPanelProps, type SerializedDockview } from 'dockview-react'
import { captureEditorGroups, editorGroupLimits, restoreEditorGroups, type EditorGroupsLayout } from '../../../shared/editor-groups'
import { environmentTag } from '../../../shared/environments'
import { isSsisDocumentKind } from '../../../shared/ssis/catalog.ts'
import type { ThemeType } from '../../../shared/theme/types'
import { useServiceSelector, useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import type { Workbench } from '../core/workbench'
import { focusWhenDrawn } from '../core/modal'
import { documentKind, isCustomKind, isQueryDocument, isTextDocument, kindInfo, type QueryTab } from '../documents'
import { DockingGuides } from '../docking-guides'
import { afterPointer } from './pointer'
import TabShelves from './TabShelves'
import { createQueryEditor, type QueryEditorInstance } from '../editor/create-editor'
import EnvironmentTag from '../EnvironmentTag'
import Icon from '../Icon'
import EmptyState from '../kit/EmptyState'
import { useMenuTarget } from '../menus/useMenuTarget'
import PaneMenuButton from '../PaneMenuButton'
import TabRenameBox from '../TabRenameBox'
import type { EditorGroupHost, EditorGroupInfo, EditorMove } from '../services/editor-groups'
import { liveQuerySession } from '../services/queries'
import TableDesigner from '../designer/TableDesigner'
import SsisProperties from '../ssis/SsisProperties'
import DatabaseProperties from '../properties/DatabaseProperties'
import NewDatabase from '../new-database/NewDatabase'
import RestoreDatabase from '../restore/RestoreDatabase'
import ActivityMonitor from '../activity/ActivityMonitor'
import SsisOperations from '../ssis/SsisOperations'
import ObjectSearch from '../search/ObjectSearch'
import PeekTab from '../explorer/PeekTab'
import PlanDocument from '../plans/PlanDocument'

/**
 * The query editor panel's editor groups (docs/editor-groups.md): a Dockview of its own inside the workbench's editor
 * panel, one panel per open document. Each group has its own tab strip and one Monaco editor, which moves into whichever
 * text document the group shows; DocumentService keeps the documents and their models. Tabs drag along a strip, into
 * another group, onto a group's side to split it (the compass shows where), or Shift-drag to float over the editor area.
 */

/** One editor group's Monaco editor and the element it lives in, which moves into the text document the group shows. */
interface GroupEditor { readonly element: HTMLDivElement; readonly editor: QueryEditorInstance; shows: string; dispose(): void }
interface Area {
  /** Shows document `id` in group `group`'s editor, in `slot`. */
  mount(group: string, slot: HTMLElement, id: string): void
  /** `slot` no longer shows group `group`'s editor (its document is hidden, or moved). */
  unmount(group: string, slot: HTMLElement): void
}
const AreaContext = createContext<Area | null>(null)
const RestoredContext = createContext(false)

const panelOptions = (id: string, title: string) => ({ id, contentComponent: 'document', tabComponent: 'document', title, renderer: 'onlyWhenVisible' as const })
const addOptions = (id: string, title: string) => ({ id, component: 'document', tabComponent: 'document', title, renderer: 'onlyWhenVisible' as const })
// As the workbench's floating panels: a floating group may hang past the editor area's edges, keeping its titlebar to grab.
const floatingBounds = { minimumWidthWithinViewport: 120, minimumHeightWithinViewport: 60 }
const keepTitlebar = ({ proposed }: FloatingGroupDragContext) => ({ top: Math.max(0, proposed.top), left: proposed.left })
const areaThemes = {
  dark: { ...themeDark, name: 'varia-dark-groups', className: 'dockview-theme-dark varia-dock editor-groups' },
  light: { ...themeLight, name: 'varia-light-groups', className: 'dockview-theme-light varia-dock editor-groups' }
} satisfies Record<ThemeType, typeof themeDark>

/** A tab's tooltip: its file's path (or the name it would have, when renamed), its state, and where a reopened query was. */
export function tabTooltip(tab: QueryTab): string {
  const what = tab.file?.path ?? tab.baseName ?? tab.name
  return `${what}${tab.file?.readOnly ? ' (read-only)' : ''}${tab.dirty ? ' (unsaved changes)' : ''}${tab.lastServer ? `
Last connected to ${tab.lastServer}` : ''}`
}

/** The groups in order, the grid's then the floating ones, from Dockview's layout. */
export function groupsOf(json: SerializedDockview): EditorGroupInfo[] {
  const groups: EditorGroupInfo[] = []
  type Node = SerializedDockview['grid']['root']
  const leaf = (data: { id: string; views: string[]; activeView?: string }, floating: boolean) => { groups.push({ id: data.id, documents: [...data.views], ...data.activeView ? { active: data.activeView } : {}, floating }) }
  const walk = (node: Node, floating: boolean) => { if (node.type === 'leaf') leaf(node.data as { id: string; views: string[]; activeView?: string }, floating); else (node.data as Node[]).forEach(child => walk(child, floating)) }
  walk(json.grid.root, false)
  for (const item of json.floatingGroups ?? []) {
    const value = item as { data?: { id: string; views: string[]; activeView?: string }; grid?: SerializedDockview['grid'] }
    if (value.data) leaf(value.data, true)
    else if (value.grid) walk(value.grid.root, true)
  }
  return groups
}

/** Each panel's own document: a text document shows its group's editor; any other kind renders its own view. */
function DocumentPanel({ api }: IDockviewPanelProps) {
  const area = useContext(AreaContext)!
  const { documents } = useWorkbench()
  const kind = useServiceSelector(documents, snapshot => documentKind(snapshot.documents.find(document => document.id === api.id)))
  // Dockview keeps a panel's React tree while its tab is hidden; only the documents a group shows render, as the single
  // editor's workbench rendered only the active one.
  const [visible, setVisible] = useState(api.isVisible)
  const [group, setGroup] = useState(api.group.id)
  const [planSource, setPlanSource] = useState(false)
  const slot = useRef<HTMLDivElement>(null)
  const custom = isCustomKind(kind)
  const text = useRef(!custom)
  text.current = !custom
  useEffect(() => {
    // The group's editor moves in as the tab is chosen, not after React renders: a command that activates a document
    // and then uses its editor (Next Bookmark, Go to Query) finds it showing that document.
    const visibility = api.onDidVisibilityChange(event => {
      const element = slot.current
      if (text.current && element) { if (event.isVisible) area.mount(api.group.id, element, api.id); else area.unmount(api.group.id, element) }
      setVisible(event.isVisible)
    })
    const moved = api.onDidGroupChange(() => setGroup(api.group.id))
    setVisible(api.isVisible); setGroup(api.group.id)
    return () => { visibility.dispose(); moved.dispose() }
  }, [api, area])
  useLayoutEffect(() => {
    const element = slot.current
    if (!visible || custom || !element) return
    area.mount(group, element, api.id)
    return () => area.unmount(group, element)
  }, [area, api.id, group, visible, custom])
  // A text document keeps its (empty) slot while hidden, so the editor can move in the moment its tab is chosen.
  if (!custom) {
    const plan = kind === 'sqlplan'
    const editor = <div className="editor-container" ref={slot} hidden={plan && !planSource} />
    return plan ? <div className="document-view">
      {visible && <PlanDocument documentId={api.id} source={planSource} onSource={setPlanSource} />}
      {editor}
    </div> : editor
  }
  if (!visible) return null
  const id = api.id
  return <div className="document-view">
    {kind === 'tableDesigner' && <TableDesigner documentId={id} />}
    {kind === 'databaseProperties' && <DatabaseProperties documentId={id} />}
    {kind === 'newDatabase' && <NewDatabase documentId={id} />}
    {isSsisDocumentKind(kind) && <SsisProperties documentId={id} />}
    {kind === 'activityMonitor' && <ActivityMonitor documentId={id} />}
    {kind === 'objectSearch' && <ObjectSearch documentId={id} />}
    {kind === 'peek' && <PeekTab documentId={id} />}
    {kind === 'ssisOperations' && <SsisOperations documentId={id} />}
    {kind === 'restoreDatabase' && <RestoreDatabase documentId={id} />}
  </div>
}

/** A document's tab: its kind, name, environment, read-only, running and unsaved marks, and Close; double-click renames it. */
function DocumentTab({ api }: IDockviewPanelHeaderProps) {
  const workbench = useWorkbench(), id = api.id
  const tab = useServiceSelector(workbench.documents, snapshot => snapshot.documents.find(document => document.id === id))
  const busy = useServiceSelector(workbench.documents, snapshot => snapshot.busy)
  const query = useServiceSelector(workbench.queries, snapshot => snapshot[id]), running = !!query?.running
  const renaming = useServiceSelector(workbench.tabRename, snapshot => snapshot.id === id)
  const connections = useServiceSnapshot(workbench.connections)
  // Re-renders when the theme changes, which the accent relies on.
  useServiceSnapshot(workbench.theme)
  const connection = connections.find(value => value.id === tab?.connectionId), environment = connection?.options.environment
  const element = useRef<HTMLDivElement | null>(null)
  // Selected in its group: the group shows it.
  const [selected, setSelected] = useState(api.isVisible)
  useEffect(() => { setSelected(api.isVisible); const visibility = api.onDidVisibilityChange(event => setSelected(event.isVisible)); return () => visibility.dispose() }, [api])
  const menuTarget = useMenuTarget<HTMLDivElement>(() => workbench.documents.get(id) ? { kind: 'documentTab', tabId: id, floating: api.location.type === 'floating' } : null)
  const ref = useCallback((node: HTMLDivElement | null) => { element.current = node; menuTarget(node) }, [menuTarget])
  // Dockview's tab element is the tab (role, name, selection, roving focus): F2 renames while it has focus, and screen
  // readers hear its environment.
  // A query's live SQL session shows after its name, and screen readers hear it with the tab's environment and pin.
  const spid = tab && isQueryDocument(tab) ? liveQuerySession(query, connection)?.spid : undefined
  const session = spid === undefined ? 'No live SQL session' : `SQL session ID ${spid}`
  const description = [environmentTag(environment)?.description, tab?.pinned && 'Pinned', spid !== undefined && session].filter(Boolean).join('. ') || undefined
  const tooltip = tab ? tabTooltip(tab) : ''
  useEffect(() => {
    const host = element.current?.closest<HTMLElement>('.dv-tab')
    if (!host) return
    host.dataset.documentTab = ''
    host.title = tooltip
    if (description) host.setAttribute('aria-description', description)
    else host.removeAttribute('aria-description')
  }, [description, tooltip])
  const name = tab?.name
  // The SID chip stays on whole pixels as its text changes. Shelf columns already keep tab origins on whole pixels.
  const sidText = tab && isQueryDocument(tab) ? String(spid ?? '') : undefined
  useLayoutEffect(() => {
    const boxes = [...element.current?.querySelectorAll<HTMLElement>('.tab-sid') ?? []], strip = element.current?.closest('[role="tablist"]')
    if (!boxes.length) return
    const snap = () => {
      for (const box of boxes) {
        if (!box.getClientRects().length) continue
        const text = document.createRange(), style = getComputedStyle(box)
        text.selectNodeContents(box)
        const width = text.getBoundingClientRect().width
        if (width > 0) box.style.width = `${Math.ceil(width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) - 0.01)}px`
      }
    }
    snap()
    let current = true
    void document.fonts?.ready.then(() => { if (current) snap() })
    const shown = typeof ResizeObserver === 'function' && strip ? new ResizeObserver(snap) : undefined
    if (strip) shown?.observe(strip)
    return () => { current = false; shown?.disconnect() }
  }, [name, sidText, renaming])
  // The close button and the rename box take the pointer for themselves: Dockview would otherwise choose the tab, or
  // start dragging it, on the press.
  useEffect(() => {
    const node = element.current
    if (!node) return
    const own = (event: PointerEvent) => { if (event.target instanceof Element && event.target.closest('.tab-close, .tab-pin, .tab-rename')) event.stopPropagation() }
    node.addEventListener('pointerdown', own)
    return () => node.removeEventListener('pointerdown', own)
  }, [])
  if (!tab) return null
  const kind = kindInfo[documentKind(tab)], pin = `${tab.pinned ? 'Unpin' : 'Pin'} ${tab.name}`
  const sid = isQueryDocument(tab) && <span className="tab-sid" title={session} aria-hidden="true">{spid === undefined ? '—' : `SID ${spid}`}</span>
  return <div className={selected ? 'query-tab active' : 'query-tab'} ref={ref} data-tab-id={id} data-dirty={tab.dirty || undefined} data-pinned={tab.pinned || undefined} style={{ borderTopColor: workbench.theme.accent(connection?.color) }}
    onDoubleClick={event => { if (workbench.gestures.matches('documentTabs.rename', event) && !(event.target as Element).closest('.tab-close, .tab-pin')) workbench.tabRename.start(id) }}>
    {renaming ? <div className="tab-select tab-renaming"><Icon name={kind.icon} className="tab-icon" label={kind.label} /><TabRenameBox tabId={id} name={tab.name} service={workbench.tabRename} />{sid}</div>
      : <div className="tab-select"><Icon name={kind.icon} className="tab-icon" label={kind.label} /><span className="tab-name">{tab.name}</span><EnvironmentTag environment={environment} place="tab" />{tab.file?.readOnly && <Icon name="lock" className="tab-readonly" label="Read-only" />}{running && <Icon name="loading" spin className="tab-running" label="Executing" />}{sid}{tab.dirty && <span className="dirty-dot" role="img" aria-label="Unsaved changes" />}</div>}
    {/* Pinned tabs come first in their group (EditorAreaController.keepPinsFirst); focus stays on the tab as it moves. */}
    {isTextDocument(tab) && <button type="button" className="tab-pin" tabIndex={-1} aria-label={pin} title={pin} disabled={busy || workbench.documents.isFilling(id)}
      onClick={() => { if (workbench.documents.setPinned(id, !tab.pinned)) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.editor-groups .dv-tab [data-tab-id="${CSS.escape(id)}"]`)?.closest<HTMLElement>('.dv-tab')?.focus()) }}>
      <Icon name={tab.pinned ? 'pinned' : 'pin'} />
    </button>}
    <button type="button" className="tab-close" tabIndex={-1} aria-label={`Close ${tab.name}`} title={running ? `Close ${tab.name} (its query is executing)` : `Close ${tab.name}`} disabled={busy}
      onClick={() => void workbench.commands.execute('file.close', { tabId: id }, 'toolbar')}><Icon name="close" /></button>
  </div>
}

/** The editor panel's ⋯ menu, in the group whose header is at the editor area's top right. */
function GroupActions({ group, containerApi }: IDockviewHeaderActionsProps) {
  const [corner, setCorner] = useState(false)
  useEffect(() => {
    const check = () => {
      const root = group.element.closest('.editor-groups-root')?.getBoundingClientRect(), box = group.element.getBoundingClientRect()
      setCorner(!!root && group.api.location.type === 'grid' && Math.abs(box.top - root.top) < 2 && Math.abs(box.right - root.right) < 2)
    }
    check()
    const layout = containerApi.onDidLayoutChange(check), location = group.api.onDidLocationChange(check)
    return () => { layout.dispose(); location.dispose() }
  }, [group, containerApi])
  return <><TabShelves group={group} />{corner && <div className="editor-group-actions"><PaneMenuButton pane="editor" /></div>}</>
}

function EmptyEditor({ group }: IWatermarkPanelProps) {
  const { commands, documents } = useWorkbench(), restored = useContext(RestoredContext)
  const open = useServiceSelector(documents, snapshot => snapshot.documents.length > 0)
  if (!restored) return null
  const newQuery = { label: 'New query', run: () => void commands.execute('file.new', undefined, 'toolbar') }
  // With no group there is no header: the editor panel's ⋯ menu stays at the top right; an empty group has its own. Dockview
  // floats a group's last tab (Shift-drag, a tab released outside the area); the grid then keeps an empty group (`keepGrid`),
  // which says the queries float.
  const state = open
    ? <EmptyState className="workspace-empty" icon="file-code" title="All open queries float" detail="Dock one to bring it back here, or drag its tab into this area."
      actions={[{ label: 'Dock query', run: () => void commands.execute('editor.dock', undefined, 'toolbar'), primary: true }, newQuery]} />
    : <EmptyState className="workspace-empty" icon="file-code" title="No open queries" actions={[{ ...newQuery, primary: true }, { label: 'Open SQL file', run: () => void commands.execute('file.open', undefined, 'toolbar') }]} />
  return <div className="editor-empty">{!group && <div className="editor-group-actions"><PaneMenuButton pane="editor" /></div>}{state}</div>
}

const components = { document: DocumentPanel }
const tabComponents = { document: DocumentTab }

/** The editor area. It stays mounted for the app's lifetime, as the single editor did, and owns its groups' editors. */
export default function EditorArea() {
  const workbench = useWorkbench()
  const themeType = useServiceSnapshot(workbench.theme).active.type
  const root = useRef<HTMLDivElement>(null)
  const [restored, setRestored] = useState(false)
  const [area] = useState(() => new EditorAreaController(workbench))
  useEffect(() => () => area.dispose(), [area])
  const onReady = useCallback((event: DockviewReadyEvent) => { area.ready(event.api, root.current!); setRestored(true) }, [area])
  return <div className="editor-groups-root" ref={root}>
    <AreaContext.Provider value={area}><RestoredContext.Provider value={restored}>
      <DockviewReact className="editor-groups-dock" theme={areaThemes[themeType]} components={components} tabComponents={tabComponents} defaultTabComponent={DocumentTab}
        disableTabsOverflowList scrollbars="native"
        rightHeaderActionsComponent={GroupActions} watermarkComponent={EmptyEditor} defaultRenderer="onlyWhenVisible" floatingGroupBounds={floatingBounds}
        transformFloatingGroupDrag={keepTitlebar} floatingGroupDragHandle="titlebar" dndStrategy="pointer" onReady={onReady} />
    </RestoredContext.Provider></AreaContext.Provider>
  </div>
}

/** Dockview names each group's region after its shown panel; an editor group showing a custom document would then be a
 * second region named as that document's own frame (New Database), so editor groups are named "Editor group: …". */
const groupPrefix = 'Editor group: '
function nameGroupRegions(root: HTMLElement): { refresh(): void; dispose(): void } {
  // Only Dockview's groups: a document's own regions ("… sections", a chart's table) keep their names as their titles change.
  const name = (element: Element) => {
    const label = element.getAttribute('aria-label')
    if (element.classList.contains('dv-groupview') && element.getAttribute('role') === 'region' && label && !label.startsWith(groupPrefix)) element.setAttribute('aria-label', groupPrefix + label)
  }
  const refresh = () => root.querySelectorAll('.dv-groupview[role="region"]').forEach(name)
  refresh()
  // Dockview labels a group as its shown tab changes. A group that arrives already labelled (a floating group, groups a
  // restore rebuilds) is named by `refresh`, which the controller runs on every layout change: watching added nodes
  // would also watch every line Monaco draws.
  const observer = new MutationObserver(records => { for (const record of records) if (record.target instanceof Element) name(record.target) })
  observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['aria-label', 'role'] })
  return { refresh, dispose: () => observer.disconnect() }
}

/** Menus, the palette and dialogs come and go over the editor area: focus there says nothing about where the user is. */
const transientFocus = '.menu-layer, [role="dialog"], [role="alertdialog"]'
/** Reports whether each element that takes focus (transient layers aside) is inside the editor area. */
function followFocus(root: HTMLElement, report: (inside: boolean) => void): { dispose(): void } {
  const focused = (event: FocusEvent) => { const target = event.target; if (target instanceof Element && !target.closest(transientFocus)) report(root.contains(target)) }
  document.addEventListener('focusin', focused, true)
  return { dispose: () => document.removeEventListener('focusin', focused, true) }
}

/**
 * A tab that focus reaches from another tab of its strip shows its document, as the single strip's arrow keys did:
 * Dockview's roving focus (arrows, Home, End) then chooses tabs, and Close, Rename and Delete act on the focused tab,
 * which is the active one. Focus that comes from elsewhere (a closing menu restoring it) chooses nothing, and a press
 * chooses a tab only when Dockview says (the primary button): a right-click leaves the shown document as it is.
 */
function chooseFocusedTabs(root: HTMLElement, choose: (id: string) => void): { dispose(): void } {
  let pressed = false
  const press = () => { pressed = true }
  const release = () => { pressed = false }
  const focused = (event: FocusEvent) => {
    const target = event.target
    const from = event.relatedTarget instanceof Element ? event.relatedTarget.closest('.dv-tab') : null
    const roving = !pressed && target instanceof HTMLElement && target.classList.contains('dv-tab') && !!from && from !== target && from.parentElement === target.parentElement
    const id = roving ? target.querySelector('[data-tab-id]')?.getAttribute('data-tab-id') : undefined
    if (id) choose(id)
  }
  root.addEventListener('pointerdown', press, true)
  root.ownerDocument.addEventListener('pointerup', release, true)
  root.ownerDocument.addEventListener('pointercancel', release, true)
  root.ownerDocument.defaultView?.addEventListener('blur', release)
  root.addEventListener('focusin', focused)
  return { dispose: () => {
    root.removeEventListener('pointerdown', press, true)
    root.ownerDocument.removeEventListener('pointerup', release, true)
    root.ownerDocument.removeEventListener('pointercancel', release, true)
    root.ownerDocument.defaultView?.removeEventListener('blur', release)
    root.removeEventListener('focusin', focused)
  } }
}

/**
 * Keeps the editor area's Dockview and DocumentService in step: a document opened anywhere gets a panel in the active
 * group, a closed one loses its panel, and the active document is the active group's shown panel. Dockview's changes
 * (a tab chosen, dragged, split or floated) go back as the active document and the documents' order, group by group.
 */
class EditorAreaController implements Area, EditorGroupHost {
  private api?: DockviewApi
  private root?: HTMLElement
  private readonly editors = new Map<string, GroupEditor>()
  private readonly parking = document.createElement('div')
  private disposables: { dispose(): void }[] = []
  private reconciling = false
  private disposed = false
  /**
   * Whether the last element to take focus, menus, the palette and dialogs aside, was in the editor area. Focus on the
   * body then means the area lost it (a hidden panel took its element), not that the user went elsewhere (a toast closed).
   */
  private focusInArea = true
  private regions?: { refresh(): void }
  private keepingGrid = false
  private sortingPins = false
  private pointer?: ReturnType<typeof afterPointer>
  private status?: { editor: QueryEditorInstance['instance']; binding: { dispose(): void } }
  constructor(private readonly workbench: Workbench) {}

  ready(api: DockviewApi, root: HTMLElement): void {
    this.api = api
    this.root = root
    const { documents, editorGroups } = this.workbench
    const guides = new DockingGuides(api, root, () => {}, error => this.workbench.commands.reportError(error instanceof Error ? error.message : 'The editor could not move.'), this.workbench.gestures)
    api.updateOptions({ dropPositionResolver: guides })
    this.disposables.push(guides,
      api.onDidActivePanelChange(event => { if (!this.reconciling && event.panel && documents.getSnapshot().activeId !== event.panel.id) documents.activate(event.panel.id); this.followStatus() }),
      api.onDidLayoutChange(() => { this.keepGrid(); this.keepPinsFirst(); this.publish() }),
      api.onDidRemoveGroup(group => this.dropEditor(group.id)),
      // A group past the cap (a drop that would split once more) goes back: its documents join the active group.
      api.onDidAddGroup(group => { if (api.groups.length > editorGroupLimits.groups) queueMicrotask(() => this.mergeInto(group)) }),
      { dispose: documents.subscribe(() => this.reconcile()) },
      documents.useTextFocus(id => this.focusText(id)),
      editorGroups.attach(this),
      this.regions = nameGroupRegions(root),
      this.pointer = afterPointer(),
      followFocus(root, inside => { this.focusInArea = inside; if (!inside) documents.dropPendingFocus() }),
      chooseFocusedTabs(root, id => { if (documents.getSnapshot().activeId !== id) api.getPanel(id)?.api.setActive() }))
    this.reconcile()
    this.publish()
  }

  /** Brings the panels in line with the documents: names, new and closed documents, and the active one. */
  private reconcile(): void {
    const api = this.api
    if (!api || this.disposed || this.reconciling) return
    const { documents: list, activeId } = this.workbench.documents.getSnapshot()
    const open = new Set(list.map(document => document.id))
    // A tab closed while it had focus (Delete) hands focus to the tab that shows next, so the keyboard stays in the strip.
    const focusedTab = document.activeElement?.closest('.dv-tab')?.querySelector('[data-tab-id]')?.getAttribute('data-tab-id')
    const tabFocusLeaves = !!focusedTab && !open.has(focusedTab)
    this.reconciling = true
    try {
      for (const panel of [...api.panels]) if (!open.has(panel.id)) api.removePanel(panel)
      for (const document of list) {
        const panel = api.getPanel(document.id)
        if (!panel) this.add(document.id, document.name, document.id !== activeId)
        else if (panel.title !== document.name) panel.api.setTitle(document.name)
      }
    } finally { this.reconciling = false }
    this.keepPinsFirst()
    // The active document's panel becomes active: one chosen from a menu, Script As or Go to Query, and after a close the
    // next tab in the closed one's group, which DocumentService already made active (`EditorGroupService.successor`).
    if (activeId && api.activePanel?.id !== activeId) { this.reconciling = true; try { api.getPanel(activeId)?.api.setActive() } finally { this.reconciling = false } }
    if (tabFocusLeaves && activeId) this.root?.querySelector(`[data-tab-id="${CSS.escape(activeId)}"]`)?.closest<HTMLElement>('.dv-tab')?.focus()
    this.followStatus()
    this.publish()
  }
  private add(id: string, title: string, inactive: boolean): IDockviewPanel {
    const api = this.api!, group = api.activeGroup
    const panel = api.addPanel({ ...addOptions(id, title), ...group ? { position: { referenceGroup: group } } : {}, inactive })
    this.guard(panel)
    return panel
  }
  /**
   * Pinned tabs come first in each group, in their own order, as VS Code's do: a pin or unpin, a pinned tab opened or moved
   * into a group, and a drag past the pins all end with the pins first. Each group keeps the tab it shows, and the active
   * group stays the active one.
   */
  private keepPinsFirst(): void {
    const api = this.api
    if (!api || this.disposed || this.sortingPins) return
    const pinned = (panel: IDockviewPanel) => !!this.workbench.documents.get(panel.id)?.pinned
    const reconciling = this.reconciling
    this.sortingPins = this.reconciling = true
    try {
      for (const group of api.groups) {
        const order = [...group.panels.filter(pinned), ...group.panels.filter(panel => !pinned(panel))]
        if (order.every((panel, index) => group.panels[index] === panel)) continue
        const shown = group.activePanel
        order.forEach((panel, index) => { if (group.panels[index] !== panel) panel.api.moveTo({ group, position: 'center', index, skipSetActive: true }) })
        if (shown && group.activePanel !== shown) group.model.openPanel(shown, { skipSetGroupActive: true })
      }
    } finally { this.sortingPins = false; this.reconciling = reconciling }
  }
  /**
   * Dockview's own close goes through File › Close, which asks about unsaved changes. Its tab keys never reach it: Delete
   * and Backspace on a focused tab are File › Close's catalogue keys, which KeybindingService takes first.
   */
  private guard(panel: IDockviewPanel): void {
    const id = panel.id
    Object.defineProperty(panel.api, 'close', { configurable: true, value: () => { void this.workbench.commands.execute('file.close', { tabId: id }, 'keybinding') } })
  }
  /**
   * The grid keeps a group: when every document floats (Dockview floats a group's last tab), an empty one stays behind the
   * floating groups, whose watermark says they float; it goes once another grid group shows a document, or once no
   * document is left (the area's own empty state). With no room under the cap for it, a floating group docks instead.
   */
  private keepGrid(): void {
    const api = this.api
    if (!api || this.disposed || this.keepingGrid) return
    const grid = api.groups.filter(group => group.api.location.type === 'grid')
    this.keepingGrid = true
    try {
      if (!api.groups.some(group => group.panels.length)) for (const group of grid) api.removeGroup(group)
      else if (!grid.length) {
        const active = api.activeGroup ?? api.groups[0]
        if (api.groups.length >= editorGroupLimits.groups) {
          // A Shift-drag float is still following the pointer: the group docks once it lands, not under the drag.
          if (this.pointer?.held()) this.pointer.then(() => { this.keepGrid(); this.publish() })
          else {
            active.api.moveTo({ position: 'right' })
            this.workbench.commands.reportWarning(`The query editor shows at most ${editorGroupLimits.groups} editor groups.`)
          }
        } else {
          api.addGroup({ direction: 'right' })
          active.api.setActive()
        }
      } else if (grid.some(group => group.panels.length)) for (const group of grid) if (!group.panels.length) api.removeGroup(group)
    } finally { this.keepingGrid = false }
  }
  /** The groups for EditorGroupService, and the documents' order to match them. */
  private publish(): void {
    const api = this.api
    if (!api || this.disposed) return
    const groups = groupsOf(api.toJSON())
    this.regions?.refresh()
    // Each group's tab strip (Dockview's tablist) is named as the one strip was.
    for (const strip of this.root?.querySelectorAll('.dv-tabs-container:not([aria-label])') ?? []) strip.setAttribute('aria-label', 'Query documents')
    this.workbench.editorGroups.update({ groups, activeGroup: api.activeGroup?.id ?? '' })
    this.workbench.documents.reorder(groups.flatMap(group => group.documents))
  }
  /** The status bar's Ln and Col follow the active document's editor. */
  private followStatus(): void {
    const editor = this.workbench.documents.boundEditor
    if (this.status?.editor === editor) return
    this.status?.binding.dispose()
    this.status = editor ? { editor, binding: this.workbench.editorStatus.bindEditor(editor) } : undefined
  }

  mount(group: string, slot: HTMLElement, id: string): void {
    if (this.disposed) return
    let editor = this.editors.get(group)
    if (!editor) {
      const element = document.createElement('div')
      element.className = 'editor-host'
      slot.append(element)
      const created = createQueryEditor(this.workbench, element)
      // Clicking or tabbing into a group's editor makes its document the active one.
      const focus = created.instance.onDidFocusEditorWidget(() => {
        const shows = this.editors.get(group)?.shows
        if (shows && this.workbench.documents.getSnapshot().activeId !== shows) this.api?.getPanel(shows)?.api.setActive()
      })
      editor = { element, editor: created, shows: '', dispose: () => { focus.dispose(); this.workbench.documents.releaseEditor(created.instance); created.dispose(); element.remove() } }
      this.editors.set(group, editor)
    }
    // Another group's editor left in this slot (a restore rebuilds the groups around the same panels) goes.
    for (const [other, value] of this.editors) if (other !== group && value.element.parentElement === slot) this.dropEditor(other)
    // Moving the editor's element blurs it: it keeps the keyboard when it had it, or when nothing has it now and the editor
    // area had it last (a menu or the palette closed onto the old panel, which a new document hid), as the single editor
    // kept it across tab switches.
    const active = document.activeElement, keep = editor.element.contains(active) || ((!active || active === document.body) && this.focusInArea)
    if (editor.element.parentElement !== slot) slot.append(editor.element)
    editor.shows = id
    this.workbench.documents.showIn(editor.editor.instance, id)
    if (keep && this.workbench.documents.getSnapshot().activeId === id && !editor.editor.instance.hasWidgetFocus()) this.workbench.documents.focusActive()
    this.followStatus()
  }
  unmount(group: string, slot: HTMLElement): void {
    const editor = this.editors.get(group)
    if (editor && editor.element.parentElement === slot) this.parking.append(editor.element)
  }
  private dropEditor(group: string): void {
    const editor = this.editors.get(group)
    if (!editor) return
    this.editors.delete(group)
    if (this.status?.editor === editor.editor.instance) { this.status.binding.dispose(); this.status = undefined }
    editor.dispose()
    this.followStatus()
  }
  private mergeInto(group: DockviewGroupPanel): void {
    const api = this.api, target = api?.groups.find(item => item !== group && item.api.location.type === 'grid')
    if (!api || !target || !api.groups.includes(group)) return
    for (const panel of [...group.panels]) panel.api.moveTo({ group: target, position: 'center' })
    this.workbench.commands.reportWarning(`The query editor shows at most ${editorGroupLimits.groups} editor groups.`)
  }

  private groupById(id: string): DockviewGroupPanel | undefined { return this.api?.groups.find(group => group.id === id) }
  private focusText(id: string): boolean {
    const editor = this.workbench.documents.editorOf(id), element = editor?.getContainerDomNode()
    const graph = element?.closest('.document-view')?.querySelector<HTMLElement>('.plan-canvas')
    if (graph?.checkVisibility()) { graph.focus(); return true }
    if (!editor || !element?.checkVisibility()) return false
    editor.focus()
    return true
  }
  private focusLater(): void {
    const target = document.activeElement
    focusWhenDrawn(requestAnimationFrame, () => {
      const active = document.activeElement
      if (!active || active === document.body || active === target) this.workbench.documents.focusActive()
    })
  }
  // EditorGroupHost: the moves commands ask for.
  move(id: string, to: EditorMove): void {
    const api = this.api, panel = api?.getPanel(id)
    if (!api || !panel) return
    if ('group' in to) {
      const group = this.groupById(to.group)
      if (group) panel.api.moveTo({ group, position: 'center', ...to.index !== undefined ? { index: to.index } : {} })
    } else if ('split' in to) {
      const group = this.groupById(to.beside)
      if (group) panel.api.moveTo({ group, position: to.split === 'down' ? 'bottom' : to.split === 'up' ? 'top' : to.split })
    } else if ('float' in to) {
      const box = this.api!.width, height = this.api!.height
      api.addFloatingGroup(panel, { x: Math.max(0, Math.round(box / 2 - 260)), y: Math.max(0, Math.round(height / 2 - 180)), width: Math.min(520, box), height: Math.min(360, height) })
    } else {
      const grid = api.groups.find(group => group.api.location.type === 'grid' && group !== panel.group)
      if (grid) panel.api.moveTo({ group: grid, position: 'center' })
      else panel.group.api.moveTo({ position: 'right' })
    }
    // The moved document stays the one shown, in its new group, and keeps the keyboard, as VS Code's moves do.
    api.getPanel(id)?.api.setActive()
    this.publish()
    this.focusLater()
  }
  focusGroup(groupId: string): void {
    const group = this.groupById(groupId)
    if (!group) return
    group.api.setActive()
    const shown = group.activePanel
    if (shown) { shown.api.setActive(); this.focusLater() }
  }
  join(): void {
    const api = this.api
    if (!api) return
    const groups = groupsOf(api.toJSON()), first = this.groupById(groups[0]?.id ?? '')
    if (!first) return
    const active = api.activePanel?.id
    for (const info of groups.slice(1)) for (const id of info.documents) api.getPanel(id)?.api.moveTo({ group: first, position: 'center' })
    if (active) api.getPanel(active)?.api.setActive()
    this.publish()
    this.focusLater()
  }
  focusedDocument(): string | undefined {
    const tab = document.activeElement?.closest('.dv-tab')
    return tab && this.root?.contains(tab) ? tab.querySelector('[data-tab-id]')?.getAttribute('data-tab-id') ?? undefined : undefined
  }
  capture(place: (id: string) => number | undefined): EditorGroupsLayout | undefined {
    return this.api ? captureEditorGroups(this.api.toJSON(), place) : undefined
  }
  restore(layout: EditorGroupsLayout, id: (place: number) => string | undefined): void {
    const api = this.api
    if (!api) return
    const names = new Map(this.workbench.documents.getSnapshot().documents.map(document => [document.id, document.name]))
    const json = restoreEditorGroups(layout, place => { const value = id(place); return value && names.has(value) ? value : undefined }, panelId => panelOptions(panelId, names.get(panelId) ?? ''))
    if (!json) return
    this.reconciling = true
    try {
      // Live panels are reused, so their editors' models and undo stay; documents the layout leaves out come back below.
      api.fromJSON(json, { reuseExistingPanels: true })
      for (const panel of api.panels) this.guard(panel)
    } catch (error) {
      this.workbench.commands.reportWarning('The editor groups could not be restored: ' + (error instanceof Error ? error.message : 'the layout was refused.'))
    } finally { this.reconciling = false }
    for (const group of [...this.editors.keys()]) if (!this.groupById(group)) this.dropEditor(group)
    this.reconcile()
  }

  dispose(): void {
    this.disposed = true
    this.disposables.forEach(item => item.dispose())
    this.disposables = []
    this.status?.binding.dispose()
    for (const editor of this.editors.values()) editor.dispose()
    this.editors.clear()
    this.api = undefined
  }
}
