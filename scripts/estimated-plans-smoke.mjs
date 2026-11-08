// Real Electron entry points; optional part B uses SQL Server and an isolated profile. No renderer test hook starts an estimate.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { connectLive } from './fixtures/live-rows.mjs'
import { enlargeOutput } from './fixtures/results-pane.mjs'
import { resizeContent } from './fixtures/window-resize.mjs'
import { backendReady, planCanvas, planViewer, queryBarButton, documentTabs, outputView } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
let application, page
const failures = []
const watchdog = setTimeout(() => { console.error('Estimated plan suite timed out.'); application?.process()?.kill(); process.exitCode = 1 }, 180_000)
const textbox = () => page.locator('.monaco-editor [role="textbox"]')
async function text(sql) { await textbox().focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(sql) }
async function close() {
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await application.close()
}
try {
  for (const live of process.env.VARIA_TEST_SQL_SERVER ? [false, true] : [false]) {
    const profile = await mkdtemp(resolve('artifacts', 'estimated-profile-'))
    const control = await mkdtemp(resolve('artifacts', 'estimated-control-'))
    const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
    delete env.ELECTRON_RUN_AS_NODE
    if (!live) Object.assign(env, { VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control })
    else delete env.VARIA_TEST_BACKEND
    application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
    page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    page.on('pageerror', error => failures.push(error.message))
    await expect(backendReady(page, live ? /\.NET \d+\./ : 'fake')).toBeVisible({ timeout: 30_000 })
    // Windows CI has a 1024x768 display. Exercise that layout everywhere instead of relying on the host's screen.
    await resizeContent(application, page, 1024, 700)
    await expect(queryBarButton(page, 'Display Estimated Execution Plan')).toBeDisabled()
    if (live) await connectLive(page, expect)
    else {
      await page.getByRole('button', { name: 'Connect', exact: true }).first().click()
      const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
      await dialog.getByLabel('Server Name', { exact: true }).fill('estimated-test')
      // Fake connections must not depend on Windows identity or a Kerberos ticket on the host.
      await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
      await dialog.getByLabel('Login', { exact: true }).fill('reader')
      await dialog.getByLabel('Password', { exact: true }).fill('unused')
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    }
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    // All three features coexist: an estimate preserves ordinary grids, actual capture and the statistics trial.
    await queryBarButton(page, 'Include Actual Execution Plan').click()
    await queryBarButton(page, 'Include Client Statistics').click()
    await text(live ? 'SELECT COUNT_BIG(*) AS first_value FROM sys.objects;\nGO\nSELECT COUNT_BIG(*) AS second_value FROM sys.columns;' : 'ACTUAL_PLAN_FIXTURE')
    await page.keyboard.press('F5')
    await expect(queryBarButton(page, 'Display Estimated Execution Plan')).toBeEnabled()
    await expect(outputView(page, 'Execution plan, 2 plans')).toBeVisible()
    const firstCell = page.getByRole('grid', { name: /^Result 1 of/ }).getByRole('gridcell').first()
    // The result summary can arrive before the worker paints this cell's page.
    await expect(firstCell).toHaveText(/^\d+$/)
    const retainedValue = await firstCell.innerText()
    await outputView(page, 'Client Statistics').click()
    const statistics = page.getByRole('table', { name: 'Client statistics comparison', exact: true })
    await expect(statistics.getByRole('columnheader', { name: 'Run 1', exact: true })).toBeVisible()
    await text('SELECT name FROM sys.objects;')
    await page.keyboard.press(`${mod}+l`)
    await expect(page.locator('[data-estimated-plan]')).toContainText('Estimated')
    await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
    await expect(outputView(page, 'Execution plan, Estimated').getByText('1', { exact: true })).toBeVisible()
    await expect(queryBarButton(page, 'Include Actual Execution Plan')).toHaveAttribute('aria-pressed', 'true')
    await expect(queryBarButton(page, 'Include Client Statistics')).toHaveAttribute('aria-pressed', 'true')
    await outputView(page, 'Client Statistics').click()
    await expect(statistics.getByRole('columnheader', { name: 'Run 1', exact: true })).toBeVisible()
    await expect(statistics.getByRole('columnheader', { name: /Previous \(run/ })).toHaveCount(0)
    await outputView(page, /^Results,/).click()
    await expect(firstCell).toHaveText(retainedValue)
    // Returning to a query keeps the output the user selected, even while that query retains an estimate.
    await page.keyboard.press(`${mod}+n`)
    await documentTabs(page).getByRole('tab').filter({ hasText: /^SQLQuery1/ }).click()
    await expect(outputView(page, /^Results,/)).toHaveAttribute('aria-selected', 'true')
    await expect(firstCell).toHaveText(retainedValue)
    await outputView(page, 'Execution plan, Estimated').click()
    // Give the short dock room through its normal splitter before inspecting outline rows below wrapped plan tools,
    // just as the results smoke suite does.
    await enlargeOutput(page)
    await expect(planViewer(page).getByRole('treeitem').first()).toBeVisible()
    await expect(planViewer(page).getByRole('treeitem').first()).toBeInViewport()
    await planViewer(page).getByRole('treeitem').first().click()
    await expect(planViewer(page).getByRole('complementary', { name: 'Plan properties' })).toContainText('Estimated rows')
    await planViewer(page).getByRole('button', { name: 'Fit batch', exact: true }).click()
    await page.screenshot({ path: resolve('artifacts', live ? 'estimated-plan-live.png' : 'estimated-plan-fake.png') })
    await planViewer(page).getByRole('button', { name: 'Open plan document', exact: true }).click()
    await expect(documentTabs(page).getByRole('tab', { selected: true })).toContainText('Estimated Plan 1')
    const save = join(control, 'estimated.sqlplan')
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, save)
    await page.keyboard.press(`${mod}+s`)
    await expect.poll(() => readFile(save, 'utf8').catch(() => '')).toContain('ShowPlanXML')
    if (live) expect(await readFile(save, 'utf8')).not.toContain('RunTimeCountersPerThread')
    await documentTabs(page).getByRole('tab').filter({ hasText: /^SQLQuery1/ }).click()
    // A toolbar click keeps Monaco's selection: the erroneous first line must not be submitted.
    await text('SELECT * FROM dbo.VariaEstimateMissing;\nSELECT name FROM sys.objects;')
    await page.keyboard.press('Home'); await page.keyboard.press('Shift+End')
    await queryBarButton(page, 'Display Estimated Execution Plan').click()
    await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
    if (!live) {
      const calls = (await readFile(join(control, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(calls.filter(call => call.method === 'plans.estimate').at(-1).params).toMatchObject({ sql: 'SELECT name FROM sys.objects;', startLine: 2 })
      expect(calls.filter(call => call.method === 'query.execute')).toHaveLength(1)
    }
    if (live) {
      await text('SET SHOWPLAN_XML OFF\nGO\nSELECT 1;')
      await queryBarButton(page, 'Display Estimated Execution Plan').click()
      await expect(page.locator('[data-estimated-plan]').getByRole('alert')).toContainText('Remove SHOWPLAN')
      await text('SELECT 42 AS ordinary;')
      await page.keyboard.press('F5')
      await expect(page.getByRole('gridcell', { name: '42', exact: true })).toBeVisible()
      await expect(page.locator('[data-estimated-plan]')).toHaveCount(0)
      // A streamed row can precede actual-capture cleanup; close only after the execution has settled.
      await expect(queryBarButton(page, 'Display Estimated Execution Plan')).toBeEnabled()
    }
    // A query with only an estimate has no ordinary ResultsService run to supply its Ctrl+R restore view.
    await documentTabs(page).getByRole('tab').filter({ hasText: /^SQLQuery2/ }).click()
    await text('SELECT name FROM sys.objects;')
    await page.keyboard.press(`${mod}+l`)
    await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
    await textbox().focus()
    await page.keyboard.press(`${mod}+r`)
    await expect(planViewer(page)).toBeHidden()
    await page.keyboard.press(`${mod}+r`)
    await expect(planViewer(page)).toBeVisible()
    await close()
    console.log(`Estimated plan Electron checks passed (${live ? 'SQL Server' : 'fake backend'}).`)
  }
  expect(failures).toEqual([])
} catch (error) {
  console.error(error)
  await page?.screenshot({ path: resolve('artifacts', 'estimated-plan-failure.png') }).catch(() => {})
  process.exitCode = 1
  await close().catch(() => application?.process()?.kill())
} finally { clearTimeout(watchdog) }
