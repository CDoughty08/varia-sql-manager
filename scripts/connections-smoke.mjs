import { electron, expect } from './fixtures/smoke.mjs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { userInfo } from 'node:os'
import { parseCalls } from './fixtures/call-log.mjs'
import { explorerRow, explorerStatics } from './fixtures/explorer-tree.mjs'
import {
  activeDocument, activeDocumentName, backendReady, clickToClose, connectDialogWindow, connectErrorDetails, connectFailure, connectFailureCopyStatus, connectFailureNote, connectFailureSentence, connectOutcome, databaseErrorDetails,
  dialogClosed, documentTab, editorGroups, editorTextbox, environmentPill, explorerLabel, localGrid, objectSearchBox, objectSearchHits, part, pressToClose, queryBar, queryServer, queryStatus, quickInput, savedConnections, selectOpenDocument,
  serverRows, statusBar, submitConnect, toolbarButton, expectEditorShown
} from './fixtures/ui.mjs'
import { resizeContent } from './fixtures/window-resize.mjs'
import { connectionLifecycle } from './fixtures/connection-lifecycle.mjs'

// Same rules as the backend live checks: SQL authentication when a test login is supplied, otherwise Windows authentication.
const liveUser = process.env.VARIA_TEST_SQL_USER?.trim() ? process.env.VARIA_TEST_SQL_USER : undefined
if (process.env.VARIA_TEST_SQL_SERVER && liveUser && process.env.VARIA_TEST_SQL_PASSWORD === undefined) throw new Error('VARIA_TEST_SQL_PASSWORD is required when VARIA_TEST_SQL_USER is set.')
await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'connections-profile-'))
// A credential cache that does not exist: off Windows, Windows Authentication's User name is then the OS user name.
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, KRB5CCNAME: 'FILE:' + join(profile, 'no-kerberos-ticket') }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const recentId = crypto.randomUUID()
// Seeded under 0.9.0's name: startup copies it to mssql-connections.json (profile-migration.ts), which the checks below read.
await writeFile(join(profile, 'connections.json'), JSON.stringify({ version: 1, profiles: [{ id: recentId, options: { server: 'recent-server', database: 'master', authentication: 'windows', trustServerCertificate: false }, favorite: false, registered: false, lastConnected: new Date().toISOString() }] }))
let app
let page
let connectWin
const failures = []
// Ten minutes: the dialog, Remember password and environment labels with the query bar's narrow layouts took about five
// on Windows and Linux runners once the Connect dialog's two-pane checks joined them, so the bound that catches a hang
// leaves them room.
const watchdog = setTimeout(() => { console.error('Connection suite timed out.'); app?.process()?.kill(); process.exitCode = 1 }, 600000)
// Remember password's phase: its own profile and the fake backend, whose server password-check accepts only one password.
const passwordProfile = await mkdtemp(resolve('artifacts', 'connections-passwords-'))
// Environment labels' phase: the fake backend behind main's real request, history and library handlers.
const environmentProfile = await mkdtemp(resolve('artifacts', 'connections-environments-'))
// BigQuery's phase: its own profile, against the emulator VARIA_TEST_BIGQUERY_ENDPOINT names (docs/bigquery.md, Testing).
const bigQueryProfile = await mkdtemp(resolve('artifacts', 'connections-bigquery-'))
async function launch(options = launchOptions, runtime) {
  app = await electron.launch(options)
  page = await app.firstWindow()
  connectWin = undefined
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page, runtime)).toBeVisible({ timeout: 30000 })
  await expectEditorShown(page)
}
async function open() {
  await toolbarButton(page, 'Connect').click()
  const opened = await connectDialogWindow(app)
  connectWin = opened.window
  return opened.dialog
}
/** The two panes side by side inside 900×730 (or the fallback dialog bounds), with the footer under the form and failures just above it. */
const layout = dialog => dialog.evaluate((form, part) => {
  const box = element => element?.getBoundingClientRect()
  const outer = box(form), sources = box(form.querySelector(part.connectSourcesPane)), fields = box(form.querySelector(part.connectFormPane))
  const footer = box(form.querySelector(part.connectionFooter)), scroll = box(form.querySelector(part.connectFormScroll)), failure = box(form.querySelector(part.connectFailure))
  const expectedWidth = form.closest(part.dialogWindowRoot) ? innerWidth : Math.min(900, innerWidth - 40)
  return {
    size: Math.abs(outer.width - expectedWidth) < 1 && outer.height <= 730.5,
    sideBySide: sources.right <= fields.left + 0.5 && Math.abs(sources.top - fields.top) < 1,
    connectInside: footer.bottom <= outer.bottom + 0.5 && Math.abs(footer.left - fields.left) < 1 && Math.abs(footer.right - fields.right) < 1,
    failureAtConnect: failure ? failure.top >= scroll.bottom - 0.5 && failure.bottom <= footer.top + 0.5 : null
  }
}, part)
/** Check the ink's bounds as well as the buttons' bounds. A nowrap label can spill outside an otherwise visible button. */
const footerFit = dialog => dialog.locator(part.connectionFooter).evaluate(footer => {
  const box = footer.getBoundingClientRect(), buttons = [...footer.querySelectorAll('button')]
  const bounds = buttons.map(button => button.getBoundingClientRect())
  const last = bounds.at(-1), first = bounds[0]
  const insets = [first.left - box.left, box.right - last.right]
  return {
    labelsFit: buttons.every((button, index) => {
      const range = document.createRange(), rect = bounds[index]
      range.selectNodeContents(button.firstElementChild ?? button)
      return [...range.getClientRects()].every(text =>
        text.left >= rect.left - 0.5 && text.right <= rect.right + 0.5 && text.top >= rect.top - 0.5 && text.bottom <= rect.bottom + 0.5)
    }),
    inset: insets.every(inset => Math.abs(inset - 8) < 1),
    inside: bounds.every(button => button.left >= box.left + 7 && button.right <= box.right - 7 && button.bottom <= box.bottom + 0.5),
    grouped: [...footer.children].every(group => {
      const groupButtons = [...group.querySelectorAll('button')]
      return groupButtons.length > 0 && groupButtons.every(button => Math.abs(button.getBoundingClientRect().bottom - groupButtons[0].getBoundingClientRect().bottom) < 1)
    }),
    wrapped: first.bottom <= last.top
  }
})
const containedFooter = { labelsFit: true, inset: true, inside: true, grouped: true }
const fittingFooter = { ...containedFooter, wrapped: false }
async function expectControlHeight(control, dense = false) {
  const { height, expected } = await control.evaluate((element, dense) => {
    const style = getComputedStyle(element)
    const metric = name => parseFloat(style.getPropertyValue(name))
    return { height: parseFloat(style.height), expected: metric('--varia-control') - (dense ? metric('--varia-space-1') : 0) }
  }, dense)
  expect(height).toBeCloseTo(expected, 1)
}
/** Where the footer's Connect and Cancel (or Stop) sit: what shows at Connect must never move them under the pointer.
 *  Reset Form (when inline), Test Connection and Save come first. */
const footerPlace = dialog => dialog.locator(part.connectionFooter).evaluate(footer => [...footer.querySelectorAll('button')].slice(-2).map(button => {
  const box = button.getBoundingClientRect()
  return [box.top, box.bottom, box.right].map(Math.round)
}))
/**
 * Stacked, in a narrow or zoomed window: the panes in one scroll, the list two rows tall, the form with room for at least
 * two of its rows beside the outcome, and, with the panes scrolled back up to the list, the outcome under the scroll and
 * the footer at the dialog's bottom.
 */
