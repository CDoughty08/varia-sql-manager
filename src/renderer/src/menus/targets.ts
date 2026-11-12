import type { ContextKeys, TargetKeys } from '../../../shared/commands/context-keys'
import type { ContextMenuId } from '../../../shared/commands/menus'
import { folderSpecs, nodeStatuses } from '../../../shared/explorer/catalog.ts'
import type { ExplorerTarget } from '../../../shared/explorer/refs.ts'
import { isPeekKind } from '../../../shared/explorer/peek.ts'
import { searchHitNames, type ObjectSearchHit } from '../../../shared/explorer/search.ts'
import type { PaneId } from '../../../shared/layouts'
import { onUnexpectedError } from '../core/errors'
import type { CommandArgs } from '../core/types'
import { gridAnchor, gridTarget } from '../grid/anchor'

/**
 * The Object Explorer node a context menu is for, captured when it opened: what the node is (`ExplorerTarget`: its status,
 * a database's runtime state and its server's engine among it), its node id in `ExplorerService`, whether it is a server
 * whose connection was lost with its backend generation, whether it is a folder with a filter, and whether it is a folder
 * with names to copy (a fully loaded Columns folder).
 */
export interface ExplorerMenuNode extends ObjectMenuNode { readonly id: number; readonly filtered?: boolean; readonly insertable?: boolean }
/** An object a menu is for, with or without a tree row: whether its server's connection was lost with its backend generation. */
export interface ObjectMenuNode extends ExplorerTarget { readonly lost: boolean }
/**
 * A Search Objects result, captured when its menu opened: the search and the hit's index in its result, the hit, whether it is
 * Object Explorer's own search (`pane`), the object as a menu node, and the selection keys it stands in for the tree's
 * (`selectionContextOf`), so Object Explorer's commands in its menu follow the result's kind, not the tree's selection.
 */
export interface SearchHitTarget {
  readonly kind: 'searchHit'
  readonly searchId: string
  readonly index: number
  readonly hit: ObjectSearchHit
  readonly pane: boolean
  readonly node: ObjectMenuNode
  readonly state: Partial<ContextKeys>
}
/** A text field's state when its menu opened: what Cut, Copy, Paste, Delete, Select All, Undo, and Redo can do. */
export interface InputTarget {
  readonly kind: 'input'
  readonly element: HTMLElement
  readonly readOnly: boolean
  readonly secret: boolean
  readonly hasSelection: boolean
  readonly empty: boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
}
export type OutputView = 'grid' | 'messages' | 'live'
/**
 * A Query Output view: the query's results grid for one result set (its cell selection lives in the grid's view state,
 * `ResultsService`), or Messages with the text selected in them when the menu opened. A live view's grid (an Activity
 * Monitor pane) is the same results grid with a live source: view `live`, whose commands act through `live`.
 */
