import { useState } from 'react'
import type { PlanNode } from '../../../shared/plans'
import { useMenuTarget } from '../menus/useMenuTarget'
import type { PlanPropertiesTarget } from '../menus/targets'
import { factText, selectedFacts } from '../menus/selected-facts'
import type { SourceStatement } from './sources'
import { discrepancyLabel, estimatedTotalRows, formatPlanMetric as amount } from './diagnostics'
import './diagnostics.css'

type Property = { name: string; value: string }
function Facts({ values }: { values: readonly (readonly [string, string])[] }) {
  const menu = useFactMenu()
  return <dl>{values.map(([name, value], index) => <div key={index} ref={menu} className="plan-fact"><dt>{name}</dt><dd>{value || 'Unavailable'}</dd></div>)}</dl>
}
function Attributes({ properties }: { properties: readonly Property[] }) {
  return <Facts values={properties.map(property => [property.name, property.value])} />
}
function Details({ title, items }: { title: string; items?: readonly { kind: string; properties: Property[] }[] }) {
  return <details><summary>{title} ({items?.length ?? 0})</summary>{items?.length ? items.map((item, index) => <div key={index} className="plan-diagnostic-detail"><strong>{item.kind || 'Unavailable'}</strong><Attributes properties={item.properties} /></div>)
    : <p>{items ? 'No details retained. Inspect the XML source for complete information.' : 'Detailed data unavailable in this view. Inspect the XML source for complete information.'}</p>}</details>
}

/**
 * The Properties menu's target: the facts whose text is selected in the pane, else the one the menu was opened on (`fact`),
 * else every fact shown (a closed section's facts are hidden). A right-click (or Ctrl+click) on macOS selects the word under
 * it before the menu opens, so a menu opened while a press is down reads the selection as that press began (`press`), as
 * Peek's Properties does; once the press ends (Windows opens the menu on release) it reads the selection as it is.
 */
export function planPropertiesMenu() {
  let pressed: HTMLElement[] | undefined
  return {
    press(pane: HTMLElement) {
      pressed = selectedFacts(pane, '.plan-fact')
      const doc = pane.ownerDocument
      const release = () => { pressed = undefined; doc.removeEventListener('pointerup', release, true); doc.removeEventListener('pointercancel', release, true) }
      doc.addEventListener('pointerup', release, true)
      doc.addEventListener('pointercancel', release, true)
    },
    target(pane: HTMLElement, fact?: Element): PlanPropertiesTarget | null {
      const facts = [...pane.querySelectorAll<HTMLElement>('.plan-fact')].filter(item => !item.closest('details:not([open])'))
      const press = pressed
      pressed = undefined
      const selected = (press ?? selectedFacts(pane, '.plan-fact')).filter(item => facts.includes(item))
      // The press saw no selection, so any selection now is the word macOS selects under a right-click: drop it, or the
      // next right-click's press would take it for the user's selection and copy this fact again.
      // A selection elsewhere in the window (Messages) is the user's and stays.
      const selection = pane.ownerDocument.getSelection()
      if (press && !press.length && selection && !selection.isCollapsed && pane.contains(selection.anchorNode)) selection.removeAllRanges()
      if (!facts.length) return null
      const picked = selected.length ? selected : fact && facts.includes(fact as HTMLElement) ? [fact as HTMLElement] : facts
      return { kind: 'planProperties', facts: picked.map(groupedFactText) }
    }
  }
}
/** A fact's name and value, the name after its group's label where facts repeat (a parameter, missing index, predicate or
 *  thread entry), so copied lines still say which item each belongs to. */
function groupedFactText(fact: HTMLElement): readonly [string, string] {
  const [name, value] = factText(fact)
  const detail = fact.closest('.plan-diagnostic-detail')
  const nested = fact.closest('details')
  const label = detail ? detail.querySelector(':scope > strong')?.textContent
    : nested?.parentElement?.closest('details') ? nested.querySelector(':scope > summary')?.textContent : undefined
  return [label ? `${label} · ${name}` : name, value]
}
type PropertiesMenu = ReturnType<typeof planPropertiesMenu>
const paneSelector = '.plan-properties-pane'
/** Each Properties pane's menu, for the facts inside it: a fact's own target names it, so a right-click copies that fact. */
const paneMenus = new WeakMap<Element, PropertiesMenu>()
function useFactMenu() {
  return useMenuTarget<HTMLElement>(fact => {
    const pane = fact.closest<HTMLElement>(paneSelector)
    return pane ? paneMenus.get(pane)?.target(pane, fact) ?? null : null
  }, fact => fact.closest<HTMLElement>(paneSelector) ?? undefined)
}

