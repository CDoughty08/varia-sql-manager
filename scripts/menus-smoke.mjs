import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'menus-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const appearanceFile = join(profile, 'appearance.json'), savedPath = join(profile, 'menus-saved.sql')
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Menus suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 240000)

const menubar = () => page.getByRole('menubar', { name: 'Application menu' })
const menubarItem = name => menubar().getByRole('menuitem', { name, exact: true })
const menu = name => page.getByRole('menu', { name, exact: true })
const openMenus = () => page.locator('.menu')
const textbox = () => page.locator('.monaco-editor [role="textbox"]')
const editorText = () => page.locator('.monaco-editor .view-lines').innerText()
const tabs = () => page.locator('.query-tabs').getByRole('tab')
const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText())
const zoomLevel = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())
const variable = key => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), '--varia-' + key.replaceAll('.', '-'))
// expect.poll does not retry a callback that throws, and appearance.json appears only after the first choice.
const appearance = () => readFile(appearanceFile, 'utf8').catch(() => null)
const nativeItem = id => application.evaluate(({ Menu }, itemId) => {
  const item = Menu.getApplicationMenu().getMenuItemById(itemId)
  return item ? { checked: item.checked, enabled: item.enabled } : null
}, id)
async function nativeKey(keyCode, modifiers = []) {
  await application.evaluate(({ BrowserWindow }, key) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', ...key })
    contents.sendInputEvent({ type: 'keyUp', ...key })
  }, { keyCode, modifiers })
}
async function typeSql(sql) {
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(sql)
  await expect.poll(editorText).toContain(sql.replaceAll(' ', ' '))
}
/** Opens a title-bar menu with the mouse and clicks an item, as a user would. */
async function choose(name, label, role = 'menuitem') {
  await menubarItem(name).click()
  await menu(name).getByRole(role, { name: label, exact: true }).click()
  await expect(openMenus()).toHaveCount(0)
}
const exit = process.platform === 'win32' ? { label: 'Exit', key: 'Alt+F4' } : { label: 'Quit', key: 'Ctrl+Q' }

