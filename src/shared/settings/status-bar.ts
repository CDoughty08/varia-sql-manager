import type { SettingDef } from './types'

/**
 * Text Editor › Editor Tab and Status Bar: SSMS 22's property grid, in its categories and its alphabetical order, with
 * its wording. SSMS's status bar colours, Include selected row and column, and Tab Text are not here yet. The server, login
 * and database settings apply wherever the query's facts show: the window's status bar, or the query window status bar when
 * it is on. Execution time and row count belong to the query window status bar: without it the results head shows them.
 */
export const statusBarSettings = [
  {
    key: 'textEditor.statusBar.executionTime', page: 'textEditor.editorTabAndStatusBar', group: 'Status Bar Content', label: 'Display execution time', type: 'enum', default: 'elapsed', enabledBy: 'textEditor.statusBar.queryWindow',
    values: [{ value: 'elapsed', label: 'Elapsed' }, { value: 'end', label: 'End' }, { value: 'none', label: 'None' }], keywords: ['elapsed', 'time', 'duration', 'end time'],
    description: 'Select type of time display to include on the query window status bar: how long the query has run or ran (Elapsed), or the time its last execution ended (End). Without that bar the results head shows how long the query ran and when it ended.'
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
    key: 'textEditor.statusBar.showRowCount', page: 'textEditor.editorTabAndStatusBar', group: 'Status Bar Content', label: 'Include row count', type: 'boolean', default: true, keywords: ['rows'], enabledBy: 'textEditor.statusBar.queryWindow',
    description: 'Include count of returned rows on the query window status bar. Without that bar the results head shows the rows.'
  },
  {
    key: 'textEditor.statusBar.showServer', page: 'textEditor.editorTabAndStatusBar', group: 'Status Bar Content', label: 'Include server name', type: 'boolean', default: true, keywords: ['version'],
    description: 'Include server name on the status bar, with the server\'s major and minor version.'
  },
  {
    key: 'textEditor.statusBar.queryWindow', page: 'textEditor.editorTabAndStatusBar', group: 'Status Bar Layout and Colors', label: 'Show query window status bar', type: 'boolean', default: false, varia: true,
    keywords: ['classic', 'legacy', 'query status bar', 'spid'],
    description: 'Shows SSMS\'s status bar in the query window again, below or above the query (Status bar location), with the query\'s state, server, login, database, time and rows. Without it the window\'s status bar shows the active query\'s server, login and database, and the results head how its last execution went, its time and its rows. This option will be removed in a later release.'
  },
  {
    key: 'textEditor.statusBar.location', page: 'textEditor.editorTabAndStatusBar', group: 'Status Bar Layout and Colors', label: 'Status bar location', type: 'enum', default: 'bottom', enabledBy: 'textEditor.statusBar.queryWindow',
    values: [{ value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }], keywords: ['position', 'top', 'bottom'],
    description: 'Select the location of the status bar for the editor: below the query text, or above it.'
  }
] as const satisfies readonly SettingDef[]
