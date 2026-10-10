import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Compares the benchmark results (artifacts/bench/node.json from npm run bench, e2e.json from npm run bench:e2e, and
// grid.json from npm run bench:grid) with tests/bench/floors.json, prints a markdown table, and appends it to
// $GITHUB_STEP_SUMMARY. With --enforce it exits 1 when a value is worse than its floor or a metric with a floor was not
// measured (a live metric only when its harness ran --live). Without it, it only reports (Windows and macOS CI).

const formatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 })
const show = (value, unit) => `${Math.abs(value) >= 1000 ? Math.round(value).toLocaleString('en-US') : formatter.format(value)} ${unit}`
const bound = (better, value, unit) => value === null || value === undefined ? '—' : `${better === 'higher' ? '≥' : '≤'} ${show(value, unit)}`
const meets = (better, value, limit) => better === 'higher' ? value >= limit : value <= limit

/** A metric's harness is the first segment of its id: `node`, `e2e` or `grid`. */
const harnessOf = id => id.split('.')[0]

/**
 * One row per metric in `floors.metrics`. `results` are the parsed result files (each `{ harness, live?, metrics }`).
 * Status: 'target' (meets its target), 'floor' (meets its floor only), 'below' (worse than its floor), 'report'
 * (worse than its target, no floor), 'missing' (not measured; `required` when enforcement must fail).
 */
export function compare(floors, results) {
  const measured = Object.assign({}, ...results.map(result => result.metrics))
  const live = new Set(results.filter(result => result.live === true).map(result => result.harness))
  return Object.entries(floors.metrics).map(([id, spec]) => {
    const metric = measured[id]
    if (!metric) return { id, spec, status: 'missing', required: spec.floor !== null && (!spec.live || live.has(harnessOf(id))) }
    const status = meets(spec.better, metric.value, spec.target) ? 'target' : spec.floor === null ? 'report' : meets(spec.better, metric.value, spec.floor) ? 'floor' : 'below'
    return { id, spec, metric, status, required: false }
  })
}

const labels = { target: 'meets target', floor: 'above floor', below: '**below floor**', report: 'reported', missing: 'not measured' }

export function markdown(rows, results) {
  const machines = results.map(result => `${result.harness}: ${result.platform} ${result.arch}, ${result.cpus} × ${result.cpu}, Node ${result.node}${result.view ? `, ${result.view.width} × ${result.view.height} window` : ''}${result.harness === 'node' ? '' : result.live ? ', live SQL' : ', no live SQL'}`)
  return [
    '### Benchmarks',
    '',
    ...machines.map(line => `- ${line}`),
    '',
    '| Metric | Measured | Target | Floor | Status |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.spec.title} | ${row.metric ? show(row.metric.value, row.spec.unit) : '—'} | ${bound(row.spec.better, row.spec.target, row.spec.unit)} | ${bound(row.spec.better, row.spec.floor, row.spec.unit)} | ${labels[row.status]} |`),
    ''
  ].join('\n')
}

/** Whether enforcement fails: a value below its floor, or a required metric missing. */
export function failed(rows) { return rows.filter(row => row.status === 'below' || (row.status === 'missing' && row.required)) }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const enforce = process.argv.includes('--enforce')
  const floors = JSON.parse(readFileSync(resolve('tests/bench/floors.json'), 'utf8'))
  const results = ['node', 'e2e', 'grid'].map(name => resolve('artifacts/bench', name + '.json')).filter(path => existsSync(path)).map(path => JSON.parse(readFileSync(path, 'utf8')))
  const rows = compare(floors, results)
  const table = markdown(rows, results)
  console.log(table)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + '\n')
  const failures = failed(rows)
  if (enforce && failures.length > 0) {
    console.error(`Benchmark floors failed: ${failures.map(row => row.id + (row.metric ? ` (${show(row.metric.value, row.spec.unit)}, floor ${bound(row.spec.better, row.spec.floor, row.spec.unit)})` : ' (not measured)')).join('; ')}.`)
    process.exit(1)
  }
}
