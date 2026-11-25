// A windowed BigQuery result against a loopback REST fake (scripts/fixtures/bigquery-rest.mjs, as
// VARIA_TEST_BIGQUERY_ENDPOINT: emulator mode, so no Google project or credential is involved) through the Release
// backend, under Always windowed: Load Sample… from the results toolbar's ⋯ menu, its first rows (free, no job) and a
// random sample (a TABLESAMPLE job), each a new result named for what it holds; then the result's table expiring, its strip
// offering Re-run…, and Re-run running the result's own statement and replacing it where it is (docs/bigquery.md, Load a
// sample, Expiry). On the re-run result, a jump to its end reads that block with tabledata.list (no job), Copy of a whole
// column reads its blocks, Save Results As streams every row to a file, and Load into memory reads it into memory in
// place; then Automatically, by size keeps the same query's small result in memory (docs/bigquery.md, Residence). No
// assertion depends on absolute pixel sizes.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startBigQueryRest } from './fixtures/bigquery-rest.mjs'
import { enlargeOutput } from './fixtures/results-pane.mjs'
import { backendReady, connectDialogWindow, editorTextbox, gridCell, gridPart, jobNotice, moreResultsTools, outputStatus, resultGrid, resultIdOf, resultsToolsMenu, submitConnect, toolbarButton } from './fixtures/ui.mjs'

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
/** The strip's text, or '' once the grid shows none (an in-memory result with nothing to say). */
const stripText = async name => await strip(name).count() ? await strip(name).innerText() : ''
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
  // Connect opens in its own window (or over the main one where it cannot).
  await toolbarButton(page, 'Connect').click()
  const { window: connectWindow, dialog: connect } = await connectDialogWindow(application)
  const bigQueryType = connect.getByRole('group', { name: 'Server type', exact: true }).getByRole('button', { name: 'BigQuery', exact: true })
  await bigQueryType.click()
  await expect(bigQueryType).toHaveAttribute('aria-pressed', 'true')
  await expect(connect.getByText(/^Emulator account /)).toBeVisible({ timeout: 20000 })
  await connect.getByLabel('Project', { exact: true }).fill(fake.project)
  await connect.getByLabel('Default dataset', { exact: true }).fill(fake.dataset)
  await submitConnect(connectWindow, connect, { timeout: 30000 })
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
  const before = await resultIdOf(resultGrid(page, 'Result 1'))
  const readsBeforeRerun = fake.reads.length
  await rerun.click()
  // The strip says it runs again at once: wait for the new job and for the grid to show the new result.
  await expect.poll(() => fake.inserted.length, { timeout: 30000 }).toBe(jobs + 2)
  expect(fake.inserted.at(-1).query).toBe('SELECT n, s FROM t')
  await expect.poll(() => resultIdOf(resultGrid(page, 'Result 1')), { timeout: 30000 }).not.toBe(before)
  await expect(strip('Result 1')).not.toContainText(/BigQuery no longer keeps this result|Running the query again/, { timeout: 30000 })
  await gridCell(resultGrid(page, 'Result 1'), 0, 0).click()
  await page.keyboard.press('Control+End')
  await expect(gridCell(resultGrid(page, 'Result 1'), 59_999, 1)).toHaveText('row 59999', { timeout: 30000 })
  // The samples stay, still named for what they hold.
  await expect(first).toBeVisible()
  await expect(random).toBeVisible()

  const rerunGrid = resultGrid(page, 'Result 1')
  // Paging, on the re-run result (a new table): the grid reads blocks of the result table with tabledata.list as it
  // scrolls, never a job; the re-run check's jump to the end read the block that holds the last row, and the jumps here
  // home and back come from the block cache or read again. These phases cache every row, so they come after
  // the expiry check, which needs rows not cached. The re-run check left the grid at its last row.
  await gridCell(rerunGrid, 59_999, 0).click()
  await page.keyboard.press('Control+Home')
  await expect(gridCell(rerunGrid, 0, 1)).toHaveText('row 0', { timeout: 30000 })
  await page.keyboard.press('Control+End')
  await expect(gridCell(rerunGrid, 59_999, 1)).toHaveText('row 59999', { timeout: 30000 })
  const table = fake.tableOf('SELECT n, s FROM t')
  const rerunReads = fake.reads.slice(readsBeforeRerun).filter(read => read.table === table)
  expect(rerunReads.some(read => read.start > 50_000)).toBe(true)
  await page.keyboard.press('Control+Home')
  await expect(gridCell(rerunGrid, 0, 1)).toHaveText('row 0')
  console.log('BigQuery results checks: a windowed result reads its blocks with tabledata.list as the grid scrolls and jumps.')

  // Copy of a whole column reads every block it spans, in order, under the Copy limit.
  await application.evaluate(({ clipboard }) => clipboard.writeText('before'))
  await gridCell(rerunGrid, 0, 1).click()
  await page.keyboard.press('Control+Shift+End')
  await page.keyboard.press('Control+C')
  const clipboardLines = async () => (await application.evaluate(({ clipboard }) => clipboard.readText())).split(/\r?\n/)
  await expect.poll(async () => (await clipboardLines()).length, { timeout: 30000 }).toBe(60_000)
  const copied = await clipboardLines()
  expect([copied[0], copied[12_345], copied[59_999]]).toEqual(['row 0', 'row 12345', 'row 59999'])
  console.log('BigQuery results checks: Copy of a windowed column reads its 60,000 rows block by block.')

  // Save Results As streams every row from BigQuery to the file, past the block cache, with no job.
  const saved = join(profile, 'windowed.txt')
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, saved)
  // The copy left the grid at its last row.
  await page.keyboard.press('Control+Home')
  await gridCell(rerunGrid, 0, 0).click()
  await page.keyboard.press('Control+S')
  await expect(jobNotice(page)).toHaveText('Saved 60,000 rows to windowed.txt.', { timeout: 30000 })
  const lines = (await readFile(saved, 'utf8')).replace(/^\uFEFF/, '').split('\r\n')
  expect([lines[0], lines[1], lines[60_000], lines.length]).toEqual(['n\ts', '0\trow 0', '59999\trow 59999', 60_002])
  expect(fake.inserted.length).toBe(jobs + 2)
  console.log('BigQuery results checks: Save Results As streams all 60,000 rows of a windowed result to the file.')

  // Load into memory: the strip offers it while the result fits the result memory free; it reads the whole table into
  // memory in place, with no job, and the result is no longer windowed.
  const loaded = jobs + 2
  const pagesBefore = fake.results.length
  await strip('Result 1').getByRole('button', { name: 'Load into memory', exact: true }).click()
  // The load reads the job's rows again from the first, with jobs.getQueryResults, past the block cache.
  await expect.poll(() => fake.results.slice(pagesBefore).some(read => read.table === table && read.start === 0), { timeout: 60000 }).toBe(true)
  await expect.poll(() => stripText('Result 1'), { timeout: 60000 }).not.toMatch(/windowed in BigQuery|Loading into memory/)
  await gridCell(resultGrid(page, 'Result 1'), 0, 0).click()
  await page.keyboard.press('Control+End')
  await expect(gridCell(resultGrid(page, 'Result 1'), 59_999, 1)).toHaveText('row 59999', { timeout: 30000 })
  expect(await stripText('Result 1')).not.toMatch(/windowed in BigQuery/)
  expect(fake.inserted.length).toBe(loaded)
  console.log('BigQuery results checks: Load into memory reads a windowed result into memory in place, with no job.')

  // Automatically, by size: the same query's 60,000 short rows fit half the room the query may take, so they stay in memory.
  expect((await page.evaluate(() => window.varia.updateSettings({ 'queryResults.bigQuery.residence': 'automatic' }))).ok).toBe(true)
  const loadedId = await resultIdOf(resultGrid(page, 'Result 1'))
  await editorTextbox(page).focus()
  await page.keyboard.press('F5')
  await expect.poll(() => fake.inserted.length, { timeout: 30000 }).toBe(loaded + 1)
  // The new run replaces the loaded result: wait for the new one before asserting on it.
  await expect.poll(() => resultIdOf(resultGrid(page, 'Result 1')), { timeout: 30000 }).not.toBe(loadedId)
  await expect(status()).toContainText(/^Completed · /, { timeout: 30000 })
  const automatic = fake.tableOf('SELECT n, s FROM t')
  await gridCell(resultGrid(page, 'Result 1'), 0, 0).click()
  await page.keyboard.press('Control+End')
  await expect(gridCell(resultGrid(page, 'Result 1'), 59_999, 1)).toHaveText('row 59999', { timeout: 30000 })
  // In memory, the whole result came with the query's own pages: the grid read nothing of its table with tabledata.list.
  expect(fake.reads.filter(read => read.table === automatic)).toEqual([])
  expect(await stripText('Result 1')).not.toContain('windowed in BigQuery')
  console.log('BigQuery results checks: Automatically, by size keeps a result that fits in memory.')
  expect(failures).toEqual([])
  expect(fake.unanswered.filter(path => !/\/datasets\/_anon_fake\/tables\//.test(path))).toEqual([])
  console.log('BigQuery results checks passed: paging, Copy and Save over a windowed result, Load Sample… of the first rows and at random, Re-run of an expired result in place, Load into memory and the automatic residence.')
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
