import { planLimits, type LivePlanFrame } from '../../../shared/plans'
import type { SourceStatement } from './sources'

function hash(text: string): string {
  let value = 2166136261
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619)
  return (value >>> 0).toString(36)
}
function scalarIdentity(statement: SourceStatement): string | undefined {
  const values = statement.nodes.flatMap(node => node.properties.filter(p => p.name === 'ScalarOperator.ScalarString' || p.name === 'Const.ConstValue')
    .map(p => [node.nodeId, p.name, p.value]))
  return values.length ? hash(JSON.stringify(values)) : undefined
}
/** SQL Server StatementId and NodeId survive the transient/completed XML's different document boundaries.
 * Batch and GO iteration are indispensable: two identical submitted statements are separate executions. */
export function queryPlanStatements(statements: readonly SourceStatement[]): SourceStatement[] {
  const occurrences = new Map<string, number>()
  return statements.map(statement => {
    if (!statement.batchNumber) return statement
    // IDs are local to the compiled batch, and QueryHash can agree for different literals. Dynamic SQL and
    // procedures can reuse both within one submitted batch; retain the text identity as well.
    const sql = statement.text.trim()
    const scalar = scalarIdentity(statement)
    const key = `b${statement.batchNumber}i${statement.iteration ?? 1}s${statement.statementId ?? ''}t${hash(sql)}${scalar ? 'p' + scalar : ''}${statement.queryHash ? 'q' + statement.queryHash : ''}`
    const occurrence = occurrences.get(key) ?? 0
    occurrences.set(key, occurrence + 1)
    const id = key + ':' + occurrence
    const nodeIds = new Map(statement.nodes.map(node => [node.id, id + 'n' + node.nodeId]))
    return { ...statement, id, nodes: statement.nodes.map(node => ({ ...node, id: nodeIds.get(node.id)!, parentId: node.parentId ? nodeIds.get(node.parentId) ?? null : null })) }
  })
}

export interface LivePlanModel { readonly statements: readonly SourceStatement[]; readonly revision: number; readonly batch: number; readonly iteration: number; readonly counterIds: ReadonlyMap<string, string> }
export const emptyLivePlan: LivePlanModel = { statements: [], revision: -1, batch: 0, iteration: 0, counterIds: new Map() }
export function idleLivePlan(model: LivePlanModel): LivePlanModel {
  return model.statements.some(s => s.nodes.some(n => n.liveActivity))
    ? { ...model, statements: model.statements.map(s => ({ ...s, nodes: s.nodes.map(n => n.liveActivity ? { ...n, liveActivity: false } : n) })) } : model
}
/** One document per batch revision, counters only thereafter. Old statements stay inspectable through partial runs. */
export function applyLivePlan(previous: LivePlanModel, frame: LivePlanFrame): LivePlanModel {
  const same = previous.batch === frame.batch && previous.iteration === frame.iteration && previous.revision === frame.revision
  if (!frame.document && !same) return previous
  const batchLabel = `Batch ${frame.batch}${frame.iteration > 1 ? `, repetition ${frame.iteration}` : ''}`
  const raw = frame.document?.statements.map(statement => ({ ...statement, sourceKey: '', batchLabel, batchNumber: frame.batch, iteration: frame.iteration, partial: true }))
  const counters = new Map(frame.counters.map(counter => [counter.id, counter]))
  const active = raw ?? previous.statements.filter(s => s.batchNumber === frame.batch && s.iteration === frame.iteration)
  const old = new Map(previous.statements.flatMap(s => s.nodes.map(n => [n.id, n] as const)))
  // Counters use parser ids; after normalization the document's node order is unchanged.
  const normalized = raw ? queryPlanStatements(raw) : active
  const counterIds = raw ? new Map(normalized.flatMap((s, i) => s.nodes.map((n, j) => [n.id, raw[i].nodes[j].id] as const))) : previous.counterIds
  const updated = normalized.map(statement => ({ ...statement, nodes: statement.nodes.map(node => {
    const counter = counters.get(counterIds.get(node.id) ?? '')
    if (!counter) return node
    return { ...node, actualRows: counter.rows, elapsedMs: counter.elapsedMs, cpuMs: counter.cpuMs, executions: counter.executions,
      liveActivity: counter.rows !== null && counter.rows > (old.get(node.id)?.actualRows ?? 0) }
  }) }))
  const merged = completedPlanStatements(idleLivePlan(previous).statements, updated)
  if (merged.length > planLimits.statements || merged.reduce((n, s) => n + s.nodes.length, 0) > planLimits.nodes) return previous
  if (raw && new TextEncoder().encode(JSON.stringify(merged)).length > 4_194_304) return previous
  return { statements: merged, batch: frame.batch, iteration: frame.iteration, revision: frame.revision, counterIds }
}

