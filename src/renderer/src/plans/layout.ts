import { card, union, type PlanLayout, type PlacedEdge, type PlacedNode, type PlacedStatement } from './geometry'

export interface LayoutStatement { readonly id: string; readonly nodes: readonly { readonly id: string; readonly parentId: string | null }[] }

/** Ordered tree layout in O(operators + edges), without recursion or crossing minimization.
 * Each subtree owns a disjoint vertical interval. Parents sit between their first and last input;
 * SQL Server's input order is the order in the document, never a sort by NodeId. */
export function layoutPlans(statements: readonly LayoutStatement[]): PlanLayout {
  const nodes: PlacedNode[] = [], edges: PlacedEdge[] = [], sections: PlacedStatement[] = []
  let y = card.padding
  for (let s = 0; s < statements.length; s++) {
    const statement = statements[s], ids = new Map<string, number>(), roots: number[] = []
    const children: number[][] = statement.nodes.map(() => [])
    statement.nodes.forEach((node, index) => {
      if (ids.has(node.id)) throw new Error('The plan contains duplicate operator identities.')
      ids.set(node.id, index)
    })
    statement.nodes.forEach((node, index) => {
      if (node.parentId === null) roots.push(index)
      else {
        const parent = ids.get(node.parentId)
        if (parent === undefined) throw new Error('The plan contains an unavailable parent operator.')
        children[parent].push(index)
      }
    })
    const order: number[] = [], depths = new Int32Array(statement.nodes.length), heights = new Float64Array(statement.nodes.length)
    const stack = roots.toReversed()
    while (stack.length) {
      const index = stack.pop()!
      order.push(index)
      for (let c = children[index].length - 1; c >= 0; c--) {
        const child = children[index][c]
        depths[child] = depths[index] + 1
        stack.push(child)
      }
    }
    if (order.length !== statement.nodes.length) throw new Error('The plan contains an operator cycle.')
    for (let at = order.length - 1; at >= 0; at--) {
      const index = order[at]
      heights[index] = children[index].length ? children[index].reduce((sum, child) => sum + heights[child], 0) + (children[index].length - 1) * card.nodeGap : card.height
    }
    const tops = new Float64Array(statement.nodes.length), centers = new Float64Array(statement.nodes.length)
    let rootTop = 0
    for (const root of roots) { tops[root] = rootTop; rootTop += heights[root] + card.nodeGap }
    for (const index of order) {
      let top = tops[index]
      for (const child of children[index]) { tops[child] = top; top += heights[child] + card.nodeGap }
    }
    for (let at = order.length - 1; at >= 0; at--) {
      const index = order[at], inputs = children[index]
      centers[index] = inputs.length ? (centers[inputs[0]] + centers[inputs.at(-1)!]) / 2 : tops[index] + card.height / 2
    }
    const start = nodes.length
    statement.nodes.forEach((node, index) => nodes.push({ id: node.id, statement: s, index,
      x: card.padding * 2 + depths[index] * (card.width + card.layerGap), y: y + card.heading + centers[index] - card.height / 2, width: card.width, height: card.height }))
    for (let index = 0; index < statement.nodes.length; index++) {
      const node = statement.nodes[index]
      if (node.parentId === null) continue
      const parent = nodes[start + ids.get(node.parentId)!], child = nodes[start + index]
      const left = parent.x + parent.width, middle = left + card.layerGap / 2, fromY = parent.y + card.height / 2, toY = child.y + card.height / 2
      const points = [{ x: left, y: fromY }, { x: middle, y: fromY }, { x: middle, y: toY }, { x: child.x, y: toY }]
      edges.push({ ...union(points.map(point => ({ ...point, width: 0, height: 0 }))), points })
    }
    const bounds = union(nodes.slice(start))
    const width = Math.max(card.width, bounds.x + bounds.width - card.padding * 2) + card.padding * 2
    const height = Math.max(card.height, rootTop - card.nodeGap) + card.heading + card.padding
    sections.push({ index: s, x: card.padding, y, width, height })
    y += height + card.gap
    if (width > 10_000_000 || y > 10_000_000) throw new Error('The combined plan layout is too large.')
  }
  return { nodes, edges, statements: sections, bounds: union(sections) }
}
