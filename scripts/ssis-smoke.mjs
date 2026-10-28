import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expandExplorerPath, explorerRow, explorerTree } from './fixtures/explorer-tree.mjs'
import { closeDocumentButton, documentCrumbs, documentFactValues, documentFrame, documentHeader, documentNotice, documentStaleBadge, documentStatePill, documentSubtitle, documentTab, documentTabs, frameSection, menuItemNames, part, quickInputRows, sectionColumn, sectionList, toolbarButton } from './fixtures/ui.mjs'

// The SSIS Catalog's properties documents against the fake backend (tests/fixtures/backend.mjs, workbench mode), through
// main's real schemas: Properties from a node's menu, the palette, Enter and a double-click; the sections and their list,
// which each tab keeps across switches, list and content; Refresh with F5; Close cancelling a read in flight; a failed read
// and Retry, with the header the same height in every state; an object deleted elsewhere.
await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'ssis-profile-'))
const control = await mkdtemp(resolve('artifacts', 'ssis-control-'))
await mkdir(join(control, 'hold'))
await mkdir(join(control, 'ssis'))
const lines = async name => (await readFile(join(control, name), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const describes = async () => (await lines('calls.jsonl')).filter(call => call.method === 'ssis.describe').map(call => call.params)
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('SSIS suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 240000)

const fast = { force: true }
const catalog = ['server-a', 'Integration Services Catalogs', 'SSISDB']
const finance = [...catalog, 'Finance']
const tabs = () => documentTabs(page).getByRole('tab')
const tab = name => documentTab(page, name)
/** The open document's frame: a region named by the object's name. */
const frame = title => documentFrame(page, title)
const sections = title => sectionList(frame(title))
/** Whether a section's heading shows inside the scrolled content column, and how far the column is scrolled. */
const headingShown = (title, section) => sectionColumn(frame(title), title).evaluate((column, id) => {
  const heading = column.querySelector(`section[data-section="${id}"] h2`)
  const view = column.getBoundingClientRect(), box = heading?.getBoundingClientRect()
  return { shown: !!box && box.top >= view.top - 1 && box.bottom <= view.bottom + 1, scrolled: column.scrollTop > 0 }
}, section)
/** The header row's height: the same whichever state it shows (F9a keeps the header one row tall). */
const headerHeight = title => documentHeader(frame(title)).evaluate(header => header.getBoundingClientRect().height)
const objectMenu = () => page.getByRole('menu', { name: 'Object Explorer', exact: true })

async function connect(server) {
  await toolbarButton(page, 'Connect').click()
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await dialog.getByLabel('Server Name', { exact: true }).fill(server)
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(await explorerRow(page, server)).toBeVisible()
}
/** The row's menu: its items' labels, and a click on one. */
async function menuOn(path, item) {
  await (await explorerRow(page, ...path)).click({ button: 'right', force: true })
  await expect(objectMenu()).toBeVisible()
  const labels = await menuItemNames(objectMenu())
  if (item) await objectMenu().getByRole('menuitem', { name: item, exact: true }).click(fast)
  return labels
}
/** A General fact by its label. */
const fact = (title, label) => frameSection(frame(title), 'General').locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd')

try {
  application = await electron.launch(launchOptions)
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
  await connect('server-a')
  await expandExplorerPath(page, ...finance, 'Projects', 'Loads', 'Packages')
  await expandExplorerPath(page, ...finance, 'Environments')
  await expect(explorerTree(page)).toHaveAttribute('aria-busy', 'false')

  // 1. A folder's menu has one Properties (Object Explorer's own is not offered), which opens Folder Properties at once.
  const before = await tabs().count()
  const items = await menuOn(finance, 'Properties')
  expect(items.filter(label => label === 'Properties')).toHaveLength(1)
  await expect(tab('Folder Properties - Finance')).toHaveAttribute('aria-selected', 'true')
  await expect(tabs()).toHaveCount(before + 1)
  await expect(page.locator(part.editorPane)).toBeHidden()
  await expect(frame('Finance').getByRole('heading', { level: 1 })).toHaveText('Finance')
  await expect(documentSubtitle(frame('Finance'))).toHaveText('Folder Properties')
  await expect(documentCrumbs(frame('Finance'))).toHaveText(['server-a', 'Integration Services Catalogs', 'SSISDB'])
  await expect(documentStaleBadge(frame('Finance'))).toHaveText(/^Updated /)
  await expect(fact('Finance', 'Description')).toHaveText('Nightly finance loads')
  await expect(fact('Finance', 'Created by')).toHaveText('CONTOSO\\etl')
  // The catalog's own offset, never the local clock.
  await expect(fact('Finance', 'Created')).toHaveText('2026-10-21 14:05:06 +02:00')
  // One section, so no section list.
  await expect(sections('Finance')).toHaveCount(0)
  expect((await describes()).at(-1)).toMatchObject({ view: 'folder', target: { kind: 'ssisFolder', name: 'Finance' } })
  // Focus moved to the document (its Refresh button), off the menu and the tree.
  await expect(frame('Finance').getByRole('button', { name: 'Refresh', exact: true })).toBeFocused()
  console.log('SSIS checks: a folder\'s Properties opens Folder Properties as a tab with its facts in the catalog\'s offset.')

  // 2. The palette opens a project's: four sections with their list, lists with counts, and sensitive values masked.
  await (await explorerRow(page, ...finance, 'Projects', 'Loads')).click()
  await page.keyboard.press('F1')
  await page.keyboard.type('Integration Services: Project Properties')
  await expect(quickInputRows(page).first()).toContainText('Project Properties')
  await page.keyboard.press('Enter')
  await expect(tab('Project Properties - Loads')).toHaveAttribute('aria-selected', 'true')
  const loads = frame('Loads')
  await expect(sections('Loads').getByRole('button')).toHaveText(['General', 'Packages', 'Parameters', 'References'])
  await expect(sections('Loads').getByRole('button', { name: 'General', exact: true })).toBeFocused()
  await expect(documentFactValues(loads)).toHaveText(['Finance', '2026-10-21 14:05:06 +02:00', 'Not validated'])
  const parameters = loads.getByRole('table', { name: 'Parameters', exact: true })
  await expect(parameters.locator('tbody tr')).toHaveCount(3)
  await expect(parameters.locator('tbody tr').nth(0).locator('td')).toHaveText(['Server', 'String', 'sql01', 'Literal', 'Yes', 'No', '—'])
  await expect(parameters.locator('tbody tr').nth(1).locator('td').nth(2)).toHaveText('********')
  await expect(parameters.locator('tbody tr').nth(2).locator('td').nth(3)).toHaveText('Environment variable')
  await expect(loads.getByRole('table', { name: 'References', exact: true }).locator('tbody td')).toHaveText(['Test', '.', 'Relative', 'Not validated'])
  // The count follows the title inside the heading, and says what it counts: the section is "Packages (2 packages)".
  await expect(frameSection(loads, 'Packages (2 packages)').getByRole('heading', { level: 2 })).toHaveText('Packages2 (2 packages)')
  // Down in the list moves to the next section; References from the list stays current.
  await page.keyboard.press('ArrowDown')
  await expect(sections('Loads').getByRole('button', { name: 'Packages', exact: true })).toHaveAttribute('aria-current', 'location')
  await sections('Loads').getByRole('button', { name: 'References', exact: true }).click()
  await expect(sections('Loads').getByRole('button', { name: 'References', exact: true })).toHaveAttribute('aria-current', 'location')
  await expect.poll(() => headingShown('Loads', 'references')).toEqual({ shown: true, scrolled: true })
  await page.screenshot({ path: resolve('artifacts', 'ssis-project-dark.png') })
  console.log('SSIS checks: the palette opens Project Properties with its sections, counts, masked sensitive values and references.')

  // 3. Enter on a package and a double-click on an environment open their Properties, as in SSMS.
  await (await explorerRow(page, ...finance, 'Projects', 'Loads', 'Packages', 'Daily.dtsx')).click()
  await page.keyboard.press('Enter')
  await expect(tab('Package Properties - Daily.dtsx')).toHaveAttribute('aria-selected', 'true')
  await expect(fact('Daily.dtsx', 'Entry point')).toHaveText('Yes')
  await expect(fact('Daily.dtsx', 'Version comments')).toHaveText('Adds the ledger step')
  await expect(documentCrumbs(frame('Daily.dtsx'))).toHaveText(['server-a', 'Integration Services Catalogs', 'SSISDB', 'Finance', 'Loads'])
  await (await explorerRow(page, ...finance, 'Environments', 'Test')).dblclick()
  await expect(tab('Environment Properties - Test')).toHaveAttribute('aria-selected', 'true')
  const variables = frame('Test').getByRole('table', { name: 'Variables', exact: true })
  await expect(variables.locator('tbody tr').nth(1).locator('td')).toHaveText(['Secret', 'String', '********', 'Yes', 'Never read'])
  console.log('SSIS checks: Enter on a package and a double-click on an environment open their Properties.')

  // 4. Each tab keeps its section across switches; opening the folder again shows its tab and reads it again.
  await tab('Project Properties - Loads').click()
  await expect(sections('Loads').getByRole('button', { name: 'References', exact: true })).toHaveAttribute('aria-current', 'location')
  // The content comes back on that section too, not on General from the top.
  await expect.poll(() => headingShown('Loads', 'references')).toEqual({ shown: true, scrolled: true })
  const count = await tabs().count(), reads = (await describes()).length
  await menuOn(finance, 'Properties')
  await expect(tab('Folder Properties - Finance')).toHaveAttribute('aria-selected', 'true')
  await expect(tabs()).toHaveCount(count)
  await expect.poll(async () => (await describes()).length).toBe(reads + 1)
  console.log('SSIS checks: each tab keeps its section across switches, and Properties again shows the open tab and reads it again.')

  // 5. F5 in the document refreshes it (and runs no query); the model stays while the read is held, and Close cancels it.
  await frameSection(frame('Finance'), 'General').click()
  const fresh = await headerHeight('Finance')
  await writeFile(join(control, 'hold', 'ssis.describe'), '')
  await page.keyboard.press('F5')
  await expect(documentStatePill(frame('Finance'))).toHaveText('Refreshing')
  expect(await headerHeight('Finance')).toBe(fresh)
  await expect(fact('Finance', 'Description')).toHaveText('Nightly finance loads')
  expect((await lines('calls.jsonl')).some(call => call.method === 'query.execute')).toBe(false)
  await closeDocumentButton(page, 'Folder Properties - Finance').click()
  await expect(tab('Folder Properties - Finance')).toHaveCount(0)
  await expect.poll(async () => (await lines('cancels.jsonl')).filter(line => line.method === 'ssis.describe').length).toBe(1)
  await rm(join(control, 'hold', 'ssis.describe'))
  console.log('SSIS checks: F5 refreshes the document and keeps its model while it reads; closing it cancels the read.')

  // 6. A read that fails keeps the last model under the failure, the header says since when it is stale (without growing),
  // and Retry reads it again.
  await tab('Package Properties - Daily.dtsx').click()
  await expect(documentStaleBadge(frame('Daily.dtsx'))).toHaveText(/^Updated /)
  const daily = await headerHeight('Daily.dtsx')
  await writeFile(join(control, 'ssis', 'fail'), '')
  await frame('Daily.dtsx').getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(documentStaleBadge(frame('Daily.dtsx'))).toHaveAttribute('data-stale', '')
  await expect(documentStaleBadge(frame('Daily.dtsx'))).toHaveText(/^Stale since /)
  await expect(documentNotice(frame('Daily.dtsx')).getByRole('alert')).toHaveText('The SSIS Catalog did not answer in time.')
  await expect(fact('Daily.dtsx', 'Version')).toHaveText('1.0.7')
  expect(await headerHeight('Daily.dtsx')).toBe(daily)
  await rm(join(control, 'ssis', 'fail'))
  await documentNotice(frame('Daily.dtsx')).getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(documentNotice(frame('Daily.dtsx'))).toHaveCount(0)
  await expect(documentStaleBadge(frame('Daily.dtsx'))).not.toHaveAttribute('data-stale', '')
  console.log('SSIS checks: a failed read keeps the model, marks the header stale at the same height, and Retry reads it again.')

  // 7. An object deleted elsewhere: Refresh says so over the last model, and Close is the way out.
  await writeFile(join(control, 'ssis', 'missing'), '')
  await frame('Daily.dtsx').getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(documentStatePill(frame('Daily.dtsx'))).toHaveText('Not found')
  const notice = documentNotice(frame('Daily.dtsx'))
  await expect(notice.getByRole('alert')).toHaveText('The package Daily.dtsx no longer exists in the SSIS Catalog.')
  await expect(fact('Daily.dtsx', 'Version')).toHaveText('1.0.7')
  expect(await headerHeight('Daily.dtsx')).toBe(daily)
  await rm(join(control, 'ssis', 'missing'))
  await notice.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(tab('Package Properties - Daily.dtsx')).toHaveCount(0)
  console.log('SSIS checks: an object deleted elsewhere says so over the last model, and Close closes it.')

  // 8. Light theme, and still no page-wide horizontal scroll.
  await tab('Project Properties - Loads').click()
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'light' }))
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe('light')
  await page.screenshot({ path: resolve('artifacts', 'ssis-project-light.png') })
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'dark' }))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

  expect(failures).toEqual([])
  console.log('SSIS checks passed: Properties from the menu, the palette, Enter and a double-click; sections, facts and lists; tab state; F5; Close cancelling a read; a failed read and Retry; a deleted object; Dark and Light (artifacts/ssis-project-dark.png, ssis-project-light.png).')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'ssis-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
  await rm(control, { recursive: true, force: true })
}
