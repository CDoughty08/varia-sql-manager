import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expandExplorerPath, explorerRow, explorerTree, revealExplorerRow } from './fixtures/explorer-tree.mjs'
import { actionsStubData, designerScript, installActionsStub } from './fixtures/actions-stub.mjs'
import { activeDocument, activeDocumentName, backendReady, closeDocumentButton, documentTabs, kindBadge, menuItemNames, part, toolbarButton, unsavedMark } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'table-designer-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Table designer suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 300000)

const fast = { force: true }
const menuNamed = name => page.getByRole('menu', { name, exact: true })
const tabs = () => documentTabs(page).getByRole('tab')
const designer = () => page.locator(part.tableDesigner)
const grid = () => designer().getByRole('grid', { name: 'Columns', exact: true })
const rows = () => grid().getByRole('row').filter({ has: page.getByRole('rowheader') })
const stubCalls = method => application.evaluate((_electron, name) => globalThis.variaStub.calls.filter(call => call.method === name).map(call => call.params), method)
const appData = ['server-a', 'Databases', 'AppData']
const tablesPath = [...appData, 'Tables']
const menuItemEnabled = id => application.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu().getMenuItemById(itemId)?.enabled, id)
async function menu(id) {
  await application.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu().getMenuItemById(itemId)
    if (!item) throw new Error('Menu item missing: ' + itemId)
    item.click()
  }, id)
}

async function connect(server) {
  await toolbarButton(page, 'Connect').click()
  const connectDialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(connectDialog.getByText('Loading saved connections…')).toHaveCount(0)
  await connectDialog.getByLabel('Server Name', { exact: true }).fill(server)
  await connectDialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await connectDialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(connectDialog).toHaveCount(0, { timeout: 30000 })
}
/** Right-click Tables › New › Table…: the designer opens as a tab, and its grid has focus. */
async function newTable() {
  await (await revealExplorerRow(page, ...tablesPath)).click({ button: 'right', force: true })
  await expect(menuNamed('Object Explorer')).toBeVisible()
  await menuNamed('Object Explorer').getByRole('menuitem', { name: 'New', exact: true }).click(fast)
  await page.getByRole('menuitem', { name: 'Table…', exact: true }).click(fast)
  await expect(grid()).toBeFocused()
  await expect(designer().getByRole('status').filter({ hasText: 'Reading the database…' })).toHaveCount(0)
}
/** Main's message boxes answer from `globalThis.variaStub.answers` and are recorded. */
async function answerPrompts() {
  await application.evaluate(({ dialog }) => {
    globalThis.variaStub.prompts = []
    globalThis.variaStub.answers = []
    dialog.showMessageBox = async (_window, options) => {
      globalThis.variaStub.prompts.push({ title: options.title, message: options.message, buttons: options.buttons })
      return { response: globalThis.variaStub.answers.shift() ?? options.cancelId, checkboxChecked: false }
    }
  })
}

