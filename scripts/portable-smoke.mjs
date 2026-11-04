import { chromium, expect } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { backendReady } from './fixtures/ui.mjs'

const executable = process.env.VARIA_PORTABLE_EXECUTABLE
if (!executable || process.platform !== 'win32') throw new Error('Set VARIA_PORTABLE_EXECUTABLE to the Windows portable executable.')

// The portable launcher extracts and starts Electron as a child; it does not forward the inspector output that
// Playwright's Electron launcher expects. Connect to the child's Chromium debugging port instead.
const server = createServer()
await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen))
const port = server.address().port
await new Promise(resolveClose => server.close(resolveClose))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(resolve(executable), [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
let browser
try {
  const endpoint = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Portable launcher exited before startup: ${child.exitCode}`)
    try { browser = await chromium.connectOverCDP(endpoint, { timeout: 2000 }); break } catch { await delay(500) }
  }
  if (!browser) throw new Error('Portable application did not open its debugging port.')
  let page
  while (Date.now() < deadline && !page) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('file:'))
    if (!page) await delay(250)
  }
  if (!page) throw new Error('Portable application did not open its window.')
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 60000 })
  await expect(backendReady(page)).toHaveText('Ready', { timeout: 60000 })
  const health = await page.evaluate(() => window.varia.health())
  if (!health.ok) throw new Error(`Portable backend health failed at ${page.url()}: ${JSON.stringify(health)}`)
  expect(health.value).toMatchObject({ protocolVersion: 2, smoVersion: expect.stringMatching(/^\d+\./) })
  await page.close()
  const exited = await Promise.race([new Promise(resolveExit => child.once('exit', () => resolveExit(true))), delay(30000).then(() => false)])
  if (!exited && child.exitCode === null) throw new Error('Portable launcher did not exit after closing the app.')
} finally {
  await browser?.close().catch(() => {})
  if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