export interface OutputTarget {
  readonly kind: 'output'
  readonly tabId: string
  readonly view: OutputView
  /** The grid's result, by its entry key (ResultsService): a `grid` view always has one, Messages and a live grid none. */
  readonly entry?: string
  /** The header or cell column captured when the menu opened (zero-based, without the row-number column). */
  readonly column?: number
  /** The cell's or row number's row captured with it (zero-based, a row of the result as the grid shows it now). */
  readonly row?: number
  /** Refuses commands after the entry came to show another stored result than the one the menu opened on. */
  readonly result?: { readonly generation: number; readonly resultId: number }
  /** The grid's result kind ('rows', 'diff', 'pivot', 'transpose'…), for the commands only some kinds offer. */
  readonly resultKind?: string
  readonly selectedText: string
  readonly element: HTMLElement
  /** A live grid's own commands (view `live`): its table is not a result set in ResultsService. */
  readonly live?: LiveOutput
}
/** What Query Output's commands do in a live grid (LiveGridPane): its selection, sort, funnels, widths and copy. */
export interface LiveOutput {
  /** Its table sorts (a snapshot table, not a log that keeps arrival order). */
  readonly sortable: boolean
  /** Its source filters some columns by value (header funnels), so the Filter items show. */
  readonly filterable: boolean
  /** The grid has rows and columns to select, copy and save. */
  hasRows(): boolean
  /** Cells are selected. */
  hasSelection(): boolean
  activeColumn(): number | undefined
  columnName(column: number): string | undefined
  /** Whether a column sorts (never the tone column) or has a funnel (its source filters it). */
  canSort(column: number): boolean
  canFilter(column: number): boolean
  sorted(): boolean
  filtered(): boolean
  copy(headers: boolean): void
  selectAll(): void
  /** Sorts by the column, alone or (`add`) as a further key. */
  sort(column: number, descending: boolean, add: boolean): void
  clearSort(): void
  fitColumn(column: number): void
  filterColumn(column: number): void
  clearFilters(): void
  save(): void
  /** Find in Results: the owner's filter box, when it has one. */
  canFind(): boolean
  find(): void
}
const liveOutputs = new WeakMap<Element, LiveOutput>()
/** A live grid's element (marked `data-output-view="live"`) and its commands, until the returned function runs. */
export function registerLiveOutput(element: Element, live: LiveOutput): () => void {
  liveOutputs.set(element, live)
  return () => { if (liveOutputs.get(element) === live) liveOutputs.delete(element) }
}
/** What a context menu was opened for. Renderer objects only: commands receive it as `CommandArgs.target`, and it never crosses IPC. */
export type MenuTarget =
  | { readonly kind: 'editor'; readonly tabId: string }
  /** Without a node, the empty area below the servers. */
  | { readonly kind: 'explorer'; readonly node?: ExplorerMenuNode }
  /** `floating` when the tab is in a floating editor group. */
  | { readonly kind: 'documentTab'; readonly tabId: string; readonly floating?: boolean }
  /** A table designer's grid; its commands act on the designer's selected columns. */
  | { readonly kind: 'tableDesigner'; readonly tabId: string }
  /** An Integration Services Operations grid; its commands act on the selected operation. */
  | { readonly kind: 'ssisOperations'; readonly tabId: string }
  | OutputTarget
  /** A panel's tab or ⋯ button; `popout` when the panel is in a window of its own. */
  | { readonly kind: 'dockTab'; readonly pane: PaneId; readonly floating: boolean; readonly popout: boolean }
  | SearchHitTarget
  | InputTarget

export const menuForTarget: Readonly<Record<MenuTarget['kind'], ContextMenuId>> = {
  editor: 'editor.context', explorer: 'explorer.context', tableDesigner: 'tableDesigner.context', documentTab: 'documentTab.context', output: 'output.context', dockTab: 'dockTab.context', input: 'input.context',
  ssisOperations: 'ssis.operation.context', searchHit: 'search.hit.context'
}
/** Each context menu's accessible name. */
export const contextMenuLabels: Readonly<Record<ContextMenuId, string>> = {
  'editor.context': 'Query editor', 'explorer.context': 'Object Explorer', 'tableDesigner.context': 'Table Designer', 'documentTab.context': 'Query tab', 'output.context': 'Query output',
  'dockTab.context': 'Panel tab', 'input.context': 'Text field', 'ssis.operation.context': 'Integration Services Operations',
  'search.hit.context': 'Search result'
}

/** A folder whose objects Filter Settings can narrow (Tables, Views, Databases, Logins…). */
export const filterable = (node: Pick<ExplorerTarget, 'folder'> | undefined): boolean => !!node?.folder && !!folderSpecs[node.folder].filter?.length
/** The target keys placement `when` clauses read; each describes one kind of target and is '' or false for the others. */
export function targetKeys(target: MenuTarget | undefined): TargetKeys {
  return {
    explorerNode: target?.kind === 'explorer' ? target.node?.kind ?? 'background' : '',
    explorerServerLost: target?.kind === 'explorer' && !!target.node?.lost,
    explorerFolder: target?.kind === 'explorer' && target.node?.kind === 'folder' ? target.node.folder ?? '' : '',
    explorerFolderFilterable: target?.kind === 'explorer' && filterable(target.node),
    explorerFolderFiltered: target?.kind === 'explorer' && !!target.node?.filtered,
    explorerFolderInsertable: target?.kind === 'explorer' && target.node?.kind === 'folder' && !!target.node.insertable,
    explorerNodePeekable: target?.kind === 'explorer' && !!target.node && target.node.kind !== 'folder' && isPeekKind(target.node.kind),
    explorerNodeStatus: target?.kind === 'explorer' && target.node?.status && (nodeStatuses as readonly string[]).includes(target.node.status) ? target.node.status : '',
    explorerServerEngine: target?.kind === 'explorer' ? target.node?.engine ?? '' : '',
    explorerServerLinux: target?.kind === 'explorer' && !!target.node?.linux,
    outputView: target?.kind === 'output' ? target.view : '',
    outputGridTransposable: target?.kind === 'output' && target.view === 'grid' && transposableKinds.has(target.resultKind ?? ''),
    outputLiveSortable: target?.kind === 'output' && !!target.live?.sortable,
    outputLiveFilterable: target?.kind === 'output' && !!target.live?.filterable,
    pane: target?.kind === 'dockTab' ? target.pane : '',
    paneFloating: target?.kind === 'dockTab' && target.floating,
    panePopout: target?.kind === 'dockTab' && target.popout,
    documentTabFloating: target?.kind === 'documentTab' && !!target.floating,
    searchHitSchema: target?.kind === 'searchHit' && searchHitNames(target.hit.object).schema !== undefined
  }
}
/**
 * The arguments a context menu's commands run with: the target, the tab it is about, so the File commands act on that tab, and
 * the state keys a Search Objects result stands in for the selection's.
 */
