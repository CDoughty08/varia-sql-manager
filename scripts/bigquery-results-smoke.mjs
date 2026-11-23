// A windowed BigQuery result against a loopback REST fake (scripts/fixtures/bigquery-rest.mjs, as
// VARIA_TEST_BIGQUERY_ENDPOINT: emulator mode, so no Google project or credential is involved) through the Release
// backend: Load Sample… from the results toolbar's ⋯ menu, its first rows (free, no job) and a random sample (a
// TABLESAMPLE job), each a new result named for what it holds; then the result's table expiring, its strip offering
// Re-run…, and Re-run running the result's own statement and replacing it where it is (docs/bigquery.md, Load a sample,
// Expiry). No assertion depends on absolute pixel sizes.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startBigQueryRest } from './fixtures/bigquery-rest.mjs'
import { enlargeOutput } from './fixtures/results-pane.mjs'
import { backendReady, editorTextbox, gridCell, gridPart, moreResultsTools, outputStatus, resultGrid, resultsToolsMenu, toolbarButton } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'bigquery-results-profile-'))
// Stacked, so each result is found by its caption; every result windowed, whatever its size.
await writeFile(join(profile, 'settings.json'), JSON.stringify({ version: 1, values: { 'queryResults.grid.layout': 'stacked', 'queryResults.bigQuery.residence': 'windowed' } }))
const fake = await startBigQueryRest({ rows: 60_000, sampleRows: 400 })
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BIGQUERY_ENDPOINT: fake.endpoint }
delete env.ELECTRON_RUN_AS_NODE
delete env.VARIA_TEST_BACKEND
delete env.VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT
const application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error('BigQuery results suite exceeded its time limit.'); application.process()?.kill(); process.exit(1) }, 300_000)
const page = await application.firstWindow()
page.setDefaultTimeout(30000)
const failures = []
page.on('pageerror', error => failures.push(error.message))

const status = () => outputStatus(page)
const strip = name => resultGrid(page, name).locator('xpath=..').locator(gridPart.strip)
const sampleDialog = () => page.getByRole('dialog', { name: 'Load Sample', exact: true })
/** Opens Load Sample… from the results toolbar's ⋯ menu for the grid that has the focus. */
async function openSample(name) {
  await gridCell(resultGrid(page, name), 0, 0).click()
  await moreResultsTools(page).click()
  await resultsToolsMenu(page).getByRole('menuitem', { name: 'Load Sample…', exact: true }).click()
  await expect(sampleDialog()).toBeVisible()
  return sampleDialog()
}

