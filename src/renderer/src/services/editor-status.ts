import type { editor } from 'monaco-editor'
import type { LineEnding } from '../../../shared/contracts'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

/**
 * The caret as Visual Studio's status bar shows it: `line`; `column`, the display column with tabs expanded; and
 * `character`, the 1-based UTF-16 index Monaco calls the column. Only numbers and the line ending: no query text.
 */
export interface EditorStatus { readonly line: number; readonly column: number; readonly character: number; readonly eol: LineEnding }
export type EditorStatusSnapshot = EditorStatus | null

/**
 * The 1-based display column before UTF-16 index `column` (1-based) of `lineText`: a tab moves to the next multiple of
 * `tabSize`, and a surrogate pair is one character.
 */
export function displayColumn(lineText: string, column: number, tabSize: number): number {
  const end = Math.min(Math.max(column - 1, 0), lineText.length), size = Math.max(1, Math.floor(tabSize))
  let visible = 0
  for (let index = 0; index < end; index++) {
    const code = lineText.charCodeAt(index)
    if (code === 9) visible += size - visible % size
    else {
      visible++
      // The low half of a pair is not a column of its own.
      if ((code & 0xfc00) === 0xd800 && index + 1 < end && (lineText.charCodeAt(index + 1) & 0xfc00) === 0xdc00) index++
    }
  }
  return visible + 1
}

type StatusEditor = Pick<editor.ICodeEditor, 'getModel' | 'getPosition' | 'onDidChangeCursorPosition' | 'onDidChangeModel' | 'onDidChangeModelContent' | 'onDidChangeModelOptions'>
const same = (a: EditorStatusSnapshot, b: EditorStatusSnapshot) => a === b || (!!a && !!b && a.line === b.line && a.column === b.column && a.character === b.character && a.eol === b.eol)

/**
 * Ln, Col, Ch and the line ending of the bound editor's caret, for the IDE status bar. Typing moves the caret on every
 * key, so the snapshot is computed and published at most once per animation frame.
 */
export class EditorStatusService extends SnapshotStore<EditorStatusSnapshot> implements Disposable {
  private editor?: StatusEditor
  private scheduled = false
  private disposed = false
  constructor(private readonly frame: (callback: () => void) => void = callback => { requestAnimationFrame(() => callback()) }) { super(null) }

  bindEditor(instance: StatusEditor): Disposable {
    this.editor = instance
    const changed = () => this.schedule()
    const subscriptions = [instance.onDidChangeCursorPosition(changed), instance.onDidChangeModel(changed), instance.onDidChangeModelContent(changed), instance.onDidChangeModelOptions(changed)]
    this.schedule()
    return { dispose: () => {
      subscriptions.forEach(subscription => subscription.dispose())
      if (this.editor !== instance) return
      this.editor = undefined
      this.schedule()
    } }
  }
  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    this.frame(() => {
      this.scheduled = false
      if (this.disposed) return
      const next = this.read()
      if (!same(next, this.getSnapshot())) this.publish(next)
    })
  }
  private read(): EditorStatusSnapshot {
    const model = this.editor?.getModel(), position = this.editor?.getPosition()
    if (!model || !position) return null
    const column = displayColumn(model.getLineContent(position.lineNumber), position.column, model.getOptions().tabSize)
    return { line: position.lineNumber, column, character: position.column, eol: model.getEOL() === '\r\n' ? 'crlf' : 'lf' }
  }
  dispose(): void {
    this.disposed = true
    this.editor = undefined
    this.clearListeners()
  }
}
