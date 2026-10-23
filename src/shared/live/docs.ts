// docs/live.md, generated from the live catalogue (npx vitest run tests/live-catalog.test.ts -u).
import { limits } from '../ipc/wire/protocol'
import { defaultBatchRows, defaultBudgetMs, defaultDutyCycle, defaultSettle, defaultSnapshotRows, liveProbeIds, liveTones, liveProbes, liveSourceIds, liveSources, type LiveProbeSpec, type LiveTableSpec } from './catalog'

const seconds = (ms: number) => ms % 1000 === 0 ? `${(ms / 1000).toLocaleString('en-US')} s` : `${ms.toLocaleString('en-US')} ms`
const code = (text: string) => '`' + text + '`'
const editions: Readonly<Record<number, string>> = { 1: 'Personal', 2: 'Standard', 3: 'Enterprise', 4: 'Express', 5: 'Azure SQL Database', 6: 'Azure Synapse', 8: 'Managed Instance', 9: 'Azure SQL Edge', 11: 'Synapse serverless', 12: 'Fabric' }
const runsOn = (probe: LiveProbeSpec) => [
  probe.gates ? `SQL Server ${probe.gates.minMajor} and later; editions ${probe.gates.editions.map(edition => `${edition} (${editions[edition] ?? 'other'})`).join(', ')}` : 'wherever its source runs',
  ...probe.permission === 'serverState' ? ['needs VIEW SERVER PERFORMANCE STATE (2022 and later) or VIEW SERVER STATE'] : []
].join('; ')
const schedule = (probe: LiveProbeSpec) => {
  const budget = probe.budgetMs ?? defaultBudgetMs
  return `budget ${seconds(budget.min)} to ${seconds(budget.max)}; slows above ${Math.round((probe.maxDutyCycle ?? defaultDutyCycle) * 100)} % of its interval${probe.minGapMs ? `; refresh at most every ${seconds(probe.minGapMs)}` : ''}`
}

const count = (value: number) => value.toLocaleString('en-US')
/** A table's own settings: a snapshot's row cap, departed rows and facets; an append table's keyset, settle window and reads. */
const tableRules = (table: LiveTableSpec) => table.mode === 'snapshot'
  ? [`at most ${count(table.rowCap ?? defaultSnapshotRows)} rows`, ...table.departed ? ['keeps departed rows'] : [], ...table.facets?.length ? ['facets ' + table.facets.map(code).join(', ')] : []].join(', ')
  : [`keyset ${code(table.key[0])}`, `settles after ${(table.settle ?? defaultSettle).ticks} ticks and ${seconds((table.settle ?? defaultSettle).ms)}`, `at most ${count(table.batchRows ?? defaultBatchRows)} new rows a tick`].join(', ')

