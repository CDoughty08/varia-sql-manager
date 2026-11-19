import { memo, useMemo, useState } from 'react'
import type { PlanNode, PlanStatement } from '../../../shared/plans'
import { LocalGrid } from '../grid/LocalGrid'
import Icon from '../Icon'
import { operatorDifferences, statementDifferences } from './comparison-tables'

/** The Differences pane: the selected operators' and statements' metrics and properties, each a results grid (page) that
 *  copies with headers and saves as a result does. */
function ComparisonDetails({ left, right, leftStatement, rightStatement, reason }: { left?: PlanNode; right?: PlanNode; leftStatement?: PlanStatement; rightStatement?: PlanStatement; reason?: string }) {
  const [statements, setStatements] = useState(false)
  const operators = useMemo(() => operatorDifferences(left, right), [left, right])
  const statement = useMemo(() => statementDifferences(leftStatement, rightStatement), [leftStatement, rightStatement])
  return <section className="comparison-details" aria-label="Plan differences" data-statements={statements || undefined}>
    <p>{reason ?? 'Select an operator in either view or in the pairing list.'}</p>
    <p>Delta = right − left. Rows, CPU and executions sum all thread entries across their executions. Elapsed is the maximum cumulative thread time, not wall time. Operator times overlap. Repetitions are separate inputs; no per-execution or per-worker normalization is inferred. Partial captures remain partial. Unreported or omitted fields are unavailable.</p>
    <LocalGrid table={operators} label="Operator differences" preset="page" suggestedName="Operator differences" />
    {(!left?.diagnostics || !right?.diagnostics) && <p>Structured operator diagnostics are unavailable on at least one side. Use each view's properties for individual retained thread entries; these are not paired by thread ID.</p>}
    <button type="button" className="comparison-disclosure" aria-expanded={statements} onClick={() => setStatements(open => !open)}><Icon name={statements ? 'chevron-down' : 'chevron-right'} />Statement estimates, parameters, memory grants and warnings</button>
    {statements && <>
      <LocalGrid table={statement} label="Statement differences" preset="page" suggestedName="Statement differences" />
      {(!leftStatement?.diagnostics || !rightStatement?.diagnostics) && <p>Structured diagnostics are unavailable on at least one side. Missing grants or parameters are not zero or empty values.</p>}
    </>}
  </section>
}
export default memo(ComparisonDetails)
