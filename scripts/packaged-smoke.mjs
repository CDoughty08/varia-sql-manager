import { chromium, expect } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { getCurrentFuseWire } from '@electron/fuses'
import { backendReady } from './fixtures/ui.mjs'
import { asarProblems, isReadyToRun, readAsar, readyToRunAssemblies } from './packaged-contents.mjs'

const { fuseMismatches, fuseTarget } = createRequire(import.meta.url)('../build/fuses.cjs')
const executablePath = process.env.VARIA_PACKAGED_EXECUTABLE
if (!executablePath) throw new Error('VARIA_PACKAGED_EXECUTABLE must name the packaged application executable.')
const executable = resolve(executablePath)

// The packaged executable carries build/fuses.cjs's fuses: no file: privileges, no Node mode, NODE_OPTIONS or --inspect.
// An AppImage's executable sits compressed in its squashfs; appimage-check.mjs inspect reads its fuses after extracting it.
if (!executable.endsWith('.AppImage')) {
  const wrong = fuseMismatches(await getCurrentFuseWire(fuseTarget(executable)))
  if (wrong.length) throw new Error(`Packaged fuses not applied: ${wrong.join(', ')}`)
}

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

// With --inspect fused off, Playwright's Electron launcher cannot attach to main; connect to Chromium's debugging port. A
// packaged build keeps that port only with VARIA_PACKAGED_SMOKE=1 and a profile other than the user's (sandbox-guard.ts):
// VARIA_PACKAGED_PROFILE=<dir>, or a fresh temporary one.
const server = createServer()
await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen))
const port = server.address().port
await new Promise(resolveClose => server.close(resolveClose))
const env = { ...process.env, VARIA_PACKAGED_SMOKE: '1' }
delete env.ELECTRON_RUN_AS_NODE
const temporaryProfile = process.env.VARIA_PACKAGED_PROFILE ? undefined : mkdtempSync(join(tmpdir(), 'varia-packaged-smoke-'))
const profile = temporaryProfile ?? resolve(process.env.VARIA_PACKAGED_PROFILE)
const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])]
const child = spawn(executable, args, { env, stdio: 'ignore' })
let browser
try {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged application exited before startup: ${child.exitCode}`)
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }); break } catch { await delay(500) }
  }
  if (!browser) throw new Error('Packaged application did not open its debugging port.')
  let page
  while (Date.now() < deadline && !page) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === 'app://varia/index.html')
    if (!page) await delay(250)
  }
  if (!page) throw new Error('Packaged application did not open its window.')
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 60000 })
  await expect(backendReady(page)).toHaveText('Ready', { timeout: 60000 })
  const health = await page.evaluate(() => window.varia.health())
  expect(health.ok && health.value.protocolVersion).toBe(2)
  expect(health.ok && health.value.smoVersion).toMatch(/^\d+\./)
  // The packaged page cannot read local files either.
  expect(await page.evaluate(async () => { try { await fetch('file:///'); return 'read' } catch (error) { return error.name } })).toBe('TypeError')
  await page.close()
  // macOS keeps an app running with no windows; elsewhere closing the last window quits.
  if (process.platform !== 'darwin') {
    const exited = child.exitCode !== null || child.signalCode !== null || await Promise.race([new Promise(resolveExit => child.once('exit', () => resolveExit(true))), delay(30000, false, { ref: false })])
    if (!exited && child.exitCode === null) throw new Error('Packaged application did not exit after closing its window.')
  }
} finally {
  await browser?.close().catch(() => {})
  if (child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGKILL')
  }
  if (temporaryProfile) rmSync(temporaryProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
