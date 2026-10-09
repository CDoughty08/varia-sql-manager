import type { TargetKeys } from '../../../shared/commands/context-keys'
import type { ContextMenuId } from '../../../shared/commands/menus'
import type { ServerObjectKind } from '../../../shared/contracts'
import type { PaneId } from '../../../shared/layouts'
import { onUnexpectedError } from '../core/errors'
import type { CommandArgs } from '../core/types'

/** An Object Explorer node a context menu can be for; 'background' is the empty area below the servers. */
export type ExplorerNode =
  | { readonly kind: 'background' }
  | { readonly kind: 'server'; readonly connectionId: string }
  | { readonly kind: 'databasesFolder' | 'systemDatabasesFolder' | 'snapshotsFolder' | 'securityFolder'; readonly connectionId: string }
  | { readonly kind: 'database' | 'tablesFolder'; readonly connectionId: string; readonly database: string }
  | { readonly kind: 'table'; readonly connectionId: string; readonly database: string; readonly schema: string; readonly name: string }
  | { readonly kind: 'serverObjectsFolder'; readonly connectionId: string; readonly objectKind: ServerObjectKind }
  | { readonly kind: 'serverObject'; readonly connectionId: string; readonly objectKind: ServerObjectKind; readonly name: string }
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
export type OutputView = 'grid' | 'messages' | 'plan'
/**
 * A Query Output view: the query's results grid for one result set (its cell selection lives in
 * `ResultSelectionService`), or Messages or the XML plan with the text selected in them when the menu opened.
 */
export interface OutputTarget {
  readonly kind: 'output'
  readonly tabId: string
  readonly view: OutputView
  readonly resultIndex: number
  readonly selectedText: string
  readonly element: HTMLElement
}
/** What a context menu was opened for. Renderer objects only: commands receive it as `CommandArgs.target`, and it never crosses IPC. */
export type MenuTarget =
  | { readonly kind: 'editor'; readonly tabId: string }
  | { readonly kind: 'explorer'; readonly node: ExplorerNode }
  | { readonly kind: 'documentTab'; readonly tabId: string }
  | OutputTarget
  | { readonly kind: 'dockTab'; readonly pane: PaneId; readonly floating: boolean }
  | InputTarget

export const menuForTarget: Readonly<Record<MenuTarget['kind'], ContextMenuId>> = {
  editor: 'editor.context', explorer: 'explorer.context', documentTab: 'documentTab.context', output: 'output.context', dockTab: 'dockTab.context', input: 'input.context'
}
/** Each context menu's accessible name. */
export const contextMenuLabels: Readonly<Record<ContextMenuId, string>> = {
  'editor.context': 'Query editor', 'explorer.context': 'Object Explorer', 'documentTab.context': 'Query tab', 'output.context': 'Query output',
  'dockTab.context': 'Panel tab', 'input.context': 'Text field'
}

/** The target keys placement `when` clauses read; each describes one kind of target and is '' or false for the others. */
export function targetKeys(target: MenuTarget | undefined): TargetKeys {
  return {
    explorerNode: target?.kind === 'explorer' ? target.node.kind : '',
    outputView: target?.kind === 'output' ? target.view : '',
    paneFloating: target?.kind === 'dockTab' && target.floating
  }
}
/** The arguments a context menu's commands run with: the target, and the tab it is about, so the File commands act on that tab. */
export function argsFor(target: MenuTarget): CommandArgs {
  const tabId = target.kind === 'editor' || target.kind === 'documentTab' || target.kind === 'output' ? target.tabId : undefined
  return { target, ...(tabId ? { tabId } : {}) }
}
export const inputOf = (args: CommandArgs | undefined): InputTarget | undefined => args?.target?.kind === 'input' ? args.target : undefined
export const explorerNodeOf = (args: CommandArgs | undefined): ExplorerNode | undefined => args?.target?.kind === 'explorer' ? args.target.node : undefined
export const outputOf = (args: CommandArgs | undefined): OutputTarget | undefined => args?.target?.kind === 'output' ? args.target : undefined

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
export interface MenuTargetOptions {
  /** The bound query editor's container and the query it shows, when there is one. */
  readonly editor?: () => { readonly container: Element; readonly tabId: string } | undefined
  readonly commandEnabled?: CommandEnabled
}

