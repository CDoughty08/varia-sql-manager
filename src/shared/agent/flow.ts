// The job document's Steps › Flow view (docs/sql-server-agent.md › Steps › Flow, docs/agent-ui-rethink.md › Flow view; mocks rx-flow*): a
// job's steps as a graph, pure. Where each step goes on success and on failure, which steps the Start step reaches, the loops, the flow
// checks (shared with the List, so they are not Flow-only) and the layout the canvas draws: steps stay in step order, top to bottom, and
// jumps run in lanes beside the column, success on the left and failure on the right. No React or Pixi here.
import type { AgentStepDraft, AgentStepsDraft, StepAction } from './steps.ts'

export type FlowWhich = 'success' | 'fail'
/** Where an edge goes: a step (by position), a Quit, the End past the last step (Agent then fails the job), a step that no longer exists, or,
 *  in a job with more steps than Varia reads, a step past those read (by its saved id, when the draft names it). */
export type FlowTarget =
  | { readonly kind: 'step'; readonly index: number }
  | { readonly kind: 'quit'; readonly success: boolean }
  | { readonly kind: 'end' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unread'; readonly stepId?: number }
export interface FlowEdge {
  readonly from: number
  readonly which: FlowWhich
  readonly action: StepAction
  readonly target: FlowTarget
  /** A Go to step N whose N is the step just below: drawn straight like Go to the next step, but marked "→ N", since it follows that step
   *  if steps move and the next step does not. */
  readonly marked: boolean
  /** Both ends are steps of the same loop. */
  readonly loop: boolean
}
/** A set of steps that can run again and again (a strongly connected component of two or more steps), in step order. */
export interface FlowLoop {
  readonly steps: readonly number[]
  /** Every action of every step in it stays inside it: the job never ends by itself. */
  readonly closed: boolean
  /** The edge the loop is reported and tagged on: its last edge back up the column. */
  readonly back: FlowEdge
  /** The edges that leave it, in step order. */
  readonly exits: readonly FlowEdge[]
}
export interface StepsFlow {
  readonly count: number
  /** The Start step's position; -1 for a job with no steps. */
  readonly start: number
  /** Two per step, success then failure, in step order. */
  readonly edges: readonly FlowEdge[]
  /** Steps the Start step reaches, by position. */
  readonly reachable: readonly boolean[]
  readonly loops: readonly FlowLoop[]
}

const flowWhich: readonly FlowWhich[] = ['success', 'fail']
/** An edge's key, `${from}:${which}`: what the canvas's accent and hot sets and its chips name. */
export const flowEdgeKey = (from: number, which: FlowWhich): string => `${from}:${which}`
const savedId = (key: string | undefined): number | undefined => key && /^s[1-9][0-9]*$/.test(key) ? Number(key.slice(1)) : undefined
const targetOf = (draft: AgentStepsDraft, step: AgentStepDraft, at: number, which: FlowWhich, more: boolean): FlowTarget => {
  const action = which === 'success' ? step.onSuccess : step.onFail, key = which === 'success' ? step.onSuccessTarget : step.onFailTarget
  if (action === 1 || action === 2) return { kind: 'quit', success: action === 1 }
  // Past the steps read, the next step is one Varia did not read, not the End.
  if (action === 3) return at < draft.steps.length - 1 ? { kind: 'step', index: at + 1 } : more ? { kind: 'unread', ...step.from !== undefined ? { stepId: step.from + 1 } : {} } : { kind: 'end' }
  const index = key ? draft.steps.findIndex(item => item.key === key) : -1
  if (index >= 0) return { kind: 'step', index }
  const id = savedId(key)
  return more && id !== undefined ? { kind: 'unread', stepId: id } : { kind: 'missing' }
}
const stepTarget = (edge: FlowEdge): number | undefined => edge.target.kind === 'step' ? edge.target.index : undefined

/** The steps as a graph: edges, what the Start step reaches and the loops. `more`: the job has steps past those read (its steps were cut). */
export function stepsFlow(draft: AgentStepsDraft, more = false): StepsFlow {
  const count = draft.steps.length
  const raw = draft.steps.flatMap((step, at) => flowWhich.map(which => {
    const action = which === 'success' ? step.onSuccess : step.onFail, target = targetOf(draft, step, at, which, more)
    return { from: at, which, action, target, marked: action === 4 && target.kind === 'step' && target.index === at + 1 }
  }))
  const start = draft.steps.findIndex(step => step.key === draft.startKey)
  const reachable = reach(count, raw, start)
  const components = strongComponents(count, raw)
  const inLoop = new Map<number, number>()
  components.forEach((members, id) => { for (const member of members) inLoop.set(member, id) })
  const edges: FlowEdge[] = raw.map(edge => {
    const to = stepTarget(edge as FlowEdge), own = inLoop.get(edge.from)
    return { ...edge, loop: own !== undefined && to !== undefined && inLoop.get(to) === own }
  })
  const loops = components.map((members, id): FlowLoop => {
    const inside = edges.filter(edge => inLoop.get(edge.from) === id)
    const backs = inside.filter(edge => edge.loop && stepTarget(edge)! <= edge.from)
    const exits = inside.filter(edge => !edge.loop)
    return { steps: members, closed: exits.length === 0, back: backs[backs.length - 1]!, exits }
  })
  return { count, start, edges, reachable, loops }
}
function reach(count: number, edges: readonly { readonly from: number; readonly target: FlowTarget }[], from: number): boolean[] {
  const seen = Array.from({ length: count }, () => false)
  if (from < 0 || from >= count) return seen
  const queue = [from]
  seen[from] = true
  while (queue.length) {
    const at = queue.shift()!
    for (const edge of edges) {
      if (edge.from !== at || edge.target.kind !== 'step' || seen[edge.target.index]) continue
      seen[edge.target.index] = true
      queue.push(edge.target.index)
    }
  }
  return seen
}
/** Tarjan's components of two or more steps, each in step order, ordered by their first step. A step cannot go to itself (an error). */
function strongComponents(count: number, edges: readonly { readonly from: number; readonly target: FlowTarget }[]): number[][] {
  const next: number[][] = Array.from({ length: count }, () => [])
  for (const edge of edges) if (edge.target.kind === 'step' && edge.target.index !== edge.from) next[edge.from]!.push(edge.target.index)
  const index: number[] = Array(count).fill(-1), low: number[] = Array(count).fill(0), onStack: boolean[] = Array(count).fill(false)
  const stack: number[] = [], found: number[][] = []
  let counter = 0
  // Iterative, so a long chain of steps never overflows the call stack.
  for (let root = 0; root < count; root++) {
    if (index[root] !== -1) continue
    const work: { node: number; child: number }[] = [{ node: root, child: 0 }]
    index[root] = low[root] = counter++
    stack.push(root); onStack[root] = true
    while (work.length) {
      const frame = work[work.length - 1]!
      const children = next[frame.node]!
      if (frame.child < children.length) {
        const child = children[frame.child++]!
        if (index[child] === -1) { index[child] = low[child] = counter++; stack.push(child); onStack[child] = true; work.push({ node: child, child: 0 }) }
        else if (onStack[child]) low[frame.node] = Math.min(low[frame.node]!, index[child]!)
        continue
      }
      work.pop()
      if (work.length) low[work[work.length - 1]!.node] = Math.min(low[work[work.length - 1]!.node]!, low[frame.node]!)
      if (low[frame.node] !== index[frame.node]) continue
      const members: number[] = []
      let member: number
      do { member = stack.pop()!; onStack[member] = false; members.push(member) } while (member !== frame.node)
      if (members.length > 1) found.push(members.sort((a, b) => a - b))
    }
  }
  return found.sort((a, b) => a[0]! - b[0]!)
}

// --- Flow checks: warnings, never errors (they never block Save), on the step and field they belong to ------------------------

export type FlowCheckKind = 'neverRuns' | 'loop' | 'closedLoop' | 'end'
export type FlowFix = { readonly kind: 'makeStart' } | { readonly kind: 'quit'; readonly which: FlowWhich; readonly success: boolean }
export interface FlowCheck {
  readonly kind: FlowCheckKind
  /** The step it is on, and the field: Never runs on the step, a loop on its edge back, the End on the edge past the last step. */
  readonly key: string
  readonly field: 'flow' | 'onSuccess' | 'onFail'
  readonly title: string
  readonly detail: string
  readonly fix?: FlowFix
  readonly fixLabel?: string
}

const listed = (numbers: readonly number[]) => numbers.length < 2 ? numbers.join('') : `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
const fieldOf = (which: FlowWhich): 'onSuccess' | 'onFail' => which === 'success' ? 'onSuccess' : 'onFail'
/** Where an edge that leaves a loop goes, in the loop check's words: "step 3 fails (to step 6)". */
function exitText(edge: FlowEdge): string {
  const verb = `step ${edge.from + 1} ${edge.which === 'success' ? 'succeeds' : 'fails'}`
  const target = edge.target
  const where = target.kind === 'step' ? `to step ${target.index + 1}` : target.kind === 'quit' ? `quits reporting ${target.success ? 'success' : 'failure'}` : target.kind === 'end' ? 'the job fails' : 'to a step that no longer exists'
  return `${verb} (${where})`
}
const maxExitsListed = 3

/** The flow checks, in step order: steps the Start step never reaches, loops (a warning, since Agent does not count passes), loops with no way
 *  out, and a last step that goes to the next step, which Agent runs and then fails the job ("tried to run a non-existent step"). */
export function flowChecks(draft: AgentStepsDraft, flow: StepsFlow = stepsFlow(draft)): FlowCheck[] {
  const checks: FlowCheck[] = []
  if (!flow.count) return checks
  const start = flow.start
  const startReach = flow.reachable
  draft.steps.forEach((step, at) => {
    if (flow.start < 0 || flow.reachable[at]) return
    const into = flow.edges.filter(edge => stepTarget(edge) === at && edge.from !== at)
    // Make Start step fixes it only when the steps that run now still run from this step.
    const fromHere = reach(flow.count, flow.edges, at)
    const keeps = startReach.every((runs, index) => !runs || fromHere[index])
    checks.push({
      kind: 'neverRuns', key: step.key, field: 'flow', title: `Step ${at + 1} never runs`,
      detail: `The Start step is ${start + 1} and ${into.length ? 'no step that runs' : 'no step'} goes to step ${at + 1}, so ${step.name ? `${step.name} is` : 'it is'} skipped on every scheduled run. Start at step can still run it.`,
      ...keeps ? { fix: { kind: 'makeStart' } as const, fixLabel: 'Make Start step' } : {}
    })
  })
  for (const loop of flow.loops) {
    const numbers = loop.steps.map(at => at + 1)
    const back = loop.back, step = draft.steps[back.from]!
    const backText = `Step ${back.from + 1} goes back to step ${stepTarget(back)! + 1} on ${back.which === 'success' ? 'success' : 'failure'}.`
    if (loop.closed) {
      checks.push({
        kind: 'closedLoop', key: step.key, field: fieldOf(back.which), title: `Steps ${listed(numbers)} repeat with no way out`,
        detail: `${backText} Every action of every step in the loop stays inside it, so the job never ends by itself; only Stop Job ends it. Make one of them quit or go to a step outside the loop.`
      })
      continue
    }
    const exits = loop.exits.slice(0, maxExitsListed).map(exitText)
    const more = loop.exits.length - exits.length
    checks.push({
      kind: 'loop', key: step.key, field: fieldOf(back.which), title: `Steps ${listed(numbers)} can repeat`,
      detail: `${backText} Agent does not count passes: the loop ends only when ${[...exits, ...more ? [`${more} other ${more === 1 ? 'way' : 'ways'}`] : []].join(' or ')}.`
    })
  }
  const last = draft.steps.length - 1
  for (const edge of flow.edges) {
    if (edge.target.kind !== 'end') continue
    const n = last + 1
    checks.push(edge.which === 'success'
      ? {
        kind: 'end', key: draft.steps[last]!.key, field: 'onSuccess', title: `Step ${n} goes to the next step, but it is the last step`,
        detail: `So a run that reaches step ${n} and succeeds there is reported as failed ("JobManager tried to run a non-existent step (${n + 1})"). Pick a Quit action to say how the job ends.`,
        fix: { kind: 'quit', which: 'success', success: true }, fixLabel: 'Quit reporting success'
      }
      : {
        kind: 'end', key: draft.steps[last]!.key, field: 'onFail', title: `Step ${n} goes to the next step on failure, but it is the last step`,
        detail: `When it fails, Agent reports "JobManager tried to run a non-existent step (${n + 1})" in place of the step's own failure. Quit reporting failure ends the job the same way, with the step's outcome.`,
        fix: { kind: 'quit', which: 'fail', success: false }, fixLabel: 'Quit reporting failure'
      })
  }
  const order = new Map(draft.steps.map((step, at) => [step.key, at]))
  return checks.sort((a, b) => order.get(a.key)! - order.get(b.key)!)
}

// --- Accessible names ---------------------------------------------------------------------------------------------------

/** An action in words, for a node's accessible name: "go to the next step", "go to step 3, loop". */
export function flowActionWords(edge: FlowEdge): string {
  const target = edge.target
  if (target.kind === 'quit') return `quit reporting ${target.success ? 'success' : 'failure'}`
  if (target.kind === 'end') return 'go to the next step, which fails the job'
  if (target.kind === 'missing') return 'go to a step that no longer exists'
  if (target.kind === 'unread') return `go to ${edge.action === 3 ? 'the next step' : 'step'}${target.stepId !== undefined ? ` ${target.stepId}` : ''}, past the steps Varia reads`
  if (edge.action === 3) return 'go to the next step'
  return `go to step ${target.index + 1}${edge.loop ? ', loop' : ''}`
}

// --- Layout ---------------------------------------------------------------------------------------------------------------

/** The canvas's sizes, in canvas pixels at 100 % (rx-flow): the column, a node, the gap between nodes and the lanes beside the column. */
export interface FlowMetrics {
  readonly nodeWidth: number
  readonly nodeHeight: number
  readonly pitch: number
  readonly top: number
  readonly laneGap: number
  readonly laneStep: number
  readonly margin: number
  readonly startWidth: number
}
export type FlowPoint = readonly [number, number]
export interface FlowEdgeLayout {
  readonly edge: FlowEdge
  /** The polyline from the port to the target's side or top; empty for a Quit, which is a pill under the port. */
  readonly points: readonly FlowPoint[]
  /** Where a chip or sequence badge sits: the middle of the lane, or beside a straight edge. */
  readonly mid: FlowPoint
  /** The edge runs in a lane (a jump), not straight down. */
  readonly lane?: number
}
export interface FlowLayout {
  readonly width: number
  readonly height: number
  readonly x: number
  readonly nodes: readonly { readonly x: number; readonly y: number; readonly width: number; readonly height: number }[]
  readonly edges: readonly FlowEdgeLayout[]
  /** The port centres of each step, success then failure. */
  readonly ports: readonly (readonly [FlowPoint, FlowPoint])[]
  /** The Quit pills (their top centre), also for a step that no longer exists or was not read; and an End node (its top centre) for each of
   *  the last step's actions that goes to the next step, so both have a destination when both do. */
  readonly quits: readonly { readonly edge: FlowEdge; readonly at: FlowPoint }[]
  readonly ends: readonly { readonly at: FlowPoint; readonly edge: FlowEdge }[]
  readonly start?: { readonly from: FlowPoint; readonly to: FlowPoint }
  /** The x just past the lanes on each side, for chips. */
  readonly chipLeft: number
  readonly chipRight: number
}
/** The Flow canvas's sizes at 100 % (rx-flow): a 340 × 50 node every 84 px, lanes 18 px apart starting 26 px from the column, room for the Start pill. */
export const flowMetrics: FlowMetrics = { nodeWidth: 340, nodeHeight: 50, pitch: 84, top: 40, laneGap: 26, laneStep: 18, margin: 16, startWidth: 76 }
/** The share of a node's width at which its ✓ and ✗ ports sit. */
export const flowPortShare = { success: 0.3, fail: 0.7 } as const
/** How far below the node's bottom an edge leaves its port (past the port circle), and how far down it runs before it turns into its lane. */
const portDrop = 8, turnDrop = 9
/** How far below the last node the End node sits. */
const endDrop = 22

/** Lanes for the jumps on one side: shortest spans innermost, and two jumps share a lane only when their spans do not touch. */
function lanes(jumps: readonly { readonly id: number; readonly lo: number; readonly hi: number }[]): Map<number, number> {
  const taken: { lo: number; hi: number }[][] = []
  const result = new Map<number, number>()
  for (const jump of [...jumps].sort((a, b) => (a.hi - a.lo) - (b.hi - b.lo) || a.lo - b.lo)) {
    let lane = 0
    while (taken[lane]?.some(span => span.lo <= jump.hi && jump.lo <= span.hi)) lane++
    ;(taken[lane] ??= []).push({ lo: jump.lo, hi: jump.hi })
    result.set(jump.id, lane)
  }
  return result
}

export function flowLayout(flow: StepsFlow, metrics: FlowMetrics): FlowLayout {
  const { nodeWidth: w, nodeHeight: h, pitch, top, laneGap, laneStep, margin, startWidth } = metrics
  const jumpsOf = (which: FlowWhich) => flow.edges.map((edge, id) => ({ edge, id })).filter(({ edge }) => edge.which === which && edge.target.kind === 'step' && edge.target.index !== edge.from + 1)
    .map(({ edge, id }) => ({ id, lo: Math.min(edge.from, stepTarget(edge)!), hi: Math.max(edge.from, stepTarget(edge)!) }))
  const leftLanes = lanes(jumpsOf('success')), rightLanes = lanes(jumpsOf('fail'))
  const leftCount = Math.max(0, ...[...leftLanes.values()].map(lane => lane + 1)), rightCount = Math.max(0, ...[...rightLanes.values()].map(lane => lane + 1))
  const x = margin + startWidth + laneGap + leftCount * laneStep
  const nodes = Array.from({ length: flow.count }, (_, at) => ({ x, y: top + at * pitch, width: w, height: h }))
  const ports = nodes.map(node => [[node.x + w * flowPortShare.success, node.y + h], [node.x + w * flowPortShare.fail, node.y + h]] as const)
  // Entries into a step's side, spread down its height in the order of where they come from.
  const entries = new Map<string, number[]>()
  flow.edges.forEach((edge, id) => {
    if (!leftLanes.has(id) && !rightLanes.has(id)) return
    const k = `${stepTarget(edge)}:${edge.which}`
    entries.set(k, [...entries.get(k) ?? [], id])
  })
  const entryY = (id: number, edge: FlowEdge) => {
    const list = entries.get(`${stepTarget(edge)}:${edge.which}`)!
    const sorted = [...list].sort((a, b) => flow.edges[a]!.from - flow.edges[b]!.from)
    return nodes[stepTarget(edge)!]!.y + h * (sorted.indexOf(id) + 1) / (sorted.length + 1)
  }
  const edges: FlowEdgeLayout[] = []
  const quits: { edge: FlowEdge; at: FlowPoint }[] = []
  const ends: { at: FlowPoint; edge: FlowEdge }[] = []
  flow.edges.forEach((edge, id) => {
    const [px, py] = ports[edge.from]![edge.which === 'success' ? 0 : 1]
    const y0 = py + portDrop
    const target = edge.target
    if (target.kind === 'quit' || target.kind === 'missing' || target.kind === 'unread') { quits.push({ edge, at: [px, y0 + 1] }); edges.push({ edge, points: [], mid: [px, y0] }); return }
    if (target.kind === 'end') {
      ends.push({ at: [px, y0 + endDrop + 2], edge })
      edges.push({ edge, points: [[px, y0], [px, y0 + endDrop]], mid: [px + 13, y0 + endDrop / 2] })
      return
    }
    if (target.index === edge.from + 1) {
      edges.push({ edge, points: [[px, y0], [px, nodes[target.index]!.y - 2]], mid: [px + 13, y0 + 13] })
      return
    }
    const left = edge.which === 'success'
    const lane = (left ? leftLanes : rightLanes).get(id)!
    const lx = left ? x - laneGap - lane * laneStep : x + w + laneGap + lane * laneStep
    const ye = entryY(id, edge)
    edges.push({ edge, lane, points: [[px, y0], [px, y0 + turnDrop], [lx, y0 + turnDrop], [lx, ye], [left ? x - 2 : x + w + 2, ye]], mid: [lx, (y0 + turnDrop + ye) / 2] })
  })
  const startNode = flow.start >= 0 ? nodes[flow.start] : undefined
  const sy = startNode ? startNode.y + h / 2 : 0
  const height = (nodes.length ? nodes[nodes.length - 1]!.y + h : top) + portDrop + endDrop + 30
  const chipLeft = x - laneGap - leftCount * laneStep, chipRight = x + w + laneGap + rightCount * laneStep
  return {
    // Lane chips sit past the right lanes; with none, the Quit pills stay inside the node column.
    width: chipRight + margin + (rightCount ? 120 : 0), height, x, nodes, edges, ports, quits, ends,
    ...startNode ? { start: { from: [margin + startWidth, sy] as const, to: [x - 2, sy] as const } } : {},
    chipLeft, chipRight
  }
}
