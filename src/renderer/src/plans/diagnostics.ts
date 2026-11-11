import type { PlanNode } from '../../../shared/plans'

const metricFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 })
export function formatPlanMetric(value: number | null | undefined): string {
  if (value == null) return 'Unavailable'
  // Deltas are signed: a tiny negative must not round to "-0", and a true zero stays a plain 0.
  const magnitude = Math.abs(value)
  return magnitude > 0 && magnitude < 0.0001 ? value.toExponential(2) : metricFormat.format(magnitude === 0 ? 0 : value)
}

/** Compare like scopes: total observed rows vs optimizer rows × optimizer executions.
 * ActualExecutions sums workers and must never multiply a global cardinality estimate. */
export function estimatedTotalRows(node: PlanNode): number | undefined {
  const executions = node.diagnostics?.estimatedExecutions
  if (node.estimatedRows === null || executions == null) return
  const expected = node.estimatedRows * executions
  return Number.isFinite(expected) ? expected : undefined
}
export function rowComparison(node: PlanNode): { estimatedTotal: number; factor: number; direction: string } | undefined {
  const expected = estimatedTotalRows(node), actual = node.actualRows
  if (expected === undefined || actual === null) return
  const factor = actual === expected ? 1 : Math.min(actual, expected) === 0 ? Infinity : Math.max(actual, expected) / Math.min(actual, expected)
  return { estimatedTotal: expected, factor, direction: actual > expected ? 'underestimate' : actual < expected ? 'overestimate' : 'match' }
}
export function discrepancyLabel(node: PlanNode): string {
  const comparison = rowComparison(node)
  return comparison ? `${comparison.factor === Infinity ? '∞' : formatPlanMetric(comparison.factor)}× ${comparison.direction}` : 'Unavailable'
}
export type OperatorRanking = 'plan' | 'cpu' | 'elapsed' | 'rows'
export function rankingValue(node: PlanNode, ranking: OperatorRanking): number | undefined {
  return ranking === 'cpu' ? node.cpuMs ?? undefined : ranking === 'elapsed' ? node.elapsedMs ?? undefined : ranking === 'rows' ? rowComparison(node)?.factor : undefined
}
export function rankOperators<T extends { node: PlanNode }>(matches: readonly T[], ranking: OperatorRanking): T[] {
  if (ranking === 'plan') return [...matches]
  // Stable ties preserve plan order. Missing metrics are excluded; measured zeros are retained.
  return matches.filter(match => rankingValue(match.node, ranking) !== undefined).toSorted((a, b) => {
    const first = rankingValue(a.node, ranking)!, second = rankingValue(b.node, ranking)!
    return first === second ? 0 : first > second ? -1 : 1
  })
}