/** The Properties pane, focusable, with a menu whose Copy and Copy Value write its facts. */
export function PlanPropertiesPane(props: { statement?: SourceStatement; node?: PlanNode; liveRunning?: boolean }) {
  const [copy] = useState(planPropertiesMenu)
  const menu = useMenuTarget<HTMLDivElement>(pane => copy.target(pane))
  return <div ref={element => { if (element) { paneMenus.set(element, copy); menu(element) } }} className="plan-properties-pane" tabIndex={0} role="group" aria-label="Properties"
    onPointerDownCapture={event => copy.press(event.currentTarget)}><PlanProperties {...props} /></div>
}

export function PlanProperties({ statement, node, liveRunning }: { statement?: SourceStatement; node?: PlanNode; liveRunning?: boolean }) {
  const data = statement?.diagnostics, diagnostic = node?.diagnostics
  return <>
    <h3>{node?.physicalOp ?? 'Statement properties'}</h3>
    {statement && <>
      <details><summary>Statement SQL</summary><p className="plan-statement-text">{statement.text.trim() ? statement.text : 'SQL text unavailable'}</p></details>
      <Facts values={[
        ...statement.batchLabel ? [['Position', statement.batchLabel] as const] : [],
        ['Plan data', statement.captureLabel ?? (statement.partial ? liveRunning ? 'Live (partial)' : 'Partial live snapshot' : statement.nodes.some(n => [n.actualRows, n.cpuMs, n.elapsedMs, n.executions].some(value => value !== null) || n.diagnostics?.threads.length) ? 'Actual' : 'Estimated')],
        ['Statement estimated cost', amount(statement.estimatedCost)], ['Degree of parallelism', amount(data?.degreeOfParallelism)]
      ]} />
      <p className="plan-diagnostic-note">Costs are optimizer estimates, including in actual plans. Operator times may overlap and include child work; do not add them to obtain query time.</p>
      {statement.warnings.map((warning, index) => <p className="plan-warning" key={index}>{warning}</p>)}
      <Details title="Statement warning details" items={data?.warnings} />
      <details><summary>Parameters ({data?.parameters.length ?? 0})</summary>{data?.parameters.length ? data.parameters.map((parameter, index) => <div key={index} className="plan-diagnostic-detail"><strong>{parameter.name || 'Unavailable'}</strong><Facts values={[
        ['Data type', parameter.dataType], ['Compiled value', parameter.compiledValue === '' ? '(empty)' : parameter.compiledValue ?? 'Unavailable'], ['Runtime value', parameter.runtimeValue === '' ? '(empty)' : parameter.runtimeValue ?? 'Unavailable']
      ]} /></div>) : <p>Parameter values unavailable in this view.</p>}</details>
      <details><summary>Memory grant</summary>{data?.memoryGrant.length ? <><p className="plan-diagnostic-note">Memory amounts are KiB; GrantWaitTime is milliseconds. Other attributes retain their XML names and values.</p><Attributes properties={data.memoryGrant} /></> : <p>{statement.partial ? 'Grant details require captured actual XML.' : 'Unavailable in this view.'}</p>}</details>
      <details><summary>Missing indexes ({data?.missingIndexes.length ?? 0})</summary>{data?.missingIndexes.length ? <>
        <p className="plan-diagnostic-note">Optimizer suggestions and estimated impact; assess against the workload before creating an index.</p>
        {data.missingIndexes.map((index, position) => <div key={position} className="plan-diagnostic-detail"><strong>{[index.database, index.schema, index.table].filter(Boolean).join('.')}</strong><Facts values={[
          ['Estimated impact (%)', amount(index.impact)], ...index.columns.map(column => [column.usage || 'Usage unavailable', column.name] as const)
        ]} /></div>)}
      </> : <p>No structured suggestions retained. Inspect the XML source for complete information.</p>}</details>
    </>}
    {node ? <>
      <Facts values={[
        ['Node ID', node.nodeId], ['Logical operation', node.logicalOp], ['Object', node.object],
        ['Estimated rows per execution', amount(node.estimatedRows)], ['Estimated executions', amount(diagnostic?.estimatedExecutions)],
        ['Estimated rows · all estimated executions', amount(estimatedTotalRows(node))], ['Actual rows · total', amount(node.actualRows)],
        ['Row-estimate discrepancy · totals', discrepancyLabel(node)], ['Estimated subtree cost', amount(node.estimatedCost)],
        ['Elapsed (ms, maximum thread)', amount(node.elapsedMs)], ['CPU (ms, summed threads)', amount(node.cpuMs)], ['Executions (summed threads)', amount(node.executions)],
        ['Parallel operator', diagnostic?.parallel == null ? 'Unavailable' : diagnostic.parallel ? 'Yes' : 'No'], ['Estimated execution mode', diagnostic?.estimatedExecutionMode ?? '']
      ]} />
      <details><summary>Metric definitions</summary><p className="plan-diagnostic-note">Rows and CPU sum all reported thread entries, across their executions. Elapsed is the maximum thread total, not query wall time. A missing counter on any thread makes its aggregate unavailable. Execution counts include workers. Row discrepancy compares total rows with estimated rows multiplied by (1 + estimated rebinds + estimated rewinds), without a worker multiplier.</p></details>
      {statement?.partial && <p className="plan-diagnostic-note">Live totals are partial. Thread, spill and grant details require captured actual XML.</p>}
      <details><summary>Predicates ({diagnostic?.predicates.filter(p => p.columns.length || p.expressions.length).length ?? 0})</summary>{diagnostic?.predicates.filter(p => p.columns.length || p.expressions.length).map((predicate, index) => <div key={index} className="plan-diagnostic-detail"><strong>{predicate.kind}</strong><Facts values={[
        ['Comparison', predicate.comparison], ['Columns', predicate.columns.join(', ')], ['Expressions', predicate.expressions.join('; ')]
      ]} /></div>)}{!diagnostic?.predicates.some(p => p.columns.length || p.expressions.length) && <p>Unavailable in this view.</p>}</details>
      <details><summary>Output columns ({diagnostic?.outputColumns.length ?? 0})</summary>{diagnostic?.outputColumns.length ? <ul>{diagnostic.outputColumns.map((column, index) => <li key={index}>{column || 'Unavailable'}</li>)}</ul> : <p>Unavailable in this view.</p>}</details>
      {node.warnings.map((warning, index) => <p className="plan-warning" key={index}>{warning}</p>)}
      <Details title="Operator warning details" items={diagnostic?.warnings} />
      <Details title="Spill details" items={diagnostic?.spills} />
      <details><summary>Thread runtime ({diagnostic?.threads.length ?? 0} retained entries)</summary>
        <p className="plan-diagnostic-note">Each entry contains SQL Server's cumulative counters across its executions. Entries are preserved separately, even with repeated thread IDs. Thread 0 can be a coordinator. Detail retention is bounded; aggregates use all entries. Missing values are unavailable.</p>
        {diagnostic?.threads.length ? diagnostic.threads.map((thread, index) => <details key={index}><summary>Thread {amount(thread.thread)} · entry {index + 1}</summary><Facts values={[
          ['Rows', amount(thread.rows)], ['Rows read', amount(thread.rowsRead)], ['Executions', amount(thread.executions)], ['CPU (ms)', amount(thread.cpuMs)], ['Elapsed (ms)', amount(thread.elapsedMs)], ['Actual execution mode', thread.executionMode]
        ]} /><Attributes properties={thread.properties} /></details>) : <p>{diagnostic?.runtimeDetailsAvailable === false ? 'Per-thread details require captured actual XML.' : 'Unavailable in this view.'}</p>}
      </details>
      <details><summary>Operator properties</summary><Attributes properties={node.properties} /></details>
    </> : <p>Select an operator to inspect its properties.</p>}
  </>
}
