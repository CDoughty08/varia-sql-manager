// BigQuery's Job History (docs/bigquery.md, Job History): the `bigquery.jobs` live source's limits, time ranges, states, job
// types and the columns its probe stores. Erasable TypeScript without zod, so the live catalogue (src/shared/live/catalog.ts),
// which Node's type stripping loads, can build its entry from it; the schemas and the renderer's rules are in history.ts.

export const jobHistorySource = 'bigquery.jobs' as const
export const jobHistoryProbe = 'bigquery.jobs.list' as const

export const jobHistoryLimits = {
  /** The newest top-level jobs one view holds; the status says when more exist in the range. */
  jobs: 1000,
  /** jobs.list's page size (maxResults). */
  pageJobs: 100,
  /** One refresh's response bytes; the next refresh goes on from where it stopped. */
  responseBytes: 10 * 1024 * 1024,
  /** A grid cell's SQL preview, in characters (one line). */
  previewChars: 200,
  /** BigQuery keeps jobs for 180 days: the widest range, and how far back a custom range may start. */
  retentionDays: 180,
  /** A script's children listed under it, in statement order. */
  children: 1000,
  /** Scripts expanded at once in one view. */
  expanded: 4,
  /** Jobs a view may be filtered to (a Messages link, records without a tab). */
  pinned: 64,
  /** Statement types a filter names, and each one's length. */
  statements: 16, statementChars: 64,
  /** Error text in the grid, in characters. */
  errorChars: 300,
  /** The refresh interval while a job is open, its range, and the interval while none is (the catalogue's idleIntervalMs). */
  intervalMs: 5000, minIntervalMs: 2000, maxIntervalMs: 300_000, idleIntervalMs: 60_000,
  /** New jobs are listed from this long before the newest held one, so jobs that became listable out of order are not missed. */
  overlapMs: 60_000
} as const

/** The time ranges the header offers, in hours back from now; Custom names its own start and end. */
export const jobHistoryRanges: readonly { readonly hours: 1 | 24 | 168 | 720; readonly label: string }[] = [
  { hours: 1, label: 'Last hour' }, { hours: 24, label: 'Last 24 hours' }, { hours: 168, label: 'Last 7 days' }, { hours: 720, label: 'Last 30 days' }
]
export const jobHistoryDefaultHours = 24

/** A job's state as the grid shows it. BigQuery has only PENDING, RUNNING and DONE: failed and cancelled are DONE jobs with an
 *  error (reason `stopped` for cancelled), which the backend tells apart. */