export function argsFor(target: MenuTarget): CommandArgs {
  const tabId = target.kind === 'editor' || target.kind === 'documentTab' || target.kind === 'output' || target.kind === 'tableDesigner' || target.kind === 'ssisOperations' ? target.tabId : undefined
  return { target, ...(tabId ? { tabId } : {}), ...(target.kind === 'searchHit' ? { state: target.state } : {}) }
}
export const inputOf = (args: CommandArgs | undefined): InputTarget | undefined => args?.target?.kind === 'input' ? args.target : undefined
/** The Object Explorer node a context menu was opened for; undefined for its empty area and for other targets. */
export const explorerNodeOf = (args: CommandArgs | undefined): ExplorerMenuNode | undefined => args?.target?.kind === 'explorer' ? args.target.node : undefined
export const outputOf = (args: CommandArgs | undefined): OutputTarget | undefined => args?.target?.kind === 'output' ? args.target : undefined
export const searchHitOf = (args: CommandArgs | undefined): SearchHitTarget | undefined => args?.target?.kind === 'searchHit' ? args.target : undefined
/** The object a menu was opened for: an Object Explorer node, or a Search Objects result's object. */
export const objectNodeOf = (args: CommandArgs | undefined): ObjectMenuNode | undefined => explorerNodeOf(args) ?? searchHitOf(args)?.node

const textTypes: ReadonlySet<string> = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password'])
/**
 * The text field `element` is or is in: a text-like input, a text area, or editable content. The query editor's own
 * input element is not one: the editor has its own menu.
 */
export function editableText(element: Element): HTMLElement | undefined {
  if (element.closest('.native-edit-context, .inputarea')) return undefined
  if (element.tagName === 'TEXTAREA') return element as HTMLElement
  if (element.tagName === 'INPUT') return textTypes.has(((element as HTMLInputElement).type || 'text').toLowerCase()) ? element as HTMLElement : undefined
  return element.closest<HTMLElement>('[contenteditable]:not([contenteditable="false"])') ?? undefined
}
export const isEditableText = (element: Element): boolean => editableText(element) !== undefined

/** Whether the focused field can undo or redo; `document.queryCommandEnabled` in the app, true when unknown. */
export type CommandEnabled = (command: 'undo' | 'redo') => boolean
/** A text field's facts, read when its menu opens (after it has focus, so Undo and Redo describe it). */
export function inputTarget(element: HTMLElement, commandEnabled: CommandEnabled): InputTarget {
  const field = element as Partial<HTMLInputElement>, isField = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
  const value = isField ? String(field.value ?? '') : element.textContent ?? ''
  let hasSelection = false
  try {
    hasSelection = isField && typeof field.selectionStart === 'number' ? field.selectionStart !== field.selectionEnd : !!element.ownerDocument?.getSelection()?.toString()
  } catch (error) { onUnexpectedError(error) }
  const enabled = (command: 'undo' | 'redo') => { try { return commandEnabled(command) } catch { return true } }
  return {
    kind: 'input', element, readOnly: isField ? !!field.readOnly || !!field.disabled : !element.isContentEditable, secret: isField && String(field.type).toLowerCase() === 'password',
    hasSelection, empty: value === '', canUndo: enabled('undo'), canRedo: enabled('redo')
  }
}

/**
 * Where a context menu was asked for: the target, the element the menu is for (its rect anchors keyboard menus), the
 * element that takes focus first (as in Windows Explorer), and the element marked `data-menu-target` while it is open.
 */
