import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expandExplorerPath, explorerRow, explorerTree } from './fixtures/explorer-tree.mjs'
import { resizeContent } from './fixtures/window-resize.mjs'
import { backendReady, closeDocumentButton, connectDialogWindow, documentCrumbs, documentFactValues, documentFrame, documentHeader, documentBanner, documentStaleBadge, documentState, documentSubtitle, documentTab, documentTabs, frameSection, gridCell, gridPart, localGrid, localGridFrame, menuItemNames, part, quickInputRows, sectionColumn, sectionList, selectOpenDocument, submitConnect, toolbarButton } from './fixtures/ui.mjs'
import { parseCalls } from './fixtures/call-log.mjs'

// The SSIS Catalog's properties documents against the fake backend (tests/fixtures/backend.mjs, workbench mode), through
// main's real schemas: Properties from a node's menu, the palette, Enter and a double-click; the sections and their list,
// which each tab keeps across switches, list and content; Refresh with F5; Close cancelling a read in flight; a failed read
// and Retry from the keyboard, with focus kept in the document and the header the same height in every state; the lists
// as page grids (LocalGrid) whose Copy and Save write a sensitive value masked; lists at the 2,048-row cap; an object
// deleted elsewhere.
await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'ssis-profile-'))
const control = await mkdtemp(resolve('artifacts', 'ssis-control-'))
await mkdir(join(control, 'hold'))
await mkdir(join(control, 'ssis'))
const saveDir = await mkdtemp(resolve('artifacts', 'ssis-save-'))
const eol = process.platform === 'win32' ? '\r\n' : '\n'
const lines = async name => parseCalls(await readFile(join(control, name), 'utf8').catch(() => ''))
const describes = async () => (await lines('calls.jsonl')).filter(call => call.method === 'ssis.describe').map(call => call.params)
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('SSIS suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 240000)

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
  const { window: connectWin, dialog } = await connectDialogWindow(application)
  await dialog.getByLabel('Server Name', { exact: true }).fill(server)
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await submitConnect(connectWin, dialog)
  await expect(await explorerRow(page, server)).toBeVisible()
}
/** The row's menu: its items' labels, and a click on one. */
async function menuOn(path, item) {
  await (await explorerRow(page, ...path)).click({ button: 'right', force: true })
  await expect(objectMenu()).toBeVisible()
  const labels = await menuItemNames(objectMenu())
  if (item) await objectMenu().getByRole('menuitem', { name: item, exact: true }).click()
  return labels
}
/** Whether focus is inside the document's frame. */
const focusIn = title => frame(title).evaluate(element => element.contains(document.activeElement))
/** Rows a document draws (its grids draw only those near the view), and every element in it. */
const drawn = title => frame(title).evaluate(element => ({ rows: element.querySelectorAll('[role="rowgroup"] > [role="row"]').length, nodes: element.querySelectorAll('*').length }))
/** A list's row as its cells show it. */
const rowText = async (grid, row, columns) => { const cells = []; for (let column = 0; column < columns; column++) cells.push(await gridCell(grid, row, column).textContent()); return cells }
const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText())
/** A list's grid frame (its strip, its box): one list of the name is open where this is used. */
const listFrame = name => localGridFrame(page, name)
/** Whether a list's row is wholly inside the part of its scroller that shows, above any scroll bar or strip. */
const rowShown = async (grid, name, row) => {
  const box = await gridCell(grid, row, 0).boundingBox()
  const view = await listFrame(name).locator(gridPart.scroller).evaluate(element => ({ top: element.getBoundingClientRect().top, height: element.clientHeight }))
  return !!box && box.y >= view.top - 0.5 && box.y + box.height <= view.top + view.height + 0.5
}
/** Runs a Query output menu item on a list's cell. */
const listMenu = async (grid, item) => {
  await gridCell(grid, 0, 0).click({ button: 'right' })
  await page.getByRole('menu', { name: 'Query output', exact: true }).getByRole('menuitem', { name: item, exact: true }).click()
}
/** A General fact by its label. */
const fact = (title, label) => frameSection(frame(title), 'General').locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd')

