import type { editor } from 'monaco-editor'
import type { Disposable } from '../core/types'
import type { QueryEditorInstance, QueryEditorUse } from '../editor/create-editor'

/** The Monaco context key Peek's editor sets on itself: Varia's chord bridge leaves it out, as query-tab commands do. */
export const peekEditorContextKey = 'variaPeekEditor'
/** The attribute on the element that holds Peek's editor, which the `peekEditorFocus` context key reads. */
export const peekEditorAttribute = 'data-peek-editor'
/** How Peek's editor differs from an editor group's (`createQueryEditor`): read-only, compact, its own context key. */
export const peekEditorUse: QueryEditorUse = {
  readOnly: { message: 'Peek is read-only. Script to New Query or Modify opens the definition in a query tab.' },
  compact: true,
  ariaLabel: 'Definition text',
  contextKey: peekEditorContextKey,
  inEditorPane: false,
  // Its hover and message widgets sit in a body-level host, outside the card: a press there is still a press on Peek.
  widgetHostAttribute: peekEditorAttribute
}

/** Whether a pressed element belongs to a Peek editor, its body-level widget host included. */
export function inPeekEditor(target: EventTarget | null): boolean {
  const element = target && typeof (target as Element).closest === 'function' ? target as Element : (target as Node | null)?.parentElement
  return !!element?.closest(`[${peekEditorAttribute}]`)
}

/**
 * Whether `element` (the focused one) is the text of a Peek editor, not its find widget: Monaco then waits for a chord's
 * second key after Ctrl+K (⌘K), as it does in a query's text.
 */
export function peekEditorHasTextFocus(element: Element | null | undefined): boolean {
  return !!element?.closest(`[${peekEditorAttribute}]`) && !!element.closest('.native-edit-context, .inputarea') && !element.closest('.find-widget')
}

/** A model's connection and database, as a query document carries them. */
export interface SqlModelContext { readonly connectionId: string; readonly database?: string }
/**
 * What SqlLanguageService reads to serve a Peek model: its connection and database, and `documentId`, the model's own UUID
 * (its URI's), which names it to the language backend for as long as the model lives.
 */
export interface PeekModelContext extends SqlModelContext { readonly documentId: string }
const modelContexts = new WeakMap<object, PeekModelContext>()
/** The context of a Peek model; undefined for any other model (a query document's are in DocumentService). */
export const peekModelContext = (model: object): PeekModelContext | undefined => modelContexts.get(model)

/** The definition a Peek editor shows: `key` changes when the view shows another object or reads it again. */
export interface PeekEditorText extends SqlModelContext { readonly key: string; readonly text: string }

/** The parts of Monaco a Peek editor uses, so tests can pass a fake. */
export interface PeekEditorMonaco {
  readonly editor: { createModel(value: string, language: string, uri: unknown): editor.ITextModel }
  readonly Uri: { parse(value: string): unknown }
}
export interface PeekEditorOptions {
  readonly monaco: PeekEditorMonaco
  /** `createQueryEditor` with `peekEditorUse`: the same editor editor groups use. */
  readonly create: (container: HTMLElement) => QueryEditorInstance
  readonly newId?: () => string
}

/**
 * The editor of one Peek view (the card's or a promoted tab's): one Monaco instance, made the first time the definition shows
 * and kept while the view lives, moved into whichever slot shows the definition. Each definition gets a model of its own (a
 * `varia-sql://peek/` URI, with the view's connection and database), disposed as soon as the view moves on: another object,
 * Back, Refresh, a read that failed. Disposing the view's editor disposes both.
 */
export class PeekEditor implements Disposable {
  private host?: { readonly element: HTMLElement; readonly editor: QueryEditorInstance }
  private shown?: { readonly key: string; readonly text: string; readonly model: editor.ITextModel }
  private disposed = false
  private readonly newId: () => string

  constructor(private readonly options: PeekEditorOptions) {
    this.newId = options.newId ?? (() => crypto.randomUUID())
  }

  /** The Monaco instance, once the definition has shown. */
  get instance(): editor.IStandaloneCodeEditor | undefined { return this.host?.editor.instance }

  /**
   * Shows `text` in `slot`. The editor is made in the slot's window (Object Explorer, and with it the card, may be in a
   * popout), and made again when the slot is in another window, since Monaco binds to the window it was made in.
   */
  show(slot: HTMLElement, text: PeekEditorText): void {
    if (this.disposed) return
    if (this.host && this.host.element.ownerDocument !== slot.ownerDocument) this.dropHost()
    let host = this.host
    if (!host) {
      const element = slot.ownerDocument.createElement('div')
      element.className = 'peek-editor-host'
      element.setAttribute(peekEditorAttribute, '')
      slot.append(element)
      host = this.host = { element, editor: this.options.create(element) }
    } else if (host.element.parentElement !== slot) slot.append(host.element)
    const shown = this.shown
    if (shown && shown.key === text.key && shown.text === text.text) {
      if (host.editor.instance.getModel() !== shown.model) host.editor.instance.setModel(shown.model)
      return
    }
    const documentId = this.newId()
    const model = this.options.monaco.editor.createModel(text.text, 'sql', this.options.monaco.Uri.parse(`varia-sql://peek/${documentId}`))
    modelContexts.set(model, { documentId, connectionId: text.connectionId, ...text.database === undefined ? {} : { database: text.database } })
    this.shown = { key: text.key, text: text.text, model }
    host.editor.instance.setModel(model)
    shown?.model.dispose()
  }

  /** `slot` no longer shows the definition (another tab does): the editor leaves the document and keeps its model. */
  hide(slot: HTMLElement): void {
    if (this.host?.element.parentElement === slot) this.host.element.remove()
  }

  /** The view shows `key` now (undefined: nothing with a definition): a model kept for anything else is disposed. */
  keep(key: string | undefined): void {
    const shown = this.shown
    if (!shown || shown.key === key) return
    this.shown = undefined
    this.host?.editor.instance.setModel(null)
    shown.model.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.dropHost()
    this.keep(undefined)
  }

  private dropHost(): void {
    const host = this.host
    if (!host) return
    this.host = undefined
    host.editor.dispose()
    host.element.remove()
  }
}