export interface TargetHit {
  readonly target: MenuTarget
  readonly element: Element
  readonly focus?: HTMLElement
  readonly mark?: Element
  /** What a keyboard-opened menu opens below, when not `element`: the results grid's active cell. */
  readonly anchor?: Element
}
export type TargetProvider = (element: Element) => MenuTarget | null
interface TargetRegistration {
  readonly provider: TargetProvider
  /** A composite widget keeps keyboard focus on its owner rather than an inner action button. */
  readonly focus?: () => HTMLElement | undefined
}
export interface MenuTargetOptions {
  /** The bound query editor's container and the query it shows, when there is one. */
  readonly editor?: () => { readonly container: Element; readonly tabId: string } | undefined
  readonly commandEnabled?: CommandEnabled
}

const focusable = 'button, [tabindex], input, textarea, [contenteditable]'
/** Parts of the query editor whose right-click shows no menu: scroll bars, the overview ruler, hovers, suggestions, and the find widget around its inputs. */
const editorChrome = '.scrollbar, .decorationsOverviewRuler, .contentWidgets, .overflowingContentWidgets, .overlayWidgets'
const documentCommandEnabled: CommandEnabled = command => typeof document === 'undefined' || document.queryCommandEnabled(command)
const outputViews: ReadonlySet<string> = new Set<OutputView>(['grid', 'messages', 'live'])
/** The result kinds Transpose reads (TransposeService's `transposable`): never a diff's paired changes. */
const transposableKinds: ReadonlySet<string> = new Set(['rows', 'pivot', 'transpose'])

