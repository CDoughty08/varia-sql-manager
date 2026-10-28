// Renders docs/activity-monitor.md from the Activity Monitor catalogue; tests/activity-catalog.test.ts keeps the file in sync.
import {
  activityBands, activityEditions, activityIntervalDefaults, activityIntervalsSeconds, activityLimits, activityLoadGuard, activityPanes, activityPoolSuffix, activityProbes, activitySource, activityTables, benignCategories, benignWaits, blockerLabels,
  defaultPanes, detailsSections, detailsTexts, killOutcomes, maxExpandedTiles, paneSpecs, probeSeries, probeSpecs, rankChips, rowTones, seriesSpecs, sessionToggles, tableSpecs, tileSpecs, unavailableMessage, variaSessionKinds,
  viewChipNotes, viewChips, viewChipTitles, waitCategories, waitExceptions, waitsChartSeries, waitToggles, type ColumnSpec, type ThresholdSpec
} from './catalog.ts'

/** The results grid's copy keys the Differences section cites; tests/activity-catalog.test.ts checks them against the commands catalogue. */
export const copyKeys = {
  'output.copy': { other: 'Ctrl+C', darwin: '⌘C' },
  'output.copyWithHeaders': { other: 'Ctrl+Shift+C', darwin: '⇧⌘C' }
} as const

const cell = (value: string) => value.replaceAll('|', '\\|')
const row = (cells: readonly string[]) => '| ' + cells.map(cell).join(' | ') + ' |'
const table = (header: readonly string[], rows: readonly (readonly string[])[]) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n')
const code = (value: string) => '`' + value + '`'
const number = (value: number) => value.toLocaleString('en-US')
const seconds = (ms: number) => ms % 1_000 === 0 ? `${number(ms / 1_000)} s` : `${number(ms)} ms`
const parityLabel = { ssms: 'SSMS', new: 'New', fix: 'Fixed' } as const
const columnUnit = (column: ColumnSpec) => column.unit === 'id' ? 'id' : column.unit || '—'
const threshold = (spec: ThresholdSpec) => {
  const label = seriesSpecs[spec.series]?.label ?? spec.series
  const bounds = [spec.warning !== undefined ? `warning ≥ ${number(spec.warning)}` : '', spec.error !== undefined ? `error ≥ ${number(spec.error)}` : ''].filter(Boolean).join(', ')
  const settings = spec.settings ? ' (' + Object.values(spec.settings).map(code).join(', ') + (spec.settingScale === 1_000 ? ', in seconds' : '') + ')' : ''
  return `${label}: ${bounds}${spec.while ? ` while ${seriesSpecs[spec.while]?.label.toLowerCase()} > 0` : ''}${settings}`
}
const limitNotes: Readonly<Record<keyof typeof activityLimits, string>> = {
  monitorsPerConnection: 'Activity Monitors per connection; opening another activates it',
  probesPerMonitor: 'Probes of the monitor\'s one subscription',
  sessions: 'Processes rows; more set `truncated` and drop idle sessions first (sessions in a blocking wait come first, then those with a request)',
  blockingEdges: 'Blocking waits read per sample',
  blockingRows: 'Blocking rows',
  blockingDepth: 'Depth of a blocking chain the Blocking pane shows',
  activeQueries: 'Active Expensive Queries rows',
  waitTypes: 'Wait types rows',
  files: 'Data File I/O rows',
  queryStatsRows: 'Query statistics rows read per sample',
  queryDeltaKeys: 'Statements whose totals are kept between samples (oldest dropped first)',
  shownHashes: 'Recent Expensive Queries rows',
  textCache: 'Statement texts kept for Recent Expensive Queries',
  textBatch: 'Statement texts fetched per statement',
  textBatchesPerTick: 'Text statements per sample',
  leadBlockerBatches: 'Lead blockers whose last batch is read per sample',
  statementChars: 'Characters of a statement in a grid',
  inputBufferChars: 'Characters of a lead blocker\'s last batch read per sample',
  resourceChars: 'Characters of a wait resource description',
  lastBatchChars: 'Characters of the last batch on a Blocking row',
  facetColumns: 'Columns with value filters',
  facetValues: 'Distinct values a column filter lists',
  facetChars: 'Characters of a listed value',
  filterText: 'Characters in the filter box',
  columnFilters: 'Column filters at once',
  columnFilterValues: 'Values chosen in one column filter',
  columnFilterChars: 'Characters of a chosen value',
  columnsPerProjection: 'Columns a pane asks for',
  detailsChars: 'Characters of a text Details returns whole when asked for it (Open in Query Editor)',
  detailsPreviewChars: 'Characters of each text (statement, batch, last batch) in the Details flyout',
  detailsWaits: 'Session waits in Details',
  detailsTransactions: 'Transaction rows (one per transaction and database) in Details',
  detailsLocks: 'Grouped lock rows in Details',
  detailsBudgetMs: 'Milliseconds a Details read may take, gate wait and connect included, before it answers TIMEOUT',
  detailsRunning: 'Details reads main tracks for cancellation at once',
  killSessions: 'Sessions one Kill Process request may end',
  killBudgetMs: 'Milliseconds a Kill Process request may take; past it, sessions not yet tried are left alone and reported so',
  killMessageChars: 'Characters of a Kill outcome\'s message',
  cancelIds: 'Details reads one cancel may name',
  cancelTombstones: 'Cancelled Details ids main remembers, so a read cancelled before it was sent is refused',
  cancelTombstoneMs: 'Milliseconds main remembers them',
  sessionId: 'The largest session id'
}

