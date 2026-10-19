import { describe, expect, it, vi } from 'vitest'
import { Range } from 'monaco-editor/editor/common/core/range.js'
import { PieceTreeTextBufferBuilder } from 'monaco-editor/editor/common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.js'
import { applyTextOp, caseEdits, indentEdits, textOpLimits, tooLargeMessage, type TextEdit, type TextModelLike, type TextRange, type TextSelection } from '../src/renderer/src/editor/text-ops'

/**
 * A model over Monaco's own text buffer, so edits apply as the editor applies them: touching ranges keep their reverse
 * edits in document order, and 1,000 or more edits merge into one.
 */
function model(text: string) {
  const builder = new PieceTreeTextBufferBuilder()
  builder.acceptChunk(text)
  const buffer = builder.finish(true).create(1).textBuffer
  const range = (value: TextRange) => new Range(value.startLineNumber, value.startColumn, value.endLineNumber, value.endColumn)
  const value: TextModelLike & { text(): string; apply(edits: readonly TextEdit[]): void } = {
    getLineCount: () => buffer.getLineCount(),
    getLineContent: line => buffer.getLineContent(line),
    getValueInRange: value => buffer.getValueInRange(range(value)),
    getValueLengthInRange: value => buffer.getValueLengthInRange(range(value)),
    text: () => buffer.getLinesContent().join('\n'),
    apply: edits => { buffer.applyEdits(edits.map(edit => ({ range: range(edit.range), text: edit.text })), false, true) }
  }
  return value
}
const selection = (startLine: number, startColumn: number, endLine = startLine, endColumn = startColumn): TextSelection =>
  ({ selectionStartLineNumber: startLine, selectionStartColumn: startColumn, positionLineNumber: endLine, positionColumn: endColumn })
/** Runs an operation as the editor would and returns the text and selections afterwards. */
function run(text: string, op: (target: ReturnType<typeof model>) => ReturnType<typeof caseEdits>) {
  const target = model(text), result = op(target)
  target.apply(result.edits)
  return { text: target.text(), selections: result.selections, edits: result.edits }
}

