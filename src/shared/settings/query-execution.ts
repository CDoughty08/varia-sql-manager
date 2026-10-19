import type { SettingDef } from './types'

/** Query Execution pages: what each `query.execute` request carries. */
export const queryExecutionSettings = [
  {
    key: 'queryExecution.executionTimeout', page: 'queryExecution.sqlServer.general', label: 'Execution time-out', type: 'integer', min: 0, max: 86_400, default: 0, unit: 'seconds',
    applies: 'nextExecution', keywords: ['timeout', 'command timeout'],
    description: 'The number of seconds to wait before cancelling a query. 0 waits indefinitely. A connection whose Advanced properties set a command timeout uses that instead.'
  },
  {
    key: 'queryExecution.stopOnError', page: 'queryExecution.sqlServer.advanced', label: 'Stop the script at the first batch that raises an error', type: 'boolean', default: false,
    varia: true, applies: 'nextExecution', keywords: ['error', 'batch', 'abort'],
    description: 'Skips the remaining batches of a script after a batch fails. Otherwise every batch runs, as in SSMS.'
  }
] as const satisfies readonly SettingDef[]