/** Runtime changes never restart layout or recreate Pixi. */
export function planTopology(statements: readonly SourceStatement[]): string {
  return JSON.stringify(statements.map(s => [s.id, s.nodes.map(n => [n.id, n.parentId])]))
}

export function completedPlanStatements(live: readonly SourceStatement[], actual: readonly SourceStatement[]): SourceStatement[] {
  const replacements = new Map(actual.map(s => [s.id, s]))
  const consumed = new Set<string>()
  // Native STATISTICS XML can supply SQL text that the live DMV omits. Use a unique compiled-statement match
  // only for completed data; never collapse different nonempty SQL or guess between repeated executions.
  const candidates = actual.filter(s => !s.partial && !live.some(l => l.id === s.id))
  const unmatched = live.filter(s => !replacements.has(s.id))
  const shapes = new Map<SourceStatement, string>()
  const scalars = new Map(candidates.length ? [...live, ...candidates].map(s => [s, scalarIdentity(s)] as const) : [])
  const shape = (statement: SourceStatement) => {
    let value = shapes.get(statement)
    if (value === undefined) {
      const nodes = new Map(statement.nodes.map(n => [n.id, n.nodeId]))
      value = JSON.stringify(statement.nodes.map(n => [n.nodeId, nodes.get(n.parentId ?? ''), n.physicalOp, n.logicalOp, n.object]))
      shapes.set(statement, value)
    }
    return value
  }
  const matches = (a: SourceStatement, b: SourceStatement) => !!a.batchNumber && a.batchNumber === b.batchNumber && (a.iteration ?? 1) === (b.iteration ?? 1)
    && !!a.queryHash && a.queryHash === b.queryHash && (!a.text.trim() || !b.text.trim() || a.text.trim() === b.text.trim())
    && !(scalars.get(a) && scalars.get(b) && scalars.get(a) !== scalars.get(b)) && shape(a) === shape(b)
  for (const statement of unmatched) {
    const found = candidates.filter(candidate => matches(statement, candidate))
    if (found.length !== 1 || unmatched.filter(other => matches(other, found[0])).length !== 1) continue
    const completed = found[0]
    const nodeIds = new Map(completed.nodes.map(node => [node.id, statement.id + 'n' + node.nodeId]))
    replacements.set(statement.id, { ...completed, id: statement.id, nodes: completed.nodes.map(node => ({ ...node,
      id: nodeIds.get(node.id)!, parentId: node.parentId ? nodeIds.get(node.parentId) ?? null : null })) })
    consumed.add(completed.id)
  }
  const retained = live.map(s => replacements.get(s.id) ?? s)
  const ids = new Set(live.map(s => s.id))
  const added = actual.filter(s => !ids.has(s.id) && !consumed.has(s.id))
  return added.length ? [...retained, ...added].toSorted((a, b) => (a.batchNumber || Number.MAX_SAFE_INTEGER) - (b.batchNumber || Number.MAX_SAFE_INTEGER) || (a.iteration ?? 1) - (b.iteration ?? 1)) : retained
}

/** Actual sources and retained live snapshots are bounded separately. Their combined canvas needs the same cap. */
export function completedPlanView(live: readonly SourceStatement[], actual: readonly SourceStatement[]): { statements: SourceStatement[]; omitted: number } {
  const combined = completedPlanStatements(live, actual)
  if (combined.length <= planLimits.statements && combined.reduce((sum, s) => sum + s.nodes.length, 0) <= planLimits.nodes)
    return { statements: combined, omitted: 0 }
  const kept = new Set<SourceStatement>()
  let operators = 0
  // Full captured data takes priority; omitted partial snapshots remain accessible in Live mode.
  for (const statement of [...combined.filter(s => !s.partial), ...combined.filter(s => s.partial)]) {
    if (kept.size === planLimits.statements || operators + statement.nodes.length > planLimits.nodes) continue
    kept.add(statement)
    operators += statement.nodes.length
  }
  return { statements: combined.filter(s => kept.has(s)), omitted: combined.length - kept.size }
}
