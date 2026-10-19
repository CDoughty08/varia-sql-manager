// Edit › Advanced's text commands as pure functions over a minimal model, so they are tested without Monaco. Each
// returns Monaco-shaped edits and the selections to show afterwards; `applyTextOp` applies them as one undo step.

export interface TextRange { readonly startLineNumber: number; readonly startColumn: number; readonly endLineNumber: number; readonly endColumn: number }
/** Monaco's ISelection: the anchor (`selectionStart…`) and the caret (`position…`). */
export interface TextSelection { readonly selectionStartLineNumber: number; readonly selectionStartColumn: number; readonly positionLineNumber: number; readonly positionColumn: number }
export interface TextEdit { readonly range: TextRange; readonly text: string }
/** What text operations read from a model. */
export interface TextModelLike {
  getLineCount(): number
  getLineContent(lineNumber: number): string
  getValueInRange(range: TextRange): string
  getValueLengthInRange(range: TextRange): number
}
export interface TextOp {
  readonly edits: readonly TextEdit[]
  /** The selections afterwards, from the inverse edits Monaco reports (in `edits` order). */
  selections(inverse: readonly { readonly range: TextRange }[]): TextSelection[]
}
export interface IndentOptions { readonly indentSize: number; readonly insertSpaces: boolean }

export const textOpLimits = { characters: 1_000_000, lines: 100_000 } as const
export const tooLargeMessage = 'The selection is too large to change (more than 1,000,000 characters).'

const rangeOf = (selection: TextSelection): TextRange => {
  const forward = selection.selectionStartLineNumber < selection.positionLineNumber
    || (selection.selectionStartLineNumber === selection.positionLineNumber && selection.selectionStartColumn <= selection.positionColumn)
  return forward
    ? { startLineNumber: selection.selectionStartLineNumber, startColumn: selection.selectionStartColumn, endLineNumber: selection.positionLineNumber, endColumn: selection.positionColumn }
    : { startLineNumber: selection.positionLineNumber, startColumn: selection.positionColumn, endLineNumber: selection.selectionStartLineNumber, endColumn: selection.selectionStartColumn }
}
const isEmpty = (range: TextRange) => range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn
const reversed = (selection: TextSelection) => rangeOf(selection).startLineNumber !== selection.selectionStartLineNumber || rangeOf(selection).startColumn !== selection.selectionStartColumn
const select = (range: TextRange, backwards: boolean): TextSelection => backwards
  ? { selectionStartLineNumber: range.endLineNumber, selectionStartColumn: range.endColumn, positionLineNumber: range.startLineNumber, positionColumn: range.startColumn }
  : { selectionStartLineNumber: range.startLineNumber, selectionStartColumn: range.startColumn, positionLineNumber: range.endLineNumber, positionColumn: range.endColumn }
const caret = (lineNumber: number, column: number): TextSelection => ({ selectionStartLineNumber: lineNumber, selectionStartColumn: column, positionLineNumber: lineNumber, positionColumn: column })

/** Throws the size error when the selections hold more than the limits; checked before any text is read. */
export function checkSelectionSize(model: Pick<TextModelLike, 'getValueLengthInRange'>, selections: readonly TextSelection[]): void {
  let characters = 0, lines = 0
  for (const selection of selections) {
    const range = rangeOf(selection)
    lines += range.endLineNumber - range.startLineNumber + 1
    characters += model.getValueLengthInRange(range)
    if (characters > textOpLimits.characters || lines > textOpLimits.lines) throw new Error(tooLargeMessage)
  }
}

/**
 * Make Uppercase and Make Lowercase, as Visual Studio's Edit.MakeUppercase: each non-empty selection changes and stays
 * selected over the new text (which can be longer: 'ß' becomes 'SS'); an empty one changes the character after the caret
 * and moves past it. `toUpperCase` with no locale argument behaves the same in every locale except for its default, so
 * the result does not depend on the user's.
 */
