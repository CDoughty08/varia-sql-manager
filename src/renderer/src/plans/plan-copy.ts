import type { PlanNode } from '../../../shared/plans'
import { localTableCopyText, type LocalColumn, type LocalTableData } from '../../../shared/results/local-table'
import { formatPlanMetric } from './diagnostics'
import { rowFlow } from './presentation'

/** The columns a plan outline row copies as: what the row shows, its cost and its rows. */
export const outlineCopyColumns: readonly LocalColumn[] = [{ name: 'Operator' }, { name: 'Object' }, { name: 'Estimated subtree cost', kind: 'number' }, { name: 'Rows' }]

/** Outline rows as a local table, each value as the plan viewer shows it. */
export function outlineCopyTable(rows: readonly { readonly node: PlanNode; readonly partial: boolean }[]): LocalTableData {
  return { columns: outlineCopyColumns, rows: rows.map(({ node, partial }) => [node.physicalOp, node.object, formatPlanMetric(node.estimatedCost), rowFlow(node, partial).label]) }
}

/** Copy of outline rows, tab-separated through the results text writer, after a header line when `headers`. */
export const outlineCopyText = (rows: readonly { readonly node: PlanNode; readonly partial: boolean }[], o: { headers: boolean; crlf: boolean }) => localTableCopyText(outlineCopyTable(rows), o)

/** Copy of plan properties: `Name<TAB>Value` lines, or with `values` the values alone, one a line, as a grid copies them. */
export function propertiesCopyText(facts: readonly (readonly [name: string, value: string])[], o: { values: boolean; crlf: boolean }): Promise<string> {
  const table: LocalTableData = o.values ? { columns: [{ name: 'Value' }], rows: facts.map(([, value]) => [value]) } : { columns: [{ name: 'Name' }, { name: 'Value' }], rows: facts.map(([name, value]) => [name, value]) }
  return localTableCopyText(table, { headers: false, crlf: o.crlf })
}
