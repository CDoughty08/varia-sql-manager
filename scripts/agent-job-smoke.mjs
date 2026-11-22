// SQL Server Agent's job document (AG-6a) against the fake backend's jobs (tests/fixtures/backend.mjs, VARIA_TEST_BACKEND=workbench;
// the smoke runs open the release gate): double-click and Enter in Job Activity Monitor open one tab per job with its live state, an
// edit counts on Save, Save sends one agentJob action carrying the version it read, a save that loses the race (the job-save-race
// control file) opens the field-by-field compare whose Reload and keep my changes saves on the next try, Start once at step sends the
// chosen step, and New Job from the palette copies an existing job and creates it. Alerts and operators (AG-7): the new job's New alert for
// this job creates an alert that runs it and notifies an operator, and the palette's Operators and Notifications grid saves a changed cell
// as one agentAlert action and sends a test e-mail through the fake backend (nothing is sent). Screenshots in Dark and Light go to artifacts/.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chooseExplorerMenuItem } from './fixtures/explorer-tree.mjs'
import { documentFrame, documentState, documentTab, documentVerb, gridPart, liveGrid, quickInputRows, statusBar, toolbarButton } from './fixtures/ui.mjs'
import { parseCalls } from './fixtures/call-log.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'agent-job-profile-'))
const control = await mkdtemp(resolve('artifacts', 'agent-job-backend-'))
// The fake backend lists the SQL Server Agent node only for the Agent suites.
await writeFile(resolve(control, 'agent-node'), '')
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error('Job document suite exceeded its time limit.'); app.process()?.kill(); process.exitCode = 1 }, 180000)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const failures = []
let step = 'start'
page.on('pageerror', error => failures.push(error.message))

const jobCell = name => liveGrid(page, 'Jobs').locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: new RegExp(`^${name}$`) }) }).locator(gridPart.cell).nth(2)
const job = name => documentFrame(page, name)
const verb = (name, label) => documentVerb(job(name), name, label)
const calls = async method => parseCalls(await readFile(resolve(control, 'calls.jsonl'), 'utf8').catch(() => '')).filter(call => call.method === method).map(call => call.params)
const saves = async () => (await calls('actions.execute')).filter(call => call.action === 'agentJob')
async function connect(server) {
  await toolbarButton(page, 'Connect').click()
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(dialog.getByText('Loading saved connections…')).toHaveCount(0)
  await dialog.getByLabel('Server Name', { exact: true }).fill(server)
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30000 })
}

