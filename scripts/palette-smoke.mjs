import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { explorerRow, explorerStatics, explorerTree } from './fixtures/explorer-tree.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'palette-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const appearanceFile = join(profile, 'appearance.json')
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Palette suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 180000)

async function launch() {
  application = await electron.launch(launchOptions)
  page = await application.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.getByText(/\.NET 10\..*Ready/)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true })
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    // Unsaved queries make a normal exit ask first; answer Don't Save.
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
}
async function nativeKey(keyCode, modifiers = []) {
  await application.evaluate(({ BrowserWindow }, key) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', ...key })
    contents.sendInputEvent({ type: 'keyUp', ...key })
  }, { keyCode, modifiers })
}
// Every theme change rebuilds the application menu, so items are looked up afresh each time.
const menuItem = id => application.evaluate(({ Menu }, itemId) => {
  const item = Menu.getApplicationMenu().getMenuItemById(itemId)
  return item ? { enabled: item.enabled, checked: item.checked } : null
}, id)
const clickMenu = id => application.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu().getMenuItemById(itemId).click(), id)
const calls = method => application.evaluate((_electron, name) => globalThis.variaCalls.filter(call => call.method === name).length, method)
const textbox = () => page.locator('.monaco-editor [role="textbox"]')
const editorText = () => page.locator('.monaco-editor .view-lines').innerText()
const tabs = () => page.locator('.query-tabs').getByRole('tab')
const selectedTab = () => page.locator('.query-tabs').getByRole('tab', { selected: true }).getAttribute('aria-label')
const widget = () => page.locator('.quick-input')
const combobox = name => page.getByRole('combobox', { name, exact: true })
const activeId = () => page.locator('.quick-input [role="combobox"]').getAttribute('aria-activedescendant')
/** The option aria-activedescendant names, as the screen reader sees it. */
const activeOption = () => page.evaluate(() => {
  const id = document.querySelector('.quick-input [role="combobox"]')?.getAttribute('aria-activedescendant')
  const option = id ? document.getElementById(id) : null
  return option && { role: option.getAttribute('role'), selected: option.getAttribute('aria-selected'), disabled: option.getAttribute('aria-disabled'), name: option.getAttribute('aria-label'), text: option.textContent }
})
const variable = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--varia-editor-background').trim().toLowerCase())
const windowBackground = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase())
// expect.poll does not retry a callback that throws, and appearance.json appears only after the first choice.
const appearance = () => readFile(appearanceFile, 'utf8').catch(() => null)
async function typeSql(sql) {
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(sql)
  await expect.poll(editorText).toContain(sql.replaceAll(' ', '\u00a0'))
}
/** Opens the command palette from the editor and filters it, checking which command Enter would run. */
async function palette(filter, expected) {
  await textbox().focus()
  await page.keyboard.press('F1')
  await expect(combobox('Command Palette')).toBeFocused()
  await page.keyboard.type(filter)
  await expect.poll(async () => (await activeOption())?.name).toMatch(new RegExp('^' + expected))
}
async function themePicker() {
  await palette('color theme', 'Preferences: Color Theme…')
  await page.keyboard.press('Enter')
  await expect(combobox('Select Color Theme')).toBeFocused()
}

