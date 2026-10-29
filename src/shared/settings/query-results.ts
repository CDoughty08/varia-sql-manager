import type { SettingDef } from './types'

/** Query Results pages. */
export const queryResultsSettings = [
  {
    key: 'queryResults.grid.includeColumnHeaders', page: 'queryResults.sqlServer.grid', label: 'Include column headers when copying or saving the results', type: 'boolean', default: false,
    keywords: ['headers', 'copy', 'csv', 'export', 'save'],
    description: 'Copy and Save Results As (CSV and tab-delimited text) start with a row of column names. JSON always names its keys, and Copy with Headers always includes them.'
  },
  {
    key: 'queryResults.grid.maxResultSets', page: 'queryResults.sqlServer.grid', label: 'Maximum result sets kept per execution', type: 'integer', min: 1, max: 1000, default: 1000,
    varia: true, applies: 'nextExecution', keywords: ['result sets', 'limit'],
    description: 'Result sets after this many still run and are counted, but their rows are not kept; the Messages tab says so.'
  },
  {
    key: 'queryResults.grid.showColumnTypes', page: 'queryResults.sqlServer.grid', label: 'Show column data types in the column headers', type: 'boolean', default: true,
    varia: true, keywords: ['type', 'data type', 'header', 'int', 'nvarchar'],
    description: 'Each column header shows the column\'s SQL type after its name, in smaller text: int, nvarchar(50), decimal(18,2). The header\'s tooltip names the type either way. Column widths already set are kept when this changes.'
  }
] as const satisfies readonly SettingDef[]
