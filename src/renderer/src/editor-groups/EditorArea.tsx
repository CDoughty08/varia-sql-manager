import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DockviewReact, themeDark, themeLight, type DockviewApi, type DockviewGroupPanel, type DockviewReadyEvent, type FloatingGroupDragContext, type IDockviewHeaderActionsProps, type IDockviewPanel, type IDockviewPanelHeaderProps, type IDockviewPanelProps, type SerializedDockview } from 'dockview-react'
import { captureEditorGroups, editorGroupLimits, restoreEditorGroups, type EditorGroupsLayout } from '../../../shared/editor-groups'
import { environmentTag } from '../../../shared/environments'
import { isSsisDocumentKind } from '../../../shared/ssis/catalog.ts'
import type { ThemeType } from '../../../shared/theme/types'
import { useServiceSelector, useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import type { Workbench } from '../core/workbench'
import { documentKind, isCustomKind, kindInfo, type QueryTab } from '../documents'
import { DockingGuides } from '../docking-guides'
import { createQueryEditor, type QueryEditorInstance } from '../editor/create-editor'
import EnvironmentTag from '../EnvironmentTag'
import Icon from '../Icon'
import EmptyState from '../kit/EmptyState'
import { useMenuTarget } from '../menus/useMenuTarget'
import PaneMenuButton from '../PaneMenuButton'
import TabRenameBox from '../TabRenameBox'
import type { EditorGroupHost, EditorGroupInfo, EditorMove } from '../services/editor-groups'
import TableDesigner from '../designer/TableDesigner'
import SsisProperties from '../ssis/SsisProperties'
import DatabaseProperties from '../properties/DatabaseProperties'
import NewDatabase from '../new-database/NewDatabase'
import RestoreDatabase from '../restore/RestoreDatabase'
import ActivityMonitor from '../activity/ActivityMonitor'
import SsisOperations from '../ssis/SsisOperations'
import ObjectSearch from '../search/ObjectSearch'

/**
 * The query editor panel's editor groups (docs/editor-groups.md): a Dockview of its own inside the workbench's editor
 * panel, one panel per open document. Each group has its own tab strip and one Monaco editor, which moves into whichever
 * text document the group shows; DocumentService keeps the documents and their models. Tabs drag along a strip, into
 * another group, onto a group's side to split it (the compass shows where), or Ctrl-drag to float over the editor area.
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
  if (!custom) return <div className="editor-container" ref={slot} />
  if (!visible) return null
  const id = api.id
  return <div className="document-view">
    {kind === 'tableDesigner' && <TableDesigner documentId={id} />}
    {kind === 'databaseProperties' && <DatabaseProperties documentId={id} />}
    {kind === 'newDatabase' && <NewDatabase documentId={id} />}
    {isSsisDocumentKind(kind) && <SsisProperties documentId={id} />}
    {kind === 'activityMonitor' && <ActivityMonitor documentId={id} />}
    {kind === 'objectSearch' && <ObjectSearch documentId={id} />}
    {kind === 'ssisOperations' && <SsisOperations documentId={id} />}
    {kind === 'restoreDatabase' && <RestoreDatabase documentId={id} />}
  </div>
}

/** A document's tab: its kind, name, environment, read-only, running and unsaved marks, and Close; double-click renames it. */
function DocumentTab({ api }: IDockviewPanelHeaderProps) {
  const workbench = useWorkbench(), id = api.id
  const tab = useServiceSelector(workbench.documents, snapshot => snapshot.documents.find(document => document.id === id))
  const busy = useServiceSelector(workbench.documents, snapshot => snapshot.busy)
  const running = useServiceSelector(workbench.queries, snapshot => !!snapshot[id]?.running)
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
  const description = environmentTag(environment)?.description, tooltip = tab ? tabTooltip(tab) : ''
  useEffect(() => {
    const host = element.current?.closest<HTMLElement>('.dv-tab')
    if (!host) return
    host.dataset.documentTab = ''
    host.title = tooltip
    if (description) host.setAttribute('aria-description', description)
    else host.removeAttribute('aria-description')
  }, [description, tooltip])
  const name = tab?.name
  // A tab is as wide as its name, so every tab after the first would start on a fractional pixel and blur its kind icon.
  // The name's box is rounded up to whole pixels (the rest of a tab already is), measured from its text so the tab never
  // shrinks meanwhile; again once the fonts have loaded, and when its strip is laid out after being hidden.
  useLayoutEffect(() => {
    const label = element.current?.querySelector<HTMLElement>('.tab-name'), strip = element.current?.closest('[role="tablist"]')
    if (!label) return
    const snap = () => {
      if (!label.getClientRects().length) return
      const text = document.createRange()
      text.selectNodeContents(label)
      const width = text.getBoundingClientRect().width
      if (width > 0) label.style.width = `${Math.ceil(width - 0.01)}px`
    }
    snap()
    let current = true
    void document.fonts?.ready.then(() => { if (current) snap() })
    const shown = typeof ResizeObserver === 'function' && strip ? new ResizeObserver(snap) : undefined
    if (strip) shown?.observe(strip)
    return () => { current = false; shown?.disconnect() }
  }, [name])
  // The shown tab stays in view on a full strip. Dockview scrolls to a tab as it is chosen, which for a new document is
  // before React has drawn its name (and so its width); this scrolls again once it has, and when a rename widens it.
  useLayoutEffect(() => {
    const host = element.current?.closest<HTMLElement>('.dv-tab'), strip = host?.parentElement
    if (!selected || !host || !strip) return
    const start = host.offsetLeft, end = start + host.offsetWidth
    if (start < strip.scrollLeft) strip.scrollLeft = start
    else if (end > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = end - strip.clientWidth
  }, [selected, name])
  // The close button and the rename box take the pointer for themselves: Dockview would otherwise choose the tab, or
  // start dragging it, on the press.
  useEffect(() => {
    const node = element.current
    if (!node) return
    const own = (event: PointerEvent) => { if (event.target instanceof Element && event.target.closest('.tab-close, .tab-rename')) event.stopPropagation() }
    node.addEventListener('pointerdown', own)
    return () => node.removeEventListener('pointerdown', own)
  }, [])
  if (!tab) return null
  const kind = kindInfo[documentKind(tab)]
  return <div className={selected ? 'query-tab active' : 'query-tab'} ref={ref} data-tab-id={id} data-dirty={tab.dirty || undefined} style={{ borderTopColor: workbench.theme.accent(connection?.color) }}
    onDoubleClick={event => { if (!(event.target as Element).closest('.tab-close')) workbench.tabRename.start(id) }}>
    {renaming ? <div className="tab-select tab-renaming"><Icon name={kind.icon} className="tab-icon" label={kind.label} /><TabRenameBox tabId={id} name={tab.name} service={workbench.tabRename} /></div>
      : <div className="tab-select"><Icon name={kind.icon} className="tab-icon" label={kind.label} /><span className="tab-name">{tab.name}</span><EnvironmentTag environment={environment} place="tab" />{tab.file?.readOnly && <Icon name="lock" className="tab-readonly" label="Read-only" />}{running && <Icon name="loading" spin className="tab-running" label="Executing" />}{tab.dirty && <span className="dirty-dot" role="img" aria-label="Unsaved changes" />}</div>}
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
  return corner ? <div className="editor-group-actions"><PaneMenuButton pane="editor" /></div> : null
}

function EmptyEditor() {
  const { commands } = useWorkbench(), restored = useContext(RestoredContext)
  if (!restored) return null
  // With no group there is no header: the editor panel's ⋯ menu stays at the top right.
  return <div className="editor-empty"><div className="editor-group-actions"><PaneMenuButton pane="editor" /></div><EmptyState className="workspace-empty" icon="file-code" title="No open queries" actions={[{ label: 'New query', run: () => void commands.execute('file.new', undefined, 'toolbar'), primary: true }, { label: 'Open SQL file', run: () => void commands.execute('file.open', undefined, 'toolbar') }]} /></div>
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
        rightHeaderActionsComponent={GroupActions} watermarkComponent={EmptyEditor} defaultRenderer="onlyWhenVisible" floatingGroupBounds={floatingBounds}
        transformFloatingGroupDrag={keepTitlebar} floatingGroupDragHandle="titlebar" dndStrategy="pointer" onReady={onReady} />
    </RestoredContext.Provider></AreaContext.Provider>
  </div>
}

/** Dockview names each group's region after its shown panel; an editor group showing a custom document would then be a
 * second region named as that document's own frame (New Database), so editor groups are named "Editor group: …". */
const groupPrefix = 'Editor group: '
function nameGroupRegions(root: HTMLElement): { dispose(): void } {
  const name = (element: Element) => {
    const label = element.getAttribute('aria-label')
    if (element.getAttribute('role') === 'region' && label && !label.startsWith(groupPrefix)) element.setAttribute('aria-label', groupPrefix + label)
  }
  root.querySelectorAll('[role="region"]').forEach(name)
  const observer = new MutationObserver(records => { for (const record of records) if (record.target instanceof Element) name(record.target) })
  observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['aria-label', 'role'] })
  return { dispose: () => observer.disconnect() }
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
  private status?: { editor: QueryEditorInstance['instance']; binding: { dispose(): void } }
  constructor(private readonly workbench: Workbench) {}

  ready(api: DockviewApi, root: HTMLElement): void {
    this.api = api
    this.root = root
    const { documents, editorGroups } = this.workbench
    const guides = new DockingGuides(api, root, () => {}, error => this.workbench.commands.reportError(error instanceof Error ? error.message : 'The editor could not move.'))
    api.updateOptions({ dropPositionResolver: guides })
    this.disposables.push(guides,
      api.onDidActivePanelChange(event => { if (!this.reconciling && event.panel && documents.getSnapshot().activeId !== event.panel.id) documents.activate(event.panel.id); this.followStatus() }),
      api.onDidLayoutChange(() => this.publish()),
      api.onDidRemoveGroup(group => this.dropEditor(group.id)),
      // A group past the cap (a drop that would split once more) goes back: its documents join the active group.
      api.onDidAddGroup(group => { if (api.groups.length > editorGroupLimits.groups) queueMicrotask(() => this.mergeInto(group)) }),
      { dispose: documents.subscribe(() => this.reconcile()) },
      editorGroups.attach(this),
      nameGroupRegions(root))
    this.reconcile()
    this.publish()
  }

  /** Brings the panels in line with the documents: names, new and closed documents, and the active one. */
  private reconcile(): void {
    const api = this.api
    if (!api || this.disposed || this.reconciling) return
    const { documents: list, activeId } = this.workbench.documents.getSnapshot()
    const open = new Set(list.map(document => document.id))
    this.reconciling = true
    let closedActive = false
    try {
      for (const panel of [...api.panels]) if (!open.has(panel.id)) { closedActive ||= api.activePanel === panel; api.removePanel(panel) }
      for (const document of list) {
        const panel = api.getPanel(document.id)
        if (!panel) this.add(document.id, document.name, document.id !== activeId)
        else if (panel.title !== document.name) panel.api.setTitle(document.name)
      }
    } finally { this.reconciling = false }
    // Closing the active document shows the next one in its own group, as VS Code does; otherwise the active document's
    // panel becomes active (a document chosen from a menu, Script As, Go to Query).
    const shown = api.activePanel
    if (closedActive && shown && shown.id !== activeId) this.workbench.documents.activate(shown.id)
    else if (activeId && api.activePanel?.id !== activeId) { this.reconciling = true; try { api.getPanel(activeId)?.api.setActive() } finally { this.reconciling = false } }
    this.followStatus()
    this.publish()
  }
  private add(id: string, title: string, inactive: boolean): IDockviewPanel {
    const api = this.api!, group = api.activeGroup
    const panel = api.addPanel({ ...addOptions(id, title), ...group ? { position: { referenceGroup: group } } : {}, inactive })
    this.guard(panel)
    return panel
  }
  /** Dockview's own close (Delete on a focused tab) goes through File › Close, which asks about unsaved changes. */
  private guard(panel: IDockviewPanel): void {
    const id = panel.id
    Object.defineProperty(panel.api, 'close', { configurable: true, value: () => { void this.workbench.commands.execute('file.close', { tabId: id }, 'keybinding') } })
  }
  /** The groups for EditorGroupService, and the documents' order to match them. */
  private publish(): void {
    const api = this.api
    if (!api || this.disposed) return
    const groups = groupsOf(api.toJSON())
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
    // Moving the editor's element blurs it: it keeps the keyboard when it had it, or when nothing has it now (a menu or the
    // palette closed onto the old panel, which a new document hid), as the single editor kept it across tab switches.
    const active = document.activeElement, keep = editor.element.contains(active) || !active || active === document.body
    if (editor.element.parentElement !== slot) slot.append(editor.element)
    editor.shows = id
    this.workbench.documents.showIn(editor.editor.instance, id)
    if (keep && this.workbench.documents.getSnapshot().activeId === id && !editor.editor.instance.hasWidgetFocus()) editor.editor.instance.focus()
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
    requestAnimationFrame(() => this.workbench.documents.focusActive())
  }
  focusGroup(groupId: string): void {
    const group = this.groupById(groupId)
    if (!group) return
    group.api.setActive()
    const shown = group.activePanel
    if (shown) { shown.api.setActive(); requestAnimationFrame(() => this.workbench.documents.focusActive()) }
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
    requestAnimationFrame(() => this.workbench.documents.focusActive())
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
