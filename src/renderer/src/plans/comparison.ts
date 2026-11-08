import { planLimits, type PlanNode, type PlanStatement } from '../../../shared/plans'

export type PairStatus = 'paired' | 'ambiguous' | 'left-only' | 'right-only'
export interface PlanPair<T> { left?: T; right?: T; status: PairStatus; reason: string }
export interface OperatorPair extends PlanPair<PlanNode> { structural: boolean; structureUnknown?: boolean; propertiesChanged: boolean }
export interface StatementPair extends PlanPair<PlanStatement> { operators: OperatorPair[] }

function groups<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const item of items) {
    const value = key(item)
    if (!value) continue
    const group = result.get(value)
    if (group) group.push(item); else result.set(value, [item])
  }
  return result
}

/** Index equality only. No edit-distance matrix, cross product, or identity inferred from NodeId/array position.
 * Uniqueness is checked against the whole scope, not made artificially unique by earlier matches. */
function pairItems<T>(left: readonly T[], right: readonly T[], keys: readonly { key(item: T): string; reason: string }[]) {
  const forward = new Map<T, T>(), backward = new Map<T, T>(), reasons = new Map<T, string>()
  const ambiguousLeft = new Set<T>(), ambiguousRight = new Set<T>()
  for (const { key, reason } of keys) {
    const a = groups(left, key), b = groups(right, key)
    for (const [value, first] of a) {
      const second = b.get(value)
      if (!second) continue
      if (first.length === 1 && second.length === 1) {
        if (!forward.has(first[0]) && !backward.has(second[0])) {
          forward.set(first[0], second[0]); backward.set(second[0], first[0]); reasons.set(first[0], reason)
        }
      } else {
        for (const item of first) ambiguousLeft.add(item)
        for (const item of second) ambiguousRight.add(item)
      }
    }
  }
  return { forward, backward, reasons, ambiguousLeft, ambiguousRight }
}

const identity = (node: PlanNode) => JSON.stringify([node.physicalOp, node.logicalOp, node.object])
const operatorKeys = [
  { key: (node: PlanNode) => JSON.stringify([identity(node), node.diagnostics?.predicates ?? []]), reason: 'Unique operator, object and predicates' },
  { key: identity, reason: 'Unique physical/logical operator and object' },
  { key: (node: PlanNode) => node.logicalOp ? JSON.stringify([node.logicalOp, node.object]) : '', reason: 'Unique logical operator and object' }
]
const values = (node: PlanNode) => JSON.stringify([node.physicalOp, node.logicalOp, node.object,
  node.properties.filter(property => property.name !== 'RelOp.NodeId').toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
  node.warnings, node.diagnostics?.parallel, node.diagnostics?.estimatedExecutionMode, node.diagnostics?.predicates,
  node.diagnostics?.outputColumns, node.diagnostics?.warnings, node.diagnostics?.spills])

export function pairOperators(left: readonly PlanNode[], right: readonly PlanNode[]): OperatorPair[] {
  for (const nodes of [left, right]) if (nodes.length > planLimits.nodes || new Set(nodes.map(node => node.id)).size !== nodes.length)
    throw new Error('The comparison input has too many operators or duplicate operator identities.')
  const match = pairItems(left, right, operatorKeys)
  const children = (nodes: readonly PlanNode[]) => groups(nodes, node => node.parentId ?? '\u0000root')
  const aChildren = children(left), bChildren = children(right)
  const queue: [string, string][] = [['\u0000root', '\u0000root'], ...Array.from(match.forward, ([a, b]) => [a.id, b.id] as [string, string])]
  // A paired parent can disambiguate identical operators in distinct branches, without guessing sibling order.
  for (let at = 0; at < queue.length; at++) {
    const [a, b] = queue[at]
    const firstChildren = aChildren.get(a), secondChildren = bChildren.get(b)
    if (!firstChildren?.some(node => !match.forward.has(node)) || !secondChildren?.some(node => !match.backward.has(node))) continue
    const local = pairItems(firstChildren, secondChildren, operatorKeys)
    for (const [first, second] of local.forward) if (!match.forward.has(first) && !match.backward.has(second)) {
      match.forward.set(first, second); match.backward.set(second, first)
      match.reasons.set(first, 'Unique operator within paired parents'); queue.push([first.id, second.id])
    }
  }
  const byId = new Map(left.map(node => [node.id, node]))
  const aOrder = new Map<string, number>(), bOrder = new Map<string, number>()
  for (const group of aChildren.values()) group.forEach((node, index) => aOrder.set(node.id, index))
  for (const group of bChildren.values()) group.forEach((node, index) => bOrder.set(node.id, index))
  const pairs: OperatorPair[] = left.map(first => {
    const second = match.forward.get(first)
    const parent = first.parentId ? byId.get(first.parentId) : undefined
    const parentPair = parent && match.forward.get(parent)
    const parentKnown = first.parentId === null || second?.parentId === null || !!parentPair
    const sameParent = first.parentId === null ? second?.parentId === null : parentPair?.id === second?.parentId
    return { left: first, right: second, status: second ? 'paired' : match.ambiguousLeft.has(first) ? 'ambiguous' : 'left-only',
      reason: second ? match.reasons.get(first)! : match.ambiguousLeft.has(first) ? 'Multiple plausible counterparts; no pairing inferred' : 'No conservative counterpart',
      structural: !!second && parentKnown && (!sameParent || aOrder.get(first.id) !== bOrder.get(second.id)), structureUnknown: !!second && !parentKnown,
      propertiesChanged: !!second && values(first) !== values(second) }
  })
  for (const second of right) if (!match.backward.has(second)) pairs.push({ right: second, status: match.ambiguousRight.has(second) ? 'ambiguous' : 'right-only',
    reason: match.ambiguousRight.has(second) ? 'Multiple plausible counterparts; no pairing inferred' : 'No conservative counterpart', structural: false, propertiesChanged: false })
  return pairs
}

