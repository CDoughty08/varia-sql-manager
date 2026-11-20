// Real Electron entry points; optional part B uses SQL Server and an isolated profile. No renderer test hook starts an estimate.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { connectLive } from './fixtures/live-rows.mjs'
import { enlargeOutput } from './fixtures/results-pane.mjs'
import { resizeContent } from './fixtures/window-resize.mjs'
import { checkCanvasUx } from './fixtures/plan-canvas-ux.mjs'
import { backendReady, localGrid, planCanvas, planViewer, queryBarButton, documentTabs, outputView, pane, selectOpenDocument } from './fixtures/ui.mjs'
import { parseCalls } from './fixtures/call-log.mjs'

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
    const statistics = localGrid(page, 'Client statistics comparison')
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
    await selectOpenDocument(page, /^SQLQuery1/)
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
    // The outline copies its selected operator as one tab-separated row (Operator, Object, Estimated subtree cost, Rows):
    // Ctrl+C in the tree, or Copy on a row's menu, with a header line only when Include column headers when copying is on.
    const clipboardText = () => application.evaluate(({ clipboard }) => clipboard.readText())
    const operatorTree = planViewer(page).getByRole('tree', { name: 'Plan operators', exact: true })
    const firstOperator = planViewer(page).getByRole('treeitem').first()
    // The row shows the operator first, then its object and rows on a second line.
    const nameOf = async item => (await item.innerText()).split(/\n| · /)[0].trim()
    const rowOf = name => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\t[^\\t\\r\\n]*\\t[^\\t\\r\\n]+\\t(Est\\.|Actual|Live partial|Rows unavailable)[^\\t\\r\\n]*$`)
    const operatorRow = rowOf(await nameOf(firstOperator))
    await application.evaluate(({ clipboard }) => clipboard.writeText('before'))
    await operatorTree.focus()
    await page.keyboard.press(`${mod}+c`)
    await expect.poll(clipboardText).toMatch(operatorRow)
    // Edit › Copy reaches the focused outline as a copy event, and copies the operator as Ctrl+C does.
    await application.evaluate(({ clipboard }) => clipboard.writeText('before'))
    await operatorTree.dispatchEvent('copy')
    await expect.poll(clipboardText).toMatch(operatorRow)
    expect((await page.evaluate(() => window.varia.updateSettings({ 'queryResults.grid.copyColumnHeaders': true }))).ok).toBe(true)
    await application.evaluate(({ clipboard }) => clipboard.writeText('before'))
    // A right-click on another operator selects it and copies that one.
    const secondOperator = planViewer(page).getByRole('treeitem').nth(1)
    const secondRow = rowOf(await nameOf(secondOperator))
    await secondOperator.click({ button: 'right' })
    await expect(secondOperator).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('menu', { name: 'Plan outline', exact: true }).getByRole('menuitem', { name: /^Copy/ }).click()
    await expect.poll(async () => (await clipboardText()).split(/\r?\n/)).toEqual(['Operator\tObject\tEstimated subtree cost\tRows', expect.stringMatching(secondRow)])
    await firstOperator.click()
    expect((await page.evaluate(() => window.varia.updateSettings({ 'queryResults.grid.copyColumnHeaders': null }))).ok).toBe(true)
    // Properties: Copy Value copies the value of the fact right-clicked, and Copy its name and value.
    const planProperties = planViewer(page).getByRole('complementary', { name: 'Plan properties' })
    const rowsFact = planProperties.getByText('Estimated rows per execution', { exact: true })
    await application.evaluate(({ clipboard }) => clipboard.writeText('before'))
    await rowsFact.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Plan properties', exact: true }).getByRole('menuitem', { name: 'Copy Value', exact: true }).click()
    await expect.poll(clipboardText).not.toBe('before')
    const rowsValue = await clipboardText()
    expect(rowsValue).not.toMatch(/[\t\r\n]/)
    await rowsFact.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Plan properties', exact: true }).getByRole('menuitem', { name: 'Copy', exact: true }).click()
    await expect.poll(clipboardText).toBe(`Estimated rows per execution\t${rowsValue}`)
    console.log('Plan copy checks: the outline copies its operator with Ctrl+C and its menu, and Properties copies a value or a name and value.')
    await planViewer(page).getByRole('button', { name: 'Fit batch', exact: true }).click()
    await page.screenshot({ path: resolve('artifacts', live ? 'estimated-plan-live.png' : 'estimated-plan-fake.png') })
    await planViewer(page).getByRole('button', { name: 'Open plan document', exact: true }).click()
    await expect(documentTabs(page).getByRole('tab', { selected: true })).toContainText('Estimated Plan 1')
    const save = join(control, 'estimated.sqlplan')
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, save)
    await page.keyboard.press(`${mod}+s`)
    await expect.poll(() => readFile(save, 'utf8').catch(() => '')).toContain('ShowPlanXML')
    if (live) expect(await readFile(save, 'utf8')).not.toContain('RunTimeCountersPerThread')
    await selectOpenDocument(page, /^SQLQuery1/)
    // A toolbar click keeps Monaco's selection: the erroneous first line must not be submitted.
    await text('SELECT * FROM dbo.VariaEstimateMissing;\nSELECT name FROM sys.objects;')
    await page.keyboard.press('Home'); await page.keyboard.press('Shift+End')
    await queryBarButton(page, 'Display Estimated Execution Plan').click()
    await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
    if (!live) {
      const calls = parseCalls(await readFile(join(control, 'calls.jsonl'), 'utf8'))
      expect(calls.filter(call => call.method === 'plans.estimate').at(-1).params).toMatchObject({ sql: 'SELECT name FROM sys.objects;', startLine: 2 })
      expect(calls.filter(call => call.method === 'query.execute')).toHaveLength(1)
    }
    if (live) {
      await text('SET SHOWPLAN_XML OFF\nGO\nSELECT 1;')
      await queryBarButton(page, 'Display Estimated Execution Plan').click()
      await expect(page.locator('[data-estimated-plan]').getByRole('alert')).toContainText('Remove SHOWPLAN')
      await text('CREATE TABLE #estimate_ui(n int); INSERT #estimate_ui VALUES(42); SET ARITHABORT OFF; SET TEXTSIZE 1234; BEGIN TRAN;')
      await page.keyboard.press('F5')
      await expect(queryBarButton(page, 'Display Estimated Execution Plan')).toBeEnabled()
      await text('SELECT * FROM dbo.VariaEstimateMissing;\nSELECT n FROM #estimate_ui;')
      await page.keyboard.press('Home'); await page.keyboard.press('Shift+End')
      await queryBarButton(page, 'Display Estimated Execution Plan').click()
      await expect(page.locator('[data-estimated-plan]').getByRole('alert')).toContainText('#estimate_ui')
      // Switch mode through the visible pane. The second line stays selected and can see the original session's temp table.
      await page.getByRole('button', { name: 'Estimate in query session', exact: true }).click()
      await expect(page.locator('[data-estimated-plan]')).toContainText('Estimated · Query session')
      await expect(page.locator('[data-estimated-plan]')).toContainText('@@ROWCOUNT and @@ERROR')
      await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
      await page.screenshot({ path: resolve('artifacts', 'estimated-plan-session-live.png') })
      // The dedicated Query menu action uses the same selected statement and session mode.
      await page.getByRole('menubar', { name: 'Application menu', exact: true }).getByRole('menuitem', { name: 'Query', exact: true }).click()
      await page.getByRole('menu', { name: 'Query', exact: true }).getByRole('menuitem', { name: 'Display Estimated Plan in Query Session', exact: true }).click()
      await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
      await expect(queryBarButton(page, 'Display Estimated Execution Plan')).toBeEnabled()
      await text('SELECT @@TRANCOUNT AS open_transactions, n FROM #estimate_ui;')
      await page.keyboard.press('F5')
      await expect(page.getByRole('gridcell', { name: '42', exact: true })).toBeVisible()
      await expect(page.getByRole('gridcell', { name: '1', exact: true })).toBeVisible()
      await expect(queryBarButton(page, 'Display Estimated Execution Plan')).toBeEnabled()
      await text('ROLLBACK; SELECT 42 AS ordinary;')
      await page.keyboard.press('F5')
      await expect(page.getByRole('gridcell', { name: '42', exact: true })).toBeVisible()
      await expect(page.locator('[data-estimated-plan]')).toHaveCount(0)
      // A streamed row can precede actual-capture cleanup; close only after the execution has settled.
      await expect(queryBarButton(page, 'Display Estimated Execution Plan')).toBeEnabled()
    }
    // A query with only an estimate has no ordinary ResultsService run to supply its Ctrl+R restore view.
    await selectOpenDocument(page, /^SQLQuery2/)
    await text('SELECT name FROM sys.objects;')
    await page.keyboard.press(`${mod}+l`)
    await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
    await textbox().focus()
    await page.keyboard.press(`${mod}+r`)
    await expect(planViewer(page)).toBeHidden()
    await page.keyboard.press(`${mod}+r`)
    await expect(planViewer(page)).toBeVisible()
    if (live) {
      // Saved XML uses the same parser and diagnostic UI as captured plans, through the normal Open entry point.
      await application.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }) }, resolve('tests/fixtures/plans/diagnostics.sqlplan'))
      await page.keyboard.press(`${mod}+o`)
      await expect(documentTabs(page).getByRole('tab', { selected: true })).toContainText('diagnostics.sqlplan')
      // A plan document is not a query: the enlarged output gives it the whole document area by itself.
      await expect(pane(page, 'plan')).toBeHidden()
      const viewer = planViewer(page), properties = viewer.getByRole('complementary', { name: 'Plan properties' })
      await viewer.getByRole('treeitem').filter({ hasText: 'Index Seek' }).click()
      await properties.getByText('Predicates (3)', { exact: true }).click()
      await expect(properties).toContainText('Seek Prefix')
      await expect(properties).toContainText('Residual')
      await properties.getByText('Parameters (2)', { exact: true }).click()
      await expect(properties).toContainText("N'完了'")
      await properties.getByText('Missing indexes (1)', { exact: true }).click()
      await expect(properties).toContainText('INCLUDE')
      await viewer.getByRole('combobox', { name: 'Operator ranking' }).selectOption('cpu')
      await expect(viewer.getByRole('treeitem').first()).toContainText('Sort · 18 ms')
      await expect(viewer.getByRole('treeitem').nth(1)).toContainText('Index Seek · 0 ms')
      await viewer.getByRole('treeitem').first().click()
      await properties.getByText('Spill details (2)', { exact: true }).click()
      await expect(properties).toContainText('WritesToTempDb')
      await properties.getByText('Thread runtime (3 retained entries)', { exact: true }).click()
      await expect(properties.getByText('Thread 0 · entry 1', { exact: true })).toBeVisible()
      await viewer.getByRole('combobox', { name: 'Operator ranking' }).selectOption('rows')
      await expect(viewer.getByRole('treeitem').first()).toContainText('5× underestimate')
      await page.screenshot({ path: resolve('artifacts', 'plan-diagnostics.png') })
      await page.getByRole('group', { name: 'Execution plan document views' }).getByRole('button', { name: 'XML source', exact: true }).click()
      await expect(page.getByRole('code')).toContainText('ShowPlanXML')
      await page.screenshot({ path: resolve('artifacts', 'plan-diagnostics-source.png') })
      await page.getByRole('button', { name: 'Graph', exact: true }).click()
      // A document-tab round trip while XML source is showing leaves the graph selection independent of the unmoved XML caret.
      const views = page.getByRole('group', { name: 'Execution plan document views' })
      await viewer.getByRole('treeitem').filter({ hasText: 'Sort' }).first().click()
      await viewer.getByRole('button', { name: 'Go to XML', exact: true }).click()
      await expect(views.getByRole('button', { name: 'XML source', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await views.getByRole('button', { name: 'Graph', exact: true }).click()
      await expect(viewer.getByRole('treeitem', { selected: true })).toContainText('Sort')
      await viewer.getByRole('treeitem').filter({ hasText: 'Index Seek' }).first().click()
      await views.getByRole('button', { name: 'XML source', exact: true }).click()
      await page.keyboard.press(`${mod}+n`)
      await expect(documentTabs(page).getByRole('tab', { selected: true })).not.toContainText('diagnostics.sqlplan')
      await selectOpenDocument(page, /diagnostics\.sqlplan/)
      await expect(views.getByRole('button', { name: 'XML source', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await views.getByRole('button', { name: 'Graph', exact: true }).click()
      await expect(viewer.getByRole('treeitem', { selected: true })).toContainText('Index Seek')
      await checkCanvasUx({ application, page, expect })
    }
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
