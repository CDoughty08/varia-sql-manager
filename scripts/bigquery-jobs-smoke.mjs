// BigQuery Job History end to end (docs/bigquery.md, Job History): the real backend in emulator mode against a loopback REST
// fake standing in for BigQuery's jobs API (VARIA_TEST_BIGQUERY_ENDPOINT; no Google project, no credential, nothing billed).
// Connect opens a BigQuery connection, the server node's menu opens Job History with the jobs newest first and their tones,
// Cancel Job asks, then posts jobs.cancel and the row turns Cancelled, Enter shows a script's details and statements, which
// also show under it in the grid, All users refused by BigQuery turns back to My jobs and says why, and closing ends the view.
import { electron, expect } from './fixtures/smoke.mjs'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chooseExplorerMenuItem } from './fixtures/explorer-tree.mjs'
import { connectDialogWindow, documentFrame, documentTab, gridPart, gridTones, liveGrid, liveGridSelector, statusBar, submitConnect, toolbarButton } from './fixtures/ui.mjs'

const project = 'varia-emulator'
const started = Date.now()
const at = seconds => String(started - seconds * 1000)
/** BigQuery's jobs as the fake holds them: a running Varia query, a finished script with two statements, a failed insert and a
 *  cancelled query (REST shapes, docs/bigquery.md). Cancelling one turns it DONE with reason stopped. */
const jobs = new Map([
  ['varia_running', { state: 'RUNNING', created: 30, statement: 'SELECT', sql: 'SELECT customer, SUM(total) FROM sales.orders GROUP BY customer', labels: { varia_client: 'varia' } }],
  ['script_1', { state: 'DONE', created: 600, statement: 'SCRIPT', sql: 'DECLARE x INT64 DEFAULT 1;\nSELECT x;', children: 2, billed: '10485760' }],
  ['failed_1', { state: 'DONE', created: 900, statement: 'INSERT', sql: 'INSERT INTO sales.missing VALUES (1)', error: { reason: 'notFound', message: 'Not found: Table varia-emulator:sales.missing' } }],
  ['cancelled_1', { state: 'DONE', created: 1200, statement: 'SELECT', sql: 'SELECT * FROM sales.big', error: { reason: 'stopped', message: 'Job execution was cancelled: User requested cancellation' } }]
])
const children = [
  { id: 'script_1_a', created: 598, statement: 'DECLARE', sql: 'DECLARE x INT64 DEFAULT 1' },
  { id: 'script_1_b', created: 597, statement: 'SELECT', sql: 'SELECT x' }
]
const resource = (id, job, parent) => ({
  kind: 'bigquery#job', id: `${project}:US.${id}`, jobReference: { projectId: project, jobId: id, location: 'US' }, state: job.state ?? 'DONE', user_email: 'smoke@example.com',
  statistics: { creationTime: at(job.created), startTime: at(job.created - 1), ...job.state === 'RUNNING' ? {} : { endTime: at(job.created - 5) }, ...parent ? { parentJobId: parent } : {},
    ...job.children ? { numChildJobs: String(job.children) } : {}, query: { statementType: job.statement, ...job.billed ? { totalBytesBilled: job.billed } : {} } },
  configuration: { jobType: 'QUERY', ...job.labels ? { labels: job.labels } : {}, query: { query: job.sql } },
  status: { state: job.state ?? 'DONE', ...job.error ? { errorResult: job.error } : {} }
})
/** jobs.list's minimal projection (and its default) leaves out each job's configuration and statistics.query, as a real
 *  project showed, and parentJobId too, to be safe: only projection=full names a child's statement. */
