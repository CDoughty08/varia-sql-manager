// Live Electron cross-panel DOM/geometry/scroll/sash/interactive probe & consolidated screenshot capture for AP-6.
import { expect } from '../fixtures/smoke.mjs'
import { parseCalls } from '../fixtures/call-log.mjs'
import { chooseExplorerMenuItem, expandExplorerPath } from '../fixtures/explorer-tree.mjs'
import {
  chooseJamMoreAction, closeDocumentButton, documentFrame, documentTab, gridPart, inspectorPanel, inspectorTab, jamToolbar, liveGrid, quickInputRows
} from '../fixtures/ui.mjs'
import { resizeContent } from '../fixtures/window-resize.mjs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Verifies zero unexpected nested vertical scrollers inside `scopeLocator` in live Chromium:
 * ignores Monaco's internal `.monaco-scrollable-element`, and fails if any scrollable element
 * (`overflowY` auto/scroll with `scrollHeight > clientHeight + 2`) sits inside another scrollable ancestor
 * or if `.inspector-pane-fill` / `.document-body` itself overflows vertically.
 */
async function assertNoUnexpectedNestedVerticalScrolls(scopeLocator, label) {
  const offenders = await scopeLocator.evaluate(root => {
    const isScrollableY = el => {
      if (el.scrollHeight <= el.clientHeight + 2) return false
      const style = getComputedStyle(el)
      return style.overflowY === 'auto' || style.overflowY === 'scroll'
    }
    const found = []
    for (const fill of [root, ...root.querySelectorAll('.inspector-pane-fill, .document-body')]) {
      if (fill.matches('.inspector-pane-fill, .document-body') && fill.scrollHeight > fill.clientHeight + 2) {
        const style = getComputedStyle(fill)
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          found.push(`fill/body overflow (${fill.className}): ${fill.scrollHeight} > ${fill.clientHeight}`)
        }
      }
    }
    const all = [root, ...root.querySelectorAll('*')]
    for (const el of all) {
      if (el.closest('.monaco-editor') && el.classList.contains('monaco-scrollable-element')) continue
      if (!isScrollableY(el)) continue
      let parent = el.parentElement
      while (parent && parent !== root.parentElement) {
        if (!(parent.closest('.monaco-editor') && parent.classList.contains('monaco-scrollable-element')) && isScrollableY(parent)) {
          found.push(`${parent.tagName.toLowerCase()}.${parent.className} -> ${el.tagName.toLowerCase()}.${el.className}`)
          break
        }
        parent = parent.parentElement
      }
    }
    return found
  })
  if (offenders.length > 0) throw new Error(`${label} has unexpected nested vertical scrollers: ${offenders.join(' | ')}`)
}

/**
 * Verifies in live Chromium that every visible button with a `.codicon` or `.icon`:
 * - uses a flex/grid display (`inline-flex`, `flex`, `inline-grid`, `grid`)
 * - vertically centers its icon on single-line buttons (excluding intentional flex-start multi-line card buttons)
 * - keeps at least 3px horizontal gap between icon and adjacent visible text when non-empty text exists.
 */
