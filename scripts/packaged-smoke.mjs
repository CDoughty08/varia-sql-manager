import { chromium, expect } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { getCurrentFuseWire } from '@electron/fuses'
import { closeMs, within } from './fixtures/smoke.mjs'
import { backendReady } from './fixtures/ui.mjs'
import { asarProblems, isReadyToRun, readAsar, readyToRunAssemblies } from './packaged-contents.mjs'
import { hostRid, sqlToolsServiceProblems } from './prepare-sqltools-service.mjs'

const { fuseMismatches, fuseTarget } = createRequire(import.meta.url)('../build/fuses.cjs')
const executablePath = process.env.VARIA_PACKAGED_EXECUTABLE
if (!executablePath) throw new Error('VARIA_PACKAGED_EXECUTABLE must name the packaged application executable.')
const executable = resolve(executablePath)
let currentPhase
const phase = name => { currentPhase = name; console.log(`Packaged smoke: ${name}.`) }

// An AppImage's executable and resources sit compressed in its squashfs: appimage-check.mjs inspect reads its fuses after
// extracting it, and the same build's linux-unpacked run checks the archive and backend below. Here it is only launched.
const appImage = executable.endsWith('.AppImage')
phase('validating packaged contents')
if (!appImage) {
  // The packaged executable carries build/fuses.cjs's fuses: no file: privileges, no Node mode, NODE_OPTIONS or --inspect.
  const wrong = fuseMismatches(await getCurrentFuseWire(fuseTarget(executable)))
  if (wrong.length) throw new Error(`Packaged fuses not applied: ${wrong.join(', ')}`)

  // Every package is bundled into out/: no node_modules in the archive, and main and preload load only Electron and node: modules.
  const resources = process.platform === 'darwin' ? resolve(dirname(executable), '../Resources') : resolve(dirname(executable), 'resources')
  const asar = resolve(resources, 'app.asar')
  const contents = readAsar(asar)
  if (!contents.has('out/main/index.js')) throw new Error(`${asar} does not hold out/main/index.js.`)
  const problems = asarProblems(contents)
  if (problems.length) throw new Error(`Packaged app.asar: ${problems.join('; ')}`)
  // The backend is published ReadyToRun.
  const interpreted = readyToRunAssemblies.filter(name => !isReadyToRun(resolve(resources, 'backend', name)))
  if (interpreted.length) throw new Error(`Packaged backend assemblies are not ReadyToRun: ${interpreted.join(', ')}`)
  const languageProblems = await sqlToolsServiceProblems(resolve(resources, 'sqltools-service'), hostRid())
  if (languageProblems.length) throw new Error(`Packaged SQL Tools Service: ${languageProblems.join(' ')}`)
}

// With --inspect fused off, Playwright's Electron launcher cannot attach to main; connect to Chromium's debugging port. A
// packaged build keeps that port only with VARIA_PACKAGED_SMOKE=1 and a profile other than the user's (sandbox-guard.ts):
// VARIA_PACKAGED_PROFILE=<dir>, or a fresh temporary one.
const server = createServer()
await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen))
const port = server.address().port
await new Promise(resolveClose => server.close(resolveClose))
const env = { ...process.env, VARIA_PACKAGED_SMOKE: '1' }
delete env.ELECTRON_RUN_AS_NODE
// The package must supply its language service independently of a developer's override.
delete env.VARIA_SQLTOOLS_SERVICE_PATH
delete env.VARIA_SQLTOOLS_SERVICE_SOURCE
const temporaryProfile = process.env.VARIA_PACKAGED_PROFILE ? undefined : mkdtempSync(join(tmpdir(), 'varia-packaged-smoke-'))
const profile = temporaryProfile ?? resolve(process.env.VARIA_PACKAGED_PROFILE)
const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])]
phase('starting owned application')
const child = spawn(executable, args, { env, stdio: 'ignore' })
let browser
async function smoke() {
  phase('connecting to application')
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged application exited before startup: ${child.exitCode}`)
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }); break } catch { await delay(500) }
  }
  if (!browser) throw new Error('Packaged application did not open its debugging port.')
  phase('finding application window')
  let page
  while (Date.now() < deadline && !page) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === 'app://varia/index.html')
    if (!page) await delay(250)
  }
  if (!page) throw new Error('Packaged application did not open its window.')
  phase('waiting for editor and backend readiness')
  await expect(page.locator('.monaco-editor[role=code]')).toBeVisible({ timeout: 60000 })
  await expect(backendReady(page)).toHaveText('Ready', { timeout: 60000 })
  phase('checking backend health')
  const health = await page.evaluate(() => window.varia.health())
  expect(health.ok && health.value.protocolVersion).toBe(2)
  expect(health.ok && health.value.smoVersion).toMatch(/^\d+\./)
  phase('checking language availability')
  const languageStatus = await page.evaluate(() => window.varia.languageStatus())
  expect(languageStatus.ok && languageStatus.value.providers.find(provider => provider.id === 'sqlserver')?.configured).toBe(true)
  phase('checking bundled language service')
  const languageDocument = await page.evaluate(async () => {
    const documentId = crypto.randomUUID()
    const result = await window.varia.languageComplete({ documentId, version: 1, text: 'SEL', context: { providerId: 'sqlserver' }, position: { line: 0, character: 3 } })
    await window.varia.languageClose(documentId)
    return result
  })
  expect(languageDocument.ok, JSON.stringify(languageDocument)).toBe(true)
  // The packaged page cannot read local files either.
  phase('checking file access boundary')
  expect(await page.evaluate(async () => { try { await fetch('file:///'); return 'read' } catch (error) { return error.name } })).toBe('TypeError')
  phase('closing application window')
  await within(page.close(), closeMs, () => { throw new Error('Packaged application window did not close within 45 s.') })
  // macOS keeps an app running with no windows; elsewhere closing the last window quits.
  if (process.platform !== 'darwin') {
    phase('waiting for graceful application exit')
    const exited = child.exitCode !== null || child.signalCode !== null || await within(new Promise(resolveExit => child.once('exit', () => resolveExit(true))), 30000, () => false)
    if (!exited && child.exitCode === null) throw new Error('Packaged application did not exit after closing its window.')
  }
  phase('finished functional checks')
}
try {
  await within(smoke(), 300000, () => { throw new Error(`Packaged smoke did not complete within 300 s during ${currentPhase}.`) })
} catch (error) {
  console.error(`Packaged smoke failed during ${currentPhase}.`, error)
  throw error
} finally {
  phase('stopping owned application')
  let stopFailure
  // End our app before disconnecting CDP: macOS deliberately keeps it alive after its last window closes.
  try {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        const stopped = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: closeMs })
        if (stopped.error || stopped.status !== 0) stopFailure = new Error('Packaged smoke could not stop its owned application within 45 s.')
      }
      else child.kill('SIGKILL')
    }
  } catch { stopFailure = new Error('Packaged smoke could not stop its owned application.') }
  try {
    phase('disconnecting application browser')
    if (browser) await within(browser.close().catch(() => {}), closeMs, () => { throw new Error('Packaged browser cleanup did not complete within 45 s.') })
  } finally {
    phase('removing temporary profile')
    if (temporaryProfile) rmSync(temporaryProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  }
  if (stopFailure) throw stopFailure
}
phase('finished')