const focusable = 'button, [tabindex], input, textarea, [contenteditable]'
/** Parts of the query editor whose right-click shows no menu: scroll bars, the overview ruler, hovers, suggestions, and the find widget around its inputs. */
const editorChrome = '.scrollbar, .decorationsOverviewRuler, .contentWidgets, .overflowingContentWidgets, .overlayWidgets'
const documentCommandEnabled: CommandEnabled = command => typeof document === 'undefined' || document.queryCommandEnabled(command)
const outputViews: ReadonlySet<string> = new Set<OutputView>(['grid', 'messages', 'plan'])

/** The text selected inside `element`, or '' when the selection is elsewhere or crosses its edge. */
export function selectedTextIn(element: Element): string {
  const selection = element.ownerDocument?.getSelection()
  if (!selection?.anchorNode || !selection.focusNode || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return ''
  return selection.toString()
}
/** The Query Output view `element` is in: QueryOutput marks each with its query, view, and result set. */
export function outputTarget(element: Element): OutputTarget | undefined {
  const view = element.closest<HTMLElement>('[data-output-view]')
  const kind = view?.getAttribute('data-output-view') ?? '', tabId = view?.getAttribute('data-tab-id') ?? '', resultIndex = Number(view?.getAttribute('data-result-index') ?? 0)
  if (!view || !outputViews.has(kind) || !tabId || !Number.isInteger(resultIndex) || resultIndex < 0) return undefined
  return { kind: 'output', tabId, view: kind as OutputView, resultIndex, selectedText: kind === 'grid' ? '' : selectedTextIn(view), element: view }
}

/**
 * Finds what a context menu is for. Components register elements with a provider (`useMenuTarget`); the query editor,
 * Dockview's tab elements, and Query Output's views are resolved here. `targetFor` returns a hit to open its menu, null
 * to show no menu even where an outer element has one (the palette's input, the editor's scroll bars), and undefined
 * where nothing has a menu. Providers run at event time, so a target is never stale.
 */
export class MenuTargetService {
  private readonly providers = new WeakMap<Element, TargetProvider>()
  constructor(private readonly options: MenuTargetOptions = {}) {}

  register(element: Element, provider: TargetProvider): void { this.providers.set(element, provider) }
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
        const provider = this.providers.get(node)
        if (provider) return this.hit(provider, node, element)
      }
      const editor = this.options.editor?.()
      if (editor?.container.contains(element)) return element.closest(editorChrome) || !editor.tabId ? null : { target: { kind: 'editor', tabId: editor.tabId }, element: editor.container }
      // Dockview's focusable tab element wraps the panel's own tab content, which registers the target.
      const tab = element.closest('.dv-tab')?.querySelector('[data-pane-tab]')
      const provider = tab && this.providers.get(tab)
      if (provider) return this.hit(provider, tab, element)
      const output = outputTarget(element)
      if (!output) return undefined
      // Keyboard menus open below the grid's active cell, else its first cell.
      const anchor = output.view === 'grid' ? output.element.querySelector('td.active-cell') ?? output.element.querySelector('td[data-col]') ?? undefined : undefined
      return { target: output, element: output.element, focus: output.element, ...(anchor ? { anchor } : {}) }
    } catch (error) { onUnexpectedError(error); return undefined }
  }

  private hit(provider: TargetProvider, registered: Element, from: Element): TargetHit | null {
    const target = provider(registered)
    if (!target) return null
    const tab = registered.closest<HTMLElement>('.dv-tab') ?? undefined
    // The focusable part that was clicked (a tab's button), else the registered element or the Dockview tab around it.
    const inner = from.closest<HTMLElement>(focusable)
    const focus = inner && registered.contains(inner) ? inner : registered.matches(focusable) ? registered as HTMLElement : tab
    return { target, element: tab ?? registered, mark: tab ?? registered, ...(focus ? { focus } : {}) }
  }
}
