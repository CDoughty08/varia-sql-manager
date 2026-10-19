import type { IPosition, IRange } from 'monaco-editor'

/** The part of Monaco's text model the seed reads: the word at a position, which may end there. */
export interface WordSource {
  getWordAtPosition(position: IPosition): { readonly word: string; readonly startColumn: number; readonly endColumn: number } | null
}

/**
 * The word Quick Find and Quick Replace start from when nothing is selected, as SSMS's do: the word the caret is at the
 * start of or inside, that is, the one the character after the caret belongs to. A caret just after a word (Monaco's
 * word at the position, which SSMS ignores) or between non-word characters gives undefined, and the find box keeps its
 * previous text. A selection gives undefined too: Monaco seeds a single-line one itself (seedSearchStringFromSelection:
 * 'selection'), and searches in a multi-line one.
 */
export function caretFindSeed(model: WordSource, selection: IRange): string | undefined {
  const { startLineNumber: lineNumber, startColumn: column } = selection
  if (lineNumber !== selection.endLineNumber || column !== selection.endColumn) return undefined
  const word = model.getWordAtPosition({ lineNumber, column })
  if (!word) return undefined
  if (column < word.endColumn) return word.word
  // Monaco reports the word on the left when two touch (x-1.5): the one on the right starts at the caret.
  const next = model.getWordAtPosition({ lineNumber, column: column + 1 })
  return next && next.startColumn === column ? next.word : undefined
}
