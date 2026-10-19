import type { SettingDef } from './types'

/**
 * Text Editor › Editor Tab and Status Bar: SSMS 22's property grid, in its categories and its alphabetical order, with
 * its wording. SSMS's status bar colours, Include selected row and column, and Tab Text are not here yet.
 */
export const statusBarSettings = [
  {
    key: 'textEditor.statusBar.executionTime', page: 'textEditor.editorTabAndStatusBar', group: 'Status Bar Content', label: 'Display execution time', type: 'enum', default: 'elapsed',
    values: [{ value: 'elapsed', label: 'Elapsed' }, { value: 'end', label: 'End' }, { value: 'none', label: 'None' }], keywords: ['elapsed', 'time', 'duration', 'end time'],
    description: 'Select type of time display to include on the status bar: how long the query has run or ran (Elapsed), or the time its last execution ended (End).'
  },
  {
    key: 'textEditor.statusBar.showDatabase', page: 'textEditor.editorTabAndStatusBar', group: 'Status Bar Content', label: 'Include database name', type: 'boolean', default: true,
    description: 'Include the database name on the status bar.'
  },
  {
    key: 'textEditor.statusBar.showLogin', page: 'textEditor.editorTabAndStatusBar', group: 'Status Bar Content', label: 'Include login name', type: 'boolean', default: true, keywords: ['spid', 'session'],
    description: 'Include login information on the status bar: the login and session id, `login (SPID)`, of the query\'s last execution.'
  },
  {
    key: 'textEditor.statusBar.showRowCount', page: 'textEditor.editorTabAndStatusBar', group: 'Status Bar Content', label: 'Include row count', type: 'boolean', default: true, keywords: ['rows'],
    description: 'Include count of returned rows on the status bar.'
  },
  {
    key: 'textEditor.statusBar.showServer', page: 'textEditor.editorTabAndStatusBar', group: 'Status Bar Content', label: 'Include server name', type: 'boolean', default: true, keywords: ['version'],
    description: 'Include server name on the status bar, with the server\'s major and minor version.'
  },
  {
    key: 'textEditor.statusBar.location', page: 'textEditor.editorTabAndStatusBar', group: 'Status Bar Layout and Colors', label: 'Status bar location', type: 'enum', default: 'bottom',
    values: [{ value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }], keywords: ['position', 'top', 'bottom'],
    description: 'Select the location of the status bar for the editor: below the query text, or above it.'
  }
] as const satisfies readonly SettingDef[]
