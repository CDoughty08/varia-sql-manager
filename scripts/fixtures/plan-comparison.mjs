import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { documentTabs, planCanvas } from './ui.mjs'

/** Two maximum-width views use the real parser/Pixi and leave repeated siblings explicitly ambiguous. */
export async function checkLargeComparison({ application, page, folder, expect }) {
  const path = join(folder, 'comparison-wide-2000.sqlplan')
  const children = Array.from({ length: 1999 }, (_, index) => `<RelOp NodeId="${index + 1}" PhysicalOp="Constant Scan" LogicalOp="Constant Scan" EstimateRows="1"><ConstantScan /></RelOp>`).join('')
  await writeFile(path, `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.6"><BatchSequence><Batch><Statements><StmtSimple StatementId="1" StatementType="SELECT" StatementText="Wide comparison"><QueryPlan><RelOp NodeId="0" PhysicalOp="Concatenation" LogicalOp="Concatenation"><Concat>${children}</Concat></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`)
  await page.getByRole('region', { name: 'Retained plans', exact: true }).getByRole('button', { name: 'Compare plans', exact: true }).click()
  const comparison = page.getByRole('region', { name: 'Plan comparison', exact: true })
  await application.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }) }, path)
  await comparison.getByRole('button', { name: 'Open saved plan…', exact: true }).click()
  await expect(documentTabs(page).getByRole('tab', { selected: true })).toContainText('comparison-wide-2000.sqlplan')
  for (const side of ['Left', 'Right']) await comparison.getByRole('combobox', { name: side + ' comparison input', exact: true }).selectOption({ label: 'Document · comparison-wide-2000.sqlplan' })
  await comparison.getByRole('button', { name: 'Compare selected plans', exact: true }).click()
  await expect(comparison.getByRole('status').filter({ hasText: /paired statements/ })).toContainText('1 paired operators · 3998 ambiguous entries')
  const left = comparison.getByRole('region', { name: 'Left plan view', exact: true }), right = comparison.getByRole('region', { name: 'Right plan view', exact: true })
  for (const view of [left, right]) await expect(planCanvas(view).locator('canvas')).toHaveCount(1)
  await left.getByRole('treeitem').first().click()
  await expect(right.getByRole('treeitem', { selected: true })).toHaveCount(1)
  await left.getByRole('treeitem').nth(1).click()
  await expect(right.getByRole('treeitem', { selected: true })).toHaveCount(0)
  await comparison.getByRole('button', { name: 'Pairing list', exact: true }).click()
  const list = comparison.getByRole('region', { name: 'Operator pairing list', exact: true })
  await expect(list.getByRole('button')).toHaveCount(52)
  await comparison.getByRole('button', { name: 'Pairing list', exact: true }).click()
  await planCanvas(left).hover(); await page.mouse.wheel(0, 300)
  await left.getByRole('button', { name: 'Fit batch', exact: true }).click()
  await comparison.getByRole('button', { name: 'Close comparison', exact: true }).click()
  await expect(comparison).toHaveCount(0)
  console.log('Large comparison: two real 2,000-operator Pixi views; 3,998 ambiguous entries, bounded pairing DOM, linked selection/pan and close.')
}
