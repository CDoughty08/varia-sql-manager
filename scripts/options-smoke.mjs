import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expandExplorerPath, explorerRow } from './fixtures/explorer-tree.mjs'
import { resizeContent } from './fixtures/window-resize.mjs'
import { editorText as editorTextOf, optionsDescription, optionsForm, optionsHeading, optionsNotes, toolbarButton, warningBanner as warningBannerOf } from './fixtures/ui.mjs'

// Tools › Options over the fake backend (tests/fixtures/backend.mjs, workbench mode), which records each request in
// calls.jsonl: the page tree, search, form and property-grid pages, what OK saves to settings.json and what the
// workbench then does with it, recovery from a damaged file, and migration from scripting-options.json.
await mkdir('artifacts', { recursive: true })
const control = await mkdtemp(resolve('artifacts', 'options-backend-'))
const mac = process.platform === 'darwin'
let profile, application, page
const failures = []
const watchdog = setTimeout(() => { console.error('Options suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 420000)
const fast = { force: true }

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
  await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
}
// Unsaved queries make a normal exit ask first; answer Don't Save.
async function close() {
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await application.close()
}
const textbox = () => page.locator('.monaco-editor [role="textbox"]')
const dialog = () => page.getByRole('dialog', { name: 'Options', exact: true })
const tree = () => dialog().getByRole('tree', { name: 'Options pages', exact: true })
const node = name => tree().getByRole('treeitem', { name, exact: true })
const field = label => dialog().getByLabel(label, { exact: true })
const heading = () => optionsHeading(dialog())
const search = () => dialog().getByRole('searchbox', { name: 'Search Options', exact: true })
const warningBanner = () => warningBannerOf(page)
const calls = async method => (await readFile(join(control, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.method === method).map(call => call.params)
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
  await expect(dialog()).toBeVisible()
}
/** Shows a page by clicking each node of its path; a category shows its first page. */
async function showPage(...path) {
  for (const name of path) await node(name).click(fast)
  await expect(heading()).toContainText(path.join(' › '))
}
const searchKey = mac ? 'Meta+e' : 'Control+e'
const treeNames = () => tree().getByRole('treeitem').evaluateAll(items => items.map(item => '  '.repeat(Number(item.getAttribute('aria-level')) - 1) + item.textContent))
const layout = () => page.evaluate(() => {
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
  await expect(heading()).toHaveText('Environment › General')
  await expect(node('General').first()).toHaveAttribute('aria-selected', 'true')
  await expect(optionsNotes(dialog()).first()).toHaveText('Color theme: View › Theme')
  for (const name of ['Text Editor', 'Transact-SQL', 'Query Execution', 'Query Results', 'SQL Server Object Explorer']) await node(name).click(fast)
  expect(await treeNames()).toEqual([
    'Environment', '  General', '  AutoRecover', '  Documents', '  Fonts and Colors', '  Keyboard', '  Live Data', 'Text Editor', '  General', '  Editor Tab and Status Bar', '  Transact-SQL', '    General', '    Tabs', 'Query Execution', '  SQL Server', '    General', '    Advanced',
    'Query Results', '  SQL Server', '    Results to Grid', 'SQL Server Object Explorer', '  Commands', '  Scripting'
  ])
  await expect(heading()).toHaveText('SQL Server Object Explorer › Commands')
  // The tree's keys: Up and Down show the page they reach, Left goes to the parent, Home to the first node.
  await node('Scripting').focus()
  await page.keyboard.press('ArrowUp')
  await expect(node('Commands')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(node('SQL Server Object Explorer')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(node('Environment')).toBeFocused()
  await expect(heading()).toHaveText('Environment › General')
  // The Keyboard page explains that shortcuts follow SSMS's and cannot be changed yet.
  await node('Keyboard').click(fast)
  await expect(optionsNotes(dialog())).toContainText('cannot be changed yet')
  // Fonts and Colors says where colors are set, above its Size row and while that row is focused.
  await node('Fonts and Colors').click(fast)
  await field('Size').focus()
  await expect(optionsNotes(dialog())).toHaveText('Colors come from the color theme (View › Theme).')
  await expect(optionsDescription(dialog())).toContainText('Size')
  // Environment › AutoRecover has SSMS's defaults (on, every 5 minutes, kept 7 days); off greys both numbers.
  await node('AutoRecover').click(fast)
  await expect(field('Save AutoRecover information')).toBeChecked()
  await expect(field('Save AutoRecover information every')).toHaveValue('5')
  await expect(field('Keep AutoRecover information for')).toHaveValue('7')
  await field('Save AutoRecover information').uncheck()
  await expect(field('Save AutoRecover information every')).toBeDisabled()
  await expect(field('Keep AutoRecover information for')).toBeDisabled()
  await field('Save AutoRecover information').check()
  await expect(field('Keep AutoRecover information for')).toBeEnabled()
  // Environment › Live Data (Varia's own page): hidden views pause after 2 s and stop after 5 min; off greys both delays.
  await node('Live Data').click(fast)
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
  console.log('Options checks: Alt+T, O opens Environment › General with the search box focused, the tree has SSMS\'s 22 nodes plus Live Data and its keys, AutoRecover has SSMS\'s defaults, and Live Data its own.')

  // 2. Ctrl+E (⌘E) searches: "time-out" leaves Query Execution › SQL Server › General, highlighted; Escape clears, then closes.
  await node('Keyboard').focus()
  await page.keyboard.press(searchKey)
  await expect(search()).toBeFocused()
  await page.keyboard.type('time-out')
  expect(await treeNames()).toEqual(['Query Execution', '  SQL Server', '    General'])
  await expect(heading()).toHaveText('Query Execution › SQL Server › General')
  await expect(optionsForm(dialog()).locator('mark')).toHaveText('time-out')
  await page.keyboard.type('zzz')
  await expect(dialog().getByText('No settings match.', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(search()).toHaveValue('')
  await expect(dialog()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog()).toHaveCount(0)
  console.log('Options checks: Ctrl+E focuses the search, which filters the tree and highlights matches; Escape clears it, then cancels.')

  // 3. Changes on five pages, one OK: settings.json holds exactly the changed keys, and each takes effect.
  await openOptions()
  // The dialog opens on the page last shown.
  await expect(heading()).toHaveText('Query Execution › SQL Server › General')
  await field('Execution time-out').fill('7')
  await node('Advanced').click(fast)
  await field('Stop the script at the first batch that raises an error').check()
  await field('Stop the script at the first batch that raises an error').focus()
  await expect(optionsDescription(dialog())).toContainText('Not in SSMS.')
  await showPage('Text Editor', 'Transact-SQL')
  await field('Word wrap').check()
  await node('Tabs').click(fast)
  await field('Tab size').fill('2')
  await field('Indent size').fill('2')
  // SSMS's default is Keep tabs; with Insert spaces, Tab inserts an indent's two columns as spaces.
  await dialog().getByRole('radio', { name: 'Insert spaces', exact: true }).check()
  await showPage('SQL Server Object Explorer', 'Commands')
  await field('Value for Select Top <n> Rows command').fill('50')
  await dialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  await expect.poll(stored).toEqual({ version: 1, values: {
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
  await toolbarButton(page, 'Connect').click(fast)
  await page.getByLabel('Server Name', { exact: true }).fill('server-a')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click(fast)
  await expect(page.getByRole('dialog')).toHaveCount(0)
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
    await explorerMenu.getByRole('menuitem', { name: 'Select Top 50 Rows', exact: true }).click(fast)
    await expect.poll(async () => (await calls('query.execute')).at(-1)?.sql).toContain('SELECT TOP (50) [Id]')
  }
  console.log('Options checks: one OK saves five pages\' changes as overrides only; Tab, word wrap, F5\'s time-out and stop-on-error, and Select Top 50 Rows follow them.')

  // 4. OK refuses an out-of-range value, shows why and focuses the field; Cancel discards a draft that spans two pages.
  await openOptions()
  await node('Query Execution').click(fast)
  await field('Execution time-out').fill('99999')
  await showPage('Text Editor', 'Transact-SQL', 'Tabs')
  await expect(heading()).toHaveText('Text Editor › Transact-SQL › Tabs')
  await field('Tab size').fill('3')
  await dialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(heading()).toHaveText('Query Execution › SQL Server › General')
  await expect(dialog().getByText('Execution time-out must be a whole number from 0 to 86,400.', { exact: true })).toBeVisible()
  await expect(field('Execution time-out')).toBeFocused()
  await dialog().getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  expect((await stored()).values).toMatchObject({ 'queryExecution.executionTimeout': 7, 'textEditor.sql.tabSize': 2 })
  await openOptions()
  await expect(field('Execution time-out')).toHaveValue('7')
  await page.keyboard.press('Escape')
  console.log('Options checks: OK names the bounds of an out-of-range value and focuses it; Cancel discards a draft across pages.')

  // 10. At 1024×768 the dialog fits; screenshots in Dark and Light (the window keeps this size from here on).
  await resizeContent(application, page, 1024, 768)
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024)
  await openOptions()
  await node('SQL Server Object Explorer').click(fast)
  await node('Scripting').click(fast)
  expect(await layout()).toEqual({ inside: true, overflow: false })
  await page.screenshot({ path: resolve('artifacts', 'options-dark.png') })
  // A form page: checkboxes, number fields with their units, and radio buttons.
  await showPage('Text Editor', 'Transact-SQL', 'Tabs')
  expect(await layout()).toEqual({ inside: true, overflow: false })
  await page.screenshot({ path: resolve('artifacts', 'options-form-dark.png') })
  await page.keyboard.press('Escape')
  await menu('theme.mode.light')
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe('light')
  await openOptions()
  expect(await layout()).toEqual({ inside: true, overflow: false })
  await page.screenshot({ path: resolve('artifacts', 'options-light.png') })
  await page.keyboard.press('Escape')
  await menu('theme.mode.dark')
  console.log('Options checks: the dialog fits at 1024×768 in Dark and Light (artifacts/options-dark.png, options-form-dark.png, options-light.png).')

  // 5. A restart keeps the values; Alt+Z toggles word wrap and saves it.
  await close()
  await launch()
  await openOptions()
  await showPage('Text Editor', 'Transact-SQL')
  await expect(field('Word wrap')).toBeChecked()
  await page.keyboard.press('Escape')
  if (!mac) {
    await textbox().focus()
    await page.keyboard.press('Alt+z')
    await expect.poll(async () => (await stored())?.values['textEditor.sql.wordWrap']).toBeUndefined()
    await page.keyboard.press('Alt+z')
    await expect.poll(async () => (await stored())?.values['textEditor.sql.wordWrap']).toBe(true)
  }
  console.log('Options checks: the values survive a restart, and Alt+Z saves word wrap.')

  // 6. A value this version does not support is reset and named in a warning; the file is kept, the rest stays.
  await close()
  await writeFile(settingsFile(), JSON.stringify({ version: 1, values: { 'textEditor.sql.tabSize': 0, 'queryExecution.executionTimeout': 30 } }))
  await launch()
  const banner = warningBanner().filter({ hasText: 'Tab size' })
  await expect(banner).toHaveText('Some settings had values this version does not support (Tab size) and were reset to their defaults; the original file was kept.')
  expect((await readdir(profile)).filter(name => /^settings\.json\.invalid-[0-9a-f-]{36}\.json$/.test(name))).toHaveLength(1)
  expect(await stored()).toEqual({ version: 1, values: { 'queryExecution.executionTimeout': 30 } })
  await openOptions()
  await node('Query Execution').click(fast)
  await expect(field('Execution time-out')).toHaveValue('30')
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
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
  await node('SQL Server Object Explorer').click(fast)
  await node('Scripting').click(fast)
  await expect(field('Script USE <database>')).toHaveValue('false')
  await page.keyboard.press('Escape')
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
