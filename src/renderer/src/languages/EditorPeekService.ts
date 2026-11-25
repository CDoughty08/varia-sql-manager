import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { scriptMenuState } from '../../../shared/scripting/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { googleSqlReservedKeywords } from '../../../shared/googlesql/catalog.ts'
import { reservedKeywords } from '../../../shared/sql/lexer.ts'
import type { Disposable } from '../core/types'
import { monacoKeyCodes, type BridgeMonaco } from '../editor/keybinding-bridge'
import type { PeekAnchor, PeekService, PeekSource } from '../explorer/PeekService'
import type { PeekTabService } from '../explorer/PeekTabService'
import type { ScriptingService } from '../scripting/ScriptingService'
import { bigQueryDefinitionKinds, definitionErrors, definitionLabel, definitionMessages, definitionNode, indexObjectLabel, indexObjectNode } from './definition'
import { googleSqlLanguageId } from './googlesql'
import type { IndexDefinitionOutcome } from './bigquery-definition'
import type { FoundIndexObject, IndexCompletionService } from './IndexCompletionService'
import type { SqlLanguageService } from './SqlLanguageService'

const googleSqlReserved: ReadonlySet<string> = new Set(googleSqlReservedKeywords)

/** A name in a SQL editor: the editor, its model and a position in the name. */
export interface EditorPlace {
  readonly editor: Pick<Monaco.editor.ICodeEditor, 'getDomNode' | 'getScrolledVisiblePosition' | 'getLayoutInfo' | 'onDidScrollChange' | 'onDidLayoutChange' | 'onDidChangeModelContent' | 'onDidChangeModel' | 'onDidDispose' | 'focus' | 'getModel'>
  readonly model: Monaco.editor.ITextModel
  readonly position: Monaco.Position
}
/** What a definition opens: F12's CREATE script, Peek's card at the name (Alt+F12, Ctrl+hover), or a Peek tab (Ctrl+click). */
export type DefinitionMode = 'script' | 'card' | 'tab'

export interface EditorPeekOptions {
  readonly sqlLanguage: Partial<Pick<SqlLanguageService, 'definition'>>
  readonly connections: { isLive(connectionId: string): boolean }
  readonly scripting?: Pick<ScriptingService, 'run' | 'inform'>
  readonly peek?: Pick<PeekService, 'peekAt' | 'hoverAt' | 'cancelHover' | 'getSnapshot' | 'close' | 'subscribe'>
  readonly peekTabs?: Pick<PeekTabService, 'open'>
  /** A BigQuery tab's lookup, from the connection's Search Objects index. */
  readonly indexDefinition?: Pick<IndexCompletionService, 'definition'>
  /**
   * F12 on a BigQuery view or routine: opens its free definition (`bigquery.properties`, `tables.get` or `routines.get`) in a new
   * query (`indexDefinitionOpener`); throws when the read fails.
   */
  readonly openIndexDefinition?: (found: FoundIndexObject) => Promise<IndexDefinitionOutcome>
}

/**
 * Where Peek's card is anchored for a name in a query editor: the name's first character, in window coordinates, while it is
 * in view. The card closes when the editor's text or document changes or the editor goes away, and moves as it scrolls.
 */
export function editorPeekAnchor({ editor, model, position }: EditorPlace): PeekAnchor | undefined {
  const dom = editor.getDomNode()
  if (!dom) return undefined
  const word = model.getWordAtPosition(position)
  const start = { lineNumber: position.lineNumber, column: word?.startColumn ?? position.column }
  const end = { lineNumber: position.lineNumber, column: word?.endColumn ?? position.column }
  return {
    document: dom.ownerDocument,
    rect: () => {
      const from = editor.getScrolledVisiblePosition(start), to = editor.getScrolledVisiblePosition(end)
      if (!from) return undefined
      const box = dom.getBoundingClientRect(), layout = editor.getLayoutInfo()
      const top = box.top + from.top, bottom = top + from.height
      // Scrolled out of the editor's text area: the card stays where it was.
      if (bottom <= box.top || top >= box.bottom || from.left < layout.contentLeft || from.left > layout.contentLeft + layout.contentWidth) return undefined
      return { left: box.left + from.left, top, right: box.left + (to?.left ?? from.left), bottom }
    },
    watch: (moved, gone) => {
      const subscriptions = [editor.onDidScrollChange(moved), editor.onDidLayoutChange(moved), editor.onDidChangeModelContent(gone), editor.onDidChangeModel(gone), editor.onDidDispose(gone)]
      return () => { for (const subscription of subscriptions) subscription.dispose() }
    },
    focus: () => editor.focus()
  }
}

