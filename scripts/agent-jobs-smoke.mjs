// SQL Server Agent's Job Activity Monitor against the fake backend's jobs (tests/fixtures/backend.mjs, VARIA_TEST_BACKEND=workbench):
// the Agent node's menu opens one live document per connection listing the jobs with
// tiles and tones, the expanded Jobs folder's rows show their state chips (AG-12), list a job created elsewhere without Refresh
// and end their view when collapsed, a view chip and Clear filters narrow and restore the list through live.update, two selected jobs get Start
// as one request each with a result line per job, the status bar follows the newest started job to its outcome, the Last run
// chevron shows the selected job's last run in place, the list's row menu and F5 refresh it (AG-10), Change owner and Attach schedule (AG-3b) send one request per job from their
// forms below the bulk bar (Escape closes one), View history opens the Log File Viewer (AG-5a) with the selected job
// checked, whose sources, outcome filter, selected run, whole message and Delete History work against the fake history, the
// SQL Server Agent error log (AG-5b) shows its rows and a row's message and Recycle asks first (Enter cancels), closing
// ends the view, and Enter on the Job Activity Monitor node opens it again. Screenshots in Dark and Light go to artifacts/.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chooseExplorerMenuItem, expandExplorerPath, explorerMenuItems, revealExplorerRow } from './fixtures/explorer-tree.mjs'
import { chooseJamMoreAction, connectDialogWindow, documentFrame, documentTab, gridPart, gridTones, jamTile, jamToolbar, liveGrid, liveGridSelector, menuItemNames, statusBar, submitConnect, toolbarButton } from './fixtures/ui.mjs'
import { parseCalls } from './fixtures/call-log.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'agent-jobs-profile-'))
const control = await mkdtemp(resolve('artifacts', 'agent-jobs-backend-'))
// The fake backend lists the SQL Server Agent node only for this suite.
await writeFile(resolve(control, 'agent-node'), '')
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error('Job Activity Monitor suite exceeded its time limit.'); app.process()?.kill(); process.exitCode = 1 }, 240000)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const failures = []
let step = 'start'
page.on('pageerror', error => failures.push(error.message))

const tabName = 'Job Activity Monitor - server-a'
const frame = () => documentFrame(page, 'Job Activity Monitor')
const grid = () => liveGrid(page, 'Jobs')
const parts = { grid: liveGridSelector('Jobs'), row: gridPart.row, cell: gridPart.cell, tones: gridTones }
/** The jobs shown, top to bottom: name, status and last run outcome (the grid draws only the columns in view), and tone. */
const rows = () => page.evaluate(({ grid, row, cell, tones }) => {
  const toneOf = element => Object.keys(tones).find(tone => element.matches(tones[tone])) ?? 'none'
  const text = (element, column) => [...element.querySelectorAll(cell)].find(item => item.style.display !== 'none' && item.getAttribute('aria-colindex') === String(column + 2))?.textContent
  return [...document.querySelectorAll(`${grid} ${row}`)].filter(element => element.style.display !== 'none' && element.hasAttribute('aria-rowindex'))
    .map(element => ({ index: Number(element.getAttribute('aria-rowindex')) - 2, name: text(element, 0), status: text(element, 2), outcome: text(element, 4), tone: toneOf(element) }))
    .sort((a, b) => a.index - b.index)
}, parts)
const calls = async method => parseCalls(await readFile(resolve(control, 'calls.jsonl'), 'utf8').catch(() => '')).filter(call => call.method === method).map(call => call.params)
const views = () => page.evaluate(() => window.__variaLive.snapshot().handles.filter(handle => handle.source === 'agent.jobs'))
const tile = name => jamTile(frame(), name)
const bulkBar = () => jamToolbar(frame())
const jobCell = name => grid().locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: new RegExp(`^${name}$`) }) }).locator(gridPart.cell).nth(2)
async function connect(server) {
  await toolbarButton(page, 'Connect').click()
  const { window, dialog } = await connectDialogWindow(app)
  await dialog.getByLabel('Server Name', { exact: true }).fill(server)
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await submitConnect(window, dialog, { timeout: 30000 })
}

