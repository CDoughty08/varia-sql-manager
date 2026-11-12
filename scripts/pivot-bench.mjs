import { _electron as electron, expect } from '@playwright/test'
import { cpus, totalmem } from 'node:os'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { connectLive } from './fixtures/live-rows.mjs'
import { sizeResultStack } from './fixtures/results-pane.mjs'
import { within } from './fixtures/smoke.mjs'
import { backendReady, outputStatus, part, pivotPanel, resultsToolbar } from './fixtures/ui.mjs'

// End-to-end Pivot timings (hand-run: node scripts/pivot-bench.mjs [--rows N] [--runs N]; not part of check or CI): the built
// app and the Release backend against VARIA_TEST_SQL_SERVER. Each case runs a query of synthetic rows (numbers from a cross
// join of catalog views; no user data), opens the Pivot panel, groups by one column and times Build Pivot from the click to
// the answer (the panel stops being busy), to the pivot's grid being in the document and to its first cell being painted,
// with the renderer's long tasks, longest frame gap and main-thread task time over that span. docs/pivot-performance-findings.md
// holds the numbers it produced. Writes artifacts/bench/pivot-e2e.json. Needs out/ and the Release backend (npm run build:smoke).
if (!process.env.VARIA_TEST_SQL_SERVER) throw new Error('pivot-bench needs VARIA_TEST_SQL_SERVER (and VARIA_TEST_SQL_USER and VARIA_TEST_SQL_PASSWORD for SQL authentication).')
const option = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : Number(process.argv[at + 1]) }
const reported = option('--rows', 20463), runs = option('--runs', 7)
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined
const output = resolve(`artifacts/bench/pivot-e2e${only ? '-' + only : ''}.json`)
await mkdir(resolve('artifacts/bench'), { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'pivot-bench-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
const cases = []
let app, page, client, sized
let step = 'launch'
const watchdog = setTimeout(async () => {
  console.error(`Pivot benchmarks timed out during: ${step}.`)
  await within(page?.screenshot({ path: resolve('artifacts', 'pivot-bench-timeout.png') }) ?? Promise.resolve(), 5000, () => {})
  app?.process()?.kill()
  process.exit(1)
}, option('--timeout', 1200) * 1000)

const numbers = 'FROM (SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b CROSS JOIN (SELECT TOP (8) 1 AS x FROM sys.all_objects) AS c) AS numbers'
/** One int column of repeated values with NULLs (every seventh row), `groups` distinct values. */
const narrow = (top, groups) => `SELECT TOP (${top}) CASE WHEN n % 7 = 0 THEN NULL ELSE CAST(n % ${groups} AS int) END AS status ${numbers};`
/** Eight columns as scripts/fixtures/live-rows.mjs's, with a status column in front. */
const wide = (top, groups) => `SELECT TOP (${top}) CASE WHEN n % 7 = 0 THEN NULL ELSE CAST(n % ${groups} AS int) END AS status, n AS id, CONCAT(N'Customer ', n) AS name,
  DATEADD(SECOND, n, CAST('2026-01-01' AS datetime2(7))) AS created, CAST(n % 100000 / 100.0 AS decimal(18,2)) AS amount,
  CONCAT(N'Note ', n, N': Lorem ipsum dolor sit amet, consectetur adipiscing elit') AS note, CONCAT(N'Region ', n % 12) AS region ${numbers};`

const textbox = () => page.locator('.monaco-editor [role="textbox"]')
// Grids in stack order: a pivot is appended, so the one a build adds is the last.
const grid = index => page.locator('[data-result-grid]').nth(index)
const show = name => resultsToolbar(page).getByRole('group', { name: 'Show', exact: true }).getByRole('button', { name, exact: true })
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.max(0, Math.ceil(p / 100 * values.length) - 1))]
const taskSeconds = async () => (await client.send('Performance.getMetrics')).metrics.find(item => item.name === 'TaskDuration').value

async function run(sql, timeout = 300000) {
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(sql)
  const started = Date.now()
  await page.keyboard.press('F5')
  await expect(outputStatus(page)).toContainText(/^Completed · /, { timeout })
  return Date.now() - started
}