try {
  application = await electron.launch(launchOptions)
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page, 'fake')).toHaveText('Ready', { timeout: 30000 })
  await application.evaluate(({ dialog }) => {
    globalThis.variaSave = { paths: [], dialogs: [] }
    dialog.showSaveDialog = async (_window, options) => {
      globalThis.variaSave.dialogs.push(options)
      const filePath = globalThis.variaSave.paths.shift()
      return filePath ? { canceled: false, filePath } : { canceled: true }
    }
  })
  // A short window, as properties documents take the whole document area: Project Properties' sections then overflow
  // their column, so choosing one scrolls to it.
  await resizeContent(application, page, 1440, 700)
  await connect('server-a')
  await expandExplorerPath(page, ...finance, 'Projects', 'Loads', 'Packages')
  await expandExplorerPath(page, ...finance, 'Environments')
  await expect(explorerTree(page)).toHaveAttribute('aria-busy', 'false')

  // 1. A folder's menu has one Properties (Object Explorer's own is not offered), which opens Folder Properties at once,
  // reading; focus moves into it when that read ends, though it had nothing to focus while it read.
  const before = await tabs().count()
  await writeFile(join(control, 'hold', 'ssis.describe'), '')
  const items = await menuOn(finance, 'Properties')
  expect(items.filter(label => label === 'Properties')).toHaveLength(1)
  await expect(tab('Folder Properties - Finance')).toHaveAttribute('aria-selected', 'true')
  await expect(documentState(frame('Finance'))).toHaveText('Loading')
  // Long enough for the focus the open asked for (a frame, or 50 ms in a throttled window) to find nothing to focus.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)))
  expect(await focusIn('Finance')).toBe(false)
  await rm(join(control, 'hold', 'ssis.describe'))
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
  // Each list is a results grid (LocalGrid), named with its counts as a result's grid is.
  const parameters = localGrid(loads, 'Parameters')
  await expect(parameters).toHaveAttribute('aria-label', 'Parameters, 3 rows, 7 columns')
  await expect(parameters.locator(gridPart.columnHeader).filter({ visible: true })).toHaveText(['Name', 'Data type', 'Value', 'Source', 'Required', 'Sensitive', 'Description'])
  // An empty value is an empty cell; a sensitive one is stars.
  expect(await rowText(parameters, 0, 7)).toEqual(['Server', 'String', 'sql01', 'Literal', 'Yes', 'No', ''])
  expect(await rowText(parameters, 1, 7)).toEqual(['Password', 'String', '********', 'Literal', 'No', 'Yes', ''])
  await expect(gridCell(parameters, 2, 3)).toHaveText('Environment variable')
  expect(await rowText(localGrid(loads, 'References'), 0, 4)).toEqual(['Test', '.', 'Relative', 'Not validated'])
  // A short list is as tall as its rows: its last row is inside its frame, with no band of empty rows under it.
  await expect.poll(() => rowShown(parameters, 'Parameters', 2)).toBe(true)
  expect(await listFrame('Parameters').evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(160)
  // A list narrower than its section has no room kept for a horizontal scroll bar: its header, two rows and its border.
  // Polled until two reads agree: the grid says whether it is wide on its first frame.
  const packagesHeight = () => listFrame('Packages').evaluate(element => element.getBoundingClientRect().height)
  await expect.poll(async () => { const height = await packagesHeight(); await page.evaluate(() => new Promise(requestAnimationFrame)); return height === await packagesHeight() && height }).toBeLessThanOrEqual(22 + 2 * 20 + 4)
  // Copy writes what the cell shows: the stars, never a value. Copy with Headers of every row does too.
  await gridCell(parameters, 1, 2).click()
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe('********')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Control+Shift+C')
  await expect.poll(clipboard).toBe([['Name', 'Data type', 'Value', 'Source', 'Required', 'Sensitive', 'Description'], ['Server', 'String', 'sql01', 'Literal', 'Yes', 'No', ''],
    ['Password', 'String', '********', 'Literal', 'No', 'Yes', ''], ['Port', 'Int32', 'Port', 'Environment variable', 'No', 'No', '']].map(row => row.join('\t')).join(eol))
  // Save Results As (Ctrl+S) writes the same text through main's dialog, named for the project and the list.
  await application.evaluate((_, value) => { globalThis.variaSave.paths.push(value) }, join(saveDir, 'parameters.csv'))
  await page.keyboard.press('Control+S')
  await expect(listFrame('Parameters').locator(gridPart.strip)).toHaveText('Saved 3 rows to parameters.csv.')
  // The list grows to make room for its strip: every row still shows.
  await expect.poll(() => rowShown(parameters, 'Parameters', 2)).toBe(true)
  expect(await application.evaluate(() => globalThis.variaSave.dialogs.at(-1))).toMatchObject({ title: 'Save Grid Results', defaultPath: expect.stringMatching(/Loads-Parameters\.csv$/) })
  const saved = await readFile(join(saveDir, 'parameters.csv'), 'utf8')
  // An empty value is an empty string (""), as a result's is; an empty field would be NULL.
  // Saves have column headers by default (Include column headers when saving the results).
  expect(saved).toBe('﻿' + ['Name,Data type,Value,Source,Required,Sensitive,Description', 'Server,String,sql01,Literal,Yes,No,""', 'Password,String,********,Literal,No,Yes,""', 'Port,Int32,Port,Environment variable,No,No,""'].map(line => line + '\r\n').join(''))
  // A header sorts the list, as in a results grid.
  await listMenu(parameters, 'Sort Descending')
  await expect(gridCell(parameters, 0, 0)).toHaveText('Server')
  await expect(gridCell(parameters, 2, 0)).toHaveText('Password')
  await sections('Loads').getByRole('button', { name: 'General', exact: true }).focus()
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
  const variables = localGrid(frame('Test'), 'Variables')
  expect(await rowText(variables, 1, 5)).toEqual(['Secret', 'String', '********', 'Yes', 'Never read'])
  await gridCell(variables, 1, 0).click()
  await gridCell(variables, 1, 4).click({ modifiers: ['Shift'] })
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe(['Secret', 'String', '********', 'Yes', 'Never read'].join('\t'))
  console.log('SSIS checks: Enter on a package and a double-click on an environment open their Properties.')

  // 4. Each tab keeps its section across switches, and its lists their sort; opening the folder again shows its tab and
  // reads it again.
  await selectOpenDocument(page, 'Project Properties - Loads')
  await expect(gridCell(parameters, 0, 0)).toHaveText('Server')
  await expect(parameters.getByRole('columnheader', { name: 'Name', exact: true })).toHaveAttribute('aria-sort', 'descending')
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
  await expect(documentState(frame('Finance'))).toHaveText('Refreshing')
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
  await selectOpenDocument(page, 'Package Properties - Daily.dtsx')
  await expect(documentStaleBadge(frame('Daily.dtsx'))).toHaveText(/^Updated /)
  const daily = await headerHeight('Daily.dtsx')
  await writeFile(join(control, 'ssis', 'fail'), '')
  await frame('Daily.dtsx').getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(documentStaleBadge(frame('Daily.dtsx'))).toHaveAttribute('data-stale', '')
  await expect(documentStaleBadge(frame('Daily.dtsx'))).toHaveText(/^Stale since /)
  await expect(documentBanner(frame('Daily.dtsx')).getByRole('alert')).toHaveText('The SSIS Catalog did not answer in time.')
  await expect(fact('Daily.dtsx', 'Version')).toHaveText('1.0.7')
  expect(await headerHeight('Daily.dtsx')).toBe(daily)
  // Retry from the keyboard keeps focus on Retry while it reads (disabled, not removed) and after it fails again.
  const retry = documentBanner(frame('Daily.dtsx')).getByRole('button', { name: 'Retry', exact: true })
  await retry.focus()
  await writeFile(join(control, 'hold', 'ssis.describe'), '')
  await page.keyboard.press('Enter')
  await expect(documentState(frame('Daily.dtsx'))).toHaveText('Refreshing')
  await expect(retry).toHaveAttribute('aria-disabled', 'true')
  await expect(retry).toBeFocused()
  await rm(join(control, 'hold', 'ssis.describe'))
  await expect(documentStaleBadge(frame('Daily.dtsx'))).toHaveText(/^Stale since /)
  await expect(retry).not.toHaveAttribute('aria-disabled', 'true')
  await expect(retry).toBeFocused()
  // A Retry that succeeds takes the notice away, and focus goes to the document's Refresh, not the page.
  await rm(join(control, 'ssis', 'fail'))
  await writeFile(join(control, 'hold', 'ssis.describe'), '')
  await page.keyboard.press('Enter')
  await expect(documentState(frame('Daily.dtsx'))).toHaveText('Refreshing')
  await expect(retry).toBeFocused()
  await rm(join(control, 'hold', 'ssis.describe'))
  await expect(documentBanner(frame('Daily.dtsx'))).toHaveCount(0)
  await expect(documentStaleBadge(frame('Daily.dtsx'))).not.toHaveAttribute('data-stale', '')
  await expect(frame('Daily.dtsx').getByRole('button', { name: 'Refresh', exact: true })).toBeFocused()
  expect(await focusIn('Daily.dtsx')).toBe(true)
  console.log('SSIS checks: a failed read keeps the model, marks the header stale at the same height, and Retry from the keyboard reads it again with focus kept in the document.')

  // 7. An object deleted elsewhere: Refresh says so over the last model, and Close is the way out.
  await writeFile(join(control, 'ssis', 'missing'), '')
  await frame('Daily.dtsx').getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(documentState(frame('Daily.dtsx'))).toHaveText('Not found')
  const notice = documentBanner(frame('Daily.dtsx'))
  await expect(notice.getByRole('alert')).toHaveText('The package Daily.dtsx no longer exists in the SSIS Catalog.')
  await expect(fact('Daily.dtsx', 'Version')).toHaveText('1.0.7')
  expect(await headerHeight('Daily.dtsx')).toBe(daily)
  await rm(join(control, 'ssis', 'missing'))
  await notice.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(tab('Package Properties - Daily.dtsx')).toHaveCount(0)
  console.log('SSIS checks: an object deleted elsewhere says so over the last model, and Close closes it.')

  // 8. Lists at the 2,048-row cap draw only the rows near the view, also after a tab switch, and scroll to their last row.
  await writeFile(join(control, 'ssis', 'many'), '')
  await selectOpenDocument(page, 'Project Properties - Loads')
  await frame('Loads').getByRole('button', { name: 'Refresh', exact: true }).click()
  const references = localGrid(frame('Loads'), 'References')
  await expect(references).toHaveAttribute('aria-label', 'References, 2,048 rows, 4 columns')
  await expect(parameters).toHaveAttribute('aria-label', 'Parameters, 2,048 rows, 7 columns')
  await expect(documentBanner(frame('Loads'))).toContainText('each list shows its first 2,048')
  // 6,144 rows of 4 to 7 cells each were 67,701 elements; each grid draws a screen of rows.
  const bounded = async () => {
    const { rows, nodes } = await drawn('Loads')
    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThanOrEqual(400)
    expect(nodes).toBeLessThanOrEqual(6000)
  }
  await bounded()
  // The sensitive rows of a long list copy masked too: every fifth parameter, in the catalog's order once the sort clears.
  await listMenu(parameters, 'Clear Sort')
  await expect(gridCell(parameters, 0, 0)).toHaveText('Parameter 1')
  await gridCell(parameters, 0, 2).click()
  await gridCell(parameters, 5, 2).click({ modifiers: ['Shift'] })
  await page.keyboard.press('Control+C')
  await expect.poll(async () => (await clipboard()).split(eol)[0]).toBe('********')
  expect((await clipboard()).split(eol).filter(value => value === '********')).toHaveLength(2)
  await sections('Loads').getByRole('button', { name: 'References', exact: true }).click()
  await expect.poll(() => headingShown('Loads', 'references')).toEqual({ shown: true, scrolled: true })
  await expect(gridCell(references, 0, 0)).toHaveText('Environment 1')
  await bounded()
  // Ctrl+End in the grid goes to its last row, in view: a list at the cap scrolls inside its section.
  await gridCell(references, 0, 0).click()
  await page.keyboard.press('Control+End')
  const last = gridCell(references, 2047, 0)
  await expect(last).toHaveText('Environment 2048')
  await expect.poll(() => rowShown(references, 'References', 2047)).toBe(true)
  await sectionColumn(frame('Loads'), 'Loads').evaluate(column => { column.scrollTop = column.scrollHeight })
  await expect(last).toBeInViewport()
  await bounded()
  await selectOpenDocument(page, 'Environment Properties - Test')
  await selectOpenDocument(page, 'Project Properties - Loads')
  await expect(references).toHaveAttribute('aria-label', 'References, 2,048 rows, 4 columns')
  await expect(sections('Loads').getByRole('button', { name: 'References', exact: true })).toHaveAttribute('aria-current', 'location')
  await bounded()
  await rm(join(control, 'ssis', 'many'))
  await frame('Loads').getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(references).toHaveAttribute('aria-label', 'References, 1 row, 4 columns')
  // The selection Ctrl+End left on row 2,048 is held to the one row left: Copy copies it, not rows that are gone.
  await references.focus()
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe('Not validated')
  console.log('SSIS checks: lists at the 2,048-row cap draw only the rows near the view, after a tab switch too, and reach their last row.')

  // 9. Light theme, and still no page-wide horizontal scroll.
  await selectOpenDocument(page, 'Project Properties - Loads')
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'light' }))
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe('light')
  await page.screenshot({ path: resolve('artifacts', 'ssis-project-light.png') })
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'dark' }))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

  expect(failures).toEqual([])
  console.log('SSIS checks passed: Properties from the menu, the palette, Enter and a double-click; sections, facts and lists; tab state; F5; Close cancelling a read; a failed read and Retry from the keyboard; lists as grids copying and saving sensitive values masked; lists at the cap; a deleted object; Dark and Light (artifacts/ssis-project-dark.png, ssis-project-light.png).')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'ssis-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
  await rm(control, { recursive: true, force: true })
  await rm(saveDir, { recursive: true, force: true })
}