async function assertButtonIconAlignment(scopeLocator, label) {
  const issues = await scopeLocator.evaluate(root => {
    const multilineAllowlist = ['agent-job-vitals-problem', 'agent-schedule-item', 'agent-job-start-choice']
    const problems = []
    const buttons = [...root.querySelectorAll('button')]
    for (const btn of buttons) {
      const btnRect = btn.getBoundingClientRect()
      if (btnRect.width <= 0 || btnRect.height <= 0) continue
      const icon = btn.querySelector(':scope > .codicon, :scope > .icon') ?? btn.querySelector('.codicon, .icon')
      if (!icon) continue
      const iconRect = icon.getBoundingClientRect()
      if (iconRect.width <= 0 || iconRect.height <= 0) continue
      const style = getComputedStyle(btn)
      if (!/^(?:inline-)?(?:flex|grid)$/.test(style.display)) {
        problems.push(`non-flex button "${btn.textContent?.trim() || btn.getAttribute('aria-label') || btn.className}": display=${style.display}`)
        continue
      }
      if (multilineAllowlist.some(cls => btn.classList.contains(cls))) continue

      // Collect visible text bounding rects (skipping .visually-hidden).
      const textRects = []
      const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue
        const el = node.parentElement
        if (el && el.closest('.visually-hidden')) continue
        if (icon.contains(el)) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        const rect = range.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) textRects.push(rect)
      }
      if (textRects.length === 0) continue

      // Check vertical center alignment and horizontal gap when icon & text sit on one horizontal row.
      const textRect = textRects[0]
      const sameRow = Math.abs((iconRect.top + iconRect.height / 2) - (textRect.top + textRect.height / 2)) <= Math.max(iconRect.height, textRect.height)
      if (!sameRow) continue
      const iconCenterY = iconRect.top + iconRect.height / 2
      const textCenterY = textRect.top + textRect.height / 2
      if (Math.abs(iconCenterY - textCenterY) > 3) {
        problems.push(`vertical offset ${Math.abs(iconCenterY - textCenterY).toFixed(1)}px on "${btn.textContent?.trim()}"`)
      }
      const gap = textRect.left >= iconRect.right - 0.5
        ? textRect.left - iconRect.right
        : iconRect.left >= textRect.right - 0.5
          ? iconRect.left - textRect.right
          : 0
      if (gap < 2.5) {
        problems.push(`missing icon gap (${gap.toFixed(1)}px) on "${btn.textContent?.trim()}"`)
      }
    }
    return problems
  })
  if (issues.length > 0) throw new Error(`${label} button-icon alignment issues: ${issues.join(' | ')}`)
}

async function probeBothViewports(app, page, scopeLocator, label) {
  for (const vp of [{ label: '1440x900', width: 1440, height: 900 }, { label: '1080x720', width: 1080, height: 720 }]) {
    await resizeContent(app, page, vp.width, vp.height)
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    await assertNoUnexpectedNestedVerticalScrolls(scopeLocator, `${label} (${vp.label})`)
    await assertButtonIconAlignment(scopeLocator, `${label} (${vp.label})`)
  }
  await resizeContent(app, page, 1440, 900)
}

