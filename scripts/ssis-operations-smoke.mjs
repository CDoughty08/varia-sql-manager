// Integration Services Operations against the fake backend's SSIS catalog (tests/fixtures/backend.mjs, VARIA_TEST_BACKEND=workbench):
// the SSISDB node's Active Operations and reports open one live document per connection; tiles count and filter, the
// filter bar reads the window again, the grid updates in place with the selection kept on the same operation, Stop Operation
// asks, stops and shows Stopping then Canceled, F5, Pause and Copy act on it, hiding the tab pauses it and closing ends it,
// a server with no catalog says so in place of its rows (in view in a short window), and a view the catalog refuses offers
// Retry, which subscribes again. Screenshots in Dark and Light go to artifacts/.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expandExplorerPath, revealExplorerRow } from './fixtures/explorer-tree.mjs'
import { documentCrumbs, documentFrame, documentTab, documentTabs, gridPart, gridTones, liveGrid, liveGridSelector, menuItemNames, statusBar, toolbarButton } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'ssis-operations-profile-'))
const control = await mkdtemp(resolve('artifacts', 'ssis-operations-backend-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error('SSIS Operations suite exceeded its time limit.'); app.process()?.kill(); process.exitCode = 1 }, 300000)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const failures = []
let step = 'start'
page.on('pageerror', error => failures.push(error.message))

const title = 'Operations'
const frame = () => documentFrame(page, title)
const grid = () => liveGrid(page, 'Operations')
const fast = { force: true }
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const parts = { grid: liveGridSelector('Operations'), row: gridPart.row, cell: gridPart.cell, tones: gridTones }
/** The operations shown, top to bottom: id, type, status and folder (the grid draws only the columns in view), and tone. */
const rows = () => page.evaluate(({ grid, row, cell, tones }) => {
  const toneOf = element => Object.keys(tones).find(tone => element.matches(tones[tone])) ?? 'none'
  const text = (element, column) => [...element.querySelectorAll(cell)].find(item => item.style.display !== 'none' && item.getAttribute('aria-colindex') === String(column + 2))?.textContent
  return [...document.querySelectorAll(`${grid} ${row}`)].filter(element => element.style.display !== 'none' && element.hasAttribute('aria-rowindex'))
    .map(element => ({ index: Number(element.getAttribute('aria-rowindex')) - 2, id: text(element, 0), type: text(element, 1), status: text(element, 2), folder: text(element, 3), tone: toneOf(element) }))
    .sort((a, b) => a.index - b.index)
}, parts)
/** The active cell's row: its operation id, as the grid tells a screen reader. */
const activeId = () => page.evaluate(({ grid, cell }) => {
  const root = document.querySelector(grid), active = root && document.getElementById(root.getAttribute('aria-activedescendant') ?? '')
  const row = active?.closest('[role="row"]')
  return row ? [...row.querySelectorAll(cell)].find(item => item.getAttribute('aria-colindex') === '2')?.textContent ?? null : null
}, parts)
const calls = async method => (await readFile(resolve(control, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.method === method).map(call => call.params)
const operationsUpdates = async () => (await calls('live.update')).filter(update => update.args || update.refresh || update.paused !== undefined)
const views = () => page.evaluate(() => window.__variaLive.snapshot().handles.filter(handle => handle.source === 'ssis.operations'))
const tile = name => frame().getByRole('group', { name: 'Operation counts', exact: true }).getByRole('button', { name: new RegExp(`^${name}: `) })
const chip = (group, name) => frame().getByRole('group', { name: group, exact: true }).getByRole('button', { name: new RegExp(`^${name}$`) })
const verb = name => frame().getByRole('group', { name: `${title} actions`, exact: true }).getByRole('button', { name, exact: true })
const menuNamed = name => page.getByRole('menu', { name, exact: true })
const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())

/** Clicks operation `id`'s row until the grid's active row is that operation: an arrival can move the row down between
 * finding it and the click landing, which then selects the operation that took its place. */
async function selectOperation(id) {
  await expect(async () => {
    await grid().locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: new RegExp(`^${id}$`) }) }).locator(gridPart.cell).nth(2).click()
    await expect.poll(activeId, { timeout: 1000 }).toBe(id)
  }).toPass({ timeout: 20000 })
}
async function size(width, height) { await app.evaluate(({ BrowserWindow }, dimensions) => { BrowserWindow.getAllWindows()[0].setContentSize(...dimensions) }, [width, height]) }
/** Whether the header shows the server's crumb whole: its text is not cut. */
const serverCrumbWhole = () => documentCrumbs(frame()).first().evaluate(item => { const text = item.firstElementChild; return !!text && text.clientWidth > 0 && text.scrollWidth <= text.clientWidth })
async function connect(server) {
  await toolbarButton(page, 'Connect').click()
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(dialog.getByText('Loading saved connections…')).toHaveCount(0)
  await dialog.getByLabel('Server Name', { exact: true }).fill(server)
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30000 })
}
/** Right-click the server's SSISDB node and choose `item`. */
async function fromCatalog(server, item) {
  await expandExplorerPath(page, server, 'Integration Services Catalogs')
  await (await revealExplorerRow(page, server, 'Integration Services Catalogs', 'SSISDB')).click({ button: 'right', force: true })
  const menu = menuNamed('Object Explorer')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: item, exact: true }).click(fast)
}

