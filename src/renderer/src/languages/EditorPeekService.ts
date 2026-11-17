import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { scriptMenuState } from '../../../shared/scripting/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { reservedKeywords } from '../../../shared/sql/lexer.ts'
import type { PeekAnchor, PeekService, PeekSource } from '../explorer/PeekService'
import type { PeekTabService } from '../explorer/PeekTabService'
import type { ScriptingService } from '../scripting/ScriptingService'
import { definitionLabel, definitionMessages, definitionNode } from './definition'
import type { SqlLanguageService } from './SqlLanguageService'

/** A name in a SQL editor: the editor, its model and a position in the name. */
export interface EditorPlace {
  readonly editor: Pick<Monaco.editor.ICodeEditor, 'getDomNode' | 'getScrolledVisiblePosition' | 'getLayoutInfo' | 'onDidScrollChange' | 'onDidLayoutChange' | 'onDidChangeModelContent' | 'onDidChangeModel' | 'onDidDispose' | 'focus'>
  readonly model: Monaco.editor.ITextModel
  readonly position: Monaco.Position
}
/** What a definition opens: F12's CREATE script, Peek's card at the name (Alt+F12, Ctrl+hover), or a Peek tab (Ctrl+click). */
export type DefinitionMode = 'script' | 'card' | 'tab'

export interface EditorPeekOptions {
  readonly sqlLanguage: Partial<Pick<SqlLanguageService, 'definition'>>
  readonly connections: { isLive(connectionId: string): boolean }
  readonly scripting?: Pick<ScriptingService, 'run' | 'inform'>
  readonly peek?: Pick<PeekService, 'peekAt' | 'hoverAt' | 'cancelHover' | 'getSnapshot'>
  readonly peekTabs?: Pick<PeekTabService, 'open'>
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
      if (bottom <= box.top || top >= box.bottom || from.left < layout.contentLeft || from.left > layout.width) return undefined
      return { left: box.left + from.left, top, right: box.left + (to?.left ?? from.left), bottom }
    },
    watch: (moved, gone) => {
      const subscriptions = [editor.onDidScrollChange(moved), editor.onDidLayoutChange(moved), editor.onDidChangeModelContent(gone), editor.onDidChangeModel(gone), editor.onDidDispose(gone)]
      return () => { for (const subscription of subscriptions) subscription.dispose() }
    },
    focus: () => editor.focus()
  }
}

/**
 * Go To Definition, Peek Definition and their pointer gestures for SQL editors (a query tab's, or Peek's read-only one): F12
 * scripts the object as CREATE to a new query (Script As, as SSMS does), Alt+F12 and Ctrl+hover open Peek's card beside the
 * name, and Ctrl+click opens a Peek tab. A name that resolves to nothing, or a lookup that fails, is a quiet status-bar notice
 * from the keyboard and nothing at all from a hover, never an error banner.
 */
export class EditorPeekService {
  /** The name the card was last opened on by a hover, so resting on it again asks the backend nothing. */
  private shown: string | undefined

  constructor(private readonly options: EditorPeekOptions) {}

  async run(mode: DefinitionMode, place: EditorPlace, source: PeekSource = 'keyboard'): Promise<void> {
    const { sqlLanguage, scripting, connections } = this.options
    if (!sqlLanguage.definition || !scripting) return
    const quiet = source === 'hover'
    const inform = (text: string) => { if (!quiet) scripting.inform(text) }
    const word = place.model.getWordAtPosition(place.position)?.word
    let found
    try { found = await sqlLanguage.definition(place.model, place.position) }
    catch (error) { inform(definitionMessages.failed(error instanceof Error ? error.message : undefined)); return }
    if (found === undefined) return
    if (found === null || !connections.isLive(found.connectionId)) { inform(definitionMessages.notFound(word === undefined ? undefined : displayText(word))); return }
    const node = definitionNode(found)
    if (mode === 'card') {
      const anchor = editorPeekAnchor(place)
      if (!anchor || !this.options.peek?.peekAt(node, anchor, source)) inform(definitionMessages.notPeekable(definitionLabel(found)))
      return
    }
    if (mode === 'tab') {
      if (!this.options.peekTabs?.open(node)) inform(definitionMessages.notPeekable(definitionLabel(found)))
      return
    }
    if (scriptMenuState({ kind: node.kind, ...node.subtype ? { subtype: node.subtype } : {} }).verbs.create !== 'enabled') {
      inform(definitionMessages.notScriptable(definitionLabel(found)))
      return
    }
    try { await scripting.run('create', 'newQuery', node) }
    catch (error) { inform(definitionMessages.failed(error instanceof Error ? error.message : undefined)) }
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
    if (!word || reservedKeywords.has(word.word.toUpperCase())) { peek.cancelHover(); return }
    const key = `${place.model.uri.toString()}\n${place.model.getVersionId()}\n${place.position.lineNumber}\n${word.startColumn}`
    const open = peek.getSnapshot().open
    if (open?.anchor && this.shown === key) return
    // A card the keyboard opened has focus: a pointer passing over names with the modifier held leaves it alone, as in Object Explorer.
    if (open && open.source !== 'hover') return
    peek.hoverAt(key, () => { this.shown = key; void this.run('card', place, 'hover') })
  }

  /** The pointer left the name, moved without the modifier, or pressed: a card not yet open stays closed. */
  cancelHover(): void { this.options.peek?.cancelHover() }
}
