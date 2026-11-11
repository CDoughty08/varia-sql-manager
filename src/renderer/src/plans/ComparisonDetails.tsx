import { memo } from 'react'
import type { PlanNode, PlanStatement } from '../../../shared/plans'
import { estimatedTotalRows, formatPlanMetric } from './diagnostics'
import { metricDelta, propertyDifferences, type ComparedProperty } from './comparison'

type Property = ComparedProperty
const absent = 'Unavailable'
const display = (value: string | undefined) => value === undefined ? absent : value === '' ? '(empty value)' : value.length > 4096 ? value.slice(0, 4096) + ' [shortened in comparison; inspect frozen XML]' : value
const signed = (value: number) => (value > 0 ? '+' : '') + formatPlanMetric(value)
function Numeric({ name, left, right }: { name: string; left?: number | null; right?: number | null }) {
  const delta = metricDelta(left, right)
  return <tr data-changed={delta.left !== delta.right || undefined}><th scope="row">{name}</th><td>{formatPlanMetric(delta.left)}</td><td>{formatPlanMetric(delta.right)}</td>
    <td>{delta.absolute === undefined ? absent : `${signed(delta.absolute)} (${delta.zeroBaseline ? 'zero baseline' : delta.percent === undefined ? 'percentage unavailable' : signed(delta.percent) + '%'})`}</td></tr>
}
function TextRows({ left, right }: { left?: readonly Property[]; right?: readonly Property[] }) {
  return propertyDifferences(left, right).map((row, index) => <tr key={index} data-changed={row.changed || undefined}><th scope="row">{row.name}</th><td>{display(row.left)}</td><td>{display(row.right)}</td><td>{row.left === undefined && row.right === undefined ? 'Unavailable on both sides' : row.changed ? 'Changed / availability differs' : row.unverified ? 'Retained text agrees; shortened by the parser, equality unverified (inspect frozen XML)' : 'Same'}</td></tr>)
}
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
  { name: 'Memory grant availability', value: statement.diagnostics?.memoryGrant.length ? 'Reported attributes (subject to omission notices)' : undefined },
  { name: 'Parameter availability', value: statement.diagnostics?.parameters.length ? `${statement.diagnostics.parameters.length} reported entries (subject to omission notices)` : undefined },
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
function Grants({ left, right }: { left?: readonly Property[]; right?: readonly Property[] }) {
  return propertyDifferences(left, right).map((row, index) => {
    const unit = row.name === 'GrantWaitTime' ? 'ms' : memoryKiB.has(row.name) ? 'KiB' : undefined
    const number = (value?: string) => value !== undefined && value.trim() && /^\d+(\.\d+)?$/.test(value) ? Number(value) : undefined
    return unit ? <Numeric key={index} name={`Memory grant · ${row.name} (${unit})`} left={number(row.left)} right={number(row.right)} />
      : <TextRows key={index} left={row.left === undefined ? [] : [{ name: 'Memory grant · ' + row.name, value: row.left, partial: row.unverified }]} right={row.right === undefined ? [] : [{ name: 'Memory grant · ' + row.name, value: row.right, partial: row.unverified }]} />
  })
}
function ComparisonDetails({ left, right, leftStatement, rightStatement, reason }: { left?: PlanNode; right?: PlanNode; leftStatement?: PlanStatement; rightStatement?: PlanStatement; reason?: string }) {
  return <section className="comparison-details" aria-label="Plan differences">
    <p>{reason ?? 'Select an operator in either view or in the pairing list.'}</p>
    <p>Delta = right − left. Rows, CPU and executions sum all thread entries across their executions. Elapsed is the maximum cumulative thread time, not wall time. Operator times overlap. Repetitions are separate inputs; no per-execution or per-worker normalization is inferred. Partial captures remain partial. Unreported or omitted fields are unavailable.</p>
    <table aria-label="Operator differences"><thead><tr><th>Operator metric / property</th><th>Left</th><th>Right</th><th>Delta / change</th></tr></thead><tbody>
      <Numeric name="Actual rows (total across threads)" left={left?.actualRows} right={right?.actualRows} />
      <Numeric name="CPU (ms, summed threads)" left={left?.cpuMs} right={right?.cpuMs} />
      <Numeric name="Elapsed (ms, max thread)" left={left?.elapsedMs} right={right?.elapsedMs} />
      <Numeric name="Executions (summed workers)" left={left?.executions} right={right?.executions} />
      <Numeric name="Estimated rows per execution" left={left?.estimatedRows} right={right?.estimatedRows} />
      <Numeric name="Estimated executions" left={left?.diagnostics?.estimatedExecutions} right={right?.diagnostics?.estimatedExecutions} />
      <Numeric name="Estimated total rows" left={left && estimatedTotalRows(left)} right={right && estimatedTotalRows(right)} />
      <Numeric name="Estimated subtree cost (optimizer units)" left={left?.estimatedCost} right={right?.estimatedCost} />
      <TextRows left={nodeFacts(left)} right={nodeFacts(right)} />
    </tbody></table>
    {(!left?.diagnostics || !right?.diagnostics) && <p>Structured operator diagnostics are unavailable on at least one side. Use each view's properties for individual retained thread entries; these are not paired by thread ID.</p>}
    <details><summary>Statement estimates, parameters, memory grants and warnings</summary>
      <table aria-label="Statement differences"><thead><tr><th>Statement metric / property</th><th>Left</th><th>Right</th><th>Delta / change</th></tr></thead><tbody>
        <Numeric name="Estimated statement cost (optimizer units)" left={leftStatement?.estimatedCost} right={rightStatement?.estimatedCost} />
        <Numeric name="Degree of parallelism (reported)" left={leftStatement?.diagnostics?.degreeOfParallelism} right={rightStatement?.diagnostics?.degreeOfParallelism} />
        <Grants left={leftStatement?.diagnostics && partial(leftStatement.diagnostics.memoryGrant, leftStatement.detailsShortened)} right={rightStatement?.diagnostics && partial(rightStatement.diagnostics.memoryGrant, rightStatement.detailsShortened)} />
        <TextRows left={statementFacts(leftStatement)} right={statementFacts(rightStatement)} />
      </tbody></table>
      {(!leftStatement?.diagnostics || !rightStatement?.diagnostics) && <p>Structured diagnostics are unavailable on at least one side. Missing grants or parameters are not zero or empty values.</p>}
    </details>
  </section>
}
export default memo(ComparisonDetails)