export function renderLiveDocs(): string {
  const L = limits.live
  const lines = [
    '# Live data',
    '',
    '<!-- Generated from src/shared/live/catalog.ts. Regenerate with: npx vitest run tests/live-catalog.test.ts -u -->',
    '',
    'Periodic data (the Activity Monitor, SSIS monitoring, later Object Explorer status) flows through one stream method,',
    '`live.subscribe`, and one control method, `live.update` ([docs/ipc.md](ipc.md#live-subscriptions)). A subscription',
    'names one source and up to ' + L.probes + ' of its probes; the backend schedules every probe and sends one `live.tick` per',
    'scheduler wake, only after the renderer has applied the previous one. This page lists the sources and probes the',
    'catalogue declares, and what each probe emits. Sources marked test only are accepted only by an unpackaged smoke run',
    '(main\'s test schemas) and a backend started with `VARIA_BACKEND_TEST_HOOKS=1`.',
    '',
    '## Sources',
    '',
    'While a source\'s view is hidden it pauses (no SQL), or, with the statusOnly policy, keeps only its probes without tables at',
    `${seconds(L.hiddenIntervalMs)} or slower.`,
    '',
    '| Source | Scope | Probes | Test only | Hidden | Description |',
    '| --- | --- | --- | --- | --- | --- |',
    ...liveSourceIds.map(id => {
      const source = liveSources[id]
      return `| ${code(id)} | ${source.scope} | ${source.probes.map(code).join(', ')} | ${source.testOnly ? 'yes' : 'no'} | ${source.hidden ?? 'pause'} | ${source.description} |`
    }),
    '',
    '## Probes',
    '',
    'A probe\'s statement budget is 0.8 × its interval within the range shown. The series kinds say how the backend turns',
    'raw values into samples: `gauge` as read, `rate` and `msPerSecond` as change per second of the server\'s own clock,',
    '`ratio` as change over a base counter\'s change, `cpuPercent` as CPU time over elapsed time across the schedulers; every',
    'kind but `gauge` is null in a sample marked `baseline` or `resumed` and after a restart (`reset`); a single counter',
    'that went down (cleared) is null alone, also marked `reset`, and the others keep their rates.',
    '',
    'A snapshot table is a new stored result each sample (two revisions alive), sorted as asked with its key breaking ties,',
    'cut at its row cap; one that keeps departed rows keeps a tracked row that left for one more revision. An append table',
    'grows one stored result (a segment) by the rows above the highest id it has settled, rolling to a new segment at',
    `${count(L.segmentRows)} rows or ${L.segmentBytes / 1024 / 1024} MiB (${L.segments} segments' worth kept, in at most ${L.segmentResults} results).`,
    'A probe whose filter mode is memory filters the stored cell text;',
    'restart starts its append tables again under the new predicate.',
    `A table's tone column (its last) names each row's tone (${liveTones.map(code).join(', ')} or NULL for none): the grid`,
    'colours the row and hides the column, and Copy and Save leave it out.',
    '',
    '| Probe | Interval (default, min, max) | Schedule | Runs on | Emits | Description |',
    '| --- | --- | --- | --- | --- | --- |',
    ...liveProbeIds.map(id => {
      const probe = liveProbes[id]
      const emits = [
        ...(probe.series ?? []).length ? ['series ' + (probe.series ?? []).map(series => `${code(series.id)} (${series.unit}, ${series.counter})`).join(', ')] : [],
        ...(probe.tables ?? []).map((table, index) => `${table.mode} table ${index} ${code(table.id)}: ${table.columns.map(column => `${code(column.id)} ${column.dataType}${column.role === 'tone' ? ' (row tone)' : ''}`).join(', ')}; key ${table.key.map(code).join(', ') || 'none'}; ${tableRules(table)}`),
        ...(probe.status ?? []).length ? ['status ' + (probe.status ?? []).map(code).join(', ')] : []
      ]
      const settings = [...probe.views?.length ? ['views ' + probe.views.map(code).join(', ')] : [], ...probe.filterMode ? [`filter ${probe.filterMode}`] : []]
      return `| ${code(id)} | ${seconds(probe.intervalMs.default)}, ${seconds(probe.intervalMs.min)}, ${seconds(probe.intervalMs.max)} | ${[schedule(probe), ...settings].join('; ')} | ${runsOn(probe)} | ${emits.join('; ')} | ${probe.description} |`
    }),
    '',
    '## Limits',
    '',
    '| Item | Value |',
    '| --- | --- |',
    `| Subscriptions | ${L.portStreams} per results port (main), ${L.backendSubscriptions} per backend, ${L.perServer} per SQL Server (by the server a connection reaches) |`,
    `| Probes | ${L.probes} per subscription; ${L.tablesPerProbe} snapshot and ${L.appendPerProbe} append tables per probe, ${L.tablesPerTick} tables per tick |`,
    `| Interval | ${seconds(L.intervalMs.min)} to ${seconds(L.intervalMs.max)} requested, then clamped to the probe's own minimum and maximum |`,
    `| Frames | one unacknowledged per subscription; initial credit ${L.initialCredit / 1024} KiB; at most ${limits.eventBody / 1024} KiB each, and the catalogue's worst case at most ${L.frameBudget / 1024} KiB |`,
    `| Series, status values, errors | ${L.series} series per probe; ${L.statuses} status values of ${L.statusCharacters} characters; ${L.errors} probe errors of ${L.messageCharacters.toLocaleString('en-US')} characters per tick |`,
    `| Sort, filter, tracking | ${L.sortColumns} sort columns; filter text ${L.filterCharacters} characters on ${L.filterColumns} columns; ${L.trackedKeys} tracked keys of ${L.keyCharacters} characters per table |`,
    `| Resume token, kept results | ${L.resumeCharacters} base64url characters; ${L.kept} results kept when a source ends |`,
    `| Tables | a snapshot revision at most ${count(L.snapshotRows)} rows (a table's own cap may be lower); an append segment ${count(L.segmentRows)} rows or ${L.segmentBytes / 1024 / 1024} MiB, ${L.segments} segments' worth kept in at most ${L.segmentResults} results a table; at most ${count(L.batchRows)} new append rows a tick |`,
    `| Table memory | ${L.subscriptionBytes / 1024 / 1024} MiB per subscription, all live tables at most ${L.budgetShare * 100} % of the result budget; past either, a sample stores what fits and reports BUDGET |`,
    `| Facets, departed rows | ${L.facetColumns} columns of ${L.facetValues} values of ${L.facetCharacters} characters, at most ${L.facetBytes / 1024} KiB of text a tick; ${L.trackedKeys} departed rows per table |`,
    `| Live statements | ${L.statementsPerConnection} at once per connection and ${L.statements} in the backend (shared with unary methods on lane live); a statement waits for its turn at most its budget, then the probe reports BUSY |`,
    `| Statement budget | 0.8 × the probe's interval, within the probe's range and ${seconds(L.budgetMs.min)} to ${seconds(L.budgetMs.max)} |`,
    `| Back-off | a failing or costly probe slows to at most ${seconds(L.backoffMs)} (or its asked interval, when longer) |`,
    `| Idle connection | returned to the pool while every probe is paused, when the next sample is at least ${seconds(L.idleMs)} away, and between samples when every running probe's interval in force is at least ${seconds(L.idleMs)} |`,
    ''
  ]
  return lines.join('\n')
}