describe('Make Uppercase and Make Lowercase', () => {
  it('change each selection and keep it selected', () => {
    const result = run('select a, b from t', target => caseEdits(target, [selection(1, 1, 1, 7), selection(1, 13, 1, 17)], 'upper'))
    expect(result.text).toBe('SELECT a, b FROM t')
    expect(result.selections).toEqual([selection(1, 1, 1, 7), selection(1, 13, 1, 17)])
    expect(run('SELECT X', target => caseEdits(target, [selection(1, 1, 1, 9)], 'lower')).text).toBe('select x')
  })
  it('keep a backwards selection backwards, and one across lines', () => {
    const result = run('abc\ndef', target => caseEdits(target, [selection(2, 3, 1, 2)], 'upper'))
    expect(result.text).toBe('aBC\nDEf')
    expect(result.selections).toEqual([selection(2, 3, 1, 2)])
  })
  // Visual Studio's Edit.MakeUppercase (Microsoft's docs: "if there's no selection, changes the character at the insertion point").
  it('change the character after an empty selection and move the caret past it, as Visual Studio does', () => {
    const result = run('select', target => caseEdits(target, [selection(1, 1)], 'upper'))
    expect(result.text).toBe('Select')
    expect(result.selections).toEqual([selection(1, 2)])
    // Already uppercase: no edit, but the caret still moves; at the end of a line nothing happens.
    const same = run('Ab', target => caseEdits(target, [selection(1, 1), selection(1, 3)], 'upper'))
    expect([same.text, same.edits, same.selections]).toEqual(['Ab', [], [selection(1, 2), selection(1, 3)]])
  })
  it("cover the longer text when a character grows ('ß' becomes 'SS')", () => {
    const result = run('straße x', target => caseEdits(target, [selection(1, 1, 1, 7)], 'upper'))
    expect(result.text).toBe('STRASSE x')
    expect(result.selections).toEqual([selection(1, 1, 1, 8)])
    const caret = run('ßa', target => caseEdits(target, [selection(1, 1)], 'upper'))
    expect([caret.text, caret.selections]).toEqual(['SSa', [selection(1, 3)]])
  })
  // Monaco keeps the reverse edits of touching ranges in document order, not in the order the edits were given.
  it('place each selection by its own text when the ranges touch', () => {
    // The primary selection is 'bc', and a second caret sits before 'a'.
    const result = run('abcd', target => caseEdits(target, [selection(1, 2, 1, 4), selection(1, 1)], 'upper'))
    expect(result.text).toBe('ABCd')
    expect(result.selections).toEqual([selection(1, 2, 1, 4), selection(1, 2)])
  })
  it('move a selection that needs no change past an earlier one that grew', () => {
    const result = run('ß ABC', target => caseEdits(target, [selection(1, 1, 1, 2), selection(1, 3, 1, 6)], 'upper'))
    expect(result.text).toBe('SS ABC')
    expect(result.selections).toEqual([selection(1, 1, 1, 3), selection(1, 4, 1, 7)])
    const carets = run('ß1', target => caseEdits(target, [selection(1, 1), selection(1, 2)], 'upper'))
    expect([carets.text, carets.selections]).toEqual(['SS1', [selection(1, 3), selection(1, 4)]])
    // Across lines: only the columns on the lines that changed move.
    const lines = run('aß\nßB c', target => caseEdits(target, [selection(1, 2, 2, 2), selection(2, 2, 2, 4), selection(2, 4)], 'upper'))
    expect(lines.text).toBe('aSS\nSSB C')
    expect(lines.selections).toEqual([selection(1, 2, 2, 3), selection(2, 3, 2, 5), selection(2, 6)])
    // A CRLF model: a selection's text holds the model's line break.
    const crlf = run('ß\r\nßb', target => caseEdits(target, [selection(1, 1, 2, 2), selection(2, 3)], 'upper'))
    expect([crlf.text, crlf.selections]).toEqual(['SS\nSSb', [selection(1, 1, 2, 3), selection(2, 4)]])
  })
  // Monaco merges 1,000 or more edits into one, with a single reverse edit.
  it('keep a column selection over 1,000 lines as 1,000 selections', () => {
    const count = 1_000, columns = Array.from({ length: count }, (_, index) => selection(index + 1, 1, index + 1, 5))
    const result = run(Array(count).fill('abcdef').join('\n'), target => caseEdits(target, columns, 'upper'))
    expect(result.text).toBe(Array(count).fill('ABCDef').join('\n'))
    expect(result.selections).toEqual(columns)
  })
  it('leave surrogate pairs whole and unchanged', () => {
    const result = run('𝒶b', target => caseEdits(target, [selection(1, 1)], 'upper'))
    expect([result.text, result.edits, result.selections]).toEqual(['𝒶b', [], [selection(1, 3)]])
    expect(run('a😀b', target => caseEdits(target, [selection(1, 1, 1, 5)], 'upper')).text).toBe('A😀B')
  })
})

