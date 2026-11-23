// Hot exit for SQL Server Agent documents (AG-6g) against the fake backend's jobs (tests/fixtures/backend.mjs, VARIA_TEST_BACKEND=workbench;
// the smoke runs open the release gate): a job document with an unsaved edit is kept by a quit that asks nothing, a relaunch on the same
// profile reopens it with the edit and the unsaved mark, and once its server reconnects the job is read again with the edit on top, ready
// to save. Native message boxes are stubbed in main and recorded; the profile lives under artifacts/.
import { closeMs, electron, expect, within } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chooseExplorerMenuItem } from './fixtures/explorer-tree.mjs'
import { connectDialogWindow, documentFrame, documentTab, documentVerb, gridPart, liveGrid, statusBar, submitConnect, toolbarButton, unsavedMark } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'agent-hot-exit-profile-'))
const control = await mkdtemp(resolve('artifacts', 'agent-hot-exit-backend-'))
// The fake backend lists the SQL Server Agent node only for the Agent suites.
await writeFile(resolve(control, 'agent-node'), '')
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control, VARIA_TEST_HOT_EXIT: '1' }
delete env.ELECTRON_RUN_AS_NODE
let application, page, step = 'start'
const failures = []
const watchdog = setTimeout(() => { console.error(`Agent hot exit suite exceeded its time limit during ${step}.`); application?.process()?.kill(); process.exit(1) }, 150_000)

async function launch() {
  application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  await application.evaluate(({ dialog }) => {
    const state = globalThis.variaAgentHotExit = { prompts: [] }
    dialog.showMessageBox = async (_window, options) => { state.prompts.push((options ?? _window).message); return { response: (options ?? _window).cancelId ?? 1, checkboxChecked: false } }
  })
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(statusBar(page)).toContainText(/Ready/, { timeout: 30000 })
}
async function quit() {
  const exited = new Promise(done => application.process().once('exit', done))
  await within((async () => {
    await application.evaluate(({ app }) => { setImmediate(() => app.quit()) })
    await exited
  })(), closeMs, () => { throw new Error(`The workbench did not quit within ${closeMs / 1000} s.`) })
}
const job = () => documentFrame(page, 'Nightly')
const description = () => job().getByLabel('Description', { exact: true })

try {
  await launch()
  step = 'open'
  await toolbarButton(page, 'Connect').click()
  const { window, dialog } = await connectDialogWindow(application)
  await dialog.getByLabel('Server Name', { exact: true }).fill('server-a')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await submitConnect(window, dialog, { timeout: 30000 })
  await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Job Activity Monitor')
  const nightly = liveGrid(page, 'Jobs').locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: /^Nightly$/ }) }).locator(gridPart.cell).nth(2)
  await nightly.dblclick()
  await expect(documentTab(page, 'Job Properties - Nightly')).toHaveAttribute('aria-selected', 'true')
  await expect(description()).toHaveValue('Nightly maintenance.')
  await description().fill('Kept across a restart.')
  await expect(unsavedMark(documentTab(page, 'Job Properties - Nightly'))).toBeVisible()

  step = 'quit'
  // A quit keeps the edited job instead of asking to save it: a prompt would be answered Cancel, and the app would not exit.
  await quit()
  const kept = JSON.parse(await readFile(join(profile, 'WorkbenchSession', 'session.json'), 'utf8'))
  const entry = kept.documents.find(document => document.kind === 'agentJob')
  expect(entry).toMatchObject({ name: 'Job Properties - Nightly', dirty: true, attachWanted: true })
  expect(JSON.parse(entry.text)).toMatchObject({ kind: 'agentJob', target: { kind: 'agentJob', name: 'Nightly' }, draft: { description: 'Kept across a restart.' } })
  console.log('Agent hot exit checks: a quit asks nothing and keeps the edited job document with its target.')

  step = 'relaunch'
  // The relaunch reopens the job with the edit; once server-a reconnects (on its own, or by Connect) the job is read again with the edit on top.
  await launch()
  await expect(documentTab(page, 'Job Properties - Nightly')).toBeVisible({ timeout: 30000 })
  await documentTab(page, 'Job Properties - Nightly').click()
  await expect(unsavedMark(documentTab(page, 'Job Properties - Nightly'))).toBeVisible()
  await expect(description()).toHaveValue('Kept across a restart.')
  await expect(job().getByText('Your unsaved changes were restored on the job as read now.', { exact: true })).toBeVisible({ timeout: 30000 })
  await expect(description()).toHaveValue('Kept across a restart.')
  await expect(documentVerb(job(), 'Nightly', 'Save · 1 change')).toBeEnabled()
  await page.screenshot({ path: 'artifacts/agent-hot-exit.png' })
  console.log('Agent hot exit checks: a relaunch reopens the job with its edit, and the reconnect reads it again with the edit on top, ready to save.')

  if (failures.length) throw new Error(`Page errors: ${failures.join(' | ')}`)
  console.log('Agent hot exit suite passed.')
} catch (error) {
  console.error(`Agent hot exit suite failed during ${step}:`, error)
  await page?.screenshot({ path: 'artifacts/agent-hot-exit-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await application?.close().catch(() => {})
}
