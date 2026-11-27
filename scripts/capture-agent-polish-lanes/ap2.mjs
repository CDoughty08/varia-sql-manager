import { chooseExplorerMenuItem } from '../fixtures/explorer-tree.mjs'
import {
  documentFrame, documentTab, gridPart, inspectorPanel, inspectorTab, liveGrid, stepCardFlowGeometry
} from '../fixtures/ui.mjs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Verifies no unexpected nested vertical scroller exists inside the active inspector tab panel or Create several frame:
 * only intentional scrollable regions (listbox, tree, pre/monaco, schedule/step detail, table scroll, vitals body) may scroll.
 */
async function assertNoUnexpectedNestedVerticalScrolls(page, scopeLocator, label) {
  const nested = await scopeLocator.evaluate(root => {
    const isScrollableY = el => {
      if (el.scrollHeight <= el.clientHeight + 2) return false
      const style = getComputedStyle(el)
      return style.overflowY === 'auto' || style.overflowY === 'scroll'
    }
    const offenders = []
    const all = [root, ...root.querySelectorAll('*')]
    for (const el of all) {
      if (!isScrollableY(el)) continue
      let parent = el.parentElement
      while (parent && parent !== root.parentElement) {
        if (isScrollableY(parent)) {
          offenders.push(`${parent.tagName.toLowerCase()}.${parent.className} -> ${el.tagName.toLowerCase()}.${el.className}`)
          break
        }
        parent = parent.parentElement
      }
    }
    return offenders
  })
  if (nested.length > 0) throw new Error(`${label} has nested vertical scrollers: ${nested.join(' | ')}`)
}

