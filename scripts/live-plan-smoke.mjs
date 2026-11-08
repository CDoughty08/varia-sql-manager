// Real Electron + SQL Server through the normal query toolbar and output tabs. Uses an isolated app profile.
import { electron, expect } from './fixtures/smoke.mjs'
import { connectLive } from './fixtures/live-rows.mjs'
import { enlargeOutput } from './fixtures/results-pane.mjs'
import { checkLargePlan } from './fixtures/large-plan.mjs'
import { backendReady, outputStatus, outputView, planCanvas, planViewer, queryBarButton } from './fixtures/ui.mjs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

if (!process.env.VARIA_TEST_SQL_SERVER) { console.log('Live Plan SQL smoke skipped: set VARIA_TEST_SQL_SERVER to run it.'); process.exit(0) }
await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'live-plan-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
const application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const page = await application.firstWindow()
page.setDefaultTimeout(30_000)
const errors = []
page.on('pageerror', error => errors.push(error.message))
const watchdog = setTimeout(() => { application.process()?.kill(); process.exit(1) }, 180_000)
async function sql(text) {
  const editor = page.locator('.monaco-editor [role="textbox"]')
  await editor.focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(text)
  await page.keyboard.press('F5')
}
try {
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await expect(backendReady(page)).toBeVisible({ timeout: 30_000 })
  await connectLive(page, expect)
  await enlargeOutput(page)
  const toggle = page.getByRole('button', { name: 'Include Live Execution Plan', exact: true })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await queryBarButton(page, 'Include Client Statistics').click()
  const aggregate = "SELECT SUM(CONVERT(bigint,CHECKSUM(HASHBYTES('SHA2_256',CONCAT(a.object_id,':',b.object_id))))) AS measured FROM sys.all_objects a CROSS JOIN sys.all_objects b OPTION(MAXDOP 1);"
  await sql('SET STATISTICS XML ON; ' + aggregate)
  await expect(outputStatus(page)).toContainText(/^Executing/)
  await outputView(page, /^Execution plan/).click()
  const viewer = planViewer(page), canvas = planCanvas(page)
  await expect(canvas.locator('canvas')).toHaveCount(1)
  await expect(viewer.getByRole('button', { name: 'Live', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const operator = viewer.getByRole('treeitem').filter({ hasText: /Nested Loops/ }).first()
  await operator.click()
  const selected = await operator.getAttribute('id')
  await viewer.getByRole('button', { name: 'Reset plan zoom to 100%', exact: true }).click()
  await viewer.getByRole('button', { name: 'Zoom in plan', exact: true }).click()
  const zoom = await viewer.getByRole('button', { name: 'Reset plan zoom to 100%', exact: true }).innerText()
  await canvas.evaluate(element => { window.__livePlanCanvas = element.querySelector('canvas') })
  const rowValue = () => viewer.locator('dt').filter({ hasText: /^Actual rows$/ }).locator('+ dd').innerText()
  const before = await rowValue()
  await expect.poll(rowValue, { timeout: 15_000 }).not.toBe(before)
  expect(await canvas.evaluate(element => window.__livePlanCanvas === element.querySelector('canvas'))).toBe(true)
  await expect(page.locator(`[id="${selected}"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(viewer.getByRole('button', { name: 'Reset plan zoom to 100%', exact: true })).toHaveText(zoom)
  await expect(outputStatus(page)).toContainText(/^Completed/, { timeout: 60_000 })
  await expect(viewer.getByRole('button', { name: 'Actual', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator(`[id="${selected}"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(viewer.getByRole('button', { name: 'Reset plan zoom to 100%', exact: true })).toHaveText(zoom)
  expect(await canvas.evaluate(element => window.__livePlanCanvas === element.querySelector('canvas'))).toBe(true)
  await expect(viewer.getByText('Partial live snapshot', { exact: true })).toHaveCount(0)
  await expect(viewer.getByRole('button', { name: 'Open plan document', exact: true })).toBeEnabled()
  await page.screenshot({ path: resolve('artifacts/live-plan-actual.png') })
  await outputView(page, 'Client Statistics').click()
  const statistics = page.getByRole('table', { name: 'Client statistics comparison', exact: true })
  await expect(statistics.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Server round trips', exact: true }) }).getByRole('cell').first()).toHaveText('1')
  await expect(page.getByLabel('Statistics execution').getByRole('option')).toContainText(['live plan'])
  // Cancel a later long statement: earlier completed plans and every GO repetition remain distinct.
  await sql("SET STATISTICS XML OFF; SELECT TOP (1) name AS before_live FROM sys.all_objects ORDER BY object_id;\nGO 2\n" + aggregate.replace('CROSS JOIN sys.all_objects b', 'CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c'))
  await outputView(page, /^Execution plan/).click()
  await expect(planViewer(page).getByRole('button', { name: 'Live', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
  await queryBarButton(page, 'Cancel').click()
  await expect(outputStatus(page)).toContainText(/^Cancelled/, { timeout: 30_000 })
  await expect(planViewer(page).getByRole('combobox', { name: 'Plan statement' }).getByRole('option')).toHaveCount(3)
  await page.screenshot({ path: resolve('artifacts/live-plan-partial.png') })
  // Estimating after a live execution preserves its results and toggles; the next F5 returns to Live/Actual output.
  const editor = page.locator('.monaco-editor [role="textbox"]')
  await editor.focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText('SELECT 1 AS estimated_after_live;')
  await queryBarButton(page, 'Display Estimated Execution Plan').click()
  await expect(page.locator('[data-estimated-plan]')).toContainText('Estimated')
  await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
  await expect(planViewer(page).getByRole('button', { name: 'Live', exact: true })).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await sql('SELECT name AS executed_after_estimate FROM sys.databases WHERE database_id = 1;')
  await expect(outputStatus(page)).toContainText(/^Completed/)
  await outputView(page, /^Execution plan/).click()
  await expect(page.locator('[data-estimated-plan]')).toHaveCount(0)
  await expect(planViewer(page).getByRole('button', { name: 'Actual', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(planViewer(page).getByRole('combobox', { name: 'Plan statement' }).getByRole('option')).toHaveCount(1)
  expect(errors).toEqual([])
  await checkLargePlan({ application, page, profile, expect })
  expect(errors).toEqual([])
  console.log('Live Plan: changing real operator rows; stable Pixi canvas, zoom and selection through actual capture; cancelled partial plan and GO repetitions.')
} finally {
  clearTimeout(watchdog)
  await application.close()
  await rm(profile, { recursive: true, force: true })
}
