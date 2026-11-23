// Focused developer entry point; CI exercises the same fixture inside results-smoke's existing launches.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { backendReady, connectDialogWindow, localGrid, outputStatus, outputView, queryBarButton, submitConnect, toolbarButton } from './fixtures/ui.mjs'
import { connectLive } from './fixtures/live-rows.mjs'
import { enlargeOutput } from './fixtures/results-pane.mjs'
import { checkClientStatistics } from './fixtures/client-statistics.mjs'

await mkdir('artifacts', { recursive: true })
for (const live of [false, ...(process.env.VARIA_TEST_SQL_SERVER ? [true] : [])]) {
  const profile = await mkdtemp(resolve('artifacts', 'statistics-profile-'))
  const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  if (!live) { env.VARIA_TEST_BACKEND = 'workbench'; env.VARIA_TEST_NODE = process.execPath }
  else { delete env.VARIA_TEST_BACKEND; delete env.VARIA_TEST_NODE }
  const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  const failures = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', error => failures.push(error.message))
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    if (live) await expect(backendReady(page)).toBeVisible({ timeout: 30000 })
    if (live) await connectLive(app, page, expect)
    else {
      await toolbarButton(page, 'Connect').click()
      const { window: connectWin, dialog } = await connectDialogWindow(app)
      await dialog.getByLabel('Server Name', { exact: true }).fill('statistics-fixture')
      await submitConnect(connectWin, dialog)
    }
    await enlargeOutput(page)
    const run = async (sql, { running = false } = {}) => {
      await page.locator('.monaco-editor [role="textbox"]').focus()
      await page.keyboard.press('Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('F5')
      await expect(outputStatus(page)).toContainText(running ? /^Executing · / : /^Completed( with errors)? · /)
    }
    await checkClientStatistics(page, expect, run, live, app)
    if (live) {
      await queryBarButton(page, 'Include Client Statistics').click()
      await run("WAITFOR DELAY '00:00:05'; SELECT 1;", { running: true })
      await app.evaluate(() => globalThis.__variaTest.kill())
      await outputView(page, 'Client Statistics').click()
      await expect(page.getByRole('status').filter({ hasText: /^Run 1: unavailable/ })).toBeVisible()
      await expect(localGrid(page, 'Client statistics comparison').getByRole('columnheader', { name: 'Average (0 runs)', exact: true })).toBeVisible()
      await expect(backendReady(page)).toBeVisible({ timeout: 30000 })
      console.log('Client statistics backend-loss/restart check passed.')
    }
    expect(failures).toEqual([])
  } finally {
    await app.close()
    if (!profile.startsWith(resolve('artifacts') + sep)) throw new Error('Unexpected test profile path.')
    await rm(profile, { recursive: true, force: true })
  }
}
