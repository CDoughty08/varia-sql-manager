// BigQuery's Object Explorer end to end against the loopback REST fake (scripts/fixtures/bigquery-rest.mjs with `objects`,
// as VARIA_TEST_BIGQUERY_ENDPOINT: emulator mode, so no Google project or credential is involved) through the Release
// backend: the connection lists its billing project, the dataset its folders and their objects from the free REST
// listers, a table's Columns expand a STRUCT to its fields, Preview Rows reads a table's rows with tabledata.list and no
// job, a view's menu leaves Preview Rows out, Script View as › SELECT To writes the template locally, and Properties shows
// a table's facts from tables.get (docs/bigquery.md, Object Explorer). No assertion depends on absolute pixel sizes.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { startBigQueryRest } from './fixtures/bigquery-rest.mjs'
import { chooseExplorerMenuItem, expandExplorerPath, explorerMenuItems, explorerRow } from './fixtures/explorer-tree.mjs'
import { backendReady, connectDialogWindow, documentFrame, editorText, gridCell, outputStatus, resultGrid, submitConnect, toolbarButton } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'bigquery-explorer-profile-'))
const fake = await startBigQueryRest({ rows: 10, objects: true })
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BIGQUERY_ENDPOINT: fake.endpoint }
delete env.ELECTRON_RUN_AS_NODE
delete env.VARIA_TEST_BACKEND
delete env.VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT
const application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error('BigQuery Explorer suite exceeded its time limit.'); application.process()?.kill(); process.exit(1) }, 300_000)
const page = await application.firstWindow()
page.setDefaultTimeout(30000)
const failures = []
page.on('pageerror', error => failures.push(error.message))
const { project, dataset } = fake
const datasetPath = [project, project, dataset]
// Monaco draws spaces as no-break spaces.
const queryText = async () => (await editorText(page)).replaceAll(String.fromCharCode(0xa0), ' ')

try {
  await expect(backendReady(page)).toBeVisible({ timeout: 30000 })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
  // Query tabs opened here are unsaved at quit: Don't Save.
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await toolbarButton(page, 'Connect').click()
  const { window: connectWindow, dialog: connect } = await connectDialogWindow(application)
  const bigQueryType = connect.getByRole('group', { name: 'Server type', exact: true }).getByRole('button', { name: 'BigQuery', exact: true })
  await bigQueryType.click()
  await expect(connect.getByText(/^Emulator account /)).toBeVisible({ timeout: 20000 })
  await connect.getByLabel('Project', { exact: true }).fill(project)
  await connect.getByLabel('Default dataset', { exact: true }).fill(dataset)
  await submitConnect(connectWindow, connect, { timeout: 30000 })

  // The connection lists its billing project, the project its dataset, the dataset its six folders and their objects.
  await expandExplorerPath(page, ...datasetPath)
  for (const folder of ['Tables', 'Views', 'Materialized Views', 'External Tables', 'Routines', 'Models']) await explorerRow(page, ...datasetPath, folder)
  await expandExplorerPath(page, ...datasetPath, 'Tables')
  await explorerRow(page, ...datasetPath, 'Tables', 'orders')
  await expandExplorerPath(page, ...datasetPath, 'Views')
  await explorerRow(page, ...datasetPath, 'Views', 'daily')
  await expandExplorerPath(page, ...datasetPath, 'Routines')
  await explorerRow(page, ...datasetPath, 'Routines', 'to_cents')
  await expandExplorerPath(page, ...datasetPath, 'Models')
  await explorerRow(page, ...datasetPath, 'Models', 'churn')
  console.log('BigQuery Explorer checks: the project, dataset, folders, tables, views, routines and models list from the REST listers.')

  // Columns from tables.get's schema; a STRUCT column expands to its fields.
  await expandExplorerPath(page, ...datasetPath, 'Tables', 'orders', 'Columns', 'address')
  await explorerRow(page, ...datasetPath, 'Tables', 'orders', 'Columns', 'id')
  await explorerRow(page, ...datasetPath, 'Tables', 'orders', 'Columns', 'address', 'city')
  console.log('BigQuery Explorer checks: a table\'s Columns come from its schema and a STRUCT expands to its fields.')

  // Preview Rows: a new query tab with the SELECT it stands for, filled from tabledata.list, with no job.
  const tableRow = [...datasetPath, 'Tables', 'orders']
  await chooseExplorerMenuItem(page, tableRow, 'Preview Rows')
  await expect.poll(queryText, { timeout: 30000 }).toContain('LIMIT 1000')
  const preview = resultGrid(page, 'Result 1')
  await expect(gridCell(preview, 0, 1)).toHaveText('Ada', { timeout: 30000 })
  await expect(gridCell(preview, 2, 1)).toHaveText('Edsger')
  await expect(outputStatus(page)).toContainText(/^Completed · /)
  expect(fake.inserted).toEqual([])
  expect(fake.reads.some(read => read.table === 'orders')).toBe(true)
  console.log('BigQuery Explorer checks: Preview Rows reads a table\'s rows with tabledata.list, free and with no job.')

  // A view has no stored rows to list: its menu leaves Preview Rows out and offers Script View as instead.
  const viewRow = [...datasetPath, 'Views', 'daily']
  const viewItems = await explorerMenuItems(page, ...viewRow)
  expect(viewItems.names).not.toContain('Preview Rows')
  expect(viewItems.names).toContain('Script View as')
  await page.keyboard.press('Escape')
  await chooseExplorerMenuItem(page, viewRow, ['Script View as', 'SELECT To', 'New Query Editor Window'])
  await expect.poll(queryText, { timeout: 30000 }).toContain(`\`${project}\`.\`${dataset}\`.\`daily\``)
  expect(fake.inserted).toEqual([])
  console.log('BigQuery Explorer checks: a view\'s menu has no Preview Rows, and Script View as › SELECT To writes its template with no job.')

  // Properties: the table's facts from tables.get in a document of its own.
  await chooseExplorerMenuItem(page, tableRow, 'Properties')
  const properties = documentFrame(page, 'orders').getByRole('region', { name: 'Properties', exact: true })
  await expect(properties).toContainText('customer', { timeout: 30000 })
  await expect(properties).toContainText(/DAY/)
  expect(fake.inserted).toEqual([])
  expect(failures).toEqual([])
  expect(fake.unanswered).toEqual([])
  console.log('BigQuery Explorer checks passed: browsing, Columns and STRUCT fields, Preview Rows, a view\'s menu, Script As and Properties.')
} catch (error) {
  await page.screenshot({ path: resolve('artifacts', 'bigquery-explorer-failure.png') }).catch(() => {})
  console.error('Unanswered fake requests: ' + fake.unanswered.join(', '))
  throw error
} finally {
  clearTimeout(watchdog)
  await application.close().catch(() => {})
  await fake.close().catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
