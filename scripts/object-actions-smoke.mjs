import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expandExplorerPath, explorerRow, explorerTree, revealExplorerRow } from './fixtures/explorer-tree.mjs'
import { actionsStubData, caution, dependentsMessage, installActionsStub, scriptText } from './fixtures/actions-stub.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'object-actions-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const mac = process.platform === 'darwin'
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Object actions suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 300000)

const fast = { force: true }
const menuNamed = name => page.getByRole('menu', { name, exact: true })
const explorerMenu = () => menuNamed('Object Explorer')
const openMenus = () => page.locator('.menu')
const labels = () => explorerMenu().locator('.menu-item .menu-label').allTextContents()
const disabled = () => explorerMenu().locator('.menu-item[aria-disabled="true"] .menu-label').allTextContents()
const dialog = () => page.getByRole('dialog', { name: 'Delete Object', exact: true })
const commandBanner = () => page.locator('.global-error[role="alert"]')
const warningBanner = () => page.locator('.global-error.warning[role="status"]')
const tabs = () => page.locator('.query-tabs').getByRole('tab')
const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText())
const stubCalls = method => application.evaluate((_electron, name) => globalThis.variaStub.calls.filter(call => call.method === name).map(call => call.params), method)
const appData = ['server-a', 'Databases', 'AppData']
const tablesPath = [...appData, 'Tables']
const ordersPath = [...tablesPath, 'dbo.Orders']

async function connect(server) {
  await page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true }).click()
  const connectDialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(connectDialog.getByText('Loading saved connections…')).toHaveCount(0)
  await connectDialog.getByLabel('Server Name', { exact: true }).fill(server)
  await connectDialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await connectDialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(connectDialog).toHaveCount(0, { timeout: 30000 })
}
/** Right-clicks a row and returns its menu's item labels. */
async function menuOf(...path) {
  await (await revealExplorerRow(page, ...path)).click({ button: 'right', force: true })
  await expect(explorerMenu()).toBeVisible()
  return labels()
}
async function closeMenu() {
  await page.keyboard.press('Escape')
  await expect(openMenus()).toHaveCount(0)
}
/** Selects a row with a click on its label, which also focuses the tree. */
async function select(...path) {
  await (await revealExplorerRow(page, ...path)).locator('.oe-label').click()
  await expect(explorerTree(page)).toBeFocused()
}

