// The plan comparison's Differences tables as local tables (LocalGrid): the rows as the grid shows, copies and saves them.
import type { PlanNode, PlanStatement } from '../../../shared/plans'
import type { LocalTableData } from '../../../shared/results/local-table'
import { estimatedTotalRows, formatPlanMetric } from './diagnostics'
import { metricDelta, propertyDifferences, type ComparedProperty } from './comparison'

type Property = ComparedProperty
type Row = readonly [name: string, left: string, right: string, change: string]
const absent = 'Unavailable'
/** A long value is shortened for display, with a note that fits inside a local table's cell (4,000 characters). */
const shown = 3_800
const display = (value: string | undefined) => value === undefined ? absent : value === '' ? '(empty value)' : value.length > shown ? value.slice(0, shown) + ' [shortened in comparison; inspect frozen XML]' : value
const signed = (value: number) => (value > 0 ? '+' : '') + formatPlanMetric(value)
function numeric(name: string, left?: number | null, right?: number | null): Row {
  const delta = metricDelta(left, right)
  return [name, formatPlanMetric(delta.left), formatPlanMetric(delta.right),
    delta.absolute === undefined ? absent : `${signed(delta.absolute)} (${delta.zeroBaseline ? 'zero baseline' : delta.percent === undefined ? 'percentage unavailable' : signed(delta.percent) + '%'})`]
}
const textRows = (left?: readonly Property[], right?: readonly Property[]): Row[] => propertyDifferences(left, right).map(row => [row.name, display(row.left), display(row.right),
  row.left === undefined && row.right === undefined ? 'Unavailable on both sides' : row.changed ? 'Changed / availability differs' : row.unverified ? 'Retained text agrees; shortened by the parser, equality unverified (inspect frozen XML)' : 'Same'])
const structured = (value: unknown) => value === undefined ? undefined : Array.isArray(value) && !value.length ? 'None reported' : JSON.stringify(value)
/** The parser flags the owner, not the field. Within a flagged owner a list may have lost entries, and a single value was
 * cut when it ends with the parser's ellipsis or was emptied by an exhausted budget; other single values are complete. */
const partial = (facts: (Property & { list?: boolean })[], flagged: boolean | undefined): Property[] => facts.map(({ list, ...fact }) =>
  flagged && (list || fact.value === '' || fact.value?.endsWith('…')) ? { ...fact, partial: true } : fact)
