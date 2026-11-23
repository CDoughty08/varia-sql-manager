import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expandExplorerPath, explorerRow } from './fixtures/explorer-tree.mjs'
import {
  backendReady, connectDialogWindow, dialogClosed, dialogWindow, documentTabSlots, editorText as editorTextOf, menubar, movePane, optionsControls, optionsDescription, optionsForm, optionsHeading, optionsNotes, optionsSection, pane, dockPopoutBack, popoutTabs, queryServer, resultGrid,
  shortcutsInspector, shortcutsRow, shortcutsSearch, shortcutsSheet, shortcutsTable, submitConnect, toolbarButton, warningBanner as warningBannerOf, expectEditorShown, pressToClose, clickToClose
} from './fixtures/ui.mjs'
import { resizeContent } from './fixtures/window-resize.mjs'
import { parseCalls } from './fixtures/call-log.mjs'

// Tools › Options over the fake backend (tests/fixtures/backend.mjs, workbench mode), which records each request in
// calls.jsonl: the page tree, search, form and property-grid pages, what OK saves to settings.json and what the
// workbench then does with it, recovery from a damaged file, and migration from scripting-options.json.
await mkdir('artifacts', { recursive: true })
const control = await mkdtemp(resolve('artifacts', 'options-backend-'))
const mac = process.platform === 'darwin'
let profile, application, page
// Tools › Options opens in a dialog window of its own (popouts/DialogWindow.tsx): the page of that window while it is open.
let options
const failures = []
const watchdog = setTimeout(() => { console.error('Options suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 420000)

const settingsFile = () => join(profile, 'settings.json')
const stored = () => readFile(settingsFile(), 'utf8').then(JSON.parse, () => null)
async function launch(fresh = false) {
  if (fresh || !profile) profile = await mkdtemp(resolve('artifacts', 'options-profile-'))
  const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
  delete env.ELECTRON_RUN_AS_NODE
  // Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it.
  application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  await expectEditorShown(page)
}
// Unsaved queries make a normal exit ask first; answer Don't Save.
async function close() {
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await application.close()
}
const textbox = () => page.locator('.monaco-editor [role="textbox"]')
const dialog = () => options.getByRole('dialog', { name: 'Options', exact: true })
const closed = () => dialogClosed(options, 'Options')
const tree = () => dialog().getByRole('tree', { name: 'Options pages', exact: true })
const node = name => tree().getByRole('treeitem', { name, exact: true })
const field = label => dialog().getByLabel(label, { exact: true })
const heading = () => optionsHeading(dialog())
const search = () => dialog().getByRole('searchbox', { name: 'Search Options', exact: true })
const controlShape = control => control.evaluate(element => {
  const style = getComputedStyle(element)
  return { height: element.getBoundingClientRect().height, radius: style.borderTopLeftRadius }
})
const searchIconFits = control => control.evaluate(element => {
  const icon = element.parentElement.querySelector('[data-icon="search"]')?.getBoundingClientRect()
  const field = element.getBoundingClientRect(), textStart = field.left + parseFloat(getComputedStyle(element).paddingInlineStart)
  return !!icon && icon.left > field.left && icon.right <= textStart && Math.abs((icon.top + icon.bottom - field.top - field.bottom) / 2) < 1
})
const standardControl = { height: 26, radius: '4px' }
const denseControl = { ...standardControl, height: 22 }
const warningBanner = () => warningBannerOf(page)
const calls = async method => parseCalls(await readFile(join(control, 'calls.jsonl'), 'utf8').catch(() => '')).filter(call => call.method === method).map(call => call.params)
const nbsp = String.fromCharCode(160)
const editorText = async () => (await editorTextOf(page)).replaceAll(nbsp, ' ')
async function menu(id) {
  await application.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu().getMenuItemById(itemId)
    if (!item) throw new Error('Menu item missing: ' + itemId)
    item.click()
  }, id)
}
/** Tools › Options…: Alt+T, O on Windows and Linux; the menu item on macOS, whose ⌘, is a manual check. */
async function openOptions() {
  if (!mac) {
    await textbox().focus()
    await page.keyboard.press('Alt+t')
    await expect(page.getByRole('menu', { name: 'Tools', exact: true }).getByRole('menuitem', { name: 'Options…', exact: true })).toBeFocused()
    await page.keyboard.press('o')
  } else await menu('preferences.options')
  options = await dialogWindow(application, 'Options')
  options.setDefaultTimeout(15000)
  if (options !== page) options.on('pageerror', error => failures.push(error.message))
  await expect(dialog()).toBeVisible()
}
/** The Options window as main has it: its own OS window, kept above the main window, resizable, with only a close button. */
const optionsWindow = () => application.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows().find(item => item.getTitle() === 'Options')
  return window && { parent: window.getParentWindow()?.getTitle().endsWith('Varia SQL Manager') ?? false, resizable: window.isResizable(), minimizable: window.isMinimizable(), maximizable: window.isMaximizable(), size: window.getContentSize() }
})
/** Shows a page by clicking each node of its path; a category shows its first page. */
async function showPage(...path) {
  for (const name of path) await node(name).click()
  await expect(heading()).toContainText(path.join(' › '))
}
const searchKey = mac ? 'Meta+e' : 'Control+e'
const treeNames = () => tree().getByRole('treeitem').evaluateAll(items => items.map(item => '  '.repeat(Number(item.getAttribute('aria-level')) - 1) + item.textContent))
const layout = () => options.evaluate(() => {
  const box = document.querySelector('[role="dialog"]').getBoundingClientRect()
  return { inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight }
})

