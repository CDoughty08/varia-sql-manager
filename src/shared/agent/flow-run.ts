// The Flow view's run overlays (docs/sql-server-agent.md › Steps › Flow; docs/agent-ui-rethink.md › Flow view, decisions 4 and 5): a run's
// history rows as passes over the steps, and what the graph draws for them. Run draws one finished (or running) run: the path it took
// in bold with the order on each edge, each step's outcome and duration (×N and each pass for a step a loop ran more than once), and the
// steps it never reached faded. Live run adds the current step, from the job header's live state, and the two ways it can go next.
import { flowEdgeKey, type FlowTarget, type FlowWhich, type StepsFlow } from './flow.ts'
import { durationText, stampSeconds, type JobHistoryStep } from './job-history.ts'

/** One pass of a step: its rows up to and including its first row that is not a Retry, so ×N counts passes, not rows. */
export interface FlowPass {
  /** The step's index in the draft, or -1 when no step of the draft is the one history names (deleted since). */
  readonly at: number
  readonly stepId: number
  readonly name: string
  /** Its last row: how the pass ended. */
  readonly outcome: string
  readonly tone: 'ok' | 'bad' | 'muted'
  /** The rows' seconds added up (its retries' too), where every row has one. */
  readonly seconds?: number
  readonly retries: number
  readonly rows: readonly JobHistoryStep[]
}

/** A draft step as history is matched to it: its saved id (`from`) and name. */
export interface FlowRunStep { readonly from?: number; readonly name: string }
const retryOutcome = 'Retry'
const toneOf = (row: JobHistoryStep): FlowPass['tone'] => row.tone === 'error' ? 'bad' : row.tone === 'muted' ? 'muted' : 'ok'

/**
 * The draft step a history row names. History records the step's id and name as they were when it ran, and a reorder since moves ids, so a
 * name that one step of the draft has wins (as History's Edit step finds it); else the saved step with that id, when it was renamed since.
 * A step whose own name the run also recorded is not a renamed one: the id moved to it when an earlier step was deleted, so the row's step
 * is gone (`names` holds every step name in the run's rows).
 */
export function runStepIndex(steps: readonly FlowRunStep[], row: { readonly stepId: number; readonly name: string }, names?: ReadonlySet<string>): number {
  const named = steps.flatMap((step, at) => step.name === row.name ? [at] : [])
  if (named.length === 1) return named[0]!
  const at = steps.findIndex(step => step.from === row.stepId)
  return at >= 0 && steps[at]!.name !== row.name && names?.has(steps[at]!.name) ? -1 : at
}

/**
 * A run's step rows (the job outcome row, step 0, is left out) as passes, in the order they ran. A run that is still going can end with
 * Retry rows of a step that has not finished: they are left out, since that pass has no outcome yet.
 */
export function runPasses(rows: readonly JobHistoryStep[], steps: readonly FlowRunStep[]): FlowPass[] {
  const ordered = rows.filter(row => row.stepId > 0).sort((a, b) => a.instance - b.instance)
  const names = new Set(ordered.map(row => row.name))
  const passes: FlowPass[] = []
  let pending: JobHistoryStep[] = []
  for (const row of ordered) {
    // Retries belong to the pass of the step they retried; a Retry row of another step starts that step's pass afresh.
    if (pending.length && pending[0]!.stepId !== row.stepId) pending = []
    pending.push(row)
    if (row.outcome === retryOutcome) continue
    const own = pending
    pending = []
    const seconds = own.every(item => item.seconds !== undefined) ? own.reduce((sum, item) => sum + item.seconds!, 0) : undefined
    passes.push({ at: runStepIndex(steps, row, names), stepId: row.stepId, name: row.name, outcome: row.outcome, tone: toneOf(row), ...seconds !== undefined ? { seconds } : {}, retries: own.length - 1, rows: own })
  }
  return passes
}

/**
 * What the canvas draws for a run: per step its state words, faded or current; the path's edges bold, with the order each was taken. `spoken`
 * says the same in words for the step's accessible name (the node's glyphs read badly), with every pass the node may leave out.
 */
export interface FlowRunDrawing {
  readonly steps: readonly { readonly fade: boolean; readonly current?: boolean; readonly bar?: number; readonly right: readonly { readonly text: string; readonly tone: 'ok' | 'bad' | 'muted' | 'run' }[]; readonly spoken: string }[]
  readonly hot: ReadonlySet<string>
  /** Edges shown at full strength without being on the path: Live run's two ways the current step can go next. */
  readonly lit: ReadonlySet<string>
  readonly sequence: ReadonlyMap<string, string>
  /** Passes whose step the draft no longer has (deleted since the run): the panel lists them, the graph cannot. */
  readonly unplaced: number
}

const whichOf = (pass: FlowPass): FlowWhich | undefined => pass.tone === 'ok' ? 'success' : pass.tone === 'bad' ? 'fail' : undefined
// A cut job's go-to past the steps Varia reads leads to a next pass that no read step is (-1), the step it names when the go-to names one.
const leadsTo = (target: FlowTarget | undefined, next: FlowPass | undefined): boolean =>
  target?.kind === 'unread' ? !!next && next.at < 0 && (target.stepId === undefined || target.stepId === next.stepId)
    : next ? target?.kind === 'step' && target.index === next.at : target?.kind === 'quit' || target?.kind === 'end'
