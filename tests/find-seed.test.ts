import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TestModel } from './fixtures/documents'
import { caretFindSeed } from '../src/renderer/src/editor/find-seed'

/** A model whose getWordAtPosition is Monaco's for SQL: it also reports a word that ends at the position. */
const model = (text: string) => new TestModel(text, 'inmemory://find-seed')
/** The seed with the caret before the `|` in `text`, which is removed. */
function caret(text: string): string | undefined {
  const offset = text.indexOf('|'), before = text.slice(0, offset).split('\n')
  const lineNumber = before.length, column = before.at(-1)!.length + 1
  return caretFindSeed(model(text.replace('|', '')), { startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column })
}

describe('Quick Find seed', () => {
  it('is the word the caret is at the start of', () => {
    expect(caret('select * from |Orders')).toBe('Orders')
    expect(caret('|select 1')).toBe('select')
  })
  it('is the word the caret is inside', () => {
    expect(caret('select * from Ord|ers')).toBe('Orders')
    expect(caret('select * from O|rders where 1 = 1')).toBe('Orders')
  })
  it('is nothing with the caret just after a word, which Monaco would offer', () => {
    expect(caret('select| * from Orders')).toBeUndefined()
    expect(caret('dbo|.Orders')).toBeUndefined()
    expect(model('select * from Orders').getWordAtPosition({ lineNumber: 1, column: 7 })?.word).toBe('select')
  })
  it('is the second word with the caret between two words separated by a space, at its start', () => {
    expect(caret('select |name from t')).toBe('name')
    expect(caret('select  | name')).toBeUndefined()
  })
  it('is nothing at the end of a line, even right after a word', () => {
    expect(caret('select * from Orders|')).toBeUndefined()
    expect(caret('select 1;|\nfrom t')).toBeUndefined()
    expect(caret('select 1|\nfrom t')).toBeUndefined()
    expect(caret('|')).toBeUndefined()
  })
  it('is the word on the right where two words touch at the caret', () => {
    expect(caret('x|-1.5')).toBe('-1.5')
  })
  it('leaves a selection to Monaco, on one line or several', () => {
    const text = model('select * from Orders\nwhere 1 = 1')
    expect(caretFindSeed(text, { startLineNumber: 1, startColumn: 15, endLineNumber: 1, endColumn: 21 })).toBeUndefined()
    expect(caretFindSeed(text, { startLineNumber: 1, startColumn: 15, endLineNumber: 1, endColumn: 16 })).toBeUndefined()
    expect(caretFindSeed(text, { startLineNumber: 1, startColumn: 15, endLineNumber: 2, endColumn: 15 })).toBeUndefined()
    expect(caretFindSeed(text, { startLineNumber: 1, startColumn: 15, endLineNumber: 2, endColumn: 1 })).toBeUndefined()
  })
})

describe('the query editor', () => {
  it("lets Monaco seed only from a selection, since Monaco's 'always' also takes the word that ends at the caret", () => {
    const source = readFileSync(join('src', 'renderer', 'src', 'QueryEditor.tsx'), 'utf8')
    expect(source).toMatch(/find: \{ autoFindInSelection: 'multiline', seedSearchStringFromSelection: 'selection',/)
  })
})
