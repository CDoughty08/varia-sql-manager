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