export const jobHistoryStates = ['running', 'pending', 'done', 'failed', 'cancelled'] as const
export type JobHistoryState = typeof jobHistoryStates[number]
export const jobHistoryStateLabels: { readonly [S in JobHistoryState]: string } = { running: 'Running', pending: 'Pending', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' }

export const jobHistoryTypes = ['query', 'load', 'extract', 'copy'] as const
export type JobHistoryType = typeof jobHistoryTypes[number]
export const jobHistoryTypeLabels: { readonly [T in JobHistoryType]: string } = { query: 'Query', load: 'Load', extract: 'Extract', copy: 'Copy' }

/** The probe's one table, in column order. Cells are display text; bytes, durations and cost sort by their values. The last
 *  columns are hidden (the live catalogue's role `hidden`): they identify the row for the renderer's actions and the grid
 *  never shows them: the job's full reference, its parent script, whether it is the connection principal's own (a My jobs
 *  listing has it, never an email comparison), whether BigQuery hid its details, its children's count, and the tone. */
export const jobHistoryColumns = [
  { id: 'state', name: 'State', dataType: 'nvarchar' },
  { id: 'jobId', name: 'Job ID', dataType: 'nvarchar' },
  { id: 'type', name: 'Type', dataType: 'nvarchar' },
  { id: 'statement', name: 'Statement', dataType: 'nvarchar' },
  { id: 'user', name: 'User', dataType: 'nvarchar' },
  { id: 'created', name: 'Created', dataType: 'datetime2' },
  { id: 'duration', name: 'Duration', dataType: 'nvarchar' },
  { id: 'processed', name: 'Processed', dataType: 'nvarchar' },
  { id: 'billed', name: 'Billed', dataType: 'nvarchar' },
  { id: 'cost', name: 'Cost', dataType: 'nvarchar' },
  { id: 'slotTime', name: 'Slot time', dataType: 'nvarchar' },
  { id: 'cache', name: 'Cache', dataType: 'nvarchar' },
  { id: 'location', name: 'Location', dataType: 'nvarchar' },
  { id: 'varia', name: 'Varia', dataType: 'nvarchar' },
  { id: 'destination', name: 'Destination', dataType: 'nvarchar' },
  { id: 'error', name: 'Error', dataType: 'nvarchar' },
  { id: 'sql', name: 'SQL', dataType: 'nvarchar' },
  { id: 'job', name: 'Job', dataType: 'nvarchar', role: 'hidden' },
  { id: 'parent', name: 'Parent job', dataType: 'nvarchar', role: 'hidden' },
  { id: 'mine', name: 'Mine', dataType: 'bit', role: 'hidden' },
  { id: 'hidden', name: 'Details hidden', dataType: 'bit', role: 'hidden' },
  { id: 'children', name: 'Children', dataType: 'int', role: 'hidden' },
  { id: 'tone', name: 'tone', dataType: 'nvarchar', role: 'tone' }
] as const
export type JobHistoryColumn = typeof jobHistoryColumns[number]['id']
/** The column the filter box searches: job id, user, destination and the SQL preview. */
export const jobHistoryTextColumns = ['job', 'user', 'destination', 'sql'] as const satisfies readonly JobHistoryColumn[]
/** What the probe's status reports: jobs held, whether more exist in the range (1), whether the list is still loading after a
 *  refresh stopped at its budget (1), the locations BigQuery could not read (comma separated), open jobs, and whether the
 *  All users listing was refused (1). */
export const jobHistoryStatus = ['held', 'more', 'loading', 'unreachable', 'open', 'allUsersDenied'] as const

/** The document's title, and its tab: the history and the connection it lists. */
export const jobHistoryTitle = 'Job History'
export const jobHistoryTabName = (connection: string): string => `${jobHistoryTitle} - ${connection}`

export type JobHistoryCommandId = 'bigquery.jobHistory' | 'bigquery.openJobResults' | 'bigquery.reattachJob' | 'bigquery.openJobSql' | 'bigquery.rerunJob' | 'bigquery.cancelJob'
  | 'bigquery.copyJobId' | 'bigquery.copyJobLink' | 'bigquery.jobDetails' | 'bigquery.refreshJobs' | 'bigquery.pauseJobs'
/** A command catalogue entry, in the shape of `CommandDescriptor`. */
export interface JobHistoryCommandEntry {
  readonly title: string
  readonly category: 'BigQuery'
  readonly icon: 'history' | 'output' | 'plug' | 'go-to-file' | 'debug-restart' | 'debug-stop' | 'copy' | 'link' | 'info' | 'refresh' | 'debug-pause'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly toggled?: string
  readonly unavailableHint: string
  readonly providers: readonly ['bigquery']
  readonly methods?: readonly ('bigquery.jobs.get' | 'bigquery.jobs.cancel' | 'query.attach' | 'live.subscribe')[]
  readonly providerContext?: 'own'
  /** False: left out of the palette. */
  readonly palette?: false
  readonly keybindings?: readonly { readonly key: string; readonly when: string }[]
  readonly menus?: readonly { readonly menu: 'explorer.context' | 'bigquery.jobs.context'; readonly group: string; readonly order: number; readonly title?: string; readonly mnemonic?: string; readonly when?: string }[]
}
/** The context keys that enable the row actions (src/shared/commands/context-keys.ts). */
export type JobHistoryActionKey = 'jobHistoryJobSelected' | 'jobHistoryCanOpenResults' | 'jobHistoryCanReattach' | 'jobHistoryCanOpenSql' | 'jobHistoryCanRerun' | 'jobHistoryCanCancel'
const openHistory = 'Open BigQuery Job History first (BigQuery: Job History).'
const selectJob = 'Select a job in BigQuery Job History.'
/**
 * Job History's commands (docs/bigquery.md, Job History): the document on a BigQuery connection's and its billing project's
 * Object Explorer menus and in the palette (BigQuery: Job History), and the row actions on its grid's menu, which act on the
 * active document's selected job and say why when they do not apply.
 */
export function jobHistoryCommandEntries(): { readonly [K in JobHistoryCommandId]: JobHistoryCommandEntry } {
  const bigquery = ['bigquery'] as const
  // Each row action is enabled by its own key (JobHistoryService.keys), which says whether it applies to the selected job.
  const row = (title: string, icon: JobHistoryCommandEntry['icon'], keywords: readonly string[], group: string, order: number, mnemonic: string, key: JobHistoryActionKey,
    methods?: JobHistoryCommandEntry['methods']): JobHistoryCommandEntry => ({
    title, category: 'BigQuery', icon, keywords: ['bigquery', 'job', ...keywords], precondition: `activeDocumentIsJobHistory && ${key}`, unavailableHint: selectJob, providers: bigquery,
    ...methods ? { methods } : {}, menus: [{ menu: 'bigquery.jobs.context', group, order, mnemonic }]
  })
  return {
    'bigquery.jobHistory': {
      title: jobHistoryTitle, category: 'BigQuery', icon: 'history', keywords: ['bigquery', 'jobs', 'history', 'running', 'cost', 'cancel', 'personal', 'project', 'live'],
      precondition: 'backendReady && hasConnection', unavailableHint: 'Connect to BigQuery first.', providers: bigquery, methods: ['live.subscribe'], providerContext: 'own',
      menus: [{ menu: 'explorer.context', group: '1_monitor', order: 1, mnemonic: 'j', when: "((explorerNode == 'server' && explorerProvider == 'bigquery') || explorerNode == 'bqProject') && !explorerServerLost" }]
    },
    'bigquery.openJobResults': row('Open Results', 'output', ['results', 'open', 'attach'], '1_open', 1, 'o', 'jobHistoryCanOpenResults', ['query.attach']),
    'bigquery.reattachJob': row('Re-attach', 'plug', ['reattach', 'attach', 'follow', 'running'], '1_open', 2, 'a', 'jobHistoryCanReattach', ['query.attach']),
    'bigquery.openJobSql': row('Open SQL in New Tab', 'go-to-file', ['sql', 'query', 'text', 'open'], '2_sql', 1, 's', 'jobHistoryCanOpenSql', ['bigquery.jobs.get']),
    // Not in the palette: their title words ("run", "cancel") would outrank Execute and Cancel Executing Query there, which
    // the palette keeps first. The row's menu and the details pane offer them.
    'bigquery.rerunJob': { ...row('Re-run…', 'debug-restart', ['rerun', 'again'], '2_sql', 2, 'r', 'jobHistoryCanRerun', ['bigquery.jobs.get']), palette: false },
    'bigquery.cancelJob': { ...row('Cancel Job…', 'debug-stop', ['stop', 'kill'], '3_cancel', 1, 'n', 'jobHistoryCanCancel', ['bigquery.jobs.cancel']), palette: false },
    'bigquery.copyJobId': row('Copy Job ID', 'copy', ['copy', 'id', 'clipboard', 'qualified'], '5_copy', 1, 'c', 'jobHistoryJobSelected'),
    'bigquery.copyJobLink': row('Copy Console Link', 'link', ['copy', 'console', 'link', 'url', 'address'], '5_copy', 2, 'l', 'jobHistoryJobSelected'),
    'bigquery.jobDetails': {
      ...row('Job Details', 'info', ['details', 'statistics', 'sql', 'error', 'children'], '9_details', 1, 'd', 'jobHistoryJobSelected', ['bigquery.jobs.get']),
      menus: [{ menu: 'bigquery.jobs.context', group: '9_details', order: 1, title: 'Details', mnemonic: 'd' }],
      keybindings: [{ key: 'enter', when: 'activeDocumentIsJobHistory && !activeDocumentIsJobActivity && liveGridFocus' }]
    },
    // The document's own F5, as Refresh is in Object Explorer and Integration Services Operations.
    'bigquery.refreshJobs': {
      title: 'Refresh Job History', category: 'BigQuery', icon: 'refresh', keywords: ['bigquery', 'jobs', 'reload', 'now'], precondition: 'backendReady && activeDocumentIsJobHistory && jobHistoryRefreshable',
      unavailableHint: openHistory, providers: bigquery,
      keybindings: [{ key: 'f5', when: "activeDocumentIsJobHistory && !activeDocumentIsSsisOperations && !activeDocumentIsSsis && activePanel != 'explorer' && !editorFocus && !queryBarFocus && !activityMonitorFocus && !peekFocus && !peekTabFocus" }],
      menus: [{ menu: 'bigquery.jobs.context', group: '8_view', order: 1, title: 'Refresh', mnemonic: 'f' }]
    },
    'bigquery.pauseJobs': {
      title: 'Pause Job History', category: 'BigQuery', icon: 'debug-pause', keywords: ['bigquery', 'jobs', 'pause', 'resume', 'freeze', 'live'], precondition: 'activeDocumentIsJobHistory && jobHistoryPausable',
      toggled: 'jobHistoryPaused', unavailableHint: openHistory, providers: bigquery, menus: [{ menu: 'bigquery.jobs.context', group: '8_view', order: 2, title: 'Pause', mnemonic: 'p' }]
    }
  }
}