const listed = (url, job) => {
  if (url.searchParams.get('projection') === 'full') return job
  const minimal = { ...job, statistics: { ...job.statistics } }
  delete minimal.configuration
  delete minimal.statistics.query
  delete minimal.statistics.parentJobId
  return minimal
}
const requests = []
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  requests.push({ method: request.method, path: url.pathname, query: url.searchParams })
  const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
  const denied = message => send(403, { error: { code: 403, message, errors: [{ message, domain: 'global', reason: 'accessDenied' }], status: 'PERMISSION_DENIED' } })
  request.resume()
  const base = `/bigquery/v2/projects/${project}`
  if (request.method === 'GET' && url.pathname === `${base}/jobs`) {
    if (url.searchParams.get('allUsers') === 'true') return denied(`Access Denied: Project ${project}: User does not have bigquery.jobs.list permission in project ${project}.`)
    if (url.searchParams.get('parentJobId') === 'script_1') return send(200, { kind: 'bigquery#jobList', jobs: children.map(child => listed(url, resource(child.id, child, 'script_1'))) })
    return send(200, { kind: 'bigquery#jobList', jobs: [...jobs].map(([id, job]) => listed(url, resource(id, job))) })
  }
  const job = /^\/bigquery\/v2\/projects\/[^/]+\/jobs\/([\w-]+)(\/cancel)?$/.exec(url.pathname)
  if (job && jobs.has(job[1])) {
    const held = jobs.get(job[1])
    if (request.method === 'POST' && job[2]) {
      // BigQuery answers at once with the job as it was, and ends it shortly after: later reads see it cancelled.
      const answer = resource(job[1], held)
      Object.assign(held, { state: 'DONE', error: { reason: 'stopped', message: 'Job execution was cancelled: User requested cancellation' } })
      return send(200, { kind: 'bigquery#jobCancelResponse', job: answer })
    }
    if (request.method === 'GET' && !job[2]) return send(200, resource(job[1], held))
  }
  if (request.method === 'GET' && url.pathname === `${base}/datasets`) return send(200, { kind: 'bigquery#datasetList', datasets: [] })
  send(404, { error: { code: 404, message: 'Not found.', errors: [{ message: 'Not found.', domain: 'global', reason: 'notFound' }], status: 'NOT_FOUND' } })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const endpoint = `http://127.0.0.1:${server.address().port}/`

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'bigquery-jobs-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BIGQUERY_ENDPOINT: endpoint }
delete env.ELECTRON_RUN_AS_NODE
delete env.VARIA_TEST_BACKEND
// The fake has no Storage Read endpoint: a local emulator's must not reach the app.
delete env.VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error('BigQuery Job History suite exceeded its time limit.'); app.process()?.kill(); process.exitCode = 1 }, 180000)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const failures = []
let step = 'start'
page.on('pageerror', error => failures.push(error.message))

const tabName = `Job History - ${project}`
const frame = () => documentFrame(page, 'Job History')
const grid = () => liveGrid(page, 'Jobs')
const parts = { grid: liveGridSelector('Jobs'), row: gridPart.row, cell: gridPart.cell, tones: gridTones }
/** The jobs shown, top to bottom: state and job id (the grid draws only the columns in view), and tone. */
const rows = () => page.evaluate(({ grid, row, cell, tones }) => {
  const toneOf = element => Object.keys(tones).find(tone => element.matches(tones[tone])) ?? 'none'
  const text = (element, column) => [...element.querySelectorAll(cell)].find(item => item.style.display !== 'none' && item.getAttribute('aria-colindex') === String(column + 2))?.textContent
  return [...document.querySelectorAll(`${grid} ${row}`)].filter(element => element.style.display !== 'none' && element.hasAttribute('aria-rowindex'))
    .map(element => ({ index: Number(element.getAttribute('aria-rowindex')) - 2, state: text(element, 0), job: text(element, 1)?.trim(), tone: toneOf(element) }))
    .sort((a, b) => a.index - b.index)
}, parts)
const jobCell = id => grid().locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: new RegExp(`^(?:[▸▾] )?${id}$`) }) }).locator(gridPart.cell).nth(2)
const views = () => page.evaluate(() => window.__variaLive.snapshot().handles.filter(handle => handle.source === 'bigquery.jobs'))
// Job History's listings, not Object Explorer's running-jobs chip (minimal pages of 1,000 filtered to open jobs).
const chipListing = request => request.query.get('projection') === 'minimal' && request.query.get('maxResults') === '1000' && request.query.getAll('stateFilter').length > 0
const listings = () => requests.filter(request => request.method === 'GET' && request.path.endsWith('/jobs') && !chipListing(request))

