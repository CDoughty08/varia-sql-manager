import { expect } from '../fixtures/smoke.mjs'
import { chooseExplorerMenuItem, expandExplorerPath } from '../fixtures/explorer-tree.mjs'
import { documentFrame, documentTab, inspectorTab, quickInputRows } from '../fixtures/ui.mjs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function captureAp5(outDir, profile, { launchMainApp, connectFakeServer, captureMatrix }) {
  const control = await mkdtemp(resolve('artifacts', 'agent-polish-ap5-backend-'))
  await writeFile(resolve(control, 'agent-node'), '')
  await writeFile(resolve(control, 'agent-operator-jobs'), '')
  const { app, page } = await launchMainApp(profile, control)
  try {
    await connectFakeServer(app, page)

    // 1. OperatorsDocument — Alerts Matrix (dirty cell + selected column + ResizableSplit side pane).
    await page.keyboard.press('F1')
    await page.keyboard.type('Operators and Notifications')
    await quickInputRows(page).filter({ hasText: 'Operators and Notifications' }).first().click()
    await expect(documentTab(page, 'Operators and Notifications')).toHaveAttribute('aria-selected', 'true')
    const opsFrame = documentFrame(page, 'Operators and notifications')
    await opsFrame.getByRole('button', { name: 'Severity 017, On Call: not notified', exact: true }).click()
    await expect(opsFrame.getByRole('button', { name: 'Severity 017, On Call: E-mail', exact: true })).toBeVisible()
    await opsFrame.getByRole('button', { name: 'DBA Team', exact: true }).click()
    await expect(opsFrame.getByRole('button', { name: 'Send test e-mail', exact: true })).toBeVisible()
    await captureMatrix(app, page, outDir, '01-operators-matrix')

    // 2. OperatorsDocument — Jobs Notifying Operators tab.
    await inspectorTab(opsFrame, 'Jobs Notifying Operators').click()
    await expect(opsFrame.getByRole('region', { name: 'Jobs that notify operators', exact: true })).toContainText('Nightly')
    await captureMatrix(app, page, outDir, '02-operators-jobs')

    // 3. AlertDocument — Severity 017.
    await expandExplorerPath(page, 'server-a', 'SQL Server Agent', 'Alerts')
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent', 'Alerts', 'Severity 017'], 'Properties')
    await expect(documentTab(page, 'Alert Properties - Severity 017')).toHaveAttribute('aria-selected', 'true')
    const alertFrame = documentFrame(page, 'Severity 017')
    await expect(alertFrame.getByRole('listitem').filter({ hasText: 'DBA Team' })).toBeVisible()
    await captureMatrix(app, page, outDir, '03-alert-document')

    // 4. OperatorDocument — DBA Team.
    await expandExplorerPath(page, 'server-a', 'SQL Server Agent', 'Operators')
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent', 'Operators', 'DBA Team'], 'Properties')
    await expect(documentTab(page, 'Operator Properties - DBA Team')).toHaveAttribute('aria-selected', 'true')
    const operatorFrame = documentFrame(page, 'DBA Team')
    await expect(operatorFrame.getByRole('button', { name: 'Send test e-mail', exact: true })).toBeVisible()
    await captureMatrix(app, page, outDir, '04-operator-document')

    // 5. ProxyDocument — FileShareWriter.
    await expandExplorerPath(page, 'server-a', 'SQL Server Agent', 'Proxies', 'Operating system (CmdExec)')
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent', 'Proxies', 'Operating system (CmdExec)', 'FileShareWriter'], 'Properties')
    await expect(documentTab(page, 'Proxy Account Properties - FileShareWriter')).toHaveAttribute('aria-selected', 'true')
    const proxyFrame = documentFrame(page, 'FileShareWriter')
    await expect(proxyFrame.getByLabel('Description', { exact: true })).toHaveValue('Writes extracts to the file share.')
    await captureMatrix(app, page, outDir, '05-proxy-document')

    // 6. CredentialDocument — FileShareWriterCred.
    await expandExplorerPath(page, 'server-a', 'Security', 'Credentials')
    await chooseExplorerMenuItem(page, ['server-a', 'Security', 'Credentials', 'FileShareWriterCred'], 'Properties')
    await expect(documentTab(page, 'Credential Properties - FileShareWriterCred')).toHaveAttribute('aria-selected', 'true')
    const credFrame = documentFrame(page, 'FileShareWriterCred')
    await expect(credFrame.getByRole('switch', { name: 'Change identity and password', exact: true })).toBeVisible()
    await captureMatrix(app, page, outDir, '06-credential-document')

    // 7. SQL Server Agent Properties modal — General.
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Properties')
    const dialog = page.getByRole('dialog', { name: 'SQL Server Agent Properties', exact: true })
    await expect(dialog.getByText('NT Service\\SQLSERVERAGENT', { exact: true })).toBeVisible()
    await captureMatrix(app, page, outDir, '07-agent-properties-general')

    // 8. SQL Server Agent Properties modal — History (with RatioBar & retention table).
    await dialog.getByRole('button', { name: 'History', exact: true }).click()
    await expect(dialog.getByText('984 / 1,000 rows (98.4%)', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('table', { name: /^What this keeps/ })).toContainText('Nightly')
    await captureMatrix(app, page, outDir, '08-agent-properties-history')

    // Close modal and revert the single dirty cell so app.close() exits cleanly without a save prompt.
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await documentTab(page, 'Operators and Notifications').click()
    await inspectorTab(opsFrame, 'Alerts Matrix').click()
    await opsFrame.getByRole('button', { name: 'Severity 017, On Call: E-mail', exact: true }).click()
    await opsFrame.getByRole('button', { name: 'Severity 017, On Call: E-mail and Pager', exact: true }).click()
    await opsFrame.getByRole('button', { name: 'Severity 017, On Call: Pager', exact: true }).click()
    await expect(opsFrame.getByRole('button', { name: 'Severity 017, On Call: not notified', exact: true })).toBeVisible()
  } finally {
    await app.close().catch(() => {})
    await rm(control, { recursive: true, force: true }).catch(() => {})
  }
}
