// Dropping Object Explorer rows into the query editor. The tree puts its own type on the drag; the editor accepts only
// that type, so files, links and text from other apps keep Chromium's behaviour (main blocks navigation).
import type { Disposable } from '../core/types'

/** The drag type Object Explorer rows carry: `{"v":1,"text":…}`. */
export const explorerDragType = 'application/x-varia-explorer'
/** As long as a script may be. */
export const maxDropText = 1_000_000

/** The text of an Object Explorer drag payload, or undefined when it is not one. */
export function parseExplorerDrop(data: string): string | undefined {
  // The JSON quotes and escapes a full-length text; anything longer cannot be a valid payload.
  if (!data || data.length > maxDropText * 6 + 32) return undefined
  try {
    const value: unknown = JSON.parse(data)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const { v, text, ...rest } = value as Record<string, unknown>
    if (v !== 1 || typeof text !== 'string' || !text || text.length > maxDropText || Object.keys(rest).length) return undefined
    return text
  } catch { return undefined }
}

interface Position { readonly lineNumber: number; readonly column: number }
/** The parts of Monaco's editor a drop uses. */
export interface DropEditor {
  getContainerDomNode(): HTMLElement
  getModel(): object | null
  getTargetAtClientPoint(clientX: number, clientY: number): { readonly position: Position | null } | null
  getSelection(): { getEndPosition(): Position } | null
  pushUndoStop(): boolean
  executeEdits(source: string, edits: { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string; forceMoveMarkers: boolean }[],
    endCursorState: (inverse: { readonly range: { readonly endLineNumber: number; readonly endColumn: number } }[]) => null): boolean
  setPosition(position: Position): void
  focus(): void
}
/** The parts of a drop event a drop uses. */
export interface DropEvent {
  readonly clientX: number
  readonly clientY: number
  readonly dataTransfer: Pick<DataTransfer, 'types' | 'getData'> | null
  preventDefault(): void
  stopPropagation(): void
}

/**
 * Inserts a dropped Object Explorer row at the drop point (or the selection's end), as one undo step, and puts the
 * caret after it with focus in the editor. Returns whether the event was an Object Explorer drop.
 */
export function dropIntoEditor(editor: DropEditor, event: DropEvent): boolean {
  if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes(explorerDragType)) return false
  event.preventDefault()
  event.stopPropagation()
  const text = parseExplorerDrop(event.dataTransfer.getData(explorerDragType))
  if (text === undefined || !editor.getModel()) return true
  const position = editor.getTargetAtClientPoint(event.clientX, event.clientY)?.position ?? editor.getSelection()?.getEndPosition()
  if (!position) return true
  let end: Position | undefined
  editor.pushUndoStop()
  editor.executeEdits('explorer.drop', [{ range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column }, text, forceMoveMarkers: true }],
    inverse => { const range = inverse[0]?.range; if (range) end = { lineNumber: range.endLineNumber, column: range.endColumn }; return null })
  editor.pushUndoStop()
  if (end) editor.setPosition(end)
  editor.focus()
  return true
}

/**
 * Accepts Object Explorer drops on the query editor. Monaco's own listener on the same element runs first: it allows
 * the drop (dragover) and draws, then removes, the `.dnd-target` caret.
 */
export function bindExplorerDrop(editor: DropEditor): Disposable {
  const container = editor.getContainerDomNode()
  const listener = (event: DragEvent) => { dropIntoEditor(editor, event) }
  container.addEventListener('drop', listener)
  return { dispose: () => container.removeEventListener('drop', listener) }
}
