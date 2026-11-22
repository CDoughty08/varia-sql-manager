import type { SettingDef } from './types'

/**
 * BigQuery's pages (docs/bigquery.md, Cost, Residence): Text Editor › GoogleSQL, Query Execution › BigQuery and Query
 * Results › BigQuery. Byte figures are whole
 * GiB, as Google bills in binary units; the cost prompts and the estimate chip read them, and the cap goes out with every job.
 */
export const bigQuerySettings = [
  {
    key: 'textEditor.googleSql.dryRunDiagnostics', page: 'textEditor.googleSql.general', label: 'Check queries with a dry run while editing', type: 'boolean', default: true, varia: true,
    keywords: ['bigquery', 'diagnostics', 'errors', 'estimate', 'dry run', 'squiggles'],
    description: 'After a pause in typing, a free BigQuery dry run marks the query\'s error at its line and column and updates the estimate beside Execute. A dry run sends the query text to Google, as Execute does; it runs nothing and bills nothing. Off, Execute still dry-runs the query for its estimate.'
  },
  {
    key: 'queryExecution.bigQuery.costPrompt', page: 'queryExecution.bigQuery.cost', group: 'Prompt', label: 'Ask before running a query that processes more than the threshold', type: 'boolean', default: true, varia: true,
    applies: 'nextExecution', keywords: ['bigquery', 'cost', 'bytes', 'estimate', 'confirm'],
    description: 'Execute dry-runs a BigQuery query first (free) and asks before running one estimated to process more than the threshold. A connection where you chose "Don\'t ask again" in the prompt never asks; its Advanced Properties turn the prompt back on.'
  },
  {
    key: 'queryExecution.bigQuery.costThreshold', page: 'queryExecution.bigQuery.cost', group: 'Prompt', label: 'Threshold', type: 'integer', min: 1, max: 1_048_576, default: 10, unit: 'GiB', varia: true,
    enabledBy: 'queryExecution.bigQuery.costPrompt', applies: 'nextExecution', keywords: ['bigquery', 'cost', 'bytes'],
    description: 'Queries estimated to process more than this ask before running. The estimate beside Execute turns amber above it.'
  },
  {
    key: 'queryExecution.bigQuery.incompleteEstimateWarning', page: 'queryExecution.bigQuery.cost', group: 'Prompt', label: 'Warn when an estimate may be low', type: 'boolean', default: true, varia: true,
    applies: 'nextExecution', keywords: ['bigquery', 'cost', 'script', 'external table'],
    description: 'Asks once per query tab before running a query whose estimate may be low: a script (estimated only up to its first DDL or control statement), external or row-level-security tables (0 bytes before they run), or an estimate BigQuery marks as a lower bound or could not make accurate.'
  },
  {
    key: 'queryExecution.bigQuery.maximumBytesBilled', page: 'queryExecution.bigQuery.cost', group: 'Limit', label: 'Maximum bytes billed per query', type: 'integer', min: 0, max: 1_048_576, default: 0, unit: 'GiB', hint: '0 = no limit', varia: true,
    applies: 'nextExecution', keywords: ['bigquery', 'cost', 'cap', 'limit', 'maximumBytesBilled'],
    description: 'Every BigQuery job carries this limit, so BigQuery fails a query that would bill more, at no charge. A connection\'s own limit (Advanced Properties) wins over this one.'
  },
  {
    key: 'queryExecution.bigQuery.showCost', page: 'queryExecution.bigQuery.cost', group: 'Estimates', label: 'Show cost as', type: 'enum', default: 'onDemand', varia: true,
    values: [{ value: 'onDemand', label: 'On-demand US rate ($6.25 per TiB)' }, { value: 'bytes', label: 'Bytes only' }], keywords: ['bigquery', 'price', 'dollars', 'cost'],
    description: 'Dollars beside every byte figure (the estimate, the Results status, Messages and the prompts), at the US on-demand rate. Projects that use reserved capacity are not billed per byte; Bytes only leaves the dollars out.'
  },
  {
    key: 'queryExecution.bigQuery.closeRunningJob', page: 'queryExecution.bigQuery.sessions', label: 'When a closing query holds a running job', type: 'enum', default: 'ask', varia: true,
    values: [{ value: 'ask', label: 'Ask' }, { value: 'cancel', label: 'Cancel the job' }, { value: 'leave', label: 'Leave it running' }],
    keywords: ['bigquery', 'job', 'close', 'cancel', 'leave running', 'detach', 'quit'],
    description: 'What closing, disconnecting, switching location or Close Results does with a BigQuery query\'s running job. Ask offers Cancel the job, Leave it running or Don\'t close, and "Remember my choice" in that prompt sets this. Quitting always asks, listing the job ids. A job left running finishes in BigQuery, where its job history lists it. A prompt that also lists SQL Server queries asks anyway, with "Leave BigQuery jobs running" checked when this is Leave it running.'
  },
  {
    key: 'queryResults.bigQuery.residence', page: 'queryResults.bigQuery.results', label: 'Keep results', type: 'enum', default: 'automatic', varia: true,
    values: [{ value: 'automatic', label: 'Automatically, by size' }, { value: 'memory', label: 'Always in memory' }, { value: 'windowed', label: 'Always windowed in BigQuery' }],
    applies: 'nextExecution', keywords: ['bigquery', 'memory', 'windowed', 'remote', 'large results', 'residence'],
    description: 'Automatically keeps a result in memory when it fits in half of the room the query may still take, and leaves a larger one windowed in BigQuery: its rows are read in blocks as you scroll, free, and expire with the result table BigQuery keeps for about 24 hours. Always in memory truncates at the result memory budget instead.'
  },
  {
    key: 'queryResults.bigQuery.windowCacheMiB', page: 'queryResults.bigQuery.results', label: 'Block cache per windowed result', type: 'integer', min: 16, max: 4096, default: 64, unit: 'MiB', varia: true,
    applies: 'nextExecution', keywords: ['bigquery', 'memory', 'windowed', 'cache', 'blocks'],
    description: 'The rows of a windowed result kept in memory as you scroll, part of the result memory budget (Window cache in the Memory panel). The least recently read blocks go first.'
  }
] as const satisfies readonly SettingDef[]