/** The Monaco context key set on a query editor while Peek's card is open (beside a name or a row), or Alt+F12 looks one up there. */
export const peekCardContextKey = 'variaPeekCard'
/**
 * Monaco's own uses of Escape in an editor, which come before the card's: each closes its widget, leaves its snippet or
 * cancels its operation first. A rule added through Monaco's API outranks every default, so the card's clause steps aside
 * for each of these; tests/monaco-keybindings.test.ts fails when a Monaco upgrade adds another. A selection is not one:
 * as with VS Code's peek, Escape closes the card first and clears the selection next.
 */
export const monacoEscapeContextKeys = ['suggestWidgetVisible', 'findWidgetVisible', 'messageVisible', 'inSnippetMode', 'codeActionMenuVisible', 'referenceSearchVisible',
  'inReferenceSearchEditor', 'markersNavigationVisible', 'hasSymbols', 'cancellableOperation', 'inQuickInput', 'parameterHintsVisible'] as const
export const peekCardEscapeWhen = [peekCardContextKey, ...monacoEscapeContextKeys.map(key => `!${key}`)].join(' && ')
export const closePeekCardCommand = 'varia.closePeekCard'

/**
 * Escape in a query editor closes Peek's card, as Esc in Object Explorer's tree does: a card the pointer opened (beside a
 * name in the editor, or beside a row while typing in the editor) leaves focus in the text, so the card's own Esc never sees
 * the key. Monaco dispatches it, after its widgets.
 */
export function registerPeekCardEscape(monaco: PeekCardMonaco, editorPeek: Pick<EditorPeekService, 'closeCard'>): Disposable {
  // Monaco dispatches the rule only from an editor's own DOM, so the editor with focus is the one Escape was pressed in.
  const command = monaco.editor.registerCommand(closePeekCardCommand, () => editorPeek.closeCard(monaco.editor.getEditors().find(editor => editor.hasWidgetFocus())))
  try {
    const rule = monaco.editor.addKeybindingRules([{ keybinding: monacoKeyCodes.escape!, command: closePeekCardCommand, when: peekCardEscapeWhen }])
    return { dispose: () => { rule.dispose(); command.dispose() } }
  } catch (error) { command.dispose(); throw error }
}

/** The parts of Monaco the Escape rule uses, so tests can pass a fake. */
export interface PeekCardMonaco {
  readonly editor: BridgeMonaco['editor'] & { getEditors(): readonly { hasWidgetFocus(): boolean }[] }
}

/** Keeps `peekCardContextKey` on `editor` in step with `cardIn`, for the Escape rule. */
export function bindPeekCardKey(editor: Pick<Monaco.editor.IStandaloneCodeEditor, 'createContextKey'>, editorPeek: Pick<EditorPeekService, 'cardIn' | 'subscribe'>): Disposable {
  const key = editor.createContextKey<boolean>(peekCardContextKey, false)
  const sync = () => key.set(editorPeek.cardIn(editor))
  const unsubscribe = editorPeek.subscribe(sync)
  sync()
  return { dispose: () => { unsubscribe(); key.reset() } }
}

/**
 * Go To Definition, Peek Definition and their pointer gestures for SQL editors (a query tab's, or Peek's read-only one): F12
 * scripts the object as CREATE to a new query (Script As, as SSMS does), Alt+F12 and Ctrl+hover open Peek's card beside the
 * name, and Ctrl+click opens a Peek tab. In a BigQuery tab the name resolves through the Search Objects index; F12 opens a view's
 * or routine's free definition in a new query, and Peek opens on its Definition tab, so nothing is billed. A name that resolves to nothing, or a lookup that fails, is a quiet status-bar notice
 * from the keyboard and nothing at all from a hover, never an error banner.
 */
