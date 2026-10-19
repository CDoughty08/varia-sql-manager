import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expandExplorerPath, explorerRow, explorerTree } from './fixtures/explorer-tree.mjs'
import { dialogLifecycle, rendererWatchdog } from './fixtures/dialog-lifecycle.mjs'
import { sessionPrompts } from './fixtures/session-prompts.mjs'

const liveUser = process.env.VARIA_TEST_SQL_USER?.trim() ? process.env.VARIA_TEST_SQL_USER : undefined
if (process.env.VARIA_TEST_SQL_SERVER && liveUser && process.env.VARIA_TEST_SQL_PASSWORD === undefined) throw new Error('VARIA_TEST_SQL_PASSWORD is required when VARIA_TEST_SQL_USER is set.')
await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'menus-profile-'))
const control = await mkdtemp(resolve('artifacts', 'menus-backend-'))
const liveEnv = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete liveEnv.ELECTRON_RUN_AS_NODE
// The fake backend (tests/fixtures/backend.mjs, workbench mode) stands in for a server with AppData and dbo.Orders: its
// scripts return stored results that the results worker reads as pages, as the real backend's do. The live step uses
// the real backend.
const env = { ...liveEnv, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const appearanceFile = join(profile, 'appearance.json'), savedPath = join(profile, 'menus-saved.sql')
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Menus suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 540000)
// The smoke window is hidden, so animation frames come once a second and Playwright's two-frame stability check costs
// two seconds a click or hover. Nothing in the menus animates, so presses skip it; assertions still wait for each result.
// Layout does wait for frames: after a zoom, a window resize, or a panel shown, hidden, floated, or docked, Dockview and
// Monaco move things up to a second later, so the suite waits for that (`settle`, `rezoom`) before such a press, and
// presses on a panel's tab, which Dockview moves, keep the checks.
const fast = { force: true }

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
  await menubarItem(name).click(fast)
  await menu(name).getByRole(role, { name: label, exact: true }).click(fast)
  await expect(openMenus()).toHaveCount(0)
}
/** Waits two animation frames, by which Dockview and Monaco have laid out a change of size. */
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
/**
 * Makes a choice that zooms the page and waits until the page has seen the new zoom: its resize event comes up to a few
 * hundred milliseconds after main reports the new level, closes any menu open by then, and moves every item.
 */
