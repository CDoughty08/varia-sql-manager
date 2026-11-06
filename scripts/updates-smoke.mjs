// Help › Check for Updates against a loopback feed (VARIA_TEST_UPDATE_FEED, honoured only in unpackaged smoke runs):
// a filter's page in place of the manifest shows as a failure with its remedy, then a real manifest downloads with
// progress in the status bar, verifies, and Restart to Update closes the app and "installs" (the test feed's install
// writes update-applied.json instead of running the file).
import { electron, expect } from './fixtures/smoke.mjs'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { backendReady, memoryBreakdown, memoryIndicator, statusBar, toastMessage, toasts } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'updates-profile-'))
// No automatic check: the suite runs each one itself.
await writeFile(join(profile, 'settings.json'), JSON.stringify({ version: 1, values: { 'environment.updates.checkAutomatically': false } }))

const version = '99.0.0', name = `Varia-SQL-Manager-${version}-Windows-x64-Setup.exe`
const payload = randomBytes(3 * 1024 * 1024)
const manifest = { schema: 1, version, assets: ['x64', 'arm64'].map(arch => ({ name, kind: 'win-setup', arch, size: payload.length, sha512: createHash('sha512').update(payload).digest('base64') })) }
let mode = 'portal'
const served = []
const server = createServer(async (request, response) => {
  served.push(request.url)
  if (request.url === '/varia-update.json') {
    if (mode === 'portal') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html><body>This site is blocked by your organization.</body></html>'); return }
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(JSON.stringify(manifest))
    return
  }
  if (request.url === `/download/v${version}/${name}`) {
    // Slow enough for the status bar to show progress: 24 chunks, 100 ms apart.
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) })
    const size = Math.ceil(payload.length / 24)
    for (let at = 0; at < payload.length; at += size) { response.write(payload.subarray(at, at + size)); await delay(100) }
    response.end()
    return
  }
  response.writeHead(404).end()
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const feed = `http://127.0.0.1:${server.address().port}/`

const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_UPDATE_FEED: feed, VARIA_TEST_UPDATE_KIND: 'nsis' }
delete env.ELECTRON_RUN_AS_NODE
const failures = []
const application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error('Updates suite exceeded its time limit.'); application.process()?.kill(); process.exitCode = 1 }, 180000)
try {
  const page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page)).toBeVisible({ timeout: 30000 })
  const menu = id => application.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu().getMenuItemById(itemId)
    if (!item) throw new Error('Menu item missing: ' + itemId)
    item.click()
  }, id)
  const bar = statusBar(page)

  // A content filter's page where the manifest should be: the failure, its remedy and its details.
  await memoryIndicator(page).click()
  await expect(memoryBreakdown(page)).toBeVisible()
  await menu('help.checkForUpdates')
  const failed = toasts(page).filter({ hasText: 'not Varia\'s release manifest' })
  await expect(failed).toBeVisible()
  await expect(toastMessage(failed)).toContainText('release-assets.githubusercontent.com')
  await expect(failed.getByRole('button', { name: 'Open releases page' })).toBeVisible()
  // Notifications retain their pointer targets even when Memory is pinned directly underneath.
  await expect(memoryBreakdown(page)).toBeVisible()
  await failed.getByRole('button', { name: 'Try again', exact: true }).click({ trial: true })
  await failed.getByRole('button', { name: 'Open releases page', exact: true }).click({ trial: true })
  const retry = bar.getByRole('button', { name: 'Update check failed' })
  await expect(retry).toBeVisible()
  await expect(retry).toHaveAttribute('title', /content filter.*HTML page/)
  await page.screenshot({ path: 'artifacts/updates-blocked.png' })

  // The real manifest: Try again from the status bar downloads, with progress, and verifies.
  mode = 'feed'
  await retry.click()
  const progress = bar.getByRole('progressbar', { name: 'Downloading update' })
  await expect(progress).toBeVisible()
  await expect(progress).toContainText(/Downloading update \d+%/)
  await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow') ?? -1)).toBeGreaterThan(0)
  const restart = bar.getByRole('button', { name: `Restart to update to ${version}` })
  await expect(restart).toBeVisible({ timeout: 30000 })
  await expect(toasts(page).filter({ hasText: `Varia SQL Manager ${version} is ready to install.` })).toBeVisible()
  await page.screenshot({ path: 'artifacts/updates-ready.png' })
  const state = await page.evaluate(async () => (await window.varia.getUpdateState()).value)
  if (state.status !== 'ready' || state.version !== version) throw new Error(`Unexpected update state: ${JSON.stringify(state)}`)
  const downloaded = await readFile(join(profile, 'updates', name))
  if (!downloaded.equals(payload)) throw new Error('The downloaded update differs from the served file.')
  if (served.filter(url => url.startsWith('/download/')).length !== 1) throw new Error(`Downloaded more than once: ${served.join(', ')}`)

  // Restart to Update closes the app as File › Exit does, then installs.
  const exited = new Promise(resolveExit => application.process().once('exit', resolveExit))
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await restart.click()
  await Promise.race([exited, delay(30000).then(() => { throw new Error('Restart to Update did not close the app.') })])
  const applied = JSON.parse(await readFile(join(profile, 'update-applied.json'), 'utf8'))
  if (applied.kind !== 'nsis' || applied.version !== version || applied.file !== name) throw new Error(`Unexpected install: ${JSON.stringify(applied)}`)
  if ((await readdir(join(profile, 'updates'))).some(file => file.endsWith('.partial'))) throw new Error('A partial download was left behind.')
  if (failures.length) throw new Error(`Page errors: ${failures.join('; ')}`)
  console.log('Update checks: a blocked feed shows its remedy; a download shows progress, verifies, and installs after Restart to Update.')
} finally {
  clearTimeout(watchdog)
  server.close()
  await application.close().catch(() => {})
}
