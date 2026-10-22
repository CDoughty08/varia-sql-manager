// docs/live.md, generated from the live catalogue (npx vitest run tests/live-catalog.test.ts -u).
import { limits } from '../ipc/wire/protocol'
import { liveProbeIds, liveProbes, liveSourceIds, liveSources } from './catalog'

const seconds = (ms: number) => ms % 1000 === 0 ? `${(ms / 1000).toLocaleString('en-US')} s` : `${ms.toLocaleString('en-US')} ms`
const code = (text: string) => '`' + text + '`'

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
    '| Source | Scope | Probes | Test only | Description |',
    '| --- | --- | --- | --- | --- |',
    ...liveSourceIds.map(id => {
      const source = liveSources[id]
      return `| ${code(id)} | ${source.scope} | ${source.probes.map(code).join(', ')} | ${source.testOnly ? 'yes' : 'no'} | ${source.description} |`
    }),
    '',
    '## Probes',
    '',
    '| Probe | Interval (default, min, max) | Emits | Description |',
    '| --- | --- | --- | --- |',
    ...liveProbeIds.map(id => {
      const probe = liveProbes[id]
      const emits = [
        ...(probe.series ?? []).length ? ['series ' + (probe.series ?? []).map(series => `${code(series.id)} (${series.unit})`).join(', ')] : [],
        ...(probe.tables ?? []).map((table, index) => `${table.mode} table ${index} ${code(table.id)}: ${table.columns.map(column => `${code(column.id)} ${column.dataType}`).join(', ')}; key ${table.key.map(code).join(', ') || 'none'}`),
        ...(probe.status ?? []).length ? ['status ' + (probe.status ?? []).map(code).join(', ')] : []
      ]
      return `| ${code(id)} | ${seconds(probe.intervalMs.default)}, ${seconds(probe.intervalMs.min)}, ${seconds(probe.intervalMs.max)} | ${emits.join('; ')} | ${probe.description} |`
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
    ''
  ]
  return lines.join('\n')
}