async function rezoom(name, label) {
  await page.evaluate(() => { window.variaResized = new Promise(resolve => addEventListener('resize', () => resolve(), { once: true })) })
  await choose(name, label)
  await page.evaluate(() => window.variaResized)
  await settle()
}
const exit = process.platform === 'win32' ? { label: 'Exit', key: 'Alt+F4' } : { label: 'Quit', key: 'Ctrl+Q' }
/** The fake backend's requests of one method since the last `forgetCalls`, oldest first (their params). */
const calls = async method => (await readFile(join(control, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.method === method).map(call => call.params)
const forgetCalls = () => writeFile(join(control, 'calls.jsonl'), '')
/** Makes Object Explorer's tree three rows tall and scrolls it to the top, as a mouse wheel would, so its selected row is out of view. */
async function scrollSelectionAway() {
  await page.evaluate(() => { const tree = document.querySelector('[data-explorer-tree]'); tree.style.flex = '0 0 66px'; tree.scrollTop = 0 })
  await expect.poll(() => page.evaluate(() => {
    const tree = document.querySelector('[data-explorer-tree]'), row = document.getElementById(tree.getAttribute('aria-activedescendant'))
    return tree.scrollTop === 0 && row.getBoundingClientRect().top >= tree.getBoundingClientRect().bottom
  })).toBe(true)
}
const restoreTree = () => page.evaluate(() => { document.querySelector('[data-explorer-tree]').style.flex = '' })

try {
  application = await electron.launch(launchOptions)
  page = await application.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  await application.evaluate(({ dialog }) => {
    globalThis.variaReloadPrompts = 0
    // A reload would ask first (unsaved queries); count the question and cancel it, so a reload attempt shows up.
    // Unsaved queries make a normal exit ask first; answer Don't Save.
    dialog.showMessageBox = async (_window, options) => {
      if (options.title === 'Reload workbench') globalThis.variaReloadPrompts++
      return { response: 1, checkboxChecked: false }
    }
  })

  // 1. The menubar by mouse: a click opens a themed menu below its button, hovering another button switches menus, and
  // choosing an item runs it with focus back where it was.
  await textbox().focus()
  await menubarItem('File').click(fast)
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
  await menubarItem('Edit').hover(fast)
  await expect(menu('Edit')).toBeVisible()
  await expect(menu('File')).toHaveCount(0)
  await menubarItem('File').hover(fast)
  await menu('File').getByRole('menuitem', { name: 'New Query', exact: true }).click(fast)
  await expect(tabs()).toHaveCount(2)
  await expect(openMenus()).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  // A disabled item does nothing and the menu stays open; clicking its button again closes it, and focus never moved.
  await menubarItem('Query').click(fast)
  await menu('Query').getByRole('menuitem', { name: 'Cancel Executing Query', exact: true }).click({ force: true })
  await expect(menu('Query')).toBeVisible()
  await menubarItem('Query').click(fast)
  await expect(openMenus()).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  // A press outside closes the menu.
  await menubarItem('View').click(fast)
  await page.locator('.status-bar').click(fast)
  await expect(openMenus()).toHaveCount(0)
  console.log('Menus checks: mouse open, hover switching, item activation, disabled items, and outside clicks.')

  // 2. The menubar by keyboard: F10 (from the page and from the operating system) focuses File, arrows move between
  // menus, a letter runs its item, and Escape walks back to the editor.
  await typeSql('abc')
  await page.keyboard.press('F10')
  await expect(menubarItem('File')).toBeFocused()
  await expect(menubar()).toHaveAttribute('data-mnemonics', 'visible')
  // Underlined as Windows does it, through descenders (Li_g_ht Theme).
  expect(await menubarItem('File').locator('.menu-mnemonic').evaluate(element => getComputedStyle(element).textDecorationSkipInk)).toBe('none')
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
  // Tab reaches the menubar too (Shift+Tab from the toolbar's first button), which then takes the same keys as after
  // F10; Escape walks back to the toolbar.
  const connectButton = page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true })
  await connectButton.focus()
  await page.keyboard.press('Shift+Tab')
  await expect(menubarItem('File')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(menubarItem('Edit')).toBeFocused()
  await page.keyboard.press('End')
  await expect(menubarItem('Window')).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await expect(menu('Edit').getByRole('menuitem', { name: 'Undo', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menubarItem('Edit')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(connectButton).toBeFocused()
  // Tab and Shift+Tab also move on from the menubar in the page's order, as from any control: Shift+Tab from Edit wraps
  // to the window's last control, and from there Tab reaches File and then the toolbar.
  await page.keyboard.press('Shift+Tab')
  await expect(menubarItem('File')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(menubarItem('Edit')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => page.evaluate(() => {
    const element = document.activeElement
    return !!element && element !== document.body && !element.closest('.title-bar, .toolbar')
  })).toBe(true)
  await page.keyboard.press('Tab')
  await expect(menubarItem('File')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(connectButton).toBeFocused()
  // Focus moved off the menubar without a key or a press (a screen reader, a script) takes the keys with it.
  await textbox().focus()
  await page.keyboard.press('F10')
  await expect(menubarItem('File')).toBeFocused()
  await textbox().focus()
  await page.keyboard.type('q')
  await expect(openMenus()).toHaveCount(0)
  await expect.poll(editorText).toBe('xyzq')
  // With no query open, leaving the menubar has nowhere to take focus back to, so the button lets it go.
  await choose('Window', 'Close All Documents')
  await expect(tabs()).toHaveCount(0)
  await page.keyboard.press('F10')
  await expect(menubarItem('File')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => !document.activeElement?.closest('.title-bar-menus'))).toBe(true)
  await choose('File', 'New Query')
  await choose('File', 'New Query')
  await expect(tabs()).toHaveCount(2)
  await textbox().focus()
  console.log('Menus checks: F10, Tab, arrow keys, access keys, and Escape.')

  // 3. Alt: a bare tap focuses the menubar (Electron's own menu bar stays hidden), Alt plus a letter opens that menu,
  // and in the editor's find widget Alt+W toggles Whole Word instead.
  await page.keyboard.press('Alt')
  await expect(menubarItem('File')).toBeFocused()
  await expect(menubar()).toHaveAttribute('data-mnemonics', 'visible')
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible())).toBe(false)
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  // Alt with the wheel scrolls the editor faster; releasing Alt then leaves focus in the editor.
  const editorBox = await page.locator('.monaco-editor .overflow-guard').boundingBox()
  await page.mouse.move(editorBox.x + editorBox.width / 2, editorBox.y + 20)
  await page.keyboard.down('Alt')
  await page.mouse.wheel(0, 120)
  await page.keyboard.up('Alt')
  // A tap would move focus on the release's task; one task later it has stayed.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)))
  await expect(textbox()).toBeFocused()
  await expect(menubar()).toHaveAttribute('data-mnemonics', 'hidden')
  await page.keyboard.press('Alt+v')
  await expect(menu('View')).toBeVisible()
  await page.keyboard.press('Alt+w')
  await expect(menu('Window')).toBeVisible()
  await expect(menu('View')).toHaveCount(0)
  await page.keyboard.press('Alt')
  await expect(openMenus()).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  // A pointer resting on Query highlights it, but not while the keyboard has File open: one button looks selected.
  const buttonBackground = name => menubarItem(name).evaluate(element => getComputedStyle(element).backgroundColor)
  const plainButton = await buttonBackground('Window')
  await menubarItem('Query').hover(fast)
  await expect.poll(() => buttonBackground('Query')).not.toBe(plainButton)
  await page.keyboard.press('Alt+f')
  await expect(menu('File')).toBeVisible()
  expect(await buttonBackground('Query')).toBe(plainButton)
  expect(await buttonBackground('File')).not.toBe(plainButton)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  await page.locator('.status-bar').hover(fast)
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
  console.log('Menus checks: bare Alt, Alt access keys, a resting pointer beside a keyboard-opened menu, and Whole Word in the find widget.')

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
  await menubarItem('View').click(fast)
  await menu('View').getByRole('menuitem', { name: 'Theme', exact: true }).hover(fast)
  await expect(menu('Theme')).toBeVisible()
  await expect(menu('Theme').getByRole('menuitemradio', { name: 'Dark', exact: true })).toHaveAttribute('aria-checked', 'true')
  await menu('Theme').getByRole('menuitemradio', { name: 'Light', exact: true }).click(fast)
  await expect.poll(() => variable('editor.background')).toBe('#ffffff')
  await expect.poll(appearance).toContain('"mode": "light"')
  await expect(textbox()).toBeFocused()
  await menubarItem('File').click(fast)
  await page.screenshot({ path: resolve('artifacts', 'menus-file-light.png') })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await menubarItem('View').click(fast)
  await menu('View').getByRole('menuitem', { name: 'Theme', exact: true }).hover(fast)
  await expect(menu('Theme').getByRole('menuitemradio', { name: 'Light', exact: true })).toHaveAttribute('aria-checked', 'true')
  await menu('Theme').getByRole('menuitemradio', { name: 'Dark', exact: true }).click(fast)
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
  await rezoom('View', 'Zoom In')
  await expect.poll(zoomLevel).toBe(0.5)
  await rezoom('View', 'Reset Zoom')
  await expect.poll(zoomLevel).toBe(0)
  // Paste reads the system clipboard, so main runs it only just after a click or key press: the page cannot run it alone.
  await application.evaluate(({ clipboard }) => clipboard.writeText('from another app'))
  await page.waitForTimeout(1500)
  expect(await page.evaluate(async () => {
    const field = document.body.appendChild(document.createElement('textarea'))
    field.focus()
    const result = await window.varia.runRole('paste')
    const value = field.value
    field.remove()
    return { ok: result.ok, value }
  })).toEqual({ ok: false, value: '' })
  // A tap is the user acting, as a click is: Edit › Paste chosen by touch pastes (Windows touch screens).
  await application.evaluate(({ clipboard }) => clipboard.writeText('pasted-by-touch'))
  await typeSql('abc')
  await page.keyboard.press('Control+A')
  const touch = await page.context().newCDPSession(page)
  const tapOn = async locator => {
    const box = await locator.boundingBox(), point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  await tapOn(menubarItem('Edit'))
  await expect(menu('Edit')).toBeVisible()
  await tapOn(menu('Edit').getByRole('menuitem', { name: 'Paste', exact: true }))
  await expect.poll(editorText).toBe('pasted-by-touch')
  await expect(page.locator('.global-error')).toHaveCount(0)
  await touch.detach()
  await textbox().focus()

  // In forced colors (Windows High Contrast), only the active item and the open menubar button are marked, and the
  // separators still show.
  await page.emulateMedia({ forcedColors: 'active' })
  await page.keyboard.press('Alt+e')
  await expect(menu('Edit')).toBeVisible()
  const forced = await page.evaluate(() => {
    const style = element => getComputedStyle(element)
    const buttons = [...document.querySelectorAll('.title-bar-menus button')], open = buttons.find(button => button.getAttribute('aria-expanded') === 'true')
    const closed = buttons.find(button => button !== open && !button.matches(':hover'))
    return {
      outlines: [...document.querySelectorAll('.menu .menu-item:not([data-active])'), closed].map(element => style(element).outlineStyle),
      separator: style(document.querySelector('.menu .menu-separator')).backgroundColor, menu: style(document.querySelector('.menu')).backgroundColor,
      open: style(open).backgroundColor, closed: style(closed).backgroundColor
    }
  })
  expect([...new Set(forced.outlines)]).toEqual(['none'])
  expect(forced.separator).not.toBe(forced.menu)
  expect(forced.open).not.toBe(forced.closed)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  // A focused disabled item (Change Database… without a connection) keeps GrayText on the menu's Canvas, outlined.
  await page.keyboard.press('Alt+q')
  await page.keyboard.press('ArrowDown')
  const changeDatabase = menu('Query').getByRole('menuitem', { name: 'Change Database…', exact: true })
  await expect(changeDatabase).toBeFocused()
  await expect(changeDatabase).toHaveAttribute('aria-disabled', 'true')
  const disabled = await changeDatabase.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, menu: getComputedStyle(element.closest('.menu')).backgroundColor, color: style.color, outline: style.outlineStyle }
  })
  expect(disabled.background).toBe(disabled.menu)
  expect(disabled.color).not.toBe(disabled.background)
  expect(disabled.outline).not.toBe('none')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.emulateMedia({ forcedColors: null })
  await expect(textbox()).toBeFocused()

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
  console.log('Menus checks: Cut and Paste in the editor through roles, no Paste the page runs alone, zoom roles, forced colors, and the inactive title bar.')

  // 6. Ctrl+R toggles the results pane, as in SSMS; nothing reloads. The operating system's keys are pressed after step 14,
  // in a shown window, where the hidden menu's accelerators work.
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
  await page.keyboard.press('Control+Shift+R')
  await settle()
  // Window › Show Results Pane is the same toggle, checked while the pane shows.
  await menubarItem('Window').click(fast)
  const showResults = menu('Window').getByRole('menuitemcheckbox', { name: 'Show Results Pane', exact: true })
  await expect(showResults).toHaveAttribute('aria-checked', 'true')
  await expect(showResults).toContainText('Ctrl+R')
  await showResults.click(fast)
  await expect(outputTab).toHaveCount(0)
  await page.keyboard.press('Control+R')
  await expect(outputTab).toBeVisible()
  expect((await page.evaluate(() => window.varia.health())).ok).toBe(true)
  expect(await page.evaluate(() => window.variaSentinel)).toBe(42)
  expect(await application.evaluate(() => globalThis.variaReloadPrompts)).toBe(0)
  await expect.poll(editorText).toContain('SELECT 2;')
  await settle()
  // View › Reload Window shows no key.
  await menubarItem('View').click(fast)
  await expect(menu('View').getByRole('menuitem', { name: 'Reload Window', exact: true }).locator('.menu-keybinding')).toHaveText('')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  console.log('Menus checks: Ctrl+R toggles the results pane and never reloads.')

  // 7. The editor's context menu replaces Monaco's: a right-click shows the workbench's items for the query, Copy copies
  // the selection, and Shift+F10 or the context-menu key opens it below the caret with its first item focused.
  await typeSql('SELECT 7 AS seven')
  const selectToken = page.locator('.monaco-editor .view-lines').getByText('SELECT', { exact: true }).first()
  await selectToken.click({ button: 'right', force: true })
  const editorMenu = menu('Query editor')
  await expect(editorMenu).toBeVisible()
  expect(await editorMenu.locator('.menu-item .menu-label').allTextContents()).toEqual(['Connection', 'Execute', 'Cancel Executing Query', 'Cut', 'Copy', 'Paste', 'Command Palette…'])
  // The query is not connected: Execute connects it first; nothing is running to cancel.
  await expect(editorMenu.getByRole('menuitem', { name: 'Execute', exact: true })).not.toHaveAttribute('aria-disabled', 'true')
  await expect(editorMenu.getByRole('menuitem', { name: 'Cancel Executing Query', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await expect(editorMenu.getByRole('menuitem', { name: 'Copy', exact: true })).toContainText('Ctrl+C')
  await expect(page.locator('.monaco-menu')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(openMenus()).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  await page.keyboard.press('Control+A')
  // A right-click inside the selection keeps it.
  await selectToken.click({ button: 'right', force: true })
  await editorMenu.getByRole('menuitem', { name: 'Copy', exact: true }).click(fast)
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
  // The page has no clipboard read of its own: Paste is Electron's role, gated in main, and copies go through main.
  expect(await page.evaluate(() => navigator.clipboard.readText().then(() => 'read', error => error.name))).toBe('NotAllowedError')
  console.log('Menus checks: the editor context menu by mouse, Shift+F10, and the context-menu key, and no navigator.clipboard reads.')

  // 8. Query tab menus act on the tab they were opened for: Close All But This, and the file items of a saved query.
  await application.evaluate(({ dialog, shell }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    globalThis.variaRevealed = []
    shell.showItemInFolder = target => { globalThis.variaRevealed.push(target) }
  }, savedPath)
  await choose('File', 'New Query')
  expect(await tabs().count()).toBeGreaterThanOrEqual(3)
  const queryTab = () => page.locator('.query-tab').first(), tabMenu = menu('Query tab')
  await queryTab().locator('.tab-name').click({ button: 'right', force: true })
  await expect(tabMenu).toBeVisible()
  await expect(queryTab()).toHaveAttribute('data-menu-target', '')
  // The tab took focus first, as in Windows Explorer, so closing the menu returns focus there.
  await page.keyboard.press('Escape')
  await expect(queryTab().getByRole('tab')).toBeFocused()
  await expect(queryTab()).not.toHaveAttribute('data-menu-target')
  await queryTab().locator('.tab-name').click({ button: 'right', force: true })
  // Unsaved changes in the other queries are discarded (the stubbed prompt answers Don't Save).
  await tabMenu.getByRole('menuitem', { name: 'Close All But This', exact: true }).click(fast)
  await expect(tabs()).toHaveCount(1)
  await expect(page.locator('[data-menu-target]')).toHaveCount(0)
  await queryTab().click({ button: 'right', force: true })
  await expect(tabMenu.getByRole('menuitem', { name: 'Copy Full Path', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await expect(tabMenu.getByRole('menuitem', { name: 'Open Containing Folder', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await tabMenu.getByRole('menuitem', { name: 'Save As…', exact: true }).click(fast)
  await expect(queryTab().locator('.tab-name')).toHaveText('menus-saved.sql')
  await queryTab().click({ button: 'right', force: true })
  await tabMenu.getByRole('menuitem', { name: 'Copy Full Path', exact: true }).click(fast)
  await expect.poll(clipboard).toBe(savedPath)
  await queryTab().click({ button: 'right', force: true })
  await tabMenu.getByRole('menuitem', { name: 'Open Containing Folder', exact: true }).click(fast)
  await expect.poll(() => application.evaluate(() => globalThis.variaRevealed)).toEqual([savedPath])
  // Main takes only a known file id and bounded clipboard text.
  for (const call of [() => window.varia.revealSqlFile('x'), () => window.varia.revealSqlFile(crypto.randomUUID()), () => window.varia.writeClipboardText(42), () => window.varia.writeClipboardText('x'.repeat(8_388_609))]) {
    expect((await page.evaluate(call)).ok).toBe(false)
  }
  expect(await application.evaluate(() => globalThis.variaRevealed)).toEqual([savedPath])
  await expect.poll(clipboard).toBe(savedPath)
  console.log('Menus checks: query tab menus close other queries, save, copy the path, and open the folder.')

  // 9. Panel tab menus replace Dockview's: Float, then Dock, then Close, by mouse and keyboard. Dockview moves the tab
  // as it lays out each change, so right-clicks on it keep Playwright's checks: one without them can land on the editor.
  const panelMenu = menu('Panel tab'), rightClickOutputTab = () => outputTab.click({ button: 'right' })
  await rightClickOutputTab()
  await expect(panelMenu.locator('.menu-item .menu-label')).toHaveText(['Float', 'Close'])
  // The tab's outline shows on every side, although the output tab has splitters above it and to its left.
  expect(await page.locator('.dv-tab[data-menu-target]').evaluate(tab => {
    const box = tab.getBoundingClientRect(), style = getComputedStyle(tab), inset = -parseFloat(style.outlineOffset) - parseFloat(style.outlineWidth) + 0.5
    // A quarter of the way along each edge: the menu opened at the tab's center covers the rest of its right and bottom.
    const edges = [[box.left + inset, box.top + box.height / 4], [box.right - inset, box.top + box.height / 4], [box.left + box.width / 4, box.top + inset], [box.left + box.width / 4, box.bottom - inset]]
    return style.outlineStyle !== 'none' && edges.every(([x, y]) => tab.contains(document.elementFromPoint(x, y)))
  })).toBe(true)
  await panelMenu.getByRole('menuitem', { name: 'Float', exact: true }).click(fast)
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(1)
  await rightClickOutputTab()
  await expect(panelMenu.locator('.menu-item .menu-label')).toHaveText(['Dock', 'Close'])
  await panelMenu.getByRole('menuitem', { name: 'Dock', exact: true }).click(fast)
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(0)
  await settle()
  const outputDockTab = page.locator('.dv-tab').filter({ has: outputTab })
  await outputDockTab.focus()
  await page.keyboard.press('Shift+F10')
  await expect(panelMenu.getByRole('menuitem', { name: 'Float', exact: true })).toBeFocused()
  await expect(outputDockTab).toHaveAttribute('data-menu-target', '')
  await page.keyboard.press('Escape')
  await expect(outputDockTab).toBeFocused()
  await rightClickOutputTab()
  await panelMenu.getByRole('menuitem', { name: 'Close', exact: true }).click(fast)
  await expect(outputTab).toHaveCount(0)
  await choose('Window', 'Query Output')
  await expect(outputTab).toBeVisible()
  await settle()
  expect(await page.locator('.dv-context-menu').count()).toBe(0)
  console.log('Menus checks: panel tab menus float, dock, and close panels.')

  // 10. Text fields in a dialog have their own menu above the dialog; the title-bar menus stay closed there.
  await choose('File', 'Connect to Server…')
  const server = page.locator('#connect-server'), password = page.locator('#connect-password'), fieldMenu = menu('Text field')
  await expect(server).toBeVisible()
  await server.fill('menus-server')
  await server.selectText()
  await server.click({ button: 'right', force: true })
  await expect(fieldMenu).toBeVisible()
  // Outlined while the menu is open, since the field's selection does not show without focus.
  await expect(server).toHaveAttribute('data-menu-target', '')
  const fieldBox = await fieldMenu.boundingBox()
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.menu'), { x: fieldBox.x + fieldBox.width / 2, y: fieldBox.y + fieldBox.height / 2 })).toBe(true)
  await fieldMenu.getByRole('menuitem', { name: 'Cut', exact: true }).click(fast)
  await expect(server).toHaveValue('')
  await expect(server).toBeFocused()
  await expect.poll(clipboard).toBe('menus-server')
  await server.click({ button: 'right', force: true })
  await fieldMenu.getByRole('menuitem', { name: 'Paste', exact: true }).click(fast)
  await expect(server).toHaveValue('menus-server')
  await page.locator('#connect-auth').selectOption('sql')
  await password.fill('hunter2')
  await password.selectText()
  await password.click({ button: 'right', force: true })
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
  // Dockview and Monaco follow the new size on later frames, which come once a second in the hidden window; on a
  // 1024-pixel screen the window was already that wide, so the editor's height shows when the layout has caught up.
  // Equal measurements a moment apart can both predate a pending layout, so each try first waits for two frames, then
  // measures the editor and checks that the corner it gives is on the editor; the press uses that corner.
  let text = null, corner = null
  await expect.poll(async () => {
    await settle()
    text = await editorArea()
    if (!text || text.x + text.width > 1024 || text.y + text.height > 700 || text.y + text.height <= 580) return false
    corner = { x: Math.round(text.x + text.width - 30), y: Math.round(text.y + text.height - 20) }
    return page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.monaco-editor .overflow-guard'), corner)
  }, { timeout: 20000 }).toBe(true)
  await page.mouse.click(corner.x, corner.y, { button: 'right' })
  await expect(editorMenu).toBeVisible()
  const flipped = await editorMenu.boundingBox()
  expect(flipped.y + flipped.height).toBeLessThanOrEqual(corner.y + 1)
  expect(flipped.x + flipped.width).toBeLessThanOrEqual(corner.x + 1)
  expect(flipped.x).toBeGreaterThanOrEqual(0)
  await editorMenu.getByRole('menuitem', { name: 'Connection', exact: true }).hover(fast)
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
  await settle()
  await reopen()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(openMenus()).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await choose('File', 'New Query')
  await reopen()
  await tabs().first().click(fast)
  await expect(openMenus()).toHaveCount(0)
  await expect(tabs().first()).toHaveAttribute('aria-selected', 'true')
  console.log('Menus checks: context menus stay inside a 1024x700 window and close on scrolling, resizing, blur, and clicks elsewhere.')

  // 12. Object Explorer menus, over the fake backend's server: right-click selects a node and shows its own items, which
  // act on it; Refresh reloads only that node; Shift+F10 or the context-menu key opens the selected node's menu below it.
  const createScript = 'CREATE TABLE dbo.Orders (Id int);'
  await forgetCalls()
  const explorerMenu = menu('Object Explorer'), labels = () => explorerMenu.locator('.menu-item .menu-label').allTextContents()
  const tree = explorerTree(page), row = (...path) => explorerRow(page, ...path)
  const ordersPath = ['server-a', 'Databases', 'AppData', 'Tables', 'dbo.Orders']
  const loads = async folder => (await calls('explorer.children')).filter(params => params.node.type === 'folder' && params.node.folder === folder).length
  // The empty area offers Connect… and Refresh, which needs a server.
  await page.locator('.explorer-empty p').click({ button: 'right', force: true })
  await expect(explorerMenu).toBeVisible()
  expect(await labels()).toEqual(['Connect…', 'Refresh'])
  await expect(explorerMenu.getByRole('menuitem', { name: 'Refresh', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await explorerMenu.getByRole('menuitem', { name: 'Connect…', exact: true }).click(fast)
  await page.getByLabel('Server Name', { exact: true }).fill('server-a')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click(fast)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // A server: its own items, and New Query on its connection with focus in the new query.
  const serverA = await row('server-a')
  await serverA.click({ button: 'right', force: true })
  expect(await labels()).toEqual(['Connect…', 'Disconnect', 'New Query', 'Copy Name', 'Refresh'])
  await expect(serverA).toHaveAttribute('data-menu-target', '')
  await expect(serverA).toHaveAttribute('aria-selected', 'true')
  const before = await tabs().count()
  await explorerMenu.getByRole('menuitem', { name: 'New Query', exact: true }).click(fast)
  await expect(tabs()).toHaveCount(before + 1)
  await expect(page.locator('#query-server option:checked')).toHaveText('server-a')
  await expect(page.locator('#query-database')).toHaveValue('master')
  await expect(textbox()).toBeFocused()
  // A database's name, quoted. Right-click selected it, and focus went back to the tree.
  await expandExplorerPath(page, 'server-a', 'Databases')
  const appData = await row('server-a', 'Databases', 'AppData')
  await appData.click({ button: 'right', force: true })
  expect(await labels()).toEqual(['New Query', 'Script Database as', 'Copy Name', 'Refresh'])
  await explorerMenu.getByRole('menuitem', { name: 'Copy Name', exact: true }).click(fast)
  await expect.poll(clipboard).toBe('[AppData]')
  await expect(tree).toBeFocused()
  await expect(appData).toHaveAttribute('aria-selected', 'true')
  // A table: Select Top 1000 Rows opens SSMS's script on its database and runs it there.
  await expandExplorerPath(page, ...ordersPath.slice(0, -1))
  const orders = await row(...ordersPath)
  await orders.click({ button: 'right', force: true })
  expect(await labels()).toEqual(['Select Top 1000 Rows', 'Script Table as', 'Copy Name', 'Refresh'])
  await explorerMenu.getByRole('menuitem', { name: 'Select Top 1000 Rows', exact: true }).click(fast)
  const selectTop = ['/****** Script for SelectTopNRows command from Varia SQL Manager ******/', 'SELECT TOP (1000) [Id]', '      ,[CustomerName]', '  FROM [AppData].[dbo].[Orders]'].join('\n')
  // New queries take the platform's line ending, as SSMS's do, so the SQL sent is CRLF on Windows; the editor's lines are not.
  const eol = process.platform === 'win32' ? '\r\n' : '\n'
  await expect.poll(async () => (await calls('query.execute')).at(-1)?.sql).toBe(selectTop.replaceAll('\n', eol))
  expect((await calls('query.execute')).at(-1).database).toBe('AppData')
  expect(await calls('tables.columns')).toEqual([expect.objectContaining({ database: 'AppData', schema: 'dbo', name: 'Orders' })])
  await expect.poll(async () => (await editorText()).replaceAll(' ', ' ')).toBe(selectTop)
  await expect(page.locator('.results-grid')).toContainText('Contoso')
  // Script Table as › CREATE To › Clipboard, then File… through the save dialog.
  const scriptTo = async destination => {
    await (await row(...ordersPath)).click({ button: 'right', force: true })
    await explorerMenu.getByRole('menuitem', { name: 'Script Table as', exact: true }).click(fast)
    await menu('Script Table as').getByRole('menuitem', { name: 'CREATE To', exact: true }).click(fast)
    await menu('CREATE To').getByRole('menuitem', { name: destination, exact: true }).click(fast)
    await expect(openMenus()).toHaveCount(0)
  }
  await scriptTo('Clipboard')
  await expect.poll(clipboard).toBe(createScript)
  const scriptFile = join(profile, 'dbo.Orders.sql')
  await application.evaluate(({ dialog }, path) => {
    globalThis.variaSaveDialogs = []
    dialog.showSaveDialog = async (_window, options) => { globalThis.variaSaveDialogs.push(options.defaultPath); return { canceled: false, filePath: path } }
  }, scriptFile)
  const tabCount = await tabs().count()
  await scriptTo('File…')
  await expect.poll(() => readFile(scriptFile, 'utf8').catch(() => null)).toBe(createScript)
  expect(await application.evaluate(() => globalThis.variaSaveDialogs.map(path => path.split(/[\\/]/).at(-1)))).toEqual(['dbo.Orders.sql'])
  await expect(tabs()).toHaveCount(tabCount)
  // One native dialog at a time: a script for File… that arrives while Save Grid Results is still open waits for it,
  // rather than opening a second modal dialog over it, and the page stays busy with it until then.
  await rm(scriptFile)
  await application.evaluate(({ dialog }, path) => {
    globalThis.variaSaveDialogs = []
    dialog.showSaveDialog = async (_window, options) => {
      globalThis.variaSaveDialogs.push(options.title)
      if (options.title !== 'Save Grid Results') return { canceled: false, filePath: path }
      await new Promise(resolve => { globalThis.variaReleaseGridSave = resolve })
      return { canceled: true }
    }
  }, scriptFile)
  await page.locator('[data-result-grid] .rg-row[aria-rowindex="2"] .rg-c[aria-colindex="2"]').first().click()
  await page.keyboard.press('Control+S')
  await expect.poll(() => application.evaluate(() => globalThis.variaSaveDialogs)).toEqual(['Save Grid Results'])
  await scriptTo('File…')
  await expect(page.locator('.toolbar').getByRole('button', { name: 'Open', exact: true })).toBeDisabled()
  await page.waitForTimeout(500)
  expect(await application.evaluate(() => globalThis.variaSaveDialogs)).toEqual(['Save Grid Results'])
  await application.evaluate(() => globalThis.variaReleaseGridSave())
  await expect.poll(() => readFile(scriptFile, 'utf8').catch(() => null)).toBe(createScript)
  expect(await application.evaluate(() => globalThis.variaSaveDialogs)).toEqual(['Save Grid Results', 'Save SQL query'])
  await expect(page.locator('.toolbar').getByRole('button', { name: 'Open', exact: true })).toBeEnabled()
  // Refresh on Tables reloads that folder only. Tables can be filtered (explorer-smoke.mjs covers Filter Settings).
  const tables = await row(...ordersPath.slice(0, -1)), stale = await (await row(...ordersPath)).getAttribute('id')
  const listed = { tables: await loads('tables'), databases: await loads('databases') }
  await tables.click({ button: 'right', force: true })
  expect(await labels()).toEqual(['Filter Settings…', 'Refresh'])
  await explorerMenu.getByRole('menuitem', { name: 'Refresh', exact: true }).click(fast)
  await expect.poll(() => loads('tables')).toBe(listed.tables + 1)
  expect(await loads('databases')).toBe(listed.databases)
  // The old rows stay until the folder's first page replaces them.
  await expect.poll(async () => (await row(...ordersPath)).getAttribute('id')).not.toBe(stale)
  // The keyboard: Shift+F10 opens the selected table's menu below its row with its first item active; so does the
  // context-menu key. Focus stays on the tree, which names the row as its active descendant.
  const table = await row(...ordersPath)
  await table.click(fast)
  await expect(tree).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(explorerMenu.getByRole('menuitem', { name: 'Select Top 1000 Rows', exact: true })).toBeFocused()
  await expect(table).toHaveAttribute('data-menu-target', '')
  const node = await table.boundingBox(), anchored = await explorerMenu.boundingBox()
  expect(anchored.y).toBeGreaterThanOrEqual(node.y + node.height - 1)
  expect(anchored.y).toBeLessThanOrEqual(node.y + node.height + 30)
  await page.keyboard.press('Escape')
  await expect(tree).toBeFocused()
  await expect(table).not.toHaveAttribute('data-menu-target')
  await page.keyboard.press('ContextMenu')
  await expect(explorerMenu.getByRole('menuitem', { name: 'Select Top 1000 Rows', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  // The selected row scrolled out of the tree's view (as a mouse wheel leaves it): Shift+F10 scrolls it back into view
  // and opens its menu below it, inside the window; the tree's own scroll does not close the menu.
  await scrollSelectionAway()
  await page.keyboard.press('Shift+F10')
  await expect(explorerMenu.getByRole('menuitem', { name: 'Select Top 1000 Rows', exact: true })).toBeFocused()
  const view = await tree.boundingBox(), revealed = await table.boundingBox(), placed = await explorerMenu.boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(revealed.y).toBeGreaterThanOrEqual(view.y - 1)
  expect(revealed.y + revealed.height).toBeLessThanOrEqual(view.y + view.height + 1)
  expect(placed.y).toBeGreaterThanOrEqual(revealed.y + revealed.height - 1)
  expect(placed.y + placed.height).toBeLessThanOrEqual(viewport.height)
  await page.waitForTimeout(300)
  await expect(explorerMenu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tree).toBeFocused()
  await restoreTree()
  // Left moves to Tables, and F5 reloads it; the tree keeps focus.
  await page.keyboard.press('ArrowLeft')
  await expect(tables).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('F5')
  await expect.poll(() => loads('tables')).toBe(listed.tables + 2)
  expect(await loads('databases')).toBe(listed.databases)
  await expect(tree).toBeFocused()
  // A login's name; the server's Disconnect needs no picker.
  await expandExplorerPath(page, 'server-a', 'Security', 'Logins')
  await (await row('server-a', 'Security', 'Logins', 'sa')).click({ button: 'right', force: true })
  expect(await labels()).toEqual(['Script Login as', 'Copy Name', 'Refresh'])
  await explorerMenu.getByRole('menuitem', { name: 'Copy Name', exact: true }).click(fast)
  await expect.poll(clipboard).toBe('[sa]')
  await serverA.click({ button: 'right', force: true })
  await explorerMenu.getByRole('menuitem', { name: 'Disconnect', exact: true }).click(fast)
  await expect(tree).toHaveCount(0)
  await expect(page.locator('.quick-input')).toHaveCount(0)
  expect(await calls('connections.disconnect')).toHaveLength(1)
  console.log('Menus checks: Object Explorer menus for the empty area, a server, a database, a table, Tables, and a login, by mouse and keyboard.')

  // 13. Query Output: the results grid selects cells as SSMS does and copies them through the backend as tab-separated
  // text, by its menu, its keys, and Edit › Copy; Messages keep text selection, with Select All and Copy in their menu.
  await choose('File', 'Connect to Server…')
  await page.getByLabel('Server Name', { exact: true }).fill('server-b')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click(fast)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await typeSql('SELECT Id, Name, Note FROM dbo.Notes -- MENUS_GRID_FIXTURE')
  await page.keyboard.press('F5')
  const grid = page.locator('[data-result-grid]').first(), outputMenu = menu('Query output'), eol = process.platform === 'win32' ? '\r\n' : '\n'
  const cell = (row, column, of = grid) => of.locator(`.rg-row[aria-rowindex="${row + 2}"] .rg-c[aria-colindex="${column + 2}"]`), selected = () => grid.locator('.rg-c.is-sel')
  const outputLabels = () => outputMenu.locator('.menu-item .menu-label').allTextContents()
  await expect(grid).toContainText('n3')
  // The grid is a named ARIA grid, so screen readers announce its place and size.
  await expect(page.getByRole('grid', { name: 'Result 1 of 1, 3 rows, 3 columns', exact: true })).toBeVisible()
  // Earlier steps shrank the window, so the output panel may be short. Every row must show: Playwright scrolls a cell
  // into view before pressing it, and that scroll would close a menu the press had just opened.
  const outputTop = (await page.locator('.output-panel').boundingBox()).y
  // With the output at its minimum height its sash is dv-maximum rather than dv-enabled: it can still move up.
  const sashes = await Promise.all((await page.locator('.dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash:not(.dv-disabled)').all()).map(sash => sash.boundingBox()))
  const above = sashes.filter(box => box && box.y < outputTop).sort((a, b) => b.y - a.y)[0]
  await page.mouse.move(above.x + above.width / 2, above.y + above.height / 2)
  await page.mouse.down()
  await page.mouse.move(above.x + above.width / 2, Math.min(above.y, 260), { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => grid.locator('.rg-scroll').evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true)
  await expect(grid.getByRole('columnheader').nth(2)).toContainText('(No column name)')
  // A right-click selects the cell under it first; Copy copies its value.
  await cell(1, 2).click({ button: 'right', force: true })
  expect(await outputLabels()).toEqual(['Copy', 'Copy with Headers', 'Select All', 'Save Results As…'])
  await expect(selected()).toHaveCount(1)
  await expect(cell(1, 2)).toHaveClass(/is-sel/)
  await outputMenu.getByRole('menuitem', { name: 'Copy', exact: true }).click(fast)
  await expect.poll(clipboard).toBe('n2')
  await expect(grid).toBeFocused()
  // Shift extends; a right-click inside the selection keeps it.
  await cell(0, 0).click(fast)
  await cell(2, 1).click({ modifiers: ['Shift'], force: true })
  await expect(selected()).toHaveCount(6)
  // In forced colors (Windows High Contrast) the selection shows in the system's selection colors, focused or not.
  await page.emulateMedia({ forcedColors: 'active' })
  const shade = locator => locator.evaluate(element => {
    for (let node = element; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor
      if (color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color)) return color
    }
    return ''
  })
  expect(await shade(cell(0, 0))).not.toBe(await shade(cell(0, 2)))
  await textbox().focus()
  expect(await shade(cell(0, 0))).not.toBe(await shade(cell(0, 2)))
  await page.emulateMedia({ forcedColors: null })
  await grid.focus()
  await cell(1, 1).click({ button: 'right', force: true })
  await expect(selected()).toHaveCount(6)
  await page.screenshot({ path: resolve('artifacts', 'menus-grid-dark.png') })
  await outputMenu.getByRole('menuitem', { name: 'Copy with Headers', exact: true }).click(fast)
  await expect.poll(clipboard).toBe(['Id\t(No column name)', '1\ta', '2\tb', '3\tc'].join(eol))
  // Ctrl+click adds a block (⌘ on macOS, where Control+click opens the menu); blocks that share neither rows nor
  // columns are copied one after the other.
  await cell(0, 2).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'], force: true })
  await expect(selected()).toHaveCount(7)
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe(['1\ta', '2\tb', '3\tc', 'NULL'].join(eol))
  // Ctrl+A and Ctrl+C in the focused grid, then Ctrl+Shift+C with headers.
  await expect(grid).toBeFocused()
  await page.keyboard.press('Control+A')
  await expect(selected()).toHaveCount(9)
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe(['1\ta\tNULL', '2\tb\tn2', '3\tc\tn3'].join(eol))
  await page.keyboard.press('Control+Shift+C')
  await expect.poll(clipboard).toBe(['Id\t(No column name)\tNote', '1\ta\tNULL', '2\tb\tn2', '3\tc\tn3'].join(eol))
  // A column header selects the column; Edit › Copy goes through Electron's copy role to the grid.
  await grid.getByRole('columnheader').nth(3).click(fast)
  await expect(selected()).toHaveCount(3)
  await choose('Edit', 'Copy')
  await expect.poll(clipboard).toBe(['NULL', 'n2', 'n3'].join(eol))
  // Shift+F10 opens the grid's menu below its active cell.
  await cell(2, 0).click(fast)
  await expect(cell(2, 0)).toHaveClass(/is-act/)
  await page.keyboard.press('Shift+F10')
  await expect(outputMenu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeFocused()
  const activeCell = await cell(2, 0).boundingBox(), gridMenu = await outputMenu.boundingBox()
  expect(Math.abs(gridMenu.y - (activeCell.y + activeCell.height)) <= 1 || gridMenu.y + gridMenu.height <= activeCell.y + 1).toBe(true)
  await page.keyboard.press('Escape')
  await expect(grid).toBeFocused()
  // Messages: no Copy with Headers; Select All selects only the messages, which Copy then copies.
  await page.locator('.output-toolbar').getByRole('tab', { name: /^Messages/ }).click(fast)
  const messages = page.locator('.messages')
  await expect(page.getByRole('log', { name: 'Messages', exact: true })).toBeVisible()
  await messages.locator('pre').first().click({ button: 'right', force: true })
  expect(await outputLabels()).toEqual(['Copy', 'Select All'])
  await expect(outputMenu.getByRole('menuitem', { name: 'Copy', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await outputMenu.getByRole('menuitem', { name: 'Select All', exact: true }).click(fast)
  await expect(messages).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await outputMenu.getByRole('menuitem', { name: 'Copy', exact: true }).click(fast)
  await expect.poll(clipboard).toContain('(3 rows affected)')
  expect(await clipboard()).toContain('Completion time: ')
  expect(await clipboard()).not.toContain('SELECT')
  console.log('Menus checks: results grid cell selection and copying by menu, keys, and Edit › Copy, and the Messages menu.')

  // 14. Every surface, twice: each menu opens by mouse or keyboard, Escape closes all of it, the outline goes, and focus
  // returns where it was. Then the table's menu, with its submenus open, is captured in Dark and Light.
  await page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true }).click(fast)
  await page.getByLabel('Server Name', { exact: true }).fill('server-a')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click(fast)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expandExplorerPath(page, ...ordersPath.slice(0, -1))
  await expandExplorerPath(page, 'server-a', 'Security', 'Logins')
  await expect(await row('server-a', 'Security', 'Logins', 'sa')).toBeVisible()
  await typeSql('SELECT Id, CustomerName FROM dbo.Orders -- MENUS_PLAN_FIXTURE')
  await page.keyboard.press('F5')
  await page.locator('.output-toolbar').getByRole('tab', { name: /^Results/ }).click(fast)
  // The plan's result set is stacked below the first, as SSMS stacks them.
  const planGrid = page.locator('[data-result-grid][data-result-index="1"]')
  await expect(planGrid).toContainText('ShowPlanXML')
  // These presses skip the stability check (see `fast`). An element out of view is scrolled first, and the menu opens
  // only after the scroll event, which would otherwise close it. The find widget slides in, so a press there waits for
  // it to settle.
  const tap = (locator, options = {}) => locator.click({ force: true, ...options })
  const point = locator => locator.hover({ force: true })
  const rightClick = async (locator, { force = true } = {}) => {
    await locator.evaluate(element => new Promise(resolve => {
      let scroller = element.parentElement
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
      const box = element.getBoundingClientRect(), view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight }
      if (box.top >= view.top && box.bottom <= view.bottom) { resolve(); return }
      addEventListener('scroll', () => resolve(), { capture: true, once: true })
      setTimeout(resolve, 3000)
      element.scrollIntoView({ block: 'center' })
    }))
    await locator.click({ button: 'right', force })
  }
  const inMenubar = () => page.evaluate(() => !!document.activeElement?.closest('[role="menubar"]'))
  const dockTab = pane => page.locator('.dv-tab').filter({ has: page.locator(`[data-pane-tab="${pane}"]`) })
  const fromEditor = open => async () => { await textbox().focus(); await open() }
  const findField = page.locator('.find-widget .monaco-findInput .input').first(), firstTab = page.locator('.query-tab').first()
  const surfaces = [
    ['File by mouse', fromEditor(() => tap(menubarItem('File'))), textbox()],
    ['Edit by Alt+E', fromEditor(() => page.keyboard.press('Alt+e')), textbox()],
    ['View by F10', fromEditor(async () => { for (const key of ['F10', 'ArrowRight', 'ArrowRight', 'ArrowDown']) await page.keyboard.press(key) }), textbox()],
    ['View › Theme › Dark Theme by hover', fromEditor(async () => {
      await tap(menubarItem('View'))
      await point(menu('View').getByRole('menuitem', { name: 'Theme', exact: true }))
      await point(menu('Theme').getByRole('menuitem', { name: 'Dark Theme', exact: true }))
      await expect(menu('Dark Theme')).toBeVisible()
    }), textbox()],
    ['Query › Connection by keyboard', fromEditor(async () => { await page.keyboard.press('Alt+q'); await page.keyboard.press('ArrowRight'); await expect(menu('Connection')).toBeVisible() }), textbox()],
    ['Window by mouse', fromEditor(() => tap(menubarItem('Window'))), textbox()],
    ['the editor by mouse', () => rightClick(page.locator('.monaco-editor .view-lines').getByText('SELECT', { exact: true }).first()), textbox()],
    ['the editor by Shift+F10', fromEditor(() => page.keyboard.press('Shift+F10')), textbox()],
    ['the editor\'s Connection by the context-menu key', fromEditor(async () => { await page.keyboard.press('ContextMenu'); await page.keyboard.press('ArrowRight'); await expect(menu('Connection')).toBeVisible() }), textbox()],
    ['a query tab by mouse', () => rightClick(firstTab.locator('.tab-name')), firstTab.getByRole('tab')],
    ['a query tab by Shift+F10', async () => { await firstTab.getByRole('tab').focus(); await page.keyboard.press('Shift+F10') }, firstTab.getByRole('tab')],
    ['a panel tab by mouse', () => rightClick(page.locator('[data-pane-tab="explorer"]')), dockTab('explorer')],
    ['a panel tab by Shift+F10', async () => { await dockTab('output').focus(); await page.keyboard.press('Shift+F10') }, dockTab('output')],
    // Object Explorer's rows are not focusable: focus stays on the tree, which names the selected row.
    ['a server', async () => rightClick(await row('server-a')), tree],
    ['the Databases folder', async () => rightClick(await row('server-a', 'Databases')), tree],
    ['a database', async () => rightClick(await row('server-a', 'Databases', 'AppData')), tree],
    ['a Tables folder', async () => rightClick(await row(...ordersPath.slice(0, -1))), tree],
    ['a table\'s Script Table as › CREATE To', async () => {
      await rightClick(await row(...ordersPath))
      await tap(explorerMenu.getByRole('menuitem', { name: 'Script Table as', exact: true }))
      await tap(menu('Script Table as').getByRole('menuitem', { name: 'CREATE To', exact: true }))
      await expect(menu('CREATE To')).toBeVisible()
    }, tree],
    ['a table by Shift+F10', async () => { await tap(await row(...ordersPath)); await page.keyboard.press('Shift+F10') }, tree],
    ['the Logins folder', async () => rightClick(await row('server-a', 'Security', 'Logins')), tree],
    ['a login', async () => rightClick(await row('server-a', 'Security', 'Logins', 'sa')), tree],
    ['a results grid cell', async () => { await tap(page.locator('.output-toolbar').getByRole('tab', { name: /^Results/ })); await rightClick(cell(0, 1)) }, grid],
    ['the results grid by Shift+F10', async () => { await grid.focus(); await page.keyboard.press('Shift+F10') }, grid],
    ['the second result set\'s grid', async () => { await rightClick(cell(0, 0, planGrid)) }, planGrid],
    ['Messages', async () => { await tap(page.locator('.output-toolbar').getByRole('tab', { name: /^Messages/ })); await rightClick(messages.locator('pre').first()) }, messages],
    ['the find widget\'s field', fromEditor(async () => { await page.keyboard.press('Control+F'); await expect(findField).toBeFocused(); await rightClick(findField, { force: false }) }), findField, () => page.keyboard.press('Escape')],
    ['a dialog\'s field', async () => { await tap(page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true })); await rightClick(page.locator('#connect-server')) },
      page.locator('#connect-server'), async () => { await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0) }]
  ]
  let opened = 0
  for (let round = 0; round < 2; round++) {
    for (const [label, open, restore, after] of surfaces) {
      await open()
      await expect(openMenus().first(), label).toBeVisible()
      opened++
      for (let presses = 0; presses < 5 && await openMenus().count(); presses++) await page.keyboard.press('Escape')
      await expect(openMenus(), label).toHaveCount(0)
      await expect(page.locator('[data-menu-target]'), label).toHaveCount(0)
      // A title-bar menu closes to its menubar button; one more Escape leaves the menubar.
      if (await inMenubar()) await page.keyboard.press('Escape')
      if (restore) await expect(restore, label).toBeFocused()
      await after?.()
    }
  }
  expect(opened).toBeGreaterThanOrEqual(50)
  expect(failures).toEqual([])
  await tap(page.locator('.output-toolbar').getByRole('tab', { name: /^Results/ }))
  for (const mode of ['dark', 'light']) {
    await page.evaluate(value => window.varia.setThemePreference({ mode: value }), mode)
    await expect.poll(appearance).toContain(`"mode": "${mode}"`)
    await expect.poll(async () => await variable('editor.background') === '#ffffff').toBe(mode === 'light')
    await rightClick(await row(...ordersPath))
    await tap(explorerMenu.getByRole('menuitem', { name: 'Script Table as', exact: true }))
    await tap(menu('Script Table as').getByRole('menuitem', { name: 'CREATE To', exact: true }))
    await point(menu('CREATE To').getByRole('menuitem', { name: 'Clipboard', exact: true }))
    await expect(menu('CREATE To').getByRole('menuitem', { name: 'Clipboard', exact: true })).toBeFocused()
    await page.screenshot({ path: resolve('artifacts', `menus-${mode}.png`) })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(openMenus()).toHaveCount(0)
  }
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'dark' }))
  await expect.poll(appearance).toContain('"mode": "dark"')
  console.log(`Menus checks: ${opened} menus opened and closed across every surface, by mouse and keyboard, with focus restored each time.`)

  // Electron's role keys come from the hidden application menu, whose accelerators work only in a shown window: Ctrl+=
  // and Electron's own Zoom In key, Ctrl+Shift+= (Ctrl++), zoom in; Ctrl+- zooms out; Ctrl+0 resets.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
  await page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true }).focus()
  for (const [key, modifiers, level] of [['=', ['control'], 0.5], ['=', ['control', 'shift'], 1], ['-', ['control'], 0.5], ['0', ['control'], 0]]) {
    await nativeKey(key, modifiers)
    await expect.poll(zoomLevel, `${modifiers.join('+')}+${key}`).toBe(level)
  }
  // Ctrl+R from the operating system toggles the results pane here too, and neither it nor Ctrl+Shift+R reaches a reload
  // key of that menu: the page and its unsaved queries stay (a reload would ask about them first).
  await page.evaluate(() => { window.variaSentinel = 43 })
  await expect(outputTab).toBeVisible()
  await nativeKey('R', ['control'])
  await expect(outputTab).toHaveCount(0)
  await nativeKey('R', ['control'])
  await expect(outputTab).toBeVisible()
  await nativeKey('R', ['control', 'shift'])
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
  expect((await page.evaluate(() => window.varia.health())).ok).toBe(true)
  expect(await page.evaluate(() => window.variaSentinel)).toBe(43)
  expect(await application.evaluate(() => globalThis.variaReloadPrompts)).toBe(0)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  console.log('Menus checks: Electron\'s zoom keys in a shown window, Ctrl+Shift+= included, and Ctrl+R and Ctrl+Shift+R there, which reload nothing.')

  // 15. Native context menus, as macOS shows them: main builds each from command ids and sends back the request's token
  // with the chosen id. The custom style refuses them; the app is relaunched with the native style, Electron's popups
  // are recorded (one is really shown), and choices are made as Electron would make them.
  expect(await page.evaluate(() => window.varia.menuStyle)).toBe('custom')
  const forged = { token: 1, menu: 'explorer.context', x: 10, y: 10, visible: ['explorer.copyName'], disabled: [], checked: [] }
  expect(await page.evaluate(request => window.varia.showContextMenu(request), forged)).toEqual({ ok: false, error: 'Native context menus are not in use.' })
  expect(failures).toEqual([])
  await application.close()
  application = await electron.launch({ ...launchOptions, env: { ...env, VARIA_SMOKE_MENU_STYLE: 'native' } })
  page = await application.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
  expect(await page.evaluate(() => window.varia.menuStyle)).toBe('native')
  await application.evaluate(({ Menu }) => {
    globalThis.variaPopups = []
    globalThis.variaPopupMode = 'record'
    const show = Menu.prototype.popup
    const describe = menu => menu.items.map(item => item.type === 'separator' ? '---' : item.submenu ? [item.label, describe(item.submenu)] : item.label)
    Menu.prototype.popup = function (options) {
      globalThis.variaPopups.push({ menu: this, options, items: describe(this) })
      if (globalThis.variaPopupMode === 'fail') throw new Error('No popup.')
      if (globalThis.variaPopupMode === 'show') show.call(this, options)
    }
  })
  const popups = () => application.evaluate(() => globalThis.variaPopups.map(popup => ({ items: popup.items, x: popup.options.x, y: popup.options.y })))
  const popupMode = mode => application.evaluate((_electron, value) => { globalThis.variaPopupMode = value }, mode)
  /** Chooses an item of the latest popup as Electron does (roles get the focused window's contents) and closes it: Linux reports the choice first, macOS the close. */
  const pick = (id, order = 'choice first') => application.evaluate(({ BrowserWindow }, { id, order }) => {
    const popup = globalThis.variaPopups.at(-1), window = BrowserWindow.getAllWindows()[0]
    const click = () => popup.menu.getMenuItemById(id).click(undefined, window, window.webContents)
    if (order === 'close first') { popup.options.callback(); click() } else { click(); popup.options.callback() }
  }, { id, order })
  // A text field in a dialog: Cut is Electron's role, acting on the field, which kept focus.
  await choose('File', 'Connect to Server…')
  const nativeField = page.locator('#connect-server')
  await nativeField.fill('native-server')
  await nativeField.selectText()
  await nativeField.click({ button: 'right' })
  await expect.poll(async () => (await popups()).length).toBe(1)
  expect((await popups())[0].items).toEqual(['Undo', 'Redo', '---', 'Cut', 'Copy', 'Paste', 'Delete', '---', 'Select All'])
  await expect(openMenus()).toHaveCount(0)
  await pick('edit.cut@input.context')
  await expect(nativeField).toHaveValue('')
  await expect.poll(clipboard).toBe('native-server')
  await expect(nativeField).toBeFocused()
  await nativeField.fill('server-a')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click(fast)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expandExplorerPath(page, ...ordersPath.slice(0, -1))
  const nativeTree = explorerTree(page), nativeTable = await explorerRow(page, ...ordersPath)
  await expect(nativeTable).toBeVisible()
  // A table's menu at the pointer: the catalogue's labels from main, the table outlined until it closes.
  const tableBox = await nativeTable.boundingBox()
  await nativeTable.click({ button: 'right', position: { x: 12, y: 6 } })
  await expect.poll(async () => (await popups()).length).toBe(2)
  const tablePopup = (await popups())[1]
  // Main titles the Script submenu from the request's key, and disables the verbs a table does not support.
  const verbs = names => names.map(name => [name, ['New Query Editor Window', 'File…', 'Clipboard']])
  const tableScripts = [...verbs(['CREATE To', 'ALTER To', 'CREATE OR ALTER To', 'DROP To', 'DROP And CREATE To']), '---', ...verbs(['SELECT To', 'INSERT To', 'UPDATE To', 'DELETE To']), '---', ...verbs(['EXECUTE To'])]
  expect(tablePopup.items).toEqual(['Select Top 1000 Rows', '---', ['Script Table as', tableScripts], '---', 'Copy Name', '---', 'Refresh'])
  expect(await application.evaluate(() => ['explorer.scriptAs', 'explorer.scriptAs.create', 'explorer.scriptAs.alter', 'explorer.scriptAs.execute']
    .map(id => globalThis.variaPopups.at(-1).menu.getMenuItemById(id).enabled))).toEqual([true, true, false, false])
  expect(Math.abs(tablePopup.x - (tableBox.x + 12))).toBeLessThanOrEqual(1)
  expect(Math.abs(tablePopup.y - (tableBox.y + 6))).toBeLessThanOrEqual(1)
  await expect(openMenus()).toHaveCount(0)
  await expect(nativeTable).toHaveAttribute('data-menu-target', '')
  await expect(nativeTree).toBeFocused()
  await expect(nativeTable).toHaveAttribute('aria-selected', 'true')
  await pick('explorer.scriptCreateToClipboard')
  await expect.poll(clipboard).toBe(createScript)
  await expect(nativeTable).not.toHaveAttribute('data-menu-target')
  await nativeTable.click({ button: 'right' })
  await expect.poll(async () => (await popups()).length).toBe(3)
  await pick('explorer.copyName', 'close first')
  await expect.poll(clipboard).toBe('[dbo].[Orders]')
  // Only the open menu's token counts: a choice from the table's older menu does not run on the server's.
  await (await explorerRow(page, 'server-a')).click({ button: 'right' })
  await expect.poll(async () => (await popups()).length).toBe(4)
  expect((await popups())[3].items).toEqual(['Connect…', 'Disconnect', '---', 'New Query', '---', 'Copy Name', '---', 'Refresh'])
  const queriesBefore = await tabs().count()
  await application.evaluate(() => { globalThis.variaPopups[2].menu.getMenuItemById('explorer.copyName').click() })
  await pick('explorer.newQuery')
  await expect(tabs()).toHaveCount(queriesBefore + 1)
  expect(await clipboard()).toBe('[dbo].[Orders]')
  // A real popup: Electron reports its close, which ends the outline.
  await popupMode('show')
  await nativeTable.click({ button: 'right' })
  await expect.poll(async () => (await popups()).length).toBe(5)
  await expect(nativeTable).toHaveAttribute('data-menu-target', '')
  await application.evaluate(({ BrowserWindow }) => { globalThis.variaPopups.at(-1).menu.closePopup(BrowserWindow.getAllWindows()[0]) })
  await expect(nativeTable).not.toHaveAttribute('data-menu-target')
  // Shift+F10 asks for the focused node's menu below it.
  await popupMode('record')
  await nativeTable.click()
  await page.keyboard.press('Shift+F10')
  await expect.poll(async () => (await popups()).length).toBe(6)
  const nodeBox = await nativeTable.boundingBox(), keyboardPopup = (await popups())[5]
  expect(keyboardPopup.y).toBeGreaterThanOrEqual(nodeBox.y + nodeBox.height - 1)
  expect(keyboardPopup.y).toBeLessThanOrEqual(nodeBox.y + nodeBox.height + 30)
  expect(keyboardPopup.x).toBeGreaterThanOrEqual(nodeBox.x - 30)
  await application.evaluate(() => globalThis.variaPopups.at(-1).options.callback())
  await expect(nativeTree).toBeFocused()
  // Scrolled out of view, the node comes back into view and the menu opens below it, inside the tree.
  await scrollSelectionAway()
  await page.keyboard.press('Shift+F10')
  await expect.poll(async () => (await popups()).length).toBe(7)
  const treeBox = await nativeTree.boundingBox(), shownBox = await nativeTable.boundingBox(), awayPopup = (await popups())[6]
  expect(shownBox.y).toBeGreaterThanOrEqual(treeBox.y - 1)
  expect(awayPopup.y).toBeGreaterThanOrEqual(shownBox.y + shownBox.height - 1)
  expect(awayPopup.y).toBeLessThanOrEqual(treeBox.y + treeBox.height + 1)
  await application.evaluate(() => globalThis.variaPopups.at(-1).options.callback())
  await expect(nativeTree).toBeFocused()
  await restoreTree()
  // When main cannot show a menu, the workbench shows the same one itself.
  await popupMode('fail')
  await nativeTable.click({ button: 'right' })
  const fallbackMenu = menu('Object Explorer')
  await expect(fallbackMenu).toBeVisible()
  expect(await fallbackMenu.locator('.menu-item .menu-label').allTextContents()).toEqual(['Select Top 1000 Rows', 'Script Table as', 'Copy Name', 'Refresh'])
  await page.keyboard.press('Escape')
  await expect(openMenus()).toHaveCount(0)
  await popupMode('record')
  // Main refuses foreign ids, disabled items that are not shown, and points off the window; roles and files are fixed lists.
  for (const change of [{ visible: ['file.save'] }, { disabled: ['explorer.refresh'] }, { x: -1 }]) {
    expect((await page.evaluate(request => window.varia.showContextMenu(request), { ...forged, ...change })).ok, JSON.stringify(change)).toBe(false)
  }
  for (const call of [() => window.varia.runRole('openExternal'), () => window.varia.revealSqlFile('x')]) expect((await page.evaluate(call)).ok).toBe(false)
  // Nor does an idle page get one: main shows a menu only in the focused window (the hidden smoke window never is) or
  // just after a click, tap, or key press in it, so a background page cannot put Paste where the user is working.
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(false)
  await page.waitForTimeout(1500)
  expect(await page.evaluate(request => window.varia.showContextMenu(request), { ...forged, menu: 'input.context', visible: ['edit.paste'] }))
    .toEqual({ ok: false, error: 'A native context menu needs the focused window or a click, tap, or key press in it.' })
  expect((await popups()).length).toBe(8)
  console.log('Menus checks: native context menus with their token round trip, roles on the focused field, the keyboard, the fallback, and none for an idle page.')

  // 16. Main's dialogs across the page's lifecycle, in fresh apps (fixtures/dialog-lifecycle.mjs): Restart asked for
  // twice restarts once; a crash's prompt waits for the open Save dialog and the dead page's queued save never opens,
  // but the dead page's open message box closes; the reload and not-responding prompts take their turn too; a quit
  // while a Script As save waits exits once the dialogs are answered, and one during the reload prompt survives Reload.
  // A renderer crash Chromium cannot see (a process spawned at the renderer's launch holds its channel) gets the crash
  // prompt from main's watchdog, once, and Reload brings the workbench back (in a new window, which takes over a quit the
  // lost page could not finish); Close there closes the window at once.
  expect(failures).toEqual([])
  await application.close()
  application = undefined
  await dialogLifecycle(launchOptions)
  await rendererWatchdog(launchOptions)
  console.log('Menus checks: Restart asked twice restarts once, a crash prompt waits for the open file dialog, drops the dead page\'s queued ones and closes its message box, the reload and not-responding prompts wait their turn, a quit waits for queued dialogs, and a quit during the reload prompt survives Reload; a renderer crash Chromium cannot see still gets one crash prompt, reloads and finishes a quit the lost page could not, and Close closes at once.')

  // 17. Open transactions and running queries (fixtures/session-prompts.mjs), in a fresh app: F5 connects a disconnected
  // query first; no execution reads its transaction; closing, changing connection and quitting read it then and ask
  // SSMS's question (Yes commits, No rolls back, Cancel); an executing query is cancelled only when asked; and a crash
  // closes the open prompt.
  await sessionPrompts(launchOptions)

  // 18. A real server, when VARIA_TEST_SQL_SERVER is set, in a fresh app with themed menus: master's New Query runs on
  // master, and the server's Refresh reloads its lists without an error.
  if (process.env.VARIA_TEST_SQL_SERVER) {
    application = await electron.launch({ ...launchOptions, env: liveEnv })
    page = await application.firstWindow()
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => failures.push(error.message))
    await expect(page.getByText(/\.NET 10\..*Ready/)).toBeVisible({ timeout: 30000 })
    // The typed query makes exit ask about saving; answer Don't Save.
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true }).click(fast)
    const connect = page.getByRole('dialog', { name: 'Connect', exact: true })
    await expect(connect.getByText('Loading saved connections…')).toHaveCount(0)
    await connect.getByLabel('Server Name', { exact: true }).fill(process.env.VARIA_TEST_SQL_SERVER)
    if (liveUser) {
      await connect.getByLabel('Authentication', { exact: true }).selectOption('sql')
      await connect.getByLabel('User Name', { exact: true }).fill(liveUser)
      await connect.getByLabel('Password', { exact: true }).fill(process.env.VARIA_TEST_SQL_PASSWORD)
    } else await connect.getByLabel('Authentication', { exact: true }).selectOption('windows')
    await connect.getByLabel('Trust server certificate', { exact: true }).check()
    await connect.getByRole('button', { name: 'Connect', exact: true }).click(fast)
    await expect(connect).toHaveCount(0, { timeout: 30000 })
    const liveServer = page.locator('.explorer-row.server').first()
    await expect(liveServer).toBeVisible({ timeout: 30000 })
    const liveName = await liveServer.locator('.oe-label').textContent(), wait = { timeout: 30000 }
    await expandExplorerPath(page, liveName, 'Databases', 'System Databases', wait)
    const master = await explorerRow(page, liveName, 'Databases', 'System Databases', 'master', wait)
    const liveTabs = await tabs().count()
    await master.click({ button: 'right' })
    await menu('Object Explorer').getByRole('menuitem', { name: 'New Query', exact: true }).click(fast)
    await expect(tabs()).toHaveCount(liveTabs + 1)
    await expect(textbox()).toBeFocused()
    await expect(page.locator('#query-database')).toHaveValue('master')
    await page.keyboard.insertText('SELECT DB_NAME()')
    await page.keyboard.press('F5')
    await expect(page.locator('[data-result-grid] .rg-row[aria-rowindex="2"] .rg-c[aria-colindex="2"]').first()).toHaveText('master', { timeout: 30000 })
    await liveServer.click({ button: 'right' })
    await menu('Object Explorer').getByRole('menuitem', { name: 'Refresh', exact: true }).click(fast)
    // The server's folders come back as new rows, collapsed, as in SSMS.
    await expect.poll(async () => (await explorerRow(page, liveName, 'Databases', wait)).getAttribute('aria-expanded'), wait).toBe('false')
    await expect(page.locator('.explorer-row.progress, .explorer-row.error')).toHaveCount(0, wait)
    // Monaco's empty live regions are alerts too; these are the workbench's error messages.
    await expect(page.locator('.global-error, .explorer-error, .messages .msg.error')).toHaveCount(0)
    console.log('Menus checks: a real server\'s master database opens a query on master from its menu, and the server refreshes with its folders collapsed.')
  } else console.log('Menus checks: the live server step was skipped (VARIA_TEST_SQL_SERVER is not set).')

  expect(failures).toEqual([])
  console.log('Menus checks passed: title-bar menus by mouse, keyboard, F10, and Alt; submenus and theme choices; editing and zoom roles; the inactive title bar; the results pane toggle; context menus for the editor, query tabs, panel tabs, text fields, Object Explorer, and Query Output; results grid cell selection; every surface opened and closed twice; native context menus; main\'s dialogs across a restart, a crash and a quit; open-transaction and running-query prompts; and a live server when configured.')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'menus-failure.png') }).catch(() => {})
  console.log(await page?.evaluate(() => ({ focused: document.activeElement?.outerHTML.slice(0, 300), menus: document.querySelectorAll('.menu').length, errors: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent) })).catch(() => 'no page'))
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
  await rm(control, { recursive: true, force: true })
}