const glyph = { ok: '✓', bad: '✗', muted: '–' } as const

/**
 * The path a run took over the graph. Each pass's edge (success after a success, failure after a failure) is on the path when it leads to the
 * next pass's step, or, for the run's last pass, to a Quit or the End; the order badges number those edges, joined for an edge taken twice.
 * An edge the draft has changed since the run, so it no longer leads where the run went, is left off rather than drawn wrong.
 */
function runPath(flow: StepsFlow, passes: readonly FlowPass[], finished: boolean): { hot: Set<string>; sequence: Map<string, string> } {
  const hot = new Set<string>(), order = new Map<string, number[]>()
  passes.forEach((pass, index) => {
    const which = whichOf(pass), next = passes[index + 1]
    if (pass.at < 0 || !which || (!next && !finished)) return
    const key = flowEdgeKey(pass.at, which), edge = flow.edges[pass.at * 2 + (which === 'success' ? 0 : 1)]
    if (!leadsTo(edge?.target, next)) return
    hot.add(key)
    if (next) (order.get(key) ?? order.set(key, []).get(key)!).push(index + 1)
  })
  return { hot, sequence: new Map([...order].map(([key, numbers]) => [key, numbers.join(' · ')])) }
}

/** The most passes a node lists; ×N still counts them all, and the panel and the accessible name have every one. */
export const flowNodePasses = 2
/**
 * Each step's words for a run: its retries, ×N for more than one pass, and each pass's glyph and duration: the last `flowNodePasses` of
 * them (the running step's last one, beside its ▶), so a loop that ran a step many times still fits on its node.
 */
function stepWords(passes: readonly FlowPass[], most = flowNodePasses): FlowRunDrawing['steps'][number]['right'] {
  const words: { text: string; tone: 'ok' | 'bad' | 'muted' | 'run' }[] = []
  const retries = passes.reduce((sum, pass) => sum + pass.retries, 0)
  if (retries) words.push({ text: `${retries} ${retries === 1 ? 'retry' : 'retries'}`, tone: 'muted' })
  if (passes.length > 1) words.push({ text: `×${passes.length}`, tone: 'muted' })
  if (passes.length > most) words.push({ text: '…', tone: 'muted' })
  for (const pass of passes.slice(-most)) words.push({ text: `${glyph[pass.tone]} ${pass.seconds !== undefined ? durationText(pass.seconds) : pass.outcome}`, tone: pass.tone })
  return words
}
/** A pass in words: "succeeded in 00:00:15 after 1 retry". */
const passSpoken = (pass: FlowPass): string =>
  `${pass.outcome.toLowerCase()}${pass.seconds !== undefined ? ` in ${durationText(pass.seconds)}` : ''}${pass.retries ? ` after ${pass.retries} ${pass.retries === 1 ? 'retry' : 'retries'}` : ''}`
/** A step's passes in words: "ran 2 times: failed in 00:00:20, then succeeded in 00:00:33". */
function stepSpoken(passes: readonly FlowPass[]): string {
  if (passes.length === 1) return passSpoken(passes[0]!)
  return `ran ${passes.length} times: ${passes.map(passSpoken).join(', then ')}`
}

/**
 * Run: the run's passes over the steps; steps it never reached are faded and say Not run. With the run's rows cut (`cut`: History read
 * only its first rows) the run went on past the last pass read, so its last edge is not drawn and an unreached step is not known, not Not run.
 */
export function lastRunDrawing(flow: StepsFlow, passes: readonly FlowPass[], finished: boolean, cut = false): FlowRunDrawing {
  const { hot, sequence } = runPath(flow, passes, finished && !cut)
  const steps = Array.from({ length: flow.count }, (_, at) => {
    const own = passes.filter(pass => pass.at === at)
    if (own.length) return { fade: false, right: stepWords(own), spoken: stepSpoken(own) }
    return cut ? { fade: true, right: [{ text: '—', tone: 'muted' as const }], spoken: 'not known: past the rows History reads' }
      : { fade: true, right: [{ text: 'Not run', tone: 'muted' as const }], spoken: 'not run' }
  })
  return { steps, hot, lit: new Set(), sequence, unplaced: passes.filter(pass => pass.at < 0).length }
}

/** The live run's current step, from the header's live state, with how long it has run and its usual time. */
export interface FlowLiveStep { readonly at: number; readonly retrying: boolean; readonly seconds?: number; readonly usual?: number }

/**
 * Live run: finished passes as Run draws them (the current step's own before its ▶), the current step ringed with a bar against its usual time and both its edges lit, and
 * the steps still to come faded: Waiting where the steps that ran so far lead, else On failure only (reached only by a failure edge).
 * Without this run's rows (`known` false) only the current step is known; the rest say nothing rather than Waiting.
 */
