import { expect } from '../fixtures/smoke.mjs'
import { chooseExplorerMenuItem } from '../fixtures/explorer-tree.mjs'
import { chooseJamMoreAction, documentFrame, documentTab, gridPart, liveGrid, quickInputRows } from '../fixtures/ui.mjs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function captureAp4(outDir, profile, { captureMatrix, launchMainApp, connectFakeServer }) {
  const control = await mkdtemp(resolve('artifacts', 'agent-polish-backend-'))
  await writeFile(resolve(control, 'agent-node'), '')
  await writeFile(resolve(control, 'agent-operator-jobs'), '')
  const { app, page } = await launchMainApp(profile, control)
  const jobCell = name => liveGrid(page, 'Jobs').locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: new RegExp(`^${name}$`) }) }).locator(gridPart.cell).nth(2)
  try {
    await connectFakeServer(app, page)
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Job Activity Monitor')
    await expect(jobCell('Nightly')).toBeVisible()

    // 1. Log File Viewer with Sources rail open and live-searched.
    await jobCell('Nightly').click()
    await chooseJamMoreAction(page, documentFrame(page, 'Job Activity Monitor'), 'View history')
    await expect(documentTab(page, 'Log File Viewer - server-a')).toHaveAttribute('aria-selected', 'true')
    const viewer = documentFrame(page, 'Log File Viewer')
    const runs = liveGrid(page, 'Runs')
    await expect(runs).toContainText('Nightly')
    await runs.locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: /^Nightly$/ }) }).first().locator(gridPart.cell).nth(1).click()
    await expect(viewer.getByRole('region', { name: 'Message details', exact: true })).toContainText('The last step to run was step 2 (Load).')

    const sourcesToggle = viewer.getByRole('button', { name: 'Sources', exact: true })
    await expect(sourcesToggle).toHaveAttribute('aria-pressed', 'true')
    const sources = viewer.getByRole('region', { name: 'Select logs', exact: true })
    await expect(sources).toBeVisible()
    const sourceSearch = sources.getByRole('searchbox', { name: 'Filter jobs and logs', exact: true })
    await sourceSearch.fill('Night')
    await expect(sources.getByRole('checkbox', { name: 'Nightly', exact: true })).toBeVisible()
    await expect(sources.getByRole('checkbox', { name: 'Backup', exact: true })).toHaveCount(0)
    await captureMatrix(app, page, outDir, '01-lfv-sources-open-searched')

    // 2. Log File Viewer with Sources rail collapsed (full-width Runs & Steps/Message).
    await sourceSearch.fill('')
    await sources.getByRole('checkbox', { name: 'All jobs', exact: true }).check()
    await expect(runs).toContainText('Backup')
    await runs.locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: /^Nightly$/ }) }).first().locator(gridPart.cell).nth(1).click()
    await expect(viewer.getByRole('region', { name: 'Message details', exact: true })).toContainText('The last step to run was step 2 (Load).')
    await sourcesToggle.click()
    await expect(sourcesToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(sources).toHaveCount(0)
    await captureMatrix(app, page, outDir, '02-lfv-sources-collapsed')

    // 3. Log File Viewer with Agent Error Log checked and Log row details populated.
    await sourcesToggle.click()
    await expect(sources).toBeVisible()
    await sources.getByRole('checkbox', { name: 'All jobs', exact: true }).uncheck()
    const errorLogs = sources.getByRole('list', { name: 'SQL Server Agent error logs', exact: true })
    await errorLogs.getByRole('checkbox', { name: 'Current - 2026-11-22 14:31', exact: true }).check()
    const agentLog = liveGrid(page, 'Agent log')
    await expect(agentLog).toContainText('Step 2 of job Nightly failed')
    await agentLog.locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: /^Warning$/ }) }).locator(gridPart.cell).nth(1).click()
    await expect(viewer.getByRole('region', { name: 'Log row details', exact: true })).toContainText('SQLServerAgent is running as a non-sysadmin account')
    await captureMatrix(app, page, outDir, '03-lfv-error-log')

    // 4. Schedules Document (DocumentFrame, Switch, Next Run, resized Detail inspector).
    await page.keyboard.press('F1')
    await page.keyboard.type('Manage Schedules')
    await quickInputRows(page).filter({ hasText: 'Manage Schedules' }).first().click()
    await expect(documentTab(page, 'Schedules')).toHaveAttribute('aria-selected', 'true')
    const schedulesFrame = documentFrame(page, 'Schedules')
    const scheduleGrid = schedulesFrame.getByRole('table', { name: 'Schedules', exact: true })
    await scheduleGrid.getByRole('button', { name: 'Nightly 02:30', exact: true }).click()
    const nightlySchedule = schedulesFrame.getByRole('region', { name: 'Schedule Nightly 02:30', exact: true })
    await nightlySchedule.getByLabel('Attach a job', { exact: true }).selectOption({ label: 'Backup' })
    await nightlySchedule.getByRole('button', { name: 'Attach', exact: true }).click()
    await nightlySchedule.getByRole('button', { name: /^Save · 1 change/ }).click()
    await expect(schedulesFrame.getByRole('status').filter({ hasText: 'Saved Nightly 02:30.' })).toBeVisible()
    const detailSash = schedulesFrame.getByRole('separator', { name: 'Resize schedule detail', exact: true })
    await detailSash.focus()
    for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft')
    await expect(detailSash).toHaveAttribute('aria-valuenow', '520')
    await captureMatrix(app, page, outDir, '04-schedules-grid-resized')

    // 5. Schedules Timeline with gridlines & overlap drawer.
    await schedulesFrame.getByRole('radio', { name: 'Timeline', exact: true }).click()
    const timeline = schedulesFrame.getByRole('grid', { name: 'Schedules timeline', exact: true })
    await expect(timeline.getByRole('rowheader', { name: /^Nightly/ })).toBeVisible()
    await expect(timeline.getByRole('rowheader', { name: /^Backup\b/ }).first()).toBeVisible()
    const overlaps = schedulesFrame.getByRole('region', { name: 'Overlaps', exact: true })
    await expect(overlaps).toContainText('Overlap 02:30–02:48: Backup starts once during Nightly.')
    const nightlyLane = timeline.getByRole('gridcell', { name: /^Nightly,/ })
    await nightlyLane.focus()
    await page.keyboard.press('End')
    await captureMatrix(app, page, outDir, '05-schedules-timeline-overlaps')
  } finally {
    await app.close().catch(() => {})
    await rm(control, { recursive: true, force: true }).catch(() => {})
  }
}