describe('Increase and Decrease Line Indent', () => {
  const tabs = { indentSize: 4, insertSpaces: false }, spaces = { indentSize: 4, insertSpaces: true }
  it('add a tab or indent-size spaces at column 1 of every selected line', () => {
    expect(run('a\nb\nc', target => indentEdits(target, [selection(1, 1, 2, 2)], tabs, 'increase')).text).toBe('\ta\n\tb\nc')
    expect(run('a\nb', target => indentEdits(target, [selection(1, 1, 2, 2)], spaces, 'increase')).text).toBe('    a\n    b')
  })
  it('indent the caret line alone, unlike Tab, and move the caret with its text', () => {
    const result = run('select\nx', target => indentEdits(target, [selection(1, 4)], tabs, 'increase'))
    expect(result.text).toBe('\tselect\nx')
    expect(result.selections).toEqual([selection(1, 5)])
  })
  it('remove a leading tab, or up to indent-size leading spaces', () => {
    expect(run('\t\ta\n      b\n   c\nd', target => indentEdits(target, [selection(1, 1, 4, 2)], tabs, 'decrease')).text).toBe('\ta\n  b\nc\nd')
    // Mixed leading whitespace: the spaces before a tab go first, then the tab.
    expect(run('  \tx', target => indentEdits(target, [selection(1, 1)], spaces, 'decrease')).text).toBe('\tx')
    expect(run('\t  x', target => indentEdits(target, [selection(1, 1)], spaces, 'decrease')).text).toBe('  x')
  })
  it('leave out the last line of a selection that ends at column 1', () => {
    const result = run('a\nb\nc', target => indentEdits(target, [selection(1, 1, 3, 1)], tabs, 'increase'))
    expect(result.text).toBe('\ta\n\tb\nc')
    // Whole lines stay selected, the indent included.
    expect(result.selections).toEqual([selection(1, 1, 3, 1)])
  })
  it('skip empty lines when more than one line is affected, but indent a lone empty line', () => {
    expect(run('a\n\nb', target => indentEdits(target, [selection(1, 1, 3, 2)], tabs, 'increase')).text).toBe('\ta\n\n\tb')
    expect(run('', target => indentEdits(target, [selection(1, 1)], tabs, 'increase')).text).toBe('\t')
  })
  it('act once on a line two selections share, and move each with its text', () => {
    const result = run('    abc', target => indentEdits(target, [selection(1, 5), selection(1, 7)], spaces, 'decrease'))
    expect(result.text).toBe('abc')
    expect(result.selections).toEqual([selection(1, 1), selection(1, 3)])
  })
})

describe('text operation limits', () => {
  it('refuse more than 1,000,000 selected characters or 100,000 lines before reading any text', () => {
    const big: TextModelLike = { getLineCount: () => 200_000, getLineContent: vi.fn(() => 'x'), getValueInRange: vi.fn(() => ''), getValueLengthInRange: range => (range.endLineNumber - range.startLineNumber + 1) * 10 }
    expect(() => caseEdits(big, [selection(1, 1, 100_001, 1)], 'upper')).toThrow(tooLargeMessage)
    expect(() => indentEdits(big, [selection(1, 1, 50_000, 1), selection(50_001, 1, 100_001, 1)], { indentSize: 4, insertSpaces: false }, 'increase')).toThrow(tooLargeMessage)
    expect(big.getValueInRange).not.toHaveBeenCalled()
    expect(big.getLineContent).not.toHaveBeenCalled()
    const long: TextModelLike = { ...big, getValueLengthInRange: () => textOpLimits.characters / 2 + 1 }
    // Two selections together are over the limit though each is under it.
    expect(() => caseEdits(long, [selection(1, 1, 1, 2), selection(2, 1, 2, 2)], 'lower')).toThrow(tooLargeMessage)
    expect(tooLargeMessage).toBe('The selection is too large to change (more than 1,000,000 characters).')
  })
})

describe('applying a text operation', () => {
  it('is one undo step with the selections the operation computes', () => {
    const target = model('select'), calls: string[] = []
    const editor = {
      pushUndoStop: () => { calls.push('stop'); return true },
      executeEdits: (source: string, edits: { range: TextRange; text: string }[], end: () => null) => { calls.push(source); target.apply(edits); end(); return true },
      setSelections: (value: readonly TextSelection[]) => { calls.push(JSON.stringify(value)) }
    }
    applyTextOp(editor, 'varia.makeUppercase', caseEdits(target, [selection(1, 1, 1, 7)], 'upper'))
    expect(calls).toEqual(['stop', 'varia.makeUppercase', 'stop', JSON.stringify([selection(1, 1, 1, 7)])])
    expect(target.text()).toBe('SELECT')
    calls.length = 0
    // Nothing to change: no undo step, only the caret moves.
    applyTextOp(editor, 'varia.makeUppercase', caseEdits(target, [selection(1, 1)], 'upper'))
    expect(calls).toEqual([JSON.stringify([selection(1, 2)])])
  })
})
