import type { SettingPage } from './types'

/**
 * The Options tree in SSMS 22's order, one node a line. Pages added later go where SSMS has them: Environment ›
 * General, AutoRecover, Documents, Fonts and Colors, Keyboard; Text Editor › General, Editor Tab and Status Bar,
 * Transact-SQL. tests/settings-catalog.test.ts's `expectedTree` lists the same tree.
 */
export const settingPages = [
  { id: 'environment', title: 'Environment' },
  { id: 'environment.general', title: 'General', parent: 'environment', layout: 'form', provider: 'theme' },
  { id: 'environment.fontsAndColors', title: 'Fonts and Colors', parent: 'environment', layout: 'form', description: 'Colors come from the color theme (View › Theme).' },
  { id: 'environment.keyboard', title: 'Keyboard', parent: 'environment', layout: 'keyboard', description: 'Shortcuts follow SSMS\'s defaults and cannot be changed yet. The command palette (F1) shows each command\'s shortcut.' },
  { id: 'textEditor', title: 'Text Editor' },
  { id: 'textEditor.general', title: 'General', parent: 'textEditor', layout: 'form' },
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
  { id: 'objectExplorer.scripting', title: 'Scripting', parent: 'objectExplorer', layout: 'propertyGrid' }
] as const satisfies readonly SettingPage[]
