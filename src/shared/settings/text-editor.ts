import type { SettingDef } from './types'

/** Text Editor pages: the query editor's Monaco options and its models' indentation. */
export const textEditorSettings = [
  {
    key: 'textEditor.dragAndDrop', page: 'textEditor.general', group: 'Settings', label: 'Enable mouse click to perform drag-and-drop text editing', type: 'boolean', default: true,
    keywords: ['drag', 'drop'], description: 'Selected text can be dragged to move it, or copied with Ctrl held.'
  },
  {
    key: 'textEditor.delimiterHighlighting', page: 'textEditor.general', group: 'Settings', label: 'Automatic delimiter highlighting', type: 'boolean', default: true,
    keywords: ['brackets', 'parentheses', 'match'], description: 'Highlights the bracket or parenthesis that matches the one at the caret. Large values opened from the results never match brackets.'
  },
  {
    key: 'textEditor.highlightCurrentLine', page: 'textEditor.general', group: 'Display', label: 'Highlight current line', type: 'boolean', default: true,
    description: 'Highlights the line that holds the caret.'
  },
  {
    key: 'textEditor.sql.wordWrap', page: 'textEditor.transactSql.general', group: 'Settings', label: 'Word wrap', type: 'boolean', default: false,
    keywords: ['wrap', 'alt+z'], description: 'Wraps long lines at the edge of the editor instead of scrolling. View › Word Wrap (Alt+Z) changes it too.'
  },
  {
    key: 'textEditor.sql.lineNumbers', page: 'textEditor.transactSql.general', group: 'Display', label: 'Line numbers', type: 'boolean', default: true,
    ssmsDefault: 'False (SSMS 18–20; SSMS 22 not verified)', keywords: ['gutter'], description: 'Shows line numbers beside the query text.'
  },
  {
    key: 'textEditor.sql.tabSize', page: 'textEditor.transactSql.tabs', group: 'Tab', label: 'Tab size', type: 'integer', min: 1, max: 60, default: 4,
    keywords: ['indent', 'indentation'], description: 'The number of columns a tab character takes.'
  },
  {
    key: 'textEditor.sql.indentSize', page: 'textEditor.transactSql.tabs', group: 'Tab', label: 'Indent size', type: 'integer', min: 1, max: 60, default: 4,
    keywords: ['indent', 'indentation'], description: 'The number of columns Tab and automatic indentation indent by.'
  },
  {
    key: 'textEditor.sql.tabs', page: 'textEditor.transactSql.tabs', group: 'Tab', label: 'Tab characters', type: 'enum', presentation: 'radio', default: 'tabs',
    values: [{ value: 'spaces', label: 'Insert spaces' }, { value: 'tabs', label: 'Keep tabs' }], keywords: ['indent', 'indentation', 'spaces', 'insert spaces', 'keep tabs'],
    description: 'Whether Tab and indentation insert spaces or tab characters, as SSMS\'s Insert spaces and Keep tabs. The indentation already in a query is not detected.'
  }
] as const satisfies readonly SettingDef[]