try {
  step = 'open'
  await expect(statusBar(page)).toContainText(/Ready/, { timeout: 30000 })
  await connect('server-a')
  // Job Activity Monitor leads the Agent node's menu, after its New submenu (which the Agent lanes' New › Job…, Proxy… and the rest fill).
  expect((await explorerMenuItems(page, 'server-a', 'SQL Server Agent')).names.filter(name => name !== 'New')[0]).toBe('Job Activity Monitor')
  await page.keyboard.press('Escape')
  await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Job Activity Monitor')
  await expect(documentTab(page, tabName)).toHaveAttribute('aria-selected', 'true')
  await expect(frame()).toBeVisible()
  await expect.poll(async () => (await rows()).map(row => `${row.name} ${row.status} ${row.outcome} ${row.tone}`)).toEqual(['Nightly Idle Failed error', 'Backup Idle Succeeded none', 'Purge Idle Succeeded muted'])
  expect((await calls('live.subscribe')).find(call => call.source === 'agent.jobs')).toMatchObject({ source: 'agent.jobs', probes: [{ probe: 'agent.jobs.list' }, { probe: 'agent.jobs.service' }] })
  await expect(tile('Last run failed')).toHaveAttribute('aria-label', /^Last run failed: 1/)
  await expect(tile('Disabled')).toHaveAttribute('aria-label', /^Disabled: 1/)
  await page.screenshot({ path: 'artifacts/agent-jobs-dark.png' })
  console.log('Open passed: the Agent node\'s menu opens Job Activity Monitor with the jobs, their tones and the counts.')

  step = 'overview'
  // The Agent overview (AG-15) from the Agent node's menu: the fake server's service, tiles and checks, and a fix opening the owner
  // of what it fixes (Show them: Job Activity Monitor on its Failed view).
  await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Agent Overview')
  await expect(documentTab(page, 'Agent Overview - server-a')).toHaveAttribute('aria-selected', 'true')
  const overview = documentFrame(page, 'SQL Server Agent')
  await expect(overview.getByRole('status', { name: 'SQL Server Agent: Running', exact: true })).toBeVisible()
  await expect(overview.getByRole('listitem', { name: 'Problem: 1 job failed in the last 24 hours', exact: true })).toBeVisible()
  await expect(overview.getByRole('listitem', { name: 'Warning: 1 job is owned by a disabled login', exact: true })).toBeVisible()
  await expect(overview.getByRole('listitem', { name: 'Warning: 1 job notifies no one when it fails', exact: true })).toBeVisible()
  await expect(overview.getByRole('listitem', { name: 'Warning: Recommended alerts are missing', exact: true })).toBeVisible()
  await expect(overview.getByRole('listitem', { name: 'Note: 1 schedule is unused', exact: true })).toBeVisible()
  await expect(overview.getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible()
  expect((await calls('live.subscribe')).find(call => call.source === 'agent.overview')).toMatchObject({ source: 'agent.overview', probes: [{ probe: 'agent.overview.read' }] })
  await page.screenshot({ path: 'artifacts/agent-overview-dark.png' })
  // The tiles share one height whether or not they have a subline (Running has none here), and a name links inside its check's sentence.
  const tileHeights = await overview.getByRole('group', { name: 'SQL Server Agent at a glance', exact: true }).getByRole('group').evaluateAll(tiles => tiles.map(tile => Math.round(tile.getBoundingClientRect().height)))
  expect(tileHeights).toHaveLength(4)
  expect(new Set(tileHeights).size).toBe(1)
  await expect(overview.getByRole('listitem', { name: 'Warning: 1 job notifies no one when it fails', exact: true }).getByRole('button', { name: 'Backup', exact: true })).toBeVisible()
  await overview.getByRole('listitem', { name: 'Problem: 1 job failed in the last 24 hours', exact: true }).getByRole('button', { name: 'Show them', exact: true }).click()
  await expect(documentTab(page, tabName)).toHaveAttribute('aria-selected', 'true')
  await expect(tile('Last run failed')).toHaveAttribute('aria-pressed', 'true')
  await tile('Last run failed').click()
  await expect(tile('Last run failed')).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Close Agent Overview - server-a', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.__variaLive.snapshot().handles.filter(handle => handle.source === 'agent.overview'))).length).toBe(0)
  console.log("Overview passed: the Agent node's menu opens the Agent overview with its checks, and Show them opens Job Activity Monitor on its failed jobs.")
  step = 'tree'
  // AG-12: the expanded Agent node watches agent.tree; the expanded Jobs folder opens its own agent.jobs view (beside the
  // document's) whose rows give each job's chip, and collapsing the folder ends that view.
  // The folder lists every job enabled (as if Purge was disabled after the listing), so Purge is dimmed by the live read alone.
  await writeFile(resolve(control, 'agent-listed-enabled'), '')
  await expandExplorerPath(page, 'server-a', 'SQL Server Agent', 'Jobs')
  await expect.poll(async () => (await page.evaluate(() => window.__variaLive.snapshot().handles.filter(handle => handle.source === 'agent.tree'))).length).toBe(1)
  await expect.poll(async () => (await views()).length).toBe(2)
  const jobRow = async name => revealExplorerRow(page, 'server-a', 'SQL Server Agent', 'Jobs', name)
  await expect(await jobRow('Nightly')).toHaveAttribute('aria-label', /Last run failed/)
  // The listing arrives after the first sample was taken, so it wins until the next sample (the list's 5 s interval) says otherwise.
  await expect(await jobRow('Purge')).toHaveAttribute('aria-label', /, disabled/, { timeout: 15000 })
  await rm(resolve(control, 'agent-listed-enabled'))
  await expect(await jobRow('Backup')).not.toHaveAttribute('aria-label', /Last run failed|Running|disabled/)
  // A job created elsewhere moves the jobs fingerprint, and the folder lists it without Refresh.
  await writeFile(resolve(control, 'agent-extra-job'), '')
  // The folder lists it after the probe's next sample, so the search repeats until the row is there.
  await expect(async () => { await expect(await jobRow('Archive')).toBeVisible() }).toPass({ timeout: 30000, intervals: [250, 500, 1000] })
  const jobsFolder = await revealExplorerRow(page, 'server-a', 'SQL Server Agent', 'Jobs')
  await jobsFolder.click()
  await page.keyboard.press('ArrowLeft')
  await expect(jobsFolder).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(async () => (await views()).length).toBe(1)
  console.log('Tree passed: the Jobs folder shows each job\'s state chip, lists a job created elsewhere without Refresh, and ends its view when collapsed.')

  step = 'filters'
  // A KPI tile asks the backend for that view; Clear filters shows every job again.
  await tile('Disabled').click()
  await expect(tile('Disabled')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await rows()).map(row => row.name)).toEqual(['Purge'])
  expect((await calls('live.update')).some(update => update.probes?.some(probe => probe.probe === 'agent.jobs.list' && probe.view === 'disabled'))).toBe(true)
  await frame().getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(tile('Disabled')).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await rows()).map(row => row.name)).toEqual(['Nightly', 'Backup', 'Purge'])
  console.log('Filters passed: a KPI tile narrows the list and Clear filters restores it.')

  step = 'start'
  // Two jobs selected: Start sends one request per job and lists each one's result.
  await jobCell('Nightly').click()
  await page.keyboard.press('Shift+ArrowDown')
  await expect(bulkBar()).toContainText('2 jobs selected')
  await bulkBar().getByRole('button', { name: 'Start', exact: true }).click()
  const results = frame().getByRole('log', { name: 'Start Jobs results', exact: true })
  await expect(results.getByRole('listitem')).toHaveCount(2)
  await expect(results.getByRole('listitem').filter({ hasText: 'Start requested' })).toHaveCount(2)
  const starts = (await calls('actions.execute')).filter(call => call.action === 'startJob')
  expect(starts.map(call => ({ name: call.target.name, kind: call.target.kind, jobId: call.agentIdentity.jobId }))).toEqual([
    { name: 'Nightly', kind: 'agentJob', jobId: 'a1b2c3d4-0000-4000-8000-000000000001' }, { name: 'Backup', kind: 'agentJob', jobId: 'a1b2c3d4-0000-4000-8000-000000000002' }
  ])
  // The status bar follows the newest started job (one more behind it) until it ends; the list shows both running meanwhile or after.
  const item = statusBar(page).getByRole('status').filter({ has: page.getByRole('button', { name: 'Dismiss Backup', exact: true }) })
  await expect(item).toBeVisible()
  await expect(item).toContainText('+1')
  await page.screenshot({ path: 'artifacts/agent-jobs-started.png' })
  await expect(item).toContainText('Backup: Succeeded', { timeout: 45000 })
  expect((await calls('live.subscribe')).some(call => call.source === 'agent.jobs' && call.args?.watch?.length === 2 && call.probes.some(probe => probe.probe === 'agent.jobs.watched'))).toBe(true)
  await expect.poll(async () => (await rows()).find(row => row.name === 'Nightly')?.outcome, { timeout: 30000 }).toBe('Succeeded')
  await item.getByRole('button', { name: 'Dismiss Backup', exact: true }).click()
  await expect(statusBar(page).getByRole('button', { name: 'Dismiss Backup', exact: true })).toHaveCount(0)
  await frame().getByRole('region', { name: 'Start Jobs', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(results).toHaveCount(0)
  console.log('Start passed: Start sends one request per selected job, lists each result, and the status bar follows the job to its outcome.')

  step = 'last run'
  // One job selected: the Last run toggle shows its last run in a split drawer with inline message preview and shortcuts.
  await jobCell('Purge').click()
  await expect(bulkBar()).toContainText('1 job selected')
  await bulkBar().getByRole('button', { name: 'Last run', exact: true }).click()
  await expect(bulkBar().getByRole('button', { name: 'Last run', exact: true })).toHaveAttribute('aria-expanded', 'true')
  const lastRun = frame().getByRole('region', { name: 'Last run of Purge', exact: true })
  await expect(lastRun).toBeVisible()
  await expect(liveGrid(page, 'Last run of Purge')).toContainText('(Job outcome)')
  await expect(lastRun.getByRole('separator', { name: 'Resize last run message', exact: true })).toBeVisible()
  const preview = lastRun.getByRole('region', { name: 'Step message preview', exact: true })
  await expect(preview).toContainText('Executed as user: sa.')
  await expect(preview.getByRole('button', { name: 'Copy', exact: true })).toBeEnabled()
  await expect(lastRun.getByRole('button', { name: 'Open Job', exact: true })).toBeEnabled()
  await expect(lastRun.getByRole('button', { name: 'Log File Viewer', exact: true })).toBeEnabled()
  expect((await calls('live.update')).filter(update => update.args).at(-1)?.args).toEqual({ expand: 'a1b2c3d4-0000-4000-8000-000000000003' })
  await lastRun.getByRole('button', { name: 'Hide the last run', exact: true }).click()
  await expect(lastRun).toHaveCount(0)
  console.log('Last run passed: the split drawer shows the selected job\'s last run and message preview and hides it again.')

  step = 'row menu'
  // AG-10: a right-click on a job opens the list's own menu (agent.jobs.context through MenuService), not Query Output's; its Refresh,
  // like F5 in the list, reads the list again through live.update.
  await jobCell('Purge').click({ button: 'right' })
  const rowMenu = page.getByRole('menu', { name: 'Job Activity Monitor', exact: true })
  await expect(rowMenu).toBeVisible()
  const names = await menuItemNames(rowMenu)
  for (const name of ['Open', 'Script Job as CREATE', 'Start Job', 'Stop Job', 'Enable Job', 'Disable Job', 'Refresh']) expect(names.some(item => item.startsWith(name))).toBe(true)
  await expect(page.getByRole('menu', { name: 'Query output', exact: true })).toHaveCount(0)
  const refreshes = async () => (await calls('live.update')).filter(update => update.refresh === true).length
  const before = await refreshes()
  await rowMenu.getByRole('menuitem', { name: /^Refresh/ }).click()
  await expect(rowMenu).toHaveCount(0)
  await expect.poll(refreshes).toBeGreaterThan(before)
  await jobCell('Purge').click()
  const afterMenu = await refreshes()
  await page.keyboard.press('F5')
  await expect.poll(refreshes).toBeGreaterThan(afterMenu)
  // The row menu replaces Query Output's menu, not its keys (outputGridFocus): Alt+Down on Status opens that column's filter.
  await grid().locator(gridPart.cell, { hasText: /^Purge$/ }).click()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Alt+ArrowDown')
  const statusFunnel = page.getByRole('dialog', { name: 'Filter Status', exact: true })
  await expect(statusFunnel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(statusFunnel).toHaveCount(0)
  console.log('Row menu passed: a right-click on a job opens the monitor\'s own menu, whose Refresh and F5 read the list again; Alt+Down still filters a column.')

  step = 'change owner'
  // Two jobs selected: Change owner reads the logins, then sends one changeJobOwner per job with its own result line; Escape closes a form.
  await jobCell('Nightly').click()
  await page.keyboard.press('Shift+ArrowDown')
  await expect(bulkBar()).toContainText('2 jobs selected')
  await chooseJamMoreAction(page, frame(), 'Change owner…')
  const ownerForm = frame().getByRole('region', { name: 'Change the owner of 2 jobs', exact: true })
  await expect(ownerForm).toContainText('Nightly, Backup')
  await expect(ownerForm.getByRole('button', { name: 'Change owner', exact: true })).toBeDisabled()
  await ownerForm.getByLabel('New owner', { exact: true }).press('Escape')
  await expect(ownerForm).toHaveCount(0)
  await chooseJamMoreAction(page, frame(), 'Change owner…')
  await ownerForm.getByLabel('New owner', { exact: true }).fill('ops')
  await ownerForm.getByLabel('New owner', { exact: true }).press('Enter')
  const ownerResults = frame().getByRole('log', { name: 'Change Job Owner results', exact: true })
  await expect(ownerResults.getByRole('listitem').filter({ hasText: 'Owner set to ops' })).toHaveCount(2)
  expect((await calls('actions.execute')).filter(call => call.action === 'changeJobOwner').map(call => ({ name: call.target.name, jobId: call.agentIdentity.jobId, owner: call.jobOwner }))).toEqual([
    { name: 'Nightly', jobId: 'a1b2c3d4-0000-4000-8000-000000000001', owner: 'ops' }, { name: 'Backup', jobId: 'a1b2c3d4-0000-4000-8000-000000000002', owner: 'ops' }
  ])
  await frame().getByRole('region', { name: 'Change Job Owner', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(ownerResults).toHaveCount(0)
  console.log('Change owner passed: the form reads the logins and sends one request per selected job; Escape closes it.')

  step = 'attach schedule'
  // All three jobs: Attach schedule picks a shared schedule (search, then its preview) and attaches it with one guarded save per job;
  // Nightly already uses it, so Backup's and Purge's requests go, each under the same schedule guard (attaching leaves it as it is).
  await jobCell('Nightly').click()
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(bulkBar()).toContainText('3 jobs selected')
  await chooseJamMoreAction(page, frame(), 'Attach schedule…')
  const scheduleForm = frame().getByRole('region', { name: 'Attach a schedule to 3 jobs', exact: true })
  await scheduleForm.getByRole('searchbox', { name: 'Search shared schedules', exact: true }).fill('nightly')
  await scheduleForm.getByRole('list', { name: 'Shared schedules', exact: true }).getByRole('button', { name: /^Nightly 02:30/ }).click()
  await expect(scheduleForm.getByRole('region', { name: 'Shared schedule Nightly 02:30', exact: true })).toContainText('Next 5 runs')
  await page.screenshot({ path: 'artifacts/agent-jobs-attach-schedule.png' })
  await scheduleForm.getByRole('button', { name: 'Attach schedule', exact: true }).click()
  const attachResults = frame().getByRole('log', { name: 'Attach Schedule results', exact: true })
  await expect(attachResults.getByRole('listitem').filter({ hasText: 'Done' })).toHaveCount(3)
  await expect(attachResults.getByRole('listitem').filter({ hasText: 'Already uses this schedule' })).toHaveCount(1)
  await expect(attachResults.getByRole('listitem').filter({ hasText: 'Attached Nightly 02:30' })).toHaveCount(2)
  const attaches = (await calls('actions.execute')).filter(call => call.action === 'agentSchedule')
  expect(attaches.map(call => call.agentSchedule)).toEqual(['2', '3'].map(job => ({ op: 'update', schedule: { id: 1, version: 2, modified: '2026-11-01T02:00:00.000' }, jobs: [{ jobId: `A1B2C3D4-0000-4000-8000-00000000000${job}`, version: 3, attach: true }] })))
  await frame().getByRole('region', { name: 'Attach Schedule', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(attachResults).toHaveCount(0)
  console.log('Attach schedule passed: the picked shared schedule is attached with one guarded save per job, skipping a job already on it.')

  step = 'history'
  // View history opens the Log File Viewer with the selected job checked; All jobs, the outcome filter, a run's rows and its
  // whole message, and Delete History behind its confirmation.
  const nightlyId = 'a1b2c3d4-0000-4000-8000-000000000001'
  const viewer = () => documentFrame(page, 'Log File Viewer')
  const runsSelector = liveGridSelector('Runs')
  const runs = () => page.evaluate(({ grid, row, cell }) => {
    const text = (element, column) => [...element.querySelectorAll(cell)].find(item => item.style.display !== 'none' && item.getAttribute('aria-colindex') === String(column + 2))?.textContent
    return [...document.querySelectorAll(`${grid} ${row}`)].filter(element => element.style.display !== 'none' && element.hasAttribute('aria-rowindex'))
      .map(element => ({ index: Number(element.getAttribute('aria-rowindex')) - 2, text: `${text(element, 1)} ${text(element, 2)}` })).sort((a, b) => a.index - b.index).map(item => item.text)
  }, { grid: runsSelector, row: gridPart.row, cell: gridPart.cell })
  await jobCell('Nightly').click()
  await expect(bulkBar()).toContainText('1 job selected')
  await chooseJamMoreAction(page, frame(), 'View history')
  await expect(documentTab(page, 'Log File Viewer - server-a')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(runs).toEqual(['Nightly Failed', 'Nightly Succeeded'])
  expect((await calls('live.subscribe')).find(call => call.source === 'agent.history')).toMatchObject({ args: { jobs: [nightlyId], days: 7 }, probes: [{ probe: 'agent.history.list' }] })
  const sources = viewer().getByRole('region', { name: 'Select logs', exact: true })
  await expect(sources.getByRole('checkbox', { name: 'Nightly', exact: true })).toBeChecked()
  await sources.getByRole('checkbox', { name: 'All jobs', exact: true }).check()
  await expect.poll(runs).toEqual(['Nightly Failed', 'Backup Succeeded', 'Nightly Succeeded'])
  await viewer().getByRole('toolbar', { name: 'History filters', exact: true }).getByLabel('Outcome', { exact: true }).selectOption('failed')
  await expect.poll(runs).toEqual(['Nightly Failed'])
  await liveGrid(page, 'Runs').locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: /^Nightly$/ }) }).locator(gridPart.cell).nth(1).click()
  await expect(liveGrid(page, 'Run steps')).toContainText('(Job outcome)')
  const details = viewer().getByRole('region', { name: 'Message details', exact: true })
  await expect(details).toContainText('The last step to run was step 2 (Load).')
  expect((await calls('agent.historyMessage')).at(-1)).toMatchObject({ jobId: nightlyId, instanceId: 12 })
  await page.screenshot({ path: 'artifacts/agent-history-dark.png' })
  // Delete History asks first (Cancel takes focus), then purges the checked jobs and says what msdb reported.
  await viewer().getByRole('button', { name: 'Delete History…', exact: true }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Delete History', exact: true })
  await expect(confirm).toContainText('This cannot be undone.')
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await confirm.getByRole('radio', { name: 'All of their history', exact: true }).check()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(viewer().getByRole('status').filter({ hasText: 'Deleted the history of 3 jobs.' })).toBeVisible()
  expect((await calls('actions.execute')).filter(call => call.action === 'deleteJobHistory').at(-1)).toMatchObject({ target: { kind: 'agent' }, agentHistory: { all: true } })
  await expect.poll(runs).toEqual([])
  console.log("History passed: View history opens the Log File Viewer on the selected job; sources, filters, each run's rows and message, and Delete History work.")

  step = 'error logs'
  // Select logs lists the Agent error logs (sysadmin); Current's rows show newest first with a row's whole message, and Recycle
  // asks first: Enter on its focused Cancel recycles nothing, Recycle starts a new Current.
  const errorLogs = sources.getByRole('list', { name: 'SQL Server Agent error logs', exact: true })
  await errorLogs.getByRole('checkbox', { name: 'Current - 2026-11-22 14:31', exact: true }).check()
  const agentLog = liveGrid(page, 'Agent log')
  await expect(agentLog).toContainText('Step 2 of job Nightly failed')
  expect((await calls('live.subscribe')).find(call => call.source === 'agent.errorLog')).toMatchObject({ args: { logs: [0], days: 7 }, probes: [{ probe: 'agent.errorLog.read' }] })
  await agentLog.locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: /^Warning$/ }) }).locator(gridPart.cell).nth(1).click()
  await expect(viewer().getByRole('region', { name: 'Log row details', exact: true })).toContainText('SQLServerAgent is running as a non-sysadmin account')
  await page.screenshot({ path: 'artifacts/agent-error-log-dark.png' })
  const recycleCalls = async () => (await calls('actions.execute')).filter(call => call.action === 'recycleAgentErrorLog')
  await viewer().getByRole('button', { name: 'Recycle…', exact: true }).click()
  const recycle = page.getByRole('alertdialog', { name: 'Recycle SQL Server Agent Error Log', exact: true })
  await expect(recycle).toContainText('the oldest archive is deleted')
  await expect(recycle.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(recycle).toHaveCount(0)
  expect(await recycleCalls()).toEqual([])
  await viewer().getByRole('button', { name: 'Recycle…', exact: true }).click()
  await recycle.getByRole('button', { name: 'Recycle', exact: true }).click()
  await expect(recycle).toHaveCount(0)
  await expect(viewer().getByRole('status').filter({ hasText: 'Started a new SQL Server Agent error log' })).toBeVisible()
  expect((await recycleCalls()).at(-1)).toMatchObject({ target: { kind: 'agent' } })
  await expect(agentLog).toContainText('Errorlog has been reinitialized')
  await expect(errorLogs.getByRole('checkbox', { name: 'Archive #1 - 2026-11-22 14:31', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close Log File Viewer - server-a', exact: true }).click()
  await expect(documentTab(page, tabName)).toHaveAttribute('aria-selected', 'true')
  console.log("Error logs passed: the Agent error log shows its rows and a row's message, and Recycle asks first and starts a new log.")

  step = 'light'
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'light' }))
  await page.screenshot({ path: 'artifacts/agent-jobs-light.png' })
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'dark' }))

  step = 'close'
  // Closing ends the document's view; Enter on the Job Activity Monitor node opens it again.
  await page.getByRole('button', { name: `Close ${tabName}`, exact: true }).click()
  await expect.poll(async () => (await views()).length).toBe(0)
  await expandExplorerPath(page, 'server-a', 'SQL Server Agent')
  const node = await revealExplorerRow(page, 'server-a', 'SQL Server Agent', 'Job Activity Monitor')
  await node.click()
  await page.keyboard.press('Enter')
  await expect(documentTab(page, tabName)).toHaveAttribute('aria-selected', 'true')
  await expect.poll(async () => (await rows()).length).toBe(3)
  console.log('Close passed: closing ends the view, and the Job Activity Monitor node opens it again.')

  if (failures.length) throw new Error('Page errors: ' + failures.join(' | '))
  console.log('Job Activity Monitor suite passed.')
} catch (error) {
  console.error(`Job Activity Monitor suite failed at "${step}":`, error)
  await page.screenshot({ path: 'artifacts/agent-jobs-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await app.close().catch(() => app.process()?.kill())
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