export function caseEdits(model: TextModelLike, selections: readonly TextSelection[], mode: 'upper' | 'lower'): TextOp {
  checkSelectionSize(model, selections)
  const convert = (text: string) => mode === 'upper' ? text.toUpperCase() : text.toLowerCase()
  const edits: TextEdit[] = []
  // Each selection's result: the index of its edit, or the selection to keep when nothing changes.
  const plan: ({ edit: number; backwards: boolean; caret: boolean } | { keep: TextSelection })[] = []
  for (const selection of selections) {
    let range = rangeOf(selection), wasCaret = false
    if (isEmpty(range)) {
      const line = model.getLineContent(range.startLineNumber), offset = range.startColumn - 1
      if (offset >= line.length) { plan.push({ keep: selection }); continue }
      // A whole code point, so a surrogate pair is never split.
      const length = String.fromCodePoint(line.codePointAt(offset)!).length
      range = { ...range, endColumn: range.startColumn + length }
      wasCaret = true
    }
    const text = model.getValueInRange(range), next = convert(text)
    if (next === text) { plan.push({ keep: wasCaret ? caret(range.endLineNumber, range.endColumn) : selection }); continue }
    plan.push({ edit: edits.length, backwards: reversed(selection), caret: wasCaret })
    edits.push({ range, text: next })
  }
  return {
    edits,
    selections: inverse => plan.map(item => {
      if ('keep' in item) return item.keep
      const range = inverse[item.edit]?.range
      if (!range) return caret(1, 1)
      return item.caret ? caret(range.endLineNumber, range.endColumn) : select(range, item.backwards)
    })
  }
}

/** The lines a selection's line commands act on: a multi-line selection that ends at column 1 leaves out its last line. */
function selectedLines(selection: TextSelection): number[] {
  const range = rangeOf(selection)
  const last = range.endLineNumber > range.startLineNumber && range.endColumn === 1 ? range.endLineNumber - 1 : range.endLineNumber
  return Array.from({ length: last - range.startLineNumber + 1 }, (_, index) => range.startLineNumber + index)
}

/**
 * SSMS's Increase and Decrease Line Indent: every line a selection touches, a caret's included, gains one indent unit at
 * column 1 (a tab, or `indentSize` spaces) or loses one (a leading tab, or up to `indentSize` leading spaces). Empty
 * lines are skipped when more than one line is affected. Selections move with their text.
 */
export function indentEdits(model: TextModelLike, selections: readonly TextSelection[], options: IndentOptions, mode: 'increase' | 'decrease'): TextOp {
  checkSelectionSize(model, selections)
  const lines = [...new Set(selections.flatMap(selectedLines))].sort((a, b) => a - b)
  const unit = options.insertSpaces ? ' '.repeat(options.indentSize) : '\t'
  const delta = new Map<number, number>(), edits: TextEdit[] = []
  for (const lineNumber of lines) {
    const content = model.getLineContent(lineNumber)
    if (lines.length > 1 && !content.length) continue
    if (mode === 'increase') {
      edits.push({ range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 1 }, text: unit })
      delta.set(lineNumber, unit.length)
      continue
    }
    let remove = 0
    if (content.startsWith('\t')) remove = 1
    else while (remove < options.indentSize && content[remove] === ' ') remove++
    if (!remove) continue
    edits.push({ range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 1 + remove }, text: '' })
    delta.set(lineNumber, -remove)
  }
  const move = (lineNumber: number, column: number, anchorOfLines: boolean) => {
    const change = delta.get(lineNumber)
    if (!change) return column
    // A selection of whole lines keeps starting at column 1, so it still covers the indent it gained.
    if (change > 0) return anchorOfLines && column === 1 ? 1 : column + change
    return Math.max(1, column + change)
  }
  return {
    edits,
    selections: () => selections.map(selection => {
      const range = rangeOf(selection), whole = !isEmpty(range)
      const start = { lineNumber: range.startLineNumber, column: move(range.startLineNumber, range.startColumn, whole) }
      const end = { lineNumber: range.endLineNumber, column: move(range.endLineNumber, range.endColumn, false) }
      return select({ startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, reversed(selection))
    })
  }
}

/** The editor calls `applyTextOp` makes. */
export interface TextOpEditor {
  pushUndoStop(): boolean
  executeEdits(source: string, edits: { range: TextRange; text: string }[], endCursorState: (inverse: { readonly range: TextRange }[]) => null): boolean
  setSelections(selections: readonly TextSelection[]): void
}
/** Applies `op` as one undo step, then selects what it says; with no edits, only the selections change. */
export function applyTextOp(editor: TextOpEditor, source: string, op: TextOp): void {
  let after = op.edits.length ? undefined : op.selections([])
  if (op.edits.length) {
    editor.pushUndoStop()
    editor.executeEdits(source, op.edits.map(edit => ({ range: edit.range, text: edit.text })), inverse => { after = op.selections(inverse); return null })
    editor.pushUndoStop()
  }
  if (after?.length) editor.setSelections(after)
}