export class EditorPeekService {
  /** The name a hover last opened the card on, and that card, so resting on it again asks the backend nothing. */
  private shown: { readonly key: string; readonly id: number | undefined } | undefined
  /** The name a hover's lookup is running for while it is still wanted, so the pointer moving within it starts no other. */
  private pending: { readonly key: string; readonly wanted: () => boolean } | undefined
  /** Alt+F12's lookup while it runs: the editor it is for, until the card opens, nothing is found or Escape drops it. */
  private opening: { readonly editor: object } | undefined
  private readonly listeners = new Set<() => void>()

  constructor(private readonly options: EditorPeekOptions) {}

  /**
   * Whether Escape in `editor` (a query editor) is the card's: a card is open, or Alt+F12 is looking one up there. With focus
   * in the editor the card has none, so it is one a hover opened, or one the editor's caret took focus back from.
   */
  cardIn(editor: object): boolean {
    return this.opening?.editor === editor || !!this.options.peek?.getSnapshot().open
  }

  /** Calls `listener` whenever `cardIn` may have changed. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    const unsubscribe = this.options.peek?.subscribe(listener)
    return () => { this.listeners.delete(listener); unsubscribe?.() }
  }

  /**
   * Escape in a query editor (`closePeekCardCommand`, `editor` the one it was pressed in): the card closes, and an Alt+F12
   * still looking one up in that editor opens nothing. One started in another editor is that editor's.
   */
  closeCard(editor?: object): void {
    if (this.opening && this.opening.editor === editor) this.setOpening(undefined)
    if (this.options.peek?.getSnapshot().open) this.options.peek.close()
  }

