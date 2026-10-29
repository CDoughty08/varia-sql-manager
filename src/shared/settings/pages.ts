import type { SettingPage } from './types'

/**
 * The Options tree in SSMS 22's order, one node a line. Pages added later go where SSMS has them: Environment ›
 * General, AutoRecover, Documents, Fonts and Colors, Keyboard, then Varia's own Live Data; Text Editor › General, Editor
 * Tab and Status Bar, Transact-SQL; Varia's own Activity Monitor last. tests/settings-catalog.test.ts's `expectedTree` lists the same tree.
 */
export const settingPages = [
  { id: 'environment', title: 'Environment' },
  { id: 'environment.general', title: 'General', parent: 'environment', layout: 'form', provider: 'theme' },
  { id: 'environment.autoRecover', title: 'AutoRecover', parent: 'environment', layout: 'form', description: 'Copies of queries with unsaved changes, offered after Varia SQL Manager closes unexpectedly.' },
  { id: 'environment.documents', title: 'Documents', parent: 'environment', layout: 'form' },
  { id: 'environment.fontsAndColors', title: 'Fonts and Colors', parent: 'environment', layout: 'form', description: 'Colors come from the color theme (View › Theme).' },
  { id: 'environment.keyboard', title: 'Keyboard', parent: 'environment', layout: 'keyboard', description: 'Shortcuts follow SSMS\'s defaults and cannot be changed yet. The command palette (F1) shows each command\'s shortcut.' },
  { id: 'environment.liveData', title: 'Live Data', parent: 'environment', layout: 'form', description: 'Live views, such as the Activity Monitor: when they pause while hidden, and how much chart history they keep. Not in SSMS.' },
  { id: 'textEditor', title: 'Text Editor' },
  { id: 'textEditor.general', title: 'General', parent: 'textEditor', layout: 'form' },
  { id: 'textEditor.editorTabAndStatusBar', title: 'Editor Tab and Status Bar', parent: 'textEditor', layout: 'propertyGrid', description: 'The query window\'s status bar: where it is, and what it shows.' },
  { id: 'textEditor.transactSql', title: 'Transact-SQL', parent: 'textEditor' },
  { id: 'textEditor.transactSql.general', title: 'General', parent: 'textEditor.transactSql', layout: 'form' },
  { id: 'textEditor.transactSql.tabs', title: 'Tabs', parent: 'textEditor.transactSql', layout: 'form' },
  { id: 'queryExecution', title: 'Query Execution' },
  { id: 'queryExecution.sqlServer', title: 'SQL Server', parent: 'queryExecution' },
  { id: 'queryExecution.sqlServer.general', title: 'General', parent: 'queryExecution.sqlServer', layout: 'form' },
  { id: 'queryExecution.sqlServer.advanced', title: 'Advanced', parent: 'queryExecution.sqlServer', layout: 'form' },
  { id: 'queryResults', title: 'Query Results' },
  { id: 'queryResults.sqlServer', title: 'SQL Server', parent: 'queryResults' },
  { id: 'queryResults.sqlServer.grid', title: 'Results to Grid', parent: 'queryResults.sqlServer', layout: 'form' },
  { id: 'objectExplorer', title: 'SQL Server Object Explorer' },
  { id: 'objectExplorer.commands', title: 'Commands', parent: 'objectExplorer', layout: 'propertyGrid' },
  { id: 'objectExplorer.scripting', title: 'Scripting', parent: 'objectExplorer', layout: 'propertyGrid' },
  { id: 'activityMonitor', title: 'Activity Monitor', layout: 'form', description: 'What a new Activity Monitor starts with, and when its tiles warn. Not in SSMS.' },
  { id: 'integrationServices', title: 'SQL Server Integration Services', layout: 'form', description: 'How Varia follows the SSIS Catalog (SSISDB) as it changes. Not in SSMS.' }
] as const satisfies readonly SettingPage[]
