import type { ConnectionInfo } from '../../../shared/contracts'
import { contextRecord, type ContextKeys } from '../../../shared/commands/context-keys'
import type { Platform } from '../../../shared/commands/keybindings'
import type { DocumentSnapshot } from '../services/documents'
import type { EditorOptions } from '../services/editor-options'
import type { QuerySnapshot } from '../services/queries'
import { onUnexpectedError } from './errors'
import type { Disposable, ExternalStore } from './types'

export interface FocusFacts { readonly editorFocus: boolean; readonly editorTextFocus: boolean; readonly inputFocus: boolean; readonly activePanel: 'explorer' | 'editor' | 'output' | '' }
/** The parts of a DOM element and of the editor that `focusFacts` reads, so tests can pass plain objects. */
export interface FocusElement { matches(selector: string): boolean; closest(selector: string): { getAttribute(name: string): string | null } | null }
export interface FocusEditor<E> { getContainerDomNode(): { contains(node: E): boolean }; hasTextFocus(): boolean }

const noFocus: FocusFacts = { editorFocus: false, editorTextFocus: false, inputFocus: false, activePanel: '' }
const panels: ReadonlySet<string> = new Set(['explorer', 'editor', 'output'])

/** Focus keys for the focused element. The find widget is inside the editor, so its inputs give editorFocus and inputFocus. */
export function focusFacts<E extends FocusElement>(element: E | null, editor: FocusEditor<E> | undefined): FocusFacts {
  if (!element) return noFocus
  const editorTextFocus = !!editor?.hasTextFocus()
  const editorFocus = editorTextFocus || !!editor?.getContainerDomNode().contains(element)
  const inputFocus = !editorTextFocus && (element.matches('input, textarea, select') || !!element.closest('[contenteditable]:not([contenteditable="false"])'))
  // DockWorkspace marks each pane host, and the mark moves with floating groups.
  const pane = element.closest('[data-pane]')?.getAttribute('data-pane') ?? ''
  return { editorFocus, editorTextFocus, inputFocus, activePanel: panels.has(pane) ? pane as FocusFacts['activePanel'] : '' }
}

export interface ContextInputs {
  readonly platform: Platform
  readonly focus?: FocusFacts
  readonly documents: DocumentSnapshot
  readonly queries: QuerySnapshot
  readonly connections: readonly ConnectionInfo[]
  readonly quickInputVisible: boolean
  readonly wordWrap: boolean
  readonly backendReady: boolean
}
/** Every context key from service snapshots and focus facts; without focus, the focus keys are false or ''. */
export function computeContextKeys(inputs: ContextInputs): ContextKeys {
  const { documents, connections } = inputs, focus = inputs.focus ?? noFocus
  const active = documents.documents.find(document => document.id === documents.activeId)
  return contextRecord(inputs.platform, {
    ...focus, textInputFocus: focus.editorTextFocus || focus.inputFocus,
    quickInputVisible: inputs.quickInputVisible, backendReady: inputs.backendReady, editorWordWrap: inputs.wordWrap,
    hasActiveDocument: !!active, multipleDocuments: documents.documents.length > 1, documentBusy: documents.busy, hasConnection: connections.length > 0,
    activeDocumentConnected: !!active?.connectionId && connections.some(connection => connection.id === active.connectionId),
    queryRunning: !!active && !!inputs.queries[active.id]?.running
  })
}

export interface ContextKeyOptions {
  readonly platform: Platform
  readonly documents: ExternalStore<DocumentSnapshot>
  readonly queries: ExternalStore<QuerySnapshot>
  readonly connections: ExternalStore<readonly ConnectionInfo[]>
  readonly editorOptions: ExternalStore<EditorOptions>
  readonly quickInput?: ExternalStore<{ readonly visible: boolean }>
  readonly editor?: () => FocusEditor<Element> | undefined
  readonly activeElement?: () => Element | null
}

/**
 * Context keys computed on read from service snapshots (and, for `get`, from the focused element), so nothing mirrored
 * can go stale. `backendReady` is the only key the app sets. Listeners hear state changes, never focus changes.
 */
export class ContextKeyService implements Disposable {
  private backendReady = false
  private listeners = new Set<() => void>()
  private cache?: { readonly inputs: readonly unknown[]; readonly keys: ContextKeys }
  private readonly unsubscribe: (() => void)[]
  constructor(private readonly options: ContextKeyOptions) {
    this.unsubscribe = [options.documents, options.queries, options.connections, options.editorOptions, options.quickInput].flatMap(store => store ? [store.subscribe(() => this.changed())] : [])
  }
  private inputs(focus?: FocusFacts): ContextInputs {
    const { options } = this
    return {
      platform: options.platform, focus, documents: options.documents.getSnapshot(), queries: options.queries.getSnapshot(), connections: options.connections.getSnapshot(),
      quickInputVisible: !!options.quickInput?.getSnapshot().visible, wordWrap: options.editorOptions.getSnapshot().wordWrap, backendReady: this.backendReady
    }
  }
  /** Static and state keys, for enablement: focus keys are false or ''. Cached until a snapshot changes. */
  getState(): ContextKeys {
    const { options } = this
    const inputs = [options.documents.getSnapshot(), options.queries.getSnapshot(), options.connections.getSnapshot(), options.editorOptions.getSnapshot(), options.quickInput?.getSnapshot(), this.backendReady]
    if (this.cache?.inputs.every((value, index) => value === inputs[index])) return this.cache.keys
    const keys = computeContextKeys(this.inputs())
    this.cache = { inputs, keys }
    return keys
  }
  /** Every key, focus included, for keybinding `when` clauses. */
  get(): ContextKeys {
    const element = this.options.activeElement ? this.options.activeElement() : typeof document === 'undefined' ? null : document.activeElement
    return computeContextKeys(this.inputs(focusFacts(element, this.options.editor?.())))
  }
  set(values: { backendReady?: boolean }): void {
    if (values.backendReady === undefined || values.backendReady === this.backendReady) return
    this.backendReady = values.backendReady
    this.changed()
  }
  private changed(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { onUnexpectedError(error) }
    }
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  dispose(): void { this.unsubscribe.forEach(unsubscribe => unsubscribe()); this.listeners.clear() }
}
