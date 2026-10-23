import { electron, expect } from './fixtures/smoke.mjs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { userInfo } from 'node:os'
import { explorerRow, explorerStatics } from './fixtures/explorer-tree.mjs'
import { backendReady, connectErrorDetails, databaseErrorDetails, part, queryStatus, savedConnections, statusBar, toolbarButton } from './fixtures/ui.mjs'

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
await writeFile(join(profile, 'connections.json'), JSON.stringify({ version: 1, profiles: [{ id: recentId, options: { server: 'recent-server', database: 'master', authentication: 'windows', trustServerCertificate: false }, favorite: false, registered: false, lastConnected: new Date().toISOString() }] }))
let app
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Connection suite timed out.'); app?.process()?.kill(); process.exitCode = 1 }, 300000)
// Remember password's phase: its own profile and the fake backend, whose server password-check accepts only one password.
const passwordProfile = await mkdtemp(resolve('artifacts', 'connections-passwords-'))
async function launch(options = launchOptions, runtime) {
  app = await electron.launch(options)
  page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page, runtime)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
}
async function open() {
  await toolbarButton(page, 'Connect').click()
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
  await authentication.selectOption(defaultAuthentication === 'windows' ? 'sql' : 'windows')
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(authentication).toHaveValue(defaultAuthentication)
  await dialog.getByLabel('Server Name', { exact: true }).fill('sql-dev')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  // SQL Server Authentication's field is Login, as in SSMS 22.
  await dialog.getByLabel('Login', { exact: true }).fill('reader')
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
  // A profile without a command timeout leaves it empty, showing Tools › Options' Execution time-out (0 by default).
  await expect(advanced.getByLabel('Command timeout (seconds)', { exact: true })).toHaveValue('')
  await expect(advanced.getByLabel('Command timeout (seconds)', { exact: true })).toHaveAttribute('placeholder', '0 (Tools › Options)')
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
  // Reading while the app saves is deliberate (Windows refuses to replace an open file); a failed save shows its dialog error here.
  // OK stores only the fields changed or touched (Always Encrypted and secure enclaves went back to False), so the
  // defaults, and Tools › Options for the command timeout, keep applying to the rest.
  await expect.poll(async () => ({ advanced: JSON.parse(await readFile(join(profile, 'connections.json'), 'utf8')).profiles.find(item => item.options.displayName === 'Development')?.options.advanced, errors: await dialog.getByRole('alert').allTextContents() })).toEqual({
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
  const controlMetrics = await dialog.locator('select').evaluateAll(controls => controls.filter(control => control.getClientRects().length).map(control => {
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
    expect([...await dialog.getByRole('alert').allTextContents(), ...await connectErrorDetails(dialog).allTextContents()].join(' ')).not.toMatch(/never-store-this-marker|Password=/i)
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
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30000 })
    const liveLibrary = JSON.parse(await readFile(join(profile, 'connections.json'), 'utf8'))
    expect(liveLibrary.profiles.some(item => item.options.server === process.env.VARIA_TEST_SQL_SERVER && item.lastConnected)).toBe(true)
    dialog = await open()
    await expect(dialog.getByText(process.env.VARIA_TEST_SQL_SERVER, { exact: true })).toBeVisible()
    await dialog.getByText('Development', { exact: true }).click()
  }
  // Keep native profile persistence but supply deterministic discovery/failure fixtures.
  await app.evaluate(({ ipcMain }, statics) => {
    globalThis.connectionCalls = []
    globalThis.dbPending = []
    // A Microsoft Entra MFA connect to 'entra-wait' waits for the browser until the dialog's Stop names its request id.
    globalThis.entraPending = new Map()
    globalThis.entraStops = []
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
        return { ok: true, value: [{ name: 'master', isSystem: true, isSnapshot: false }, { name: 'AppData', isSystem: false, isSnapshot: false }] }
      }
      if (method === 'connections.connect') {
        if (params.server === 'server-down') return { ok: false, error: 'Server unavailable.', code: 'SQL_ERROR', details: { number: 53, state: 0, class: 20, server: 'server-down' } }
        if (params.server === 'server-down-plain') return { ok: false, error: 'Server unavailable without details.' }
        return { ok: true, value: { id: crypto.randomUUID(), server: params.server, database: params.database || 'master', serverVersion: '17.0.fixture', color: params.color, displayName: params.displayName, commandTimeout: params.advanced?.commandTimeout ?? 0 } }
      }
      // alice@CONTOSO.COM, unless the suite holds the answer back (identityPending) to look at the dialog while it waits.
      if (method === 'connections.identity') return globalThis.identityPending ? new Promise(resolve => { globalThis.identityResolve = resolve }) : { ok: true, value: { principal: 'alice@CONTOSO.COM' } }
      if (method === 'databases.list') return { ok: true, value: [{ name: 'master', isSystem: true, isSnapshot: false }] }
      // Object Explorer expands each new server: the catalogue's static folders.
      if (method === 'explorer.children') {
        const { node } = params, owner = node.type === 'object' ? node.object : node.owner
        const nodes = (node.type === 'object' ? statics.objects[node.object.kind] : statics.folders[node.folder]).map(folder => ({ ref: { type: 'folder', owner, folder }, label: statics.labels[folder], icon: 'folder', hasChildren: true }))
        return { ok: true, value: { nodes, total: nodes.length, elapsedMs: 1 } }
      }
      if (method === 'query.execute') return { ok: true, value: { resultSets: [], discardedResultSets: 0, messages: [], recordsAffected: -1, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1, database: params.database, messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, generation: 1, seq: 1 }, completedAt: '2026-10-09T12:00:00.0000000+00:00' } }
      // Quitting reads each idle query's transaction; this fixture's sessions hold none.
      if (method === 'query.session.state') return { ok: true, value: { transactionCount: 0, checked: true } }
      return { ok: false, error: 'Unsupported fixture method.' }
    })
  }, explorerStatics())
  // Off Windows the dialog asks for the ticket's principal when it opens, as SSMS reads the identity on open, so the saved
  // Windows Authentication rows show it whichever authentication the form starts on (SQL Server Authentication there), and
  // asks again each time Windows Authentication is chosen. Windows shows DOMAIN\user and never asks.
  const integratedRows = async () => [...new Set(await savedConnections(dialog, 'recent-server').locator('small').allTextContents())]
  const identityCalls = () => app.evaluate(() => globalThis.connectionCalls.filter(call => call.method === 'connections.identity').length)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  dialog = await open()
  if (process.platform === 'win32') await expect.poll(integratedRows).toEqual(['master · ' + windowsIdentity])
  else {
    await expect.poll(integratedRows).toEqual(['master · alice@CONTOSO.COM'])
    expect(await identityCalls()).toBe(1)
  }
  await dialog.getByText('Development', { exact: true }).click()
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
  await dialog.getByText('Development', { exact: true }).click()
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
  await dialog.getByLabel('Server Name', { exact: true }).fill('server-down')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Server unavailable')
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
  const history = await page.evaluate(() => window.varia.loadConnectionLibrary())
  expect(history.value.library.profiles.some(item => item.options.server === 'server-down')).toBe(false)
  await dialog.getByLabel('Server Name', { exact: true }).fill('connected-server')
  await dialog.getByLabel('Database Name', { exact: true }).fill('AppData')
  await dialog.getByLabel('Name', { exact: true }).fill('Development')
  // Leaving a saved profile for another server drops that profile's name and color, so choose them for this server.
  await expect(dialog.getByLabel('Color', { exact: true })).toHaveValue('')
  await dialog.getByLabel('Color', { exact: true }).selectOption('#e66b73')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
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
  console.log('Connection dialog checks passed: history/favorites/registration, password omission, provider preview, advanced apply/cancel, restart persistence, local/network browsing, live database choices, stale discovery suppression, error recovery, connection and database discovery failure details, the integrated identity, colors in the query and Object Explorer, timeout routing, compact sizing, keyboard focus, the eight authentication types with their fields, Stop (button and Escape) while a Microsoft Entra sign-in waits, Help › Clear Entra ID Token Cache, and Remember password (saved only as ciphertext after a connect, filled in by main for the same credentials only, kept across restarts, forgotten when rejected, unchecked or removed, and disabled without a keyring or for Windows Authentication).')
} finally {
  clearTimeout(watchdog)
  await app?.close().catch(() => app?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
  await rm(passwordProfile, { recursive: true, force: true })
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
  await expect(password).toBeDisabled()
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
  await expect(password).toBeDisabled()
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
  await connect.click()
  await expect(stopButton).toBeEnabled()
  await expect(stopButton).toBeFocused()
  await expect(dialog.getByText('Complete the sign-in in your web browser. Waiting up to 3 minutes…', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('Server Name', { exact: true })).toBeDisabled()
  await dialog.screenshot({ path: resolve('artifacts', 'connect-dialog-entra.png') })
  await stopButton.click()
  await expect(dialog.getByText('Connection cancelled.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(dialog.getByLabel('Server Name', { exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
  let ids = await connectIds()
  expect(ids).toHaveLength(1)
  expect(await app.evaluate(() => globalThis.entraStops)).toEqual(ids)
  // Escape is Stop while connecting, and leaves the dialog open.
  await connect.click()
  await expect(stopButton).toBeFocused()
  await page.keyboard.press('Escape')
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
  const passwordsFile = join(userData, 'saved-passwords.json'), connectionsFile = join(userData, 'connections.json'), callsFile = join(control, 'calls.jsonl')
  const seamless = { ...env, VARIA_TEST_USER_DATA: userData, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
  delete seamless.VARIA_TEST_SAFE_STORAGE
  const options = { ...launchOptions, env: { ...seamless, ...process.platform === 'win32' ? {} : { VARIA_TEST_SAFE_STORAGE: 'test' } } }
  const read = path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const entries = async () => JSON.parse(await read(passwordsFile) || '{"entries":[]}').entries
  const calls = async () => (await read(callsFile)).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const historyId = async server => JSON.parse(await read(connectionsFile)).profiles.find(item => item.options.server === server && item.lastConnected)?.id
  async function noSecrets() {
    for (const [name, text] of [['saved-passwords.json', await read(passwordsFile)], ['connections.json', await read(connectionsFile)], ['calls.jsonl', await read(callsFile)]]) {
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
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toHaveCount(0)
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
  expect(await page.evaluate(() => document.body.innerHTML)).not.toContain(marker)
  // (4) An empty Password connects with main's injected one.
  await connected(dialog)
  expect((await calls()).filter(call => call.method === 'connections.connect' && call.params.server === 'password-check').map(call => call.params.password)).toEqual(['<redacted>', '<redacted>'])
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
  await connected(dialog)
  // (7) Rejected after a password change: forgotten, and the dialog says so.
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
  // (10) Windows Authentication has no password to remember.
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await expect(form(dialog).remember).toBeDisabled()
  await expect(form(dialog).remember).not.toBeChecked()
  await noSecrets()
  // (11) Stop through main's own handlers (varia:request registers the dialog's requestId, varia:connections-cancel sends
  // CANCEL): the fake ends a Microsoft Entra sign-in wait only on a CANCEL frame, and logs it.
  const cancels = async () => (await read(join(control, 'cancels.jsonl'))).split('\n').filter(Boolean).map(line => JSON.parse(line).method)
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
  await dialog.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(dialog.getByText('Connection cancelled.', { exact: true })).toBeVisible()
  expect(await cancels()).toEqual(['connections.databases', 'connections.connect'])
  // Closing the dialog stops Load databases too.
  await dialog.getByLabel('Database Name', { exact: true }).focus()
  await expect(loading).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
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
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await app.close(); app = undefined
}

