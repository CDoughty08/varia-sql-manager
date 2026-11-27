// Live Electron screenshot capture for Wave 2 AP-3 (Job Activity Monitor & Agent Overview).
import { expect } from '../fixtures/smoke.mjs'
import { chooseExplorerMenuItem } from '../fixtures/explorer-tree.mjs'
import { chooseJamMoreAction, documentFrame, documentTab, gridPart, jamTile, jamToolbar, liveGrid, statusBar } from '../fixtures/ui.mjs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function captureAp3(outDir, profile, { launchMainApp, connectFakeServer, captureMatrix }) {
  const control = await mkdtemp(resolve('artifacts', 'agent-polish-ap3-backend-'))
  await writeFile(resolve(control, 'agent-node'), '')
  await writeFile(resolve(control, 'agent-operator-jobs'), '')
  const { app, page } = await launchMainApp(profile, control)
  const jobCell = name => liveGrid(page, 'Jobs').locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: new RegExp(`^${name}$`) }) }).locator(gridPart.cell).nth(2)
  try {
    await connectFakeServer(app, page)
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Job Activity Monitor')
    const frame = documentFrame(page, 'Job Activity Monitor')
    await expect(jobCell('Nightly')).toBeVisible()
    await expect(jamTile(frame, 'Last run failed')).toHaveAttribute('aria-label', /^Last run failed: 1/)

    // 1. JAM: 0 jobs selected ("Select a job" state via Running tile when 0 jobs are running).
    await jamTile(frame, 'Running').click()
    await expect(jamTile(frame, 'Running')).toHaveAttribute('aria-pressed', 'true')
    await expect(jamToolbar(frame)).toContainText('Select a job')
    await captureMatrix(app, page, outDir, '01-jam-unselected')
    await jamToolbar(frame).getByRole('button', { name: 'Clear filters', exact: true }).click()
    await expect(jobCell('Nightly')).toBeVisible()

    // 2. JAM: 2 jobs selected.
    await jobCell('Nightly').click()
    await page.keyboard.press('Shift+ArrowDown')
    await expect(jamToolbar(frame)).toContainText('2 jobs selected')
    await captureMatrix(app, page, outDir, '02-jam-two-selected')

    // 3. JAM: Last Run split drawer open with inline message preview.
    await jobCell('Nightly').click()
    await expect(jamToolbar(frame)).toContainText('1 job selected')
    await jamToolbar(frame).getByRole('button', { name: 'Last run', exact: true }).click()
    const lastRun = frame.getByRole('region', { name: 'Last run of Nightly', exact: true })
    await expect(lastRun).toBeVisible()
    await expect(lastRun.getByRole('separator', { name: 'Resize last run message', exact: true })).toBeVisible()
    await expect(lastRun.getByRole('region', { name: 'Step message preview', exact: true })).toContainText('Executed as user: sa.')
    await captureMatrix(app, page, outDir, '03-jam-last-run-drawer')
    await lastRun.getByRole('button', { name: 'Hide the last run', exact: true }).click()
    await expect(lastRun).toHaveCount(0)

    // 4. JAM: Agent Stopped banner (with Start Agent…).
    await writeFile(resolve(control, 'explorer-status.json'), JSON.stringify({ agent: [0, 1, 2] }))
    await expect(frame.getByRole('status').filter({ hasText: 'SQL Server Agent is not running' })).toBeVisible({ timeout: 20000 })
    await expect(frame.getByRole('button', { name: 'Start Agent…', exact: true })).toBeVisible()
    await captureMatrix(app, page, outDir, '04-jam-agent-stopped')
    await rm(resolve(control, 'explorer-status.json'), { force: true })
    await frame.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(frame.getByRole('status').filter({ hasText: 'SQL Server Agent is not running' })).toHaveCount(0)
    await expect(statusBar(page)).not.toContainText('SQL Server Agent stopped')

    // 5. Agent Overview: Needs attention + Passing.
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Agent Overview')
    await expect(documentTab(page, 'Agent Overview - server-a')).toHaveAttribute('aria-selected', 'true')
    const overview = documentFrame(page, 'SQL Server Agent')
    await expect(overview.getByRole('status', { name: 'SQL Server Agent: Running', exact: true })).toBeVisible()
    await expect(overview.getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible()
    await expect(overview.getByRole('heading', { name: 'Passing', exact: true })).toBeVisible()
    await captureMatrix(app, page, outDir, '05-agent-overview')

    // Verify More actions menu works in Electron as well before exit.
    await documentTab(page, 'Job Activity Monitor - server-a').click()
    await jobCell('Nightly').click()
    await chooseJamMoreAction(page, frame, 'Change owner…')
    await expect(frame.getByRole('region', { name: 'Change the owner of 1 job', exact: true })).toBeVisible()
    await frame.getByRole('button', { name: 'Cancel', exact: true }).click()
  } finally {
    await app.close().catch(() => {})
    await rm(control, { recursive: true, force: true }).catch(() => {})
  }
}