export async function captureAp6(outDir, profile, { launchMainApp, connectFakeServer, captureMatrix }) {
  const control = await mkdtemp(resolve('artifacts', 'agent-polish-ap6-backend-'))
  await writeFile(resolve(control, 'agent-node'), '')
  await writeFile(resolve(control, 'agent-operator-jobs'), '')
  const { app, page } = await launchMainApp(profile, control)
  const jobCell = name => liveGrid(page, 'Jobs').locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: new RegExp(`^${name}$`) }) }).locator(gridPart.cell).nth(2)
  const calls = async method => parseCalls(await readFile(resolve(control, 'calls.jsonl'), 'utf8').catch(() => '')).filter(call => call.method === method).map(call => call.params)

  try {
    await connectFakeServer(app, page)

    // 1. JobDocument: General, Steps (+ live sash resize & reopen persistence), Schedules, Notifications & Alerts, History.
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Job Activity Monitor')
    await expect(jobCell('Nightly')).toBeVisible()
    await jobCell('Nightly').dblclick()
    await expect(documentTab(page, 'Job Properties - Nightly')).toHaveAttribute('aria-selected', 'true')
    const job = documentFrame(page, 'Nightly')
    await probeBothViewports(app, page, job, '01-job-document-general')
    await captureMatrix(app, page, outDir, '01-job-document-general')

    await inspectorTab(job, 'Steps').click()
    const stepsSash = job.getByRole('separator', { name: 'Resize steps list', exact: true })
    await stepsSash.focus()
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
    await expect(stepsSash).toHaveAttribute('aria-valuenow', '340')
    await probeBothViewports(app, page, job, '02-job-document-steps')
    await captureMatrix(app, page, outDir, '02-job-document-steps')

    await inspectorTab(job, 'Schedules').click()
    await expect(job.getByRole('button', { name: /Nightly 02:30/ })).toBeVisible()
    await probeBothViewports(app, page, inspectorPanel(job), 'probe-job-schedules')

    await inspectorTab(job, 'Notifications & Alerts').click()
    await expect(job.getByRole('table', { name: 'Alerts that run this job', exact: true })).toContainText('Nightly failed')
    await probeBothViewports(app, page, inspectorPanel(job), 'probe-job-notifications')

    await inspectorTab(job, 'History').click()
    const history = inspectorPanel(job)
    await expect(history.getByRole('region', { name: 'Step 2 message', exact: true })).toContainText('Violation of PRIMARY KEY constraint.')
    await probeBothViewports(app, page, job, '03-job-document-history')
    await captureMatrix(app, page, outDir, '03-job-document-history')

    // Verify live sash persistence across close & reopen of JobDocument!
    await closeDocumentButton(page, 'Job Properties - Nightly').click()
    await expect(documentTab(page, 'Job Properties - Nightly')).toHaveCount(0)
    await documentTab(page, 'Job Activity Monitor - server-a').click()
    await jobCell('Backup').click()
    await jobCell('Nightly').click()
    await expect(jamToolbar(documentFrame(page, 'Job Activity Monitor'))).toContainText('1 job selected')
    await page.keyboard.press('Enter')
    await expect(documentTab(page, 'Job Properties - Nightly')).toHaveAttribute('aria-selected', 'true')
    const reopenedJob = documentFrame(page, 'Nightly')
    await inspectorTab(reopenedJob, 'Steps').click()
    await expect(reopenedJob.getByRole('separator', { name: 'Resize steps list', exact: true })).toHaveAttribute('aria-valuenow', '340')

    // 2. Job Activity Monitor + Last Run split drawer (live sash resize + persistence).
    await documentTab(page, 'Job Activity Monitor - server-a').click()
    const jam = documentFrame(page, 'Job Activity Monitor')
    await jobCell('Nightly').click()
    await jamToolbar(jam).getByRole('button', { name: 'Last run', exact: true }).click()
    const lastRun = jam.getByRole('region', { name: 'Last run of Nightly', exact: true })
    await expect(lastRun.getByRole('region', { name: 'Step message preview', exact: true })).toContainText('Executed as user: sa.')
    const jamSash = lastRun.getByRole('separator', { name: 'Resize last run message', exact: true })
    await jamSash.focus()
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
    await expect(jamSash).toHaveAttribute('aria-valuenow', '476')
    await probeBothViewports(app, page, jam, '04-jam-last-run')
    await captureMatrix(app, page, outDir, '04-jam-last-run')

    // Reopen JAM tab / toggle Last run to verify persisted sash restores.
    await jamToolbar(jam).getByRole('button', { name: 'Last run', exact: true }).click()
    await jamToolbar(jam).getByRole('button', { name: 'Last run', exact: true }).click()
    await expect(jam.getByRole('separator', { name: 'Resize last run message', exact: true })).toHaveAttribute('aria-valuenow', '476')

    // 3. Agent Overview.
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Agent Overview')
    await expect(documentTab(page, 'Agent Overview - server-a')).toHaveAttribute('aria-selected', 'true')
    const overview = documentFrame(page, 'SQL Server Agent')
    await expect(overview.getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible()
    await probeBothViewports(app, page, overview, '05-agent-overview')
    await captureMatrix(app, page, outDir, '05-agent-overview')

    // 4. Log File Viewer (Sources rail + Message details split, resize + reopen).
    await documentTab(page, 'Job Activity Monitor - server-a').click()
    await jobCell('Nightly').click()
    await chooseJamMoreAction(page, jam, 'View history')
    await expect(documentTab(page, 'Log File Viewer - server-a')).toHaveAttribute('aria-selected', 'true')
    const viewer = documentFrame(page, 'Log File Viewer')
    const runs = liveGrid(page, 'Runs')
    await expect(runs).toContainText('Nightly')
    await runs.locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: /^Nightly$/ }) }).first().locator(gridPart.cell).nth(1).click()
    await expect(viewer.getByRole('region', { name: 'Message details', exact: true })).toContainText('The last step to run was step 2 (Load).')
    const lfvSash = viewer.getByRole('separator', { name: 'Resize Select logs', exact: true })
    await lfvSash.focus()
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight')
    await expect(lfvSash).toHaveAttribute('aria-valuenow', '260')
    await probeBothViewports(app, page, viewer, '06-log-file-viewer')
    await captureMatrix(app, page, outDir, '06-log-file-viewer')

    await closeDocumentButton(page, 'Log File Viewer - server-a').click()
    await documentTab(page, 'Job Activity Monitor - server-a').click()
    await chooseJamMoreAction(page, jam, 'View history')
    await expect(documentTab(page, 'Log File Viewer - server-a')).toHaveAttribute('aria-selected', 'true')
    await expect(documentFrame(page, 'Log File Viewer').getByRole('separator', { name: 'Resize Select logs', exact: true })).toHaveAttribute('aria-valuenow', '260')

    // 5. Schedules Document (Grid + Detail sash + Timeline).
    await page.keyboard.press('F1')
    await page.keyboard.type('Manage Schedules')
    await quickInputRows(page).filter({ hasText: 'Manage Schedules' }).first().click()
    await expect(documentTab(page, 'Schedules')).toHaveAttribute('aria-selected', 'true')
    const schedulesFrame = documentFrame(page, 'Schedules')
    await schedulesFrame.getByRole('table', { name: 'Schedules', exact: true }).getByRole('button', { name: 'Nightly 02:30', exact: true }).click()
    const schedSash = schedulesFrame.getByRole('separator', { name: 'Resize schedule detail', exact: true })
    await schedSash.focus()
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowLeft')
    await expect(schedSash).toHaveAttribute('aria-valuenow', '496')
    await probeBothViewports(app, page, schedulesFrame, '07-schedules-grid')
    await captureMatrix(app, page, outDir, '07-schedules-grid')

    await schedulesFrame.getByRole('radio', { name: 'Timeline', exact: true }).click()
    await expect(schedulesFrame.getByRole('grid', { name: 'Schedules timeline', exact: true })).toBeVisible()
    await probeBothViewports(app, page, schedulesFrame, '08-schedules-timeline')
    await captureMatrix(app, page, outDir, '08-schedules-timeline')

    // 6. OperatorsDocument + Alert/Operator/Proxy/Credential probes.
    await page.keyboard.press('F1')
    await page.keyboard.type('Operators and Notifications')
    await quickInputRows(page).filter({ hasText: 'Operators and Notifications' }).first().click()
    await expect(documentTab(page, 'Operators and Notifications')).toHaveAttribute('aria-selected', 'true')
    const opsFrame = documentFrame(page, 'Operators and notifications')
    await opsFrame.getByRole('button', { name: 'DBA Team', exact: true }).click()
    const opsSash = opsFrame.getByRole('separator', { name: 'Resize selected operator rail', exact: true })
    await opsSash.focus()
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowLeft')
    await expect(opsSash).toHaveAttribute('aria-valuenow', '288')
    await probeBothViewports(app, page, opsFrame, '09-operators-matrix')
    await captureMatrix(app, page, outDir, '09-operators-matrix')

    await inspectorTab(opsFrame, 'Jobs Notifying Operators').click()
    await probeBothViewports(app, page, opsFrame, 'probe-operators-jobs')

    // Probe AlertDocument, OperatorDocument, ProxyDocument, CredentialDocument across both viewports.
    await expandExplorerPath(page, 'server-a', 'SQL Server Agent', 'Alerts')
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent', 'Alerts', 'Severity 017'], 'Properties')
    await probeBothViewports(app, page, documentFrame(page, 'Severity 017'), 'probe-alert-document')

    await expandExplorerPath(page, 'server-a', 'SQL Server Agent', 'Operators')
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent', 'Operators', 'DBA Team'], 'Properties')
    const operatorDoc = documentFrame(page, 'DBA Team')
    await probeBothViewports(app, page, operatorDoc, 'probe-operator-document-general')
    await inspectorTab(operatorDoc, 'Pager duty').click()
    await probeBothViewports(app, page, operatorDoc, 'probe-operator-document-duty')
    await inspectorTab(operatorDoc, 'Notifications').click()
    await probeBothViewports(app, page, operatorDoc, 'probe-operator-document-notifications')

    await expandExplorerPath(page, 'server-a', 'SQL Server Agent', 'Proxies', 'Operating system (CmdExec)')
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent', 'Proxies', 'Operating system (CmdExec)', 'FileShareWriter'], 'Properties')
    const proxyDoc = documentFrame(page, 'FileShareWriter')
    await probeBothViewports(app, page, proxyDoc, 'probe-proxy-document-general')
    await inspectorTab(proxyDoc, 'Principals').click()
    await probeBothViewports(app, page, proxyDoc, 'probe-proxy-document-principals')
    await inspectorTab(proxyDoc, 'References').click()
    await probeBothViewports(app, page, proxyDoc, 'probe-proxy-document-references')

    await expandExplorerPath(page, 'server-a', 'Security', 'Credentials')
    await chooseExplorerMenuItem(page, ['server-a', 'Security', 'Credentials', 'FileShareWriterCred'], 'Properties')
    const credDoc = documentFrame(page, 'FileShareWriterCred')
    await probeBothViewports(app, page, credDoc, 'probe-credential-document-general')
    await inspectorTab(credDoc, 'Used by').click()
    await probeBothViewports(app, page, credDoc, 'probe-credential-document-used-by')

    // 7. Interactive clipboard-free AgentPropertiesPages verification + final screenshot.
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Properties')
    const dialog = page.getByRole('dialog', { name: 'SQL Server Agent Properties', exact: true })
    await expect(dialog.getByText('NT Service\\SQLSERVERAGENT', { exact: true })).toBeVisible()
    await probeBothViewports(app, page, dialog, 'probe-agent-properties-general')

    const agentRestart = dialog.getByRole('switch', { name: 'Auto restart SQL Server Agent if it stops unexpectedly', exact: true })
    await expect(agentRestart).toBeChecked()
    await agentRestart.uncheck()

    await dialog.getByRole('button', { name: 'History', exact: true }).click()
    await expect(dialog.getByText('984 / 1,000 rows (98.4%)', { exact: true })).toBeVisible()
    const retention = dialog.getByRole('table', { name: /^What this keeps/ })
    await expect(retention.getByRole('row')).toHaveCount(4)
    await expect(retention.getByRole('row', { name: /Nightly/ })).toContainText('a day')

    // Trigger inline purge confirmation via Enter, verify Cancel focused, execute purge, verify calls.jsonl.
    await dialog.getByRole('textbox', { name: 'Older than', exact: true }).press('Enter')
    const purgeConfirm = dialog.getByRole('group', { name: 'Confirm Delete old history now', exact: true })
    await expect(purgeConfirm).toBeVisible()
    await expect(purgeConfirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await purgeConfirm.getByRole('button', { name: 'Delete history', exact: true }).click()
    await expect(dialog.getByRole('status').filter({ hasText: 'Deleted the history.' })).toContainText('400 history entries purged.')
    expect((await calls('actions.execute')).at(-1)).toMatchObject({ action: 'agentProperties', target: { kind: 'agent' }, agentPurge: { count: 4, unit: 2 } })

    // Switch back to General, confirm switch preserved, submit OK, and verify agentProperties payload.
    await dialog.getByRole('button', { name: 'General', exact: true }).click()
    await expect(agentRestart).not.toBeChecked()
    await dialog.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect((await calls('actions.execute')).at(-1)).toEqual(expect.objectContaining({ action: 'agentProperties', agentProperties: { monitorAutostart: false } }))

    // Reopen Agent Properties cleanly on History for the final 10-agent-properties screenshot strip.
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Properties')
    await dialog.getByRole('button', { name: 'History', exact: true }).click()
    await expect(dialog.getByText('984 / 1,000 rows (98.4%)', { exact: true })).toBeVisible()
    await probeBothViewports(app, page, dialog, '10-agent-properties')
    await captureMatrix(app, page, outDir, '10-agent-properties')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // Probe CreateSeveral at both viewports and create the 1 copy row so the tab closes cleanly with zero prompt.
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Job Activity Monitor')
    await expect(documentTab(page, 'Job Activity Monitor - server-a')).toHaveAttribute('aria-selected', 'true')
    await jobCell('Backup').click()
    await jobCell('Nightly').click()
    await expect(jamToolbar(documentFrame(page, 'Job Activity Monitor'))).toContainText('1 job selected')
    await chooseJamMoreAction(page, documentFrame(page, 'Job Activity Monitor'), 'Create Job Like This…')
    await documentFrame(page, 'Copy of Nightly').getByRole('button', { name: 'Create several…', exact: true }).click()
    const several = documentFrame(page, 'Create several jobs')
    await expect(documentTab(page, 'Create several jobs')).toHaveAttribute('aria-selected', 'true')
    await probeBothViewports(app, page, several, 'probe-create-several')
    await several.getByRole('toolbar', { name: 'Create several', exact: true }).getByRole('button', { name: 'Review and create 1 job', exact: true }).click()
    await several.getByRole('button', { name: 'Create 1 job', exact: true }).click()
    await expect(several.getByRole('status').filter({ hasText: /Done: 1 job created/ })).toBeVisible()
    await closeDocumentButton(page, 'Create several jobs').click()
    await expect(documentTab(page, 'Create several jobs')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
    await rm(control, { recursive: true, force: true }).catch(() => {})
  }
}