/** Arms the page's watcher for one Build Pivot: the pivot will be grid `index`. Resolves with the span's marks. */
const arm = index => page.evaluate(({ index, stackPart }) => {
  const marks = { longTasks: [], frames: [] }
  const panel = document.querySelector('aside[aria-label="Pivot"]')
  const tasks = new PerformanceObserver(list => { for (const entry of list.getEntries()) marks.longTasks.push(Math.round(entry.duration)) })
  tasks.observe({ entryTypes: ['longtask'] })
  let last
  window.__pivotBench = new Promise(done => {
    const check = () => {
      const now = performance.now()
      if (marks.clicked === undefined) return
      if (marks.answered === undefined && marks.busy && !panel.hasAttribute('aria-busy')) marks.answered = now - marks.clicked
      if (panel.hasAttribute('aria-busy')) marks.busy = true
      const root = document.querySelectorAll('[data-result-grid]')[index]
      if (root && marks.mounted === undefined) {
        marks.mounted = now - marks.clicked
        // A pivot is appended to the stack, so it can arrive below the fold, where it draws nothing: bring it into view.
        const box = root.getBoundingClientRect(), stack = root.closest(stackPart)?.getBoundingClientRect()
        marks.revealed = !!stack && box.top >= stack.bottom - 40
        if (marks.revealed) root.scrollIntoView({ block: 'end' })
      }
      // A body cell with text: the pivot's rows have been read, decoded and drawn (pooled cells not in use are empty).
      if (root && marks.drawn === undefined) for (const cell of root.querySelectorAll('[role="gridcell"]')) if (cell.textContent !== '') { marks.drawn = now - marks.clicked; break }
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    const frame = now => {
      if (last !== undefined && marks.clicked !== undefined) marks.frames.push(now - last)
      last = now
      check()
      // Two frames after the cell was drawn, so the paint that showed it is counted.
      // A pivot added below the stack's fold draws no cells until it is scrolled to: give up on it 3 s after its grid came.
      const hidden = marks.drawn === undefined && marks.mounted !== undefined && now - marks.clicked - marks.mounted > 3000
      if (hidden || (marks.drawn !== undefined && (marks.after = (marks.after ?? 0) + 1) > 2)) {
        observer.disconnect()
        tasks.disconnect()
        marks.painted = hidden ? marks.mounted : now - marks.clicked
        marks.drawn ??= marks.mounted
        marks.hidden = hidden
        return done(marks)
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    panel.addEventListener('click', event => { if (event.target.closest('button')?.textContent === 'Build Pivot') marks.clicked = performance.now() }, { capture: true, once: false })
  })
}, { index, stackPart: part.resultStack })

/** Builds the panel's pivot `count` times (each appends a grid) and returns each build's marks. */
async function builds(first, count) {
  const samples = []
  for (let i = 0; i < count; i++) {
    await arm(first + i)
    const before = await taskSeconds()
    await pivotPanel(page).getByRole('button', { name: 'Build Pivot', exact: true }).click()
    const marks = await page.evaluate(() => window.__pivotBench)
    marks.taskMs = (await taskSeconds() - before) * 1000
    samples.push(marks)
  }
  return samples
}

function summarise(name, detail, samples) {
  const of = key => samples.map(sample => sample[key])
  const line = key => `${Math.round(percentile(of(key), 50))}/${Math.round(Math.max(...of(key)))}`
  const item = {
    name, detail, runs: samples.length, first: samples[0],
    answeredMs: { median: percentile(of('answered'), 50), max: Math.max(...of('answered')) },
    mountedMs: { median: percentile(of('mounted'), 50), max: Math.max(...of('mounted')) },
    drawnMs: { median: percentile(of('drawn'), 50), max: Math.max(...of('drawn')) },
    paintedMs: { median: percentile(of('painted'), 50), max: Math.max(...of('painted')) },
    taskMs: { median: percentile(of('taskMs'), 50), max: Math.max(...of('taskMs')) },
    longestFrameMs: Math.max(...samples.flatMap(sample => sample.frames)),
    longTasks: samples.flatMap(sample => sample.longTasks), hidden: samples.filter(sample => sample.hidden).length, revealed: samples.filter(sample => sample.revealed).length
  }
  cases.push(item)
  console.log(`${name}: answered ${line('answered')} ms, grid mounted ${line('mounted')}, first cell ${line('drawn')}, painted ${line('painted')} (median/max of ${samples.length}); `
    + `first build ${Math.round(samples[0].painted)} ms; task time ${line('taskMs')} ms; longest frame ${Math.round(item.longestFrameMs)} ms; long tasks ${JSON.stringify(item.longTasks)}${item.revealed ? `; ${item.revealed} pivots arrived below the fold and were scrolled to` : ''}${item.hidden ? `; ${item.hidden} drew no cells` : ''} (${detail})`)
}

/** Runs `sql` (its sets are grids 0 to `sets` - 1), sets the panel to group by `group` on the first, and times the builds. */
async function pivotCase(name, sql, sets, group, { before, detail = '', asColumn = false } = {}) {
  if (only && only !== name) return
  step = name + ': query'
  const queryMs = await run(sql)
  step = name + ': panel'
  await expect(grid(sets - 1)).toBeVisible()
  if (!sized) sized = await sizeResultStack(page, 720)
  if (before) await before()
  const panel = pivotPanel(page)
  if (await panel.count() === 0) await show('Pivot').click()
  await expect(panel).toBeVisible()
  // A re-run keeps the draft where the columns still fit: start each case from an empty one.
  for (const remove of await panel.getByRole('button', { name: /^Remove row group / }).all()) await remove.click()
  await panel.getByRole('combobox', { name: 'Column group', exact: true }).selectOption(asColumn ? { label: group } : '')
  if (!asColumn) await panel.getByRole('combobox', { name: 'Add row group', exact: true }).selectOption({ label: group })
  await expect(panel.getByRole('button', { name: 'Build Pivot', exact: true })).toBeEnabled({ timeout: 120000 })
  step = name + ': builds'
  summarise(name, `query ${queryMs} ms${detail ? '; ' + detail : ''}`, await builds(sets, runs))
}

try {
  app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  // A hidden window gets about one animation frame a second; show it without focus.
  const view = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0], area = screen.getPrimaryDisplay().workAreaSize
    window.setContentSize(Math.min(1600, area.width), Math.min(1000, area.height))
    window.showInactive()
    const [width, height] = window.getContentSize()
    return { width, height }
  })
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await backendReady(page).waitFor({ timeout: 60000 })
  client = await page.context().newCDPSession(page)
  await client.send('Performance.enable')
  step = 'connect'
  await connectLive(page, expect)

  // The reported shape: two results of one int column with repeats and NULLs, a Count of rows by that column.
  await pivotCase('reported', narrow(reported, 40) + '\n' + narrow(reported, 40), 2, 'status', { detail: `2 results of ${reported.toLocaleString('en-US')} rows, 40 values and NULL` })
  await pivotCase('single', narrow(reported, 40), 1, 'status', { detail: `1 result of ${reported.toLocaleString('en-US')} rows` })
  await pivotCase('manyGroups', narrow(reported, 20000), 1, 'status', { detail: `${reported.toLocaleString('en-US')} rows, about 17,000 row groups` })
  await pivotCase('wide', wide(reported, 40), 1, 'status', { detail: `${reported.toLocaleString('en-US')} rows of 7 columns` })
  await pivotCase('columnGroup', narrow(reported, 250) + String.fromCharCode(10) + narrow(reported, 250), 2, 'status', { asColumn: true, detail: 'the column as the column group: one row of 252 columns' })
  await pivotCase('profile', narrow(reported, 40) + '\n' + narrow(reported, 40), 2, 'status', {
    detail: 'the reported shape with Column Profile open',
    before: async () => { if (await show('Profile').getAttribute('aria-pressed') !== 'true') await show('Profile').click() }
  })
  if (!only) await show('Profile').click()
  await pivotCase('rowSize', narrow(reported, 40) + '\n' + narrow(reported, 40), 2, 'status', {
    detail: 'the reported shape with Row Size shown',
    before: async () => { if (await show('Row size').getAttribute('aria-pressed') !== 'true') await show('Row size').click() }
  })
  if (!only) await show('Row size').click()
  // A search term in the results toolbar: every result is searched, the new pivot included.
  await pivotCase('search', narrow(reported, 40) + String.fromCharCode(10) + narrow(reported, 40), 2, 'status', {
    detail: 'the reported shape with a results search for "1" active',
    before: async () => {
      await resultsToolbar(page).getByRole('textbox', { name: 'Search results', exact: true }).fill('1')
      await expect(resultsToolbar(page).getByRole('button', { name: 'Next match', exact: true })).toBeEnabled({ timeout: 30000 })
    }
  })
  if (!only) await resultsToolbar(page).getByRole('textbox', { name: 'Search results', exact: true }).fill('')
  if (!only) {
  // Pivots pile up: each build appends one to the run. Do the builds get slower as the stack grows?
  step = 'repeat'
  await run(narrow(reported, 40) + String.fromCharCode(10) + narrow(reported, 40))
  const repeated = await builds(2, 40)
  const middle = list => percentile(list.map(sample => sample.painted), 50)
  summarise('repeat', `40 builds on one run; painted median of the first five ${Math.round(middle(repeated.slice(0, 5)))} ms, of the last five ${Math.round(middle(repeated.slice(-5)))} ms; `
    + `task time ${Math.round(percentile(repeated.slice(0, 5).map(sample => sample.taskMs), 50))} then ${Math.round(percentile(repeated.slice(-5).map(sample => sample.taskMs), 50))} ms`, repeated)
  // The panel itself, with 42 results in the stack: add and remove a row group, each a draft change.
  step = 'panel'
  {
    const panel = pivotPanel(page)
    await page.evaluate(() => {
      const marks = window.__panelBench = { frames: [], longTasks: [], stop: false }
      new PerformanceObserver(list => { for (const entry of list.getEntries()) marks.longTasks.push(Math.round(entry.duration)) }).observe({ entryTypes: ['longtask'] })
      let last
      const frame = now => { if (last !== undefined) marks.frames.push(now - last); last = now; if (!marks.stop) requestAnimationFrame(frame) }
      requestAnimationFrame(frame)
    })
    const before = await taskSeconds(), started = Date.now()
    for (let i = 0; i < 20; i++) {
      await panel.getByRole('button', { name: /^Remove row group / }).click()
      await panel.getByRole('combobox', { name: 'Add row group', exact: true }).selectOption({ label: 'status' })
    }
    const taskMs = (await taskSeconds() - before) * 1000, wallMs = Date.now() - started
    const marks = await page.evaluate(() => { window.__panelBench.stop = true; return window.__panelBench })
    const item = { name: 'panel', detail: '40 draft changes with 42 results in the stack', taskMsPerChange: taskMs / 40, wallMsPerChange: wallMs / 40, longestFrameMs: Math.max(...marks.frames), longTasks: marks.longTasks }
    cases.push(item)
    console.log(`panel: ${item.taskMsPerChange.toFixed(1)} ms of task time a draft change (${item.wallMsPerChange.toFixed(1)} ms wall with the driver); longest frame ${Math.round(item.longestFrameMs)} ms; long tasks ${JSON.stringify(item.longTasks)} (${item.detail})`)
  }
  }
  for (const rows of [200000, 1000000, 5000000]) await pivotCase(`narrow${rows}`, narrow(rows, 40), 1, 'status', { detail: `1 result of ${rows.toLocaleString('en-US')} rows` })

  await writeFile(output, JSON.stringify({
    generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, electron: await app.evaluate(() => process.versions.electron),
    cpus: cpus().length, cpu: cpus()[0]?.model ?? 'unknown', memoryBytes: totalmem(), view, cases
  }, null, 2))
  console.log(`Wrote ${output}`)
} finally {
  clearTimeout(watchdog)
  if (app) {
    const closed = await within(app.close().then(() => true, () => false), 15000, () => false)
    if (!closed) app.process()?.kill('SIGKILL')
  }
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
