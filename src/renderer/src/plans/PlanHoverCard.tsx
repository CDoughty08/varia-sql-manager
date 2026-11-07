import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { PlanNode } from '../../../shared/plans'
import type { Rect } from './geometry'

const metricFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 })
export function formatPlanMetric(value: number | null): string {
  if (value === null) return 'Unavailable'
  return value > 0 && value < 0.0001 ? value.toExponential(2) : metricFormat.format(value)
}

function cardPosition(anchor: Rect, card: DOMRect, viewport: HTMLElement): { left: number; top: number } {
  const margin = 8, gap = 8
  const right = anchor.x + anchor.width + gap, left = anchor.x - gap - card.width
  const bottom = anchor.y + anchor.height + gap, top = anchor.y - gap - card.height
  const maxLeft = viewport.clientWidth - margin - card.width
  const maxTop = viewport.clientHeight - margin - card.height
  let x = anchor.x, y = anchor.y
  if (right <= maxLeft) x = right
  else if (left >= margin) x = left
  else y = bottom <= maxTop || top < margin ? bottom : top
  return { left: Math.max(margin, Math.min(maxLeft, x)), top: Math.max(margin, Math.min(maxTop, y)) }
}

export function PlanHoverCard({ node, anchor, owner, id, hold, leave }: {
  node: PlanNode; anchor: Rect; owner: Document; id: string; hold(): void; leave(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const { left, top } = cardPosition(anchor, element.getBoundingClientRect(), owner.documentElement)
    element.style.left = `${left}px`
    element.style.top = `${top}px`
  }, [anchor, node, owner])

  const hasRuntime = [node.actualRows, node.elapsedMs, node.cpuMs, node.executions].some(value => value !== null)
  const stats = [
    { label: 'Estimated subtree cost', value: node.estimatedCost },
    { label: 'Elapsed · max thread', value: node.elapsedMs, unit: ' ms' },
    { label: 'CPU · all threads', value: node.cpuMs, unit: ' ms' },
    { label: 'Executions · all threads', value: node.executions }
  ].filter(stat => stat.value !== null)

  return createPortal(<div ref={ref} id={id} className="plan-hover-card" role="tooltip" onPointerEnter={hold} onPointerLeave={leave}>
    <div className="plan-hover-heading"><strong>{node.physicalOp}</strong>{node.nodeId && <span>Node {node.nodeId}</span>}</div>
    {node.logicalOp && node.logicalOp !== node.physicalOp && <div className="plan-hover-logical">{node.logicalOp}</div>}
    {node.object && <div className="plan-hover-object">{node.object}</div>}
    <dl className="plan-hover-rows">
      <div><dt>Est. rows per execution</dt><dd>{formatPlanMetric(node.estimatedRows)}</dd></div>
      <div><dt>Actual rows · total</dt><dd>{hasRuntime ? formatPlanMetric(node.actualRows) : '—'}</dd></div>
    </dl>
    {!hasRuntime && <p className="plan-hover-note">Runtime counters unavailable</p>}
    {stats.length > 0 && <dl className="plan-hover-metrics">{stats.map(stat => <div key={stat.label}><dt>{stat.label}</dt><dd>{formatPlanMetric(stat.value)}{stat.unit}</dd></div>)}</dl>}
    {node.warnings.length > 0 && <div className="plan-hover-warnings">
      <strong>{node.warnings.length === 1 ? 'Warning' : `Warnings (${node.warnings.length})`}</strong>
      <ul>{node.warnings.slice(0, 3).map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      {node.warnings.length > 3 && <span>{node.warnings.length - 3} more in Properties</span>}
    </div>}
  </div>, owner.body)
}
