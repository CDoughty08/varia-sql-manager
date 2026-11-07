// Generated from monaco-editor 0.57.0 by tests/monaco-keybindings.test.ts (tests/fixtures/monaco-runtime.ts). Do not edit.
// Regenerate after a Monaco upgrade or a change to start.tsx's Monaco imports: npx vitest run tests/monaco-keybindings.test.ts -u
import type { Platform } from './keybindings'

/**
 * One of Monaco's default keybinding rules in the modules Varia's editor loads. `keys` lists each platform's
 * keybindings in canonical chords (primary first); an empty list means the rule has no key there. `when` is Monaco's
 * own clause, and `args` the arguments its rule passes. Rules for widgets Varia never opens, or keys that act only
 * inside a Monaco widget, are left out (`omittedContextKeys` in the generator).
 */
export interface MonacoKeyRule {
  readonly command: string
  readonly title?: string
  readonly when?: string
  readonly args?: unknown
  readonly keys: Readonly<Record<Platform, readonly (readonly string[])[]>>
}

export const monacoKeysVersion = '0.57.0'

export const monacoKeyRules: readonly MonacoKeyRule[] = [
  { command: 'undo', keys: { win32: [['ctrl+z']], linux: [['ctrl+z']], darwin: [['meta+z']] } },
  { command: 'redo', keys: { win32: [['ctrl+y'], ['ctrl+shift+z']], linux: [['ctrl+y'], ['ctrl+shift+z']], darwin: [['shift+meta+z']] } },
  { command: 'editor.action.selectAll', keys: { win32: [['ctrl+a']], linux: [['ctrl+a']], darwin: [['meta+a']] } },
  { command: 'cursorColumnSelectLeft', when: 'textInputFocus', keys: { win32: [['ctrl+shift+alt+left']], linux: [], darwin: [['shift+alt+meta+left']] } },
  { command: 'cursorColumnSelectRight', when: 'textInputFocus', keys: { win32: [['ctrl+shift+alt+right']], linux: [], darwin: [['shift+alt+meta+right']] } },
  { command: 'cursorColumnSelectUp', when: 'textInputFocus', keys: { win32: [['ctrl+shift+alt+up']], linux: [], darwin: [['shift+alt+meta+up']] } },
  { command: 'cursorColumnSelectPageUp', when: 'textInputFocus', keys: { win32: [['ctrl+shift+alt+pageup']], linux: [], darwin: [['shift+alt+meta+pageup']] } },
  { command: 'cursorColumnSelectDown', when: 'textInputFocus', keys: { win32: [['ctrl+shift+alt+down']], linux: [], darwin: [['shift+alt+meta+down']] } },
  { command: 'cursorColumnSelectPageDown', when: 'textInputFocus', keys: { win32: [['ctrl+shift+alt+pagedown']], linux: [], darwin: [['shift+alt+meta+pagedown']] } },
  { command: 'cursorLeft', when: 'textInputFocus', keys: { win32: [['left']], linux: [['left']], darwin: [['left'], ['ctrl+b']] } },
  { command: 'cursorLeftSelect', when: 'textInputFocus', keys: { win32: [['shift+left']], linux: [['shift+left']], darwin: [['shift+left']] } },
  { command: 'cursorRight', when: 'textInputFocus', keys: { win32: [['right']], linux: [['right']], darwin: [['right'], ['ctrl+f']] } },
  { command: 'cursorRightSelect', when: 'textInputFocus', keys: { win32: [['shift+right']], linux: [['shift+right']], darwin: [['shift+right']] } },
  { command: 'cursorUp', when: 'textInputFocus', keys: { win32: [['up']], linux: [['up']], darwin: [['up'], ['ctrl+p']] } },
  { command: 'cursorUpSelect', when: 'textInputFocus', keys: { win32: [['shift+up'], ['ctrl+shift+up']], linux: [['shift+up']], darwin: [['shift+up']] } },
  { command: 'cursorPageUp', when: 'textInputFocus', keys: { win32: [['pageup']], linux: [['pageup']], darwin: [['pageup']] } },
  { command: 'cursorPageUpSelect', when: 'textInputFocus', keys: { win32: [['shift+pageup']], linux: [['shift+pageup']], darwin: [['shift+pageup']] } },
  { command: 'cursorDown', when: 'textInputFocus', keys: { win32: [['down']], linux: [['down']], darwin: [['down'], ['ctrl+n']] } },
  { command: 'cursorDownSelect', when: 'textInputFocus', keys: { win32: [['shift+down'], ['ctrl+shift+down']], linux: [['shift+down']], darwin: [['shift+down']] } },
  { command: 'cursorPageDown', when: 'textInputFocus', keys: { win32: [['pagedown']], linux: [['pagedown']], darwin: [['pagedown']] } },
  { command: 'cursorPageDownSelect', when: 'textInputFocus', keys: { win32: [['shift+pagedown']], linux: [['shift+pagedown']], darwin: [['shift+pagedown']] } },
  { command: 'cursorHome', when: 'textInputFocus', keys: { win32: [['home']], linux: [['home']], darwin: [['home'], ['meta+left']] } },
  { command: 'cursorHomeSelect', when: 'textInputFocus', keys: { win32: [['shift+home']], linux: [['shift+home']], darwin: [['shift+home'], ['shift+meta+left']] } },
  { command: 'cursorLineStart', when: 'textInputFocus', keys: { win32: [], linux: [], darwin: [['ctrl+a']] } },
  { command: 'cursorLineStartSelect', when: 'textInputFocus', keys: { win32: [], linux: [], darwin: [['ctrl+shift+a']] } },
  { command: 'cursorEnd', when: 'textInputFocus', args: { sticky: false }, keys: { win32: [['end']], linux: [['end']], darwin: [['end'], ['meta+right']] } },
  { command: 'cursorEndSelect', when: 'textInputFocus', args: { sticky: false }, keys: { win32: [['shift+end']], linux: [['shift+end']], darwin: [['shift+end'], ['shift+meta+right']] } },
  { command: 'cursorLineEnd', when: 'textInputFocus', keys: { win32: [], linux: [], darwin: [['ctrl+e']] } },
  { command: 'cursorLineEndSelect', when: 'textInputFocus', keys: { win32: [], linux: [], darwin: [['ctrl+shift+e']] } },
  { command: 'cursorTop', when: 'textInputFocus', keys: { win32: [['ctrl+home']], linux: [['ctrl+home']], darwin: [['meta+up']] } },
  { command: 'cursorTopSelect', when: 'textInputFocus', keys: { win32: [['ctrl+shift+home']], linux: [['ctrl+shift+home']], darwin: [['shift+meta+up']] } },
  { command: 'cursorBottom', when: 'textInputFocus', keys: { win32: [['ctrl+end']], linux: [['ctrl+end']], darwin: [['meta+down']] } },
  { command: 'cursorBottomSelect', when: 'textInputFocus', keys: { win32: [['ctrl+shift+end']], linux: [['ctrl+shift+end']], darwin: [['shift+meta+down']] } },
  { command: 'scrollLineUp', when: 'textInputFocus', keys: { win32: [['ctrl+up']], linux: [['ctrl+up']], darwin: [['ctrl+pageup']] } },
  { command: 'scrollPageUp', when: 'textInputFocus', keys: { win32: [['alt+pageup']], linux: [['alt+pageup']], darwin: [['meta+pageup']] } },
  { command: 'scrollLineDown', when: 'textInputFocus', keys: { win32: [['ctrl+down']], linux: [['ctrl+down']], darwin: [['ctrl+pagedown']] } },
  { command: 'scrollPageDown', when: 'textInputFocus', keys: { win32: [['alt+pagedown']], linux: [['alt+pagedown']], darwin: [['meta+pagedown']] } },
  { command: 'cancelSelection', when: 'editorHasSelection && textInputFocus', keys: { win32: [['escape'], ['shift+escape']], linux: [['escape'], ['shift+escape']], darwin: [['escape'], ['shift+escape']] } },
  { command: 'removeSecondaryCursors', when: 'editorHasMultipleSelections && textInputFocus', keys: { win32: [['escape'], ['shift+escape']], linux: [['escape'], ['shift+escape']], darwin: [['escape'], ['shift+escape']] } },
  { command: 'lineBreakInsert', when: 'textInputFocus && !editorReadonly', keys: { win32: [], linux: [], darwin: [['ctrl+o']] } },
  { command: 'outdent', when: 'editorTextFocus && !editorReadonly && !editorTabMovesFocus', keys: { win32: [['shift+tab']], linux: [['shift+tab']], darwin: [['shift+tab']] } },
  { command: 'tab', when: 'editorTextFocus && !editorReadonly && !editorTabMovesFocus', keys: { win32: [['tab']], linux: [['tab']], darwin: [['tab']] } },
  { command: 'deleteLeft', when: 'textInputFocus', keys: { win32: [['backspace'], ['shift+backspace']], linux: [['backspace'], ['shift+backspace']], darwin: [['backspace'], ['shift+backspace'], ['ctrl+h'], ['ctrl+backspace']] } },
  { command: 'deleteRight', when: 'textInputFocus', keys: { win32: [['delete']], linux: [['delete']], darwin: [['delete'], ['ctrl+d'], ['ctrl+delete']] } },
  { command: 'actions.find', title: 'Find', when: 'editorFocus || editorIsOpen', keys: { win32: [['ctrl+f']], linux: [['ctrl+f']], darwin: [['meta+f']] } },
  { command: 'editor.action.nextMatchFindAction', title: 'Find Next', when: 'editorFocus', keys: { win32: [['f3']], linux: [['f3']], darwin: [['meta+g'], ['f3']] } },
  { command: 'editor.action.previousMatchFindAction', title: 'Find Previous', when: 'editorFocus', keys: { win32: [['shift+f3']], linux: [['shift+f3']], darwin: [['shift+meta+g'], ['shift+f3']] } },
  { command: 'editor.action.startFindReplaceAction', title: 'Replace', when: 'editorFocus || editorIsOpen', keys: { win32: [['ctrl+h']], linux: [['ctrl+h']], darwin: [['alt+meta+f']] } },
  { command: 'actions.findWithSelection', title: 'Find with Selection', keys: { win32: [], linux: [], darwin: [['meta+e']] } },
  { command: 'editor.action.nextSelectionMatchFindAction', title: 'Find Next Selection', when: 'editorFocus', keys: { win32: [['ctrl+f3']], linux: [['ctrl+f3']], darwin: [['meta+f3']] } },
  { command: 'editor.action.previousSelectionMatchFindAction', title: 'Find Previous Selection', when: 'editorFocus', keys: { win32: [['ctrl+shift+f3']], linux: [['ctrl+shift+f3']], darwin: [['shift+meta+f3']] } },
  { command: 'closeFindWidget', when: 'editorFocus && findWidgetVisible', keys: { win32: [['escape'], ['shift+escape']], linux: [['escape'], ['shift+escape']], darwin: [['escape'], ['shift+escape']] } },
  { command: 'toggleFindCaseSensitive', when: 'editorFocus', keys: { win32: [['alt+c']], linux: [['alt+c']], darwin: [['alt+meta+c']] } },
  { command: 'toggleFindWholeWord', when: 'editorFocus', keys: { win32: [['alt+w']], linux: [['alt+w']], darwin: [['alt+meta+w']] } },
  { command: 'toggleFindRegex', when: 'editorFocus', keys: { win32: [['alt+r']], linux: [['alt+r']], darwin: [['alt+meta+r']] } },
  { command: 'toggleFindInSelection', when: 'editorFocus', keys: { win32: [['alt+l']], linux: [['alt+l']], darwin: [['alt+meta+l']] } },
  { command: 'togglePreserveCase', when: 'editorFocus', keys: { win32: [['alt+p']], linux: [['alt+p']], darwin: [['alt+meta+p']] } },
  { command: 'editor.action.replaceOne', when: 'editorFocus && findWidgetVisible', keys: { win32: [['ctrl+shift+1']], linux: [['ctrl+shift+1']], darwin: [['shift+meta+1']] } },
  { command: 'editor.action.replaceAll', when: 'editorFocus && findWidgetVisible', keys: { win32: [['ctrl+alt+enter']], linux: [['ctrl+alt+enter']], darwin: [['alt+meta+enter']] } },
  { command: 'editor.action.selectAllMatches', when: 'editorFocus && findWidgetVisible', keys: { win32: [['alt+enter']], linux: [['alt+enter']], darwin: [['alt+enter']] } },
  { command: 'editor.action.clipboardCutAction', keys: { win32: [['ctrl+x'], ['shift+delete']], linux: [['ctrl+x']], darwin: [['meta+x']] } },
  { command: 'editor.action.clipboardCopyAction', keys: { win32: [['ctrl+c'], ['ctrl+insert']], linux: [['ctrl+c']], darwin: [['meta+c']] } },
  { command: 'editor.action.clipboardPasteAction', keys: { win32: [['ctrl+v'], ['shift+insert']], linux: [['ctrl+v'], ['shift+insert']], darwin: [['meta+v']] } },
  { command: 'editor.action.showContextMenu', title: 'Show Editor Context Menu', when: 'textInputFocus', keys: { win32: [['shift+f10']], linux: [['shift+f10']], darwin: [['shift+f10']] } },
  { command: 'editor.action.commentLine', title: 'Toggle Line Comment', when: 'editorTextFocus && !editorReadonly', keys: { win32: [['ctrl+/']], linux: [['ctrl+/']], darwin: [['meta+/']] } },
  { command: 'editor.action.addCommentLine', title: 'Add Line Comment', when: 'editorTextFocus && !editorReadonly', keys: { win32: [['ctrl+k', 'ctrl+c']], linux: [['ctrl+k', 'ctrl+c']], darwin: [['meta+k', 'meta+c']] } },
  { command: 'editor.action.removeCommentLine', title: 'Remove Line Comment', when: 'editorTextFocus && !editorReadonly', keys: { win32: [['ctrl+k', 'ctrl+u']], linux: [['ctrl+k', 'ctrl+u']], darwin: [['meta+k', 'meta+u']] } },
  { command: 'editor.action.blockComment', title: 'Toggle Block Comment', when: 'editorTextFocus && !editorReadonly', keys: { win32: [['shift+alt+a']], linux: [['ctrl+shift+a']], darwin: [['shift+alt+a']] } },
  { command: 'editor.action.jumpToBracket', title: 'Go to Bracket', when: 'editorTextFocus', keys: { win32: [['ctrl+shift+\\']], linux: [['ctrl+shift+\\']], darwin: [['shift+meta+\\']] } },
  { command: 'editor.action.removeBrackets', title: 'Remove Brackets', when: 'editorTextFocus', keys: { win32: [['ctrl+alt+backspace']], linux: [['ctrl+alt+backspace']], darwin: [['alt+meta+backspace']] } },
  { command: 'cursorWordLeft', when: 'textInputFocus && !accessibilityModeEnabled', keys: { win32: [['ctrl+left']], linux: [['ctrl+left']], darwin: [['alt+left']] } },
  { command: 'cursorWordLeftSelect', when: 'textInputFocus && !accessibilityModeEnabled', keys: { win32: [['ctrl+shift+left']], linux: [['ctrl+shift+left']], darwin: [['shift+alt+left']] } },
  { command: 'cursorWordEndRight', when: 'textInputFocus && !accessibilityModeEnabled', keys: { win32: [['ctrl+right']], linux: [['ctrl+right']], darwin: [['alt+right']] } },
  { command: 'cursorWordEndRightSelect', when: 'textInputFocus && !accessibilityModeEnabled', keys: { win32: [['ctrl+shift+right']], linux: [['ctrl+shift+right']], darwin: [['shift+alt+right']] } },
  { command: 'deleteWordLeft', when: 'textInputFocus && !editorReadonly', keys: { win32: [['ctrl+backspace']], linux: [['ctrl+backspace']], darwin: [['alt+backspace']] } },
  { command: 'deleteWordRight', when: 'textInputFocus && !editorReadonly', keys: { win32: [['ctrl+delete']], linux: [['ctrl+delete']], darwin: [['alt+delete']] } },
  { command: 'editor.action.marker.next', title: 'Go to Next Problem (Error, Warning, Info)', when: 'editorFocus', keys: { win32: [['alt+f8']], linux: [['alt+f8']], darwin: [['alt+f8']] } },
  { command: 'editor.action.marker.prev', title: 'Go to Previous Problem (Error, Warning, Info)', when: 'editorFocus', keys: { win32: [['shift+alt+f8']], linux: [['shift+alt+f8']], darwin: [['shift+alt+f8']] } },
  { command: 'editor.action.marker.nextInFiles', title: 'Go to Next Problem in Files (Error, Warning, Info)', when: 'editorFocus', keys: { win32: [['f8']], linux: [['f8']], darwin: [['f8']] } },
  { command: 'editor.action.marker.prevInFiles', title: 'Go to Previous Problem in Files (Error, Warning, Info)', when: 'editorFocus', keys: { win32: [['shift+f8']], linux: [['shift+f8']], darwin: [['shift+f8']] } },
  { command: 'editor.action.showHover', title: 'Show or Focus Hover', when: 'editorTextFocus', keys: { win32: [['ctrl+k', 'ctrl+i']], linux: [['ctrl+k', 'ctrl+i']], darwin: [['meta+k', 'meta+i']] } }
]