export function comparePlans(left: readonly PlanStatement[], right: readonly PlanStatement[]): StatementPair[] {
  for (const statements of [left, right]) if (statements.length > planLimits.statements || statements.reduce((sum, s) => sum + s.nodes.length, 0) > planLimits.nodes)
    throw new Error('The comparison input exceeds the statement or operator limit.')
  for (const statements of [left, right]) {
    const ids = new Set<string>(), nodes = new Set<string>()
    for (const statement of statements) {
      if (ids.has(statement.id)) throw new Error('The comparison input has duplicate statement identities.')
      ids.add(statement.id)
      for (const node of statement.nodes) {
        if (nodes.has(node.id)) throw new Error('The comparison input has duplicate operator identities.')
        nodes.add(node.id)
      }
    }
  }
  const match = pairItems(left, right, [
    { key: (s: PlanStatement) => s.text.trim() ? JSON.stringify([s.type, s.text.trim()]) : '', reason: 'Unique exact statement text and type' },
    { key: (s: PlanStatement) => s.queryHash ? JSON.stringify([s.type, s.queryHash]) : '', reason: 'Unique query hash and type (optimizer identity)' }
  ])
  const pairs: StatementPair[] = left.map(first => {
    const second = match.forward.get(first)
    return { left: first, right: second, status: second ? 'paired' : match.ambiguousLeft.has(first) ? 'ambiguous' : 'left-only',
      reason: second ? match.reasons.get(first)! : match.ambiguousLeft.has(first) ? 'Repeated statement; no occurrence pairing inferred' : 'No exact text or unique query hash counterpart',
      operators: second ? pairOperators(first.nodes, second.nodes) : first.nodes.map(node => ({ left: node, status: 'left-only', reason: 'Statement is unpaired', structural: false, propertiesChanged: false })) }
  })
  for (const second of right) if (!match.backward.has(second)) pairs.push({ right: second, status: match.ambiguousRight.has(second) ? 'ambiguous' : 'right-only',
    reason: match.ambiguousRight.has(second) ? 'Repeated statement; no occurrence pairing inferred' : 'No exact text or unique query hash counterpart',
    operators: second.nodes.map(node => ({ right: node, status: 'right-only', reason: 'Statement is unpaired', structural: false, propertiesChanged: false })) })
  return pairs
}

export interface MetricDelta { left?: number; right?: number; absolute?: number; percent?: number; zeroBaseline: boolean }
/** Right minus left. Zero/zero is 0%; nonzero/zero has no finite percentage. Unavailable never becomes zero. */
export function metricDelta(left: number | null | undefined, right: number | null | undefined): MetricDelta {
  const valid = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value >= 0
  const a = valid(left) ? left : undefined, b = valid(right) ? right : undefined
  if (a === undefined || b === undefined) return { left: a, right: b, zeroBaseline: false }
  const absolute = b - a, percent = a === 0 ? b === 0 ? 0 : undefined : absolute / a * 100
  return { left: a, right: b, absolute, percent: percent !== undefined && Number.isFinite(percent) ? percent : undefined, zeroBaseline: a === 0 && b !== 0 }
}

export interface Difference { name: string; left?: string; right?: string; changed: boolean }
/** Preserve duplicate names and original order. An absent diagnostics block/list is unavailable, not empty. */
export function propertyDifferences(left: readonly { name: string; value: string | undefined }[] | undefined, right: readonly { name: string; value: string | undefined }[] | undefined): Difference[] {
  const index = (items: typeof left) => {
    const counts = new Map<string, number>(), result = new Map<string, { name: string; value: string | undefined }>()
    for (const item of items ?? []) { const n = (counts.get(item.name) ?? 0) + 1; counts.set(item.name, n); result.set(JSON.stringify([item.name, n]), item) }
    return result
  }
  const a = index(left), b = index(right)
  return [...new Set([...a.keys(), ...b.keys()])].map(key => ({ name: a.get(key)?.name ?? b.get(key)!.name, left: a.get(key)?.value, right: b.get(key)?.value,
    changed: a.get(key)?.value !== b.get(key)?.value }))
}