  private setOpening(opening: { readonly editor: object } | undefined): void {
    if (this.opening === opening) return
    this.opening = opening
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * `wanted` (a hover's) turns false once the hover is cancelled: the lookup's answer then opens nothing. Resolves to whether
   * the card, tab or script opened.
   */
  async run(mode: DefinitionMode, place: EditorPlace, source: PeekSource = 'keyboard', wanted: () => boolean = () => true): Promise<boolean> {
    if (!this.options.scripting) return false
    // Until Alt+F12's card opens, Escape in its editor drops it, so a slow lookup never opens a card (and takes focus) later.
    const opening = mode === 'card' && source !== 'hover' ? { editor: place.editor } : undefined
    if (opening) this.setOpening(opening)
    try { return await this.find(mode, place, source, opening ? () => wanted() && this.opening === opening : wanted) }
    finally { if (opening && this.opening === opening) this.setOpening(undefined) }
  }

  private async find(mode: DefinitionMode, place: EditorPlace, source: PeekSource, wanted: () => boolean): Promise<boolean> {
    if (place.model.getLanguageId() === googleSqlLanguageId) return this.findIndexed(mode, place, source, wanted)
    const { sqlLanguage, scripting, connections } = this.options
    if (!sqlLanguage.definition || !scripting) return false
    const quiet = source === 'hover'
    const inform = (text: string) => { if (!quiet) scripting.inform(text) }
    const word = place.model.getWordAtPosition(place.position)?.word, version = place.model.getVersionId()
    let found
    try { found = await sqlLanguage.definition(place.model, place.position) }
    catch (error) { if (wanted()) inform(definitionMessages.failed(error instanceof Error ? error.message : undefined)); return false }
    if (found === undefined || !wanted()) return false
    if (found === null || !connections.isLive(found.connectionId)) { inform(definitionMessages.notFound(word === undefined ? undefined : displayText(word))); return false }
    const node = definitionNode(found)
    if (mode === 'card') {
      // The text changed, or the editor moved to another document, while the name was looked up: the card would point at the
      // wrong place.
      if (place.model.getVersionId() !== version || place.editor.getModel() !== place.model) return false
      const anchor = editorPeekAnchor(place)
      if (anchor && this.options.peek?.peekAt(node, anchor, source)) return true
      inform(definitionMessages.notPeekable(definitionLabel(found)))
      return false
    }
    if (mode === 'tab') {
      if (this.options.peekTabs?.open(node)) return true
      inform(definitionMessages.notPeekable(definitionLabel(found)))
      return false
    }
    if (scriptMenuState({ kind: node.kind, ...node.subtype ? { subtype: node.subtype } : {} }).verbs.create !== 'enabled') {
      inform(definitionMessages.notScriptable(definitionLabel(found)))
      return false
    }
    try { await scripting.run('create', 'newQuery', node); return true }
    catch (error) { inform(definitionMessages.failed(error instanceof Error ? error.message : undefined)); return false }
  }

  /** `find` for a BigQuery tab: the object from the index, a free definition for F12, Peek on its Definition tab. */
  private async findIndexed(mode: DefinitionMode, place: EditorPlace, source: PeekSource, wanted: () => boolean): Promise<boolean> {
    const { indexDefinition, scripting, connections, openIndexDefinition } = this.options
    if (!indexDefinition || !scripting) return false
    const inform = (text: string) => { if (source !== 'hover') scripting.inform(text) }
    const word = place.model.getWordAtPosition(place.position)?.word, version = place.model.getVersionId()
    let found
    try { found = await indexDefinition.definition(place.model, place.position, wanted) }
    catch (error) { if (wanted()) inform(definitionMessages.failed(error instanceof Error ? error.message : undefined)); return false }
    if (found === undefined || !wanted()) return false
    if (!found) { inform(definitionMessages.notFound(word === undefined ? undefined : displayText(word))); return false }
    if (!connections.isLive(found.connectionId)) { inform(definitionErrors.connectBigQueryFirst); return false }
    const label = indexObjectLabel(found), node = indexObjectNode(found)
    // A model: the index has it, but Peek and Properties do not describe one.
    if (!node) { inform(mode === 'script' ? definitionMessages.notScriptable(label) : definitionMessages.notPeekable(label)); return false }
    const tab = bigQueryDefinitionKinds.has(found.kind) ? 'definition' as const : undefined
    if (mode === 'card') {
      if (place.model.getVersionId() !== version || place.editor.getModel() !== place.model) return false
      const anchor = editorPeekAnchor(place)
      if (anchor && this.options.peek?.peekAt(node, anchor, source, tab)) return true
      inform(definitionMessages.notPeekable(label))
      return false
    }
    if (mode === 'tab') {
      if (this.options.peekTabs?.open(node, tab)) return true
      inform(definitionMessages.notPeekable(label))
      return false
    }
    // A table's CREATE statement is a billed INFORMATION_SCHEMA query (Script As › CREATE asks first); F12 never runs one.
    if (!tab || !openIndexDefinition) { inform(definitionMessages.noFreeDefinition(label)); return false }
    try {
      const outcome = await openIndexDefinition(found)
      if (outcome === 'none') { inform(definitionMessages.noStoredDefinition(label)); return false }
      if (outcome === 'cut') inform(definitionMessages.definitionCut(label))
      return true
    } catch (error) { inform(definitionMessages.failed(error instanceof Error ? error.message : undefined)); return false }
  }

  /**
   * The pointer rests on `position` with Peek on Hover's modifier held: the card opens there after the hover delay (the
   * Peek service's timer, which releasing the modifier or another key cancels). Keywords and the name the card already
   * shows ask nothing.
   */
  hover(place: EditorPlace): void {
    const peek = this.options.peek
    if (!peek) return
    const word = place.model.getWordAtPosition(place.position)
    const reserved = place.model.getLanguageId() === googleSqlLanguageId ? googleSqlReserved : reservedKeywords
    if (!word || reserved.has(word.word.toUpperCase())) { peek.cancelHover(); return }
    const key = `${place.model.uri.toString()}\n${place.model.getVersionId()}\n${place.position.lineNumber}\n${word.startColumn}`
    const open = peek.getSnapshot().open
    if ((open?.anchor && this.shown?.key === key && this.shown.id === open.id) || (this.pending?.key === key && this.pending.wanted())) return
    // A card the keyboard opened has focus: a pointer passing over names with the modifier held leaves it alone, as in Object Explorer.
    if (open && open.source !== 'hover') return
    peek.hoverAt(key, wanted => {
      const pending = this.pending = { key, wanted }
      void this.run('card', place, 'hover', wanted).then(opened => {
        if (opened) this.shown = { key, id: peek.getSnapshot().open?.id }
      }).finally(() => { if (this.pending === pending) this.pending = undefined })
    })
  }

  /** The pointer left the name, moved without the modifier, or pressed: a card not yet open stays closed. */
  cancelHover(): void { this.pending = undefined; this.options.peek?.cancelHover() }
}
