// Monaco modules the public API does not export. Only src/renderer/src/core/input-mode.ts imports them, and
// tests/editor-status.test.ts checks their shape, so an upgrade that changes them fails a test rather than the editor.
declare module 'monaco-editor/editor/common/inputMode.js' {
  /** Insert or overtype: one mode for every editor, which the cursor reads as it types. */
  export const InputMode: unknown
}