try {
  step = 'open'
  await expect(statusBar(page)).toContainText(/Ready/, { timeout: 30000 })
  // Samples every second, so the suite sees several within its waits.
  expect(await page.evaluate(() => window.varia.updateSettings({ 'integrationServices.operationsRefreshSeconds': 1 }))).toMatchObject({ ok: true })
  await connect('server-a')
  await expandExplorerPath(page, 'server-a', 'Integration Services Catalogs')
  await (await revealExplorerRow(page, 'server-a', 'Integration Services Catalogs', 'SSISDB')).click({ button: 'right', force: true })
  expect((await menuItemNames(menuNamed('Object Explorer'))).slice(0, 4)).toEqual(['Active Operations', 'All Executions', 'All Validations', 'All Operations'])
  await page.keyboard.press('Escape')
  await fromCatalog('server-a', 'Active Operations')
  await expect(documentTab(page, 'Operations - server-a')).toHaveAttribute('aria-selected', 'true')
  await expect(frame()).toBeVisible()
  await expect(documentCrumbs(frame())).toHaveText(['server-a', 'SSISDB'])
  await expect(frame()).toContainText('Active Operations')
  await expect(frame()).toContainText(/Live · every 1 s/)
  // Active Operations lists what has not ended: the running execution and the pending validation, newest first.
  // Open operations carry no tint: the grid's running tone is the selection's hue, and would read as a selected block.
  await expect.poll(async () => (await rows()).map(row => `${row.id} ${row.status} ${row.tone}`).slice(-2)).toEqual(['108 Running none', '107 Pending none'])
  await expect(grid()).toHaveAttribute('aria-label', /^Operations, \d+ rows, 14 columns$/)
  expect((await calls('live.subscribe')).at(-1)).toMatchObject({ source: 'ssis.operations', args: { statuses: [1, 2, 5, 8], windowHours: 24, limit: 1000 }, probes: [{ probe: 'ssis.operations.list', intervalMs: 1000 }] })
  await expect(tile('Failed')).toHaveAttribute('aria-label', 'Failed: 1, Last 24 hours')
  await expect(tile('Pending')).toHaveAttribute('aria-label', 'Pending: 1, Now')
  // The chip rows are labelled for sight, and Status lists the open statuses first, as the tiles do.
  await expect(frame().getByRole('group', { name: 'Status', exact: true }).getByRole('button').first()).toHaveAccessibleName('Running')
  await page.screenshot({ path: 'artifacts/ssis-operations-dark.png' })
  // At 1280 px the header still says which server the document is for.
  await size(1280, 800)
  await expect.poll(serverCrumbWhole).toBe(true)
  await size(1600, 1000)
  console.log('Open passed: SSISDB › Active Operations opens a live document of open operations with counts.')

  step = 'in place'
  // A new execution arrives at the top; the selection stays on the same operation as its row moves down.
  await selectOperation('107')
  const first = (await rows()).findIndex(row => row.id === '107')
  await expect.poll(async () => (await rows()).findIndex(row => row.id === '107'), { timeout: 20000 }).toBeGreaterThan(first)
  expect(await activeId()).toBe('107')
  await expect(tile('Running')).toHaveAttribute('aria-label', /^Running: [2-9]/)
  console.log('In place passed: new operations arrive at the top and the selection stays on its operation.')
  // No more arrivals: the rows the next steps click stay where they are.
  await writeFile(resolve(control, 'ssis-quiet'), '')

  step = 'stop'
  // Stop Operation from the grid's menu asks first; Escape keeps it running and sends nothing.
  await selectOperation('108')
  // The grid's active row is read back before the verb offers itself: a running execution can be stopped.
  await expect(verb('Stop Operation')).toBeEnabled()
  await grid().locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: /^108$/ }) }).locator(gridPart.cell).nth(2).click({ button: 'right' })
  const operationsMenu = menuNamed('Integration Services Operations')
  await expect(operationsMenu).toBeVisible()
  expect(await menuItemNames(operationsMenu)).toEqual(['Stop Operation', 'Copy', 'Copy with Headers', 'Refresh', 'Pause'])
  await operationsMenu.getByRole('menuitem', { name: 'Stop Operation', exact: true }).click(fast)
  const question = frame().getByRole('alertdialog', { name: 'Stop Operation', exact: true })
  await expect(question).toContainText('Stop Daily.dtsx? It stops after its current work.')
  await expect(question.getByRole('button', { name: 'Keep running', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(question).toHaveCount(0)
  expect(await calls('ssis.execute')).toEqual([])
  // The header's verb asks again; Stop Operation stops it: Stopping (stopped by the login), then it leaves Active Operations.
  await verb('Stop Operation').click()
  await question.getByRole('button', { name: 'Stop Operation', exact: true }).click()
  await expect(frame().getByRole('status').filter({ hasText: 'Stop Operation sent for operation 108.' })).toBeVisible()
  expect((await calls('ssis.execute')).map(call => call.action)).toEqual([{ verb: 'stopOperation', operationId: 108 }])
  await expect.poll(async () => (await rows()).find(row => row.id === '108')?.status ?? 'gone').toBe('Stopping')
  expect((await rows()).find(row => row.id === '108')).toMatchObject({ tone: 'warning' })
  await expect(verb('Stop Operation')).toBeDisabled()
  await page.screenshot({ path: 'artifacts/ssis-operations-stopping.png' })
  await expect.poll(async () => (await rows()).some(row => row.id === '108'), { timeout: 20000 }).toBe(false)
  console.log('Stop passed: Stop Operation asks, Escape keeps the package running, and a stop shows Stopping, then it ends.')

  step = 'filters'
  // All Operations on the same server shows the same document with its own filters.
  const tabCount = await documentTabs(page).getByRole('tab').count()
  await fromCatalog('server-a', 'All Operations')
  await expect(documentTabs(page).getByRole('tab')).toHaveCount(tabCount)
  await expect(frame()).toContainText('All Operations')
  await expect.poll(async () => (await rows()).some(row => row.id === '101')).toBe(true)
  await expect.poll(async () => (await rows()).find(row => row.id === '108')?.status).toBe('Canceled')
  // A kind chip reads the window again: only the deployment.
  await chip('Kind', 'Deployments').click()
  await expect(chip('Kind', 'Deployments')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await rows()).map(row => row.type)).toEqual(['Deploy project'])
  expect((await operationsUpdates()).at(-1)?.args).toEqual({ kinds: ['deploy'], windowHours: 24, limit: 1000 })
  await chip('Kind', 'Deployments').click()
  // The Failed tile filters to failures in the last 24 hours, and pressed again shows every status.
  await tile('Failed').click()
  await expect(tile('Failed')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await rows()).map(row => `${row.id} ${row.status} ${row.tone}`)).toEqual(['103 Failed error'])
  await tile('Failed').click()
  await expect(tile('Failed')).toHaveAttribute('aria-pressed', 'false')
  // A folder typed by its start with Names start with: nothing is sent until Enter.
  await frame().getByRole('checkbox', { name: 'Names start with', exact: true }).check()
  await frame().getByLabel('Folder', { exact: true }).fill('Fin')
  const sent = (await operationsUpdates()).length
  await expect.poll(async () => (await operationsUpdates()).length).toBe(sent)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await operationsUpdates()).at(-1)?.args).toEqual({ folder: 'Fin', prefix: true, windowHours: 24, limit: 1000 })
  await expect.poll(async () => { const shown = await rows(); return shown.length > 0 && shown.every(row => row.folder === 'Finance') }).toBe(true)
  // A filter nothing passes says so, and Clear filters brings every operation back.
  await frame().getByLabel('Caller', { exact: true }).fill('nobody')
  await page.keyboard.press('Enter')
  await expect(frame().getByText('No operations match the filters', { exact: true })).toBeVisible()
  await frame().getByRole('button', { name: 'Clear filters', exact: true }).first().click()
  await expect.poll(async () => (await operationsUpdates()).at(-1)?.args).toEqual({ windowHours: 24, limit: 1000 })
  await expect(frame().getByLabel('Folder', { exact: true })).toHaveValue('')
  await expect.poll(async () => (await rows()).some(row => row.id === '101')).toBe(true)
  console.log('Filters passed: kinds, tiles and names read the window again, and Clear filters shows everything.')

  step = 'verbs'
  // F5 in the document refreshes it; Pause stops reading and says so; Copy with Headers copies the selected rows.
  await selectOperation('103')
  await page.keyboard.press('F5')
  await expect.poll(async () => (await operationsUpdates()).some(update => update.refresh)).toBe(true)
  await verb('Pause').click()
  await expect(verb('Pause')).toHaveAttribute('aria-pressed', 'true')
  await expect(frame()).toContainText('Paused')
  await expect.poll(async () => (await views())[0]?.status).toBe('paused')
  await verb('Pause').click()
  await expect(verb('Pause')).toHaveAttribute('aria-pressed', 'false')
  await expect(frame()).toContainText(/Live · every 1 s/)
  // The row header selects the whole row, as in a results grid.
  await grid().locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: /^103$/ }) }).locator(gridPart.rowHeader).click({ button: 'right', force: true })
  await operationsMenu.getByRole('menuitem', { name: 'Copy with Headers', exact: true }).click(fast)
  await expect.poll(clipboard).toMatch(/^ID\tType\tStatus\tFolder.*\r?\n103\tCreate and start execution\tFailed\tFinance/s)
  console.log('Verbs passed: F5 refreshes, Pause stops and resumes, Copy with Headers copies the selected operation.')

  step = 'light'
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'light' }))
  await page.screenshot({ path: 'artifacts/ssis-operations-light.png' })
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'dark' }))

  step = 'hidden'
  // Another tab hides the document: its view pauses after the hidden delay, and resumes when shown again.
  await page.keyboard.press(`${mod}+n`)
  await expect.poll(async () => (await views())[0]?.status, { timeout: 20000 }).toBe('paused')
  await documentTab(page, 'Operations - server-a').click()
  await expect.poll(async () => (await views())[0]?.status).toBe('live')
  // Closing it ends its view.
  await page.getByRole('button', { name: 'Close Operations - server-a', exact: true }).click()
  await expect.poll(async () => (await views()).length).toBe(0)
  console.log('Hidden passed: a hidden document pauses, comes back, and closing it ends its view.')

  step = 'no catalog'
  // A short window: what the document says must be in view, not scrolled away by the grid taking focus.
  await size(1024, 700)
  await connect('no-ssisdb')
  await fromCatalog('no-ssisdb', 'All Executions')
  await expect(documentTab(page, 'Operations - no-ssisdb')).toHaveAttribute('aria-selected', 'true')
  const noCatalog = frame().getByRole('status').filter({ hasText: 'This server has no SSIS Catalog.' })
  await expect(noCatalog).toBeVisible()
  await expect(noCatalog).toBeInViewport()
  await expect(frame()).toContainText('No SSIS Catalog')
  await expect(frame()).toContainText(/Stopped/)
  // Nothing in place of the rows suggests the view still runs: no tiles, filters, Retry, Refresh or Pause.
  await expect(frame().getByRole('group', { name: 'Operation counts', exact: true })).toHaveCount(0)
  await expect(frame().getByRole('group', { name: 'Filters', exact: true })).toHaveCount(0)
  await expect(frame().getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  await expect(frame()).not.toContainText('Waiting for data')
  await expect(verb('Refresh')).toBeDisabled()
  await expect(verb('Pause')).toBeDisabled()
  await page.screenshot({ path: 'artifacts/ssis-operations-no-catalog.png' })
  console.log('No catalog passed: a server without SSISDB says so where the rows would be, and offers nothing that cannot work.')

  step = 'retry'
  // A login the catalog refuses: the document says why and offers Retry, which subscribes again.
  await connect('ssis-denied')
  await fromCatalog('ssis-denied', 'Active Operations')
  await expect(documentTab(page, 'Operations - ssis-denied')).toHaveAttribute('aria-selected', 'true')
  const retry = frame().getByRole('button', { name: 'Retry', exact: true })
  await expect(frame()).toContainText('This login cannot read the SSIS Catalog.')
  await expect(retry).toBeInViewport()
  await expect(verb('Refresh')).toBeEnabled()
  const subscribed = (await calls('live.subscribe')).filter(call => call.source === 'ssis.operations').length
  await retry.click()
  await expect.poll(async () => (await calls('live.subscribe')).filter(call => call.source === 'ssis.operations').length).toBe(subscribed + 1)
  await expect(frame().getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  console.log('Retry passed: a refused view says why, and Retry subscribes again.')

  if (failures.length) throw new Error('Page errors: ' + failures.join(' | '))
  console.log('SSIS Operations suite passed.')
} catch (error) {
  console.error(`SSIS Operations suite failed at "${step}":`, error)
  await page.screenshot({ path: 'artifacts/ssis-operations-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await app.close().catch(() => app.process()?.kill())
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
