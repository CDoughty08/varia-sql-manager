// The job document's Steps › Flow view (docs/sql-server-agent.md › Steps › Flow; mocks rx-flow*) against the fake backend's Nightly job
// (tests/fixtures/backend.mjs, VARIA_TEST_BACKEND=workbench): the document opens on List and the switch shows Flow, drawn by the Pixi canvas
// with the steps' accessible tree over it. Nightly's last step goes to the next step, so the End warning shows with its fix; the keyboard
// moves the selection, Shift+F10 opens the step's menu whose On failure › makes a loop (warned), Enter docks the List's editor, a ✗ port
// dragged onto a step sets Go to step, List shows the same draft, and Save sends it. Screenshots in Dark and Light go to artifacts/.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chooseExplorerMenuItem } from './fixtures/explorer-tree.mjs'
import { connectDialogWindow, documentFrame, documentTab, documentVerb, gridPart, liveGrid, statusBar, submitConnect, toolbarButton } from './fixtures/ui.mjs'
import { parseCalls } from './fixtures/call-log.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'agent-flow-profile-'))
const control = await mkdtemp(resolve('artifacts', 'agent-flow-backend-'))
await writeFile(resolve(control, 'agent-node'), '')
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error('Steps Flow suite exceeded its time limit.'); app.process()?.kill(); process.exitCode = 1 }, 120000)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const failures = []
let step = 'start'
page.on('pageerror', error => failures.push(error.message))

const job = documentFrame(page, 'Nightly')
const tree = job.getByRole('tree', { name: 'Steps flow, in step order', exact: true })
const item = n => tree.getByRole('treeitem').nth(n - 1)
const checks = job.getByRole('list', { name: /^Flow checks/ })
const saves = async () => parseCalls(await readFile(resolve(control, 'calls.jsonl'), 'utf8').catch(() => '')).filter(call => call.method === 'actions.execute' && call.params.action === 'agentJob').map(call => call.params)

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

  step = 'switch'
  // Every document opens on List; the switch leads the list's header, then the graph's toolbar.
  const views = job.getByRole('radiogroup', { name: 'Steps view', exact: true })
  await expect(views.getByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'true')
  // A radio group's keys: one tab stop, and the arrow chooses Flow.
  await views.getByRole('radio', { name: 'List' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(views.getByRole('radio', { name: 'Flow' })).toBeFocused()
  await expect(views.getByRole('radio', { name: 'Flow' })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(views.getByRole('radio', { name: 'List' })).toBeFocused()
  await views.getByRole('radio', { name: 'Flow' }).click()
  await expect(tree.getByRole('treeitem')).toHaveCount(3)
  await expect(job.locator('canvas')).toBeVisible()
  await expect(item(1)).toHaveAccessibleName('Step 1, Check integrity, T-SQL, Start step. On success, go to the next step. On failure, quit reporting failure.')
  await expect(item(3)).toHaveAccessibleName(/On success, go to the next step, which fails the job\./)
  await tree.scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'artifacts/agent-flow-dark.png' })

  step = 'end'
  // The last step goes to the next step: warned, with Quit reporting success as its fix.
  const end = checks.getByRole('listitem').filter({ hasText: 'Step 3 goes to the next step, but it is the last step' })
  await expect(end).toBeVisible()
  await end.getByRole('button', { name: 'Quit reporting success' }).click()
  await expect(end).toHaveCount(0)
  await expect(item(3)).toHaveAccessibleName(/On success, quit reporting success\./)
  await expect(documentVerb(job, 'Nightly', /^Save/)).toBeEnabled()

  step = 'keyboard'
  // The tree keeps focus over the canvas: Down selects step 2 and its summary follows; Shift+F10 opens its menu below the node.
  await tree.focus()
  await page.keyboard.press('ArrowDown')
  await expect(item(2)).toHaveAttribute('aria-selected', 'true')
  await expect(job.getByRole('region', { name: 'Selected step' })).toContainText('Rebuild indexes')
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Step actions', exact: true })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: /On failure/ }).click()
  const failure = page.getByRole('menu', { name: 'On failure' })
  await expect(failure.getByRole('menuitemradio', { name: /Quit the job reporting failure/ })).toHaveAttribute('aria-checked', 'true')
  await failure.getByRole('menuitemradio', { name: /Go to step 1: Check integrity/ }).click()
  await expect(item(2)).toHaveAccessibleName(/On failure, go to step 1, loop\./)
  await expect(checks.getByRole('listitem').filter({ hasText: 'Steps 1 and 2 can repeat' })).toBeVisible()

  step = 'editor'
  // Enter docks the List's step editor beside the graph; Close editor goes back to the summary.
  await tree.focus()
  await page.keyboard.press('Enter')
  const editor = job.getByRole('group', { name: 'Step 2: Rebuild indexes', exact: true })
  await expect(editor.getByLabel('On failure', { exact: true })).toHaveValue(/^goto:/)
  await expect(job.getByText('Step 2 of 3')).toBeVisible()
  await job.getByRole('button', { name: 'Close editor' }).click()
  await expect(editor).toHaveCount(0)

  step = 'drag'
  // A ✗ port dragged onto a step sets Go to step: step 3's failure port (70 % across, at the node's foot) onto step 1. The tree items sit
  // over their nodes, so their boxes say where the canvas drew them.
  const from = await item(3).boundingBox(), to = await item(1).boundingBox()
  await page.mouse.move(from.x + from.width * 0.7, from.y + from.height)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(item(3)).toHaveAccessibleName(/On failure, go to step 1, loop\./)

  step = 'list'
  // List shows the same draft: step 3's failure goes to step 1.
  await views.getByRole('radio', { name: 'List' }).click()
  const list = job.getByRole('listbox', { name: 'Steps', exact: true })
  await expect(list.getByRole('option').nth(2)).toContainText('Step 1')
  await views.getByRole('radio', { name: 'Flow' }).click()
  await expect(tree.getByRole('treeitem')).toHaveCount(3)

  step = 'light'
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'light' }))
  await page.screenshot({ path: 'artifacts/agent-flow-light.png' })

  step = 'save'
  await documentVerb(job, 'Nightly', /^Save/).click()
  await expect.poll(async () => (await saves()).length).toBe(1)
  const writes = (await saves())[0].agentJob.steps.writes
  const written = id => { const write = writes.find(item => item.id === id); return write && [write.onSuccessAction, write.onFailAction, write.onFailStepId] }
  expect([written(2), written(3)]).toEqual([[3, 4, 1], [1, 4, 1]])
  console.log('Steps Flow passed: List and Flow show one draft; checks, the step menu, the docked editor and a port drag edit it, and Save sends it.')
} catch (error) {
  failures.push(`${step}: ${error.message}`)
  await page.screenshot({ path: 'artifacts/agent-flow-failure.png' }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await app.close().catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
}