try {
  await launch()

  // 1. F1 in the editor opens the palette in '>' mode with an active option; Escape puts focus back.
  await textbox().focus()
  await page.keyboard.press('F1')
  await expect(combobox('Command Palette')).toBeFocused()
  await expect(combobox('Command Palette')).toHaveValue('>')
  expect(await activeOption()).toMatchObject({ role: 'option', selected: 'true' })
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  await expect(widget()).toHaveCount(0)
  // F10 closes the palette for the menu bar; Escape there returns to the editor, since the palette's input is gone.
  await page.keyboard.press('F1')
  await expect(combobox('Command Palette')).toBeFocused()
  await page.keyboard.press('F10')
  await expect(page.getByRole('menuitem', { name: 'File', exact: true })).toBeFocused()
  await expect(widget()).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()

  // 2. Filtering shows the key; Enter runs the command and returns focus to the editor.
  await page.keyboard.press('Control+Shift+P')
  await expect(combobox('Command Palette')).toBeFocused()
  await page.keyboard.type('new query')
  await expect.poll(async () => (await activeOption())?.text).toContain('File: New Query')
  expect((await activeOption()).text).toContain('Ctrl+N')
  // The key keeps a visible outline on the active row's fill, and an edge marks the row by more than its hue.
  expect(await widget().locator('.quick-input-row.active kbd').evaluate(kbd => { const style = getComputedStyle(kbd); return style.borderTopColor === style.color })).toBe(true)
  expect(await widget().locator('.quick-input-row.active').evaluate(row => getComputedStyle(row).boxShadow)).toMatch(/inset/)
  await page.keyboard.press('Enter')
  await expect(tabs()).toHaveCount(2)
  await expect(widget()).toHaveCount(0)
  await expect(textbox()).toBeFocused()

  // 3. Keys from the operating system (sendInputEvent, through main) reach the same dispatcher.
  await nativeKey('P', ['control', 'shift'])
  await expect(combobox('Command Palette')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(widget()).toHaveCount(0)
  console.log('Palette checks: F1, Ctrl+Shift+P, and native keys open the palette; Enter runs a command; Escape restores focus.')

  // 4. Keyboard navigation, Tab containment, and the result count announcement.
  await textbox().focus()
  await page.keyboard.press('F1')
  const seen = [await activeId()]
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'Control+End', 'Control+Home']) {
    await page.keyboard.press(key)
    await expect.poll(activeId).not.toBe(seen.at(-1))
    seen.push(await activeId())
  }
  expect(seen[4]).not.toBe(seen[0])
  expect(seen[5]).toBe(seen[0])
  await page.keyboard.press('Tab')
  await expect(combobox('Command Palette')).toBeFocused()
  await page.keyboard.type('zzzz')
  await expect(widget().getByRole('status')).toHaveText('No matching commands')
  await expect(widget().locator('.quick-input-empty')).toHaveText('No matching commands')
  await page.keyboard.press('Escape')

  // 5. Focus is back in the editor before the command runs, so Undo acts on the editor.
  await typeSql('SELECT 1;')
  await palette('edit undo', 'Edit: Undo')
  await page.keyboard.press('Enter')
  await expect.poll(editorText).not.toContain('SELECT\u00a01;')
  // Edit \u203a Undo from the menu (how \u2318Z in the input arrives on macOS) undoes the palette's text and leaves it open.
  await typeSql('SELECT 7;')
  await textbox().focus()
  await page.keyboard.press('F1')
  await page.keyboard.type('abc')
  await clickMenu('edit.undo')
  await expect(combobox('Command Palette')).not.toHaveValue('>abc')
  await expect(combobox('Command Palette')).toBeFocused()
  expect(await editorText()).toContain('SELECT\u00a07;')
  // So do Select All and Delete, which the macOS menu bar runs as commands (\u2318A in the input arrives that way): main
  // sends their ids as it does there, and they select and delete the palette's text, not the editor's.
  await page.keyboard.type('def')
  const field = widget().getByRole('combobox')
  const sendCommand = id => application.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('varia:command', command), id)
  await sendCommand('edit.selectAll')
  await expect.poll(() => field.evaluate(input => input.value.length > 0 && input.selectionStart === 0 && input.selectionEnd === input.value.length)).toBe(true)
  await expect(field).toBeFocused()
  await sendCommand('edit.delete')
  await expect(field).toHaveValue('')
  await expect(widget()).toHaveCount(1)
  expect(await editorText()).toContain('SELECT\u00a07;')
  await page.keyboard.press('Escape')

  // 6. A disabled command explains itself and keeps the palette open.
  await palette('execute', 'Query: Execute')
  // aria-disabled says it is unavailable; the name does not repeat it.
  expect(await activeOption()).toMatchObject({ disabled: 'true', name: 'Query: Execute, F5' })
  // Matches on a dimmed row are dimmed too, and so is the key of the active one.
  expect(await widget().locator('.quick-input-row.disabled:not(.active)').first().evaluate(row => getComputedStyle(row.querySelector('.quick-input-hl')).color === getComputedStyle(row.querySelector('.quick-input-label')).color)).toBe(true)
  expect(await widget().locator('.quick-input-row.active.disabled').evaluate(row => getComputedStyle(row.querySelector('kbd')).color === getComputedStyle(row.querySelector('.quick-input-label')).color)).toBe(true)
  // The live region stays in the accessibility tree while empty, so the hint is announced when it arrives.
  const message = widget().locator('.quick-input-message[aria-live="polite"]')
  expect(await message.evaluate(element => getComputedStyle(element).display)).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect(message).toHaveText('Connect this query to a server and wait for its running query to finish.')
  await expect(combobox('Command Palette')).toBeFocused()
  // Enter again puts the hint in a new text node, so it is announced again.
  await message.locator('span').evaluate(span => { span.dataset.announced = 'true' })
  await page.keyboard.press('Enter')
  await expect(message.locator('span')).not.toHaveAttribute('data-announced', 'true')
  await expect(message).toHaveText('Connect this query to a server and wait for its running query to finish.')
  await page.screenshot({ path: resolve('artifacts', 'palette-dark.png') })
  await page.keyboard.press('Escape')
  console.log('Palette checks: keyboard navigation, focus restored before commands run, and disabled-command hints.')

  // 7. The native menu bridge: clicks run commands, items follow the renderer's state, and Alt+Q opens the Query menu.
  await clickMenu('workbench.showCommands')
  await expect(combobox('Command Palette')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect.poll(() => menuItem('query.execute')).toMatchObject({ enabled: false })
  await textbox().focus()
  await page.keyboard.press('Alt+Z')
  await expect.poll(() => menuItem('editor.toggleWordWrap')).toMatchObject({ checked: true })
  await clickMenu('editor.toggleWordWrap')
  await expect.poll(() => menuItem('editor.toggleWordWrap')).toMatchObject({ checked: false })
  // The title-bar Query menu opens with its first item focused; the custom menus show the same enablement.
  await textbox().focus()
  await page.keyboard.press('Alt+q')
  const queryMenu = page.getByRole('menu', { name: 'Query', exact: true })
  await expect(queryMenu).toBeVisible()
  await expect(queryMenu.getByRole('menuitem', { name: 'Connection', exact: true })).toBeFocused()
  await expect(queryMenu.getByRole('menuitem', { name: 'Execute', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  console.log('Palette checks: native menu clicks, enablement, checkbox state, and the Query menu mnemonic.')

  // Stub SQL responses so connected commands run without a server.
  const health = await page.evaluate(() => window.varia.health())
  expect(health.ok).toBe(true)
  await application.evaluate(({ ipcMain }, { realHealth, statics }) => {
    globalThis.variaCalls = []
    globalThis.variaConnections = {}
    ipcMain.removeHandler('varia:request')
    ipcMain.handle('varia:request', async (_event, method, params) => {
      globalThis.variaCalls.push({ method, params })
      if (method === 'system.health') return { ok: true, value: realHealth }
      if (method === 'connections.connect') {
        const info = { id: crypto.randomUUID(), server: params.server, database: params.database || 'master', serverVersion: '17.0.test' }
        globalThis.variaConnections[info.id] = info
        return { ok: true, value: info }
      }
      if (method === 'connections.disconnect') { delete globalThis.variaConnections[params.connectionId]; return { ok: true, value: { disconnected: true } } }
      if (method === 'databases.list') return { ok: true, value: [
        { name: 'master', isSystem: true, isSnapshot: false },
        { name: 'tempdb', isSystem: true, isSnapshot: false },
        { name: 'AppData', isSystem: false, isSnapshot: false },
        { name: 'AppData_Snapshot', isSystem: false, isSnapshot: true }
      ] }
      // Object Explorer: the catalogue's static folders, and AppData in Databases.
      if (method === 'explorer.children') {
        const { node } = params, owner = node.type === 'object' ? node.object : node.owner
        const nodes = (node.type === 'object' ? statics.objects[node.object.kind] : statics.folders[node.folder]).map(folder => ({ ref: { type: 'folder', owner, folder }, label: statics.labels[folder], icon: 'folder', hasChildren: true }))
        if (node.type === 'folder' && node.folder === 'databases') nodes.push({ ref: { type: 'object', object: { kind: 'database', name: 'AppData' } }, label: 'AppData', icon: 'svg:database', hasChildren: true })
        return { ok: true, value: { nodes, total: nodes.length, elapsedMs: 1 } }
      }
      if (method === 'query.session.close') return { ok: true, value: { closed: true } }
      // Rows live in the backend's result store, which a stub does not have; the summary's messages carry the target.
      if (method === 'query.execute') return { ok: true, value: {
        resultSets: [], discardedResultSets: 0, messages: [`Executed on ${globalThis.variaConnections[params.connectionId].server} in ${params.database}`],
        recordsAffected: -1, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1, database: params.database, messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1 }
      } }
      return { ok: false, error: 'Unsupported test operation.' }
    })
  }, { realHealth: health.value, statics: explorerStatics() })

  // 8. Connecting enables Execute in the native menu; Ctrl+U picks the query's database.
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByLabel('Server Name', { exact: true }).fill('server-a')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const explorer = await explorerRow(page, 'server-a')
  await expect(explorer).toBeVisible()
  await expect.poll(() => menuItem('query.execute')).toMatchObject({ enabled: true })
  await textbox().focus()
  await page.keyboard.press('Control+U')
  await expect(combobox('Change Database')).toBeFocused()
  for (const name of ['master', 'tempdb', 'AppData', 'AppData_Snapshot']) await expect(widget().getByRole('option', { name: new RegExp('^' + name + '(,|$)') })).toHaveCount(1)
  await page.keyboard.type('AppD')
  await page.keyboard.press('Enter')
  await expect(page.locator('#query-database')).toHaveValue('AppData')
  await expect(textbox()).toBeFocused()

  // 9. Ctrl+K belongs to the editor: Ctrl+K Ctrl+U uncomments instead of opening Change Database.
  await typeSql('-- x')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Control+K')
  await page.keyboard.press('Control+U')
  await expect.poll(editorText).toBe('x')
  await expect(widget()).toHaveCount(0)

  // 10. F5 refreshes Object Explorer's selected node when the tree has focus, and executes in the editor.
  const listed = await calls('explorer.children')
  await explorer.click()
  await expect(explorerTree(page)).toBeFocused()
  await page.keyboard.press('F5')
  await expect.poll(() => calls('explorer.children')).toBeGreaterThan(listed)
  const executed = await calls('query.execute')
  await textbox().focus()
  await page.keyboard.press('F5')
  await expect.poll(() => calls('query.execute')).toBe(executed + 1)
  await expect(page.locator('.messages')).toContainText('Executed on server-a in AppData')
  // F8 moves focus to Object Explorer, as in SSMS, so the F5 after it refreshes rather than executes.
  await textbox().focus()
  const refreshed = await calls('explorer.children'), ran = await calls('query.execute')
  await page.keyboard.press('F8')
  await expect(explorerTree(page)).toBeFocused()
  await page.keyboard.press('F5')
  await expect.poll(() => calls('explorer.children')).toBeGreaterThan(refreshed)
  expect(await calls('query.execute')).toBe(ran)

  // 11. A double-click or a held Enter on a command that opens a picker picks nothing there, and choosing the query's
  // own server again keeps its session.
  const disconnects = await calls('connections.disconnect'), comboboxName = () => page.locator('.quick-input [role="combobox"]').getAttribute('aria-label')
  await palette('disconnect from', 'Connection: Disconnect from Server…')
  await widget().locator('.quick-input-row.active').dblclick()
  expect(await comboboxName()).toBe('Disconnect from Server')
  await expect(combobox('Disconnect from Server')).toBeFocused()
  await page.keyboard.press('Escape')
  await palette('disconnect from', 'Connection: Disconnect from Server…')
  await page.keyboard.down('Enter')
  await page.keyboard.down('Enter')
  await page.keyboard.up('Enter')
  expect(await comboboxName()).toBe('Disconnect from Server')
  await page.keyboard.press('Escape')
  await expect(widget()).toHaveCount(0)
  expect(await calls('connections.disconnect')).toBe(disconnects)
  await expect(explorer).toBeVisible()
  const closes = await calls('query.session.close')
  await palette('change connection', 'Query: Change Connection…')
  await page.keyboard.press('Enter')
  await expect(combobox('Change Connection')).toBeFocused()
  expect((await activeOption()).name).toMatch(/^server-a,/)
  await page.keyboard.press('Enter')
  await expect(widget()).toHaveCount(0)
  expect(await calls('query.session.close')).toBe(closes)

  // 12. Go to Query opens on the previous query, so Ctrl+P then Enter switches between the last two.
  const current = await selectedTab()
  await textbox().focus()
  await page.keyboard.press('Control+P')
  await expect(combobox('Go to Query')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(selectedTab).not.toBe(current)
  await expect(textbox()).toBeFocused()
  console.log('Palette checks: database picker, chord pass-through, F5 by focus, F8 focus, double-click and held Enter guards, the current server kept, and Go to Query.')

  // 13. Behind a modal dialog, workbench keys neither run nor are consumed, and Edit › Undo (how ⌘Z arrives on macOS)
  // does not reach into the editor behind it.
  await typeSql('SELECT 42;')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('F1')
  await page.keyboard.press('Control+N')
  const cancel = page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true })
  await cancel.focus()
  // The workbench's command listener comes first, so once this one has seen the click, Undo has run.
  await page.evaluate(() => { globalThis.variaSeenCommands = []; globalThis.variaStopSeeing = window.varia.onCommand(id => globalThis.variaSeenCommands.push(id)) })
  await clickMenu('edit.undo')
  await expect.poll(() => page.evaluate(() => globalThis.variaSeenCommands.length)).toBe(1)
  await page.evaluate(() => globalThis.variaStopSeeing())
  await expect(cancel).toBeFocused()
  expect(await editorText()).toContain('SELECT\u00a042;')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(widget()).toHaveCount(0)
  await expect(tabs()).toHaveCount(2)

  // 14. The Color Theme picker previews without saving, Escape restores, and Enter chooses like the menu.
  const saved = await appearance()
  await themePicker()
  await page.keyboard.type('varia light')
  await expect.poll(variable).toBe('#ffffff')
  await expect.poll(windowBackground).toBe('#ffffff')
  expect(await appearance()).toBe(saved)
  await page.keyboard.press('Escape')
  await expect.poll(variable).toBe('#11151c')
  await expect.poll(windowBackground).toBe('#11151c')
  expect(await appearance()).toBe(saved)
  await themePicker()
  await page.keyboard.type('varia light')
  await expect.poll(variable).toBe('#ffffff')
  await page.keyboard.press('Enter')
  await expect.poll(async () => JSON.parse(await appearance() ?? '{}').mode).toBe('light')
  await expect.poll(() => menuItem('theme.mode.light')).toMatchObject({ checked: true })
  await expect(textbox()).toBeFocused()
  await palette('execute', 'Query: Execute')
  await page.keyboard.press('Enter')
  await expect(widget().locator('.quick-input-message')).not.toBeEmpty()
  await page.screenshot({ path: resolve('artifacts', 'palette-light.png') })
  await page.keyboard.press('Escape')
  await themePicker()
  await page.keyboard.type('dark')
  await page.keyboard.press('Enter')
  await expect.poll(async () => JSON.parse(await appearance() ?? '{}').mode).toBe('dark')
  await expect.poll(variable).toBe('#11151c')
  await expect.poll(windowBackground).toBe('#11151c')
  console.log('Palette checks: modal dialogs block workbench keys; the Color Theme picker previews, cancels, and chooses.')

  // 15. An Enter that ends an IME composition never accepts a row.
  await palette('new query', 'File: New Query')
  await page.evaluate(() => document.querySelector('.quick-input [role="combobox"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
  // Keys are handled in order, so had that Enter accepted the row, this key would reach the new query instead.
  await page.keyboard.type('x')
  await expect(combobox('Command Palette')).toHaveValue('>new queryx')
  await expect(combobox('Command Palette')).toBeFocused()
  await expect(tabs()).toHaveCount(2)
  await page.keyboard.press('Escape')

  // 16. Rapid open and close, long input, and the codicon font.
  await textbox().focus()
  for (let round = 0; round < 20; round++) { await page.keyboard.press('F1'); await page.keyboard.press('Escape') }
  await expect(widget()).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  await page.keyboard.press('F1')
  await page.keyboard.insertText('x'.repeat(200))
  await expect(widget().getByRole('status')).toHaveText('No matching commands')
  await page.keyboard.press('Escape')
  await expect(widget()).toHaveCount(0)
  expect(await page.evaluate(async () => (await document.fonts.load('16px codicon')).length)).toBeGreaterThan(0)
  await page.keyboard.press('F1')
  expect(await widget().locator('.codicon').first().evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/codicon/)
  await page.keyboard.press('Escape')
  expect(failures).toEqual([])

  // 17. Recently used commands come first, and survive a restart.
  await palette('reset layout', 'View: Reset Layout')
  await page.keyboard.press('Enter')
  await expect(widget()).toHaveCount(0)
  await textbox().focus()
  await page.keyboard.press('F1')
  await expect(widget().locator('.quick-input-row').first()).toContainText('View: Reset Layout')
  await expect(widget().locator('.quick-input-row').first()).toContainText('recently used')
  await page.keyboard.press('Escape')
  await application.evaluate(({ session }) => session.defaultSession.flushStorageData())
  await application.close()
  await launch()
  await textbox().focus()
  await page.keyboard.press('F1')
  await expect(widget().locator('.quick-input-row').first()).toContainText('View: Reset Layout')
  await page.keyboard.press('Escape')
  expect(failures).toEqual([])
  console.log('Palette checks passed: open and close paths, keyboard navigation, focus restoration, disabled hints, native menu state, pickers, chord pass-through, F5 by focus, Go to Query, modal blocking, theme preview, IME, robustness, codicons, and recently used commands across a restart.')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'palette-failure.png') }).catch(() => {})
  console.log(await page?.evaluate(() => ({ focused: document.activeElement?.outerHTML.slice(0, 300), errors: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent) })).catch(() => 'no page'))
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
}