try {
  await launch()
  // 0. SSMS's default, Keep tabs: Tab inserts a tab character, so an x typed before it leaves the tab filling to column 4.
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT 1')
  await page.keyboard.press('Home')
  await page.keyboard.press('Tab')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.insertText('x')
  await expect.poll(editorText).toBe('x   SELECT 1')
  console.log('Options checks: with the default settings, Tab inserts a tab character.')

  // 1. Tools › Options… opens on Environment › General with the search box focused; the tree holds SSMS's pages.
  await openOptions()
  await expect(search()).toBeFocused()
  await expect(search()).toHaveAttribute('placeholder', mac ? 'Search Options (⌘E)' : 'Search Options (Ctrl+E)')
  expect(await controlShape(search())).toEqual(standardControl)
  expect(await searchIconFits(search())).toBe(true)
  await expect(search()).toHaveCSS('outline-offset', '-2px')
  await expect(heading()).toHaveText('Environment › General')
  await expect(node('General').first()).toHaveAttribute('aria-selected', 'true')
  await expect(optionsNotes(dialog()).first()).toHaveText('Color theme: View › Theme')
  for (const name of ['Text Editor', 'Transact-SQL', 'Query Execution', 'Query Results', 'SQL Server Object Explorer']) await node(name).click()
  expect(await treeNames()).toEqual([
    'Environment', '  General', '  AutoRecover', '  Documents', '  Fonts and Colors', '  Shortcuts', '  Product Updates', '  Live Data', '  Object Explorer', '  Connections', 'Text Editor', '  General', '  Editor Tab and Status Bar', '  Transact-SQL', '    General', '    IntelliSense', '    Tabs', '  GoogleSQL', 'Query Execution', '  SQL Server', '    General', '    Advanced', '  BigQuery',
    'Query Results', '  SQL Server', '    Results to Grid', '  BigQuery', 'SQL Server Object Explorer', '  Commands', '  Scripting', 'Activity Monitor',
    'SQL Server Integration Services'
  ])
  await expect(heading()).toHaveText('SQL Server Object Explorer › Commands')
  // The SSIS page (S2) is a page of its own at the top level: the tree probe's switch, and its interval, which follows it.
  await node('SQL Server Integration Services').click()
  await expect(heading()).toHaveText('SQL Server Integration Services')
  await expect(field('Update the SSIS Catalog in Object Explorer as it changes')).toBeChecked()
  await expect(field('Check the catalog for changes every')).toHaveValue('30')
  await node('Commands').click()
  await expect(heading()).toHaveText('SQL Server Object Explorer › Commands')
  // The tree's keys: Up and Down show the page they reach, Left goes to the parent, Home to the first node.
  await node('Scripting').focus()
  await options.keyboard.press('ArrowUp')
  await expect(node('Commands')).toBeFocused()
  await options.keyboard.press('ArrowLeft')
  await expect(node('SQL Server Object Explorer')).toBeFocused()
  await options.keyboard.press('Home')
  await expect(node('Environment')).toBeFocused()
  await expect(heading()).toHaveText('Environment › General')
  // Shortcuts (SSMS's Keyboard) is a page of its own layout: no notes, no description pane, no Reset to Defaults.
  await node('Shortcuts').click()
  await expect(dialog().getByRole('heading', { name: 'Keyboard and mouse shortcuts', exact: true })).toBeVisible()
  await expect(shortcutsTable(dialog())).toBeVisible()
  expect(await controlShape(shortcutsSearch(dialog()))).toEqual(standardControl)
  expect(await searchIconFits(shortcutsSearch(dialog()))).toBe(true)
  expect(await controlShape(dialog().getByRole('combobox', { name: /^Mapping scheme/ }))).toEqual(standardControl)
  // Ctrl+C on a row copies it as shown, its command by title: Command, Shortcut, Scope and Source, tab-separated.
  const firstCommand = shortcutsTable(dialog()).getByRole('row').filter({ has: options.getByRole('gridcell') }).first()
  await firstCommand.click()
  await application.evaluate(({ clipboard }) => clipboard.writeText('before'))
  await options.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')
  await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toMatch(/^[^\t\r\n]+\t[^\t\r\n]*\t[^\t\r\n]*\t[^\t\r\n]+$/)
  const copiedCommand = (await application.evaluate(({ clipboard }) => clipboard.readText())).split('\t')[0]
  expect((await firstCommand.getByRole('gridcell').first().innerText()).startsWith(copiedCommand)).toBe(true)
  await expect(optionsDescription(dialog())).toHaveCount(0)
  await dialog().getByRole('radio', { name: 'Mouse', exact: true }).click()
  expect(await controlShape(dialog().getByRole('combobox', { name: /: modifier$/ }).first())).toEqual(denseControl)
  // Fonts and Colors says where colors are set, above its Size row and while that row is focused.
  await node('Fonts and Colors').click()
  await field('Size').focus()
  expect(await controlShape(field('Size'))).toEqual(standardControl)
  await expect(optionsNotes(dialog())).toHaveText('Colors come from the color theme (View › Theme).')
  await expect(optionsDescription(dialog())).toContainText('Size')
  // Environment › AutoRecover has SSMS's defaults (on, every 5 minutes, kept 7 days); off greys both numbers.
  await node('AutoRecover').click()
  await expect(field('Save AutoRecover information')).toBeChecked()
  await expect(field('Save AutoRecover information every')).toHaveValue('5')
  await expect(field('Keep AutoRecover information for')).toHaveValue('7')
  await field('Save AutoRecover information').uncheck()
  await expect(field('Save AutoRecover information every')).toBeDisabled()
  await expect(field('Save AutoRecover information every')).toHaveCSS('opacity', '0.5')
  await expect(field('Keep AutoRecover information for')).toBeDisabled()
  await field('Save AutoRecover information').check()
  await expect(field('Keep AutoRecover information for')).toBeEnabled()
  // Environment › Live Data (Varia's own page): hidden views pause after 2 s and stop after 5 min; off greys both delays.
  await node('Live Data').click()
  await expect(field('Pause live views that are hidden')).toBeChecked()
  await expect(field('Pause after hidden for')).toHaveValue('2')
  await expect(field('Stop after hidden for')).toHaveValue('5')
  await expect(field('Keep chart history for')).toHaveValue('60')
  await field('Pause live views that are hidden').uncheck()
  await expect(field('Pause after hidden for')).toBeDisabled()
  await expect(field('Stop after hidden for')).toBeDisabled()
  await expect(field('Keep chart history for')).toBeEnabled()
  await field('Pause live views that are hidden').check()
  await expect(field('Pause after hidden for')).toBeEnabled()
  // Connections defaults to one silent startup reconnect attempt. This draft is discarded by Escape below.
  await node('Connections').click()
  await expect(heading()).toHaveText('Environment › Connections')
  await expect(field('Automatically reconnect on startup')).toBeChecked()
  await field('Automatically reconnect on startup').uncheck()
  console.log('Options checks: Alt+T, O opens Environment › General with the search box focused, the page tree has its expected pages and keys, AutoRecover has SSMS\'s defaults, and Connections enables startup reconnect by default.')

  // 2. Ctrl+E (⌘E) searches: "time-out" leaves Query Execution › SQL Server › General, highlighted; Escape clears, then closes.
  await node('Shortcuts').focus()
  await options.keyboard.press(searchKey)
  await expect(search()).toBeFocused()
  await options.keyboard.type('time-out')
  expect(await treeNames()).toEqual(['Query Execution', '  SQL Server', '    General'])
  await expect(heading()).toHaveText('Query Execution › SQL Server › General')
  await expect(optionsForm(dialog()).locator('mark')).toHaveText('time-out')
  // The key is the catalogue's options.focusSearch, a modal key: from a page's field it focuses the box and selects its
  // text, and Shift with it does nothing.
  await field('Execution time-out').focus()
  await options.keyboard.press(mac ? 'Meta+Shift+e' : 'Control+Shift+e')
  await expect(field('Execution time-out')).toBeFocused()
  await options.keyboard.press(searchKey)
  await expect(search()).toBeFocused()
  expect(await search().evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([0, 'time-out'.length])
  await options.keyboard.press('End')
  await options.keyboard.type('zzz')
  await expect(dialog().getByText('No settings match.', { exact: true })).toBeVisible()
  await options.keyboard.press('Escape')
  await expect(search()).toHaveValue('')
  await expect(dialog()).toBeVisible()
  await pressToClose(options, 'Escape')
  await closed()
  console.log('Options checks: Ctrl+E focuses the search, which filters the tree and highlights matches; Escape clears it, then cancels.')

  // 3. Changes across pages, one OK: settings.json holds exactly the changed keys, and each takes effect.
  await openOptions()
  // The dialog opens on the page last shown.
  await expect(heading()).toHaveText('Query Execution › SQL Server › General')
  await field('Execution time-out').fill('7')
  await node('Advanced').click()
  await field('Stop the script at the first batch that raises an error').check()
  await field('Stop the script at the first batch that raises an error').focus()
  await expect(optionsDescription(dialog())).toContainText('Not in SSMS.')
  await showPage('Text Editor', 'Transact-SQL')
  await field('Word wrap').check()
  await node('Tabs').click()
  await field('Tab size').fill('2')
  await field('Indent size').fill('2')
  // SSMS's default is Keep tabs; with Insert spaces, Tab inserts an indent's two columns as spaces.
  await dialog().getByRole('radio', { name: 'Insert spaces', exact: true }).check()
  await showPage('SQL Server Object Explorer', 'Commands')
  await field('Value for Select Top <n> Rows command').fill('50')
  await showPage('Environment', 'Object Explorer')
  await expect(field('Follow active query')).toBeChecked()
  await expect(field('Pinned server headers at top')).toHaveValue('2')
  await expect(field('Pinned server headers at bottom')).toHaveValue('2')
  await field('Follow active query').uncheck()
  await field('Pinned server headers at top').fill('1')
  await field('Pinned server headers at bottom').fill('3')
  await showPage('Environment', 'Connections')
  await expect(field('Automatically reconnect on startup')).toBeChecked()
  await field('Automatically reconnect on startup').uncheck()
  await clickToClose(dialog().getByRole('button', { name: 'OK', exact: true }))
  await closed()
  await expect.poll(stored).toEqual({ version: 1, values: {
    'environment.connections.autoReconnect': false,
    'objectExplorer.followActiveQuery': false, 'objectExplorer.pinnedServerHeadersBottom': 3, 'objectExplorer.pinnedServerHeadersTop': 1,
    'objectExplorer.selectTopRows': 50, 'queryExecution.executionTimeout': 7, 'queryExecution.stopOnError': true, 'textEditor.sql.indentSize': 2, 'textEditor.sql.tabSize': 2, 'textEditor.sql.tabs': 'spaces', 'textEditor.sql.wordWrap': true
  } })
  // Main refuses unknown keys and wrong types, and the file stays as it was.
  const refusals = await page.evaluate(async () => [await window.varia.updateSettings({ 'textEditor.unknown': true }), await window.varia.updateSettings({ 'textEditor.sql.tabSize': 'two' })].map(result => result.ok))
  expect(refusals).toEqual([false, false])
  expect((await stored()).values['textEditor.sql.tabSize']).toBe(2)
  // The editor: Tab inserts two spaces, and a long line wraps.
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT 1')
  await page.keyboard.press('Home')
  await page.keyboard.press('Tab')
  await expect.poll(editorText).toBe('  SELECT 1')
  await page.keyboard.press('End')
  await page.keyboard.insertText(' -- ' + 'wrapped '.repeat(60))
  await expect.poll(() => page.locator('.monaco-editor .view-line').count()).toBeGreaterThan(1)
  // F5 on a connected query sends Options' time-out and stop-on-error.
  await toolbarButton(page, 'Connect').click()
  const { window: connectWin, dialog: connectDialog } = await connectDialogWindow(application)
  await connectDialog.getByLabel('Server Name', { exact: true }).fill('server-a')
  await connectDialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await submitConnect(connectWin, connectDialog)
  // Connect closes before it binds the query to the new connection (App's finishConnected), and F5 on a query with none
  // asks to connect instead of running: wait for the query's server.
  await expect(queryServer(page)).not.toHaveValue('')
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT 1')
  await page.keyboard.press('F5')
  await expect.poll(async () => (await calls('query.execute')).at(-1)).toMatchObject({ timeoutSeconds: 7, stopOnError: true, maxResultSets: 1000 })
  // Object Explorer's table menu titles Select Top with the Options value, and runs that many.
  if (!mac) {
    await expandExplorerPath(page, 'server-a', 'Databases', 'AppData', 'Tables')
    const orders = await explorerRow(page, 'server-a', 'Databases', 'AppData', 'Tables', 'dbo.Orders')
    await orders.click({ button: 'right', force: true })
    const explorerMenu = page.getByRole('menu', { name: 'Object Explorer', exact: true })
    await explorerMenu.getByRole('menuitem', { name: 'Select Top 50 Rows', exact: true }).click()
    await expect.poll(async () => (await calls('query.execute')).at(-1)?.sql).toContain('SELECT TOP (50) [Id]')
  }
  console.log('Options checks: one OK saves only the changed settings, including startup reconnect and Follow active query with independent Object Explorer header limits.')

  // 4. OK refuses an out-of-range value, shows why and focuses the field; Cancel discards a draft across pages.
  await openOptions()
  await node('Query Execution').click()
  const validBorder = await field('Execution time-out').evaluate(element => getComputedStyle(element).borderTopColor)
  await field('Execution time-out').fill('99999')
  await showPage('Text Editor', 'Transact-SQL', 'Tabs')
  await expect(heading()).toHaveText('Text Editor › Transact-SQL › Tabs')
  await field('Tab size').fill('3')
  await showPage('Environment', 'Connections')
  await expect(field('Automatically reconnect on startup')).not.toBeChecked()
  await field('Automatically reconnect on startup').check()
  await dialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(heading()).toHaveText('Query Execution › SQL Server › General')
  await expect(dialog().getByText('Execution time-out must be a whole number from 0 to 86,400.', { exact: true })).toBeVisible()
  await expect(field('Execution time-out')).toBeFocused()
  await expect(field('Execution time-out')).toHaveAttribute('aria-invalid', 'true')
  await expect(field('Execution time-out')).not.toHaveCSS('border-top-color', validBorder)
  await clickToClose(dialog().getByRole('button', { name: 'Cancel', exact: true }))
  await closed()
  expect((await stored()).values).toMatchObject({ 'environment.connections.autoReconnect': false, 'queryExecution.executionTimeout': 7, 'textEditor.sql.tabSize': 2 })
  await openOptions()
  await expect(field('Execution time-out')).toHaveValue('7')
  await showPage('Environment', 'Connections')
  await expect(field('Automatically reconnect on startup')).not.toBeChecked()
  await pressToClose(options, 'Escape')
  await closed()
  console.log('Options checks: OK names the bounds of an out-of-range value and focuses it; Cancel discards a draft across pages.')

  // 10. At 1024×768 the dialog fits; screenshots in Dark and Light (the window keeps this size from here on).
  await resizeContent(application, page, 1024, 768)
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024)
  await openOptions()
  await node('SQL Server Object Explorer').click()
  await node('Scripting').click()
  expect(await layout()).toEqual({ inside: true, overflow: false })
  await options.screenshot({ path: resolve('artifacts', 'options-dark.png') })
  // A form page: checkboxes, number fields with their units, and radio buttons.
  await showPage('Text Editor', 'Transact-SQL', 'Tabs')
  expect(await layout()).toEqual({ inside: true, overflow: false })
  await options.screenshot({ path: resolve('artifacts', 'options-form-dark.png') })
  await pressToClose(options, 'Escape')
  await closed()
  await menu('theme.mode.light')
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe('light')
  await openOptions()
  // The dialog window follows the theme, as popouts do.
  await expect.poll(() => options.evaluate(() => document.documentElement.dataset.themeType)).toBe('light')
  expect(await layout()).toEqual({ inside: true, overflow: false })
  await options.screenshot({ path: resolve('artifacts', 'options-light.png') })
  await pressToClose(options, 'Escape')
  await closed()
  await menu('theme.mode.dark')
  console.log('Options checks: the dialog fits its window in Dark and Light (artifacts/options-dark.png, options-form-dark.png, options-light.png).')

  // 4b. Sections and alignment: Results to Grid groups its rows under headings, and every field and list on a page shares
  // one control column. The window is the main window's resizable child, and opens again at the size it was left.
  await openOptions()
  // Electron reports minimizable and maximizable only on Windows and macOS; on Linux the window manager decides, and
  // tests/popout-windows.test.ts checks that main asks for neither.
  expect(await optionsWindow()).toMatchObject({ parent: true, resizable: true, ...process.platform === 'linux' ? {} : { minimizable: false, maximizable: false } })
  await showPage('Query Results', 'SQL Server', 'Results to Grid')
  for (const name of ['Grid display', 'Copy and save', 'Limits and memory', 'Execution plan']) await expect(optionsSection(dialog(), name)).toBeVisible()
  await expect(optionsSection(dialog(), 'Execution plan').getByRole('checkbox', { name: 'Show outline', exact: true })).toBeChecked()
  // Copy and Save Results As have their own header settings: copy without by default, save with.
  await expect(optionsSection(dialog(), 'Copy and save').getByRole('checkbox', { name: 'Include column headers when copying the results', exact: true })).not.toBeChecked()
  await expect(optionsSection(dialog(), 'Copy and save').getByRole('checkbox', { name: 'Include column headers when saving the results', exact: true })).toBeChecked()
  await expect(optionsSection(dialog(), 'Execution plan').getByRole('spinbutton', { name: 'Outline width', exact: true })).toHaveValue('220')
  await expect(optionsSection(dialog(), 'Limits and memory')).toContainText('0 = no limit')
  await expect(optionsSection(dialog(), 'Limits and memory')).toContainText('GiB · 0 = automatic')
  const resultsLayout = field('Show results')
  expect(await controlShape(resultsLayout)).toEqual(standardControl)
  expect(await controlShape(dialog().getByRole('button', { name: 'OK', exact: true }))).toEqual(standardControl)
  // Transfer keyboard focus from the search box so the select shows its inset focus ring.
  await search().focus()
  await options.keyboard.press('Tab')
  await options.keyboard.press('Tab')
  await expect(resultsLayout).toBeFocused()
  await expect(resultsLayout).toHaveCSS('outline-offset', '-2px')
  const columns = await optionsControls(dialog()).evaluateAll(controls => controls.map(control => { const box = control.getBoundingClientRect(); return `${Math.round(box.left)}:${Math.round(box.width)}` }))
  expect(columns.length).toBeGreaterThan(5)
  expect(new Set(columns).size).toBe(1)
  await showPage('Text Editor', 'Editor Tab and Status Bar')
  expect(await controlShape(field('Include database name'))).toEqual(denseControl)
  await showPage('Query Results', 'SQL Server', 'Results to Grid')
  // Searching a section's name finds its rows.
  await search().fill('execution plan')
  await expect(heading()).toHaveText('Query Results › SQL Server › Results to Grid')
  await search().fill('')
  // A text field in the dialog window has its menu, by mouse and by Shift+F10; Escape closes the menu, not the dialog.
  const fieldMenu = options.getByRole('menu', { name: 'Text field', exact: true })
  await search().click({ button: 'right' })
  await expect(fieldMenu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeVisible()
  await options.keyboard.press('Escape')
  await expect(fieldMenu).toHaveCount(0)
  await expect(search()).toBeFocused()
  await options.keyboard.press('Shift+F10')
  await expect(fieldMenu.getByRole('menuitem', { name: 'Undo', exact: true })).toBeFocused()
  await options.keyboard.press('Escape')
  await expect(search()).toBeFocused()
  await expect(dialog()).toBeVisible()
  // Tools › Options… again from the main window raises the open window rather than opening another; the main window
  // works beside it (the dialog is modeless), and keys in the dialog window stay the dialog's.
  const windowCount = application.windows().length
  await menu('preferences.options')
  await expect(heading()).toHaveText('Query Results › SQL Server › Results to Grid')
  expect(application.windows().length).toBe(windowCount)
  const tabs = () => documentTabSlots(page).count(), before = await tabs(), newQuery = mac ? 'Meta+n' : 'Control+n'
  await search().focus()
  await options.keyboard.press(newQuery)
  await options.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await tabs()).toBe(before)
  await textbox().filter({ visible: true }).focus()
  await page.keyboard.press(newQuery)
  await expect.poll(tabs).toBe(before + 1)
  await expect(dialog()).toBeVisible()
  // Smaller than the default and than CI's screens: a reopened window is kept 32 px inside the screen.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.getTitle() === 'Options').setContentSize(900, 600))
  await expect.poll(() => options.evaluate(() => [innerWidth, innerHeight])).toEqual([900, 600])
  await clickToClose(dialog().getByRole('button', { name: 'Cancel', exact: true }))
  await closed()
  await openOptions()
  expect((await optionsWindow()).size).toEqual([900, 600])
  await pressToClose(options, 'Escape')
  await closed()
  console.log('Options checks: Results to Grid shows its four sections with one aligned control column; the window is modeless, resizable and reopens at its last size.')

  // 5. A restart keeps the values; Alt+Z toggles word wrap and saves it.
  await close()
  await launch()
  await openOptions()
  await showPage('Text Editor', 'Transact-SQL')
  await expect(field('Word wrap')).toBeChecked()
  await showPage('Environment', 'Object Explorer')
  await expect(field('Follow active query')).not.toBeChecked()
  await expect(field('Pinned server headers at top')).toHaveValue('1')
  await expect(field('Pinned server headers at bottom')).toHaveValue('3')
  await showPage('Environment', 'Connections')
  await expect(field('Automatically reconnect on startup')).not.toBeChecked()
  await pressToClose(options, 'Escape')
  await closed()
  if (!mac) {
    await textbox().focus()
    await page.keyboard.press('Alt+z')
    await expect.poll(async () => (await stored())?.values['textEditor.sql.wordWrap']).toBeUndefined()
    await page.keyboard.press('Alt+z')
    await expect.poll(async () => (await stored())?.values['textEditor.sql.wordWrap']).toBe(true)
  }
  console.log('Options checks: the values survive a restart, and Alt+Z saves word wrap.')

  // 5b. Environment › Shortcuts: New Query's Ctrl+N removed and Shift+F9 assigned. Cancel discards both; OK stores them in
  // shortcuts.json and applies them to the File menu, the main window's keys and a popout's; a file that is not a
  // shortcuts file is refused without changing anything; Reset All brings Ctrl+N back.
  const newKey = mac ? '⌘N' : 'Ctrl+N'
  const shortcutsFile = () => readFile(join(profile, 'shortcuts.json'), 'utf8').then(JSON.parse, () => null)
  const queryTabs = () => documentTabSlots(page).count()
  const fileMenuKeys = async () => {
    await menubar(page).getByRole('menuitem', { name: 'File', exact: true }).click()
    const item = page.getByRole('menu', { name: 'File', exact: true }).getByRole('menuitem', { name: 'New Query', exact: true })
    await expect(item).toBeVisible()
    const keys = await item.getAttribute('aria-keyshortcuts')
    await page.keyboard.press('Escape')
    return keys
  }
  const editor = () => textbox().filter({ visible: true })
  /** Presses a key after `focus` in `target`'s window, and checks how many query tabs it opened (0 or 1). */
  const opens = async (target, focus, key, count) => {
    const before = await queryTabs()
    await focus()
    await target.keyboard.press(key)
    if (count) return expect.poll(queryTabs).toBe(before + count)
    // A key that runs nothing changes nothing: two frames are enough for one that would.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(await queryTabs()).toBe(before)
  }
  async function remapNewQuery() {
    await openOptions()
    await node('Shortcuts').click()
    await shortcutsSearch(dialog()).fill('New Query')
    await shortcutsRow(dialog(), 'New Query').click()
    const inspector = shortcutsInspector(dialog(), 'New Query')
    await inspector.getByRole('button', { name: 'Remove ' + newKey, exact: true }).click()
    const capture = inspector.getByLabel('Press shortcut keys', { exact: true })
    await capture.focus()
    await options.keyboard.press('Shift+F9')
    await expect(capture).toHaveValue(mac ? '⇧F9' : 'Shift+F9')
    await inspector.getByRole('button', { name: 'Assign', exact: true }).click()
    await expect(dialog()).toContainText('2 shortcut changes staged · applied on OK')
  }
  if (!mac) {
    await remapNewQuery()
    await clickToClose(dialog().getByRole('button', { name: 'Cancel', exact: true }))
    await closed()
    expect(await shortcutsFile()).toBeNull()
    expect(await fileMenuKeys()).toBe('Control+N')

    await remapNewQuery()
    await clickToClose(dialog().getByRole('button', { name: 'OK', exact: true }))
    await closed()
    await expect.poll(async () => (await shortcutsFile())?.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'file.new', key: 'mod+n', remove: true }), expect.objectContaining({ command: 'file.new', key: 'shift+f9' })
    ]))
    await expect.poll(fileMenuKeys).toBe('Shift+F9')
    await opens(page, () => editor().focus(), 'Control+n', 0)
    await opens(page, () => editor().focus(), 'Shift+F9', 1)
    // A popout routes keys through the same rules: Shift+F9 in the Results window opens a query in the main window.
    await toolbarButton(page, 'Connect').click()
    const { window: popoutConnectWin, dialog: popoutConnectDialog } = await connectDialogWindow(application)
    await popoutConnectDialog.getByLabel('Server Name', { exact: true }).fill('server-a')
    await popoutConnectDialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
    await submitConnect(popoutConnectWin, popoutConnectDialog)
    await editor().focus()
    await page.keyboard.press('Control+A')
    await page.keyboard.insertText('SELECT 1')
    await page.keyboard.press('F5')
    await expect(pane(page, 'results')).toBeVisible()
    const popped = application.waitForEvent('window', { timeout: 30000 })
    await movePane(page, 'results', 'window')
    const results = await popped
    results.setDefaultTimeout(15000)
    results.on('pageerror', error => failures.push(error.message))
    await expect(popoutTabs(results)).toBeVisible()
    await opens(results, () => resultGrid(results).click(), 'Shift+F9', 1)
    await dockPopoutBack(results)
    await expect(pane(page, 'results')).toBeVisible()

    // Import refuses a file that is not a shortcuts file, and says nothing changed.
    const notShortcuts = join(control, 'not-shortcuts.json')
    await writeFile(notShortcuts, 'this is not JSON')
    await application.evaluate(({ dialog: dialogs }, path) => { dialogs.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, notShortcuts)
    await openOptions()
    await node('Shortcuts').click()
    await dialog().getByRole('button', { name: 'Import…', exact: true }).click()
    const refused = shortcutsSheet(dialog(), 'This file cannot be imported')
    await expect(refused).toContainText('Nothing was changed.')
    await refused.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(refused).toHaveCount(0)
    await expect(dialog()).not.toContainText('staged · applied on OK')

    // Reset All, then OK: the file keeps no bindings and Ctrl+N is New Query's again.
    await dialog().getByRole('button', { name: 'Reset All…', exact: true }).click()
    const reset = shortcutsSheet(dialog(), 'Reset all shortcuts?')
    await reset.getByRole('button', { name: 'Reset All', exact: true }).click()
    await expect(reset).toHaveCount(0)
    await expect(dialog()).toContainText('2 shortcut changes staged · applied on OK')
    await clickToClose(dialog().getByRole('button', { name: 'OK', exact: true }))
    await closed()
    await expect.poll(async () => { const file = await shortcutsFile(); return file && (file.bindings ?? []) }).toEqual([])
    await expect.poll(fileMenuKeys).toBe('Control+N')
    await opens(page, () => editor().focus(), 'Control+n', 1)
    console.log('Options checks: Shortcuts remaps New Query; Cancel discards it, OK applies it to the menu, the main window and a popout, a bad import is refused, and Reset All restores Ctrl+N.')
  }

  // 6. A value this version does not support is reset and named in a warning; the file is kept, the rest stays.
  await close()
  await writeFile(settingsFile(), JSON.stringify({ version: 1, values: { 'textEditor.sql.tabSize': 0, 'queryExecution.executionTimeout': 30 } }))
  await launch()
  const banner = warningBanner().filter({ hasText: 'Tab size' })
  await expect(banner).toHaveText('Some settings had values this version does not support (Tab size) and were reset to their defaults; the original file was kept.')
  expect((await readdir(profile)).filter(name => /^settings\.json\.invalid-[0-9a-f-]{36}\.json$/.test(name))).toHaveLength(1)
  expect(await stored()).toEqual({ version: 1, values: { 'queryExecution.executionTimeout': 30 } })
  await openOptions()
  await node('Query Execution').click()
  await expect(field('Execution time-out')).toHaveValue('30')
  await pressToClose(options, 'Escape')
  await closed()
  await page.reload()
  await expectEditorShown(page)
  // The workbench asked main for its settings before this call, so its answer is in once this one is.
  await page.evaluate(async () => { await window.varia.getSettings(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
  await expect(banner).toHaveCount(0)
  console.log('Options checks: an unsupported value is reset with a warning naming it, the original kept, the rest kept, once.')

  // 7. A profile with only an earlier version's scripting-options.json: its options are imported, and it is left alone.
  await close()
  profile = await mkdtemp(resolve('artifacts', 'options-legacy-'))
  const legacy = JSON.stringify({ version: 1, options: { scriptUseDatabase: false } })
  await writeFile(join(profile, 'scripting-options.json'), legacy)
  await launch()
  await openOptions()
  await node('SQL Server Object Explorer').click()
  await node('Scripting').click()
  await expect(field('Script USE <database>')).toHaveValue('false')
  await pressToClose(options, 'Escape')
  await closed()
  expect(await stored()).toEqual({ version: 1, values: { 'objectExplorer.scripting.scriptUseDatabase': false } })
  expect(await readFile(join(profile, 'scripting-options.json'), 'utf8')).toBe(legacy)
  console.log('Options checks: scripting-options.json is imported into settings.json once and left as it was.')

  expect(failures).toEqual([])
  await close()
  console.log('Options suite passed.')
} catch (error) {
  console.error(error)
  if (page) await page.screenshot({ path: resolve('artifacts', 'options-failure.png') }).catch(() => {})
  process.exitCode = 1
  await close().catch(() => application?.process()?.kill())
} finally {
  clearTimeout(watchdog)
}
