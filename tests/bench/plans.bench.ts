import { expect, it } from 'vitest'
import { layoutPlans } from '../../src/renderer/src/plans/layout'
import { PlanPreparationCache } from '../../src/renderer/src/plans/preparation'
import { largePlan } from '../fixtures/plans/large'
import { percentile, record } from './harness'

it('measures ordered layout of wide and maximum-size plans', () => {
  const wide = [largePlan(2000, 'wide')], large = [largePlan(10_000)]
  const measure = (statements: typeof wide) => {
    const samples: number[] = []
    for (let iteration = 0; iteration < 35; iteration++) {
      const start = performance.now(), layout = layoutPlans(statements)
      const elapsed = performance.now() - start
      expect(layout.nodes).toHaveLength(statements[0].nodes.length)
      expect(layout.edges).toHaveLength(statements[0].nodes.length - 1)
      if (iteration >= 5) samples.push(elapsed)
    }
    return percentile(samples, 95)
  }
  record({ id: 'node.plan.wideLayoutP95Ms', value: measure(wide), unit: 'ms', detail: '2,000 operators, one root with 1,999 ordered inputs; 30 warm runs' })
  record({ id: 'node.plan.largeLayoutP95Ms', value: measure(large), unit: 'ms', detail: '10,000 operators, ordered four-way tree; 30 warm runs' })
})

it('measures cached layout retrieval across view switches', () => {
  const cache = new PlanPreparationCache(), statement = largePlan(10_000), layout = layoutPlans([statement])
  const topology = JSON.stringify(statement), times: number[] = []
  cache.rememberLayout('tab', topology, layout, [])
  for (let index = 0; index < 100; index++) {
    const started = performance.now(), found = cache.layout('tab', topology)
    times.push(performance.now() - started)
    expect(found).toBe(layout)
  }
  record({ id: 'node.plan.cachedLayoutP95Ms', value: percentile(times, 95), unit: 'ms', detail: '10,000 operators; includes exact topology key lookup' })
  cache.dispose()
})
