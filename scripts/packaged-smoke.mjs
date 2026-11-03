import { electron, expect } from './fixtures/smoke.mjs'
import { backendReady } from './fixtures/ui.mjs'
import { resolve } from 'node:path'

const executablePath = process.env.VARIA_PACKAGED_EXECUTABLE
if (!executablePath) throw new Error('VARIA_PACKAGED_EXECUTABLE must name the packaged application executable.')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const application = await electron.launch({ executablePath: resolve(executablePath), env, chromiumSandbox: process.getuid?.() !== 0, timeout: 60000 })
try {
  expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true)
  const page = await application.firstWindow()
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 60000 })
  await expect(backendReady(page)).toHaveText('Ready', { timeout: 60000 })
  const health = await page.evaluate(() => window.varia.health())
  expect(health.ok && health.value.protocolVersion).toBe(2)
  expect(health.ok && health.value.smoVersion).toMatch(/^\d+\./)
} finally {
  await application.close()
}
