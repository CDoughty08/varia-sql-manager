// SQL Server Agent's Job Activity Monitor against the fake backend's jobs (tests/fixtures/backend.mjs, VARIA_TEST_BACKEND=workbench;
// the smoke runs open the release gate): the Agent node's menu opens one live document per connection listing the jobs with
// tiles and tones, a view chip and Clear filters narrow and restore the list through live.update, two selected jobs get Start
// as one request each with a result line per job, the status bar follows the newest started job to its outcome, the Last run
// chevron shows the selected job's last run in place, closing ends the view, and Enter on the Job Activity Monitor node opens
// it again. Screenshots in Dark and Light go to artifacts/.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chooseExplorerMenuItem, expandExplorerPath, explorerMenuItems, revealExplorerRow } from './fixtures/explorer-tree.mjs'
import { documentFrame, documentTab, gridPart, gridTones, liveGrid, liveGridSelector, statusBar, toolbarButton } from './fixtures/ui.mjs'
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
const tile = name => frame().getByRole('group', { name: 'Job counts', exact: true }).getByRole('button', { name: new RegExp(`^${name}: `) })
const chip = name => frame().getByRole('group', { name: 'View', exact: true }).getByRole('button', { name: new RegExp(`^${name}(?: [0-9,]+)?$`) })
const bulkBar = () => frame().getByRole('toolbar', { name: 'Selected jobs', exact: true })
const jobCell = name => grid().locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: new RegExp(`^${name}$`) }) }).locator(gridPart.cell).nth(2)
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
  step = 'open'
  await expect(statusBar(page)).toContainText(/Ready/, { timeout: 30000 })
  await connect('server-a')
  // Job Activity Monitor leads the Agent node's menu.
  expect((await explorerMenuItems(page, 'server-a', 'SQL Server Agent')).names[0]).toBe('Job Activity Monitor')
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

  step = 'filters'
  // A view chip asks the backend for that view; Clear filters shows every job again.
  await chip('Disabled').click()
  await expect(chip('Disabled')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await rows()).map(row => row.name)).toEqual(['Purge'])
  expect((await calls('live.update')).some(update => update.probes?.some(probe => probe.probe === 'agent.jobs.list' && probe.view === 'disabled'))).toBe(true)
  await frame().getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(chip('Disabled')).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await rows()).map(row => row.name)).toEqual(['Nightly', 'Backup', 'Purge'])
  console.log('Filters passed: a view chip narrows the list and Clear filters restores it.')

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
  expect(starts.map(call => ({ name: call.target.name, kind: call.target.kind, created: call.agentIdentity.created }))).toEqual([
    { name: 'Nightly', kind: 'agentJob', created: '2026-01-02T03:04:05' }, { name: 'Backup', kind: 'agentJob', created: '2026-01-03T03:04:05' }
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
  // One job selected: the chevron shows its last run below the list, read through args.expand.
  await jobCell('Purge').click()
  await expect(bulkBar()).toContainText('1 job selected')
  await bulkBar().getByRole('button', { name: 'Last run', exact: true }).click()
  await expect(bulkBar().getByRole('button', { name: 'Last run', exact: true })).toHaveAttribute('aria-expanded', 'true')
  const lastRun = frame().getByRole('region', { name: 'Last run of Purge', exact: true })
  await expect(lastRun).toBeVisible()
  await expect(liveGrid(page, 'Last run of Purge')).toContainText('(Job outcome)')
  expect((await calls('live.update')).filter(update => update.args).at(-1)?.args).toEqual({ expand: 'a1b2c3d4-0000-4000-8000-000000000003' })
  await lastRun.getByRole('button', { name: 'Hide the last run', exact: true }).click()
  await expect(lastRun).toHaveCount(0)
  console.log('Last run passed: the chevron shows the selected job\'s last run in place and hides it again.')

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
