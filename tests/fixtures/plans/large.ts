import type { LayoutStatement } from '../../../src/renderer/src/plans/layout'

export function largePlan(count: number, shape: 'wide' | 'balanced' | 'chain' = 'balanced'): LayoutStatement {
  return { id: shape, nodes: Array.from({ length: count }, (_, index) => ({ id: `${shape}:${index}`,
    parentId: index === 0 ? null : `${shape}:${shape === 'wide' ? 0 : shape === 'chain' ? index - 1 : Math.floor((index - 1) / 4)}` })) }
}
