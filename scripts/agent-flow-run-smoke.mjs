// Steps › Flow's run overlays (docs/sql-server-agent.md › Steps › Flow; mocks rx-flow-lastrun, rx-flow-running) against the fake backend's
// agent-flow-runs Nightly (tests/fixtures/backend.mjs): four steps whose newest run failed after a loop. Last run draws that run with its
// passes and the failed step; the run box picks an older run, and History's Show in Flow comes back to it. Start begins a run that moves a
// step a watched sample: Live run turns on by itself, the current step moves on, and the view goes back to Last run when the run ends,
// now drawing the run that just finished. Screenshots in Dark and Light go to artifacts/; VARIA_SMOKE_RECORD=1 also records the window as
// artifacts/agent-flow-run.png, an animated PNG (scripts/fixtures/recording.mjs).
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chooseExplorerMenuItem } from './fixtures/explorer-tree.mjs'
import { recordPage } from './fixtures/recording.mjs'
import { connectDialogWindow, documentFrame, documentState, documentTab, gridPart, liveGrid, statusBar, submitConnect, toolbarButton } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'agent-flow-run-profile-'))
const control = await mkdtemp(resolve('artifacts', 'agent-flow-run-backend-'))
await writeFile(resolve(control, 'agent-node'), '')
await writeFile(resolve(control, 'agent-flow-runs'), '')
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error('Flow run overlays suite exceeded its time limit.'); app.process()?.kill(); process.exitCode = 1 }, 150000)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const failures = []
let recording
let step = 'start'
page.on('pageerror', error => failures.push(error.message))

const job = documentFrame(page, 'Nightly')
const tree = job.getByRole('tree', { name: 'Steps flow, in step order', exact: true })
const item = n => tree.getByRole('treeitem').nth(n - 1)
const show = job.getByRole('radiogroup', { name: 'Show', exact: true })
const passes = job.getByRole('table', { name: 'Steps of the run, in the order they ran', exact: true })
const runBox = job.getByRole('combobox', { name: 'Run to draw', exact: true })
// The Steps section scrolled to its top, so the toolbar's Show switch and the graph are both in the picture.
const shot = async name => {
  await job.getByRole('group', { name: 'Steps', exact: true }).evaluate(section => {
    // Only the document's own scroller moves: scrollIntoView would also shift the window's overflow-hidden shell.
    let scroller = section.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
    if (scroller) scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  })
  await page.screenshot({ path: `artifacts/agent-flow-${name}.png` })
}
const theme = mode => page.evaluate(value => window.varia.setThemePreference({ mode: value }), mode)

