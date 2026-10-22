import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { activeMenuItem, documentTabs, movePane, editorText as editorTextOf, openMenus, statusBar, themeNotice, toolbarButton } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'theme-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const themesFolder = join(profile, 'themes'), smokeTheme = join(themesFolder, 'smoke.json'), appearanceFile = join(profile, 'appearance.json')
const canonical = /^#[0-9a-f]{6}([0-9a-f]{2})?$/
const sql = "SELECT COUNT((42)) AS answer, N'theme' AS label; -- survives a theme switch"
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Theme suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 180000)

async function launch() {
  application = await electron.launch(launchOptions)
  page = await application.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.getByText(/\.NET 10\..*Ready/)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
}
// Unsaved queries make a normal exit ask first; answer Don't Save.
async function close() {
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await application.close()
}
// Every theme change rebuilds the application menu, so items are looked up afresh for each click.
async function menu(id) {
  await application.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu().getMenuItemById(itemId)
    if (!item) throw new Error('Menu item missing: ' + itemId)
    item.click()
  }, id)
}
const menuItem = id => application.evaluate(({ Menu }, itemId) => {
  const item = Menu.getApplicationMenu().getMenuItemById(itemId)
  return item ? { label: item.label, checked: item.checked, enabled: item.enabled } : null
}, id)
const variable = key => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), '--varia-' + key.replaceAll('.', '-'))
const variables = keys => Promise.all(keys.map(variable))
const native = () => application.evaluate(({ BrowserWindow, nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors, background: BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase() }))
const backgroundOf = selector => page.locator(selector).first().evaluate(element => getComputedStyle(element).backgroundColor)
const shellClasses = () => page.locator('.dv-shell').evaluate(element => [...element.classList].filter(name => /^(dockview-theme-|varia-dock$)/.test(name)).sort())
const editorText = () => editorTextOf(page)
const themeState = () => page.evaluate(async () => (await window.varia.getThemeState()).value)
// Dockview draws the dock tab focus ring on ::after; programmatic focus counts as keyboard focus here.
const dockTabFocusRing = () => page.locator('.dv-tab').first().evaluate(tab => { tab.focus(); return [tab.matches(':focus-visible'), getComputedStyle(tab, '::after').outlineColor] })
const contextMenuBorder = () => openMenus(page).evaluate(menu => { const style = getComputedStyle(menu); return `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}` })
// A theme color as the browser resolves it, to compare with computed styles.
const colorOf = key => page.evaluate(name => {
  const probe = document.body.appendChild(document.createElement('div'))
  probe.style.background = `var(${name})`
  const color = getComputedStyle(probe).backgroundColor
  probe.remove()
  return color
}, '--varia-' + key.replaceAll('.', '-'))
// CI keeps screenshots only as artifacts, so a failure also logs the themes folder, the published theme state, and the
// native menu's theme items.
async function diagnostics() {
  const state = await themeState().catch(reason => ({ error: String(reason) }))
  const menuIds = await application?.evaluate(({ Menu }) => {
    const ids = []
    const visit = menu => { for (const item of menu?.items ?? []) { if (item.id?.startsWith('theme.')) ids.push(`${item.id}${item.checked ? ' [checked]' : ''}${item.enabled ? '' : ' [disabled]'}`); visit(item.submenu) } }
    visit(Menu.getApplicationMenu())
    return ids
  }).catch(reason => String(reason))
  return {
    files: await readdir(themesFolder).catch(reason => String(reason)), preference: state?.preference, revision: state?.revision, notice: state?.notice,
    themes: state?.themes?.map(theme => `${theme.id} (${theme.source}, ${theme.types?.join('/')}${theme.usable ? '' : ', unusable'})`), problems: state?.problems, error: state?.error, menu: menuIds
  }
}
// expect.poll does not retry a callback that throws, and appearance.json appears only after the first choice.
const appearance = () => readFile(appearanceFile, 'utf8').then(JSON.parse, () => null)
const lightKeys = ['editor.background', 'foreground', 'button.background', 'titleBar.activeBackground', 'connection.red']
// Monaco paints matched brackets by depth over the token colors; the outer and inner parentheses of COUNT((42)).
const bracketColors = () => page.evaluate(() => [0, 1].map(level => {
  const bracket = document.querySelector('.monaco-editor .view-lines .bracket-highlighting-' + level)
  return bracket && getComputedStyle(bracket).color
}))

