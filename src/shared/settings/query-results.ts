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
  }
] as const satisfies readonly SettingDef[]