export async function captureAp2({ outDir, profile, launchMainApp, connectFakeServer, captureMatrix, expect }) {
  const control = await mkdtemp(resolve('artifacts', 'agent-polish-ap2-backend-'))
  await writeFile(resolve(control, 'agent-node'), '')
  const { app, page } = await launchMainApp(profile, control)
  const jobCell = name => liveGrid(page, 'Jobs')
    .locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: new RegExp(`^${name}$`) }) })
    .locator(gridPart.cell)
    .nth(2)

  let closed = false
  try {
    await connectFakeServer(app, page)
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Job Activity Monitor')
    await expect(jobCell('Nightly')).toBeVisible()

    // Open Nightly Job Document on ObjectInspectorFrame.
    await jobCell('Nightly').dblclick()
    await expect(documentTab(page, 'Job Properties - Nightly')).toHaveAttribute('aria-selected', 'true')
    const job = documentFrame(page, 'Nightly')
    await expect(job.getByLabel('Description', { exact: true })).toHaveValue('Nightly maintenance.')

    // 1. General tab + Vitals rail (272px default).
    const vitals = job.getByRole('complementary', { name: 'Vitals', exact: true })
    if (!await vitals.isVisible().catch(() => false)) {
      await job.getByRole('button', { name: 'Show Vitals panel', exact: true }).click()
    }
    await expect(vitals).toBeVisible()
    await assertNoUnexpectedNestedVerticalScrolls(page, inspectorPanel(job), '01-job-general')
    await captureMatrix(app, page, outDir, '01-job-general')

    // 2. Steps tab: mixed TSQL/SSIS/PowerShell balanced 3-col cards + resized rail.
    await inspectorTab(job, 'Steps').click()
    const list = job.getByRole('listbox', { name: 'Steps', exact: true })
    await expect(list.getByRole('option')).toHaveCount(3)

    await list.getByRole('option', { name: /Rebuild indexes/ }).click()
    await job.getByRole('group', { name: 'Step 2: Rebuild indexes', exact: true }).getByRole('radio', { name: 'SSIS package', exact: true }).click()
    await list.getByRole('option', { name: /Update statistics/ }).click()
    await job.getByRole('group', { name: 'Step 3: Update statistics', exact: true }).getByRole('radio', { name: 'PowerShell', exact: true }).click()
    await list.getByRole('option', { name: /Check integrity/ }).click()

    const geo = await stepCardFlowGeometry(list)
    expect(geo.map(row => row.typeText)).toEqual(['TSQL', 'SSIS', 'PS'])
    expect([...new Set(geo.map(row => row.typeWidth))]).toEqual([44])
    expect(new Set(geo.map(row => row.okX)).size).toBe(1)
    expect(new Set(geo.map(row => row.badX)).size).toBe(1)

    const stepsSash = job.getByRole('separator', { name: 'Resize steps list', exact: true })
    const beforeNow = Number(await stepsSash.getAttribute('aria-valuenow'))
    const box = await stepsSash.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 48, box.y + box.height / 2, { steps: 6 })
    await page.mouse.up()
    await expect.poll(async () => Number(await stepsSash.getAttribute('aria-valuenow'))).toBeGreaterThan(beforeNow)
    await assertNoUnexpectedNestedVerticalScrolls(page, inspectorPanel(job), '02-job-steps')
    await captureMatrix(app, page, outDir, '02-job-steps')

    // Reload Nightly so subsequent tabs render clean state while keeping persisted sash width.
    await job.getByRole('group', { name: 'Nightly actions', exact: true }).getByRole('button', { name: 'Reload', exact: true }).click()
    await expect(job.getByRole('group', { name: 'Nightly actions', exact: true }).getByRole('button', { name: 'Save', exact: true })).toBeVisible()

    // 3. Schedules tab (Nightly 02:30 selected).
    await inspectorTab(job, 'Schedules').click()
    const nightlyScheduleButton = job.getByRole('button', { name: /Nightly 02:30/ })
    await expect(nightlyScheduleButton).toBeVisible()
    await nightlyScheduleButton.click()
    await expect(job.getByLabel('Name', { exact: true })).toHaveValue('Nightly 02:30')
    await assertNoUnexpectedNestedVerticalScrolls(page, inspectorPanel(job), '03-job-schedules')
    await captureMatrix(app, page, outDir, '03-job-schedules')

    // 4. Notifications & Alerts tab (DBA Team + Nightly failed alert visible).
    await inspectorTab(job, 'Notifications & Alerts').click()
    await expect(job.getByRole('table', { name: 'Alerts that run this job', exact: true })).toContainText('Nightly failed')
    await assertNoUnexpectedNestedVerticalScrolls(page, inspectorPanel(job), '04-job-notifications-alerts')
    await captureMatrix(app, page, outDir, '04-job-notifications-alerts')

    // 5. History tab (newest failed run auto-selected, failed step 2 Load + SSIS execution 48213 link visible).
    await inspectorTab(job, 'History').click()
    const history = inspectorPanel(job)
    await expect(history.getByRole('region', { name: 'Step 2 message', exact: true })).toContainText('Violation of PRIMARY KEY constraint.')
    await expect(history.getByRole('button', { name: 'SSIS execution 48213', exact: true })).toBeVisible()
    await assertNoUnexpectedNestedVerticalScrolls(page, history, '05-job-history')
    await captureMatrix(app, page, outDir, '05-job-history')

    // 6. Create several (full-height fill table + selected row details).
    await documentTab(page, 'Job Activity Monitor - server-a').click()
    await jobCell('Nightly').click()
    await page.getByRole('toolbar', { name: 'Selected jobs', exact: true }).getByRole('button', { name: 'Create Job Like This…', exact: true }).click()
    await documentFrame(page, 'Copy of Nightly').getByRole('button', { name: 'Create several…', exact: true }).click()
    const several = documentFrame(page, 'Create several jobs')
    await expect(documentTab(page, 'Create several jobs')).toHaveAttribute('aria-selected', 'true')
    const severalBar = several.getByRole('toolbar', { name: 'Create several', exact: true })
    await severalBar.getByRole('button', { name: 'Paste rows…', exact: true }).click()
    await several.getByRole('group', { name: 'Paste rows', exact: true }).getByRole('textbox').fill('Nightly HR\nNightly Payroll\n')
    await several.getByRole('button', { name: 'Add 2 rows', exact: true }).click()
    await several.getByRole('table', { name: 'Jobs to create', exact: true }).getByRole('button', { name: 'Row 2', exact: true }).click()
    await assertNoUnexpectedNestedVerticalScrolls(page, several, '06-job-create-several')
    await captureMatrix(app, page, outDir, '06-job-create-several')

    // Clean the Create several draft so app.close() exits without an interactive save prompt.
    await severalBar.getByRole('button', { name: 'Review and create 3 jobs', exact: true }).click()
    await several.getByRole('button', { name: 'Create 3 jobs', exact: true }).click()
    await expect(several.getByRole('status').filter({ hasText: /Done: 3 jobs created/ })).toBeVisible()

    await app.close()
    closed = true
  } finally {
    if (!closed) await app.close().catch(() => app.process()?.kill())
    await rm(control, { recursive: true, force: true }).catch(() => {})
  }
}
