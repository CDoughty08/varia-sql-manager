import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const liveUser = process.env.VARIA_TEST_SQL_USER?.trim() ? process.env.VARIA_TEST_SQL_USER : undefined
if (process.env.VARIA_TEST_SQL_SERVER && liveUser && process.env.VARIA_TEST_SQL_PASSWORD === undefined) throw new Error('VARIA_TEST_SQL_PASSWORD is required when VARIA_TEST_SQL_USER is set.')
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
/**
 * Replaces main's backend requests with a server that has AppData and dbo.Orders, recording every call (runs in main).
 * Queries return one row, and with `plan` an XML plan after it.
 */
function explorerBackend({ ipcMain }, { realHealth, script, plan = false }) {
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
    if (method === 'databases.list') return { ok: true, value: [{ name: 'master', isSystem: true, isSnapshot: false }, { name: 'AppData', isSystem: false, isSnapshot: false }] }
    if (method === 'server.objects.list') return { ok: true, value: params.kind === 'logins' ? [{ name: 'sa', description: 'SQL_LOGIN' }] : [] }
    if (method === 'tables.list') return { ok: true, value: [{ schema: 'dbo', name: 'Orders' }] }
    if (method === 'tables.script') return { ok: true, value: { sql: script } }
    if (method === 'tables.columns') return { ok: true, value: { columns: [{ name: 'Id', dataType: 'int' }, { name: 'CustomerName', dataType: 'nvarchar' }], truncated: false } }
    if (method === 'query.session.close') return { ok: true, value: { closed: true } }
    if (method === 'query.execute') return { ok: true, value: {
      resultSets: [{ columns: [{ name: 'Id', dataType: 'int' }, { name: 'CustomerName', dataType: 'nvarchar' }], rows: [[1, 'Contoso']], truncated: false },
        ...plan ? [{ columns: [{ name: 'Microsoft SQL Server 2005 XML Showplan', dataType: 'xml' }], rows: [['<ShowPlanXML Version="1.6"><BatchSequence /></ShowPlanXML>']], truncated: false, kind: 'executionPlan' }] : []],
      messages: [], recordsAffected: -1, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1, database: params.database, messagesTruncated: false
    } }
    return { ok: false, error: 'Unsupported test operation.' }
  })
}

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
  await menu('Query').getByRole('menuitem', { name: 'Execute', exact: true }).click({ force: true })
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
  await expect(editorMenu.getByRole('menuitem', { name: 'Execute', exact: true })).toHaveAttribute('aria-disabled', 'true')
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
  // Dockview and Monaco follow the new size on a later frame; on a 1024-pixel screen the window was already that wide,
  // so the editor's height shows when the layout has caught up.
  await expect.poll(async () => { const box = await editorArea(); return box.x + box.width <= 1024 && box.y + box.height <= 700 && box.y + box.height > 580 }).toBe(true)
  const text = await editorArea()
  const corner = { x: Math.round(text.x + text.width - 30), y: Math.round(text.y + text.height - 20) }
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

  // 12. Object Explorer node menus, over a stubbed server: each kind of node shows its own items, they act on that node,
  // Refresh reloads only that node's lists, and Shift+F10 or the context-menu key opens a focused node's menu below it.
  const health = await page.evaluate(() => window.varia.health())
  expect(health.ok).toBe(true)
  const createScript = 'CREATE TABLE [dbo].[Orders] ([Id] int);'
  await application.evaluate(explorerBackend, { realHealth: health.value, script: createScript })
  const calls = method => application.evaluate((_electron, name) => globalThis.variaCalls.filter(call => call.method === name).map(call => call.params), method)
  const explorerMenu = menu('Object Explorer'), labels = () => explorerMenu.locator('.menu-item .menu-label').allTextContents()
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
  const serverA = page.getByRole('region', { name: 'Server server-a', exact: true })
  await expect(serverA.locator('[data-database="AppData"]')).toBeVisible()
  // A server: its own items, and New Query on its connection with focus in the new query.
  await serverA.locator('.server-toggle').click({ button: 'right', force: true })
  expect(await labels()).toEqual(['Connect…', 'Disconnect', 'New Query', 'Copy Name', 'Refresh'])
  await expect(serverA.locator('.server-row')).toHaveAttribute('data-menu-target', '')
  const before = await tabs().count()
  await explorerMenu.getByRole('menuitem', { name: 'New Query', exact: true }).click(fast)
  await expect(tabs()).toHaveCount(before + 1)
  await expect(page.locator('#query-server option:checked')).toHaveText('server-a')
  await expect(page.locator('#query-database')).toHaveValue('master')
  await expect(textbox()).toBeFocused()
  // A database's name, quoted.
  const appData = serverA.locator('[data-database="AppData"] .database-node')
  await appData.click({ button: 'right', force: true })
  expect(await labels()).toEqual(['New Query', 'Copy Name', 'Refresh'])
  await explorerMenu.getByRole('menuitem', { name: 'Copy Name', exact: true }).click(fast)
  await expect.poll(clipboard).toBe('[AppData]')
  await expect(appData).toBeFocused()
  // A table: Select Top 1000 Rows opens SSMS's script on its database and runs it there.
  await appData.click(fast)
  // master is expanded too (the new query selected it), and the stub lists the same table there.
  const orders = serverA.locator('[data-database="AppData"]').getByRole('button', { name: 'dbo.Orders', exact: true })
  await expect(orders).toBeVisible()
  await orders.click({ button: 'right', force: true })
  expect(await labels()).toEqual(['Select Top 1000 Rows', 'Script Table as', 'Copy Name'])
  await explorerMenu.getByRole('menuitem', { name: 'Select Top 1000 Rows', exact: true }).click(fast)
  const selectTop = ['/****** Script for SelectTopNRows command from Varia SQL Manager ******/', 'SELECT TOP (1000) [Id]', '      ,[CustomerName]', '  FROM [AppData].[dbo].[Orders]'].join('\n')
  await expect.poll(async () => (await calls('query.execute')).at(-1)?.sql).toBe(selectTop)
  expect((await calls('query.execute')).at(-1).database).toBe('AppData')
  expect(await calls('tables.columns')).toEqual([expect.objectContaining({ database: 'AppData', schema: 'dbo', name: 'Orders' })])
  await expect.poll(async () => (await editorText()).replaceAll(' ', ' ')).toBe(selectTop)
  await expect(page.locator('.results-grid')).toContainText('Contoso')
  // Script Table as › CREATE To › Clipboard, then File… through the save dialog.
  const scriptTo = async destination => {
    await orders.click({ button: 'right', force: true })
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
  // Refresh on Tables reloads that list only.
  const listed = { tables: (await calls('tables.list')).length, databases: (await calls('databases.list')).length }
  await serverA.getByRole('button', { name: 'Tables in AppData', exact: true }).click({ button: 'right', force: true })
  expect(await labels()).toEqual(['Refresh'])
  await explorerMenu.getByRole('menuitem', { name: 'Refresh', exact: true }).click(fast)
  await expect.poll(async () => (await calls('tables.list')).length).toBe(listed.tables + 1)
  expect((await calls('databases.list')).length).toBe(listed.databases)
  // The keyboard: Shift+F10 opens a focused table's menu below it with its first item active; so does the context-menu key.
  await orders.focus()
  await page.keyboard.press('Shift+F10')
  await expect(explorerMenu.getByRole('menuitem', { name: 'Select Top 1000 Rows', exact: true })).toBeFocused()
  await expect(orders).toHaveAttribute('data-menu-target', '')
  const node = await orders.boundingBox(), anchored = await explorerMenu.boundingBox()
  expect(anchored.y).toBeGreaterThanOrEqual(node.y + node.height - 1)
  expect(anchored.y).toBeLessThanOrEqual(node.y + node.height + 30)
  await page.keyboard.press('Escape')
  await expect(orders).toBeFocused()
  await expect(orders).not.toHaveAttribute('data-menu-target')
  await page.keyboard.press('ContextMenu')
  await expect(explorerMenu.getByRole('menuitem', { name: 'Select Top 1000 Rows', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  // F5 on a table refreshes its list, and the table keeps focus.
  await page.keyboard.press('F5')
  await expect.poll(async () => (await calls('tables.list')).length).toBe(listed.tables + 2)
  expect((await calls('databases.list')).length).toBe(listed.databases)
  await expect(orders).toBeFocused()
  // A login has only Copy Name; the server's Disconnect needs no picker.
  await serverA.getByRole('button', { name: 'Security', exact: true }).click(fast)
  await serverA.getByRole('button', { name: 'Logins', exact: true }).click(fast)
  await serverA.locator('.object-node').filter({ hasText: 'sa' }).click({ button: 'right', force: true })
  expect(await labels()).toEqual(['Copy Name'])
  await explorerMenu.getByRole('menuitem', { name: 'Copy Name', exact: true }).click(fast)
  await expect.poll(clipboard).toBe('[sa]')
  await serverA.locator('.server-toggle').click({ button: 'right', force: true })
  await explorerMenu.getByRole('menuitem', { name: 'Disconnect', exact: true }).click(fast)
  await expect(serverA).toHaveCount(0)
  await expect(page.locator('.quick-input')).toHaveCount(0)
  expect(await calls('connections.disconnect')).toHaveLength(1)
  console.log('Menus checks: Object Explorer menus for the empty area, a server, a database, a table, Tables, and a login, by mouse and keyboard.')

  // 13. Query Output: the results grid selects cells as SSMS does and copies them as tab-separated text, by its menu,
  // its keys, and Edit › Copy; Messages keep text selection, with Select All and Copy in their menu.
  await application.evaluate(({ ipcMain }, realHealth) => {
    ipcMain.removeHandler('varia:request')
    ipcMain.handle('varia:request', async (_event, method, params) => {
      if (method === 'system.health') return { ok: true, value: realHealth }
      if (method === 'connections.connect') return { ok: true, value: { id: crypto.randomUUID(), server: params.server, database: 'master', serverVersion: '17.0.test' } }
      if (method === 'databases.list' || method === 'server.objects.list') return { ok: true, value: [] }
      if (method === 'query.session.close') return { ok: true, value: { closed: true } }
      if (method === 'query.execute') return { ok: true, value: {
        resultSets: [{ columns: [{ name: 'Id', dataType: 'int' }, { name: '', dataType: 'nvarchar' }, { name: 'Note', dataType: 'nvarchar' }], rows: [[1, 'a', null], [2, 'b', 'n2'], [3, 'c', 'n3']], truncated: false }],
        messages: ['(3 rows affected)'], recordsAffected: 3, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1, database: 'master', messagesTruncated: false
      } }
      return { ok: false, error: 'Unsupported test operation.' }
    })
  }, health.value)
  await choose('File', 'Connect to Server…')
  await page.getByLabel('Server Name', { exact: true }).fill('server-b')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click(fast)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await typeSql('SELECT Id, Name, Note FROM dbo.Notes')
  await page.keyboard.press('F5')
  const grid = page.locator('.grid-scroll'), outputMenu = menu('Query output'), eol = process.platform === 'win32' ? '\r\n' : '\n'
  const cell = (row, column) => grid.locator(`td[data-row="${row}"][data-col="${column}"]`), selected = () => grid.locator('td.selected')
  const outputLabels = () => outputMenu.locator('.menu-item .menu-label').allTextContents()
  await expect(grid).toContainText('n3')
  // Focusable output views are named regions, so screen readers announce their names.
  await expect(page.getByRole('region', { name: 'Result 1, 3 rows, 3 columns', exact: true })).toBeVisible()
  // Earlier steps shrank the window, so the output panel may be short. Every row must show: Playwright scrolls a cell
  // into view before pressing it, and that scroll would close a menu the press had just opened.
  const outputTop = (await page.locator('.output-panel').boundingBox()).y
  const sashes = await Promise.all((await page.locator('.dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash.dv-enabled').all()).map(sash => sash.boundingBox()))
  const above = sashes.filter(box => box && box.y < outputTop).sort((a, b) => b.y - a.y)[0]
  await page.mouse.move(above.x + above.width / 2, above.y + above.height / 2)
  await page.mouse.down()
  await page.mouse.move(above.x + above.width / 2, Math.min(above.y, 260), { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => grid.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true)
  await expect(grid.getByRole('columnheader').nth(2)).toContainText('(No column name)')
  // A right-click selects the cell under it first; Copy copies its value.
  await cell(1, 2).click({ button: 'right', force: true })
  expect(await outputLabels()).toEqual(['Copy', 'Copy with Headers', 'Select All'])
  await expect(selected()).toHaveCount(1)
  await expect(cell(1, 2)).toHaveClass(/selected/)
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
  // macOS reports Control+click as a left press with Control and opens the menu, so there it keeps the selection as a
  // right-click does; elsewhere it is a left press.
  await cell(0, 0).click(fast)
  await cell(2, 1).click({ modifiers: ['Shift'], force: true })
  await cell(1, 1).dispatchEvent('pointerdown', { button: 0, buttons: 1, ctrlKey: true, pointerType: 'mouse', isPrimary: true })
  await cell(1, 1).dispatchEvent('pointerup', { button: 0, buttons: 0, ctrlKey: true, pointerType: 'mouse', isPrimary: true })
  await expect(selected()).toHaveCount(process.platform === 'darwin' ? 6 : 1)
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
  await page.keyboard.press('Shift+F10')
  await expect(outputMenu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeFocused()
  const activeCell = await cell(2, 0).boundingBox(), gridMenu = await outputMenu.boundingBox()
  expect(Math.abs(gridMenu.y - (activeCell.y + activeCell.height)) <= 1 || gridMenu.y + gridMenu.height <= activeCell.y + 1).toBe(true)
  await page.keyboard.press('Escape')
  await expect(grid).toBeFocused()
  // Messages: no Copy with Headers; Select All selects only the messages, which Copy then copies.
  await page.locator('.output-toolbar').getByRole('button', { name: /^Messages/ }).click(fast)
  const messages = page.locator('.messages')
  await expect(page.getByRole('region', { name: 'Messages', exact: true })).toBeVisible()
  await messages.locator('pre').first().click({ button: 'right', force: true })
  expect(await outputLabels()).toEqual(['Copy', 'Select All'])
  await expect(outputMenu.getByRole('menuitem', { name: 'Copy', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await outputMenu.getByRole('menuitem', { name: 'Select All', exact: true }).click(fast)
  await expect(messages).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await outputMenu.getByRole('menuitem', { name: 'Copy', exact: true }).click(fast)
  await expect.poll(clipboard).toContain('(3 rows affected)')
  expect(await clipboard()).toContain('Completed in 1 ms.')
  expect(await clipboard()).not.toContain('SELECT')
  console.log('Menus checks: results grid cell selection and copying by menu, keys, and Edit › Copy, and the Messages menu.')

  // 14. Every surface, twice: each menu opens by mouse or keyboard, Escape closes all of it, the outline goes, and focus
  // returns where it was. Then the table's menu, with its submenus open, is captured in Dark and Light.
  await application.evaluate(explorerBackend, { realHealth: health.value, script: createScript, plan: true })
  await page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true }).click(fast)
  await page.getByLabel('Server Name', { exact: true }).fill('server-a')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click(fast)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await serverA.locator('[data-database="AppData"] .database-node').click(fast)
  await expect(orders).toBeVisible()
  await serverA.getByRole('button', { name: 'Security', exact: true }).click(fast)
  await serverA.getByRole('button', { name: 'Logins', exact: true }).click(fast)
  const login = serverA.locator('.object-node').filter({ hasText: 'sa' })
  await expect(login).toBeVisible()
  await typeSql('SELECT Id, CustomerName FROM dbo.Orders')
  await page.keyboard.press('F5')
  await page.locator('.output-toolbar').getByRole('button', { name: /^Results/ }).click(fast)
  await expect(page.locator('.result-selector').getByRole('button', { name: 'XML plan', exact: true })).toBeVisible()
  const showResult = name => page.locator('.result-selector').getByRole('button', { name, exact: true }).click({ force: true })
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
    ['a server', () => rightClick(serverA.locator('.server-toggle')), serverA.locator('.server-toggle')],
    ['the Databases folder', () => rightClick(serverA.getByRole('button', { name: 'Databases', exact: true })), serverA.getByRole('button', { name: 'Databases', exact: true })],
    ['a database', () => rightClick(appData), appData],
    ['a Tables folder', () => rightClick(serverA.getByRole('button', { name: 'Tables in AppData', exact: true })), serverA.getByRole('button', { name: 'Tables in AppData', exact: true })],
    ['a table\'s Script Table as › CREATE To', async () => {
      await rightClick(orders)
      await tap(explorerMenu.getByRole('menuitem', { name: 'Script Table as', exact: true }))
      await tap(menu('Script Table as').getByRole('menuitem', { name: 'CREATE To', exact: true }))
      await expect(menu('CREATE To')).toBeVisible()
    }, orders],
    ['a table by Shift+F10', async () => { await orders.focus(); await page.keyboard.press('Shift+F10') }, orders],
    ['the Logins folder', () => rightClick(serverA.getByRole('button', { name: 'Logins', exact: true })), serverA.getByRole('button', { name: 'Logins', exact: true })],
    ['a login', () => rightClick(login), null],
    ['a results grid cell', async () => { await showResult('Result 1'); await rightClick(cell(0, 1)) }, grid],
    ['the results grid by Shift+F10', async () => { await grid.focus(); await page.keyboard.press('Shift+F10') }, grid],
    ['Messages', async () => { await tap(page.locator('.output-toolbar').getByRole('button', { name: /^Messages/ })); await rightClick(messages.locator('pre').first()) }, messages],
    ['the XML plan', async () => {
      await tap(page.locator('.output-toolbar').getByRole('button', { name: /^Results/ }))
      await showResult('XML plan')
      await rightClick(page.locator('.plan-output'))
    }, page.locator('.plan-output')],
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
  await showResult('Result 1')
  for (const mode of ['dark', 'light']) {
    await page.evaluate(value => window.varia.setThemePreference({ mode: value }), mode)
    await expect.poll(appearance).toContain(`"mode": "${mode}"`)
    await expect.poll(async () => await variable('editor.background') === '#ffffff').toBe(mode === 'light')
    await rightClick(orders)
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
  await expect(page.getByText(/\.NET 10\..*Ready/)).toBeVisible({ timeout: 30000 })
  expect(await page.evaluate(() => window.varia.menuStyle)).toBe('native')
  await application.evaluate(explorerBackend, { realHealth: health.value, script: createScript })
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
  const nativeServer = page.getByRole('region', { name: 'Server server-a', exact: true })
  await nativeServer.locator('[data-database="AppData"] .database-node').click(fast)
  const nativeTable = nativeServer.locator('[data-database="AppData"]').getByRole('button', { name: 'dbo.Orders', exact: true })
  await expect(nativeTable).toBeVisible()
  // A table's menu at the pointer: the catalogue's labels from main, the table outlined until it closes.
  const tableBox = await nativeTable.boundingBox()
  await nativeTable.click({ button: 'right', position: { x: 12, y: 6 } })
  await expect.poll(async () => (await popups()).length).toBe(2)
  const tablePopup = (await popups())[1]
  expect(tablePopup.items).toEqual(['Select Top 1000 Rows', '---', ['Script Table as', [['CREATE To', ['New Query Editor Window', 'File…', 'Clipboard']]]], '---', 'Copy Name'])
  expect(Math.abs(tablePopup.x - (tableBox.x + 12))).toBeLessThanOrEqual(1)
  expect(Math.abs(tablePopup.y - (tableBox.y + 6))).toBeLessThanOrEqual(1)
  await expect(openMenus()).toHaveCount(0)
  await expect(nativeTable).toHaveAttribute('data-menu-target', '')
  await expect(nativeTable).toBeFocused()
  await pick('explorer.scriptCreateToClipboard')
  await expect.poll(clipboard).toBe(createScript)
  await expect(nativeTable).not.toHaveAttribute('data-menu-target')
  await nativeTable.click({ button: 'right' })
  await expect.poll(async () => (await popups()).length).toBe(3)
  await pick('explorer.copyName', 'close first')
  await expect.poll(clipboard).toBe('[dbo].[Orders]')
  // Only the open menu's token counts: a choice from the table's older menu does not run on the server's.
  await nativeServer.locator('.server-toggle').click({ button: 'right' })
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
  await nativeTable.focus()
  await page.keyboard.press('Shift+F10')
  await expect.poll(async () => (await popups()).length).toBe(6)
  const nodeBox = await nativeTable.boundingBox(), keyboardPopup = (await popups())[5]
  expect(keyboardPopup.y).toBeGreaterThanOrEqual(nodeBox.y + nodeBox.height - 1)
  expect(keyboardPopup.y).toBeLessThanOrEqual(nodeBox.y + nodeBox.height + 30)
  expect(keyboardPopup.x).toBeGreaterThanOrEqual(nodeBox.x - 30)
  await application.evaluate(() => globalThis.variaPopups.at(-1).options.callback())
  await expect(nativeTable).toBeFocused()
  // When main cannot show a menu, the workbench shows the same one itself.
  await popupMode('fail')
  await nativeTable.click({ button: 'right' })
  const fallbackMenu = menu('Object Explorer')
  await expect(fallbackMenu).toBeVisible()
  expect(await fallbackMenu.locator('.menu-item .menu-label').allTextContents()).toEqual(['Select Top 1000 Rows', 'Script Table as', 'Copy Name'])
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
  expect((await popups()).length).toBe(7)
  console.log('Menus checks: native context menus with their token round trip, roles on the focused field, the keyboard, the fallback, and none for an idle page.')

  // 16. A real server, when VARIA_TEST_SQL_SERVER is set, in a fresh app with themed menus: master's New Query runs on
  // master, and the server's Refresh reloads its lists without an error.
  if (process.env.VARIA_TEST_SQL_SERVER) {
    expect(failures).toEqual([])
    await application.close()
    application = await electron.launch(launchOptions)
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
    const live = page.locator('.server-section'), systemDatabases = live.getByRole('button', { name: 'System Databases', exact: true })
    await expect(systemDatabases).toBeVisible({ timeout: 30000 })
    if (await systemDatabases.getAttribute('aria-expanded') === 'false') await systemDatabases.click(fast)
    const master = live.locator('[data-database="master"] .database-node')
    const liveTabs = await tabs().count()
    await master.click({ button: 'right' })
    await menu('Object Explorer').getByRole('menuitem', { name: 'New Query', exact: true }).click(fast)
    await expect(tabs()).toHaveCount(liveTabs + 1)
    await expect(textbox()).toBeFocused()
    await expect(page.locator('#query-database')).toHaveValue('master')
    await page.keyboard.insertText('SELECT DB_NAME()')
    await page.keyboard.press('F5')
    await expect(page.locator('.grid-scroll td[data-row="0"][data-col="0"]')).toHaveText('master', { timeout: 30000 })
    await live.locator('.server-toggle').click({ button: 'right' })
    await menu('Object Explorer').getByRole('menuitem', { name: 'Refresh', exact: true }).click(fast)
    await expect(live.getByText('Loading…')).toHaveCount(0, { timeout: 30000 })
    await expect(master).toBeVisible()
    // Monaco's empty live regions are alerts too; these are the workbench's error messages.
    await expect(page.locator('.global-error, .explorer-error, .query-error')).toHaveCount(0)
    console.log('Menus checks: a real server\'s master database opens a query on master from its menu, and the server refreshes.')
  } else console.log('Menus checks: the live server step was skipped (VARIA_TEST_SQL_SERVER is not set).')

  expect(failures).toEqual([])
  console.log('Menus checks passed: title-bar menus by mouse, keyboard, F10, and Alt; submenus and theme choices; editing and zoom roles; the inactive title bar; the results pane toggle; context menus for the editor, query tabs, panel tabs, text fields, Object Explorer, and Query Output; results grid cell selection; every surface opened and closed twice; native context menus; and a live server when configured.')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'menus-failure.png') }).catch(() => {})
  console.log(await page?.evaluate(() => ({ focused: document.activeElement?.outerHTML.slice(0, 300), menus: document.querySelectorAll('.menu').length, errors: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent) })).catch(() => 'no page'))
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
}
