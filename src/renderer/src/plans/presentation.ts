import type { PlanNode } from '../../../shared/plans'
import type { SvgIconId } from '../../../shared/icons'
import { estimatedTotalRows, formatPlanMetric } from './diagnostics'
import type { SourceStatement } from './sources'

export function operatorIcon(operator: string, logical = ''): SvgIconId {
  if (/aggregate/i.test(operator + ' ' + logical)) return 'plan-aggregate'
  if (/join|nested loops|apply|hash match/i.test(operator + ' ' + logical)) return 'plan-join'
  if (/sort/i.test(operator)) return 'plan-sort'
  if (/filter|assert|top|bitmap/i.test(operator)) return 'plan-filter'
  if (/parallel|distribute|repartition|gather/i.test(operator)) return 'plan-parallel'
  if (/seek|lookup/i.test(operator)) return 'key'
  if (/scan|insert|update|delete|merge/i.test(operator)) return 'table'
  if (/compute|constant/i.test(operator)) return 'plan-compute'
  if (/spool/i.test(operator)) return 'database'
  return 'execution-plan'
}

export function rowFlowMetrics(node: PlanNode, partial = false): { kind: 'actual' | 'estimated' | 'partial' | 'unavailable'; value: number | null; total: number | undefined; width: number } {
  const total = estimatedTotalRows(node), estimate = total ?? node.estimatedRows
  const value = partial ? node.actualRows : node.actualRows ?? estimate
  const kind = partial ? 'partial' : node.actualRows !== null ? 'actual' : node.executions !== null || node.cpuMs !== null || node.elapsedMs !== null ? 'unavailable' : estimate !== null ? 'estimated' : 'unavailable'
  return { kind, value, total, width: kind === 'unavailable' || value === null ? 1 : Math.min(6, 1 + Math.log10(1 + value)) }
}

export function rowFlow(node: PlanNode, partial = false): { kind: 'actual' | 'estimated' | 'partial' | 'unavailable'; label: string; width: number } {
  const { kind, value, total, width } = rowFlowMetrics(node, partial)
  const label = kind === 'partial' ? `Live partial ${formatPlanMetric(value)}` : kind === 'actual' ? `Actual ${formatPlanMetric(value)}` : kind === 'estimated' ? `Est. ${formatPlanMetric(value)}` : 'Rows unavailable'
  return { kind, label: label + (kind === 'unavailable' ? '' : kind === 'estimated' && total === undefined ? ' rows/exec' : ' rows'), width }
}

/** Keep models intact. Only the layout projection hides descendants; search and outline still find every operator. */
export function visibleOperators(statements: readonly SourceStatement[], collapsed: ReadonlySet<string>): Set<string> {
  const visible = new Set<string>()
  for (const statement of statements) {
    const children = new Map<string | null, string[]>()
    for (const node of statement.nodes) { const inputs = children.get(node.parentId) ?? []; inputs.push(node.id); children.set(node.parentId, inputs) }
    const stack = [...children.get(null) ?? []]
    while (stack.length) { const id = stack.pop()!; visible.add(id); if (!collapsed.has(id)) for (const child of children.get(id) ?? []) stack.push(child) }
  }
  return visible
}

export function revealAncestors(id: string, parents: ReadonlyMap<string, string | null>, collapsed: ReadonlySet<string>): Set<string> {
  const next = new Set(collapsed), visited = new Set<string>()
  let parent = parents.get(id)
  while (parent && !visited.has(parent)) { visited.add(parent); next.delete(parent); parent = parents.get(parent) }
  return next
}