try {
  application = await electron.launch(launchOptions)
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.getByText(/\.NET 10\..*Ready/)).toBeVisible({ timeout: 30000 })
  await application.evaluate(installActionsStub, actionsStubData())
  await connect('server-a')
  // Top down, so no row moves once its own folder has loaded: a right-click must land on the row it selects.
  for (const path of [['server-a', 'Databases', 'System Databases'], tablesPath, [...appData, 'Views'], [...appData, 'Programmability', 'Stored Procedures']]) await expandExplorerPath(page, ...path)
  await expect(explorerTree(page)).toHaveAttribute('aria-busy', 'false')

  // 1. SSMS's order: the query items, Script … as, Copy Name, then Rename and Delete, then Refresh; SQL Server's own
  // database shows Rename and Delete greyed, and F2 does nothing there.
  expect(await menuOf(...ordersPath)).toEqual(['Select Top 1000 Rows', 'Script Table as', 'Copy Name', 'Rename', 'Delete', 'Refresh'])
  await closeMenu()
  expect(await menuOf(...appData, 'Views', 'dbo.OrderSummary')).toEqual(['Select Top 1000 Rows', 'Script View as', 'Copy Name', 'Rename', 'Delete', 'Refresh'])
  await closeMenu()
  expect(await menuOf(...appData, 'Programmability', 'Stored Procedures', 'dbo.ShipOrder')).toEqual(['Modify', 'Script Stored Procedure as', 'Copy Name', 'Rename', 'Delete', 'Refresh'])
  await closeMenu()
  expect(await menuOf(...appData)).toEqual(['New Query', 'Script Database as', 'Copy Name', 'Rename', 'Delete', 'Refresh'])
  await closeMenu()
  expect(await menuOf('server-a', 'Databases', 'System Databases', 'master')).toEqual(['New Query', 'Script Database as', 'Copy Name', 'Rename', 'Delete', 'Refresh'])
  expect(await disabled()).toEqual(['Rename', 'Delete'])
  await closeMenu()
  await select('server-a', 'Databases', 'System Databases', 'master')
  await page.keyboard.press('F2')
  await expect(page.locator('.explorer-rename')).toHaveCount(0)
  await page.keyboard.press('Delete')
  await expect(dialog()).toHaveCount(0)
  console.log('Object action checks: table, view, procedure and database menus in SSMS\'s order, with master\'s Rename and Delete greyed and its keys inert.')

  // 2. Select Top 1000 Rows on a view lists its columns and runs on its database.
  const before = await tabs().count()
  await (await revealExplorerRow(page, ...appData, 'Views', 'dbo.OrderSummary')).click({ button: 'right', force: true })
  await explorerMenu().getByRole('menuitem', { name: 'Select Top 1000 Rows', exact: true }).click(fast)
  const selectTop = ['/****** Script for SelectTopNRows command from Varia SQL Manager ******/', 'SELECT TOP (1000) [OrderId]', '      ,[Total]', '  FROM [AppData].[dbo].[OrderSummary]'].join('\n')
  await expect.poll(async () => (await stubCalls('query.execute')).at(-1)?.sql).toBe(selectTop)
  expect((await stubCalls('query.execute')).at(-1).database).toBe('AppData')
  expect((await stubCalls('tables.columns')).at(-1)).toEqual({ connectionId: expect.any(String), database: 'AppData', schema: 'dbo', name: 'OrderSummary' })
  await expect(tabs()).toHaveCount(before + 1)
  console.log('Object action checks: Select Top 1000 Rows on a view opens its column list and runs it on AppData.')

  // 3. F2: the box holds the name without its schema, all selected; Escape sends nothing; Enter renames and reselects.
  await select(...ordersPath)
  await page.keyboard.press('F2')
  const box = page.getByRole('textbox', { name: 'Rename Table', exact: true })
  await expect(box).toBeFocused()
  await expect(box).toHaveValue('Orders')
  expect(await box.evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([0, 6])
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
  await expect(explorerTree(page)).toBeFocused()
  expect(await stubCalls('actions.execute')).toEqual([])
  await page.keyboard.press('F2')
  await expect(box).toBeFocused()
  await page.keyboard.type('Orders2')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'rename', target: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }, newName: 'Orders2' })
  const renamed = await explorerRow(page, ...tablesPath, 'dbo.Orders2')
  await expect(renamed).toHaveAttribute('aria-selected', 'true')
  await expect(explorerTree(page)).toBeFocused()
  await expect(warningBanner()).toHaveText(caution)
  await page.getByRole('button', { name: 'Dismiss warning', exact: true }).click()
  // A name already in use: the banner says so, and the label shows the old name again.
  await select(...tablesPath, 'dbo.Orders2')
  await page.keyboard.press('F2')
  await expect(box).toHaveValue('Orders2')
  await page.keyboard.type('Taken')
  await page.keyboard.press('Enter')
  await expect(commandBanner()).toHaveText('Rename failed for dbo.Orders2: The name Taken is already in use in this schema.')
  await expect(box).toHaveCount(0)
  await expect(renamed.locator('.oe-label')).toHaveText('dbo.Orders2')
  await page.getByRole('button', { name: 'Dismiss command error', exact: true }).click()
  console.log('Object action checks: F2 renames inline with the name selected, Escape sends nothing, Enter renames and reselects, and NAME_IN_USE reverts the label.')

  // 4. Delete opens exactly one Delete Object dialog, consuming the key (the hidden menu's Delete role does not also run).
  await select(...tablesPath, 'dbo.Lines')
  await page.evaluate(() => { addEventListener('keydown', event => { if (event.key === 'Delete') window.variaDeleteKey = event.defaultPrevented }, true) })
  await page.keyboard.press(mac ? 'Meta+Backspace' : 'Delete')
  await expect(dialog()).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  if (!mac) expect(await page.evaluate(() => window.variaDeleteKey)).toBe(true)
  await expect(dialog().getByRole('navigation', { name: 'Select a page' }).getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page')
  await expect(dialog().locator('.object-dialog-box dd')).toHaveText(['server-a', 'sa'])
  await expect(dialog().locator('.object-dialog-progress')).toHaveText('Ready')
  await expect(dialog().getByRole('grid').locator('tbody td')).toHaveText(['dbo.Lines', 'Table', 'dbo', '', ''])
  await expect(dialog().locator('.object-dialog-warnings li')).toHaveText(['Referenced by foreign key FK_Items_Lines on dbo.Items; the DROP fails until it is dropped.'])
  // Script › Script Action to Clipboard puts the action's script there; the dialog stays open, as in SSMS.
  await dialog().getByRole('button', { name: 'Script options', exact: true }).click()
  await dialog().getByRole('option', { name: 'Script Action to Clipboard', exact: true }).click()
  await expect.poll(clipboard).toBe(scriptText('Lines'))
  await expect(dialog()).toBeVisible()
  expect((await stubCalls('actions.script')).at(-1)).toMatchObject({ action: 'delete', target: { name: 'Lines' }, closeConnections: false, deleteHistory: false })
  // OK: the foreign key blocks the DROP, so the dialog stays with the error.
  await dialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(dialog().getByRole('alert')).toHaveText(dependentsMessage)
  await expect(dialog().getByRole('grid').locator('tbody td').nth(3)).toHaveText('Error')
  await expect(dialog().locator('.object-dialog-progress')).toHaveText('Error')
  await page.screenshot({ path: resolve('artifacts', 'object-actions-delete-dark.png') })
  await page.keyboard.press('Escape')
  await expect(dialog()).toHaveCount(0)
  await expect(explorerTree(page)).toBeFocused()
  // OK deletes dbo.Orders2: the dialog closes, Tables reloads without it, and the tree has focus.
  await (await explorerRow(page, ...tablesPath, 'dbo.Orders2')).click({ button: 'right', force: true })
  await explorerMenu().getByRole('menuitem', { name: 'Delete', exact: true }).click(fast)
  await expect(dialog().locator('.object-dialog-progress')).toHaveText('Ready')
  await dialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  await expect.poll(async () => (await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'delete', target: { name: 'Orders2' } })
  await expect(page.locator('.explorer-tree .oe-label', { hasText: 'dbo.Orders2' })).toHaveCount(0)
  await expect(explorerTree(page)).toBeFocused()
  console.log('Object action checks: Delete opens one Delete Object dialog, Script Action to Clipboard leaves it open, DEPENDENTS keeps it with the error, and OK deletes and reloads Tables.')

  // 5. A database: SSMS's two options (backup history checked, Close existing connections not), then a lost server
  // leaves only Close.
  await (await revealExplorerRow(page, ...appData)).click({ button: 'right', force: true })
  await explorerMenu().getByRole('menuitem', { name: 'Delete', exact: true }).click(fast)
  await expect(dialog().locator('.object-dialog-progress')).toHaveText('Ready')
  await expect(dialog().getByLabel('Delete backup and restore history information for databases', { exact: true })).toBeChecked()
  await expect(dialog().getByLabel('Close existing connections', { exact: true })).not.toBeChecked()
  await page.screenshot({ path: resolve('artifacts', 'object-actions-database-dark.png') })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('varia:backend-state', {
    status: 'restarting', generation: 1, lost: { generation: 1, reason: 'crash', connections: 1, queries: 0 }, retryInMs: 60000
  }))
  await expect(dialog().getByRole('alert')).toHaveText('The server was disconnected.')
  await expect(dialog().getByRole('button', { name: 'OK', exact: true })).toBeDisabled()
  await dialog().getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  console.log('Object action checks: a database\'s Delete Object offers SSMS\'s options with their defaults, and a lost server leaves only Close.')

  expect(failures).toEqual([])
  console.log('Object action checks passed: menus, Select Top for views, inline Rename, the Delete Object dialog with Script and errors, database options, and a lost server.')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'object-actions-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
}
