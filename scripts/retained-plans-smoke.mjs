// Normal query, history, file and palette entry points in isolated Electron profiles; optional real SQL Server lane.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { connectLive } from './fixtures/live-rows.mjs'
import { enlargeOutput } from './fixtures/results-pane.mjs'
import { resizeContent } from './fixtures/window-resize.mjs'
import { backendReady, documentTabs, outputView, planCanvas, planViewer, queryBarButton, quickInputActive } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
let application, page
const errors = []
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const editor = () => page.locator('.monaco-editor [role="textbox"]')
const history = () => page.getByRole('region', { name: 'Retained plans', exact: true })
const snapshots = () => history().getByRole('combobox', { name: 'Retained plan', exact: true })
async function text(sql) { await editor().focus(); await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText(sql) }
async function execute(sql) { await text(sql); await page.keyboard.press('F5'); await expect(queryBarButton(page, 'Display Estimated Execution Plan')).toBeEnabled() }
async function palette(text, expected) { await page.keyboard.press('F1'); await page.keyboard.type(text); await expect(quickInputActive(page)).toContainText(expected); await page.keyboard.press('Enter') }
async function showHistory() {
  await palette('show execution plan', 'View: Show Execution Plan')
  const button = page.getByRole('button', { name: /^Plan history \(/ })
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click()
  await expect(history()).toBeVisible()
}
async function close() {
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await application.close()
}
const watchdog = setTimeout(() => { console.error('Retained plan smoke timed out.'); application?.process()?.kill(); process.exitCode = 1 }, 240_000)
try {
  for (const live of process.env.VARIA_TEST_SQL_SERVER ? [false, true] : [false]) {
    const profile = await mkdtemp(resolve('artifacts', 'retained-profile-')), control = await mkdtemp(resolve('artifacts', 'retained-control-'))
    const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
    delete env.ELECTRON_RUN_AS_NODE
    if (!live) Object.assign(env, { VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control })
    else delete env.VARIA_TEST_BACKEND
    application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
    page = await application.firstWindow(); page.setDefaultTimeout(20_000)
    page.on('pageerror', error => errors.push(error.message))
    await expect(backendReady(page, live ? /\.NET \d+\./ : 'fake')).toBeVisible({ timeout: 30_000 })
    await resizeContent(application, page, 1024, 700)
    if (live) await connectLive(page, expect)
    else {
      await page.getByRole('button', { name: 'Connect', exact: true }).first().click()
      const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
      await dialog.getByLabel('Server Name', { exact: true }).fill('retained-test')
      await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
      await dialog.getByLabel('Login', { exact: true }).fill('reader')
      await dialog.getByLabel('Password', { exact: true }).fill('unused')
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    }
    await enlargeOutput(page)
    await queryBarButton(page, 'Include Actual Execution Plan').click()
    await queryBarButton(page, 'Include Client Statistics').click()
    const originalSql = live ? 'SELECT TOP (1) name AS retained_original FROM sys.objects;\nGO 2' : 'ACTUAL_PLAN_FIXTURE'
    await execute(originalSql)
    await showHistory()
    await enlargeOutput(page)
    await expect(snapshots().getByRole('option')).toHaveCount(2)
    await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
    const pinned = await snapshots().inputValue()
    await history().getByRole('button', { name: 'Pin snapshot', exact: true }).click()
    await history().locator('summary').first().click()
    await expect(history().getByLabel('Captured SQL context')).toHaveText(originalSql)
    const originalFile = join(control, 'original.sqlplan')
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, originalFile)
    await history().getByRole('button', { name: 'Save plan as…', exact: true }).click()
    await expect.poll(() => readFile(originalFile, 'utf8').catch(() => '')).toContain('ShowPlanXML')
    const originalXml = await readFile(originalFile, 'utf8')
    // Backend BeginQuery releases the old session's results; history must continue to open/save original XML.
    await execute(live ? 'SELECT TOP (2) name AS replaced FROM sys.columns;' : 'ACTUAL_PLAN_FIXTURE')
    await showHistory(); await snapshots().selectOption(pinned)
    const afterFile = join(control, 'after-reexecution.xml')
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, afterFile)
    await history().getByRole('button', { name: 'Save plan as…', exact: true }).click()
    await expect.poll(() => readFile(afterFile, 'utf8').catch(() => '')).toBe(originalXml)
    // Close Results is a normal command, with no history side effects.
    await palette('close results', 'Query: Close Results')
    await showHistory(); await snapshots().selectOption(pinned)
    await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
    // A toolbar estimate must keep just the selected SQL context even if the rest of the editor is invalid.
    await text('SELECT * FROM dbo.VariaRetainedMissing;\nSELECT name FROM sys.objects;')
    await page.keyboard.press('Home'); await page.keyboard.press('Shift+End')
    await queryBarButton(page, 'Display Estimated Execution Plan').click()
    await expect(queryBarButton(page, 'Display Estimated Execution Plan')).toBeEnabled()
    await showHistory(); await snapshots().selectOption({ index: 0 })
    await expect(history().getByLabel('Captured SQL context')).toHaveCount(1)
    await history().locator('summary').first().click()
    await expect(history().getByLabel('Captured SQL context')).toHaveText('SELECT name FROM sys.objects;')
    await expect(history()).toContainText('Selected SQL, starting at line 2')
    await expect(history().locator('summary').first()).toContainText('Estimated')
    const removed = await snapshots().inputValue()
    await history().getByRole('button', { name: 'Remove snapshot', exact: true }).click()
    await expect(snapshots().getByRole('option').filter({ hasText: 'Estimated' })).toHaveCount(0)
    expect(await snapshots().inputValue()).not.toBe(removed)
    if (live) {
      await text("SELECT TOP (1) name AS before_cancel FROM sys.objects;\nGO\nWAITFOR DELAY '00:00:30';")
      await page.keyboard.press('F5')
      await expect(page.getByRole('gridcell').first()).toBeVisible()
      await queryBarButton(page, 'Cancel').click()
      await expect(queryBarButton(page, 'Display Estimated Execution Plan')).toBeEnabled({ timeout: 30_000 })
      await showHistory(); await snapshots().selectOption({ index: 0 })
      await expect(history().locator('summary').first()).toContainText('cancelled · Partial execution')
    }
    await history().getByRole('button', { name: 'Clear unpinned', exact: true }).click()
    await expect(snapshots().getByRole('option')).toHaveCount(1)
    await expect(snapshots()).toHaveValue(pinned)
    // Close every originating document; history is still reachable through Window / palette.
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await palette('close all', 'File: Close All')
    await showHistory()
    await expect(snapshots()).toHaveValue(pinned)
    // Backend crash invalidates every result handle, without invalidating retained XML.
    await application.evaluate(() => globalThis.__variaTest.kill())
    await expect.poll(() => application.evaluate(() => globalThis.__variaTest.state().generation), { timeout: 30_000 }).toBe(2)
    await expect(backendReady(page, live ? /\.NET \d+\./ : 'fake')).toBeVisible({ timeout: 30_000 })
    await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
    await history().getByRole('button', { name: 'Open snapshot document', exact: true }).click()
    await expect(documentTabs(page).getByRole('tab', { selected: true })).toContainText('Actual Plan.sqlplan')
    await expect(planViewer(page).getByRole('treeitem').first()).toBeVisible()
    await page.screenshot({ path: resolve('artifacts', `retained-plan-${live ? 'live' : 'fake'}.png`) })
    await showHistory()
    await expect(snapshots()).toHaveValue(pinned)
    await close()
    // A new window/profile launch has no retained history, even with hot-exit documents on disk.
    application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
    page = await application.firstWindow(); page.setDefaultTimeout(20_000)
    await expect(backendReady(page, live ? /\.NET \d+\./ : 'fake')).toBeVisible({ timeout: 30_000 })
    await showHistory(); await expect(history()).toContainText('0 / 32 snapshots')
    await close()
    console.log(`Retained plans passed (${live ? 'SQL Server' : 'fake backend'}): pin, original XML save, re-execution, Close Results, selection context, close tabs, backend loss, reopen, remove, window reset.`)
  }
  expect(errors).toEqual([])
} catch (error) {
  console.error(error)
  await page?.screenshot({ path: resolve('artifacts/retained-plan-failure.png') }).catch(() => {})
  process.exitCode = 1
  await close().catch(() => application?.process()?.kill())
} finally { clearTimeout(watchdog) }