try {
  await expect(backendReady(page)).toBeVisible({ timeout: 30000 })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
  // The query tab's text is unsaved at quit: Don't Save.
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await toolbarButton(page, 'Connect').click()
  const connect = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(page.getByText('Loading saved connections…')).toHaveCount(0)
  await connect.getByLabel('Server type', { exact: true }).selectOption('bigquery')
  await expect(connect.getByText(/^Emulator account /)).toBeVisible({ timeout: 20000 })
  await connect.getByLabel('Project', { exact: true }).fill(fake.project)
  await connect.getByLabel('Default dataset', { exact: true }).fill(fake.dataset)
  await connect.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(connect).toHaveCount(0, { timeout: 30000 })
  await toolbarButton(page, 'New query').click()
  await editorTextbox(page).focus()
  await page.keyboard.insertText('SELECT n, s FROM t')
  await page.keyboard.press('F5')
  await expect(status()).toContainText(/^Completed · /, { timeout: 30000 })
  await enlargeOutput(page)
  const source = resultGrid(page, 'Result 1')
  await expect(gridCell(source, 0, 1)).toHaveText('row 0')
  await expect(strip('Result 1')).toContainText('windowed in BigQuery')
  const jobs = fake.inserted.length

  // The first rows: free, read with tabledata.list into a new result named for what it holds, with no job.
  let dialog = await openSample('Result 1')
  const rows = dialog.getByLabel('Rows', { exact: true })
  await expect(rows).toBeFocused()
  await expect(dialog.getByText('of 60,000', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('Sample', { exact: true })).toHaveValue('first')
  await rows.fill('1,000')
  await expect(dialog).toContainText('The first rows are free')
  await expect(dialog).toContainText('Creates “Sample: 1,000 of 60,000 rows”')
  await rows.fill('0')
  await expect(dialog.getByRole('button', { name: 'Load', exact: true })).toBeDisabled()
  await expect(dialog).toContainText('Enter a number from 1 to 60,000.')
  await rows.fill('1,000')
  await dialog.getByRole('button', { name: 'Load', exact: true }).click()
  await expect(sampleDialog()).toHaveCount(0)
  const first = resultGrid(page, 'Sample: 1,000 of 60,000 rows')
  await expect(first).toBeVisible({ timeout: 30000 })
  await expect(gridCell(first, 999, 0)).toHaveCount(0)
  await expect(gridCell(first, 0, 1)).toHaveText('row 0')
  expect(fake.inserted.length).toBe(jobs)
  console.log('BigQuery results checks: Load Sample… reads the first rows, free and with no job, into a new result named for what it holds.')

  // A random sample: estimated in the dialog (faked in emulator mode), then a TABLESAMPLE job over the result table.
  dialog = await openSample('Result 1')
  await dialog.getByLabel('Rows', { exact: true }).fill('1,000')
  await dialog.getByLabel('Sample', { exact: true }).selectOption('random')
  await expect(dialog).toContainText('The random sample processes about', { timeout: 20000 })
  await expect(dialog).toContainText('Creates a sample of up to 1,000 of 60,000 rows')
  await dialog.getByRole('button', { name: 'Load', exact: true }).click()
  const random = resultGrid(page, 'Sample: 400 of 60,000 rows')
  await expect(random).toBeVisible({ timeout: 30000 })
  expect(fake.inserted.length).toBe(jobs + 1)
  expect(fake.inserted.at(-1).query).toMatch(/^SELECT \* FROM `varia-emulator`\.`_anon_fake`\.`anon_\d+` TABLESAMPLE SYSTEM \(@percent PERCENT\) LIMIT @rows$/)
  expect(fake.inserted.at(-1).parameters.map(parameter => [parameter.name, parameter.parameterValue.value])).toEqual([['percent', '1.833334'], ['rows', '1000']])
  console.log('BigQuery results checks: a random sample is estimated in the dialog, runs TABLESAMPLE over the result table and opens as a sample.')

  // The result's table expires: rows not cached answer REMOTE_EXPIRED, and the strip offers Re-run…, which runs the
  // result's own statement and replaces it where it is.
  fake.expire(fake.tableOf('SELECT n, s FROM t'))
  await gridCell(source, 0, 0).click()
  await page.keyboard.press('Control+End')
  await expect(strip('Result 1')).toContainText('BigQuery no longer keeps this result', { timeout: 30000 })
  const rerun = strip('Result 1').getByRole('button', { name: 'Re-run…', exact: true })
  await rerun.click()
  await expect(strip('Result 1')).not.toContainText('BigQuery no longer keeps this result', { timeout: 30000 })
  expect(fake.inserted.length).toBe(jobs + 2)
  expect(fake.inserted.at(-1).query).toBe('SELECT n, s FROM t')
  await gridCell(resultGrid(page, 'Result 1'), 0, 0).click()
  await page.keyboard.press('Control+End')
  await expect(gridCell(resultGrid(page, 'Result 1'), 59_999, 1)).toHaveText('row 59999', { timeout: 30000 })
  // The samples stay, still named for what they hold.
  await expect(first).toBeVisible()
  await expect(random).toBeVisible()
  expect(failures).toEqual([])
  expect(fake.unanswered.filter(path => !/\/datasets\/_anon_fake\/tables\//.test(path))).toEqual([])
  console.log('BigQuery results checks passed: Load Sample… of the first rows and at random, and Re-run of an expired result in place.')
} catch (error) {
  await page.screenshot({ path: resolve('artifacts', 'bigquery-results-failure.png') }).catch(() => {})
  console.error('Unanswered fake requests: ' + fake.unanswered.join(', '))
  throw error
} finally {
  clearTimeout(watchdog)
  await application.close().catch(() => {})
  await fake.close().catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