try {
  await expect(statusBar(page)).toContainText(/Ready/, { timeout: 30000 })
  await toolbarButton(page, 'Connect').click()
  const { window, dialog } = await connectDialogWindow(app)
  await dialog.getByLabel('Server Name', { exact: true }).fill('server-a')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await submitConnect(window, dialog, { timeout: 30000 })
  await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Job Activity Monitor')
  await liveGrid(page, 'Jobs').locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: /^Nightly$/ }) }).locator(gridPart.cell).nth(2).dblclick()
  await expect(documentTab(page, 'Job Properties - Nightly')).toHaveAttribute('aria-selected', 'true')
  await job.getByRole('radiogroup', { name: 'Steps view', exact: true }).getByRole('radio', { name: 'Flow' }).click()
  await expect(tree.getByRole('treeitem')).toHaveCount(4)

  step = 'last run'
  recording = recordPage(page)
  // Targets only by default; Live run waits for a running job. Last run reads History (its section closed) and draws the newest run:
  // step 1 retried once and ran twice, step 2 failed back to step 1, step 3 failed to step 4, which quit reporting failure.
  await expect(show.getByRole('radio', { name: 'Targets only' })).toHaveAttribute('aria-checked', 'true')
  await expect(show.getByRole('radio', { name: 'Live run' })).toBeDisabled()
  await show.getByRole('radio', { name: 'Last run' }).click()
  await expect(passes.getByRole('row')).toHaveCount(7)
  await expect(job.getByText('Failed at step 3 (Update statistics)')).toBeVisible()
  await expect(item(1)).toHaveAccessibleName(/This run: 1 retry, ×2, ✓ 00:00:15, ✓ 00:00:12\.$/)
  await expect(item(2)).toHaveAccessibleName(/This run: ×2, ✗ 00:00:20, ✓ 00:00:33\.$/)
  await expect(item(4)).toHaveAccessibleName(/This run: ✓ 00:00:01\.$/)
  // A pass's step opens its message below the table.
  await passes.getByRole('button', { name: '3 · Update statistics' }).click()
  await expect(job.getByRole('group', { name: 'Steps', exact: true }).getByRole('region', { name: 'Step 3 message', exact: true })).toContainText('Lock request time out period exceeded.')
  await shot('lastrun-dark')
  await theme('light')
  await shot('lastrun-light')
  await theme('dark')

  step = 'run box'
  // The run box picks the older run, which never reached step 4: it fades and says Not run.
  await runBox.selectOption({ label: await runBox.locator('option', { hasText: 'Succeeded' }).first().textContent() })
  await expect(passes.getByRole('row')).toHaveCount(4)
  await expect(item(4)).toHaveAccessibleName(/This run: Not run\.$/)

  step = 'show in flow'
  // Open in History goes to the same run there; History's Show in Flow brings the newest run back to Last run.
  await job.getByRole('button', { name: 'Open in History', exact: true }).click()
  const history = job.getByRole('group', { name: 'History', exact: true })
  await history.getByRole('list', { name: 'Runs', exact: true }).getByRole('button', { name: /Failed/ }).click()
  await history.getByRole('button', { name: 'Show in Flow', exact: true }).click()
  await expect(show.getByRole('radio', { name: 'Last run' })).toHaveAttribute('aria-checked', 'true')
  await expect(passes.getByRole('row')).toHaveCount(7)

  step = 'live run'
  // Start: Live run turns on by itself, rings the current step with its time and usual time, and follows Agent from step to step.
  await job.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(show.getByRole('radio', { name: 'Live run' })).toHaveAttribute('aria-checked', 'true', { timeout: 30000 })
  await expect(item(1)).toHaveAccessibleName(/This run: ▶ /)
  await expect(job.getByRole('region', { name: 'Current step' })).toContainText('Check integrity')
  await expect(item(3)).toHaveAccessibleName(/This run: Waiting\.$/)
  await expect(item(4)).toHaveAccessibleName(/This run: On failure only\.$/)
  // Step 2 fails back to step 1, then step 2 runs again: its earlier pass stays drawn beside the current one.
  await expect(item(2)).toHaveAccessibleName(/This run: ▶ 00:00:04, usual 00:00:30\.$/, { timeout: 30000 })
  await shot('live-dark')
  await expect(item(2)).toHaveAccessibleName(/This run: ✗ 00:00:09, ▶ 00:00:04, usual 00:00:30\.$/, { timeout: 30000 })
  await expect(item(1)).toHaveAccessibleName(/This run: ×2, ✓ 00:00:13, ✓ 00:00:12\.$/)
  await theme('light')
  await shot('live-light')
  await theme('dark')

  step = 'run ends'
  // The run ends: the view goes back to Last run, which now draws the run that just finished (step 3 quit reporting success).
  await expect(show.getByRole('radio', { name: 'Last run' })).toHaveAttribute('aria-checked', 'true', { timeout: 45000 })
  await expect(show.getByRole('radio', { name: 'Live run' })).toBeDisabled()
  await expect(documentState(job)).toContainText('Last run succeeded', { timeout: 30000 })
  await expect(passes.getByRole('row')).toHaveCount(6, { timeout: 30000 })
  await expect(item(3)).toHaveAccessibleName(/This run: ✓ 00:00:06\.$/)
  await expect(item(4)).toHaveAccessibleName(/This run: Not run\.$/)
  await shot('lastrun-after-dark')
  console.log('Flow run overlays passed: Last run draws a run\'s passes, the run box and Show in Flow pick runs, and Live run follows a run to its end.')
} catch (error) {
  failures.push(`${step}: ${error.message}`)
  await page.screenshot({ path: 'artifacts/agent-flow-run-failure.png' }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  const recorded = await recording?.stop(resolve('artifacts', 'agent-flow-run.png')).catch(error => { failures.push(`recording: ${error.message}`) })
  if (recorded) console.log(`Recording: ${recorded}`)
  await app.close().catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
}
