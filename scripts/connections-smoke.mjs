import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

// Same rules as the backend live checks: SQL authentication when a test login is supplied, otherwise Windows authentication.
const liveUser = process.env.VARIA_TEST_SQL_USER?.trim() ? process.env.VARIA_TEST_SQL_USER : undefined
if (process.env.VARIA_TEST_SQL_SERVER && liveUser && process.env.VARIA_TEST_SQL_PASSWORD === undefined) throw new Error('VARIA_TEST_SQL_PASSWORD is required when VARIA_TEST_SQL_USER is set.')
await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'connections-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const recentId = crypto.randomUUID()
await writeFile(join(profile, 'connections.json'), JSON.stringify({ version: 1, profiles: [{ id: recentId, options: { server: 'recent-server', database: 'master', authentication: 'windows', trustServerCertificate: false }, favorite: false, registered: false, lastConnected: new Date().toISOString() }] }))
let app
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Connection suite timed out.'); app?.process()?.kill(); process.exitCode = 1 }, 180000)
async function launch() {
  app = await electron.launch(launchOptions)
  page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.getByText(/\.NET 10\..*Ready/)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
}
async function open() {
  await page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Connect', exact: true })).toBeVisible()
  await expect(page.getByText('Loading saved connections…')).toHaveCount(0)
  return page.getByRole('dialog', { name: 'Connect', exact: true })
}
async function size(width, height) { await app.evaluate(({ BrowserWindow }, dimensions) => { BrowserWindow.getAllWindows()[0].setContentSize(...dimensions) }, [width, height]) }
try {
  await launch()
  let dialog = await open()
  await expect(dialog.getByText('recent-server', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Favorite recent-server', exact: true }).click()
  await expect(dialog.locator('details').first().getByText('recent-server', { exact: true })).toBeVisible()
  await dialog.getByLabel('Filter connections').fill('not-a-match')
  await expect(dialog.getByText('recent-server', { exact: true })).toHaveCount(0)
  await dialog.getByLabel('Filter connections').fill('')
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
  await dialog.getByLabel('Server Name', { exact: true }).fill('sql-dev')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  await dialog.getByLabel('User Name', { exact: true }).fill('reader')
  await dialog.getByLabel('Password', { exact: true }).fill('never-store-this-marker')
  await dialog.getByLabel('Name', { exact: true }).fill('Development')
  await dialog.getByLabel('Color', { exact: true }).selectOption('#e66b73')
  await dialog.getByRole('button', { name: 'Add favorite', exact: false }).click()
  await expect(dialog.getByRole('button', { name: 'Remove favorite', exact: false })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Register server', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Unregister server', exact: true })).toBeEnabled()
  let stored = await readFile(join(profile, 'connections.json'), 'utf8')
  expect(stored).not.toContain('never-store-this-marker')
  expect(stored).not.toContain('password')
  await dialog.getByRole('button', { name: 'Advanced…', exact: true }).click()
  let advanced = page.getByRole('dialog', { name: 'Advanced Properties', exact: true })
  await expect(advanced).toBeVisible()
  await expect(dialog).toHaveAttribute('inert', '')
  await advanced.getByLabel('Command timeout (seconds)', { exact: true }).fill('7')
  await advanced.getByLabel('Connect timeout (seconds)', { exact: true }).fill('20')
  await advanced.getByLabel('Enable secure enclaves', { exact: true }).isDisabled().then(value => expect(value).toBe(true))
  await advanced.getByLabel('Enable Always Encrypted', { exact: true }).selectOption('true')
  await advanced.getByLabel('Enable secure enclaves', { exact: true }).selectOption('true')
  await advanced.getByLabel('Attestation protocol', { exact: true }).selectOption('HGS')
  await advanced.getByLabel('Enclave attestation URL', { exact: true }).fill('https://attestation.example')
  await advanced.getByLabel('Enable Always Encrypted', { exact: true }).selectOption('false')
  await expect(advanced.getByLabel('Enable secure enclaves', { exact: true })).toHaveValue('false')
  await advanced.getByLabel('Multiple active result sets', { exact: true }).selectOption('true')
  await advanced.getByLabel('Network library', { exact: true }).selectOption('tcp')
  await advanced.getByLabel('Application intent', { exact: true }).selectOption('ReadOnly')
  await advanced.getByLabel('Packet size', { exact: true }).fill('8192')
  await advanced.screenshot({ path: resolve('artifacts', 'advanced-connection-properties.png') })
  await advanced.getByRole('button', { name: 'OK', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => JSON.parse(await readFile(join(profile, 'connections.json'), 'utf8')).profiles.find(item => item.options.displayName === 'Development')?.options.advanced?.commandTimeout).toBe(7)
  await dialog.getByRole('tab', { name: 'Connection String', exact: true }).click()
  await expect(dialog.getByLabel('Connection string preview')).toContainText('tcp:sql-dev')
  await expect(dialog.getByLabel('Connection string preview')).toContainText('Application Intent=ReadOnly')
  await expect(dialog.getByLabel('Connection string preview')).not.toContainText('never-store-this-marker')
  await dialog.getByRole('tab', { name: 'Connection Properties', exact: true }).click()
  await dialog.getByRole('button', { name: 'Advanced…', exact: true }).click()
  advanced = page.getByRole('dialog', { name: 'Advanced Properties', exact: true })
  await advanced.getByLabel('Command timeout (seconds)', { exact: true }).fill('99')
  await advanced.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.getByRole('button', { name: 'Advanced…', exact: true }).click()
  advanced = page.getByRole('dialog', { name: 'Advanced Properties', exact: true })
  await expect(advanced.getByLabel('Command timeout (seconds)', { exact: true })).toHaveValue('7')
  await page.keyboard.press('Escape')
  await expect(advanced).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Advanced…', exact: true })).toBeFocused()
  await dialog.getByRole('tab', { name: 'Browse', exact: true }).click()
  await expect(dialog.getByText('Discovering local servers…')).toHaveCount(0, { timeout: 10000 })
  await dialog.getByLabel('Server source', { exact: true }).selectOption('registered')
  await expect(dialog.getByText('Development', { exact: true })).toBeVisible()
  await dialog.getByText('Development', { exact: true }).click()
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue('')
  await expect(dialog.getByLabel('Color', { exact: true })).toHaveValue('#e66b73')
  // A saved profile's name and color describe its server, so typing another server drops them.
  await dialog.getByLabel('Server Name', { exact: true }).fill('another-server')
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('')
  await expect(dialog.getByLabel('Color', { exact: true })).toHaveValue('')
  await dialog.getByText('Development', { exact: true }).click()
  await expect(dialog.getByLabel('Color', { exact: true })).toHaveValue('#e66b73')
  await dialog.getByRole('tab', { name: 'History', exact: true }).click()
  const controlMetrics = await dialog.locator('.property-row select').evaluateAll(controls => controls.filter(control => control.getClientRects().length).map(control => {
    const style = getComputedStyle(control)
    return { height: control.getBoundingClientRect().height, contentHeight: control.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom), lineHeight: parseFloat(style.lineHeight) }
  }))
  expect(controlMetrics.filter(control => control.contentHeight < control.lineHeight)).toEqual([])
  await dialog.screenshot({ path: resolve('artifacts', 'connect-dialog.png') })
  await size(1024, 700)
  await expect.poll(async () => { const box = await dialog.boundingBox(); return box.y + box.height <= 700 }).toBe(true)
  await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport()
  await dialog.getByRole('button', { name: 'Advanced…', exact: true }).click()
  advanced = page.getByRole('dialog', { name: 'Advanced Properties', exact: true })
  await expect(advanced.getByRole('button', { name: 'OK', exact: true })).toBeInViewport()
  await expect(advanced.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport()
  await advanced.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await app.close(); app = undefined
  await launch()
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  dialog = await open()
  await expect(dialog.getByText('Development', { exact: true })).toBeVisible()
  await dialog.getByText('Development', { exact: true }).click()
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue('')
  await dialog.getByRole('button', { name: 'Advanced…', exact: true }).click()
  advanced = page.getByRole('dialog', { name: 'Advanced Properties', exact: true })
  await expect(advanced.getByLabel('Command timeout (seconds)', { exact: true })).toHaveValue('7')
  await advanced.getByRole('button', { name: 'Cancel', exact: true }).click()
  if (process.env.VARIA_TEST_SQL_SERVER) {
    await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
    await dialog.getByLabel('Server Name', { exact: true }).fill(process.env.VARIA_TEST_SQL_SERVER)
    if (liveUser) {
      await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
      await dialog.getByLabel('User Name', { exact: true }).fill(liveUser)
      await dialog.getByLabel('Password', { exact: true }).fill(process.env.VARIA_TEST_SQL_PASSWORD)
    } else await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
    await dialog.getByLabel('Trust server certificate', { exact: true }).check()
    await dialog.getByLabel('Database Name', { exact: true }).focus()
    await expect(dialog.getByText(/databases available/)).toBeVisible({ timeout: 35000 })
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30000 })
    const liveLibrary = JSON.parse(await readFile(join(profile, 'connections.json'), 'utf8'))
    expect(liveLibrary.profiles.some(item => item.options.server === process.env.VARIA_TEST_SQL_SERVER && item.lastConnected)).toBe(true)
    dialog = await open()
    await expect(dialog.getByText(process.env.VARIA_TEST_SQL_SERVER, { exact: true })).toBeVisible()
    await dialog.getByText('Development', { exact: true }).click()
  }
  // Keep native profile persistence but supply deterministic discovery/failure fixtures.
  await app.evaluate(({ ipcMain }) => {
    globalThis.connectionCalls = []
    globalThis.dbPending = []
    ipcMain.removeHandler('varia:request')
    ipcMain.handle('varia:request', async (_event, method, params) => {
      globalThis.connectionCalls.push({ method, params: { ...params, password: params.password ? '<redacted>' : undefined } })
      if (method === 'connections.discover') return { ok: true, value: { servers: [{ server: params.scope + '-server', version: '17.0', source: params.scope }], warning: 'Discovery can be incomplete.' } }
      if (method === 'connections.databases') {
        if (params.server === 'slow-server') return new Promise(resolve => { globalThis.dbPending.push(resolve) })
        if (params.server === 'db-error') return { ok: false, error: 'Login failed.' }
        return { ok: true, value: [{ name: 'master', isSystem: true, isSnapshot: false }, { name: 'AppData', isSystem: false, isSnapshot: false }] }
      }
      if (method === 'connections.connect') {
        if (params.server === 'connect-error') return { ok: false, error: 'Server unavailable.' }
        return { ok: true, value: { id: crypto.randomUUID(), server: params.server, database: params.database || 'master', serverVersion: '17.0.fixture', color: params.color, displayName: params.displayName, commandTimeout: params.advanced?.commandTimeout ?? 0 } }
      }
      if (method === 'databases.list') return { ok: true, value: [{ name: 'master', isSystem: true, isSnapshot: false }] }
      if (method === 'query.execute') return { ok: true, value: { resultSets: [], messages: [], recordsAffected: -1, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1, database: params.database, messagesTruncated: false } }
      return { ok: false, error: 'Unsupported fixture method.' }
    })
  })
  await dialog.getByRole('tab', { name: 'Browse', exact: true }).click()
  await dialog.getByLabel('Server source', { exact: true }).selectOption('network')
  await expect(dialog.getByRole('button', { name: /network-server/ })).toBeVisible()
  await dialog.getByRole('button', { name: /network-server/ }).click()
  await expect(dialog.getByLabel('Server Name', { exact: true })).toHaveValue('network-server')
  await dialog.getByLabel('Database Name', { exact: true }).focus()
  await expect(dialog.getByText('2 databases available.')).toBeVisible()
  expect(await dialog.locator('#available-databases option').evaluateAll(options => options.map(option => option.value))).toContain('AppData')
  await dialog.getByLabel('Server Name', { exact: true }).fill('slow-server')
  await dialog.getByRole('button', { name: 'Load databases', exact: true }).click()
  await expect(dialog.getByText('Loading databases…')).toBeVisible()
  await dialog.getByLabel('Server Name', { exact: true }).fill('db-error')
  await app.evaluate(() => { globalThis.dbPending.splice(0).forEach(resolve => resolve({ ok: true, value: [{ name: 'StaleDb', isSystem: false, isSnapshot: false }] })) })
  await dialog.getByRole('button', { name: 'Load databases', exact: true }).click()
  await expect(dialog.getByText(/Could not load databases: Login failed/)).toBeVisible()
  // Refocusing the database field must not retry a rejected login (account lockout); only Refresh retries.
  const discoveryAttempts = () => app.evaluate(() => globalThis.connectionCalls.filter(call => call.method === 'connections.databases').length)
  const attempts = await discoveryAttempts()
  await dialog.getByLabel('Server Name', { exact: true }).focus()
  await dialog.getByLabel('Database Name', { exact: true }).focus()
  await page.waitForTimeout(300)
  expect(await discoveryAttempts()).toBe(attempts)
  expect(await dialog.locator('#available-databases option').evaluateAll(options => options.map(option => option.value))).not.toContain('StaleDb')
  await dialog.getByLabel('Server Name', { exact: true }).fill('connect-error')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Server unavailable')
  const history = await page.evaluate(() => window.varia.loadConnectionLibrary())
  expect(history.value.library.profiles.some(item => item.options.server === 'connect-error')).toBe(false)
  await dialog.getByLabel('Server Name', { exact: true }).fill('connected-server')
  await dialog.getByLabel('Database Name', { exact: true }).fill('AppData')
  await dialog.getByLabel('Name', { exact: true }).fill('Development')
  // Leaving a saved profile for another server drops that profile's name and color, so choose them for this server.
  await expect(dialog.getByLabel('Color', { exact: true })).toHaveValue('')
  await dialog.getByLabel('Color', { exact: true }).selectOption('#e66b73')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.query-context')).toContainText('Development')
  expect(await page.locator('.query-context').evaluate(element => getComputedStyle(element).borderBottomColor)).toBe('rgb(230, 107, 115)')
  await page.locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT 1;')
  await page.getByRole('button', { name: /Execute/ }).click()
  await expect.poll(() => app.evaluate(() => globalThis.connectionCalls.find(call => call.method === 'query.execute')?.params.timeoutSeconds)).toBe(7)
  expect(failures).toEqual([])
  console.log('Connection dialog checks passed: history/favorites/registration, password omission, provider preview, advanced apply/cancel, restart persistence, local/network browsing, live database choices, stale discovery suppression, error recovery, colors, timeout routing, compact sizing, and keyboard focus.')
} finally {
  clearTimeout(watchdog)
  await app?.close().catch(() => app?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
}

