import { describe, expect, it, vi } from 'vitest'
import { applyTextOp, caseEdits, indentEdits, textOpLimits, tooLargeMessage, type TextEdit, type TextModelLike, type TextRange, type TextSelection } from '../src/renderer/src/editor/text-ops'

/** A model over plain text, and Monaco's applyEdits with its inverse ranges, so end selections can be checked. */
function model(text: string) {
  let lines = text.split('\n')
  const offset = (line: number, column: number) => lines.slice(0, line - 1).reduce((total, value) => total + value.length + 1, 0) + column - 1
  const position = (at: number, value = lines.join('\n')) => {
    const before = value.slice(0, at).split('\n')
    return { lineNumber: before.length, column: before.at(-1)!.length + 1 }
  }
  const value: TextModelLike & { text(): string; apply(edits: readonly TextEdit[]): { range: TextRange }[] } = {
    getLineCount: () => lines.length,
    getLineContent: line => lines[line - 1],
    getValueInRange: range => lines.join('\n').slice(offset(range.startLineNumber, range.startColumn), offset(range.endLineNumber, range.endColumn)),
    getValueLengthInRange: range => offset(range.endLineNumber, range.endColumn) - offset(range.startLineNumber, range.startColumn),
    text: () => lines.join('\n'),
    apply: edits => {
      // Edits never overlap; applied last first, the inverse ranges are where each new text ends up.
      let current = lines.join('\n')
      const sorted = edits.map((edit, index) => ({ edit, index, start: offset(edit.range.startLineNumber, edit.range.startColumn), end: offset(edit.range.endLineNumber, edit.range.endColumn) }))
        .sort((a, b) => b.start - a.start)
      for (const { edit, start, end } of sorted) current = current.slice(0, start) + edit.text + current.slice(end)
      const inverse: { range: TextRange }[] = []
      for (const item of sorted) {
        const shift = sorted.filter(other => other.start < item.start).reduce((total, other) => total + other.edit.text.length - (other.end - other.start), 0)
        const start = position(item.start + shift, current), end = position(item.start + shift + item.edit.text.length, current)
        inverse[item.index] = { range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column } }
      }
      lines = current.split('\n')
      return inverse
    }
  }
  return value
}
const selection = (startLine: number, startColumn: number, endLine = startLine, endColumn = startColumn): TextSelection =>
  ({ selectionStartLineNumber: startLine, selectionStartColumn: startColumn, positionLineNumber: endLine, positionColumn: endColumn })
/** Runs an operation as the editor would and returns the text and selections afterwards. */
function run(text: string, op: (target: ReturnType<typeof model>) => ReturnType<typeof caseEdits>) {
  const target = model(text), result = op(target)
  const selections = result.selections(target.apply(result.edits))
  return { text: target.text(), selections, edits: result.edits }
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
      executeEdits: (source: string, edits: { range: TextRange; text: string }[], end: (inverse: { range: TextRange }[]) => null) => { calls.push(source); end(target.apply(edits)); return true },
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