try {
  await expect(statusBar(page)).toContainText(/Ready/, { timeout: 30000 })
  await connect('server-a')
  await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Job Activity Monitor')
  await expect(jobCell('Nightly')).toBeVisible()

  step = 'open'
  // Double-click opens the job's document; the header follows the job through agent.jobs' watched probe.
  await jobCell('Nightly').dblclick()
  await expect(documentTab(page, 'Job Properties - Nightly')).toHaveAttribute('aria-selected', 'true')
  await expect(job('Nightly').getByLabel('Description', { exact: true })).toHaveValue('Nightly maintenance.')
  await expect(documentState(job('Nightly'))).toContainText('Idle · Last run failed')
  expect((await calls('live.subscribe')).some(call => call.source === 'agent.jobs' && call.args?.watch?.length === 1 && call.probes.some(probe => probe.probe === 'agent.jobs.watched'))).toBe(true)
  await expect(job('Nightly').getByRole('table', { name: 'Alerts that run this job', exact: true })).toContainText('Nightly failed')
  // Enter on another selected job opens a second tab; the first stays open.
  await documentTab(page, 'Job Activity Monitor - server-a').click()
  await jobCell('Backup').click()
  // At once: Open Job reads the selection the click just made, not the one before it.
  await page.keyboard.press('Enter')
  await expect(documentTab(page, 'Job Properties - Backup')).toHaveAttribute('aria-selected', 'true')
  await expect(documentTab(page, 'Job Properties - Nightly')).toHaveCount(1)
  await page.getByRole('button', { name: 'Close Job Properties - Backup', exact: true }).click()
  await documentTab(page, 'Job Properties - Nightly').click()
  await page.screenshot({ path: 'artifacts/agent-job-dark.png' })
  console.log('Open passed: double-click and Enter in Job Activity Monitor open one tab per job with its live state and alerts.')

  step = 'save'
  // An edit counts on Save; Save sends only what changed with the version it read, then reads the job again.
  await job('Nightly').getByLabel('Description', { exact: true }).fill('Nightly integrity and index care.')
  await expect(verb('Nightly', 'Save · 1 change')).toBeEnabled()
  await job('Nightly').getByRole('button', { name: 'Remove Nightly failed', exact: true }).click()
  await verb('Nightly', 'Save · 2 changes').click()
  await expect(job('Nightly').getByRole('status').filter({ hasText: 'The job was saved.' })).toBeVisible()
  expect((await saves()).at(-1)).toMatchObject({ target: { kind: 'agentJob', name: 'Nightly' }, agentIdentity: { jobId: 'A1B2C3D4-0000-4000-8000-000000000001' },
    agentJob: { version: 3, modified: '2026-11-10T09:15:30.120', description: 'Nightly integrity and index care.', removeAlerts: [{ id: 7, name: 'Nightly failed' }] } })
  await expect(verb('Nightly', 'Save')).toBeVisible()
  await expect(job('Nightly').getByText('No alert runs this job.', { exact: true })).toBeVisible()
  console.log('Save passed: Save sends the changes with the version it read and the document reads the saved job.')

  step = 'stale'
  // Someone else saves first: Save is refused, the compare lists the field both changed, and Reload and keep my changes saves next time.
  await job('Nightly').getByLabel('Description', { exact: true }).fill('Mine.')
  await writeFile(resolve(control, 'job-save-race'), '')
  await verb('Nightly', 'Save · 1 change').click()
  const compare = job('Nightly').getByRole('table', { name: 'What changed since you opened the job', exact: true })
  await expect(compare).toContainText('changed by both')
  await expect(compare).toContainText('Changed by someone else.')
  await page.screenshot({ path: 'artifacts/job-save-race.png' })
  await job('Nightly').getByRole('button', { name: 'Reload and keep my changes', exact: true }).click()
  await expect(compare).toHaveCount(0)
  await expect(job('Nightly').getByLabel('Description', { exact: true })).toHaveValue('Mine.')
  await verb('Nightly', 'Save · 1 change').click()
  await expect(job('Nightly').getByRole('status').filter({ hasText: 'The job was saved.' })).toBeVisible()
  const [refused, accepted] = (await saves()).slice(-2)
  expect(accepted.agentJob.version).toBe(refused.agentJob.version + 1)
  console.log('Stale passed: a lost race opens the compare, and Reload and keep my changes saves on the next try.')

  step = 'start at step'
  // Start once at step lists the steps and sends the chosen one; the header shows the run.
  await job('Nightly').getByRole('button', { name: 'Start once at step', exact: true }).click()
  await expect(quickInputRows(page)).toHaveCount(3)
  await quickInputRows(page).filter({ hasText: 'Rebuild indexes' }).click()
  await expect.poll(async () => (await calls('actions.execute')).filter(call => call.action === 'startJob').at(-1)).toMatchObject({ target: { name: 'Nightly' }, stepName: 'Rebuild indexes' })
  await expect(documentState(job('Nightly'))).toContainText('Running', { timeout: 30000 })
  await expect(documentState(job('Nightly'))).toContainText('Idle · Last run succeeded', { timeout: 45000 })
  console.log('Start at step passed: the step menu sends the chosen step and the header follows the run.')

  step = 'new job'
  // New Job from the palette: Copy an existing job fills General and Notifications; Create adds the job.
  await page.keyboard.press('F1')
  await expect(page.getByRole('combobox', { name: 'Command Palette', exact: true })).toBeFocused()
  await page.keyboard.type('New Job')
  await quickInputRows(page).filter({ hasText: 'New Job…' }).first().click()
  await expect(documentTab(page, 'New Job')).toHaveAttribute('aria-selected', 'true')
  const panel = documentFrame(page, 'New Job').getByRole('group', { name: 'New Job', exact: true })
  await panel.getByRole('button', { name: /Copy an existing job/ }).click()
  await quickInputRows(page).filter({ hasText: 'Backup' }).click()
  const draft = documentFrame(page, 'Copy of Backup')
  await expect(draft.getByLabel('Description', { exact: true })).toHaveValue('Backup maintenance.')
  await draft.getByLabel('Name', { exact: true }).fill('Backup weekly')
  await documentVerb(documentFrame(page, 'Backup weekly'), 'Backup weekly', 'Create').click()
  await expect(documentTab(page, 'Job Properties - Backup weekly')).toHaveAttribute('aria-selected', 'true')
  await expect(documentFrame(page, 'Backup weekly').getByRole('status').filter({ hasText: 'The job was created.' })).toBeVisible()
  expect((await saves()).at(-1)).toMatchObject({ target: { kind: 'agent' }, agentJob: { name: 'Backup weekly', description: 'Backup maintenance.', emailLevel: 2, emailOperator: 'DBA Team' } })
  expect((await saves()).at(-1).agentJob.version).toBeUndefined()

  console.log('New Job passed: the palette opens New Job, Copy an existing job fills it, and Create adds the job.')

  step = 'new alert'
  // The job document's Alerts section opens New Alert with the job as its response; Create sends one agentAlert action on the Agent node.
  await documentFrame(page, 'Backup weekly').getByRole('button', { name: 'New alert for this job…', exact: true }).click()
  await expect(documentTab(page, 'New Alert')).toHaveAttribute('aria-selected', 'true')
  await documentFrame(page, 'New Alert').getByLabel('Name', { exact: true }).fill('Backup weekly late')
  const alert = documentFrame(page, 'Backup weekly late')
  await alert.getByLabel('Add an operator', { exact: true }).selectOption('DBA Team')
  await expect(alert.getByRole('listitem').filter({ hasText: 'DBA Team' })).toBeVisible()
  await documentVerb(alert, 'Backup weekly late', 'Create').click()
  await expect(documentTab(page, 'Alert Properties - Backup weekly late')).toHaveAttribute('aria-selected', 'true')
  await expect(alert.getByRole('status').filter({ hasText: 'The alert was created.' })).toBeVisible()
  const created = (await calls('actions.execute')).filter(call => call.action === 'agentAlert').at(-1)
  expect(created).toMatchObject({ target: { kind: 'agent' }, agentAlert: { name: 'Backup weekly late', severity: 17, notifications: [{ name: 'DBA Team', methods: 1, change: 'add' }] } })
  expect(created.agentAlert.jobId).toBeTruthy()
  expect(created.agentObjectId).toBeUndefined()
  await page.screenshot({ path: 'artifacts/agent-alert-dark.png' })
  console.log('New alert passed: the job document opens New Alert for the job, and Create adds it with its operator.')

  step = 'operators grid'
  // The palette opens the grid; a cell click cycles its methods, Save sends that alert's change with its id, and Send test e-mail runs at once.
  await page.keyboard.press('F1')
  await expect(page.getByRole('combobox', { name: 'Command Palette', exact: true })).toBeFocused()
  await page.keyboard.type('Operators and Notifications')
  await quickInputRows(page).filter({ hasText: 'Operators and Notifications…' }).first().click()
  await expect(documentTab(page, 'Operators and Notifications')).toHaveAttribute('aria-selected', 'true')
  const grid = documentFrame(page, 'Operators and notifications')
  await grid.getByRole('button', { name: 'Severity 017, On Call: not notified', exact: true }).click()
  await expect(grid.getByRole('button', { name: 'Severity 017, On Call: E-mail', exact: true })).toBeVisible()
  await documentVerb(grid, 'Operators and notifications', 'Save · 1 change').click()
  await expect(grid.getByRole('status').filter({ hasText: 'The notifications were saved.' })).toBeVisible()
  expect((await calls('actions.execute')).filter(call => call.action === 'agentAlert').at(-1)).toMatchObject({ target: { kind: 'agentAlert', name: 'Severity 017' }, agentObjectId: 21,
    agentAlert: { notifications: [{ name: 'On Call', methods: 1, change: 'add' }] } })
  await grid.getByRole('button', { name: 'DBA Team', exact: true }).click()
  await grid.getByRole('button', { name: 'Send test e-mail', exact: true }).click()
  await expect(grid.getByRole('status').filter({ hasText: 'Test e-mail queued for DBA Team.' })).toBeVisible()
  expect((await calls('actions.execute')).filter(call => call.action === 'notifyOperator').at(-1)).toMatchObject({ target: { kind: 'agentOperator', name: 'DBA Team' }, agentObjectId: 1 })
  await page.screenshot({ path: 'artifacts/agent-operators-dark.png' })
  console.log('Operators grid passed: a changed cell saves as its alert\'s change, and Send test e-mail names the operator by id.')

  step = 'light'
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'light' }))
  await page.screenshot({ path: 'artifacts/agent-job-light.png' })
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'dark' }))

  if (failures.length) throw new Error('Page errors: ' + failures.join(' | '))
  console.log('Job document suite passed.')
} catch (error) {
  console.error(`Job document suite failed at "${step}":`, error)
  await page.screenshot({ path: 'artifacts/agent-job-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await app.close().catch(() => app.process()?.kill())
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
