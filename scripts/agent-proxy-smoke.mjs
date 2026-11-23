// SQL Server Agent's proxy and Credential documents (AG-8b) against the fake backend's proxy and credential (tests/fixtures/backend.mjs,
// VARIA_TEST_BACKEND=workbench; the smoke runs open the release gate): New › Proxy… on the SQL Server Agent node opens New Proxy, whose
// credential is created in place with a password typed into masked fields; Create sends one agentProxy action whose secret the call log
// shows only as sent, and the tab becomes the proxy's. Properties on a proxy under its subsystem's folder opens one tab per proxy with its
// references; an edit counts on Save. Enter on a credential opens its document with Used by; "Change identity and password" sends both
// with the version it read. Screenshots in Dark and Light go to artifacts/.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chooseExplorerMenuItem, explorerRow, expandExplorerPath } from './fixtures/explorer-tree.mjs'
import { connectDialogWindow, documentFrame, documentTab, documentVerb, statusBar, submitConnect, toolbarButton } from './fixtures/ui.mjs'
import { parseCalls } from './fixtures/call-log.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'agent-proxy-profile-'))
const control = await mkdtemp(resolve('artifacts', 'agent-proxy-backend-'))
// The fake backend lists the SQL Server Agent node, its proxies and the credentials only for the Agent suites.
await writeFile(resolve(control, 'agent-node'), '')
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error('Proxy and credential suite exceeded its time limit.'); app.process()?.kill(); process.exitCode = 1 }, 180000)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const failures = []
let step = 'start'
page.on('pageerror', error => failures.push(error.message))

// A password no fixture or log may hold in clear.
const typed = 'Smoke-Secret-7f3a'
const callLog = () => readFile(resolve(control, 'calls.jsonl'), 'utf8').catch(() => '')
const calls = async method => parseCalls(await callLog()).filter(call => call.method === method).map(call => call.params)
const saves = async action => (await calls('actions.execute')).filter(call => call.action === action)
async function connect(server) {
  await toolbarButton(page, 'Connect').click()
  const { window, dialog } = await connectDialogWindow(app)
  await dialog.getByLabel('Server Name', { exact: true }).fill(server)
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await submitConnect(window, dialog, { timeout: 30000 })
}

