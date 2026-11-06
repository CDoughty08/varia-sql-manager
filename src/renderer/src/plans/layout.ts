import type { ElkNode } from 'elkjs'
import { card, union, type PlanLayout, type PlacedEdge, type PlacedNode, type PlacedStatement } from './geometry'

export type LayoutEngine = (graph: ElkNode) => Promise<ElkNode>
export interface LayoutStatement { readonly id: string; readonly nodes: readonly { readonly id: string; readonly parentId: string | null }[] }
/** Each statement keeps SQL Server's child order and its own space in one shared world. Runtime counters never enter layout. */
export async function layoutPlans(statements: readonly LayoutStatement[], engine: LayoutEngine): Promise<PlanLayout> {
  const nodes: PlacedNode[] = [], edges: PlacedEdge[] = [], sections: PlacedStatement[] = []
  let y = card.padding
  for (let s = 0; s < statements.length; s++) {
    const statement = statements[s]
    const graph = await engine({ id: statement.id, layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL', 'elk.padding': '[top=0,left=0,bottom=0,right=0]',
      'elk.spacing.nodeNode': String(card.nodeGap), 'elk.layered.spacing.nodeNodeBetweenLayers': String(card.layerGap),
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES', 'elk.layered.crossingMinimization.forceNodeModelOrder': 'true'
    }, children: statement.nodes.map(node => ({ id: node.id, width: card.width, height: card.height })),
    edges: statement.nodes.filter(node => node.parentId).map(node => ({ id: node.id + 'edge', sources: [node.parentId!], targets: [node.id] })) })
    if (![graph.width ?? 0, graph.height ?? 0].every(value => Number.isFinite(value) && value >= 0 && value < 10_000_000)) throw new Error('This plan is too large to lay out.')
    const width = Math.max(card.width, graph.width ?? card.width) + card.padding * 2, height = Math.max(card.height, graph.height ?? card.height) + card.heading + card.padding
    sections.push({ index: s, x: card.padding, y, width, height })
    const positions = new Map((graph.children ?? []).map(node => [node.id, node]))
    for (let n = 0; n < statement.nodes.length; n++) {
      const node = statement.nodes[n], position = positions.get(node.id)
      const x = position?.x ?? 0, nodeY = position?.y ?? 0
      if (!Number.isFinite(x) || !Number.isFinite(nodeY)) throw new Error('The plan layout contains an invalid position.')
      nodes.push({ id: node.id, statement: s, index: n, x: card.padding * 2 + x, y: y + card.heading + nodeY, width: card.width, height: card.height })
    }
    for (const edge of graph.edges ?? []) for (const section of edge.sections ?? []) {
      const points = [section.startPoint, ...section.bendPoints ?? [], section.endPoint].map(point => ({ x: point.x + card.padding * 2, y: point.y + y + card.heading }))
      if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error('The plan layout contains an invalid edge.')
      edges.push({ ...union(points.map(point => ({ ...point, width: 0, height: 0 }))), points })
    }
    y += height + card.gap
    if (y > 10_000_000) throw new Error('The combined plan layout is too large.')
  }
  return { nodes, edges, statements: sections, bounds: union(sections) }
}