const stackedRoom = dialog => dialog.evaluate((form, part) => {
  const box = element => element.getBoundingClientRect()
  const panes = form.querySelector(part.connectPanes), list = form.querySelector(part.connectionSources), row = form.querySelector(part.connectionListRow), scroll = form.querySelector(part.connectFormScroll), actions = form.querySelector(part.connectActions), outcome = form.querySelector(part.connectOutcome), footer = form.querySelector(part.connectionFooter)
  scroll.scrollIntoView({ block: 'start' })
  const top = Math.max(box(scroll).top, box(panes).top), bottom = Math.min(box(scroll).bottom, box(panes).bottom, box(actions).top)
  const room = bottom - top >= 60
  panes.scrollTop = 0
  const end = box(form).top + form.clientTop + form.clientHeight
  return {
    stacked: box(form.querySelector(part.connectSourcesPane)).bottom <= box(scroll).top + 0.5, rows: list.clientHeight >= 2 * box(row).height, room,
    inside: !!outcome && box(outcome).top >= box(panes).bottom - 0.5 && box(actions).bottom <= end + 0.5 && Math.abs(box(footer).bottom - end) < 1 && form.scrollHeight <= form.clientHeight + 0.5
  }
}, part)
/** Whether the focused element's focus ring (outline) lies inside the scrolling list that holds it, which would clip it. */
const ringInside = dialog => dialog.evaluate((form, part) => {
  const row = form.ownerDocument.activeElement, list = form.querySelector(part.connectionSources)
  const style = getComputedStyle(row), reach = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)
  const inner = row.getBoundingClientRect(), outer = list.getBoundingClientRect()
  return list.contains(row) && style.outlineStyle !== 'none' && inner.left - reach >= outer.left - 0.5 && inner.right + reach <= outer.left + list.clientWidth + 0.5
}, part)
/** A saved connection's row by its name: the Environment list has a Development option too. */
const savedNamed = (dialog, name) => dialog.locator(part.connectionChoice + ' strong', { hasText: new RegExp('^' + name + '$') })
async function size(width, height) {
  await app.evaluate(({ BrowserWindow }, dimensions) => {
    const target = BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && win.getTitle() === 'Connect') ?? BrowserWindow.getAllWindows()[0]
    target.setContentSize(...dimensions)
  }, [width, height])
}
async function zoom(factor) {
  await app.evaluate(({ BrowserWindow }, value) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.setZoomFactor(value)
  }, factor)
}
const connectContentSize = () => app.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && win.getTitle() === 'Connect') ?? BrowserWindow.getAllWindows()[0]).getContentSize())
try {
  await launch()
  let dialog = await open()
  // Focus stays in the dialog, where Escape reaches it: after a press on its text, and after Save, a star, Add favorite
  // and Remove, which disable or remove the button pressed.
  await dialog.getByRole('heading', { name: 'Connect', exact: true }).click()
  await expect(dialog).toBeFocused()
  await pressToClose(connectWin, 'Escape')
  await dialogClosed(connectWin, 'Connect')
  dialog = await open()
  await dialog.getByLabel('Server Name', { exact: true }).fill('focus-server')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  // A new connection the user filled in is not closed without asking either; Cancel there keeps editing.
  await connectWin.keyboard.press('Escape')
  let unsaved = connectWin.getByRole('dialog', { name: 'Save focus-server to History?', exact: true })
  await expect(unsaved).toBeVisible()
  await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(unsaved).toHaveCount(0)
  await expect(dialog.getByLabel('Server Name', { exact: true })).toHaveValue('focus-server')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused()
  // Save keeps a connection that never connected, in History's Saved group, and says what it saved.
  await expect(dialog.getByText('Saved to History.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Saved (1)', { exact: true })).toBeVisible()
  await expect(savedConnections(dialog, 'focus-server')).toHaveCount(1)
  await expect.poll(async () => JSON.parse(await readFile(join(profile, 'mssql-connections.json'), 'utf8')).profiles.find(item => item.options.server === 'focus-server')?.saved).toBe(true)
  await dialog.getByRole('button', { name: 'Add favorite', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Remove favorite', exact: true })).toBeFocused()
  // A favorite is listed under Favorites only.
  await expect(dialog.getByText('Saved (1)', { exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Remove saved focus-server', exact: true }).click()
  await expect(savedConnections(dialog, 'focus-server')).toHaveCount(0)
  await expect(dialog).toBeFocused()
  // Save in the prompt saves the new connection to History, then closes.
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
  await dialog.getByLabel('Server Name', { exact: true }).fill('prompt-server')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await connectWin.keyboard.press('Escape')
  unsaved = connectWin.getByRole('dialog', { name: 'Save prompt-server to History?', exact: true })
  await clickToClose(unsaved.getByRole('button', { name: 'Save', exact: true }))
  await dialogClosed(connectWin, 'Connect')
  await expect.poll(async () => JSON.parse(await readFile(join(profile, 'mssql-connections.json'), 'utf8')).profiles.some(item => item.options.server === 'prompt-server')).toBe(true)
  dialog = await open()
  // It waits in History's Saved group; removing it leaves History as the rest of the suite expects.
  await expect(dialog.getByText('Saved (1)', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Remove saved prompt-server', exact: true }).click()
  await expect(savedConnections(dialog, 'prompt-server')).toHaveCount(0)
  // Once saved, a typed password alone does not ask about the saved entry: closing loses nothing it keeps.
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
  await dialog.getByLabel('Server Name', { exact: true }).fill('password-server')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  await dialog.getByLabel('Login', { exact: true }).fill('reader')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog.getByText('Saved to History.', { exact: true })).toBeVisible()
  await dialog.getByLabel('Password', { exact: true }).fill('typed-only')
  await pressToClose(connectWin, 'Escape')
  await dialogClosed(connectWin, 'Connect')
  dialog = await open()
  // Settings a saved entry already has are not new: closing does not ask.
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
  await dialog.getByLabel('Server Name', { exact: true }).fill('password-server')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  await dialog.getByLabel('Login', { exact: true }).fill('reader')
  await pressToClose(connectWin, 'Escape')
  await dialogClosed(connectWin, 'Connect')
  dialog = await open()
  // A Name typed for that entry is an edit of it: closing asks about the entry.
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
  await dialog.getByLabel('Server Name', { exact: true }).fill('password-server')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  await dialog.getByLabel('Login', { exact: true }).fill('reader')
  await dialog.getByLabel('Name', { exact: true }).fill('Typed after')
  await connectWin.keyboard.press('Escape')
  unsaved = connectWin.getByRole('dialog', { name: 'Save changes to password-server?', exact: true })
  await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(unsaved).toHaveCount(0)
  // Removing that entry is a choice about it: closing then does not offer to save it back.
  await dialog.getByRole('button', { name: 'Remove saved password-server', exact: true }).click()
  await expect(savedConnections(dialog, 'password-server')).toHaveCount(0)
  await pressToClose(connectWin, 'Escape')
  await dialogClosed(connectWin, 'Connect')
  dialog = await open()
  // A Save in the prompt that fails (here a blank Custom environment label) keeps the dialog open with the reason.
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
  await dialog.getByLabel('Server Name', { exact: true }).fill('label-server')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await dialog.getByLabel('Environment', { exact: true }).selectOption('custom')
  await connectWin.keyboard.press('Escape')
  unsaved = connectWin.getByRole('dialog', { name: 'Save label-server to History?', exact: true })
  await unsaved.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Enter an environment label.')
  await expect(dialog).toBeVisible()
  await connectWin.keyboard.press('Escape')
  await clickToClose(unsaved.getByRole('button', { name: "Don't Save", exact: true }))
  await dialogClosed(connectWin, 'Connect')
  expect(JSON.parse(await readFile(join(profile, 'mssql-connections.json'), 'utf8')).profiles.some(item => item.options.server === 'label-server')).toBe(false)
  dialog = await open()
  await expect(dialog.getByText('recent-server', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Favorite recent-server', exact: true }).click()
  // Favoriting moves it from Recent Connections to Favorites, leaving a single row.
  await expect(dialog.getByRole('button', { name: 'Unfavorite recent-server', exact: true })).toHaveCount(1)
  await expect(dialog.getByRole('button', { name: 'Unfavorite recent-server', exact: true })).toBeFocused()
  await expect(dialog.locator('details').first().getByText('recent-server', { exact: true })).toBeVisible()
  await dialog.getByLabel('Filter connections').fill('not-a-match')
  await expect(dialog.getByText('recent-server', { exact: true })).toHaveCount(0)
  await dialog.getByLabel('Filter connections').fill('')
  // Connect v2: saved connections on the left, the form on the right, one bounded size.
  expect(await layout(dialog)).toEqual({ size: true, sideBySide: true, connectInside: true, failureAtConnect: null })
  expect(await footerFit(dialog)).toEqual(fittingFooter)
  // Up and Down move from the filter box through the rows and back.
  await dialog.getByLabel('Filter connections').focus()
  // With a modifier the key stays the text's: Shift+Down selects, Ctrl+Down and Cmd+Down move the caret.
  await connectWin.keyboard.press('Shift+ArrowDown')
  await expect(dialog.getByLabel('Filter connections')).toBeFocused()
  await connectWin.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+ArrowDown')
  await expect(dialog.getByLabel('Filter connections')).toBeFocused()
  await connectWin.keyboard.press('ArrowDown')
  await expect(savedConnections(dialog).first()).toBeFocused()
  // The scrolling list would clip a ring drawn outside the row.
  expect(await ringInside(dialog)).toBe(true)
  await connectWin.keyboard.press('ArrowUp')
  await expect(dialog.getByLabel('Filter connections')).toBeFocused()
  // Labels & Custom Properties is always expanded inline with Name, Color swatches, Environment, and Reconnect on startup.
  await expect(dialog.getByRole('group', { name: 'Labels & Custom Properties', exact: true })).toBeVisible()
  await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible()
  // Integrated authentication needs a Kerberos ticket off Windows, so the dialog opens, and Reset returns, to SQL Server
  // authentication there. The options read as SSMS's on every platform.
  const defaultAuthentication = process.platform === 'win32' ? 'windows' : 'sql'
  const authentication = dialog.getByLabel('Authentication', { exact: true })
  const userName = dialog.getByLabel('User name', { exact: true })
  await expect(authentication).toHaveValue(defaultAuthentication)
  // SSMS 22's eight types, in its order.
  await expect(authentication.locator('option')).toHaveText(['Windows Authentication', 'SQL Server Authentication', 'Microsoft Entra MFA', 'Microsoft Entra Password',
    'Microsoft Entra Integrated', 'Microsoft Entra Service Principal', 'Microsoft Entra Managed Identity', 'Microsoft Entra Default'])
  // User name shows, greyed, the identity Windows Authentication uses, as SSMS does: DOMAIN\user on Windows; elsewhere the
  // Kerberos principal, or the OS user name without a ticket (this suite's KRB5CCNAME names no cache).
  const windowsIdentity = process.platform === 'win32' ? [process.env.USERDOMAIN, userInfo().username].filter(Boolean).join('\\') : userInfo().username
  await authentication.selectOption('windows')
  await expect(userName).toHaveValue(windowsIdentity)
  await expect(userName).toBeDisabled()
  // Only the types with a password show Password and Remember password.
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveCount(0)
  await expect(dialog.getByLabel('Remember password', { exact: true })).toHaveCount(0)
  await authentication.selectOption('sql')
  await expect(dialog.getByLabel('Password', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('Remember password', { exact: true })).toBeVisible()
  await authentication.selectOption(defaultAuthentication === 'windows' ? 'sql' : 'windows')
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(authentication).toHaveValue(defaultAuthentication)
  await dialog.getByLabel('Server Name', { exact: true }).fill('sql-dev')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  // SQL Server Authentication's field is Login, as in SSMS 22.
  await dialog.getByLabel('Login', { exact: true }).fill('reader')
  await dialog.getByLabel('Password', { exact: true }).fill('never-store-this-marker')
  await dialog.getByLabel('Name', { exact: true }).fill('Development')
  const redSwatch = dialog.getByRole('button', { name: 'Red connection color', exact: true })
  await redSwatch.click()
  await expect(redSwatch).toHaveAttribute('aria-pressed', 'true')
  const expectedRedHex = await redSwatch.evaluate(el => {
    const match = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/i.exec(getComputedStyle(el).backgroundColor)
    if (!match) return ''
    return '#' + match.slice(1).map(channel => Number(channel).toString(16).padStart(2, '0')).join('')
  })
  expect(expectedRedHex).toMatch(/^#[0-9a-f]{6}$/)
  // The custom picker shows the active theme's resolved preset colour, matching the swatch rather than the stored identifier.
  await expect(dialog.getByLabel('Custom connection color', { exact: true })).toHaveValue(expectedRedHex)
  await dialog.getByRole('button', { name: 'Add favorite', exact: false }).click()
  await expect(dialog.getByRole('button', { name: 'Remove favorite', exact: false })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Register server', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Unregister server', exact: true })).toBeEnabled()
  let stored = await readFile(join(profile, 'mssql-connections.json'), 'utf8')
  expect(stored).not.toContain('never-store-this-marker')
  expect(stored).not.toContain('password')
  await dialog.getByRole('tab', { name: /^Advanced/ }).click()
  // A profile without a command timeout leaves it empty, showing Tools › Options' Execution time-out (0 by default).
  await expect(dialog.getByLabel('Command timeout (seconds)', { exact: true })).toHaveValue('')
  await expect(dialog.getByLabel('Command timeout (seconds)', { exact: true })).toHaveAttribute('placeholder', '0 (Tools › Options)')
  await dialog.getByLabel('Command timeout (seconds)', { exact: true }).fill('7')
  await dialog.getByLabel('Connect timeout (seconds)', { exact: true }).fill('20')
  await dialog.getByLabel('Enable secure enclaves', { exact: true }).isDisabled().then(value => expect(value).toBe(true))
  await dialog.getByLabel('Enable Always Encrypted', { exact: true }).selectOption('true')
  await dialog.getByLabel('Enable secure enclaves', { exact: true }).selectOption('true')
  await dialog.getByLabel('Attestation protocol', { exact: true }).selectOption('HGS')
  await dialog.getByLabel('Enclave attestation URL', { exact: true }).fill('https://attestation.example')
  await dialog.getByLabel('Enable Always Encrypted', { exact: true }).selectOption('false')
  await expect(dialog.getByLabel('Enable secure enclaves', { exact: true })).toHaveValue('false')
  await dialog.getByLabel('Multiple active result sets', { exact: true }).selectOption('true')
  await dialog.getByLabel('Network library', { exact: true }).selectOption('tcp')
  await dialog.getByLabel('Application intent', { exact: true }).selectOption('ReadOnly')
  await dialog.getByLabel('Packet size', { exact: true }).fill('8192')
  await dialog.screenshot({ path: resolve('artifacts', 'advanced-connection-properties.png') })
  // Advanced stays inline behind its tab, whose badge says how many properties are set.
  // Always Encrypted and secure enclaves went back to False: stored as edited, they set nothing, so 8 of the 10 count.
  const advancedTab = dialog.getByRole('tab', { name: 'Advanced (8 set)', exact: true })
  await expect(advancedTab).toBeVisible()
  await expect(advancedTab.locator(part.connectTabBadge)).toHaveText('8')
  await expectControlHeight(dialog.getByLabel('Command timeout (seconds)', { exact: true }))
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  // Reading while the app saves is deliberate (Windows refuses to replace an open file); a failed save shows its dialog error here.
  // Save stores only the fields changed or touched (Always Encrypted and secure enclaves went back to False), so the
  // defaults, and Tools › Options for the command timeout, keep applying to the rest.
  await expect.poll(async () => ({ advanced: JSON.parse(await readFile(join(profile, 'mssql-connections.json'), 'utf8')).profiles.find(item => item.options.displayName === 'Development')?.options.advanced, errors: await dialog.getByRole('alert').allTextContents() })).toEqual({
    advanced: {
      commandTimeout: 7, connectTimeout: 20, columnEncryption: false, secureEnclaves: false, attestationProtocol: 'HGS', enclaveAttestationUrl: 'https://attestation.example',
      multipleActiveResultSets: true, networkProtocol: 'tcp', applicationIntent: 'ReadOnly', packetSize: 8192
    },
    errors: []
  })
  await dialog.getByRole('tab', { name: 'Connection String', exact: true }).click()
  await expect(dialog.getByLabel('Connection string preview')).toContainText('tcp:sql-dev')
  await expect(dialog.getByLabel('Connection string preview')).toContainText('Application Intent=ReadOnly')
  await expect(dialog.getByLabel('Connection string preview')).not.toContainText('never-store-this-marker')
  await dialog.getByRole('tab', { name: 'Connection Properties', exact: true }).click()
  await dialog.getByRole('tab', { name: 'Browse', exact: true }).click()
  await expect(dialog.getByText('Discovering local servers…')).toHaveCount(0, { timeout: 10000 })
  // Refresh stays beside the source select, where it reads as a button, not wrapped under it as a lone word.
  const middle = async locator => { const box = await locator.boundingBox(); return box.y + box.height / 2 }
  expect(Math.abs(await middle(dialog.getByRole('button', { name: 'Refresh', exact: true })) - await middle(dialog.getByLabel('Server source', { exact: true })))).toBeLessThan(2)
  await dialog.getByLabel('Server source', { exact: true }).selectOption('registered')
  await expect(savedNamed(dialog, 'Development')).toBeVisible()
  // The narrow list cuts a long name short, so the row's tooltip starts with the name.
  await expect(dialog.locator(part.connectionChoice, { has: connectWin.locator('strong', { hasText: /^Development$/ }) })).toHaveAttribute('title', /^Development\n/)
  await savedNamed(dialog, 'Development').click()
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue('')
  await expect(dialog.getByRole('button', { name: 'Red connection color', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // A saved profile's name and color describe its server, so typing another server drops them.
  await dialog.getByLabel('Server Name', { exact: true }).fill('another-server')
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('')
  await expect(dialog.getByRole('button', { name: 'Default connection color', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await savedNamed(dialog, 'Development').click()
  await expect(dialog.getByRole('button', { name: 'Red connection color', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('tab', { name: 'History', exact: true }).click()
  const authControl = dialog.getByLabel('Authentication', { exact: true })
  for (const control of [dialog.getByLabel('Filter connections'), authControl, dialog.getByLabel('Database Name', { exact: true }),
    dialog.getByRole('button', { name: 'Load databases', exact: true }), dialog.getByRole('button', { name: 'Test Connection', exact: true })]) {
    await expectControlHeight(control)
  }
  await expectControlHeight(dialog.getByRole('button', { name: 'Reset', exact: true }), true)
  await dialog.getByLabel('Server Name', { exact: true }).focus()
  await connectWin.keyboard.press('Tab')
  await expect(authControl).toBeFocused()
  expect(await authControl.evaluate(element => {
    const style = getComputedStyle(element)
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset) <= 0
  })).toBe(true)
  const controlMetrics = await dialog.locator('select').evaluateAll(controls => controls.filter(control => control.getClientRects().length).map(control => {
    const style = getComputedStyle(control)
    return { height: control.getBoundingClientRect().height, contentHeight: control.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom), lineHeight: parseFloat(style.lineHeight) }
  }))
  expect(controlMetrics.filter(control => control.contentHeight < control.lineHeight)).toEqual([])
  await dialog.screenshot({ path: resolve('artifacts', 'connect-dialog.png') })
  const defaultSize = await connectContentSize()
  await size(680, 540)
  await expect.poll(async () => { const box = await dialog.boundingBox(); return box.y + box.height <= 540.5 }).toBe(true)
  await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport()
  await dialog.getByRole('tab', { name: 'Advanced (8 set)', exact: true }).click()
  await expect(dialog.getByLabel('Command timeout (seconds)', { exact: true })).toBeInViewport()
  await dialog.getByRole('tab', { name: 'Connection Properties', exact: true }).click()
  await size(...defaultSize)
  await expect.poll(async () => { const box = await dialog.boundingBox(); return Math.abs(box.width - defaultSize[0]) <= 2 }).toBe(true)
  await clickToClose(dialog.getByRole('button', { name: 'Cancel', exact: true }))
  await dialogClosed(connectWin, 'Connect')
  await app.close(); app = undefined
  await launch()
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  dialog = await open()
  await expect(savedNamed(dialog, 'Development')).toBeVisible()
  await savedNamed(dialog, 'Development').click()
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue('')
  await dialog.getByRole('tab', { name: 'Advanced (8 set)', exact: true }).click()
  await expect(dialog.getByLabel('Command timeout (seconds)', { exact: true })).toHaveValue('7')
  await dialog.getByRole('tab', { name: 'Connection Properties', exact: true }).click()
  if (process.env.VARIA_TEST_SQL_SERVER) {
    await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
    // The saved profile chose SQL Server authentication; Reset returns to the platform's default.
    await expect(dialog.getByLabel('Authentication', { exact: true })).toHaveValue(defaultAuthentication)
    await dialog.getByLabel('Server Name', { exact: true }).fill(process.env.VARIA_TEST_SQL_SERVER)
    // A real failed login: SQL Server's number, severity, state and server under the error, never the password.
    await dialog.getByLabel('Trust server certificate', { exact: true }).check()
    await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
    await dialog.getByLabel('Login', { exact: true }).fill('varia_no_such_login_' + crypto.randomUUID().slice(0, 8))
    await dialog.getByLabel('Password', { exact: true }).fill('never-store-this-marker')
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 30000 })
    await connectErrorDetails(dialog).getByText('Error details', { exact: true }).click()
    await expect(connectErrorDetails(dialog).locator('dt')).toHaveText(['Error number', 'Severity', 'State', 'Server'])
    // Login failed is 18456, severity 14. A server that accepts only Windows authentication sometimes closes the pipe before
    // SqlClient reads that error, which SqlClient reports as 233, severity 20; either way the details are SqlClient's own.
    const [number, severity, , answered] = await connectErrorDetails(dialog).locator('dd').allTextContents()
    expect(['18456 14', '233 20']).toContain(number + ' ' + severity)
    expect(answered).toBe(process.env.VARIA_TEST_SQL_SERVER)
    expect((await connectFailure(dialog).allTextContents()).join(' ')).not.toMatch(/never-store-this-marker|Password=/i)
    // Load databases with the same login fails the same way, and shows the same details under its note.
    const liveDatabaseDetails = databaseErrorDetails(dialog)
    await dialog.getByRole('button', { name: 'Load databases', exact: true }).click()
    await expect(dialog.getByText(/Could not load databases/)).toBeVisible({ timeout: 35000 })
    await liveDatabaseDetails.getByText('Error details', { exact: true }).click()
    const [databaseNumber, databaseSeverity, , databaseServer] = await liveDatabaseDetails.locator('dd').allTextContents()
    expect(['18456 14', '233 20']).toContain(databaseNumber + ' ' + databaseSeverity)
    expect(databaseServer).toBe(process.env.VARIA_TEST_SQL_SERVER)
    expect(await liveDatabaseDetails.textContent()).not.toMatch(/never-store-this-marker|Password=/i)
    if (liveUser) {
      await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
      await dialog.getByLabel('Login', { exact: true }).fill(liveUser)
      await dialog.getByLabel('Password', { exact: true }).fill(process.env.VARIA_TEST_SQL_PASSWORD)
    } else await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
    await dialog.getByLabel('Trust server certificate', { exact: true }).check()
    await dialog.getByLabel('Database Name', { exact: true }).focus()
    await expect(dialog.getByText(/databases available/)).toBeVisible({ timeout: 35000 })
    // Test Connection signs in with the form as it is, against the real server, and opens nothing.
    await dialog.getByRole('button', { name: 'Test Connection', exact: true }).click()
    await expect(dialog.getByText('Connected to ' + process.env.VARIA_TEST_SQL_SERVER + (liveUser ? ' as ' + liveUser : ''), { exact: false })).toBeVisible({ timeout: 35000 })
    const liveRemember = dialog.getByLabel('Remember password', { exact: true })
    if (liveUser && await liveRemember.isEnabled()) {
      // Save checks a typed password with the server, then remembers it only as ciphertext; the field shows it is saved.
      await liveRemember.check()
      await expect(dialog.getByText(/^Save checks this password with the server/)).toBeVisible()
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog.getByText(/password is remembered/)).toBeVisible({ timeout: 35000 })
      await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue('')
      const savedLive = JSON.parse(await readFile(join(profile, 'mssql-connections.json'), 'utf8')).profiles.find(item => item.options.server === process.env.VARIA_TEST_SQL_SERVER && item.options.username === liveUser)
      expect(savedLive?.saved).toBe(true)
      expect(await readFile(join(profile, 'mssql-saved-passwords.json'), 'utf8')).not.toContain(process.env.VARIA_TEST_SQL_PASSWORD)
      // The rest of the suite connects with a typed password and nothing remembered: unchecking forgets it on Connect.
      await dialog.getByLabel('Password', { exact: true }).fill(process.env.VARIA_TEST_SQL_PASSWORD)
      await liveRemember.uncheck()
    } else if (liveUser) {
      // No keyring (as on CI's Linux): Save keeps the settings and says the password was not kept.
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog.getByText('Saved to History. The password was not kept.', { exact: true })).toBeVisible()
      await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue(process.env.VARIA_TEST_SQL_PASSWORD)
    }
    // Development servers have self-signed certificates: without Trust server certificate the connect fails with the fix,
    // and the fix connects. A server whose certificate this computer trusts connects at once.
    await dialog.getByLabel('Trust server certificate', { exact: true }).uncheck()
    await clickToClose(dialog.getByRole('button', { name: 'Connect', exact: true }))
    const liveTrust = dialog.getByRole('button', { name: 'Trust server certificate and connect', exact: true })
    await expect.poll(async () => connectWin.isClosed() || await liveTrust.isVisible().catch(() => false), { timeout: 30000 }).toBe(true)
    if (!connectWin.isClosed()) await clickToClose(liveTrust)
    await dialogClosed(connectWin, 'Connect', { timeout: 30000 })
    const liveLibrary = JSON.parse(await readFile(join(profile, 'mssql-connections.json'), 'utf8'))
    expect(liveLibrary.profiles.some(item => item.options.server === process.env.VARIA_TEST_SQL_SERVER && item.lastConnected)).toBe(true)
    dialog = await open()
    await expect(dialog.getByText(process.env.VARIA_TEST_SQL_SERVER, { exact: true })).toBeVisible()
    await savedNamed(dialog, 'Development').click()
  }
  // Keep native profile persistence but supply deterministic discovery/failure fixtures.
  await app.evaluate(({ ipcMain }, statics) => {
    globalThis.connectionCalls = []
    globalThis.dbPending = []
    // A Microsoft Entra MFA connect to 'entra-wait' waits for the browser until the dialog's Stop names its request id.
    globalThis.entraPending = new Map()
    globalThis.entraStops = []
    // This phase deliberately stubs the request owner. The lifecycle phase below uses the real receipt handlers.
    ipcMain.removeHandler('varia:connections-accept')
    ipcMain.handle('varia:connections-accept', () => ({ ok: true, value: { accepted: true, retained: true } }))
    ipcMain.removeHandler('varia:connections-cancel')
    ipcMain.handle('varia:connections-cancel', (_event, value) => {
      globalThis.entraStops.push(...value.requestIds)
      let cancelled = 0
      for (const id of value.requestIds) {
        const resolve = globalThis.entraPending.get(id)
        if (!resolve) continue
        globalThis.entraPending.delete(id)
        cancelled++
        resolve({ ok: false, code: 'CANCELLED', error: 'The operation was cancelled.' })
      }
      return { ok: true, value: { cancelled } }
    })
    ipcMain.removeHandler('varia:request')
    ipcMain.handle('varia:request', async (_event, method, params, context) => {
      globalThis.connectionCalls.push({ method, params: { ...params, password: params.password ? '<redacted>' : undefined }, context })
      if ((method === 'connections.connect' || method === 'connections.databases') && params.server === 'entra-wait') return new Promise(resolve => { globalThis.entraPending.set(context?.requestId, resolve) })
      if (method === 'connections.discover') return { ok: true, value: { servers: [{ server: params.scope + '-server', version: '17.0', source: params.scope }], warning: 'Discovery can be incomplete.' } }
      if (method === 'connections.databases') {
        if (params.server === 'slow-server') return new Promise(resolve => { globalThis.dbPending.push(resolve) })
        if (params.server === 'db-error') return { ok: false, error: 'Login failed.', code: 'SQL_ERROR', details: { number: 18456, state: 1, class: 14, server: 'db-error' } }
        if (params.server === 'db-error-plain') return { ok: false, error: 'Discovery failed without details.' }
        if (params.server === 'db-backend-error') return { ok: false, error: 'The backend operation failed. Verify the connection and object permissions.', code: 'BACKEND_ERROR', details: { exception: 'System.DllNotFoundException (0x80131524)' } }
        return { ok: true, value: [{ name: 'master', isSystem: true, isSnapshot: false }, { name: 'AppData', isSystem: false, isSnapshot: false }] }
      }
      if (method === 'connections.connect') {
        if (params.server === 'server-down') return { ok: false, error: 'Server unavailable.', code: 'SQL_ERROR', details: { number: 53, state: 0, class: 20, server: 'server-down' } }
        if (params.server === 'server-down-plain') return { ok: false, error: 'Server unavailable without details.' }
        // A self-signed certificate: refused until Trust server certificate is on, and always under Strict encryption.
        if (params.server === 'cert-error' && (!params.trustServerCertificate || params.encrypt === 'strict')) return { ok: false, error: 'The certificate chain was issued by an authority that is not trusted.', code: 'SQL_ERROR', details: { number: -2146893019, state: 0, class: 20, server: 'cert-error', reason: 'certificate' } }
        if (params.server === 'cert-error') return { ok: false, error: 'Login failed after trusting the certificate.', code: 'SQL_ERROR', details: { number: 18456, state: 1, class: 14, server: 'cert-error' } }
        if (params.server === 'backend-error') return { ok: false, error: 'The backend operation failed. Verify the connection and object permissions.', code: 'BACKEND_ERROR', details: { exception: 'System.InvalidOperationException (0x80131509) > System.DllNotFoundException (0x80131524)' } }
        const principalId = 'sid:' + Buffer.from(params.username || 'fixture-account').toString('hex')
        return { ok: true, value: { id: crypto.randomUUID(), server: params.server, database: params.database || 'master', serverVersion: '17.0.fixture', color: params.color, displayName: params.displayName, commandTimeout: params.advanced?.commandTimeout ?? 0,
          generation: 1, targetId: context?.targetId ?? crypto.randomUUID(), principalId,
          authentication: { principal: { provider: 'sqlserver', authentication: params.authentication, id: principalId } } } }
      }
      // alice@CONTOSO.COM, unless the suite holds the answer back (identityPending) to look at the dialog while it waits.
      if (method === 'connections.identity') return globalThis.identityPending ? new Promise(resolve => { globalThis.identityResolve = resolve }) : { ok: true, value: { principal: 'alice@CONTOSO.COM' } }
      if (method === 'databases.list') return { ok: true, value: [{ name: 'master', isSystem: true, isSnapshot: false }, { name: 'AppData', isSystem: false, isSnapshot: false }] }
      // Object Explorer expands each new server: the catalogue's static folders.
      if (method === 'explorer.children') {
        const { node } = params, owner = node.type === 'object' ? node.object : node.owner
        const nodes = (node.type === 'object' ? statics.objects[node.object.kind] : statics.folders[node.folder]).map(folder => ({ ref: { type: 'folder', owner, folder }, label: statics.labels[folder], icon: 'folder', hasChildren: true }))
        return { ok: true, value: { nodes, total: nodes.length, elapsedMs: 1 } }
      }
      if (method === 'query.execute') return { ok: true, value: { resultSets: [], discardedResultSets: 0, messages: [], recordsAffected: -1, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1, database: params.database, messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, generation: 1, seq: 1 }, completedAt: '2026-10-09T12:00:00.0000000+00:00' } }
      // Quitting reads each idle query's transaction; this fixture's sessions hold none.
      if (method === 'query.session.state') return { ok: true, value: { transactionCount: 0, checked: true } }
      if (method === 'query.session.close') return { ok: true, value: { closed: true } }
      return { ok: false, error: 'Unsupported fixture method.' }
    })
  }, explorerStatics())
  // Off Windows the dialog asks for the ticket's principal when it opens, as SSMS reads the identity on open, so the saved
  // Windows Authentication rows show it whichever authentication the form starts on (SQL Server Authentication there), and
  // asks again each time Windows Authentication is chosen. Windows shows DOMAIN\user and never asks.
  const integratedRows = async () => [...new Set(await savedConnections(dialog, 'recent-server').locator('small').allTextContents())]
  const identityCalls = () => app.evaluate(() => globalThis.connectionCalls.filter(call => call.method === 'connections.identity').length)
  await clickToClose(dialog.getByRole('button', { name: 'Cancel', exact: true }))
  await dialogClosed(connectWin, 'Connect')
  dialog = await open()
  if (process.platform === 'win32') await expect.poll(integratedRows).toEqual(['master · ' + windowsIdentity])
  else {
    await expect.poll(integratedRows).toEqual(['master · alice@CONTOSO.COM'])
    expect(await identityCalls()).toBe(1)
  }
  await savedNamed(dialog, 'Development').click()
  await expect(dialog.getByLabel('Login', { exact: true })).toHaveValue('reader')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  if (process.platform === 'win32') {
    await expect(dialog.getByLabel('User name', { exact: true })).toHaveValue(windowsIdentity)
    expect(await identityCalls()).toBe(0)
  } else {
    await expect(dialog.getByLabel('User name', { exact: true })).toHaveValue('alice@CONTOSO.COM')
    // After a kdestroy, choosing Windows Authentication again never shows the old principal, not even while the new lookup
    // waits (a stuck cache holds it until the deadline): User name and the rows show the OS user name.
    await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
    await app.evaluate(() => { globalThis.identityPending = true; globalThis.identityResolve = undefined })
    await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
    await expect.poll(() => app.evaluate(() => typeof globalThis.identityResolve)).toBe('function')
    await expect(dialog.getByLabel('User name', { exact: true })).toHaveValue(windowsIdentity)
    expect(await integratedRows()).toEqual(['master · ' + windowsIdentity])
    expect(await identityCalls()).toBe(3)
    await app.evaluate(() => { globalThis.identityPending = false; globalThis.identityResolve({ ok: true, value: {} }) })
    await expect(dialog.getByLabel('User name', { exact: true })).toHaveValue(windowsIdentity)
    expect(await integratedRows()).toEqual(['master · ' + windowsIdentity])
  }
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  await expect(dialog.getByLabel('Login', { exact: true })).toHaveValue('reader')
  await entraChecks(dialog, windowsIdentity)
  await savedNamed(dialog, 'Development').click()
  await expect(dialog.getByLabel('Login', { exact: true })).toHaveValue('reader')
  await dialog.getByRole('tab', { name: 'Browse', exact: true }).click()
  await dialog.getByLabel('Server source', { exact: true }).selectOption('network')
  await expect(dialog.getByRole('button', { name: /network-server/ })).toBeVisible()
  await dialog.getByRole('button', { name: /network-server/ }).click()
  await expect(dialog.getByLabel('Server Name', { exact: true })).toHaveValue('network-server')
  await dialog.getByLabel('Database Name', { exact: true }).focus()
  await expect(dialog.getByText('2 databases available.')).toBeVisible()
  expect(await dialog.locator('#available-databases option').evaluateAll(options => options.map(option => option.value))).toContain('AppData')
  await dialog.getByLabel('Server Name', { exact: true }).fill('slow-server')
  // Load databases draws registry icons, refresh and then a spinning loading, not text glyphs.
  const loadDatabases = dialog.getByRole('button', { name: 'Load databases', exact: true })
  await expect(loadDatabases.locator('[data-icon]')).toHaveAttribute('data-icon', 'refresh')
  await loadDatabases.click()
  await expect(dialog.getByText('Loading databases…')).toBeVisible()
  await expect(loadDatabases.locator('[data-icon]')).toHaveAttribute('data-icon', 'loading')
  await expect(loadDatabases.locator('[data-icon]')).toHaveClass(/\bcodicon-modifier-spin\b/)
  expect(await loadDatabases.textContent()).toBe('')
  await dialog.getByLabel('Server Name', { exact: true }).fill('db-error')
  await app.evaluate(() => { globalThis.dbPending.splice(0).forEach(resolve => resolve({ ok: true, value: [{ name: 'StaleDb', isSystem: false, isSnapshot: false }] })) })
  await dialog.getByRole('button', { name: 'Load databases', exact: true }).click()
  await expect(dialog.getByText(/Could not load databases: Login failed/)).toBeVisible()
  // A failed Load databases shows the same Error details expander as a failed Connect, under the database note.
  const databaseDetails = databaseErrorDetails(dialog)
  await expect(databaseDetails).toHaveCount(1)
  await expect(databaseDetails).not.toHaveAttribute('open', '')
  await databaseDetails.getByText('Error details', { exact: true }).click()
  expect(await databaseDetails.locator('dt').allTextContents()).toEqual(['Error number', 'Severity', 'State', 'Server'])
  expect(await databaseDetails.locator('dd').allTextContents()).toEqual(['18456', '14', '1', 'db-error'])
  // Refocusing the database field must not retry a rejected login (account lockout); only Refresh retries.
  const discoveryAttempts = () => app.evaluate(() => globalThis.connectionCalls.filter(call => call.method === 'connections.databases').length)
  const attempts = await discoveryAttempts()
  await dialog.getByLabel('Server Name', { exact: true }).focus()
  await dialog.getByLabel('Database Name', { exact: true }).focus()
  await page.waitForTimeout(300)
  expect(await discoveryAttempts()).toBe(attempts)
  expect(await dialog.locator('#available-databases option').evaluateAll(options => options.map(option => option.value))).not.toContain('StaleDb')
  // The details go with the note once the form changes, and a failure without details shows none.
  await dialog.getByLabel('Server Name', { exact: true }).fill('db-error-plain')
  await expect(databaseDetails).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Load databases', exact: true }).click()
  await expect(dialog.getByText(/Could not load databases: Discovery failed without details/)).toBeVisible()
  await expect(databaseDetails).toHaveCount(0)
  // A BACKEND_ERROR's details are only its exception types: no Error details expander with nothing in it.
  await dialog.getByLabel('Server Name', { exact: true }).fill('db-backend-error')
  await dialog.getByRole('button', { name: 'Load databases', exact: true }).click()
  await expect(dialog.getByText(/Could not load databases: The backend operation failed/)).toBeVisible()
  await expect(databaseDetails).toHaveCount(0)
  // Test Connection signs in as Load databases does, saves nothing, opens no session, and reports at Connect.
  const connects = () => app.evaluate(() => globalThis.connectionCalls.filter(call => call.method === 'connections.connect').length)
  const connectsBefore = await connects(), databaseBefore = await dialog.getByLabel('Database Name', { exact: true }).inputValue()
  await dialog.getByLabel('Server Name', { exact: true }).fill('test-server')
  await dialog.getByLabel('Database Name', { exact: true }).fill('Sales')
  await dialog.getByRole('button', { name: 'Test Connection', exact: true }).click()
  await expect(dialog.getByText(/^Connected to test-server\b.*2 databases are visible\.$/)).toBeVisible()
  await expect(dialog.getByText('Sales is not among the databases this login can see.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Test Connection', exact: true })).toBeFocused()
  expect(await connects()).toBe(connectsBefore)
  expect(JSON.parse(await readFile(join(profile, 'mssql-connections.json'), 'utf8')).profiles.some(item => item.options.server === 'test-server')).toBe(false)
  // Connect drops the report: it is not about this attempt, which here fails.
  await dialog.getByLabel('Server Name', { exact: true }).fill('server-down')
  await dialog.getByRole('button', { name: 'Test Connection', exact: true }).click()
  await expect(dialog.getByText(/^Connected to server-down\b/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Server unavailable.')
  await expect(dialog.getByText(/^Connected to server-down\b/)).toHaveCount(0)
  // A changed form drops the report; a failed test shows Connect's error with its details.
  await dialog.getByLabel('Server Name', { exact: true }).fill('test-server')
  await dialog.getByRole('button', { name: 'Test Connection', exact: true }).click()
  await expect(dialog.getByText(/^Connected to test-server/)).toBeVisible()
  await dialog.getByLabel('Database Name', { exact: true }).fill('Other')
  await expect(dialog.getByText(/^Connected to test-server/)).toHaveCount(0)
  await dialog.getByLabel('Server Name', { exact: true }).fill('db-error')
  await dialog.getByRole('button', { name: 'Test Connection', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Login failed.')
  await expect(connectErrorDetails(dialog)).toHaveCount(1)
  // A test that waits (here, for a sign-in) locks the form; Test Connection becomes Stop, and Escape stops the test
  // without closing the dialog.
  await dialog.getByLabel('Server Name', { exact: true }).fill('entra-wait')
  const testFooter = await footerPlace(dialog)
  await dialog.getByRole('button', { name: 'Test Connection', exact: true }).click()
  await expect(dialog.getByText('Testing the connection to entra-wait…', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Stop', exact: true })).toBeFocused()
  expect(await footerPlace(dialog)).toEqual(testFooter)
  await expect(dialog.getByLabel('Server Name', { exact: true })).toBeDisabled()
  await connectWin.keyboard.press('Escape')
  await expect(dialog.getByText('Test cancelled.', { exact: true })).toBeVisible()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Test Connection', exact: true })).toBeFocused()
  // Cancel stops a running test too, as Stop does while connecting; it neither closes the dialog nor asks to save.
  await dialog.getByRole('button', { name: 'Test Connection', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Stop', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Test Connection', exact: true })).toBeEnabled()
  await expect(dialog).toBeVisible()
  await expect(connectWin.getByRole('dialog', { name: /^Save / })).toHaveCount(0)
  // Stopping Save's password check saves nothing and says so. Only where a keyring lets Save remember passwords.
  const authBefore = await dialog.getByLabel('Authentication', { exact: true }).inputValue()
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  await dialog.getByLabel('Login', { exact: true }).fill('reader')
  await dialog.getByLabel('Password', { exact: true }).fill('typed-for-save')
  const rememberBox = dialog.getByLabel('Remember password', { exact: true })
  if (await rememberBox.isEnabled()) {
    await rememberBox.check()
    await expect(dialog.getByText('Save checks this password with the server, then remembers it.', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog.getByText('Checking the password with entra-wait…', { exact: true })).toBeVisible()
    // Save is disabled while it checks; focus is already on Cancel, so the Escape below reaches the dialog.
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await connectWin.keyboard.press('Escape')
    await expect(dialog.getByText('Save cancelled. Nothing was saved.', { exact: true })).toBeVisible()
    expect(JSON.parse(await readFile(join(profile, 'mssql-connections.json'), 'utf8')).profiles.some(item => item.options.server === 'entra-wait')).toBe(false)
    await rememberBox.uncheck()
  }
  await dialog.getByLabel('Authentication', { exact: true }).selectOption(authBefore)
  await dialog.getByLabel('Database Name', { exact: true }).fill(databaseBefore)
  await dialog.getByLabel('Server Name', { exact: true }).fill('server-down')
  // A failure shows above the footer: Connect and Cancel stay where they were before it.
  await expect(connectOutcome(dialog)).toHaveCount(0)
  const footerBefore = await footerPlace(dialog)
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Server unavailable')
  expect(await footerPlace(dialog)).toEqual(footerBefore)
  // The details expander starts closed, opens to SQL Server's facts, and goes with the error once the options change.
  const details = connectErrorDetails(dialog)
  await expect(details).toHaveCount(1)
  await expect(details).not.toHaveAttribute('open', '')
  await details.getByText('Error details', { exact: true }).click()
  await expect(details).toHaveAttribute('open', '')
  expect(await details.locator('dt').allTextContents()).toEqual(['Error number', 'Severity', 'State', 'Server'])
  expect(await details.locator('dd').allTextContents()).toEqual(['53', '20', '0', 'server-down'])
  await details.screenshot({ path: resolve('artifacts', 'connect-error-details.png') })
  await dialog.getByLabel('Server Name', { exact: true }).fill('server-down-plain')
  await expect(details).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Server unavailable without details')
  await expect(details).toHaveCount(0)
  // An untrusted certificate offers to trust it and connect again, as checking Trust server certificate would.
  await dialog.getByLabel('Server Name', { exact: true }).fill('cert-error')
  await dialog.getByLabel('Trust server certificate', { exact: true }).uncheck()
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('not trusted')
  expect(await footerPlace(dialog)).toEqual(footerBefore)
  const trust = dialog.getByRole('button', { name: 'Trust server certificate and connect', exact: true })
  await expect(connectFailure(dialog)).toBeInViewport()
  expect(await layout(dialog)).toEqual({ size: true, sideBySide: true, connectInside: true, failureAtConnect: true })
  await dialog.screenshot({ path: resolve('artifacts', 'connect-dialog-failure.png') })
  // Zoomed in on the smallest window, the panes stack in one scroll that still shows two list rows and the form beside
  // the failure, with Connect and the failure inside the dialog.
  const contentSize = await connectContentSize()
  await dialog.getByRole('tab', { name: 'History', exact: true }).click()
  await expect(savedConnections(dialog).first()).toBeVisible()
  for (const [width, height, zoomFactor] of [[1024, 700, 1.5], [1280, 800, 2]]) {
    await size(width, height)
    await zoom(zoomFactor)
    await expect.poll(() => stackedRoom(dialog), `zoom ${zoomFactor} at ${width}x${height}`).toEqual({ stacked: true, rows: true, room: true, inside: true })
    expect(await footerFit(dialog)).toEqual(fittingFooter)
    await expect(connectFailure(dialog)).toBeInViewport()
    await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeInViewport()
    if (zoomFactor === 2) {
      // Stacked too, Connect and Cancel stay put whether or not the outcome shows: an edit clears the failure, and
      // Connect brings it back.
      const stackedFooter = await footerPlace(dialog)
      const trustBox = dialog.getByLabel('Trust server certificate', { exact: true })
      await trustBox.check()
      await trustBox.uncheck()
      await expect(connectFailure(dialog)).toHaveCount(0)
      expect(await footerPlace(dialog)).toEqual(stackedFooter)
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect(dialog.getByRole('alert')).toContainText('not trusted')
      expect(await footerPlace(dialog)).toEqual(stackedFooter)
      await expect.poll(() => stackedRoom(dialog)).toEqual({ stacked: true, rows: true, room: true, inside: true })
    }
    if (zoomFactor === 1.5) await connectWin.screenshot({ path: resolve('artifacts', 'connect-dialog-zoomed.png') })
  }
  await zoom(1)
  await size(...contentSize)
  await expect.poll(async () => (await layout(dialog)).sideBySide).toBe(true)
  await connectFailure(dialog).screenshot({ path: resolve('artifacts', 'connect-certificate-fix.png') })
  await trust.click()
  await expect(dialog.getByRole('alert')).toContainText('Login failed after trusting the certificate.')
  await expect(dialog.getByLabel('Trust server certificate', { exact: true })).toBeChecked()
  await expect(trust).toHaveCount(0)
  expect(await app.evaluate(() => globalThis.connectionCalls.filter(call => call.method === 'connections.connect' && call.params.server === 'cert-error').map(call => call.params.trustServerCertificate))).toEqual([false, false, true])
  // Strict encryption validates the certificate whatever the box says: the dialog explains, with nothing to click.
  await dialog.getByLabel('Encrypt', { exact: true }).selectOption('strict')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  // The explanation is part of the alert, so it is read with the error, and it lines up with the error's sentence.
  const explained = async (text) => {
    await expect(dialog.getByRole('alert')).toContainText(text)
    const [note, sentence] = await Promise.all([connectFailureNote(dialog).boundingBox(), connectFailureSentence(dialog).boundingBox()])
    expect(Math.abs(note.x - sentence.x)).toBeLessThan(1)
  }
  await explained(/Strict encryption always validates/)
  await expect(trust).toHaveCount(0)
  await connectFailure(dialog).screenshot({ path: resolve('artifacts', 'connect-certificate-strict.png') })
  await dialog.getByLabel('Encrypt', { exact: true }).selectOption('mandatory')
  // A pinned Host Name in Certificate is a check the person chose: trusting would skip it, so the dialog only explains.
  await dialog.getByLabel('Trust server certificate', { exact: true }).uncheck()
  await dialog.getByLabel('Host Name in Certificate', { exact: true }).fill('sql01.contoso.com')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await explained(/did not match the Server Certificate or the Host Name in Certificate/)
  await expect(trust).toHaveCount(0)
  await dialog.getByLabel('Host Name in Certificate', { exact: true }).fill('')
  await dialog.getByLabel('Trust server certificate', { exact: true }).check()
  // BACKEND_ERROR's sentence is generic; Copy details carries the exception types the backend named.
  await dialog.getByLabel('Server Name', { exact: true }).fill('backend-error')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('The backend operation failed.')
  await expect(details).toHaveCount(0)
  await connectFailure(dialog).getByRole('button', { name: 'Copy details', exact: true }).click()
  await expect(connectFailureCopyStatus(dialog)).toHaveText('Details copied.')
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Connecting to backend-error\nCode: BACKEND_ERROR\nMessage: The backend operation failed. Verify the connection and object permissions.\nException: System.InvalidOperationException (0x80131509) > System.DllNotFoundException (0x80131524)')
  const history = await page.evaluate(() => window.varia.loadConnectionLibrary())
  expect(history.value.library.profiles.some(item => item.options.server === 'server-down')).toBe(false)
  await dialog.getByLabel('Server Name', { exact: true }).fill('connected-server')
  await dialog.getByLabel('Database Name', { exact: true }).fill('AppData')
  await dialog.getByLabel('Name', { exact: true }).fill('Development')
  // Leaving a saved profile for another server drops that profile's name and color, so choose them for this server.
  await expect(dialog.getByRole('button', { name: 'Default connection color', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: 'Red connection color', exact: true }).click()
  await submitConnect(connectWin, dialog)
  await expect(queryStatus(page)).toContainText('Development')
  // The active query's connection colour is the status bar's top edge.
  expect(await statusBar(page).evaluate(element => getComputedStyle(element).borderTopColor)).toBe('rgb(230, 103, 103)')
  // Object Explorer shows the server by its name and color, expanded to its folders.
  const serverRow = await explorerRow(page, 'Development')
  await expect(serverRow).toHaveAttribute('aria-expanded', 'true')
  expect(await serverRow.locator(part.explorerAccent).evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(230, 103, 103)')
  await expect(await explorerRow(page, 'Development', 'Server Objects')).toBeVisible()
  await page.locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT 1;')
  await page.getByRole('button', { name: /Execute/ }).click()
  await expect.poll(() => app.evaluate(() => globalThis.connectionCalls.find(call => call.method === 'query.execute')?.params.timeoutSeconds)).toBe(7)
  await clearEntraCache()
  expect(failures).toEqual([])
  await app.close(); app = undefined
  await rememberPassword()
  expect(failures).toEqual([])
  await environmentLabels()
  expect(failures).toEqual([])
  await connectionLifecycle()
  await bigQueryEmulator()
  expect(failures).toEqual([])
  console.log('Connection dialog checks passed: history/favorites/registration, password omission, provider preview, advanced apply/cancel, restart persistence, local/network browsing, live database choices, stale discovery suppression, error recovery, connection and database discovery failure details, the integrated identity, colors in the query and Object Explorer, timeout routing, compact sizing, keyboard focus, the eight authentication types with their fields, Stop (button and Escape) while a Microsoft Entra sign-in waits, Help › Clear Entra ID Token Cache, and Remember password (saved only as ciphertext after a connect, filled in by main for the same credentials only, kept across restarts, forgotten when rejected, unchecked or removed, and disabled without a keyring or for Windows Authentication), the two-pane layout (one bounded size, Up and Down through the lists, Password only for the types that have one, Advanced and Custom Properties collapsed with their summaries, the error at Connect without moving it, one scroll when stacked or zoomed), and environment labels (chosen in the dialog and from the server menu, stored independently on profiles and targets, shown on the server, its tabs, the query bar and the status bar, dropped with another server, kept when the server is typed, cut short when long, and bounded in main).')
} finally {
  clearTimeout(watchdog)
  await app?.close().catch(() => app?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
  await rm(passwordProfile, { recursive: true, force: true })
  await rm(bigQueryProfile, { recursive: true, force: true })
  await rm(environmentProfile, { recursive: true, force: true })
}

/** The emulator's objects for Search Objects: a partitioned, clustered and labelled table with a column description, and a view. */
async function bigQueryFixtures(endpoint) {
  const tables = new URL('bigquery/v2/projects/varia-emulator/datasets/varia_fixture/tables', endpoint.endsWith('/') ? endpoint : endpoint + '/').toString()
  const reference = tableId => ({ projectId: 'varia-emulator', datasetId: 'varia_fixture', tableId })
  for (const body of [
    {
      tableReference: reference('search_orders'), description: 'Orders placed online.', labels: { team: 'sales' }, timePartitioning: { type: 'DAY', field: 'placed' }, clustering: { fields: ['customer'] },
      schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }, { name: 'customer', type: 'STRING', description: 'Who placed the order.' }, { name: 'placed', type: 'TIMESTAMP' }] }
    },
    { tableReference: reference('search_orders_daily'), view: { query: 'SELECT DATE(placed) AS day, COUNT(*) AS n FROM varia_fixture.search_orders GROUP BY day', useLegacySql: false } }
  ]) {
    // A run before this one may have left the object in a long-lived emulator.
    await fetch(`${tables}/${body.tableReference.tableId}`, { method: 'DELETE' })
    const created = await fetch(tables, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!created.ok) throw new Error(`The emulator refused ${body.tableReference.tableId}: HTTP ${created.status}`)
  }
}

/**
 * Search Objects on the emulator connection: a table's details pane shows tables.get's facts (partitioning, clustering, labels)
 * and its columns with their descriptions, and offers its billed CREATE statement only on a button; a view shows its text; a
 * result's New Query opens a GoogleSQL tab on the connection, in the result's dataset.
 */
async function bigQuerySearchDetails() {
  await page.keyboard.press('F1')
  await page.keyboard.type('search objects')
  await quickInput(page).getByRole('option', { name: /^Object Explorer: Search Objects…/ }).click()
  await expect(objectSearchBox(page)).toBeFocused()
  await page.keyboard.type('search_orders')
  const hits = objectSearchHits(page)
  await expect(hits.filter({ hasText: 'search_orders_daily' })).toHaveCount(1, { timeout: 30000 })
  const details = page.locator(part.objectSearchTab).getByRole('region', { name: /^Details: / })
  await hits.filter({ hasText: 'search_orders' }).filter({ hasNotText: 'search_orders_daily' }).first().click()
  await expect(details).toHaveAccessibleName('Details: varia_fixture.search_orders')
  const properties = details.getByLabel('Properties', { exact: true })
  await expect(properties).toContainText('DAY on placed', { timeout: 20000 })
  await expect(properties).toContainText('customer')
  await expect(properties).toContainText('team: sales')
  // A table's CREATE statement is a billed query: offered on a button, never read on selection.
  await expect(details.getByRole('button', { name: 'Show CREATE Statement', exact: true })).toBeVisible()
  await details.getByRole('radio', { name: 'Columns', exact: true }).click()
  const columns = localGrid(details, 'Columns')
  await expect(columns).toHaveAttribute('aria-label', /^Columns, 3 rows, 3 columns/)
  await expect(columns).toContainText('Who placed the order.')
  await details.getByRole('radio', { name: 'Definition', exact: true }).click()
  // A view's text comes with its facts.
  await hits.filter({ hasText: 'search_orders_daily' }).click()
  await expect(details).toHaveAccessibleName('Details: varia_fixture.search_orders_daily')
  await expect(details.getByLabel('Definition', { exact: true })).toContainText('COUNT(*) AS n', { timeout: 20000 })
  // New Query on the result: a GoogleSQL tab on the connection, in the result's dataset (the billing project's).
  await hits.filter({ hasText: 'search_orders_daily' }).click({ button: 'right' })
  const hitMenu = page.getByRole('menu', { name: 'Search result', exact: true })
  const tabs = await documentTab(page).count()
  await hitMenu.getByRole('menuitem', { name: 'New Query', exact: true }).click()
  // A new query tab, active: the dataset box below is its own.
  await expect(documentTab(page)).toHaveCount(tabs + 1)
  await expect(activeDocument(page)).toContainText(/SQLQuery\d+/)
  await expect(queryServer(page)).toContainText('varia-emulator')
  await expect(page.getByLabel('Query dataset', { exact: true })).toHaveValue('varia_fixture')
  console.log('BigQuery Search Objects checks passed against the emulator: the details pane\'s facts, columns and view text, the billed CREATE only on a button, and New Query.')
}

/**
 * Microsoft Entra ID in the Connect dialog (the stubbed requests): each type's fields as SSMS 22 shows them, and Stop, by
 * button and by Escape, while a sign-in waits for the web browser. The dialog starts on a SQL Server Authentication entry.
 */
async function entraChecks(dialog, windowsIdentity) {
  const authentication = dialog.getByLabel('Authentication', { exact: true })
  const password = dialog.getByLabel('Password', { exact: true })
  const connect = dialog.getByRole('button', { name: 'Connect', exact: true })
  const user = dialog.getByLabel('User name', { exact: true })
  await authentication.selectOption('entraMfa')
  await expect(password).toHaveCount(0)
  await user.fill('')
  await expect(user).toHaveAttribute('placeholder', 'user@contoso.com (optional)')
  await expect(connect).toBeEnabled()
  await expect(dialog.getByText('Sign in with your web browser when you connect.', { exact: true })).toBeVisible()
  await authentication.selectOption('entraServicePrincipal')
  await expect(user).toHaveAttribute('placeholder', 'Application (client) ID')
  await expect(connect).toBeDisabled()
  await user.fill('11111111-2222-3333-4444-555555555555')
  await expect(connect).toBeEnabled()
  await expect(password).toBeEnabled()
  await authentication.selectOption('entraManagedIdentity')
  await expect(dialog.getByLabel('User assigned identity', { exact: true })).toBeEnabled()
  await expect(password).toHaveCount(0)
  await authentication.selectOption('entraIntegrated')
  await expect(user).toBeDisabled()
  await expect(user).toHaveValue(windowsIdentity)
  await expect(dialog.getByText(/^Microsoft Entra Integrated needs Windows\./)).toHaveCount(process.platform === 'win32' ? 0 : 1)
  // Stop, while a sign-in waits for the web browser: the connect's own request id is cancelled, and the form is editable.
  await authentication.selectOption('entraMfa')
  await user.fill('alice@contoso.com')
  await dialog.getByLabel('Server Name', { exact: true }).fill('entra-wait')
  const stopButton = dialog.getByRole('button', { name: 'Stop', exact: true })
  const connectIds = () => app.evaluate(() => globalThis.connectionCalls.filter(call => call.method === 'connections.connect' && call.params.server === 'entra-wait').map(call => call.context?.requestId))
  await expect(connectOutcome(dialog)).toHaveCount(0)
  const footerBefore = await footerPlace(dialog)
  const stopsBeforeRepeat = await app.evaluate(() => globalThis.entraStops)
  await connect.focus()
  await connectWin.keyboard.down('Enter')
  await expect(stopButton).toBeEnabled()
  await expect(stopButton).toBeFocused()
  // Focus moved from Connect to Stop while Enter is held: its repeated keydown must not click Stop.
  await connectWin.keyboard.down('Enter')
  await connectWin.keyboard.up('Enter')
  await expect(stopButton).toBeFocused()
  expect(await app.evaluate(() => globalThis.entraStops)).toEqual(stopsBeforeRepeat)
  await expect(dialog.getByText('Complete the sign-in in your web browser. Waiting up to 3 minutes…', { exact: true })).toBeVisible()
  // The waiting line shows above the footer, so Stop is where Cancel was, and Connecting… where Connect was.
  expect(await footerPlace(dialog)).toEqual(footerBefore)
  await expect(dialog.getByLabel('Server Name', { exact: true })).toBeDisabled()
  await dialog.screenshot({ path: resolve('artifacts', 'connect-dialog-entra.png') })
  await stopButton.click()
  await expect(dialog.getByText('Connection cancelled.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  expect(await footerPlace(dialog)).toEqual(footerBefore)
  await expect(dialog.getByLabel('Server Name', { exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
  let ids = await connectIds()
  expect(ids).toHaveLength(1)
  expect(await app.evaluate(() => globalThis.entraStops)).toEqual(ids)
  // Escape is Stop while connecting, and leaves the dialog open.
  await connect.click()
  await expect(stopButton).toBeFocused()
  await connectWin.keyboard.press('Escape')
  await expect(dialog.getByText('Connection cancelled.', { exact: true })).toBeVisible()
  await expect(dialog).toBeVisible()
  ids = await connectIds()
  expect(ids).toHaveLength(2)
  expect(await app.evaluate(() => globalThis.entraStops)).toEqual(ids)
  await expect(connect).toBeFocused()
}

/** Help › Clear Entra ID Token Cache (the custom menubar on Windows and Linux, the palette on macOS): main asks, the real
 *  backend forgets its tokens, and the workbench says so. */
async function clearEntraCache() {
  await app.evaluate(({ dialog }) => {
    globalThis.entraPrompts = []
    globalThis.previousShowMessageBox ??= dialog.showMessageBox
    dialog.showMessageBox = async (_window, options) => { globalThis.entraPrompts.push(options.title); return { response: 0, checkboxChecked: false } }
  })
  if (process.platform === 'darwin') {
    await page.locator('.monaco-editor [role="textbox"]').focus()
    await page.keyboard.press('F1')
    await page.keyboard.type('Clear Entra ID Token Cache')
    await page.keyboard.press('Enter')
  } else {
    await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Help', exact: true }).click({ force: true })
    await page.getByRole('menu', { name: 'Help', exact: true }).getByRole('menuitem', { name: 'Clear Entra ID Token Cache', exact: true }).click({ force: true })
  }
  await expect(page.getByText('Entra ID token cache cleared.', { exact: true })).toBeVisible()
  expect(await app.evaluate(() => globalThis.entraPrompts)).toEqual(['Clear Entra ID Token Cache'])
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = globalThis.previousShowMessageBox })
}

/**
 * Remember password against the fake backend: only main's injection of the remembered password can satisfy server
 * password-check when Password is empty. Windows uses DPAPI; elsewhere the test cipher stands in for a keyring CI lacks.
 */
async function rememberPassword() {
  const marker = 'correct-horse-marker', encoded = Buffer.from(marker).toString('base64')
  const userData = join(passwordProfile, 'user-data'), control = join(passwordProfile, 'control')
  await mkdir(control, { recursive: true })
  const passwordsFile = join(userData, 'mssql-saved-passwords.json'), connectionsFile = join(userData, 'mssql-connections.json'), callsFile = join(control, 'calls.jsonl')
  const seamless = { ...env, VARIA_TEST_USER_DATA: userData, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
  delete seamless.VARIA_TEST_SAFE_STORAGE
  const options = { ...launchOptions, env: { ...seamless, ...process.platform === 'win32' ? {} : { VARIA_TEST_SAFE_STORAGE: 'test' } } }
  const read = path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const entries = async () => JSON.parse(await read(passwordsFile) || '{"entries":[]}').entries
  const calls = async () => parseCalls(await read(callsFile))
  const historyId = async server => JSON.parse(await read(connectionsFile)).profiles.find(item => item.options.server === server && item.lastConnected)?.id
  async function noSecrets() {
    for (const [name, text] of [['mssql-saved-passwords.json', await read(passwordsFile)], ['mssql-connections.json', await read(connectionsFile)], ['calls.jsonl', await read(callsFile)]]) {
      expect(text.includes(marker) || text.includes(encoded), name).toBe(false)
    }
    // No password member (the server's name, password-check, says password too).
    expect(await read(connectionsFile)).not.toContain('"password"')
  }
  const form = dialog => ({ password: dialog.getByLabel('Password', { exact: true }), remember: dialog.getByLabel('Remember password', { exact: true }) })
  async function fill(dialog, password) {
    await dialog.getByLabel('Server Name', { exact: true }).fill('password-check')
    await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
    await dialog.getByLabel('Login', { exact: true }).fill('reader')
    await form(dialog).password.fill(password)
  }
  const choose = dialog => savedConnections(dialog, 'password-check').first().click()
  async function connected(dialog) {
    await submitConnect(connectWin, dialog)
  }
  async function disconnectPasswordServer() {
    const row = await explorerRow(page, 'password-check')
    await explorerLabel(row).click({ button: 'right' })
    await page.getByRole('menu', { name: 'Object Explorer', exact: true }).getByRole('menuitem', { name: 'Disconnect', exact: true }).click()
    const prompt = page.getByRole('dialog', { name: 'Disconnect password-check?', exact: true })
    await expect.poll(async () => await prompt.isVisible() || /Disconnected/.test(await row.getAttribute('aria-label') ?? '')).toBe(true)
    if (await prompt.isVisible()) await prompt.getByRole('button', { name: 'Disconnect and Keep Tabs', exact: true }).click()
    await expect(row).toHaveAccessibleName(/Disconnected/)
  }
  /** Reopened and chosen from history: the remembered password shows only as a placeholder, with the box checked. */
  async function remembered() {
    const dialog = await open()
    await choose(dialog)
    const { password, remember } = form(dialog)
    await expect(password).toHaveValue('')
    await expect(password).toHaveAttribute('placeholder', '••••••••')
    await expect(remember).toBeChecked()
    return dialog
  }

  await launch(options, 'fake')
  // (1) Typed and remembered, then (2) only ciphertext under the history entry's id.
  let dialog = await open()
  await fill(dialog, marker)
  await expect(form(dialog).remember).toBeEnabled()
  await form(dialog).remember.check()
  await connected(dialog)
  const id = await historyId('password-check')
  await expect.poll(async () => (await entries()).map(entry => entry.profileId)).toEqual([id])
  if (process.platform !== 'win32') expect((await stat(passwordsFile)).mode & 0o777).toBe(0o600)
  await noSecrets()
  // (3) The renderer never holds it, not even in the library it loads.
  dialog = await remembered()
  await dialog.screenshot({ path: resolve('artifacts', 'connect-remember-password.png') })
  expect(await page.evaluate(async () => JSON.stringify(await window.varia.loadConnectionLibrary()))).not.toContain(marker)
  expect(await connectWin.evaluate(() => document.body.innerHTML)).not.toContain(marker)
  // (4) Space selects without connecting. Enter connects the focused saved row, even after editing the form without reselecting it.
  const attemptsBeforeEnter = (await calls()).filter(call => call.method === 'connections.connect').length
  await savedConnections(dialog, 'password-check').focus()
  await savedConnections(dialog, 'password-check').press('Space')
  expect((await calls()).filter(call => call.method === 'connections.connect')).toHaveLength(attemptsBeforeEnter)
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Server Name', { exact: true }).fill('other-server')
  await dialog.getByLabel('Login', { exact: true }).fill('other-reader')
  await pressToClose(savedConnections(dialog, 'password-check'), 'Enter')
  await dialogClosed(connectWin, 'Connect')
  expect((await calls()).filter(call => call.method === 'connections.connect' && call.params.server === 'password-check').map(call => call.params.password)).toEqual(['<redacted>'])
  // Enter used the saved row, which reuses its live connection: the edited form was not submitted, and nothing new opened.
  expect((await calls()).filter(call => call.method === 'connections.connect')).toHaveLength(attemptsBeforeEnter)
  expect((await calls()).filter(call => call.method === 'connections.connect' && (call.params.server === 'other-server' || call.params.username === 'other-reader'))).toEqual([])
  await expect(serverRows(page).filter({ hasText: 'other-server' })).toHaveCount(0)
  await expect(serverRows(page).filter({ hasText: 'password-check' })).toHaveCount(1)
  // (5) A forged request naming the entry gets no password for another server or a weaker certificate check.
  const forged = await page.evaluate(async profileId => {
    const base = { server: 'evil-server', database: '', authentication: 'sql', username: 'reader', trustServerCertificate: false, encrypt: 'mandatory' }
    const evil = await window.varia.connect(base, { profileId, remember: true })
    const trusting = await window.varia.connect({ ...base, server: 'password-check', trustServerCertificate: true }, { profileId, remember: true })
    return [evil.ok, trusting.ok, trusting.passwordForgotten ?? null]
  }, id)
  expect(forged).toEqual([true, false, null])
  const forgedCalls = (await calls()).filter(call => call.method === 'connections.connect' && (call.params.server === 'evil-server' || call.params.trustServerCertificate))
  expect(forgedCalls).toHaveLength(2)
  for (const call of forgedCalls) expect(call.params).not.toHaveProperty('password')
  expect((await entries()).map(entry => entry.profileId)).toEqual([id])
  await noSecrets()
  // (6) Kept across a restart.
  await app.close(); app = undefined
  await launch(options, 'fake')
  dialog = await remembered()
  await dialog.getByRole('button', { name: 'Favorite password-check', exact: true }).click()
  await expect(savedConnections(dialog, 'password-check')).toHaveCount(1)
  await savedConnections(dialog, 'password-check').first().dblclick().catch(error => { if (!connectWin.isClosed()) throw error })
  await dialogClosed(connectWin, 'Connect')
  // (6b) An untrusted certificate: trusting it changes the certificate settings the remembered password was saved for, and
  // main gives a password only to those, so the fix checks the box and asks for the password instead of connecting.
  await disconnectPasswordServer()
  // The longer label fits under the form even if the groups wrap with the system font. High zoom forces the wrap.
  await explorerLabel(await explorerRow(page, 'password-check')).click({ button: 'right' })
  await page.getByRole('menu', { name: 'Object Explorer', exact: true }).getByRole('menuitem', { name: 'Reconnect…', exact: true }).click()
  ;({ window: connectWin, dialog } = await connectDialogWindow(app))
  await expect(form(dialog).password).toHaveAttribute('placeholder', '••••••••')
  await form(dialog).password.fill(marker)
  const reconnect = dialog.getByRole('button', { name: 'Update Credentials and Reconnect', exact: true })
  await expect(reconnect).toBeVisible()
  expect(await footerFit(dialog)).toMatchObject(containedFooter)
  const contentSize = await connectContentSize()
  await size(1024, 700)
  await zoom(2.5)
  await expect.poll(() => footerFit(dialog)).toEqual({ ...containedFooter, wrapped: true })
  await expect(reconnect).toBeInViewport()
  await zoom(1)
  await size(...contentSize)
  await form(dialog).password.fill('')
  await clickToClose(dialog.getByRole('button', { name: 'Cancel', exact: true }))
  await dialogClosed(connectWin, 'Connect')
  await writeFile(join(control, 'untrusted-certificate'), '')
  dialog = await remembered()
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('not trusted')
  const connects = async () => (await calls()).filter(call => call.method === 'connections.connect').length
  const attempted = await connects()
  await dialog.getByRole('button', { name: 'Trust server certificate and connect', exact: true }).click()
  await expect(dialog.getByText(/enter the password, then connect/)).toBeVisible()
  await expect(form(dialog).password).toBeFocused()
  await expect(dialog.getByLabel('Trust server certificate', { exact: true })).toBeChecked()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  expect(await connects()).toBe(attempted)
  await rm(join(control, 'untrusted-certificate'))
  // Trusting the certificate changed the entry's settings, so closing asks whether to keep that change.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  const keepTrust = connectWin.getByRole('dialog', { name: /^Save changes to / })
  await expect(keepTrust).toBeVisible()
  await clickToClose(keepTrust.getByRole('button', { name: "Don't Save", exact: true }))
  await dialogClosed(connectWin, 'Connect')
  // (7) Rejected after a password change: forgotten, and the dialog says so.
  // The certificate failure left it offline, so this attempt must authenticate rather than reuse a live transport.
  await writeFile(join(control, 'reject-passwords'), '')
  dialog = await remembered()
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText("Login failed for user 'reader'.")
  await expect(dialog.getByText('The saved password was rejected, so it has been removed. Enter the password.', { exact: true })).toBeVisible()
  await expect(form(dialog).remember).not.toBeChecked()
  await expect(form(dialog).password).not.toHaveAttribute('placeholder', '••••••••')
  expect(await entries()).toEqual([])
  // Another failed connect keeps that notice: the next attempt clears only Stop's "Connection cancelled.".
  const attempts = async () => (await calls()).filter(call => call.method === 'connections.connect' && call.params.server === 'password-check').length
  const before = await attempts()
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect.poll(attempts).toBe(before + 1)
  await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('alert')).toContainText("Login failed for user 'reader'.")
  await expect(dialog.getByText('The saved password was rejected, so it has been removed. Enter the password.', { exact: true })).toBeVisible()
  await rm(join(control, 'reject-passwords'))
  // (8) Remembered again, then unchecked: connecting forgets it.
  await form(dialog).password.fill(marker)
  await form(dialog).remember.check()
  await connected(dialog)
  await expect.poll(async () => (await entries()).length).toBe(1)
  dialog = await remembered()
  await form(dialog).remember.uncheck()
  await connected(dialog)
  expect(await entries()).toEqual([])
  // (9) Remembered again, then the entry's ×: gone from both files.
  dialog = await open()
  await choose(dialog)
  await form(dialog).password.fill(marker)
  await form(dialog).remember.check()
  await connected(dialog)
  await expect.poll(async () => (await entries()).length).toBe(1)
  dialog = await remembered()
  await dialog.getByRole('button', { name: 'Remove saved password-check', exact: true }).first().click()
  await expect.poll(async () => ({ saved: await entries(), entry: await historyId('password-check') })).toEqual({ saved: [], entry: undefined })
  // (10) Windows Authentication has no password to remember: neither Password nor Remember password shows.
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await expect(form(dialog).remember).toHaveCount(0)
  await expect(form(dialog).password).toHaveCount(0)
  await noSecrets()
  // (11) Stop through main's own handlers (varia:request registers the dialog's requestId, varia:connections-cancel sends
  // CANCEL): the fake ends a Microsoft Entra sign-in wait only on a CANCEL frame, and logs it.
  const cancels = async () => parseCalls(await read(join(control, 'cancels.jsonl'))).map(line => line.method)
  const loading = dialog.getByText('Loading databases…', { exact: true })
  await dialog.getByLabel('Server Name', { exact: true }).fill('entra-wait')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('entraMfa')
  await dialog.getByLabel('User name', { exact: true }).fill('alice@contoso.com')
  // Load databases (focusing Database Name) waits for the browser; changing the form stops it.
  await dialog.getByLabel('Database Name', { exact: true }).focus()
  await expect(loading).toBeVisible()
  await dialog.getByLabel('User name', { exact: true }).fill('bob@contoso.com')
  await expect.poll(cancels).toEqual(['connections.databases'])
  await expect(loading).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByText('Complete the sign-in in your web browser. Waiting up to 3 minutes…', { exact: true })).toBeVisible()
  // The dialog says it is waiting before main has sent the connect; a Stop before then ends it in main while it prepares,
  // and the request may never reach the backend. Stop once the backend has it.
  await expect.poll(async () => (await calls()).filter(call => call.method === 'connections.connect' && call.params.server === 'entra-wait').length).toBe(1)
  await dialog.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(dialog.getByText('Connection cancelled.', { exact: true })).toBeVisible()
  // Main answers Stop at once and sends the CANCEL frame beside it: the backend logs it a moment after the dialog says so.
  await expect.poll(cancels).toEqual(['connections.databases', 'connections.connect'])
  // Closing the dialog stops Load databases too.
  await dialog.getByLabel('Database Name', { exact: true }).focus()
  await expect(loading).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  // The connection was never saved: closing asks first, and Don't Save closes.
  await clickToClose(connectWin.getByRole('dialog', { name: 'Save entra-wait to History?', exact: true }).getByRole('button', { name: "Don't Save", exact: true }))
  await dialogClosed(connectWin, 'Connect')
  await expect.poll(cancels).toEqual(['connections.databases', 'connections.connect', 'connections.databases'])
  await app.close(); app = undefined
  // (12) Without the test cipher: Windows (DPAPI) and macOS (Keychain) offer it; Linux needs a keyring.
  await launch({ ...launchOptions, env: seamless }, 'fake')
  const backend = await app.evaluate(({ safeStorage }) => process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os')
  dialog = await open()
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  const note = dialog.getByText('Remember password needs a system keyring (GNOME Keyring or KWallet), and none was found. Passwords are used for this connection only.', { exact: true })
  if (backend === 'basic_text') {
    await expect(form(dialog).remember).toBeDisabled()
    await expect(note).toBeVisible()
  } else if (backend === 'unknown') {
    await expect(form(dialog).remember).toBeDisabled()
    await expect(dialog.getByText(/Remember password is unavailable/)).toBeVisible()
  } else if (backend === 'os') {
    await expect(form(dialog).remember).toBeEnabled()
    await expect(note).toHaveCount(0)
  }
  await clickToClose(dialog.getByRole('button', { name: 'Cancel', exact: true }))
  await dialogClosed(connectWin, 'Connect')
  await app.close(); app = undefined
}


/**
 * Profile labels and independent Explorer target labels through main's handlers and the fake backend. Target edits
 * survive hot exit without rewriting the profile; all badges follow the exact target. Typed profile lookup and
 * explicit details choices remain separate from runtime equality.
 */
async function environmentLabels() {
  const userData = join(environmentProfile, 'user-data'), control = join(environmentProfile, 'control')
  await mkdir(control, { recursive: true })
  const connectionsFile = join(userData, 'mssql-connections.json')
  const fake = { ...env, VARIA_TEST_USER_DATA: userData, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control, VARIA_TEST_SAFE_STORAGE: 'test', VARIA_TEST_HOT_EXIT: '1' }
  await launch({ ...launchOptions, env: fake }, 'fake')
  const saved = async () => JSON.parse(await readFile(connectionsFile, 'utf8')).profiles.find(item => item.options.server.toLowerCase() === 'prod-server')?.options.environment
  const tag = place => environmentPill(page, place)
  // The query bar leads its server with the tag. The active query's facts are in the window's status bar, after the
  // backend's state and its tag: the tag shows there once, not again before the server, and the classic query status bar
  // (off by default) shows none.
  async function shows(text, tone) {
    for (const place of ['explorer', 'tab', 'query', 'status']) {
      await expect(tag(place), place).toHaveText(text)
      await expect(tag(place), place).toHaveAttribute('data-tone', tone)
    }
    await expect(statusBar(page).locator(part.environmentTag)).toHaveCount(1)
    await expect(tag('queryStatus')).toHaveCount(0)
    // Beside the backend's state, not in it: its tooltip and text stay the backend's.
    await expect(backendReady(page, 'fake')).toHaveText('Ready')
  }
  // Object Explorer dragged wider narrows the editor and its query bar to about `width`; the returned call drags it back.
  // The same sash both ways: once dragged, Dockview may mark it dv-maximum rather than dv-enabled.
  async function narrowBar(width) {
    const sash = await page.locator('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash.dv-enabled').first().elementHandle()
    const drag = async dx => {
      const box = await sash.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2
      await page.mouse.move(x, y); await page.mouse.down()
      await page.mouse.move(x + dx, y, { steps: 5 }); await page.mouse.up()
    }
    const before = (await queryBar(page).boundingBox()).width
    await drag(before - width)
    await expect.poll(async () => (await queryBar(page).boundingBox()).width).toBeLessThan(width + 12)
    return async () => {
      await drag((await queryBar(page).boundingBox()).width - before)
      await expect.poll(async () => (await queryBar(page).boundingBox()).width).toBeGreaterThan(before - 12)
    }
  }
  // The lists give way first, then a long label is cut short: the tag never runs under the server list, the lists keep
  // their minimum, and the pill stays inside the bar.
  const barFit = () => queryBar(page).evaluate((bar, part) => {
    const box = bar.getBoundingClientRect(), pill = bar.querySelector('[role="group"]').getBoundingClientRect()
    const tag = bar.querySelector(`${part.environmentTag} ${part.statusPill}`), label = tag.querySelector(part.statusPillLabel), edge = tag.getBoundingClientRect().right
    const [server, database] = [...bar.querySelectorAll('select')].map(list => list.getBoundingClientRect())
    const fit = { clear: edge <= server.left + 0.5, inside: pill.left >= box.left - 0.5 && pill.right <= box.right + 0.5, lists: server.width >= 63.5 && database.width >= 63.5 && database.right <= pill.right + 0.5, cut: label.scrollWidth > label.clientWidth }
    if (!fit.clear || !fit.inside || !fit.lists) return { ...fit, bounds: { width: box.width, pill: pill.width, tag: tag.getBoundingClientRect().width, server: server.width, database: database.width, overflow: database.right - pill.right } }
    return fit
  }, part)
  const serverMenu = async row => {
    await explorerLabel(row).click({ button: 'right' })
    await page.getByRole('menu', { name: 'Object Explorer', exact: true }).getByRole('menuitem', { name: 'Environment…', exact: true }).click()
    return page.getByRole('dialog', { name: 'Connection Environment', exact: true })
  }
  // (1) Production, chosen in the dialog's Labels & Custom Properties beside the colour swatches.
  let dialog = await open()
  await dialog.getByLabel('Server Name', { exact: true }).fill('prod-server')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  await dialog.getByLabel('Login', { exact: true }).fill('reader')
  await dialog.getByLabel('Password', { exact: true }).fill('any-password')
  await dialog.getByLabel('Remember password', { exact: true }).check()
  await expect(dialog.getByLabel('Environment', { exact: true }).locator('option')).toHaveText(['<none>', 'Production', 'Staging', 'Test', 'Development', 'Custom…'])
  await dialog.getByRole('button', { name: 'Red connection color', exact: true }).click()
  await dialog.getByLabel('Environment', { exact: true }).selectOption('Production')
  await submitConnect(connectWin, dialog)
  await shows('PROD', 'critical')
  let row = await explorerRow(page, 'prod-server')
  const originalQuery = await activeDocumentName(page)
  await expect(row).toHaveAttribute('aria-label', /, Production environment$/)
  await expect(page.getByRole('tablist', { name: 'Query documents', exact: true }).getByRole('tab', { selected: true })).toHaveAttribute('aria-description', 'Production environment')
  expect(await saved()).toBe('Production')
  // The tag is the kit's red tag beside the connection colour, which still marks the row; it fits the row, whole.
  const look = await row.evaluate((element, part) => {
    const pill = element.querySelector(`${part.environmentTag} ${part.statusPill}`), style = getComputedStyle(pill), probe = document.createElement('span')
    probe.style.color = 'var(--varia-statusPill-criticalForeground)'
    probe.style.backgroundColor = 'var(--varia-statusPill-criticalBackground)'
    document.body.append(probe)
    const expected = getComputedStyle(probe), box = pill.getBoundingClientRect(), outer = element.getBoundingClientRect()
    const result = { color: style.color === expected.color, fill: style.backgroundColor === expected.backgroundColor, accent: !!element.querySelector(part.explorerAccent),
      inside: box.top >= outer.top && box.bottom <= outer.bottom && box.right <= outer.right + 0.5, whole: pill.scrollWidth <= pill.clientWidth }
    probe.remove()
    return result
  }, part)
  expect(look).toEqual({ color: true, fill: true, accent: true, inside: true, whole: true })
  // The tag is no control, so the query bar's server list, which its keys reach, describes the environment.
  await expect(queryServer(page)).toHaveAttribute('aria-description', 'Production environment')
  // Every compact layout keeps PROD whole beside both lists and all six query actions, including Linux font metrics.
  let widen
  for (const width of [860, 780, 760, 600, 500, 400, 330, 320]) {
    widen = await narrowBar(width)
    expect(await barFit(), `${width} px query bar`).toEqual({ clear: true, inside: true, lists: true, cut: false })
    await widen()
  }
  // Exercise wider glyphs on Windows too, so the Linux font-metrics regression is reproducible locally.
  const originalFamily = await queryBar(page).evaluate(bar => { const family = bar.style.fontFamily; bar.style.fontFamily = 'Verdana, sans-serif'; return family })
  try {
    widen = await narrowBar(320)
    expect(await barFit(), '320 px query bar with wider glyphs').toEqual({ clear: true, inside: true, lists: true, cut: false })
    await widen()
  } finally { await queryBar(page).evaluate((bar, family) => { bar.style.fontFamily = family }, originalFamily) }
  await page.screenshot({ path: resolve('artifacts', 'environment-production.png') })
  // (2) From the server's menu: a Custom label left blank cannot be saved; one typed changes this target and its
  // attached queries, while the independently saved profile keeps Production.
  let labelling = await serverMenu(row)
  const choice = labelling.getByLabel('Environment', { exact: true })
  await expect(choice).toBeFocused()
  await expect(choice).toHaveValue('Production')
  await choice.selectOption('custom')
  await expect(labelling.getByText('Enter an environment label.', { exact: true })).toBeVisible()
  await expect(labelling.getByRole('button', { name: 'OK', exact: true })).toBeDisabled()
  await expect(labelling.getByLabel('Custom environment label', { exact: true })).toHaveAttribute('maxlength', '32')
  await labelling.getByLabel('Custom environment label', { exact: true }).fill('UAT-EU')
  await labelling.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(labelling).toHaveCount(0)
  await shows('UAT-EU', 'neutral')
  expect(await saved()).toBe('Production')
  // The target's own details, credential reference and query association survive a real hot-exit restart without
  // changing the profile. Startup reconnect attaches the original query but never executes its text.
  await app.close(); app = undefined
  const kept = JSON.parse(await readFile(join(userData, 'WorkbenchSession', 'session.json'), 'utf8'))
  expect(kept.workspace.targets).toHaveLength(1)
  expect(kept.workspace.targets[0].details.environment).toBe('UAT-EU')
  expect(kept.workspace.targets[0].resumeWanted).toBe(true)
  expect(kept.workspace.targets[0].credential).toEqual({ profileId: expect.any(String), revision: expect.any(String) })
  expect(kept.documents.find(item => item.name === originalQuery)?.targetId).toBe(kept.workspace.targets[0].id)
  expect(JSON.stringify(kept)).not.toContain('any-password')
  await launch({ ...launchOptions, env: fake }, 'fake')
  await selectOpenDocument(page, originalQuery)
  await expect(queryServer(page).locator('option:checked')).not.toContainText('Disconnected')
  await shows('UAT-EU', 'neutral')
  await expect(serverRows(page)).toHaveCount(1)
  row = await explorerRow(page, 'prod-server')
  expect(await saved()).toBe('Production')
  // (3) Escape changes nothing; Staging is the info tone.
  labelling = await serverMenu(row)
  await expect(labelling.getByLabel('Custom environment label', { exact: true })).toHaveValue('UAT-EU')
  await labelling.getByLabel('Environment', { exact: true }).selectOption('Staging')
  await page.keyboard.press('Escape')
  await expect(labelling).toHaveCount(0)
  await shows('UAT-EU', 'neutral')
  labelling = await serverMenu(row)
  await labelling.getByLabel('Environment', { exact: true }).selectOption('Staging')
  await labelling.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(labelling).toHaveCount(0)
  await shows('STAGING', 'info')
  expect(await saved()).toBe('Production')
  // The longer preset must stay whole beside the two lists, including fonts wider than the Windows default.
  for (const family of ['', 'Verdana, sans-serif', 'Arial Black, sans-serif']) {
    await queryBar(page).evaluate((bar, family) => { bar.style.fontFamily = family }, family)
    try {
      widen = await narrowBar(320)
      expect(await barFit(), `320 px query bar with Staging (${family || 'default font'})`).toEqual({ clear: true, inside: true, lists: true, cut: false })
      await widen()
    } finally { await queryBar(page).evaluate((bar, family) => { bar.style.fontFamily = family }, originalFamily) }
  }
  // (4) History keeps the profile's Production label, choosing it fills that in, and another server drops it with the
  // name and colour. Explorer's Staging target label remains independent.
  dialog = await open()
  const entry = savedConnections(dialog, 'prod-server').first()
  await expect(entry.locator(part.statusPill)).toHaveText('PROD')
  await entry.click()
  await expect(dialog.getByLabel('Environment', { exact: true })).toHaveValue('Production')
  await dialog.getByLabel('Server Name', { exact: true }).fill('other-server')
  await expect(dialog.getByLabel('Environment', { exact: true })).toHaveValue('')
  await expect(dialog.getByRole('button', { name: 'Default connection color', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // (4b) A preset chosen from history after a custom label shows as itself, not as a Custom label that spells it.
  await dialog.getByLabel('Server Name', { exact: true }).fill('uat-server')
  await dialog.getByLabel('Environment', { exact: true }).selectOption('custom')
  await dialog.getByLabel('Custom environment label', { exact: true }).fill('UAT-EU')
  await dialog.getByRole('button', { name: 'Add favorite', exact: true }).click()
  const uatEntry = savedConnections(dialog, 'uat-server').first()
  await expect(uatEntry.locator(part.statusPill)).toHaveText('UAT-EU')
  for (const [chosen, value, custom] of [[entry, 'Production', 0], [uatEntry, 'custom', 1], [entry, 'Production', 0]]) {
    await chosen.click()
    await expect(dialog.getByLabel('Environment', { exact: true })).toHaveValue(value)
    await expect(dialog.getByLabel('Custom environment label', { exact: true })).toHaveCount(custom)
  }
  // Typing a Custom label that spells a preset keeps the box, so "Test" can become "Testing".
  await dialog.getByLabel('Environment', { exact: true }).selectOption('custom')
  await dialog.getByLabel('Custom environment label', { exact: true }).fill('Test')
  await dialog.getByLabel('Custom environment label', { exact: true }).pressSequentially('ing')
  await expect(dialog.getByLabel('Custom environment label', { exact: true })).toHaveValue('Testing')
  // A blank Custom label prevents Connect and focuses Custom environment label.
  await dialog.getByLabel('Custom environment label', { exact: true }).fill('')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Enter an environment label.')
  await expect(dialog.getByLabel('Custom environment label', { exact: true })).toBeFocused()
  // The chosen History entry has an unsaved edit: Cancel asks, and Don't Save closes without saving it.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  let unsaved = connectWin.getByRole('dialog', { name: /^Save changes to / })
  await expect(unsaved).toBeVisible()
  await clickToClose(unsaved.getByRole('button', { name: "Don't Save", exact: true }))
  await dialogClosed(connectWin, 'Connect')
  expect(await saved()).toBe('Production')
  // (4c) Profile lookup folds server case, so typing the saved server's name in uppercase shows Production. Runtime
  // identity preserves the submitted spelling: restore the exact server before testing authenticated reuse of the
  // existing Staging target, whose details can change only after an explicit choice.
  dialog = await open()
  await savedConnections(dialog, 'prod-server').first().click()
  await expect(dialog.getByLabel('Environment', { exact: true })).toHaveValue('Production')
  await dialog.getByLabel('Server Name', { exact: true }).fill('other-server')
  await expect(dialog.getByLabel('Environment', { exact: true })).toHaveValue('')
  await dialog.getByLabel('Server Name', { exact: true }).fill('PROD-SERVER')
  await expect(dialog.getByLabel('Environment', { exact: true })).toHaveValue('Production')
  await dialog.getByLabel('Server Name', { exact: true }).fill('prod-server')
  await dialog.getByLabel('Password', { exact: true }).fill('any-password')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  let details = connectWin.getByRole('dialog', { name: 'Use selected connection details?', exact: true })
  await expect(details).toBeVisible()
  await expect(details).toContainText('Staging')
  await expect(details).toContainText('Production')
  await clickToClose(details.getByRole('button', { name: 'Keep Current Details', exact: true }))
  await dialogClosed(connectWin, 'Connect')
  await expect(serverRows(page)).toHaveCount(1)
  expect(await activeDocumentName(page)).toBe(originalQuery)
  await expect(activeDocument(page).locator(part.statusPill)).toHaveText('STAGING')
  await expect(tag('query')).toHaveText('STAGING')
  await expect(tag('status')).toHaveText('STAGING')
  await expect(tag('queryStatus')).toHaveCount(0)
  expect(await saved()).toBe('Production')
  // Applying the same profile is also explicit: it changes this target, then a server-menu edit can change it back
  // without overwriting the profile. Both submissions reuse the single root and its attached query.
  dialog = await open()
  await savedConnections(dialog, 'prod-server').first().click()
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  details = connectWin.getByRole('dialog', { name: 'Use selected connection details?', exact: true })
  await expect(details).toBeVisible()
  await clickToClose(details.getByRole('button', { name: 'Use Selected Details', exact: true }))
  await dialogClosed(connectWin, 'Connect')
  await shows('PROD', 'critical')
  await expect(serverRows(page)).toHaveCount(1)
  labelling = await serverMenu(row)
  await labelling.getByLabel('Environment', { exact: true }).selectOption('Staging')
  await labelling.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(labelling).toHaveCount(0)
  await shows('STAGING', 'info')
  expect(await saved()).toBe('Production')
  // The query bar and the status bar say what the tag labels, and the status bar shows it once.
  await expect(queryBar(page).locator(part.queryEnvironment)).toHaveText('Environment: STAGING')
  await expect(statusBar(page).locator(part.statusEnvironment)).toHaveText('Active connection environment: STAGING')
  await expect(statusBar(page).locator(part.environmentTag)).toHaveCount(1)
  // SSMS's query window status bar (for one release) leads its server with the tag too, and the window's keeps its own.
  expect(await page.evaluate(() => window.varia.updateSettings({ 'textEditor.statusBar.queryWindow': true }))).toMatchObject({ ok: true })
  await expect(queryStatus(page).locator(part.queryStatusEnvironment)).toHaveText('Environment: STAGING')
  await expect(tag('queryStatus')).toHaveText('STAGING')
  await expect(statusBar(page).locator(part.environmentTag)).toHaveCount(1)
  expect(await page.evaluate(() => window.varia.updateSettings({ 'textEditor.statusBar.queryWindow': null }))).toMatchObject({ ok: true })
  await expect(tag('queryStatus')).toHaveCount(0)
  // (4d) A 32-character custom label is cut short in every place, so the server's name, the tab and the bars keep
  // their room; the full label stays in the tooltip.
  const long = 'W'.repeat(32)
  labelling = await serverMenu(row)
  await labelling.getByLabel('Environment', { exact: true }).selectOption('custom')
  await labelling.getByLabel('Custom environment label', { exact: true }).fill(long)
  const preview = await labelling.evaluate((form, part) => {
    const scroll = form.querySelector(part.connectionScroll), shown = form.querySelector(part.environmentPreview)
    return { dialog: form.scrollWidth <= form.clientWidth && scroll.scrollWidth <= scroll.clientWidth, line: shown.getBoundingClientRect().height <= 24 }
  }, part)
  expect(preview).toEqual({ dialog: true, line: true })
  await labelling.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(labelling).toHaveCount(0)
  expect(await saved()).toBe('Production')
  await expect(tag('explorer').first()).toHaveAttribute('title', `${long} environment`)
  // Both submissions reused the exact runtime target: every attached query follows this target's details.
  await expect(serverRows(page)).toHaveCount(1)
  await expect(tag('query')).toHaveText(long)
  await expect(tag('status')).toHaveText(long)
  await selectOpenDocument(page, originalQuery)
  await expect(tag('status')).toHaveText(long)
  const bounded = await page.evaluate(part => {
    const tree = document.querySelector(part.explorerTreeBox), em = element => parseFloat(getComputedStyle(element).fontSize)
    // Each server row keeps its name (at least a quarter of the row, or all of a shorter one) and the tag inside the row.
    const rows = [...tree.querySelectorAll(part.explorerServerRow)].filter(item => item.querySelector(part.environmentTag)).map(item => {
      const outer = item.getBoundingClientRect(), name = item.querySelector(part.explorerLabel), pill = item.querySelector(`${part.environmentTag} ${part.statusPill}`).getBoundingClientRect()
      return name.getBoundingClientRect().width >= Math.min(name.scrollWidth, outer.width * 0.25) - 0.5 && pill.right <= outer.right + 0.5 && pill.width <= outer.width * 0.4 + 0.5
    })
    const tabTag = document.querySelector(`${part.activeDocumentTab} ${part.environmentTag}`), tab = document.querySelector(part.activeDocumentTab).getBoundingClientRect().width
    const sized = ['query', 'status'].map(place => { const element = document.querySelector(`${part.environmentTag}[data-place="${place}"]`); return element.querySelector(part.statusPill).getBoundingClientRect().width <= 12 * em(element) + 0.5 })
    const label = document.querySelector(`${part.environmentTag}[data-place="status"] ${part.statusPillLabel}`)
    // The query bar keeps its controls inside it: the label gives way, never the lists.
    const bar = document.querySelector(part.queryBar), lists = [...bar.querySelectorAll('select')].map(list => list.getBoundingClientRect())
    const kept = bar.scrollWidth <= bar.clientWidth && lists.every(list => list.width >= 64 - 0.5 && list.right <= bar.getBoundingClientRect().right + 0.5)
    return { rows, tree: tree.scrollWidth <= tree.clientWidth, tab: tabTag.getBoundingClientRect().width <= 10 * em(tabTag) + 0.5 && tab <= 220 + 10 * em(tabTag) + 120, bars: sized, ellipsis: label.scrollWidth > label.clientWidth, queryBar: kept }
  }, part)
  expect(bounded).toEqual({ rows: [true], tree: true, tab: true, bars: [true, true], ellipsis: true, queryBar: true })
  await expect(queryServer(page)).toHaveAttribute('aria-description', `${long} environment`)
  for (const width of [580, 430]) {
    widen = await narrowBar(width)
    expect(await barFit(), String(width)).toEqual({ clear: true, inside: true, lists: true, cut: true })
    if (width === 430) await page.screenshot({ path: resolve('artifacts', 'environment-narrow-query-bar.png') })
    await widen()
  }
  await page.screenshot({ path: resolve('artifacts', 'environment-long-label.png') })
  // A long name and a long label in history: the name gives way and the tag stays inside the row, as PROD does.
  dialog = await open()
  await dialog.getByLabel('Server Name', { exact: true }).fill('sql-reporting-replica-eastus2.corp.example.com')
  await dialog.getByLabel('Name', { exact: true }).fill('Finance data warehouse - primary replica (EU West)')
  await dialog.getByLabel('Environment', { exact: true }).selectOption('custom')
  await dialog.getByLabel('Custom environment label', { exact: true }).fill(long)
  await dialog.getByRole('button', { name: 'Add favorite', exact: true }).click()
  for (const label of [long, 'PROD']) {
    if (label === 'PROD') {
      await dialog.getByLabel('Environment', { exact: true }).selectOption('Production')
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    }
    const longEntry = savedConnections(dialog, 'Finance data warehouse').first()
    await expect(longEntry.locator(part.statusPill)).toHaveText(label)
    const fits = await longEntry.evaluate((button, part) => {
      const outer = button.getBoundingClientRect(), pill = button.querySelector(part.statusPill).getBoundingClientRect(), name = button.querySelector('strong').getBoundingClientRect()
      const shown = button.querySelector(part.statusPillLabel)
      return { inside: pill.width > 0 && pill.left >= outer.left && pill.right <= outer.right + 0.5, name: name.width > 0, whole: shown.scrollWidth <= shown.clientWidth }
    }, part)
    // PROD stays whole beside the long name, which gives way; only the long custom label is cut short.
    expect(fits, label).toEqual({ inside: true, name: true, whole: label === 'PROD' })
  }
  await clickToClose(dialog.getByRole('button', { name: 'Cancel', exact: true }))
  await dialogClosed(connectWin, 'Connect')
  // (4e) The longest custom label beside a live SID (#365), in a shelf cell at the normal width and in a narrow split
  // group: the SID and the tab's buttons stay whole, and the label gives way first, so the query's name keeps at least
  // three characters' room (or all of a shorter name) while the label keeps a few characters and its ellipsis.
  const connected = await activeDocument(page).getAttribute('aria-label')
  await editorTextbox(page).focus()
  await page.keyboard.insertText('select 1')
  await page.keyboard.press('F5')
  await expect(activeDocument(page).locator(part.tabSid)).toHaveText(/^SID \d+$/)
  const tabFit = () => documentTab(page, connected).evaluate((tab, part) => {
    const box = element => element.getBoundingClientRect(), em = parseFloat(getComputedStyle(tab).fontSize)
    const outer = box(tab), sid = box(tab.querySelector(part.tabSid)), name = box(tab.querySelector(part.tabName)), label = box(tab.querySelector(`${part.environmentTag} ${part.statusPill}`))
    const buttons = [...tab.querySelectorAll('button')].map(box)
    const clip = box(tab.querySelector(part.tabSid).parentElement)
    return {
      sid: sid.width > 0 && sid.left >= clip.left - 0.5 && sid.right <= clip.right + 0.5 && buttons.every(button => sid.right <= button.left + 0.5),
      name: name.width >= Math.min(tab.querySelector(part.tabName).scrollWidth, 3 * em) - 0.5, label: label.width >= em && label.right <= sid.left + 0.5, buttons: buttons.every(button => button.right <= outer.right + 0.5)
    }
  }, part)
  const fitted = { sid: true, name: true, label: true, buttons: true }
  await resizeContent(app, page, 1440, 900)
  await expect.poll(tabFit, { message: '1440 px, one editor group' }).toEqual(fitted)
  await resizeContent(app, page, 1024, 720)
  await page.keyboard.press('Control+N')
  await expect.poll(async () => (await activeDocument(page).getAttribute('aria-label')) !== connected).toBe(true)
  await selectOpenDocument(page, connected)
  await editorTextbox(page).focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Backslash' : 'Control+Backslash')
  await expect(editorGroups(page)).toHaveCount(2)
  await expect.poll(tabFit, { message: '1024 px, two editor groups' }).toEqual(fitted)
  // A cell too narrow for the label's few characters beside the SID lets the label go rather than clip the SID.
  const widenEditor = await narrowBar(430)
  await expect.poll(() => documentTab(page, connected).evaluate(tab => tab.getBoundingClientRect().width), { message: 'a split cell under 220 px' }).toBeLessThan(220)
  await expect.poll(tabFit, { message: 'a narrow split cell' }).toMatchObject({ sid: true, buttons: true })
  // The fake session is 51; a real session id may have five digits. Exercise their actual text width in the same cell.
  const sidBefore = await documentTab(page, connected).locator(part.tabSid).evaluate(sid => ({ text: sid.textContent, width: sid.style.width }))
  try {
    for (const text of ['SID 10000', 'SID 32767']) {
      await documentTab(page, connected).locator(part.tabSid).evaluate((sid, text) => { sid.textContent = text; sid.style.width = '' }, text)
      await expect.poll(tabFit, { message: `a narrow split cell with ${text}` }).toMatchObject({ sid: true, buttons: true })
    }
  } finally {
    await documentTab(page, connected).locator(part.tabSid).evaluate((sid, before) => { sid.textContent = before.text; sid.style.width = before.width }, sidBefore)
  }
  await widenEditor()
  await page.screenshot({ path: resolve('artifacts', 'environment-long-label-tabs.png') })
  // The query now has unsaved text: the quit below answers Don't Save.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  // (5) The page cannot store or send a label main refuses: too long, or with a character that reorders text.
  const forged = await page.evaluate(async () => {
    const base = { server: 'prod-server', database: '', authentication: 'sql', username: 'reader', trustServerCertificate: false, encrypt: 'mandatory' }
    const long = await window.varia.saveConnectionProfile({ options: { ...base, environment: 'P'.repeat(33) } })
    const hidden = await window.varia.connect({ ...base, password: 'any-password', environment: 'PROD' + String.fromCharCode(0x202e) })
    return [long.ok, hidden.ok]
  })
  expect(forged).toEqual([false, false])
  expect(await saved()).toBe('Production')
  // (6) Save in Connect's footer relabels the History entry and its live Explorer connection at once, with no reconnect.
  // (4e) left two query tabs open, so check Explorer and the bars rather than shows()'s single tab.
  const relabelled = async (text, tone) => {
    for (const place of ['explorer', 'status']) {
      await expect(tag(place).first(), place).toHaveText(text)
      await expect(tag(place).first(), place).toHaveAttribute('data-tone', tone)
    }
  }
  dialog = await open()
  await savedConnections(dialog, 'prod-server').first().click()
  await dialog.getByLabel('Environment', { exact: true }).selectOption('Test')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await relabelled('TEST', 'neutral')
  // Saving disables Save for a moment; focus comes back to it, so Escape and Tab still reach the dialog.
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused()
  await expect.poll(saved).toBe('Test')
  // A further edit is not dropped silently: Cancel asks, and Cancel there keeps editing.
  await dialog.getByLabel('Environment', { exact: true }).selectOption('Staging')
  await connectWin.keyboard.press('Escape')
  unsaved = connectWin.getByRole('dialog', { name: 'Save changes to prod-server?', exact: true })
  await expect(unsaved).toBeVisible()
  await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(unsaved).toHaveCount(0)
  await expect(dialog.getByLabel('Environment', { exact: true })).toHaveValue('Staging')
  // Connect applies a label the user edited to the reused connection without asking "Use selected connection details?".
  await dialog.getByLabel('Environment', { exact: true }).selectOption('Production')
  await dialog.getByLabel('Password', { exact: true }).fill('any-password')
  await submitConnect(connectWin, dialog)
  await expect(page.getByRole('dialog', { name: 'Use selected connection details?', exact: true })).toHaveCount(0)
  await relabelled('PROD', 'critical')
  await expect(serverRows(page)).toHaveCount(1)
  expect(await saved()).toBe('Production')
  // Only the labels the user changed reach the reused connection: a rename keeps its connection-only Staging.
  labelling = await serverMenu(row)
  await labelling.getByLabel('Environment', { exact: true }).selectOption('Staging')
  await labelling.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(labelling).toHaveCount(0)
  await relabelled('STAGING', 'info')
  dialog = await open()
  await savedConnections(dialog, 'prod-server').first().click()
  await dialog.getByLabel('Name', { exact: true }).fill('Prod reporting')
  await dialog.getByLabel('Password', { exact: true }).fill('any-password')
  await submitConnect(connectWin, dialog)
  await expect(page.getByRole('dialog', { name: 'Use selected connection details?', exact: true })).toHaveCount(0)
  await expect(await explorerRow(page, 'Prod reporting')).toBeVisible()
  await relabelled('STAGING', 'info')
  expect(await saved()).toBe('Production')
  await app.close(); app = undefined
  const finalKept = JSON.parse(await readFile(join(userData, 'WorkbenchSession', 'session.json'), 'utf8'))
  expect(finalKept.workspace.targets).toHaveLength(1)
  expect(finalKept.workspace.targets[0].details).toMatchObject({ displayName: 'Prod reporting', environment: 'Staging' })
  expect(await saved()).toBe('Production')
}

/**
 * The Connect dialog's BigQuery path against the emulator (anonymous credentials, so no Google project or credential is
 * involved): Server type, the account line, the project's datasets, Connect, then the server in Object Explorer and the
 * query tab's project and dataset; then Search Objects' details pane and New Query on a BigQuery result. Skipped without
 * VARIA_TEST_BIGQUERY_ENDPOINT.
 */
async function bigQueryEmulator() {
  const endpoint = process.env.VARIA_TEST_BIGQUERY_ENDPOINT
  if (!endpoint) { console.log('BigQuery Connect dialog checks skipped: VARIA_TEST_BIGQUERY_ENDPOINT is not set.'); return }
  await bigQueryFixtures(endpoint)
  await launch({ ...launchOptions, env: { ...env, VARIA_TEST_USER_DATA: bigQueryProfile, VARIA_TEST_BIGQUERY_ENDPOINT: endpoint } })
  try {
    const dialog = await open()
    const serverTypeGroup = dialog.getByRole('group', { name: 'Server type', exact: true })
    const sqlServerButton = serverTypeGroup.getByRole('button', { name: 'SQL Server', exact: true })
    const bigQueryButton = serverTypeGroup.getByRole('button', { name: 'BigQuery', exact: true })
    await expect(sqlServerButton).toHaveAttribute('aria-pressed', 'true')
    await bigQueryButton.click()
    await expect(bigQueryButton).toHaveAttribute('aria-pressed', 'true')
    expect(await footerFit(dialog)).toEqual(fittingFooter)
    // SQL Server's fields give way to BigQuery's, and Undo is offered.
    await expect(dialog.getByLabel('Server Name', { exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
    await expect(dialog.getByRole('tab', { name: 'Connection String', exact: true })).toHaveCount(0)
    await expect(dialog.getByText(/^Emulator account /)).toBeVisible({ timeout: 20000 })
    await expectControlHeight(dialog.getByLabel('Project', { exact: true }))
    await expectControlHeight(dialog.getByRole('button', { name: 'Load projects', exact: true }))
    await dialog.getByRole('tab', { name: /^Advanced/ }).click()
    await expectControlHeight(dialog.getByLabel('Maximum bytes billed', { exact: true }))
    await expectControlHeight(dialog.getByLabel('Maximum bytes billed unit', { exact: true }))
    await dialog.getByRole('tab', { name: 'Connection Properties', exact: true }).click()
    await dialog.getByLabel('Project', { exact: true }).fill('varia-emulator')
    await dialog.getByRole('button', { name: 'Load datasets', exact: true }).click()
    await expect.poll(() => dialog.getByLabel('Default dataset', { exact: true }).evaluate(input => [...input.list?.options ?? []].map(option => option.value)), { timeout: 20000 }).toContain('varia_fixture')
    await dialog.getByLabel('Default dataset', { exact: true }).fill('varia_fixture')
    await submitConnect(connectWin, dialog, { timeout: 30000 })
    await expect(serverRows(page).filter({ hasText: 'varia-emulator' })).toHaveCount(1)
    await toolbarButton(page, 'New query').click()
    await expect(queryServer(page)).toContainText('varia-emulator')
    await expect(page.getByLabel('Query dataset', { exact: true })).toHaveValue('varia_fixture')
    await expect(queryStatus(page)).toContainText('varia-emulator')
    // Typing dry-runs the text after a pause; the emulator cannot dry-run, so the chip beside Execute says so.
    await editorTextbox(page).focus()
    await page.keyboard.type('SELECT 1')
    await expect(queryBar(page).getByRole('status', { name: 'Estimate: No estimate', exact: true })).toBeVisible({ timeout: 20000 })
    await bigQuerySearchDetails()
    // The query now has unsaved text: the quit below answers Don't Save.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    // Next time, the dialog opens on the type used last, and history lists the project.
    const again = await open()
    await expect(again.getByRole('group', { name: 'Server type', exact: true }).getByRole('button', { name: 'BigQuery', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(savedConnections(again, 'varia-emulator').first()).toBeVisible()
    await clickToClose(again.getByRole('button', { name: 'Cancel', exact: true }))
    await dialogClosed(connectWin, 'Connect')
    const saved = JSON.parse(await readFile(join(bigQueryProfile, 'bigquery-connections.json'), 'utf8'))
    expect(saved.profiles.map(entry => entry.options.project)).toEqual(['varia-emulator'])
    console.log('BigQuery Connect dialog checks passed against the emulator.')
  } finally { await app.close(); app = undefined }
}