const nodeFacts = (node?: PlanNode): Property[] => node ? [
  ...partial([{ name: 'Physical operator', value: node.physicalOp }, { name: 'Logical operator', value: node.logicalOp }, { name: 'Object', value: node.object }], node.identityShortened),
  ...partial([{ name: 'Warnings', value: structured(node.warnings)!, list: true }, ...node.properties.filter(p => p.name !== 'RelOp.NodeId').map(p => ({ ...p, name: 'Property · ' + p.name })),
  ...node.diagnostics ? [
    { name: 'Parallel', value: node.diagnostics.parallel === null ? undefined : String(node.diagnostics.parallel) },
    { name: 'Estimated execution mode', value: node.diagnostics.estimatedExecutionMode || undefined },
    { name: 'Predicates', value: structured(node.diagnostics.predicates)!, list: true }, { name: 'Output columns', value: structured(node.diagnostics.outputColumns)!, list: true },
    { name: 'Warning attributes', value: structured(node.diagnostics.warnings)!, list: true }, { name: 'Spills', value: structured(node.diagnostics.spills)!, list: true },
    { name: 'Per-thread entries (source order; repeated thread IDs remain separate)', value: node.diagnostics.runtimeDetailsAvailable ? structured(node.diagnostics.threads)! : absent, list: true }
  ] : []], node.detailsShortened)
] : []
const statementFacts = (statement?: PlanStatement): Property[] => statement ? [
  { name: 'Statement text', value: statement.text, partial: statement.textShortened }, ...partial([{ name: 'Warnings', value: structured(statement.warnings)!, list: true },
  { name: 'Memory grant availability', value: statement.diagnostics?.memoryGrant.length ? 'Reported attributes (subject to omission notices)' : undefined, list: true },
  { name: 'Parameter availability', value: statement.diagnostics?.parameters.length ? `${statement.diagnostics.parameters.length} reported entries (subject to omission notices)` : undefined, list: true },
  ...statement.diagnostics ? [
    { name: 'Warning attributes', value: structured(statement.diagnostics.warnings)!, list: true },
    { name: 'Missing indexes (optimizer suggestions)', value: structured(statement.diagnostics.missingIndexes)!, list: true },
    ...statement.diagnostics.parameters.flatMap(parameter => [
      { name: `Parameter ${parameter.name} · type`, value: parameter.dataType },
      { name: `Parameter ${parameter.name} · compiled`, value: parameter.compiledValue ?? undefined },
      { name: `Parameter ${parameter.name} · runtime`, value: parameter.runtimeValue ?? undefined }
    ])
  ] : []], statement.detailsShortened)
] : []
const memoryKiB = new Set(['SerialRequiredMemory', 'SerialDesiredMemory', 'RequiredMemory', 'DesiredMemory', 'RequestedMemory', 'GrantedMemory', 'MaxUsedMemory', 'MaxQueryMemory', 'LastRequestedMemory'])
const grantNumber = (value?: string) => value !== undefined && value.trim() && /^\d+(\.\d+)?$/.test(value) ? Number(value) : undefined
const grants = (left?: readonly Property[], right?: readonly Property[]): Row[] => propertyDifferences(left, right).flatMap(row => {
  const unit = row.name === 'GrantWaitTime' ? 'ms' : memoryKiB.has(row.name) ? 'KiB' : undefined
  if (unit) return [numeric(`Memory grant · ${row.name} (${unit})`, grantNumber(row.left), grantNumber(row.right))]
  const side = (value?: string): Property[] => value === undefined ? [] : [{ name: 'Memory grant · ' + row.name, value, partial: row.unverified }]
  return textRows(side(row.left), side(row.right))
})
const table = (first: string, rows: readonly Row[]): LocalTableData => ({ columns: [{ name: first }, { name: 'Left' }, { name: 'Right' }, { name: 'Delta / change' }], rows })

/** The selected operators' metrics (delta = right − left) and their properties side by side. */
export const operatorDifferences = (left?: PlanNode, right?: PlanNode): LocalTableData => table('Operator metric / property', [
  numeric('Actual rows (total across threads)', left?.actualRows, right?.actualRows),
  numeric('CPU (ms, summed threads)', left?.cpuMs, right?.cpuMs),
  numeric('Elapsed (ms, max thread)', left?.elapsedMs, right?.elapsedMs),
  numeric('Executions (summed workers)', left?.executions, right?.executions),
  numeric('Estimated rows per execution', left?.estimatedRows, right?.estimatedRows),
  numeric('Estimated executions', left?.diagnostics?.estimatedExecutions, right?.diagnostics?.estimatedExecutions),
  numeric('Estimated total rows', left && estimatedTotalRows(left), right && estimatedTotalRows(right)),
  numeric('Estimated subtree cost (optimizer units)', left?.estimatedCost, right?.estimatedCost),
  ...textRows(nodeFacts(left), nodeFacts(right))
])

/** The paired statements' estimates, memory grants, parameters and warnings. */
export const statementDifferences = (left?: PlanStatement, right?: PlanStatement): LocalTableData => table('Statement metric / property', [
  numeric('Estimated statement cost (optimizer units)', left?.estimatedCost, right?.estimatedCost),
  numeric('Degree of parallelism (reported)', left?.diagnostics?.degreeOfParallelism, right?.diagnostics?.degreeOfParallelism),
  ...grants(left?.diagnostics && partial(left.diagnostics.memoryGrant, left.detailsShortened), right?.diagnostics && partial(right.diagnostics.memoryGrant, right.detailsShortened)),
  ...textRows(statementFacts(left), statementFacts(right))
])