export function liveRunDrawing(flow: StepsFlow, passes: readonly FlowPass[], current: FlowLiveStep | undefined, known: boolean): FlowRunDrawing {
  const shown = known ? passes : []
  const { hot, sequence } = runPath(flow, current && current.at >= 0 ? [...shown, { at: current.at } as FlowPass] : shown, false)
  const lit = new Set<string>()
  if (current && current.at >= 0) for (const which of ['success', 'fail'] as const) lit.add(flowEdgeKey(current.at, which))
  const origin = current && current.at >= 0 && current.at < flow.count ? current.at : shown.length === 0 ? flow.start : -1
  const bySuccess = reach(flow, origin, false)
  const byAny = reach(flow, origin, true)
  const steps = Array.from({ length: flow.count }, (_, at) => {
    if (current?.at === at) {
      // A step a loop runs again keeps its finished passes before the running one.
      const words: { text: string; tone: 'ok' | 'bad' | 'muted' | 'run' }[] = [...stepWords(shown.filter(pass => pass.at === at), 1), { text: `▶ ${current.seconds !== undefined ? durationText(current.seconds) : current.retrying ? 'Between retries' : 'Executing'}`, tone: 'run' as const }]
      if (current.usual !== undefined) words.push({ text: `usual ${durationText(current.usual)}`, tone: 'muted' as const })
      const bar = current.seconds !== undefined && current.usual ? Math.min(1, current.seconds / current.usual) : undefined
      const before = shown.filter(pass => pass.at === at)
      const running = `${current.retrying ? 'between retries' : 'running'}${current.seconds !== undefined ? ` for ${durationText(current.seconds)}` : ''}${current.usual !== undefined ? `, usual ${durationText(current.usual)}` : ''}`
      return { fade: false, current: true, ...bar !== undefined ? { bar } : {}, right: words, spoken: before.length ? `${stepSpoken(before)}; now ${running}` : running }
    }
    const own = shown.filter(pass => pass.at === at)
    if (own.length) return { fade: false, right: stepWords(own), spoken: stepSpoken(own) }
    if (!known || origin < 0) return { fade: true, right: [{ text: '—', tone: 'muted' as const }], spoken: 'not known yet' }
    if (bySuccess[at]) return { fade: true, right: [{ text: 'Waiting', tone: 'muted' as const }], spoken: 'waiting' }
    if (byAny[at]) return { fade: true, right: [{ text: 'On failure only', tone: 'muted' as const }], spoken: 'runs only after a failure' }
    return { fade: true, right: [{ text: 'Not run', tone: 'muted' as const }], spoken: 'not run' }
  })
  return { steps, hot, lit, sequence, unplaced: shown.filter(pass => pass.at < 0).length }
}

/** The steps reachable from `origin` through success edges only (`includeFail` false) or through either edge (`includeFail` true). */
function reach(flow: StepsFlow, origin: number, includeFail: boolean): boolean[] {
  const seen = Array.from({ length: flow.count }, () => false)
  if (origin < 0 || origin >= flow.count) return seen
  const queue = [origin]
  seen[origin] = true
  while (queue.length) {
    const at = queue.shift()!
    for (let offset = 0; offset < (includeFail ? 2 : 1); offset++) {
      const target = flow.edges[at * 2 + offset]?.target
      if (target?.kind === 'step' && !seen[target.index]) { seen[target.index] = true; queue.push(target.index) }
    }
  }
  return seen
}

/** Where the current step can go next, in words: "step 4 on success · step 6 on failure", or a Quit or the End. */
export function nextWords(flow: StepsFlow, at: number, which: FlowWhich): string {
  const target = flow.edges[at * 2 + (which === 'success' ? 0 : 1)]?.target
  if (!target) return '—'
  if (target.kind === 'step') return `step ${target.index + 1}`
  if (target.kind === 'quit') return target.success ? 'quit reporting success' : 'quit reporting failure'
  if (target.kind === 'end') return 'the end (the job fails)'
  if (target.kind === 'unread') return `${target.stepId !== undefined ? `step ${target.stepId}` : 'the next step'}, past the steps Varia reads`
  return 'a step that no longer exists'
}

/**
 * How long the current step has run: the server's clock less the end of this run's last finished row (its start plus its duration), or less the
 * run's start before any row; undefined where a time is not readable. msdb writes a step's row only when it ends, so this is the one estimate.
 * Without this run's rows (`known` false) only the run's start is known, which is the current step's start only at step 1 (`step`).
 */
export function currentStepSeconds(rows: readonly JobHistoryStep[], started: number | undefined, now: number | undefined, known = true, step = 1): number | undefined {
  const nowSeconds = now ? stampSeconds(now) : undefined
  if (nowSeconds === undefined || (!known && step > 1)) return undefined
  let from = started ? stampSeconds(started) : undefined
  for (const row of rows) {
    if (row.stepId <= 0 || row.seconds === undefined) continue
    const digits = row.started.replace(/\D/g, '').slice(0, 14)
    const begun = digits.length === 14 ? stampSeconds(Number(digits)) : undefined
    if (begun !== undefined && (from === undefined || begun + row.seconds > from)) from = begun + row.seconds
  }
  return from === undefined || nowSeconds < from ? undefined : nowSeconds - from
}
