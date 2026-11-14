// Grouped results drawn as tabs (queryResults.grid.layout = tabs) against the fake backend's synthetic result sets: the
// results toolbar's Tabs toggle, a row of result tabs with one grid mounted, a result's view tabs once it has a Pivot,
// each view keeping its selection across switches, Find Next selecting the tab that holds the match, closing from the tabs
// with the focus moving on, a row of more tabs than fit scrolling to the selected one, the Messages strip opening beside the two rows of tabs, and Stacked again from the palette.
// results-smoke.mjs covers the stacked layout and pins it. No assertion depends on absolute pixel sizes.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { enlargeOutput } from './fixtures/results-pane.mjs'
import {
  anyResultGrid, backendReady, columnProfile, gridCell, messagesStrip, outputStatus, part, pivotPanel, pivotSource, quickInputActive, resultGrid, resultsSearchCount, resultsToolbar, resultTab, resultTabPanel,
  resultTabs, tabClose, toolbarButton, viewTab, viewTabs
} from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'grouped-results-profile-'))
const control = await mkdtemp(resolve('artifacts', 'grouped-results-control-'))
await mkdir(join(control, 'hold'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
const application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error('Grouped results suite exceeded its time limit.'); application.process()?.kill(); process.exit(1) }, 300_000)
const page = await application.firstWindow()
page.setDefaultTimeout(30000)
const failures = []
page.on('pageerror', error => failures.push(error.message))

const textbox = () => page.locator('.monaco-editor [role="textbox"]')
const status = () => outputStatus(page)
const menu = id => application.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu().getMenuItemById(itemId).click(), id)
const show = name => resultsToolbar(page).getByRole('button', { name, exact: true })
async function run(sql) {
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(sql)
  await page.keyboard.press('F5')
  await expect(status()).toContainText(/^Completed( with errors)? · /)
}

async function toggleFromPalette() {
  await page.keyboard.press('F1')
  await page.keyboard.type('show results as tabs')
  await expect(quickInputActive(page)).toContainText('Query: Show Results as Tabs')
  await page.keyboard.press('Enter')
}