function columnsTable(columns: readonly ColumnSpec[]): string {
  return table(['Column', 'Id', 'Type', 'Unit', 'Shown', 'Parity', 'Notes'], columns.map(column =>
    [column.caption, code(column.id), column.type, columnUnit(column), column.visible ? 'Yes' : '', parityLabel[column.parity], column.note + (column.capability ? ` Needs ${code(column.capability)}.` : '')]))
}

export function renderActivityMonitorDocs(): string {
  const overview = probeSpecs['activity.overview'], queries = activityIntervalDefaults.queriesIntervalSeconds
  const benignLabels = benignCategories.map(id => waitCategories.find(category => category.id === id)!.label).join(', ')
  return [
    '# Activity Monitor',
    '',
    '<!-- Generated from src/shared/activity/catalog.ts. Regenerate with: npx vitest run tests/activity-catalog.test.ts -u -->',
    '',
    'The Activity Monitor\'s probes, panes, columns, tiles, filters, wait categories and limits are data in',
    '`src/shared/activity/catalog.ts`; the backend embeds the same data as `backend/Varia.Backend/Activity/activity-catalog.json`',
    'and runs constant SQL from `backend/Varia.Backend/Activity/ActivitySql.cs`. Unlike SSMS, a failing query never pauses',
    'the monitor: each probe fails alone, its panes keep their last data and say why, and the others go on. The Activity',
    'Monitor document arrives in stages; this page is what its catalogue declares, and the SQL and rules the backend already has.',
    '',
    '## Sampling',
    '',
    `One monitor is one live subscription to the source ${code(activitySource)}, with four probes. They run on their own pool, the`,
    `connection's program name plus "${activityPoolSuffix}", under READ UNCOMMITTED with LOCK_TIMEOUT 1000 and DEADLOCK_PRIORITY LOW,`,
    'so a probe waiting on a lock answers BLOCKED within a second and tries again. Rates are computed from SQL Server\'s own',
    'clock (`ms_ticks`) in backend memory; no temp table, tempdb write or metadata function is used, and a probe whose panes',
    'are not shown is paused (no SQL).',
    '',
    table(['Probe', 'Kind', 'Tables', 'Default', 'Lowest', 'At least', 'Budget', 'Refresh Now gap', 'Filters'], activityProbes.map(probe => {
      const spec = probeSpecs[probe]
      return [code(probe), spec.kind, spec.tables.map(code).join(', ') || '—', seconds(spec.defaultIntervalMs), seconds(spec.minIntervalMs), seconds(spec.floorMs), seconds(spec.budgetMs) + (spec.maxdop1 ? ', MAXDOP 1' : ''), spec.minGapMs ? seconds(spec.minGapMs) : '—', spec.filterMode === 'memory' ? 'In memory' : '—']
    })),
    '',
    `The monitor has one interval: ${activityIntervalsSeconds.map(value => `${value} s`).join(', ')} (default ${seconds(overview.defaultIntervalMs)}). Each probe uses it raised`,
    `to its "At least" value; query statistics use their own setting (${queries.min} to ${queries.max} s, default ${queries.default} s), because reading the plan cache`,
    'costs more. SSMS\'s 5, 30 and 60 minute intervals are left out: the charts keep history. When a probe\'s sample costs more',
    `than ${number(overview.maxDutyCycle * 100)} % of its interval ${activityLoadGuard.slowSamples} times in a row, its interval doubles (up to ${seconds(overview.maxIntervalMs)}) and the header says so; it steps back`,
    `after ${activityLoadGuard.cheapSamples} cheap samples. Pause stops collecting (no SQL); the charts show a gap and Resume starts a new baseline.`,
    '',
    '## Panes',
    '',
    table(['Pane', 'Id', 'Probe', 'Tables', 'Badge counts'], activityPanes.map(pane => {
      const spec = paneSpecs[pane]
      return [spec.title, code(pane), code(spec.probe), spec.tables.map(code).join(', '), spec.badge === 'blocked' ? 'Blocked sessions' : 'Rows shown']
    })),
    '',
    `Split view shows two panes; on first open ${paneSpecs[defaultPanes.primary].title} and ${paneSpecs[defaultPanes.secondary].title}. Nothing is collapsed,`,
    'and no pane needs expanding to show data.',
    '',
    '## Tiles',
    '',
    `Eight tiles, the first four SSMS's four charts with SSMS's names. Activating a tile expands its chart; at most ${maxExpandedTiles} are`,
    'expanded, and the first two are expanded on first open.',
    '',
    table(['Tile', 'Value', 'Secondary', 'Tint', 'Parity', 'Expanded first'], tileSpecs.map(tile => [
      tile.caption, `${seriesSpecs[tile.series]!.label} (${seriesSpecs[tile.series]!.unit}, ${tile.value === 'rate' ? 'rate over the interval' : 'now'})`,
      tile.secondary.map(id => seriesSpecs[id]!.label).join(', ') || '—', tile.thresholds.map(threshold).join('; ') || '—', parityLabel[tile.parity], tile.defaultExpanded ? 'Yes' : ''
    ])),
    '',
    '### Series',
    '',
    table(['Series', 'Label', 'Unit', 'Sent as', 'Kind', 'Notes'], [...activityProbes.flatMap(probe => probeSpecs[probe].series.filter(id => id !== 'wait.*'))].map(id => {
      const spec = seriesSpecs[id]!
      return [code(id), spec.label, spec.unit, code(spec.liveUnit), spec.kind, spec.note]
    }).concat([[code('wait.<category>'), 'Wait category', 'ms/s', code('msPerSecond'), 'msPerSecond', `One per wait category (${probeSeries('activity.resources').length - 1}): wait time less signal wait, per second.`]])),
    '',
    `Resource Waits charts the ${waitsChartSeries} largest categories, each in its own colour, and the rest as Other; benign waits (${benignLabels}) are never charted.`,
    'A rate has no value on the first sample, after Resume, after a reconnect, or when SQL Server restarted or its statistics',
    'were cleared; charts draw a gap there.',
    '',
    '## Tables',
    '',
    ...activityTables.flatMap(id => {
      const spec = tableSpecs[id]
      const facts = [
        `Probe ${code(spec.probe)}; key ${spec.key.map(code).join(', ')}${spec.identity ? ` (with ${spec.identity.map(code).join(', ')} for rates)` : ''}; at most ${number(spec.rowCap)} rows.`,
        spec.defaultSort.length ? `Default order: ${spec.defaultSort.map(sort => `${spec.columns.find(column => column.id === sort.column)!.caption} ${sort.descending ? 'descending' : 'ascending'}`).join(', ')}.` : 'Order: lead blockers by sessions downstream, then longest wait, each followed by the sessions it blocks.',
        spec.tones ? `Row tones: ${spec.tones.map(tone => `${tone} (${rowTones[tone]})`).join(', ')}.` : '',
        spec.departedLinger ? 'A selected row whose session ended stays one more sample, toned departed.' : ''
      ].filter(Boolean).join(' ')
      return [`### ${spec.title} (${code(id)})`, '', facts, '', columnsTable(spec.columns), '']
    }),
    '## Filters',
    '',
    'Filters run in the backend over the sample; the SQL never changes.',
    '',
    table(['View', 'Id', 'Shows'], viewChips.map(view => [viewChipTitles[view], code(view), viewChipNotes[view]])),
    '',
    `Toggles: ${Object.values(sessionToggles).map(toggle => `${toggle.title} (${code(toggle.setting)}, off by default)`).join(', ')}. The filter box matches`,
    `case-insensitively against ${tableSpecs.sessions.textColumns!.map(column => tableSpecs.sessions.columns.find(spec => spec.id === column)!.caption).join(', ')}.`,
    `Column value filters (Alt+Down on a header) offer (All), (Blanks), (Non-blanks) and each value with its count for ${tableSpecs.sessions.facetColumns!.map(column => tableSpecs.sessions.columns.find(spec => spec.id === column)!.caption).join(', ')}.`,
    'Several values in one column match any of them; filters on several columns must all match.',
    `Resource Waits has ${waitToggles.hideBenign.title} (${waitToggles.hideBenign.default ? 'on' : 'off'} by default), which leaves out benign wait types and the ${benignLabels} category.`,
    '',
    `Recent Expensive Queries ranks by ${Object.values(rankChips).map(chip => chip.title).join(', ')}, re-sorted from the last sample without new SQL.`,
    '',
    '## Blocking',
    '',
    'The chain is built from `sys.dm_os_waiting_tasks` (task-level waits, a parallel query\'s waits on itself left out), plus a',
    'request\'s `blocking_session_id` where no task wait names it. Each session appears once: SSMS lists a blocker once per',
    'session it blocks. A session waiting on several sessions hangs under the one it has waited on longest. A lead blocker',
    'blocks someone and waits on no one; an idle session holding a transaction is a lead blocker too, with its open',
    'transactions from `sys.dm_exec_sessions` (SSMS shows 0). A cycle (a deadlock SQL Server has not resolved yet) is cut at its',
    `lowest session id, and its sessions are marked. Chains deeper than ${activityLimits.blockingDepth} or longer than ${number(activityLimits.blockingRows)} rows are cut and marked truncated.`,
    '',
    'A wait on a negative id (below) is not a wait on a session: Processes shows its meaning in Blocked By, but the session',
    'is not counted as blocked (the Blocked Sessions tile and the Blocking badge count waits on sessions only), is a Blocking',
    'row only when it blocks someone, and a lead blocker waiting on a latch stays the head of its chain.',
    '',
    table(['Blocking session id', 'Shown as'], Object.entries(blockerLabels).map(([id, label]) => [id, label])),
    '',
    '## Wait categories',
    '',
    'Query Store\'s documented categories ([sys.query_store_wait_stats](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-wait-stats-transact-sql)),',
    'matched in this order: Varia\'s benign list (counted in Idle), Query Store\'s exceptions and exact names, then prefixes in',
    'the table\'s order. Anything else is Unknown, which is shown, never dropped: SSMS\'s 2008 table knows 241 of SQL Server',
    '2025\'s 1,546 wait types and drops the rest. THREADPOOL (Worker Thread), CXPACKET and CXCONSUMER (Parallelism) and',
    'SOS_SCHEDULER_YIELD (CPU) are shown. The numbers therefore differ from SSMS\'s Resource Waits.',
    '',
    `A wait type is benign when it is on Varia's benign list or in the ${benignLabels} category: a thread waiting for work. Benign`,
    'waits never count in Waiting Tasks and are never charted, and Hide benign waits hides them; every other type counts,',
    'Unknown ones too.',
    '',
    table(['Value', 'Category', 'Id', 'Wait types'], waitCategories.map(category => [String(category.value), category.label, code(category.id),
      [...category.names, ...category.patterns].map(code).join(', ') || '(anything not matched)'])),
    '',
    'Exceptions:',
    '',
    table(['Wait type', 'Category', 'Why'], waitExceptions.map(exception => [code(exception.name), waitCategories.find(category => category.id === exception.category)!.label, exception.note])),
    '',
    'Varia\'s benign list:',
    '',
    table(['Wait type', 'Why it is benign'], benignWaits.map(wait => [code(wait.name), wait.reason])),
    '',
    '## Varia\'s own sessions',
    '',
    'A session whose host process is the backend and whose program name is the connection\'s Application Name plus one of',
    'these suffixes is Varia\'s. Query tabs always show, labelled with the tab\'s name; pool sessions show only with Varia\'s own on.',
    '',
    table(['Suffix', 'Kind', 'Label'], variaSessionKinds.map(kind => [kind.suffix ? `"${kind.suffix}"` : '(none)', kind.kind === 'queryTab' ? 'Query tab' : 'Pool', kind.label])),
    '',
    '## Servers and permissions',
    '',
    table(['Server', 'EngineEdition', 'Available'], Object.values(activityEditions).map(spec => [spec.label, spec.editions.join(', '), spec.available ? 'Yes' : 'Later'])),
    '',
    `Its SQL is written for SQL Server 2016 (band ${activityBands.min}) to SQL Server 2025 (band ${activityBands.max}); Managed Instance uses the`,
    `catalog it has, not the version it reports. Any other server opens the document with "${unavailableMessage}"`,
    '',
    'Showing other sessions and server activity needs VIEW SERVER STATE (SQL Server 2019 and earlier, Managed Instance) or',
    'VIEW SERVER PERFORMANCE STATE (SQL Server 2022 and later). Without it the monitor still opens, shows the login\'s own',
    'session, and offers the GRANT statement to copy (never runs it). File names need VIEW ANY DEFINITION; without it Data',
    'File I/O shows ids. Kill Process needs ALTER ANY CONNECTION (sysadmin or processadmin), and server state to see the',
    'session it checks (below).',
    '',
    '## Session actions',
    '',
    'Details and Kill Process act on a row of Processes, Blocking or Active Expensive Queries. Both name the session by its id',
    'and its login time (`2026-10-22T06:50:12.347`: server local time, as `sys.dm_exec_sessions` has it, within `datetime`\'s',
    'range), because SQL Server reuses session ids.',
    '',
    `**Details** (${code('activity.details')}) reads the session on the monitor's pool ("${activityPoolSuffix}", READ UNCOMMITTED,`,
    `LOCK_TIMEOUT 1000) under the live gates, within ${seconds(activityLimits.detailsBudgetMs)} in all: a lock wait answers BLOCKED and the budget TIMEOUT, as`,
    'values; when the live views hold every gate for the whole budget it answers BUSY. It checks visibility and identity in `sys.dm_exec_sessions` alone before joining other DMVs. When no session has the id it answers `ended` (also when the login cannot see other',
    'sessions), and when another session has it (its login time differs) `changed`, reading nothing more. The richer session read checks the identity again, and every later section reads only while the id still has that login time, so an id reused meanwhile reads nothing rather than another session\'s rows. Every other section',
    'is a statement of its own, so a permission or a lock that stops one leaves the rest. The flyout shows each text\'s first',
    `${number(activityLimits.detailsPreviewChars)} characters; asked for one text by name (${detailsTexts.map(code).join(', ')}), Details returns only that`,
    `text, whole up to ${number(activityLimits.detailsChars)} characters, for Open in Query Editor. Closing the flyout cancels the read (an attention`,
    'ends it in SQL Server).',
    '',
    table(['Section', 'Id', 'Reads'], detailsSections.map(section => [section.title, code(section.id), section.reads])),
    '',
    `**Kill Process** (${code('activity.kill')}, up to ${activityLimits.killSessions} sessions) runs on the object actions' own connection, so \`sp_who2\` shows the`,
    'kill as a session of the connection\'s program name plus " - Object Actions": unpooled, never retried, with LOCK_TIMEOUT',
    '10000. For each session in order, one batch checks that the id is not its own session\'s, that the session exists, is a',
    'user session, still has the login time and host process id the row showed, and is not one of this window\'s pool',
    'sessions (those of every connection in the window, whatever Application Name each set); only then does it run KILL,',
    'built on the server from the session id (an int parameter), never from text. One Kill runs at a time per connection and',
    `two in the window; another waits up to 5 seconds, then answers BUSY. A request has ${seconds(activityLimits.killBudgetMs)} in all; sessions not tried by then`,
    'are left alone and the answer says so. Rollback progress needs',
    'no polling: Processes shows "rolling back n %" from the session\'s own request. Kill\'s checks need server state to see',
    'the session too: without it every other session answers `ended`, and nothing is killed.',
    '',
    table(['Outcome', 'Meaning'], (Object.keys(killOutcomes) as (keyof typeof killOutcomes)[]).map(outcome => [code(outcome), killOutcomes[outcome]])),
    '',
    '## Differences from SSMS',
    '',
    '- A failing query never pauses the monitor; each probe fails alone and says why.',
    '- CPU comes from SQL Server\'s schedulers, on every platform, never from WMI or performance counters of the host.',
    '- Wait categories are Query Store\'s, so CPU, worker thread, parallelism and modern wait types are counted (above).',
    '- Pause means stop collecting; the monitor never polls while its window is hidden.',
    `- Copy keys are the results grid's (${copyKeys['output.copy'].other} the selection, ${copyKeys['output.copyWithHeaders'].other} with headers; ${copyKeys['output.copy'].darwin} and ${copyKeys['output.copyWithHeaders'].darwin} on macOS), not SSMS's copy-a-cell.`,
    '',
    table(['Pane', 'Column', 'Varia'], activityTables.flatMap(id => tableSpecs[id].columns.filter(column => column.parity === 'fix').map(column => [tableSpecs[id].title, column.caption, column.note]))
      .concat(tileSpecs.filter(tile => tile.parity === 'fix').map(tile => ['Tiles', tile.caption, seriesSpecs[tile.series]!.note]))),
    '',
    '## Limits',
    '',
    table(['Limit', 'Value', 'Meaning'], (Object.keys(limitNotes) as (keyof typeof activityLimits)[]).map(key => [code(key), number(activityLimits[key]), limitNotes[key]])),
    ''
  ].join('\n')
}
