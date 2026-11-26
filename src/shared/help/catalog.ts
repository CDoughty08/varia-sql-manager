import type { CommandId } from '../commands/catalog'
import type { GestureId } from '../commands/gestures'
import type { SettingKey } from '../settings/catalog'

export type LessonContext = 'workbench' | 'queryEditor' | 'resultsGrid' | 'comparisonGrid'
export interface GuideMetadata {
  readonly title: string
  readonly summary: string
  readonly keywords: readonly string[]
  readonly sections: readonly { readonly id: string; readonly title: string }[]
  readonly related: readonly string[]
  readonly commands: readonly { readonly id: CommandId; readonly context: LessonContext }[]
  readonly settings: readonly SettingKey[]
  readonly gestures: readonly GestureId[]
  /** Advisory documentation-impact map; not every code change requires a prose edit. */
  readonly sourceAreas: readonly string[]
}

/** One registration per page. Its lazy component has the same file name in renderer/help/guides. */
export const guideCatalog = {
  connect: {
    title: 'Connect to SQL Server', summary: 'Choose a server and sign-in method, then find your databases.',
    keywords: ['connection', 'authentication', 'login', 'password', 'Entra', 'TLS'],
    sections: [{ id: 'prepare', title: 'Before you connect' }, { id: 'sign-in', title: 'Choose your sign-in' }, { id: 'next', title: 'Connect and explore' }, { id: 'trouble', title: 'If connecting fails' }],
    related: ['run-query', 'bigquery'], commands: [{ id: 'connection.connect', context: 'workbench' }, { id: 'connection.reconnect', context: 'workbench' }, { id: 'connection.removeFromExplorer', context: 'workbench' }], settings: ['environment.connections.autoReconnect'], gestures: [],
    sourceAreas: ['src/renderer/src/ConnectDialog.tsx', 'src/renderer/src/explorer/', 'src/renderer/src/services/connections.ts', 'src/shared/auth.ts', 'src/renderer/src/services/startup-reconnect.ts']
  },
  bigquery: {
    title: 'Connect to BigQuery', summary: 'Sign in with Google credentials, browse projects and datasets, and keep cost and large results in view.',
    keywords: ['BigQuery', 'Google', 'GoogleSQL', 'gcloud', 'ADC', 'service account', 'key file', 'federation', 'project', 'dataset', 'cost', 'bytes', 'windowed', 'job history'],
    sections: [{ id: 'prepare', title: 'Before you connect' }, { id: 'sign-in', title: 'Choose your sign-in' }, { id: 'connect', title: 'Connect and explore' }, { id: 'cost', title: 'Run queries and watch cost' }, { id: 'large', title: 'Large results' }, { id: 'trouble', title: 'If connecting fails' }],
    related: ['connect', 'run-query', 'results'],
    commands: [{ id: 'connection.connect', context: 'workbench' }, { id: 'bigquery.starProjectPrompt', context: 'workbench' }, { id: 'explorer.previewRows', context: 'workbench' }, { id: 'explorer.bigQueryProperties', context: 'workbench' }, { id: 'bigquery.jobHistory', context: 'workbench' }, { id: 'edit.peekDefinition', context: 'queryEditor' }, { id: 'edit.goToDefinition', context: 'queryEditor' }, { id: 'query.execute', context: 'queryEditor' }, { id: 'query.cancel', context: 'queryEditor' }, { id: 'output.loadIntoMemory', context: 'resultsGrid' }, { id: 'output.loadSample', context: 'resultsGrid' }],
    settings: ['objectExplorer.search.bigQueryAccessibleProjects', 'objectExplorer.search.bigQueryMaxProjects', 'queryExecution.bigQuery.costThreshold', 'queryExecution.bigQuery.maximumBytesBilled', 'queryExecution.bigQuery.showCost', 'queryResults.bigQuery.residence', 'environment.connections.autoReconnect'], gestures: [],
    sourceAreas: ['src/renderer/src/BigQueryConnectFields.tsx', 'src/renderer/src/bigquery-connect-form.ts', 'src/main/bigquery-credentials.ts', 'src/shared/bigquery-connections.ts', 'src/renderer/src/services/bigquery-cost.ts', 'src/shared/settings/bigquery.ts', 'src/shared/bigquery/', 'backend/Varia.Backend/BigQuery/', 'src/renderer/src/languages/bigquery-definition.ts']
  },
  'run-query': {
    title: 'Run your first query', summary: 'Create a query, choose its database and understand what Execute runs.',
    keywords: ['SQL', 'selection', 'execute', 'editor', 'font', 'zoom', 'messages', 'cancel', 'name', '#Name'],
    sections: [{ id: 'new', title: 'Open a query' }, { id: 'execute', title: 'Choose what runs' }, { id: 'read', title: 'Read the outcome' }],
    related: ['connect', 'results'], commands: [{ id: 'file.new', context: 'workbench' }, { id: 'query.execute', context: 'queryEditor' }], settings: [], gestures: ['editor.wheelZoom'],
    sourceAreas: ['src/renderer/src/contributions/query.ts', 'src/renderer/src/services/queries.ts', 'src/renderer/src/services/documents.ts', 'src/renderer/src/services/targets.ts', 'src/renderer/src/services/session.ts', 'src/renderer/src/editor/create-editor.ts']
  },
  results: {
    title: 'Work with query results', summary: 'Sort and filter returned rows, select cells and copy with confidence.',
    keywords: ['grid', 'copy', 'headers', 'sort', 'filter', 'selection', 'tabs', 'stacked', 'layout', 'pivot', 'comparison', 'name', '#Name'],
    sections: [{ id: 'browse', title: 'Explore returned rows' }, { id: 'layout', title: 'Move between results' }, { id: 'select', title: 'Select and copy' }, { id: 'limits', title: 'Know the limits' }],
    related: ['run-query', 'bigquery'], commands: [{ id: 'output.nextResult', context: 'workbench' }, { id: 'output.previousResult', context: 'workbench' }, { id: 'output.goToResult', context: 'workbench' }, { id: 'output.goToResult1', context: 'resultsGrid' }, { id: 'output.goToLastResult', context: 'resultsGrid' }, { id: 'output.toggleResultsTabs', context: 'workbench' }, { id: 'output.filterSelection', context: 'resultsGrid' }, { id: 'output.filterColumnValues', context: 'resultsGrid' }, { id: 'output.copy', context: 'resultsGrid' }, { id: 'output.copyWithHeaders', context: 'resultsGrid' }, { id: 'output.saveResultsAs', context: 'resultsGrid' }, { id: 'output.compareMatch', context: 'workbench' }, { id: 'output.compareNextDifference', context: 'comparisonGrid' }, { id: 'output.comparePreviousDifference', context: 'comparisonGrid' }, { id: 'output.compareGoToPossibleMatch', context: 'workbench' }, { id: 'query.cancel', context: 'queryEditor' }],
    settings: ['queryResults.grid.layout', 'queryResults.compare.layout', 'queryResults.compare.rows', 'queryResults.grid.copyColumnHeaders', 'queryResults.grid.saveColumnHeaders', 'queryResults.grid.discardResults', 'queryResults.bigQuery.residence'], gestures: ['grid.addToSelection'],
    sourceAreas: ['src/renderer/src/results', 'src/renderer/src/grid/ResultGrid.tsx', 'src/renderer/src/grid/ResultsTabs.tsx', 'src/renderer/src/grid/ResultsPicker.tsx', 'src/main/results-jobs.ts', 'src/shared/settings/query-results.ts', 'backend/Varia.Backend/Results/ResultPacker.cs']
  },
  'sql-server-agent': {
    title: 'Schedule work with SQL Server Agent', summary: 'Watch jobs run, read their history, and create or change jobs, schedules and alerts.',
    keywords: ['Agent', 'job', 'jobs', 'schedule', 'step', 'history', 'Job Activity Monitor', 'alert', 'operator', 'proxy', 'credential', 'error log', 'msdb', 'overview', 'health check'],
    sections: [{ id: 'find', title: 'Find SQL Server Agent' }, { id: 'watch', title: 'Watch jobs and read history' }, { id: 'jobs', title: 'Create and change jobs' }, { id: 'objects', title: 'Alerts, operators and proxies' }, { id: 'trouble', title: 'If Agent is unavailable' }],
    related: ['connect', 'run-query'],
    commands: [{ id: 'agent.jobActivity', context: 'workbench' }, { id: 'agent.viewHistory', context: 'workbench' }, { id: 'agent.newJob', context: 'workbench' }, { id: 'agentJob.save', context: 'workbench' }, { id: 'agent.createJobLike', context: 'workbench' }, { id: 'agent.schedules', context: 'workbench' }, { id: 'agent.newAlert', context: 'workbench' }, { id: 'agent.newOperator', context: 'workbench' }, { id: 'agent.newProxy', context: 'workbench' }, { id: 'explorer.startAgent', context: 'workbench' }, { id: 'agent.overview', context: 'workbench' }],
    settings: [], gestures: [],
    sourceAreas: ['src/shared/agent/', 'src/shared/actions/agent-job.ts', 'src/renderer/src/agent/', 'src/renderer/src/contributions/agent.ts', 'src/shared/explorer/catalog.ts', 'backend/Varia.Backend/Agent/', 'docs/sql-server-agent.md']
  }
} as const satisfies Record<string, GuideMetadata>
export type GuideId = keyof typeof guideCatalog
export const guideIds = Object.keys(guideCatalog) as GuideId[]
export const isGuideId = (id: unknown): id is GuideId => typeof id === 'string' && Object.hasOwn(guideCatalog, id)
export const guideMetadata = (id: GuideId): GuideMetadata => guideCatalog[id]
export const matchingGuides = (search: string): readonly GuideId[] => {
  const words = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return guideIds.filter(id => {
    const guide = guideMetadata(id), text = [guide.title, guide.summary, ...guide.keywords].join(' ').toLocaleLowerCase()
    return words.every(word => text.includes(word))
  })
}