try {
  application = await electron.launch(launchOptions)
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page)).toBeVisible({ timeout: 30000 })
  await application.evaluate(installActionsStub, actionsStubData())
  await answerPrompts()
  await connect('server-a')
  await expandExplorerPath(page, ...tablesPath)
  await expect(explorerTree(page)).toHaveAttribute('aria-busy', 'false')

  // 1. Tables › New › Table… opens "<server>.AppData - dbo.Table_1" at once, with its grid focused.
  const before = await tabs().count()
  await newTable()
  await expect(tabs()).toHaveCount(before + 1)
  await expect(page.getByRole('tab', { name: 'server-a.AppData - dbo.Table_1', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect((await stubCalls('actions.describe')).at(-1)).toMatchObject({ dialog: 'tableDesigner', target: { kind: 'database', name: 'AppData' } })
  // The query editor is hidden, and the Server and Database pickers belong to queries.
  await expect(page.locator(part.editorPane)).toBeHidden()
  await expect(page.getByLabel('Query database', { exact: true })).toBeDisabled()
  console.log('Table designer checks: Tables › New › Table… opens the designer tab at once with the grid focused.')

  // 2. Keyboard only: Id int without nulls, then Name nvarchar(50) from the empty last row.
  await page.keyboard.type('Id')
  await page.keyboard.press('Tab')
  await page.keyboard.type('int')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  await page.keyboard.type('Name')
  await page.keyboard.press('Tab')
  await page.keyboard.type('nvarchar(50)')
  await page.keyboard.press('Enter')
  await expect(rows()).toHaveCount(3)
  await expect(rows().nth(0).locator(part.designerText)).toHaveText(['Id', 'int'])
  await expect(rows().nth(1).locator(part.designerText)).toHaveText(['Name', 'nvarchar(50)'])
  await expect(rows().nth(0).getByRole('checkbox')).not.toBeChecked()
  await expect(rows().nth(1).getByRole('checkbox')).toBeChecked()
  // The tab shows its unsaved changes, and so does the window title.
  await expect(unsavedMark(activeDocument(page))).toHaveCount(1)
  await expect(kindBadge(activeDocument(page), 'Table Designer')).toHaveCount(1)
  await expect.poll(() => page.title()).toBe('* server-a.AppData - dbo.Table_1 — Varia SQL Manager')
  console.log('Table designer checks: typing, Tab, Space and the empty last row add columns, and the tab is dirty.')

  // 3. The designer menu's Set Primary Key on the first row: the key glyph, and Allow Nulls greyed.
  await rows().nth(0).getByRole('rowheader').click({ button: 'right' })
  const designerMenu = menuNamed('Table Designer')
  await expect(designerMenu).toBeVisible()
  expect(await menuItemNames(designerMenu)).toEqual(['Set Primary Key', 'Insert Column', 'Delete Column', 'Generate Change Script…', 'Properties'])
  await designerMenu.getByRole('menuitem', { name: 'Set Primary Key', exact: true }).click(fast)
  await expect(rows().nth(0).locator('[data-icon="key"]')).toHaveCount(1)
  await expect(rows().nth(0).getByRole('checkbox')).toBeDisabled()
  // Column Properties: (Is Identity) Yes; its parent mirrors it.
  const properties = designer().getByRole('region', { name: 'Column Properties', exact: true })
  await expect(properties.getByLabel('(Name)', { exact: true })).toHaveValue('Id')
  await properties.getByLabel('(Is Identity)', { exact: true }).selectOption('Yes')
  await expect(properties.getByLabel('Identity Specification', { exact: true })).toHaveValue('Yes')
  await expect(properties.getByLabel('Identity Seed', { exact: true })).toHaveValue('1')
  await page.screenshot({ path: resolve('artifacts', 'table-designer-dark.png') })
  // F4 in the grid shows Properties, with schema dbo.
  await grid().focus()
  await page.keyboard.press('F4')
  const tableProperties = designer().getByRole('complementary', { name: 'Properties', exact: true })
  await expect(tableProperties.getByLabel('Schema', { exact: true })).toHaveValue('dbo')
  await expect(tableProperties.getByLabel('Database Name', { exact: true })).toHaveValue('AppData')
  // Edit › Find and the other text commands have nothing to act on.
  await expect.poll(() => menuItemEnabled('edit.find')).toBe(false)
  await expect.poll(() => menuItemEnabled('file.saveAs')).toBe(false)
  await menu('theme.mode.light')
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe('light')
  await page.screenshot({ path: resolve('artifacts', 'table-designer-light.png') })
  await menu('theme.mode.dark')
  console.log('Table designer checks: Set Primary Key from the designer menu, (Is Identity) in Column Properties, F4\'s Properties, and Edit › Find disabled.')

  // 4. Generate Change Script… shows the backend's script; No closes it.
  await grid().focus()
  await rows().nth(0).getByRole('rowheader').click({ button: 'right' })
  await menuNamed('Table Designer').getByRole('menuitem', { name: 'Generate Change Script…', exact: true }).click(fast)
  const scriptDialog = page.getByRole('dialog', { name: 'Save Change Script', exact: true })
  // A text area's value has LF line breaks.
  await expect(scriptDialog.getByRole('textbox', { name: 'Change script' })).toHaveValue(designerScript('Table_1').replaceAll(String.fromCharCode(13), ''))
  await scriptDialog.getByRole('button', { name: 'No', exact: true }).click()
  await expect(scriptDialog).toHaveCount(0)
  console.log('Table designer checks: Generate Change Script… shows the script, and No closes it.')

  // 5. Ctrl+S asks Choose Name (Table_1), then creates dbo.Orders with exactly the design shown.
  await grid().focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  const chooseName = page.getByRole('dialog', { name: 'Choose Name', exact: true })
  await expect(chooseName.getByLabel('Enter a name for the table:', { exact: true })).toHaveValue('Table_1')
  await chooseName.getByLabel('Enter a name for the table:', { exact: true }).fill('Orders')
  await chooseName.getByRole('button', { name: 'OK', exact: true }).click()
  await expect.poll(async () => (await stubCalls('actions.execute')).filter(call => call.action === 'createTable').length).toBe(1)
  expect((await stubCalls('actions.execute')).at(-1)).toEqual({
    action: 'createTable', connectionId: expect.any(String), requestId: expect.any(String), target: { kind: 'database', name: 'AppData' },
    design: { schema: 'dbo', name: 'Orders', columns: [{ name: 'Id', type: { system: 'int' }, allowNulls: false, identity: { seed: '1', increment: '1' } }, { name: 'Name', type: { system: 'nvarchar', length: 50 }, allowNulls: true }], primaryKey: [0] }
  })
  await expect(designer().getByRole('status').filter({ hasText: 'dbo.Orders was created. Changing an existing table in the designer is not available yet.' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'server-a.AppData - dbo.Orders', exact: true })).toBeVisible()
  await expect(unsavedMark(activeDocument(page))).toHaveCount(0)
  await expect(rows().nth(0).getByRole('checkbox')).toBeDisabled()
  await expect(rows().nth(1).getByRole('checkbox')).toBeDisabled()
  // Object Explorer reloads Tables and selects the new table.
  await expect(await explorerRow(page, ...tablesPath, 'dbo.Orders')).toBeVisible()
  await expect.poll(async () => (await explorerRow(page, ...tablesPath, 'dbo.Orders')).getAttribute('aria-selected')).toBe('true')
  console.log('Table designer checks: Ctrl+S asks Choose Name once and saves exactly the design; the tab is clean and read-only, and Tables shows dbo.Orders selected.')

  // 6. A second designer: a name that looks like markup stays text; closing it dirty asks main's question.
  await newTable()
  const hostile = '<img src=x onerror=alert(1)>'
  await page.keyboard.type(hostile)
  await page.keyboard.press('Enter')
  await expect(rows().nth(0).locator(part.designerText).first()).toHaveText(hostile)
  await expect(designer().locator('img')).toHaveCount(0)
  await application.evaluate(() => { globalThis.variaStub.answers.push(1) })
  await closeDocumentButton(page, await activeDocumentName(page)).click()
  await expect(page.getByRole('tab', { name: 'server-a.AppData - dbo.Table_2', exact: true })).toHaveCount(0)
  expect(await application.evaluate(() => globalThis.variaStub.prompts.at(-1))).toMatchObject({ message: 'Save changes to server-a.AppData - dbo.Table_2?', buttons: ['Save', "Don't Save", 'Cancel'] })
  console.log('Table designer checks: a name like markup shows as text, and closing a dirty designer asks to save it (Don\'t Save closes).')

  // 7. A save waiting on a lock shows Stop; Stop cancels it in the backend, and SQL Server rolled it back.
  await newTable()
  await page.keyboard.type('Id')
  await page.keyboard.press('Enter')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await chooseName.getByLabel('Enter a name for the table:', { exact: true }).fill('Held')
  await chooseName.getByRole('button', { name: 'OK', exact: true }).click()
  const stop = designer().getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible()
  await stop.click()
  await expect(designer().getByRole('alert')).toHaveText('The save was stopped. SQL Server rolled back the table; nothing was created.')
  const held = (await stubCalls('actions.execute')).at(-1)
  expect(held).toMatchObject({ action: 'createTable', design: { name: 'Held' } })
  expect(await application.evaluate(() => globalThis.variaStub.cancels)).toContain(held.requestId)
  await expect(unsavedMark(activeDocument(page))).toHaveCount(1)
  console.log('Table designer checks: Stop cancels a waiting save in the backend, which SQL Server rolled back, and the designer stays dirty.')

  // 8. Generate Change Script… › Yes saves the script to the file main's Save dialog picks.
  const scriptFile = resolve(profile, 'Held.sql')
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, scriptFile)
  await rows().nth(0).getByRole('rowheader').click({ button: 'right' })
  await menuNamed('Table Designer').getByRole('menuitem', { name: 'Generate Change Script…', exact: true }).click(fast)
  await scriptDialog.getByRole('button', { name: 'Yes', exact: true }).click()
  await expect(scriptDialog).toHaveCount(0)
  await expect.poll(async () => (await readFile(scriptFile, 'utf8').catch(() => '')).replace(/^﻿/, '').replaceAll('\r', '')).toBe(designerScript('Held').replaceAll('\r', ''))
  console.log('Table designer checks: Generate Change Script… › Yes saves the script to the chosen file.')

  // 9. A retry save after NAME_IN_USE, with a column still being typed: Ctrl+S sends it (no Choose Name blurs the cell),
  // the error shows, and after a new name in Properties the next Ctrl+S creates the table.
  await grid().focus()
  await page.keyboard.press('F4')
  await tableProperties.getByLabel('(Name)', { exact: true }).fill('Taken')
  await grid().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Home')
  await page.keyboard.type('Extra')
  await expect(grid().getByRole('textbox', { name: 'Column Name', exact: true })).toHaveValue('Extra')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await expect(designer().getByRole('alert')).toHaveText('An object named Taken already exists in schema dbo.')
  await expect(page.getByRole('dialog', { name: 'Choose Name', exact: true })).toHaveCount(0)
  const taken = (await stubCalls('actions.execute')).at(-1)
  expect(taken).toMatchObject({ action: 'createTable', design: { name: 'Taken', columns: [{ name: 'Id' }, { name: 'Extra' }], primaryKey: [] } })
  await expect(rows().nth(1).locator(part.designerText).first()).toHaveText('Extra')
  await tableProperties.getByLabel('(Name)', { exact: true }).fill('Fixed')
  await grid().focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await expect(designer().getByRole('status').filter({ hasText: 'dbo.Fixed was created.' })).toBeVisible()
  expect((await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'createTable', design: { name: 'Fixed', columns: [{ name: 'Id' }, { name: 'Extra' }] } })
  console.log('Table designer checks: a retry after NAME_IN_USE sends the cell being typed, shows the error, and saves under a new name.')

  // 10. File › Save All with an unnamed designer behind a query brings the designer forward with Choose Name.
  await newTable()
  await page.keyboard.type('Id')
  await page.keyboard.press('Enter')
  const unnamed = page.getByRole('tab', { name: 'server-a.AppData - dbo.Table_4', exact: true })
  await expect(unnamed).toHaveAttribute('aria-selected', 'true')
  await menu('file.new')
  await expect(unnamed).toHaveAttribute('aria-selected', 'false')
  await menu('file.saveAll')
  await expect(unnamed).toHaveAttribute('aria-selected', 'true')
  await expect(chooseName.getByLabel('Enter a name for the table:', { exact: true })).toHaveValue('Table_4')
  await chooseName.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(chooseName).toHaveCount(0)
  await expect(unsavedMark(activeDocument(page))).toHaveCount(1)
  console.log('Table designer checks: Save All brings an unnamed designer behind a query forward with Choose Name.')

  expect(failures).toEqual([])
  console.log('Table designer checks passed: New › Table…, keyboard editing, the designer menu, Column Properties, F4, Generate Change Script and its file, Choose Name and Save, the close prompt, Stop, a retry after NAME_IN_USE, and Save All.')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'table-designer-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
}
