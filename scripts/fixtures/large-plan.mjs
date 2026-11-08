// A representative wide Showplan document, opened through File > Open against the real parser and GPU canvas.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { documentTabs, planCanvas, planViewer } from './ui.mjs'

export async function checkLargePlan({ application, page, profile, expect }) {
  const path = join(profile, 'wide-2000.sqlplan')
  const inputs = Array.from({ length: 1999 }, (_, index) => `<RelOp NodeId="${index + 1}" PhysicalOp="Constant Scan" LogicalOp="Constant Scan" EstimateRows="1"><ConstantScan /></RelOp>`).join('')
  await writeFile(path, `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.6"><BatchSequence><Batch><Statements><StmtSimple StatementId="1" StatementType="SELECT" StatementText="Wide plan layout check"><QueryPlan><RelOp NodeId="0" PhysicalOp="Concatenation" LogicalOp="Concatenation"><Concat>${inputs}</Concat></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`)
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
  await page.keyboard.press('Control+O')
  const tab = documentTabs(page).getByRole('tab').filter({ hasText: 'wide-2000.sqlplan' })
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  const viewer = planViewer(page), canvas = planCanvas(page)
  const summary = viewer.getByRole('complementary', { name: 'Plan outline', exact: true }).getByRole('status')
  await expect(canvas.locator('canvas')).toHaveCount(1)
  await expect(summary).toHaveText('2000 operators')
  await viewer.getByRole('button', { name: 'Reset plan zoom to 100%', exact: true }).click()
  await viewer.getByRole('treeitem').filter({ hasText: 'Concatenation' }).click()
  await expect(viewer.getByRole('complementary', { name: 'Plan properties' })).toContainText('Concatenation')
  // Pan across changing visible sets, then zoom back out to the full wide statement.
  await canvas.hover()
  for (let frame = 0; frame < 12; frame++) await page.mouse.wheel(0, frame % 2 ? -180 : 320)
  await viewer.getByRole('button', { name: 'Fit batch', exact: true }).click()
  await page.getByRole('button', { name: 'XML source', exact: true }).click()
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await expect(canvas.locator('canvas')).toHaveCount(1)
  await expect(summary).toHaveText('2000 operators')
  await expect(viewer.getByRole('treeitem').filter({ hasText: 'Concatenation' })).toHaveAttribute('aria-selected', 'true')
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await canvas.focus(); await page.keyboard.press('Control+W')
  console.log('Large plan: real parser and Pixi render 2,000 ordered operators; panning, Graph/XML and selection survive.')
}
