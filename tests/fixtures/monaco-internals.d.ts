// Monaco modules tests import below its public API, which ships no types for them: only what the tests use.
declare module 'monaco-editor/editor/contrib/snippet/browser/snippetParser.js' {
  export class Marker { toString(): string }
  export class Placeholder extends Marker { readonly index: number; readonly isFinalTabstop: boolean }
  export class Variable extends Marker { readonly name: string }
  export class TextmateSnippet extends Marker { readonly placeholders: Placeholder[]; readonly children: Marker[] }
  export class SnippetParser { parse(value: string, insertFinalTabstop?: boolean, enforceFinalTabstop?: boolean): TextmateSnippet }
}
declare module 'monaco-editor/editor/common/services/editorBaseApi.js' {
  export const KeyMod: { readonly CtrlCmd: number; readonly Shift: number; readonly Alt: number; readonly WinCtrl: number }
}
declare module 'monaco-editor/editor/common/standalone/standaloneEnums.js' {
  export const KeyCode: Readonly<Record<string, number>>
}
declare module 'monaco-editor/base/common/keyCodes.js' {
  export function KeyChord(firstPart: number, secondPart: number): number
}
declare module 'monaco-editor/editor/common/core/range.js' {
  export class Range {
    constructor(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number)
    readonly startLineNumber: number; readonly startColumn: number; readonly endLineNumber: number; readonly endColumn: number
  }
}
declare module 'monaco-editor/editor/common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.js' {
  import type { Range } from 'monaco-editor/editor/common/core/range.js'
  export interface PieceTreeTextBuffer {
    getLineCount(): number
    getLineContent(lineNumber: number): string
    getValueInRange(range: Range): string
    getValueLengthInRange(range: Range): number
    getLinesContent(): string[]
    applyEdits(operations: { range: Range; text: string }[], recordTrimAutoWhitespace: boolean, computeUndoEdits: boolean): { reverseEdits: { range: Range }[] | null }
  }
  export class PieceTreeTextBufferBuilder {
    acceptChunk(chunk: string): void
    finish(normalizeEOL?: boolean): { create(defaultEOL: number): { textBuffer: PieceTreeTextBuffer } }
  }
}
declare module 'monaco-editor/editor/common/core/wordHelper.js' {
  export const DEFAULT_WORD_REGEXP: RegExp
  export function getWordAtText(column: number, wordDefinition: RegExp, text: string, textOffset: number): { word: string; startColumn: number; endColumn: number } | null
}