try {
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  // A hidden window draws about once a second; clicks and focus wait for frames.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await toolbarButton(page, 'Connect').click()
  await page.getByLabel('Server Name', { exact: true }).fill('server-a')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await enlargeOutput(page)

  // 1. Stacked is the default; the results toolbar's Tabs turns tabs on and the setting keeps it.
  await run('-- varia-fake: sets=W1*100,N1*10,W1*20')
  await expect(page.locator(part.resultStack)).toHaveCount(1)
  await expect(anyResultGrid(page)).toHaveCount(3)
  await expect(show('Tabs')).toHaveAttribute('aria-pressed', 'false')
  await show('Tabs').click()
  await expect(show('Tabs')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate(() => window.varia.getSettings().then(result => result.value.values['queryResults.grid.layout']))).toBe('tabs')
  await expect(page.locator(part.resultStack)).toHaveCount(0)
  await expect(resultTabs(page).getByRole('tab')).toHaveText(['Result 1', 'Result 2', 'Result 3'])
  await expect(resultTab(page, 'Result 1')).toHaveAttribute('aria-selected', 'true')
  await expect(viewTabs(page).getByRole('tab')).toHaveText(['Table'])
  // One grid is mounted: the selected view's, in the panel its view tab names.
  await expect(anyResultGrid(page)).toHaveCount(1)
  await expect(resultTabPanel(page).locator(resultGrid(page, 'Result 1', 'table'))).toHaveCount(1)
  await expect(resultTabPanel(page)).toHaveAttribute('aria-labelledby', await viewTab(page, 'Table').getAttribute('id'))
  console.log('Grouped results checks: the results toolbar\'s Tabs shows one result at a time under a row of result tabs, with one grid mounted.')

  // 2. Switching keeps each view's state: a cell selected in Result 1 is still selected after Result 2 was shown.
  await gridCell(resultGrid(page, 'Result 1'), 5, 1).click()
  await expect(gridCell(resultGrid(page, 'Result 1'), 5, 1)).toHaveAttribute('aria-selected', 'true')
  await resultTab(page, 'Result 2').click()
  await expect(resultTab(page, 'Result 2')).toHaveAttribute('aria-selected', 'true')
  await expect(resultGrid(page, 'Result 2')).toHaveCount(1)
  await expect(anyResultGrid(page)).toHaveCount(1)
  // The arrow keys move along the tabs and select as they go.
  await resultTab(page, 'Result 2').press('ArrowLeft')
  await expect(resultTab(page, 'Result 1')).toBeFocused()
  await expect(resultTab(page, 'Result 1')).toHaveAttribute('aria-selected', 'true')
  await expect(gridCell(resultGrid(page, 'Result 1'), 5, 1)).toHaveAttribute('aria-selected', 'true')
  console.log('Grouped results checks: switching tabs, by click or arrow keys, keeps each grid\'s selection.')

  // Column Profile follows the selected tab, without a grid taking the focus.
  await show('Profile').click()
  await expect(columnProfile(page)).toContainText('· 100 rows')
  await resultTab(page, 'Result 2').click()
  await expect(columnProfile(page)).toContainText('· 10 rows')
  await resultTab(page, 'Result 1').click()
  await expect(columnProfile(page)).toContainText('· 100 rows')
  await show('Profile').click()
  await expect(columnProfile(page)).toHaveCount(0)
  console.log('Grouped results checks: Column Profile follows the selected tab.')

  // 3. Find Next onto a match in another result selects its tab, then reveals the match.
  const findBox = resultsToolbar(page).getByRole('textbox', { name: 'Search results', exact: true })
  await findBox.fill('complete 7')
  await expect(resultsSearchCount(page)).toContainText('of 1')
  await expect(resultTab(page, 'Result 2')).toHaveAttribute('aria-selected', 'true')
  await expect(gridCell(resultGrid(page, 'Result 2'), 7, 3)).toHaveText('complete 7')
  // F3 from a grid: the grid shown instead takes the focus and makes the match its active cell, so F3 keeps working.
  await resultTab(page, 'Result 1').click()
  await gridCell(resultGrid(page, 'Result 1'), 5, 1).click()
  await page.keyboard.press('F3')
  await expect(resultTab(page, 'Result 2')).toHaveAttribute('aria-selected', 'true')
  await expect(resultGrid(page, 'Result 2')).toBeFocused()
  await expect(gridCell(resultGrid(page, 'Result 2'), 7, 3)).toHaveAttribute('aria-selected', 'true')
  await findBox.fill('')
  await resultTab(page, 'Result 1').click()
  console.log('Grouped results checks: Find Next, from the search box or F3 in a grid, selects the tab that holds the match, reveals it and keeps the grid focused.')

  // 4. A Pivot of Result 1 is a view tab beside its Table; Result 1's tab returns to the view it showed last.
  await show('Pivot').click()
  const pivoting = pivotPanel(page)
  await expect(pivotSource(page)).toHaveText('Result 1')
  await pivoting.getByRole('combobox', { name: 'Add row group', exact: true }).selectOption({ label: 'active' })
  await pivoting.getByRole('button', { name: 'Build Pivot', exact: true }).click()
  await expect(viewTabs(page).getByRole('tab')).toHaveText(['Table', 'Pivot'])
  await expect(viewTab(page, 'Pivot of Result 1')).toHaveAttribute('aria-selected', 'true')
  await expect(resultGrid(page, 'Result 1', 'pivot')).toHaveCount(1)
  await expect(anyResultGrid(page)).toHaveCount(1)
  await pivoting.getByRole('button', { name: 'Close Pivot', exact: true }).click()
  await resultTab(page, 'Result 3').click()
  await expect(viewTabs(page).getByRole('tab')).toHaveText(['Table'])
  await resultTab(page, 'Result 1').click()
  await expect(viewTab(page, 'Pivot of Result 1')).toHaveAttribute('aria-selected', 'true')
  await viewTab(page, 'Table').click()
  await expect(gridCell(resultGrid(page, 'Result 1', 'table'), 5, 1)).toHaveAttribute('aria-selected', 'true')
  await viewTab(page, 'Pivot of Result 1').click()
  await expect(resultGrid(page, 'Result 1', 'pivot')).toHaveCount(1)
  await page.screenshot({ path: resolve('artifacts', 'grouped-results-tabs-dark.png') })
  await menu('theme.mode.light')
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe('light')
  await page.screenshot({ path: resolve('artifacts', 'grouped-results-tabs-light.png') })
  await menu('theme.mode.dark')
  console.log('Grouped results checks: a Pivot is a view tab beside its Table, and a result\'s tab returns to the view it showed last.')

  // 5. Closing from the tabs: the Pivot's close selects its Table and focuses its view tab; a result's close selects the
  // next tab and focuses it.
  await expect(tabClose(page, 'Result 1')).toHaveAttribute('title', 'Close Result 1 and its Pivot')
  await tabClose(page, 'Pivot of Result 1').click()
  await expect(viewTabs(page).getByRole('tab')).toHaveText(['Table'])
  await expect(viewTab(page, 'Table')).toBeFocused()
  await tabClose(page, 'Result 1').click()
  await expect(resultTabs(page).getByRole('tab')).toHaveText(['Result 2', 'Result 3'])
  await expect(resultTab(page, 'Result 2')).toHaveAttribute('aria-selected', 'true')
  await expect(resultTab(page, 'Result 2')).toBeFocused()
  await expect(anyResultGrid(page)).toHaveCount(1)
  console.log('Grouped results checks: closing from the tabs selects the Table after its Pivot, else the next result, and the focus follows.')

  // 6. More result tabs than the row fits: End reaches the last, which scrolls into view and takes a click; Home goes back.
  await run(`-- varia-fake: sets=${Array(30).fill('N1*3').join(',')}`)
  await expect(resultTabs(page).getByRole('tab')).toHaveCount(30)
  await resultTab(page, 'Result 1').click()
  await expect(resultTab(page, 'Result 30')).not.toBeInViewport()
  await resultTab(page, 'Result 1').press('End')
  await expect(resultTab(page, 'Result 30')).toBeFocused()
  await expect(resultTab(page, 'Result 30')).toBeInViewport({ ratio: 1 })
  await resultTab(page, 'Result 29').click()
  await expect(resultTab(page, 'Result 29')).toHaveAttribute('aria-selected', 'true')
  await resultTab(page, 'Result 29').press('Home')
  await expect(resultTab(page, 'Result 1')).toBeInViewport({ ratio: 1 })
  console.log('Grouped results checks: a row of more tabs than fit scrolls to keep the selected tab in view.')
  // Stacked from the last result's grid: the stack opens at that result, so its grid takes the focus back; and Tabs again.
  await resultTab(page, 'Result 1').press('End')
  await gridCell(resultGrid(page, 'Result 30'), 1, 0).click()
  await expect(resultGrid(page, 'Result 30')).toBeFocused()
  await toggleFromPalette()
  await expect(page.locator(part.resultStack)).toHaveCount(1)
  await expect(resultGrid(page, 'Result 30')).toBeFocused()
  await toggleFromPalette()
  await expect(resultTabs(page)).toHaveCount(1)
  await expect(resultGrid(page, 'Result 30')).toBeFocused()
  console.log('Grouped results checks: switching the layout from a result far down the stack keeps its grid focused.')

  // 7. The Messages strip opens by itself beside the two rows of tabs when an error arrives and the pane has room.
  await run('-- varia-fake: sets=N1*3,W1*2000 messages=2 errors=1')
  await expect(resultTabs(page).getByRole('tab')).toHaveText(['Result 1', 'Result 2'])
  await expect(messagesStrip(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(resultTabPanel(page)).toBeVisible()
  console.log('Grouped results checks: the Messages strip opens beside the tabs when the pane fits both rows, a grid and the strip.')

  // 8. The palette's Show Results as Tabs from a grid switches the layout, and the grid of the same view takes the focus
  // back; then Stacked again from the editor: every grid is drawn, nothing was rebuilt.
  await resultTab(page, 'Result 1').click()
  await gridCell(resultGrid(page, 'Result 1'), 1, 0).click()
  await expect(resultGrid(page, 'Result 1')).toBeFocused()
  await toggleFromPalette()
  await expect(page.locator(part.resultStack)).toHaveCount(1)
  await expect(resultGrid(page, 'Result 1')).toBeFocused()
  await toggleFromPalette()
  await expect(resultTabs(page)).toHaveCount(1)
  await expect(resultGrid(page, 'Result 1')).toBeFocused()
  await textbox().focus()
  await toggleFromPalette()
  await expect(page.locator(part.resultStack)).toHaveCount(1)
  await expect(resultTabs(page)).toHaveCount(0)
  await expect(anyResultGrid(page)).toHaveCount(2)
  await expect(show('Tabs')).toHaveAttribute('aria-pressed', 'false')
  expect(failures).toEqual([])
  console.log('Grouped results checks passed: tabs and view tabs with one grid, state kept across switches, Find Next across tabs, closing with focus, the Messages strip, a row too long to fit, switching from a grid with its focus kept and Stacked again.')
} catch (error) {
  await page.screenshot({ path: resolve('artifacts', 'grouped-results-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await application.close().catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
