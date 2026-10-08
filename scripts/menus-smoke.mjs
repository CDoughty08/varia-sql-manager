import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'menus-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const appearanceFile = join(profile, 'appearance.json')
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Menus suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 150000)

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

  expect(failures).toEqual([])
  console.log('Menus checks passed: title-bar menus by mouse, keyboard, F10, and Alt; submenus and theme choices; editing and zoom roles; the inactive title bar; and the results pane toggle.')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'menus-failure.png') }).catch(() => {})
  console.log(await page?.evaluate(() => ({ focused: document.activeElement?.outerHTML.slice(0, 300), menus: document.querySelectorAll('.menu').length, errors: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent) })).catch(() => 'no page'))
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
}