try {
  step = 'connect'
  await expect(statusBar(page)).toContainText(/Ready/, { timeout: 30000 })
  await toolbarButton(page, 'Connect').click()
  const { window: connectWindow, dialog } = await connectDialogWindow(app)
  await dialog.getByRole('group', { name: 'Server type', exact: true }).getByRole('button', { name: 'BigQuery', exact: true }).click()
  await expect(dialog.getByText(/^Emulator account /)).toBeVisible({ timeout: 20000 })
  await dialog.getByLabel('Project', { exact: true }).fill(project)
  await submitConnect(connectWindow, dialog, { timeout: 30000 })

  step = 'open'
  await chooseExplorerMenuItem(page, [project], 'Job History')
  await expect(documentTab(page, tabName)).toHaveAttribute('aria-selected', 'true')
  await expect(frame()).toBeVisible()
  await expect.poll(async () => (await rows()).map(row => `${row.state} ${row.job} ${row.tone}`), { timeout: 20000 })
    .toEqual(['Running varia_running running', 'Done ▸ script_1 none', 'Failed failed_1 error', 'Cancelled cancelled_1 muted'])
  const first = listings()[0]
  expect(first.query.get('projection')).toBe('full')
  expect(first.query.get('maxResults')).toBe('100')
  expect(first.query.has('allUsers')).toBe(false)
  await expect(frame().getByRole('status').filter({ hasText: '4 jobs · 1 running or pending' })).toBeVisible()
  await page.screenshot({ path: 'artifacts/bigquery-jobs-dark.png' })
  console.log('Open passed: the server node\'s menu opens Job History with the jobs newest first and their tones.')

  step = 'cancel'
  // Cancel Job from the grid's menu asks first; Keep running sends nothing, Cancel Job posts jobs.cancel in the job's location.
  // The menu greys what the selected row's cells rule out, read after the row is selected and weighed as the menu opens (until
  // then every item is offered): open it again until that read has landed.
  const menu = page.getByRole('menu', { name: 'Job History', exact: true })
  await jobCell('varia_running').click()
  await expect(async () => {
    if (await menu.isVisible()) await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await jobCell('varia_running').click({ button: 'right' })
    await expect(menu.getByRole('menuitem', { name: 'Open Results', exact: true })).toBeDisabled({ timeout: 1000 })
  }).toPass({ timeout: 15000 })
  await menu.getByRole('menuitem', { name: 'Cancel Job…', exact: true }).click()
  const question = frame().getByRole('alertdialog', { name: 'Cancel Job', exact: true })
  await expect(question).toContainText(/^Cancel job varia_running .*ago\?/)
  await expect(question.getByRole('button', { name: 'Keep running', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(question).toHaveCount(0)
  expect(requests.filter(request => request.method === 'POST')).toEqual([])
  await frame().getByRole('button', { name: 'Cancel Job', exact: true }).click()
  await question.getByRole('button', { name: 'Cancel Job', exact: true }).click()
  await expect(frame().getByRole('status').filter({ hasText: 'Cancel sent for job varia_running.' })).toBeVisible()
  const cancels = requests.filter(request => request.method === 'POST')
  expect(cancels.map(request => [request.path, request.query.get('location')])).toEqual([[`/bigquery/v2/projects/${project}/jobs/varia_running/cancel`, 'US']])
  await expect.poll(async () => (await rows()).find(row => row.job === 'varia_running')).toMatchObject({ state: 'Cancelled', tone: 'muted' })
  console.log('Cancel passed: Cancel Job asks, posts jobs.cancel once, and the row turns Cancelled.')

  step = 'details'
  // Enter opens the details pane on the selected script: its SQL and statements; Show statements in grid lists them under it.
  await jobCell('script_1').click()
  await page.keyboard.press('Enter')
  const details = frame().getByRole('region', { name: 'Job details', exact: true })
  await expect(details.getByLabel('SQL', { exact: true })).toContainText('DECLARE x INT64 DEFAULT 1;')
  await expect(details).toContainText('Statements (2)')
  await details.getByRole('button', { name: 'Show statements in grid', exact: true }).click()
  await expect.poll(async () => (await rows()).map(row => row.job)).toEqual(['varia_running', '▾ script_1', '↳ script_1_a', '↳ script_1_b', 'failed_1', 'cancelled_1'])
  const childListings = listings().filter(request => request.query.get('parentJobId') === 'script_1')
  expect(childListings.length).toBeGreaterThan(0)
  expect(childListings.map(request => request.query.get('projection'))).toEqual(childListings.map(() => 'full'))
  await details.getByRole('button', { name: 'Close details', exact: true }).click()
  await expect(details).toHaveCount(0)
  console.log('Details passed: Enter shows the script\'s SQL and statements, which then show under it.')

  step = 'all users'
  // BigQuery refuses All users here: the toggle turns back to My jobs and says why.
  await frame().getByRole('radio', { name: 'All users', exact: true }).click()
  await expect(frame().getByRole('status').filter({ hasText: 'BigQuery refused listing every user\'s jobs' })).toBeVisible({ timeout: 20000 })
  await expect(frame().getByRole('radio', { name: 'My jobs', exact: true })).toHaveAttribute('aria-checked', 'true')
  expect(listings().some(request => request.query.get('allUsers') === 'true')).toBe(true)
  // A change of scope folds the scripts again: My jobs lists its four top-level jobs anew.
  await expect.poll(async () => (await rows()).map(row => row.job)).toEqual(['varia_running', '▸ script_1', 'failed_1', 'cancelled_1'])
  console.log('All users passed: a refusal turns back to My jobs and says why.')

  step = 'close'
  await page.getByRole('button', { name: `Close ${tabName}`, exact: true }).click()
  await expect.poll(async () => (await views()).length).toBe(0)
  console.log('Close passed: closing ends the view.')

  if (failures.length) throw new Error('Page errors: ' + failures.join(' | '))
  console.log('BigQuery Job History suite passed.')
} catch (error) {
  console.error(`BigQuery Job History suite failed at "${step}":`, error)
  await page.screenshot({ path: 'artifacts/bigquery-jobs-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await app.close().catch(() => app.process()?.kill())
  server.close()
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
