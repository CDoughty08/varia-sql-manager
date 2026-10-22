// Renders docs/activity-monitor.md from the Activity Monitor catalogue; tests/activity-catalog.test.ts keeps the file in sync.
import {
  activityBands, activityEditions, activityIntervalsSeconds, activityLimits, activityPanes, activityPoolSuffix, activityProbes, activitySource, activityTables, benignWaits, blockerLabels,
  defaultPanes, maxExpandedTiles, paneSpecs, probeSeries, probeSpecs, rankChips, rowTones, seriesSpecs, sessionToggles, tableSpecs, tileSpecs, unavailableMessage, variaSessionKinds,
  viewChipNotes, viewChips, viewChipTitles, waitCategories, waitExceptions, waitsChartSeries, type ColumnSpec, type ThresholdSpec
} from './catalog.ts'

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
  sessions: 'Processes rows; more set `truncated`',
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
  detailsChars: 'Characters of each text in Details (statement, batch, input buffer)',
  detailsWaits: 'Session waits in Details',
  detailsTransactions: 'Transactions in Details',
  detailsLocks: 'Grouped lock rows in Details',
  killSessions: 'Sessions one Kill Process request may end',
  sessionId: 'The largest session id'
}

function columnsTable(columns: readonly ColumnSpec[]): string {
  return table(['Column', 'Id', 'Type', 'Unit', 'Shown', 'Parity', 'Notes'], columns.map(column =>
    [column.caption, code(column.id), column.type, columnUnit(column), column.visible ? 'Yes' : '', parityLabel[column.parity], column.note + (column.capability ? ` Needs ${code(column.capability)}.` : '')]))
}

export function renderActivityMonitorDocs(): string {
  const overview = probeSpecs['activity.overview']
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
    table(['Probe', 'Kind', 'Tables', 'Default', 'Lowest', 'At least', 'Budget', 'Refresh Now gap'], activityProbes.map(probe => {
      const spec = probeSpecs[probe]
      return [code(probe), spec.kind, spec.tables.map(code).join(', ') || '—', seconds(spec.defaultIntervalMs), seconds(spec.minIntervalMs), seconds(spec.floorMs), seconds(spec.budgetMs) + (spec.maxdop1 ? ', MAXDOP 1' : ''), spec.minGapMs ? seconds(spec.minGapMs) : '—']
    })),
    '',
    `The monitor has one interval: ${activityIntervalsSeconds.map(value => `${value} s`).join(', ')} (default ${seconds(overview.defaultIntervalMs)}). Each probe uses it raised`,
    'to its "At least" value; query statistics use their own setting (15 to 60 s, default 30 s), because reading the plan cache',
    'costs more. SSMS\'s 5, 30 and 60 minute intervals are left out: the charts keep history. When a probe\'s sample costs more',
    `than ${number(overview.maxDutyCycle * 100)} % of its interval three times in a row, its interval doubles (up to 60 s) and the header says so; it steps back`,
    'after ten cheap samples. Pause stops collecting (no SQL); the charts show a gap and Resume starts a new baseline.',
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
    table(['Series', 'Label', 'Unit', 'Kind', 'Notes'], [...activityProbes.flatMap(probe => probeSpecs[probe].series.filter(id => id !== 'wait.*'))].map(id => {
      const spec = seriesSpecs[id]!
      return [code(id), spec.label, spec.unit, spec.kind, spec.note]
    }).concat([[code('wait.<category>'), 'Wait category', 'ms/s', 'msPerSecond', `One per wait category (${probeSeries('activity.resources').length - 1}): wait time less signal wait, per second.`]])),
    '',
    `Resource Waits charts the ${waitsChartSeries} largest categories, each in its own colour, and the rest as Other.`,
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
    table(['Blocking session id', 'Shown as'], Object.entries(blockerLabels).map(([id, label]) => [id, label])),
    '',
    '## Wait categories',
    '',
    'Query Store\'s documented categories ([sys.query_store_wait_stats](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-wait-stats-transact-sql)),',
    'matched in this order: Varia\'s benign list (counted in Idle and never in Waiting Tasks), Query Store\'s exceptions and exact',
    'names, then prefixes in the table\'s order. Anything else is Unknown, which is shown, never dropped: SSMS\'s 2008 table',
    'knows 241 of SQL Server 2025\'s 1,546 wait types and drops the rest. THREADPOOL (Worker Thread), CXPACKET and CXCONSUMER',
    '(Parallelism) and SOS_SCHEDULER_YIELD (CPU) are shown. The numbers therefore differ from SSMS\'s Resource Waits.',
    '',
    table(['Value', 'Category', 'Id', 'Wait types'], waitCategories.map(category => [String(category.value), category.label, code(category.id),
      [...category.names, ...category.patterns].map(code).join(', ') || '(anything not matched)'])),
    '',
    'Exceptions:',
    '',
    table(['Wait type', 'Category', 'Why'], waitExceptions.map(exception => [code(exception.name), waitCategories.find(category => category.id === exception.category)!.label, exception.note])),
    '',
    'Benign waits:',
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
    'File I/O shows ids. Kill Process needs ALTER ANY CONNECTION (sysadmin or processadmin).',
    '',
    'Kill Process runs on the object actions\' own connection, so `sp_who2` shows the kill as a session of the program',
    'name plus " - Object Actions": unpooled, never retried, and checking the session\'s login time and host process id',
    'first, so a session id SQL Server has reused is never killed.',
    '',
    '## Differences from SSMS',
    '',
    '- A failing query never pauses the monitor; each probe fails alone and says why.',
    '- CPU comes from SQL Server\'s schedulers, on every platform, never from WMI or performance counters of the host.',
    '- Wait categories are Query Store\'s, so CPU, worker thread, parallelism and modern wait types are counted (above).',
    '- Pause means stop collecting; the monitor never polls while its window is hidden.',
    '- Copy keys are the results grid\'s (Ctrl+C the selection, Ctrl+Shift+C with headers), not SSMS\'s copy-a-cell.',
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
