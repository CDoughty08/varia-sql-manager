import type { PlanStatement } from '../../../shared/plans'
import { comparePlans } from './comparison'

export interface ComparisonIndex {
  left?: string; right?: string; status: string; reason: string
  operators: { left?: string; right?: string; status: string; reason: string; structural: boolean; structureUnknown?: boolean; propertiesChanged: boolean }[]
}
self.onmessage = (event: MessageEvent<{ left: PlanStatement[]; right: PlanStatement[] }>) => {
  try {
    const pairs: ComparisonIndex[] = comparePlans(event.data.left, event.data.right).map(pair => ({ ...pair, left: pair.left?.id, right: pair.right?.id,
      operators: pair.operators.map(operator => ({ ...operator, left: operator.left?.id, right: operator.right?.id })) }))
    self.postMessage({ ok: true, pairs })
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Plan matching failed.' }) }
}