/** The text selected inside `element`, or '' when the selection is elsewhere or crosses its edge. */
export function selectedTextIn(element: Element): string {
  const selection = element.ownerDocument?.getSelection()
  if (!selection?.anchorNode || !selection.focusNode || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return ''
  return selection.toString()
}
/** The result's row and column under `element`, as the grid there answers (grid/anchor.ts): a cell's both, a header's
 *  column, a row number's row. Where no GridView is registered, the column by ARIA index. */
function outputCell(element: Element, view: HTMLElement): { readonly row?: number; readonly column?: number } {
  const grid = gridTarget(view, element)
  if (grid.registered) return grid.target ?? {}
  const column = outputColumn(element, view)
  return column === undefined ? {} : { column }
}
/** Grid columns count past the row-number column, which has ARIA index 1. */
function outputColumn(element: Element, view: HTMLElement): number | undefined {
  const cell = element.closest('[aria-colindex]'), value = cell?.getAttribute('aria-colindex')
  const column = value && /^\d+$/.test(value) ? Number(value) - 2 : -1
  return cell && view.contains(cell) && Number.isSafeInteger(column) && column >= 0 ? column : undefined
}
/** The Query Output view `element` is in: OutputPane marks each with its query, view, and result set. */
export function outputTarget(element: Element): OutputTarget | undefined {
  const view = element.closest<HTMLElement>('[data-output-view]')
  const kind = view?.getAttribute('data-output-view') ?? '', tabId = view?.getAttribute('data-tab-id') ?? '', entry = view?.getAttribute('data-result-entry') ?? ''
  if (view && kind === 'live') {
    // A live grid belongs to no query: its commands come with it.
    const live = liveOutputs.get(view), { row, column } = outputCell(element, view)
    return live ? { kind: 'output', tabId: '', view: 'live', selectedText: '', element: view, live, ...(column !== undefined ? { column } : {}), ...(row !== undefined ? { row } : {}) } : undefined
  }
  // A grid that does not say which entry it shows is no target: nothing could act on it.
  if (!view || !outputViews.has(kind) || !tabId || (kind === 'grid' && !entry)) return undefined
  const { row, column }: { readonly row?: number; readonly column?: number } = kind === 'grid' ? outputCell(element, view) : {}
  const generation = Number(view.getAttribute('data-result-generation')), resultId = Number(view.getAttribute('data-result-id'))
  const result = kind === 'grid' && Number.isSafeInteger(generation) && generation > 0 && Number.isSafeInteger(resultId) && resultId > 0 ? { generation, resultId } : undefined
  const resultKind = kind === 'grid' ? view.getAttribute('data-result-kind') ?? undefined : undefined
  return { kind: 'output', tabId, view: kind as OutputView, ...(kind === 'grid' ? { entry } : {}), selectedText: kind === 'grid' ? '' : selectedTextIn(view), element: view,
    ...(column !== undefined ? { column } : {}), ...(row !== undefined ? { row } : {}), ...(result ? { result } : {}), ...(resultKind ? { resultKind } : {}) }
}

/**
 * Finds what a context menu is for. Components register elements with a provider (`useMenuTarget`); the query editor,
 * Dockview's tab elements, and Query Output's views are resolved here. `targetFor` returns a hit to open its menu, null
 * to show no menu even where an outer element has one (the palette's input, the editor's scroll bars), and undefined
 * where nothing has a menu. Providers run at event time, so a target is never stale.
 */
export class MenuTargetService {
  private readonly providers = new WeakMap<Element, TargetRegistration>()
  private readonly revealers = new WeakMap<Element, (item: Element) => void>()
  constructor(private readonly options: MenuTargetOptions = {}) {}

  register(element: Element, provider: TargetProvider, focus?: () => HTMLElement | undefined): void { this.providers.set(element, { provider, ...focus ? { focus } : {} }) }
  /** A widget with its own layout reveals its active descendant before the menu measures it. */
  registerReveal(widget: Element, reveal: (item: Element) => void): () => void {
    this.revealers.set(widget, reveal)
    return () => { this.revealers.delete(widget) }
  }
  reveal(widget: Element, item: Element): boolean {
    const reveal = this.revealers.get(widget)
    if (!reveal) return false
    reveal(item)
    return true
  }
  /** Reads a text field's facts again, once it has focus. */
  refresh(target: MenuTarget): MenuTarget { return target.kind === 'input' ? inputTarget(target.element, this.options.commandEnabled ?? documentCommandEnabled) : target }

  targetFor(element: Element | null): TargetHit | null | undefined {
    // A keyboard event's target can be the document itself, which has no menu.
    if (typeof element?.closest !== 'function') return undefined
    try {
      if (element.closest('.quick-input')) return null
      const field = editableText(element)
      // Outlined while its menu is open: focus is in the menu, and Chromium hides an unfocused field's selection.
      if (field) return { target: inputTarget(field, this.options.commandEnabled ?? documentCommandEnabled), element: field, focus: field, mark: field }
      for (let node: Element | null = element; node; node = node.parentElement) {
        const registration = this.providers.get(node)
        if (registration) return this.hit(registration, node, element)
      }
      const editor = this.options.editor?.()
      if (editor?.container.contains(element)) return element.closest(editorChrome) || !editor.tabId ? null : { target: { kind: 'editor', tabId: editor.tabId }, element: editor.container }
      // Dockview's focusable tab element wraps the panel's own tab content (a workspace pane's, or a document's), which
      // registers the target.
      const tab = element.closest('.dv-tab')?.querySelector('[data-pane-tab], [data-tab-id]')
      const registration = tab && this.providers.get(tab)
      if (registration) return this.hit(registration, tab, element)
      const output = outputTarget(element)
      if (!output) return undefined
      // Keyboard menus open below the grid's active cell, else its first cell.
      const anchor = output.view !== 'messages' ? gridAnchor(output.element) ?? output.element.querySelector('.rg-c.is-act') ?? output.element.querySelector('.rg-c') ?? undefined : undefined
      // Without a clicked column the menu is for the anchor's cell: its column, and its row unless a row number was clicked.
      const cell = output.column === undefined && anchor ? outputCell(anchor, output.element) : undefined
      const column = cell?.column, row = output.row ?? cell?.row
      const target = column === undefined && row === output.row ? output : { ...output, ...(column !== undefined ? { column } : {}), ...(row !== undefined ? { row } : {}) }
      return { target, element: output.element, focus: output.element, ...(anchor ? { anchor } : {}) }
    } catch (error) { onUnexpectedError(error); return undefined }
  }

  private hit({ provider, focus: registeredFocus }: TargetRegistration, registered: Element, from: Element): TargetHit | null {
    const target = provider(registered)
    if (!target) return null
    const tab = registered.closest<HTMLElement>('.dv-tab') ?? undefined
    // The focusable part that was clicked (a tab's button), else the registered element or the Dockview tab around it.
    const inner = from.closest<HTMLElement>(focusable)
    const focus = registeredFocus?.() ?? (inner && registered.contains(inner) ? inner : registered.matches(focusable) ? registered as HTMLElement : tab)
    return { target, element: tab ?? registered, mark: tab ?? registered, ...(focus ? { focus } : {}) }
  }
}