try {
  await expect(statusBar(page)).toContainText(/Ready/, { timeout: 30000 })
  await connect('server-a')

  step = 'new proxy'
  // New › Proxy… on the Agent node; the credential is created in place, its password only in masked fields.
  await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], ['New', 'Proxy…'])
  await expect(documentTab(page, 'New Proxy')).toHaveAttribute('aria-selected', 'true')
  const created = documentFrame(page, 'New Proxy')
  await created.getByLabel('Name', { exact: true }).first().fill('ExportRunner')
  const proxy = documentFrame(page, 'ExportRunner')
  await proxy.getByRole('button', { name: 'New credential', exact: true }).click()
  const inline = proxy.getByRole('group', { name: 'New credential', exact: true })
  await inline.getByLabel('Name', { exact: true }).fill('ExportRunnerCred')
  await inline.getByLabel('Identity', { exact: true }).fill('CONTOSO\\svc-export')
  await expect(inline.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password')
  await inline.getByLabel('Password', { exact: true }).fill(typed)
  await inline.getByLabel('Confirm password', { exact: true }).fill(typed)
  await proxy.getByRole('checkbox', { name: 'PowerShell', exact: true }).check()
  await page.screenshot({ path: 'artifacts/agent-proxy-dark.png' })
  await documentVerb(proxy, 'ExportRunner', 'Create').click()
  await expect(documentTab(page, 'Proxy Account Properties - ExportRunner')).toHaveAttribute('aria-selected', 'true')
  await expect(documentFrame(page, 'ExportRunner').getByRole('status').filter({ hasText: 'The proxy was created, and its credential with it' })).toBeVisible()
  expect((await saves('agentProxy')).at(-1)).toMatchObject({ target: { kind: 'agent' }, secrets: { secret: '<redacted>' },
    agentProxy: { name: 'ExportRunner', newCredential: { name: 'ExportRunnerCred', identity: 'CONTOSO\\svc-export' }, grantSubsystems: [12] } })
  // The password reached the backend once and nowhere else: not the call log, not a script request, not the page after Save.
  expect((await callLog()).includes(typed)).toBe(false)
  expect((await calls('actions.script')).every(call => !Object.hasOwn(call, 'secrets'))).toBe(true)
  await expect(documentFrame(page, 'ExportRunner').getByRole('group', { name: 'New credential', exact: true })).toHaveCount(0)
  expect(await page.evaluate(secret => document.body.innerHTML.includes(secret), typed)).toBe(false)
  console.log('New Proxy passed: the inline credential and its password go in one Create, and the password is kept nowhere.')

  step = 'properties'
  // Properties on a proxy under its subsystem's folder; one tab per proxy; an edit counts on Save.
  await expandExplorerPath(page, 'server-a', 'SQL Server Agent', 'Proxies', 'Operating system (CmdExec)')
  await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent', 'Proxies', 'Operating system (CmdExec)', 'FileShareWriter'], 'Properties')
  await expect(documentTab(page, 'Proxy Account Properties - FileShareWriter')).toHaveAttribute('aria-selected', 'true')
  const existing = documentFrame(page, 'FileShareWriter')
  await expect(existing.getByLabel('Description', { exact: true })).toHaveValue('Writes extracts to the file share.')
  await expect(existing.getByRole('table', { name: 'Job steps that run as this proxy', exact: true })).toContainText('Copy extracts')
  await existing.getByLabel('Description', { exact: true }).fill('Writes the nightly extracts.')
  await existing.getByRole('button', { name: 'Remove CONTOSO\\etl', exact: true }).click()
  await documentVerb(existing, 'FileShareWriter', 'Save · 2 changes').click()
  await expect(existing.getByRole('status').filter({ hasText: 'The proxy was saved.' })).toBeVisible()
  expect((await saves('agentProxy')).at(-1)).toMatchObject({ target: { kind: 'agentProxy', name: 'FileShareWriter' }, proxyId: 1, agentProxy: { description: 'Writes the nightly extracts.', revokePrincipals: ['CONTOSO\\etl'] } })
  expect((await saves('agentProxy')).at(-1)).not.toHaveProperty('secrets')
  console.log('Properties passed: a proxy opens its document with its references, and Save sends only the changes under its id.')

  step = 'credential'
  // Enter on a credential opens its document with Used by; the change sends the identity and the password with the version read.
  await expandExplorerPath(page, 'server-a', 'Security', 'Credentials')
  await (await explorerRow(page, 'server-a', 'Security', 'Credentials', 'FileShareWriterCred')).click()
  await page.keyboard.press('Enter')
  await expect(documentTab(page, 'Credential Properties - FileShareWriterCred')).toHaveAttribute('aria-selected', 'true')
  const credential = documentFrame(page, 'FileShareWriterCred')
  await expect(credential.getByRole('list', { name: 'Proxies and job steps that use this credential', exact: true })).toContainText('FileShareWriter')
  await expect(credential.getByLabel('Identity', { exact: true })).toBeDisabled()
  await credential.getByLabel('Change identity and password', { exact: true }).check()
  await credential.getByLabel('Password', { exact: true }).fill(typed)
  await credential.getByLabel('Confirm password', { exact: true }).fill(typed)
  await documentVerb(credential, 'FileShareWriterCred', 'Save · 1 change').click()
  await expect(credential.getByRole('status').filter({ hasText: 'The credential was saved' })).toBeVisible()
  expect((await saves('credential')).at(-1)).toMatchObject({ target: { kind: 'credential', name: 'FileShareWriterCred' }, secrets: { secret: '<redacted>' },
    credential: { id: 65536, modified: '2026-11-08T16:02:11.123', identity: 'CONTOSO\\svc-fswriter' } })
  expect((await callLog()).includes(typed)).toBe(false)
  await expect(credential.getByLabel('Change identity and password', { exact: true })).not.toBeChecked()

  step = 'light'
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'light' }))
  await page.screenshot({ path: 'artifacts/agent-credential-light.png' })
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'dark' }))
  console.log('Credential passed: a credential opens with Used by, and its change sends the identity and the password together.')

  if (failures.length) throw new Error('Page errors: ' + failures.join(' | '))
  console.log('Proxy and credential suite passed.')
} catch (error) {
  console.error(`Proxy and credential suite failed at "${step}":`, error)
  await page.screenshot({ path: 'artifacts/agent-proxy-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await app.close().catch(() => app.process()?.kill())
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
