import { bothProviders } from '../providers'
import type { SettingPage } from './types'

/**
 * The Options tree in SSMS 22's order, one node a line. Pages added later go where SSMS has them: Environment ›
 * General, AutoRecover, Documents, Fonts and Colors, Shortcuts (SSMS's Keyboard), then Varia's own Live Data and Object Explorer; Text Editor › General, Editor
 * Tab and Status Bar, Transact-SQL; Varia's own Activity Monitor last. tests/settings-catalog.test.ts's `expectedTree` lists the same tree.
 */
export const settingPages = [
  { id: 'environment', providers: bothProviders, title: 'Environment' },
  { id: 'environment.general', providers: bothProviders, title: 'General', parent: 'environment', layout: 'form', provider: 'theme' },
  { id: 'environment.autoRecover', providers: bothProviders, title: 'AutoRecover', parent: 'environment', layout: 'form', description: 'Copies of queries with unsaved changes, offered after Varia SQL Manager closes unexpectedly.' },
  { id: 'environment.documents', providers: bothProviders, title: 'Documents', parent: 'environment', layout: 'form', sections: [{ label: 'Startup' }, { label: 'Files changed outside Varia' }, { label: 'Saving' }] },
  { id: 'environment.fontsAndColors', providers: bothProviders, title: 'Fonts and Colors', parent: 'environment', layout: 'form', description: 'Colors come from the color theme (View › Theme).', sections: [{ label: 'Text Editor' }] },
  { id: 'environment.shortcuts', providers: bothProviders, title: 'Shortcuts', parent: 'environment', layout: 'shortcuts', description: 'Keyboard and mouse shortcuts: SSMS\'s defaults, your changes, and the scope each works in. Changes apply when you choose OK. Copy on a row copies it (command, shortcut, scope and source).' },
  { id: 'environment.productUpdates', providers: bothProviders, title: 'Product Updates', parent: 'environment', layout: 'form', description: 'How Varia SQL Manager finds, downloads and installs new releases.' },
  { id: 'environment.liveData', title: 'Live Data', parent: 'environment', layout: 'form', description: 'Live views, such as the Activity Monitor: when they pause while hidden, and how much chart history they keep. Not in SSMS.', sections: [{ label: 'Hidden views', description: 'Live views in tabs that are not shown, or in a minimized window.' }, { label: 'Object Explorer' }, { label: 'Charts' }] },
  { id: 'environment.objectExplorer', title: 'Object Explorer', parent: 'environment', layout: 'form' },
  { id: 'environment.connections', providers: bothProviders, title: 'Connections', parent: 'environment', layout: 'form', description: 'How remembered connection targets reconnect when the workspace opens. Not in SSMS.' },
  { id: 'textEditor', providers: bothProviders, title: 'Text Editor' },
  { id: 'textEditor.general', providers: bothProviders, title: 'General', parent: 'textEditor', layout: 'form', sections: [{ label: 'Settings' }, { label: 'Display' }] },
  { id: 'textEditor.editorTabAndStatusBar', providers: bothProviders, title: 'Editor Tab and Status Bar', parent: 'textEditor', layout: 'propertyGrid', description: 'The query window\'s status bar: where it is, and what it shows.' },
  { id: 'textEditor.transactSql', title: 'Transact-SQL', parent: 'textEditor' },
  { id: 'textEditor.transactSql.general', title: 'General', parent: 'textEditor.transactSql', layout: 'form', sections: [{ label: 'Settings' }, { label: 'Display' }] },
  { id: 'textEditor.transactSql.intelliSense', title: 'IntelliSense', parent: 'textEditor.transactSql', layout: 'form', sections: [{ label: 'IntelliSense' }] },
  { id: 'textEditor.transactSql.tabs', title: 'Tabs', parent: 'textEditor.transactSql', layout: 'form', sections: [{ label: 'Tab' }] },
  { id: 'queryExecution', title: 'Query Execution' },
  { id: 'queryExecution.sqlServer', title: 'SQL Server', parent: 'queryExecution' },
  { id: 'queryExecution.sqlServer.general', title: 'General', parent: 'queryExecution.sqlServer', layout: 'form' },
  { id: 'queryExecution.sqlServer.advanced', title: 'Advanced', parent: 'queryExecution.sqlServer', layout: 'form' },
  { id: 'queryResults', title: 'Query Results' },
  { id: 'queryResults.sqlServer', title: 'SQL Server', parent: 'queryResults' },
  { id: 'queryResults.sqlServer.grid', title: 'Results to Grid', parent: 'queryResults.sqlServer', layout: 'form', sections: [{ label: 'Grid display', description: 'How results look in the grid.' }, { label: 'Copy and save' }, { label: 'Limits and memory', description: 'Rows past a limit are still read and counted, but not kept.' }, { label: 'Execution plan', description: 'The panes beside a graphical execution plan.' }] },
  { id: 'objectExplorer', title: 'SQL Server Object Explorer' },
  { id: 'objectExplorer.commands', title: 'Commands', parent: 'objectExplorer', layout: 'propertyGrid' },
  { id: 'objectExplorer.scripting', title: 'Scripting', parent: 'objectExplorer', layout: 'propertyGrid' },
  { id: 'activityMonitor', title: 'Activity Monitor', layout: 'form', description: 'What a new Activity Monitor starts with, and when its tiles warn. Not in SSMS.', sections: [{ label: 'New monitors' }, { label: 'Thresholds', description: 'When the overview tiles warn.' }] },
  { id: 'integrationServices', title: 'SQL Server Integration Services', layout: 'form', description: 'How Varia follows the SSIS Catalog (SSISDB) as it changes. Not in SSMS.', sections: [{ label: 'Object Explorer' }, { label: 'Operations', description: 'The Operations view of the SSIS Catalog.' }] }
] as const satisfies readonly SettingPage[]