try {
  await launch()
  // A fresh profile keeps today's dark look and drives the native chrome before the first paint.
  expect(await variable('editor.background')).toBe('#11151c')
  expect(await backgroundOf('.monaco-editor')).toBe('rgb(17, 21, 28)')
  expect(await native()).toMatchObject({ source: 'dark', background: '#11151c' })
  expect(await shellClasses()).toEqual(['dockview-theme-dark', 'varia-dock'])
  expect(await page.evaluate(() => [document.documentElement.style.colorScheme, document.documentElement.dataset.themeType])).toEqual(['dark', 'dark'])
  await expect(themeNotice(page)).toHaveCount(0)
  await expect(statusBar(page)).toHaveAttribute('data-state', 'disconnected')
  console.log('Theme checks: fresh profile paints Varia Dark in CSS, Monaco, Dockview, and the native window.')

  // Floating groups live outside .dock-workbench; they used to fall back to Dockview's own grey.
  await movePane(page, 'output', 'float')
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(1)
  expect(await backgroundOf('.dv-floating-titlebar')).toBe('rgb(24, 31, 42)')
  await menu('layout.reset')
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(0)
  console.log('Theme checks: floating groups use the theme colors.')

  expect(await dockTabFocusRing()).toEqual([true, 'rgb(118, 172, 255)'])
  // The editor's context menu is the workbench's: its border and highlighted item use the menu colors.
  await page.locator('.monaco-editor .view-lines').click({ button: 'right' })
  await expect(openMenus(page)).toBeVisible()
  expect(await contextMenuBorder()).toBe('1px solid rgb(95, 112, 137)')
  await page.keyboard.press('ArrowDown')
  await expect(activeMenuItem(page)).toBeFocused()
  expect(await activeMenuItem(page).evaluate(item => getComputedStyle(item).backgroundColor)).toBe(await colorOf('menu.selectionBackground'))
  await page.keyboard.press('Escape')
  await expect(openMenus(page)).toHaveCount(0)
  // The find and hover widgets take their shadow from --vscode-shadow-lg, which standalone Monaco leaves undefined too.
  await page.locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+F')
  const findWidget = page.locator('.monaco-editor .find-widget')
  await expect(findWidget).toHaveClass(/\bvisible\b/)
  expect(await findWidget.evaluate(element => getComputedStyle(element).boxShadow)).toBe('rgba(0, 0, 0, 0.6) 0px 0px 12px 0px')
  await page.keyboard.press('Escape')
  // Monaco keeps the closed widget in the layout, so its class says whether it is open.
  await expect(findWidget).not.toHaveClass(/\bvisible\b/)
  console.log('Theme checks: dock tab focus rings, the editor context menu border, and the find widget shadow use the theme colors.')

  await page.locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(sql)
  // Monaco renders spaces as no-break spaces.
  await expect.poll(editorText).toContain('SELECT\u00a0COUNT((42))')
  const typed = await editorText()
  await expect.poll(bracketColors).toEqual(['rgb(255, 215, 0)', 'rgb(218, 112, 214)'])
  await page.screenshot({ path: resolve('artifacts', 'theme-dark.png') })
  await page.evaluate(() => { window.__themeSentinel = 1 })
  if (process.platform !== 'darwin') await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], original = window.setTitleBarOverlay.bind(window)
    globalThis.themeOverlays = []
    window.setTitleBarOverlay = options => { globalThis.themeOverlays.push(options); return original(options) }
  })
  await menu('theme.mode.light')
  await expect.poll(() => variables(lightKeys)).toEqual(['#ffffff', '#1f2733', '#005fb8', '#e9edf2', '#c42b3c'])
  await expect.poll(() => backgroundOf('.monaco-editor')).toBe('rgb(255, 255, 255)')
  expect(await shellClasses()).toEqual(['dockview-theme-light', 'varia-dock'])
  expect(await page.evaluate(() => [document.documentElement.style.colorScheme, document.documentElement.dataset.themeType])).toEqual(['light', 'light'])
  await expect.poll(native).toMatchObject({ source: 'light', background: '#ffffff' })
  if (process.platform !== 'darwin') expect(await application.evaluate(() => globalThis.themeOverlays.at(-1))).toEqual({ color: '#e9edf2', symbolColor: '#1f2733' })
  await expect.poll(async () => (await appearance())?.mode).toBe('light')
  expect(await page.evaluate(() => window.__themeSentinel)).toBe(1)
  expect(await editorText()).toBe(typed)
  expect(await menuItem('theme.mode.light')).toMatchObject({ checked: true })
  expect(await dockTabFocusRing()).toEqual([true, 'rgb(0, 95, 184)'])
  await expect.poll(bracketColors).toEqual(['rgb(4, 49, 250)', 'rgb(40, 122, 40)'])
  await page.screenshot({ path: resolve('artifacts', 'theme-light.png') })
  console.log('Theme checks: switching to Light updates CSS, Monaco, Dockview, native chrome, and the preference without a reload.')

  await mkdir(themesFolder, { recursive: true })
  await writeFile(smokeTheme, JSON.stringify({ kind: 'varia-color-theme', version: 1, name: 'Smoke', type: 'dark', palette: { accent: '#ffb000' } }))
  await menu('theme.reload')
  await expect.poll(() => menuItem('theme.dark.smoke')).toMatchObject({ label: 'Smoke', enabled: true })
  await menu('theme.dark.smoke')
  // A Dark-list choice while the mode is Light switches the mode too.
  await expect.poll(() => variables(['button.background', 'tab.activeBorderTop', 'editor.background'])).toEqual(['#ffb000', '#ffb000', '#11151c'])
  await expect.poll(native).toMatchObject({ source: 'dark', background: '#11151c' })
  await expect.poll(appearance).toEqual({ version: 1, mode: 'dark', darkTheme: 'smoke', lightTheme: 'varia-light' })
  await expect(themeNotice(page)).toHaveCount(0)

  // Theme values never reach CSS as text: the grammar drops this entry and the default accent is used.
  await writeFile(smokeTheme, '{ "kind": "varia-color-theme", "version": 1, "name": "Smoke", "type": "dark", "palette": { "accent": "red;}body{display:none" } }')
  await menu('theme.reload')
  const notice = themeNotice(page).and(page.getByRole('status'))
  await expect(notice).toContainText('smoke.json /palette/accent')
  await expect(notice).toContainText('Reloaded 1 theme; 1 has problems.')
  await expect.poll(() => variable('button.background')).toBe('#8fb7ff')
  const applied = await page.evaluate(() => [...document.documentElement.style].filter(name => name.startsWith('--varia-')).map(name => [name, document.documentElement.style.getPropertyValue(name)]))
  expect(applied).toHaveLength(Object.keys((await themeState()).active.colors).length)
  expect(applied.filter(([, value]) => !canonical.test(value))).toEqual([])
  await expect(page.locator('body')).toBeVisible()
  expect(await page.evaluate(() => getComputedStyle(document.body).display)).not.toBe('none')
  // The button's own failure is shown once, under the notice, and does not also become the notice.
  await application.evaluate(({ shell }) => { shell.openPath = async () => 'No application is registered' })
  await notice.getByRole('button', { name: 'Open Themes Folder', exact: true }).click()
  await expect(notice).toContainText('The themes folder could not be opened: No application is registered')
  expect((await notice.innerText()).split('could not be opened').length - 1).toBe(1)
  expect((await themeState()).notice).toBe('Reloaded 1 theme; 1 has problems.')
  // A later notice, even one with the same text, starts without that failure.
  const reported = (await themeState()).noticeId
  await menu('theme.reload')
  await expect.poll(async () => (await themeState()).noticeId).toBeGreaterThan(reported)
  await expect(notice).toContainText('Reloaded 1 theme; 1 has problems.')
  await expect(notice).not.toContainText('could not be opened')
  await application.evaluate(({ shell }) => { shell.openPath = async path => { globalThis.openedThemes = path; return '' } })
  await notice.getByRole('button', { name: 'Open Themes Folder', exact: true }).click()
  await expect.poll(() => application.evaluate(() => globalThis.openedThemes)).toBe(themesFolder)
  await notice.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(themeNotice(page)).toHaveCount(0)
  // Dismissing hides that notice, not its text: reloading again reports again.
  await menu('theme.reload')
  await expect(notice).toContainText('Reloaded 1 theme; 1 has problems.')
  await notice.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(themeNotice(page)).toHaveCount(0)
  await toolbarButton(page, 'New query').click()
  await expect(documentTabs(page).getByRole('tab')).toHaveCount(2)
  expect((await page.evaluate(() => window.varia.health())).ok).toBe(true)
  console.log('Theme checks: custom themes load and switch, and an injection attempt only warns.')

  // A selected theme that breaks falls back for the session; the file and the preference stay for a later fix.
  const broken = '{ "kind": "varia-color-theme", "version": 1, "name": "Smoke", '
  await writeFile(smokeTheme, broken)
  await close()
  await launch()
  const alert = themeNotice(page).and(page.getByRole('alert'))
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('smoke.json')
  await expect(alert).toContainText('Varia Dark is used instead')
  expect(await variables(['editor.background', 'button.background'])).toEqual(['#11151c', '#8fb7ff'])
  expect(await native()).toMatchObject({ source: 'dark', background: '#11151c' })
  expect(await readFile(smokeTheme, 'utf8')).toBe(broken)
  expect(await appearance()).toEqual({ version: 1, mode: 'dark', darkTheme: 'smoke', lightTheme: 'varia-light' })
  // A file that does not parse has no name, so the menu shows its id.
  expect(await menuItem('theme.dark.smoke')).toEqual({ label: 'smoke (invalid: using Varia Dark)', checked: true, enabled: false })
  console.log('Theme checks: a broken selected theme falls back to Varia Dark with an alert and keeps the file and preference.')

  await application.evaluate(({ shell }) => { shell.showItemInFolder = path => { globalThis.shownTheme = path } })
  await menu('theme.create')
  await expect.poll(() => application.evaluate(() => globalThis.shownTheme)).toBe(join(themesFolder, 'custom-theme.json'))
  await expect.poll(async () => (await appearance())?.darkTheme).toBe('custom-theme')
  expect(JSON.parse(await readFile(join(themesFolder, 'custom-theme.json'), 'utf8'))).toMatchObject({ kind: 'varia-color-theme', version: 1, name: 'My Theme', type: 'dark', palette: { accent: '#8fb7ff' } })
  expect(JSON.parse(await readFile(join(themesFolder, 'varia-theme.schema.json'), 'utf8')).title).toMatch(/Varia/)
  await expect(themeNotice(page)).toHaveCount(0)
  console.log('Theme checks: Create Custom Theme writes a starter and the schema, then selects the starter.')

  await menu('theme.mode.system')
  await expect.poll(async () => (await native()).source).toBe('system')
  const system = await native()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe(system.dark ? 'dark' : 'light')
  expect((await themeState()).active.type).toBe(system.dark ? 'dark' : 'light')
  await expect.poll(async () => (await appearance())?.mode).toBe('system')
  expect(failures).toEqual([])
  console.log('Theme checks passed: fresh-profile Dark, floating groups, live Light switch with native chrome, custom and injected themes, fallback after restart, Create Custom Theme, and Follow System.')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'theme-failure.png') }).catch(() => {})
  console.log(await diagnostics().catch(reason => 'Diagnostics failed: ' + reason))
  throw error
} finally {
  clearTimeout(watchdog)
  await close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
}