try {
  application = await electron.launch(launchOptions)
  page = await application.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.getByText(/\.NET 10\..*Ready/)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  await application.evaluate(({ dialog }) => {
    globalThis.variaReloadPrompts = 0
    // A reload would ask first (unsaved queries); count the question and cancel it, so a reload attempt shows up.
    dialog.showMessageBoxSync = () => { globalThis.variaReloadPrompts++; return 1 }
    // Unsaved queries make a normal exit ask first; answer Don't Save.
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })

  // 1. The menubar by mouse: a click opens a themed menu below its button, hovering another button switches menus, and
  // choosing an item runs it with focus back where it was.
  await textbox().focus()
  await menubarItem('File').click()
  const newQuery = menu('File').getByRole('menuitem', { name: 'New Query', exact: true })
  await expect(newQuery).toBeVisible()
  await expect(newQuery).toContainText('Ctrl+N')
  await expect(newQuery).toHaveAttribute('aria-keyshortcuts', 'Control+N')
  await expect(menubarItem('File')).toHaveAttribute('aria-expanded', 'true')
  await expect(menu('File').getByRole('menuitem').last()).toHaveText(exit.label + exit.key)
  await expect(menubar()).toHaveAttribute('data-mnemonics', 'hidden')
  const fileButton = await menubarItem('File').boundingBox(), fileMenu = await menu('File').boundingBox()
  expect(fileMenu.y).toBeGreaterThanOrEqual(fileButton.y + fileButton.height - 1)
  expect(Math.abs(fileMenu.x - fileButton.x)).toBeLessThanOrEqual(1)
  expect(await menu('File').evaluate(element => getComputedStyle(element).backgroundColor)).toBe(await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('div'))
    probe.style.background = 'var(--varia-menu-background)'
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  }))
  await page.screenshot({ path: resolve('artifacts', 'menus-file-dark.png') })
  await menubarItem('Edit').hover()
  await expect(menu('Edit')).toBeVisible()
  await expect(menu('File')).toHaveCount(0)
  await menubarItem('File').hover()
  await menu('File').getByRole('menuitem', { name: 'New Query', exact: true }).click()
  await expect(tabs()).toHaveCount(2)
  await expect(openMenus()).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  // A disabled item does nothing and the menu stays open; clicking its button again closes it, and focus never moved.
  await menubarItem('Query').click()
  await menu('Query').getByRole('menuitem', { name: 'Execute', exact: true }).click({ force: true })
  await expect(menu('Query')).toBeVisible()
  await menubarItem('Query').click()
  await expect(openMenus()).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  // A press outside closes the menu.
  await menubarItem('View').click()
  await page.locator('.status-bar').click()
  await expect(openMenus()).toHaveCount(0)
  console.log('Menus checks: mouse open, hover switching, item activation, disabled items, and outside clicks.')

  // 2. The menubar by keyboard: F10 (from the page and from the operating system) focuses File, arrows move between
  // menus, a letter runs its item, and Escape walks back to the editor.
  await typeSql('abc')
  await page.keyboard.press('F10')
  await expect(menubarItem('File')).toBeFocused()
  await expect(menubar()).toHaveAttribute('data-mnemonics', 'visible')
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  await nativeKey('F10')
  await expect(menubarItem('File')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu('File')).toBeVisible()
  await expect(menu('File').getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(menu('Edit')).toBeVisible()
  await expect(menu('Edit').getByRole('menuitem', { name: 'Undo', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(menu('File')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(openMenus()).toHaveCount(0)
  await expect(menubarItem('File')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  await page.keyboard.press('F10')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await expect(menu('Edit')).toBeVisible()
  await expect(page.locator('.menu-layer')).toHaveAttribute('data-mnemonics', 'visible')
  // A runs Select All on the editor the menu was opened from.
  await page.keyboard.press('a')
  await expect(openMenus()).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  await page.keyboard.insertText('xyz')
  await expect.poll(editorText).toBe('xyz')
  console.log('Menus checks: F10, arrow keys, access keys, and Escape.')

  // 3. Alt: a bare tap focuses the menubar (Electron's own menu bar stays hidden), Alt plus a letter opens that menu,
  // and in the editor's find widget Alt+W toggles Whole Word instead.
  await page.keyboard.press('Alt')
  await expect(menubarItem('File')).toBeFocused()
  await expect(menubar()).toHaveAttribute('data-mnemonics', 'visible')
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible())).toBe(false)
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  await page.keyboard.press('Alt+v')
  await expect(menu('View')).toBeVisible()
  await page.keyboard.press('Alt+w')
  await expect(menu('Window')).toBeVisible()
  await expect(menu('View')).toHaveCount(0)
  await page.keyboard.press('Alt')
  await expect(openMenus()).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  await page.keyboard.press('Control+F')
  const findInput = page.locator('.find-widget .monaco-findInput .input').first()
  await expect(findInput).toBeFocused()
  const wholeWord = page.locator('.find-widget [role="checkbox"][aria-label^="Match Whole Word"]')
  await expect(wholeWord).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Alt+w')
  await expect(wholeWord).toHaveAttribute('aria-checked', 'true')
  await expect(openMenus()).toHaveCount(0)
  await page.keyboard.press('Alt+w')
  await expect(wholeWord).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  console.log('Menus checks: bare Alt, Alt access keys, and Whole Word in the find widget.')

  // 4. Submenus: → opens Query › Connection with its first item, ← closes only it; hovering View › Theme opens it, and
  // its items choose themes.
  await page.keyboard.press('Alt+q')
  await expect(menu('Query').getByRole('menuitem', { name: 'Connection', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(menu('Connection')).toBeVisible()
  await expect(menu('Connection').getByRole('menuitem', { name: 'Connect…', exact: true })).toBeFocused()
  await expect(menu('Connection').getByRole('menuitem', { name: 'Disconnect', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await expect(menu('Query').getByRole('menuitem', { name: 'Connection', exact: true })).toHaveAttribute('aria-expanded', 'true')
  const queryBox = await menu('Query').boundingBox(), connectionBox = await menu('Connection').boundingBox()
  expect(connectionBox.x).toBeGreaterThanOrEqual(queryBox.x + queryBox.width - 4)
  await page.keyboard.press('ArrowLeft')
  await expect(menu('Connection')).toHaveCount(0)
  await expect(menu('Query').getByRole('menuitem', { name: 'Connection', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  await menubarItem('View').click()
  await menu('View').getByRole('menuitem', { name: 'Theme', exact: true }).hover()
  await expect(menu('Theme')).toBeVisible()
  await expect(menu('Theme').getByRole('menuitemradio', { name: 'Dark', exact: true })).toHaveAttribute('aria-checked', 'true')
  await menu('Theme').getByRole('menuitemradio', { name: 'Light', exact: true }).click()
  await expect.poll(() => variable('editor.background')).toBe('#ffffff')
  await expect.poll(appearance).toContain('"mode": "light"')
  await expect(textbox()).toBeFocused()
  await menubarItem('File').click()
  await page.screenshot({ path: resolve('artifacts', 'menus-file-light.png') })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await menubarItem('View').click()
  await menu('View').getByRole('menuitem', { name: 'Theme', exact: true }).hover()
  await expect(menu('Theme').getByRole('menuitemradio', { name: 'Light', exact: true })).toHaveAttribute('aria-checked', 'true')
  await menu('Theme').getByRole('menuitemradio', { name: 'Dark', exact: true }).click()
  await expect.poll(appearance).toContain('"mode": "dark"')
  await expect.poll(() => variable('editor.background')).not.toBe('#ffffff')
  console.log('Menus checks: keyboard and hover submenus, and theme choices from View › Theme.')

  // 5. Roles: Edit › Cut and Paste reach the editor through Electron's roles; zoom runs as the native role would.
  await typeSql('abc')
  await page.keyboard.press('Control+A')
  await choose('Edit', 'Cut')
  await expect.poll(editorText).not.toContain('abc')
  await expect.poll(clipboard).toBe('abc')
  await expect(textbox()).toBeFocused()
  await choose('Edit', 'Paste')
  await expect.poll(editorText).toBe('abc')
  await choose('View', 'Zoom In')
  await expect.poll(zoomLevel).toBe(0.5)
  await choose('View', 'Reset Zoom')
  await expect.poll(zoomLevel).toBe(0)

  // The title bar follows window focus; the native window controls are recolored with it.
  const titleBarColor = () => page.locator('.title-bar').evaluate(element => getComputedStyle(element).backgroundColor)
  const active = await titleBarColor()
  await page.evaluate(() => document.documentElement.style.setProperty('--varia-titleBar-inactiveBackground', '#123456'))
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(page.locator('html')).toHaveAttribute('data-window-focus', 'inactive')
  expect(await titleBarColor()).toBe('rgb(18, 52, 86)')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('html')).toHaveAttribute('data-window-focus', 'active')
  expect(await titleBarColor()).toBe(active)
  await page.evaluate(() => document.documentElement.style.removeProperty('--varia-titleBar-inactiveBackground'))
  const overlays = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], calls = []
    window.setTitleBarOverlay = options => { calls.push(options) }
    window.emit('blur')
    window.emit('focus')
    delete window.setTitleBarOverlay
    return calls
  })
  expect(overlays).toEqual([expect.objectContaining({ color: expect.stringMatching(/^#[0-9a-f]{6}$/), symbolColor: expect.stringMatching(/^#[0-9a-f]{6}$/) }), expect.objectContaining({ color: expect.stringMatching(/^#[0-9a-f]{6}$/) })])
  console.log('Menus checks: Cut and Paste in the editor through roles, zoom roles, and the inactive title bar.')

  // 6. Ctrl+R toggles the results pane, as in SSMS, from the page and from the operating system; nothing reloads.
  await page.evaluate(() => { window.variaSentinel = 42 })
  await typeSql('SELECT 2;')
  const outputTab = page.locator('[data-pane-tab="output"]')
  await expect(outputTab).toBeVisible()
  await expect.poll(() => nativeItem('view.toggleResultsPane')).toMatchObject({ checked: true })
  await page.keyboard.press('Control+R')
  await expect(outputTab).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  await expect.poll(() => nativeItem('view.toggleResultsPane')).toMatchObject({ checked: false })
  await page.keyboard.press('Control+R')
  await expect(outputTab).toBeVisible()
  await nativeKey('R', ['control'])
  await expect(outputTab).toHaveCount(0)
  await nativeKey('R', ['control'])
  await expect(outputTab).toBeVisible()
  await page.keyboard.press('Control+Shift+R')
  await nativeKey('R', ['control', 'shift'])
  // Window › Show Results Pane is the same toggle, checked while the pane shows.
  await menubarItem('Window').click()
  const showResults = menu('Window').getByRole('menuitemcheckbox', { name: 'Show Results Pane', exact: true })
  await expect(showResults).toHaveAttribute('aria-checked', 'true')
  await expect(showResults).toContainText('Ctrl+R')
  await showResults.click()
  await expect(outputTab).toHaveCount(0)
  await page.keyboard.press('Control+R')
  await expect(outputTab).toBeVisible()
  expect((await page.evaluate(() => window.varia.health())).ok).toBe(true)
  expect(await page.evaluate(() => window.variaSentinel)).toBe(42)
  expect(await application.evaluate(() => globalThis.variaReloadPrompts)).toBe(0)
  await expect.poll(editorText).toContain('SELECT 2;')
  // View › Reload Window shows no key.
  await menubarItem('View').click()
  await expect(menu('View').getByRole('menuitem', { name: 'Reload Window', exact: true }).locator('.menu-keybinding')).toHaveText('')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  console.log('Menus checks: Ctrl+R toggles the results pane and never reloads.')

  // 7. The editor's context menu replaces Monaco's: a right-click shows the workbench's items for the query, Copy copies
  // the selection, and Shift+F10 or the context-menu key opens it below the caret with its first item focused.
  await typeSql('SELECT 7 AS seven')
  const selectToken = page.locator('.monaco-editor .view-lines').getByText('SELECT', { exact: true }).first()
  await selectToken.click({ button: 'right' })
  const editorMenu = menu('Query editor')
  await expect(editorMenu).toBeVisible()
  expect(await editorMenu.locator('.menu-item .menu-label').allTextContents()).toEqual(['Connection', 'Execute', 'Cancel Executing Query', 'Cut', 'Copy', 'Paste', 'Command Palette…'])
  await expect(editorMenu.getByRole('menuitem', { name: 'Execute', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await expect(editorMenu.getByRole('menuitem', { name: 'Copy', exact: true })).toContainText('Ctrl+C')
  await expect(page.locator('.monaco-menu')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(openMenus()).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  await page.keyboard.press('Control+A')
  // A right-click inside the selection keeps it.
  await selectToken.click({ button: 'right' })
  await editorMenu.getByRole('menuitem', { name: 'Copy', exact: true }).click()
  await expect.poll(clipboard).toBe('SELECT 7 AS seven')
  await expect(textbox()).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+F10')
  await expect(editorMenu.getByRole('menuitem', { name: 'Connection', exact: true })).toBeFocused()
  await expect(page.locator('.menu-layer')).toHaveAttribute('data-mnemonics', 'visible')
  const caret = await page.locator('.monaco-editor .cursor').first().boundingBox(), below = await editorMenu.boundingBox()
  expect(below.y).toBeGreaterThanOrEqual(caret.y + caret.height - 1)
  expect(below.y).toBeLessThanOrEqual(caret.y + caret.height + 30)
  expect(Math.abs(below.x - caret.x)).toBeLessThanOrEqual(30)
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  await page.keyboard.press('ContextMenu')
  await expect(editorMenu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  // The page cannot read the clipboard: Paste is Electron's role and copies go through main.
  expect(await page.evaluate(() => navigator.clipboard.readText().then(() => 'read', error => error.name))).toBe('NotAllowedError')
  console.log('Menus checks: the editor context menu by mouse, Shift+F10, and the context-menu key, and no clipboard reads.')

  // 8. Query tab menus act on the tab they were opened for: Close All But This, and the file items of a saved query.
  await application.evaluate(({ dialog, shell }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    globalThis.variaRevealed = []
    shell.showItemInFolder = target => { globalThis.variaRevealed.push(target) }
  }, savedPath)
  await choose('File', 'New Query')
  expect(await tabs().count()).toBeGreaterThanOrEqual(3)
  const queryTab = () => page.locator('.query-tab').first(), tabMenu = menu('Query tab')
  await queryTab().locator('.tab-name').click({ button: 'right' })
  await expect(tabMenu).toBeVisible()
  await expect(queryTab()).toHaveAttribute('data-menu-target', '')
  // The tab took focus first, as in Windows Explorer, so closing the menu returns focus there.
  await page.keyboard.press('Escape')
  await expect(queryTab().getByRole('tab')).toBeFocused()
  await expect(queryTab()).not.toHaveAttribute('data-menu-target')
  await queryTab().locator('.tab-name').click({ button: 'right' })
  // Unsaved changes in the other queries are discarded (the stubbed prompt answers Don't Save).
  await tabMenu.getByRole('menuitem', { name: 'Close All But This', exact: true }).click()
  await expect(tabs()).toHaveCount(1)
  await expect(page.locator('[data-menu-target]')).toHaveCount(0)
  await queryTab().click({ button: 'right' })
  await expect(tabMenu.getByRole('menuitem', { name: 'Copy Full Path', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await expect(tabMenu.getByRole('menuitem', { name: 'Open Containing Folder', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await tabMenu.getByRole('menuitem', { name: 'Save As…', exact: true }).click()
  await expect(queryTab().locator('.tab-name')).toHaveText('menus-saved.sql')
  await queryTab().click({ button: 'right' })
  await tabMenu.getByRole('menuitem', { name: 'Copy Full Path', exact: true }).click()
  await expect.poll(clipboard).toBe(savedPath)
  await queryTab().click({ button: 'right' })
  await tabMenu.getByRole('menuitem', { name: 'Open Containing Folder', exact: true }).click()
  await expect.poll(() => application.evaluate(() => globalThis.variaRevealed)).toEqual([savedPath])
  // Main takes only a known file id and bounded clipboard text.
  for (const call of [() => window.varia.revealSqlFile('x'), () => window.varia.revealSqlFile(crypto.randomUUID()), () => window.varia.writeClipboardText(42), () => window.varia.writeClipboardText('x'.repeat(8_388_609))]) {
    expect((await page.evaluate(call)).ok).toBe(false)
  }
  expect(await application.evaluate(() => globalThis.variaRevealed)).toEqual([savedPath])
  await expect.poll(clipboard).toBe(savedPath)
  console.log('Menus checks: query tab menus close other queries, save, copy the path, and open the folder.')

  // 9. Panel tab menus replace Dockview's: Float, then Dock, then Close, by mouse and keyboard.
  const panelMenu = menu('Panel tab')
  await outputTab.click({ button: 'right' })
  await expect(panelMenu.locator('.menu-item .menu-label')).toHaveText(['Float', 'Close'])
  await panelMenu.getByRole('menuitem', { name: 'Float', exact: true }).click()
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(1)
  await outputTab.click({ button: 'right' })
  await expect(panelMenu.locator('.menu-item .menu-label')).toHaveText(['Dock', 'Close'])
  await panelMenu.getByRole('menuitem', { name: 'Dock', exact: true }).click()
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(0)
  const outputDockTab = page.locator('.dv-tab').filter({ has: outputTab })
  await outputDockTab.focus()
  await page.keyboard.press('Shift+F10')
  await expect(panelMenu.getByRole('menuitem', { name: 'Float', exact: true })).toBeFocused()
  await expect(outputDockTab).toHaveAttribute('data-menu-target', '')
  await page.keyboard.press('Escape')
  await expect(outputDockTab).toBeFocused()
  await outputTab.click({ button: 'right' })
  await panelMenu.getByRole('menuitem', { name: 'Close', exact: true }).click()
  await expect(outputTab).toHaveCount(0)
  await choose('Window', 'Query Output')
  await expect(outputTab).toBeVisible()
  expect(await page.locator('.dv-context-menu').count()).toBe(0)
  console.log('Menus checks: panel tab menus float, dock, and close panels.')

  // 10. Text fields in a dialog have their own menu above the dialog; the title-bar menus stay closed there.
  await choose('File', 'Connect to Server…')
  const server = page.locator('#connect-server'), password = page.locator('#connect-password'), fieldMenu = menu('Text field')
  await expect(server).toBeVisible()
  await server.fill('menus-server')
  await server.selectText()
  await server.click({ button: 'right' })
  await expect(fieldMenu).toBeVisible()
  const fieldBox = await fieldMenu.boundingBox()
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.menu'), { x: fieldBox.x + fieldBox.width / 2, y: fieldBox.y + fieldBox.height / 2 })).toBe(true)
  await fieldMenu.getByRole('menuitem', { name: 'Cut', exact: true }).click()
  await expect(server).toHaveValue('')
  await expect(server).toBeFocused()
  await expect.poll(clipboard).toBe('menus-server')
  await server.click({ button: 'right' })
  await fieldMenu.getByRole('menuitem', { name: 'Paste', exact: true }).click()
  await expect(server).toHaveValue('menus-server')
  await page.locator('#connect-auth').selectOption('sql')
  await password.fill('hunter2')
  await password.selectText()
  await password.click({ button: 'right' })
  await expect(fieldMenu.getByRole('menuitem', { name: 'Copy', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await expect(fieldMenu.getByRole('menuitem', { name: 'Cut', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await expect(password).toBeFocused()
  await server.focus()
  await page.keyboard.press('Shift+F10')
  await expect(fieldMenu.getByRole('menuitem', { name: 'Undo', exact: true })).toBeFocused()
  // The menu takes Escape, so the dialog stays open.
  await page.keyboard.press('Escape')
  await expect(server).toBeFocused()
  await expect(page.locator('.connect-dialog')).toBeVisible()
  for (const key of ['F10', 'Alt+f']) {
    await page.keyboard.press(key)
    await expect(openMenus(), key).toHaveCount(0)
    await expect(server, key).toBeFocused()
  }
  await page.keyboard.press('Escape')
  await expect(page.locator('.connect-dialog')).toHaveCount(0)
  console.log('Menus checks: text field menus in a dialog, by mouse and Shift+F10, with password fields kept from the clipboard.')

  // 11. At the smallest window size, a menu opened near the bottom right corner flips to stay inside the window, as do
  // its submenus; scrolling outside it, resizing, losing focus, and clicking elsewhere close it.
  const setContentSize = (width, height) => application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height })
  await setContentSize(1024, 700)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1024, 700])
  await textbox().focus()
  // Without the results the editor reaches the bottom of the window.
  await page.keyboard.press('Control+R')
  await expect(outputTab).toHaveCount(0)
  const editorArea = () => page.locator('.monaco-editor .overflow-guard').boundingBox()
  // Dockview and Monaco follow the new size on a later frame.
  await expect.poll(async () => { const box = await editorArea(); return box.x + box.width <= 1024 && box.y + box.height > 580 }).toBe(true)
  const text = await editorArea()
  const corner = { x: Math.round(text.x + text.width - 30), y: Math.round(text.y + text.height - 20) }
  await page.mouse.click(corner.x, corner.y, { button: 'right' })
  await expect(editorMenu).toBeVisible()
  const flipped = await editorMenu.boundingBox()
  expect(flipped.y + flipped.height).toBeLessThanOrEqual(corner.y + 1)
  expect(flipped.x + flipped.width).toBeLessThanOrEqual(corner.x + 1)
  expect(flipped.x).toBeGreaterThanOrEqual(0)
  await editorMenu.getByRole('menuitem', { name: 'Connection', exact: true }).hover()
  await expect(menu('Connection')).toBeVisible()
  const submenu = await menu('Connection').boundingBox()
  expect(submenu.x + submenu.width).toBeLessThanOrEqual(1024)
  expect(submenu.y + submenu.height).toBeLessThanOrEqual(700)
  const reopen = async () => { await page.mouse.click(text.x + 120, text.y + 40, { button: 'right' }); await expect(editorMenu).toBeVisible() }
  await page.mouse.move(text.x + 60, text.y + 60)
  await page.mouse.wheel(0, 120)
  await expect(openMenus()).toHaveCount(0)
  await reopen()
  await setContentSize(1100, 740)
  await expect(openMenus()).toHaveCount(0)
  await reopen()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(openMenus()).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await choose('File', 'New Query')
  await reopen()
  await tabs().first().click()
  await expect(openMenus()).toHaveCount(0)
  await expect(tabs().first()).toHaveAttribute('aria-selected', 'true')
  console.log('Menus checks: context menus stay inside a 1024x700 window and close on scrolling, resizing, blur, and clicks elsewhere.')

  expect(failures).toEqual([])
  console.log('Menus checks passed: title-bar menus by mouse, keyboard, F10, and Alt; submenus and theme choices; editing and zoom roles; the inactive title bar; the results pane toggle; and context menus for the editor, query tabs, panel tabs, and text fields.')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'menus-failure.png') }).catch(() => {})
  console.log(await page?.evaluate(() => ({ focused: document.activeElement?.outerHTML.slice(0, 300), menus: document.querySelectorAll('.menu').length, errors: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent) })).catch(() => 'no page'))
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
}
