import { describe, expect, it } from 'vitest'
import { flowActionWords, flowChecks, flowLayout, flowNeverRuns, flowReachedFrom, stepsFlow, type FlowMetrics } from '../src/shared/agent/flow'
import { agentStepProblems, initialStepsDraft, newStepDraft, type AgentStepDraft, type AgentStepsDraft, type StepAction } from '../src/shared/agent/steps'

// The mocks' "Finance nightly load" (docs/mockups/sql-server-agent.html › rxFin): a step that never runs (1), the Start step (2), a loop
// (3 ⇄ 4), a forward jump that skips a step (5 → 7 on success), a backward jump that is not a loop (7 → 6 on failure).
type Go = 'next' | 'qs' | 'qf' | number
const code = (go: Go): StepAction => go === 'next' ? 3 : go === 'qs' ? 1 : go === 'qf' ? 2 : 4
function job(steps: readonly [string, Go, Go][], start = 1): AgentStepsDraft {
  const drafted = steps.map(([name, ok, fail], at): AgentStepDraft => ({
    ...newStepDraft([]), key: `s${at + 1}`, from: at + 1, name, onSuccess: code(ok), onFail: code(fail),
    ...typeof ok === 'number' ? { onSuccessTarget: `s${ok}` } : {}, ...typeof fail === 'number' ? { onFailTarget: `s${fail}` } : {}
  }))
  return { steps: drafted, startKey: `s${start}` }
}
const finance = () => job([
  ['Archive old extracts', 'next', 'next'], ['Wait for source files', 'next', 'qf'], ['Load staging package', 'next', 6], ['Validate row counts', 'next', 3],
  ['Merge facts', 7, 6], ['Notify on failure', 'qf', 'qf'], ['Process finance cube', 'qs', 6]
], 2)
const metrics: FlowMetrics = { nodeWidth: 340, nodeHeight: 50, pitch: 84, top: 40, laneGap: 26, laneStep: 18, margin: 12, startWidth: 70 }

describe('the steps flow', () => {
  it('reads where each step goes, what the Start step reaches and the loops', () => {
    const flow = stepsFlow(finance())
    expect(flow.start).toBe(1)
    expect(flow.reachable).toEqual([false, true, true, true, true, true, true])
    expect(flow.loops).toHaveLength(1)
    expect(flow.loops[0]).toMatchObject({ steps: [2, 3], closed: false, back: { from: 3, which: 'fail' } })
    expect(flow.loops[0]!.exits.map(edge => `${edge.from}${edge.which}`)).toEqual(['2fail', '3success'])
    const edge = (from: number, which: 'success' | 'fail') => flow.edges.find(item => item.from === from && item.which === which)!
    expect(edge(3, 'fail')).toMatchObject({ target: { kind: 'step', index: 2 }, loop: true })
    expect(edge(6, 'fail')).toMatchObject({ target: { kind: 'step', index: 5 }, loop: false })
    expect(edge(5, 'success')).toMatchObject({ target: { kind: 'quit', success: false } })
    expect(flowActionWords(edge(3, 'fail'))).toBe('go to step 3, loop')
    expect(flowActionWords(edge(3, 'success'))).toBe('go to the next step')
    expect(flowActionWords(edge(6, 'success'))).toBe('quit reporting success')
  })
  it('marks a go-to whose target is the step below, and draws the last step\'s next step to the End', () => {
    const flow = stepsFlow(job([['A', 2, 'qf'], ['B', 'next', 'next']]))
    expect(flow.edges[0]).toMatchObject({ marked: true, target: { kind: 'step', index: 1 } })
    expect(flow.edges[2]).toMatchObject({ marked: false, target: { kind: 'end' } })
    expect(flowActionWords(flow.edges[2]!)).toBe('go to the next step, which fails the job')
    expect(stepsFlow(job([['A', 'next', 'qf'], ['B', 'qs', 'qf']])).edges[0]).toMatchObject({ marked: false })
  })
  it('finds a loop with no way out, and treats a missing target as a way out', () => {
    const closed = stepsFlow(job([['A', 'next', 'qf'], ['B', 'next', 3], ['C', 2, 2]]))
    expect(closed.loops).toMatchObject([{ steps: [1, 2], closed: true, back: { from: 2 } }])
    const dangling: AgentStepsDraft = { ...job([['A', 2, 'qf'], ['B', 1, 1]]), steps: job([['A', 2, 'qf'], ['B', 1, 1]]).steps.map((step, at) => at === 1 ? { ...step, onFail: 4, onFailTarget: 's9' } : step) }
    expect(stepsFlow(dangling).loops).toMatchObject([{ closed: false }])
  })
  it('knows no Start step when the job\'s is not among the steps read, and then says no step never runs', () => {
    // A job with more steps than Varia reads can start past them; step 1 is not its Start step.
    const past = job([['A', 'next', 'qf'], ['B', 'qs', 'qf']], 9)
    const flow = stepsFlow(past)
    expect(flow.start).toBe(-1)
    expect(flow.reachable).toEqual([false, false])
    expect(flowLayout(flow, metrics).start).toBeUndefined()
    expect(flowChecks(past, flow).filter(check => check.kind === 'neverRuns')).toEqual([])
  })
  it('reads a long chain without overflowing', () => {
    const many = job(Array.from({ length: 5000 }, (_, at) => [`S${at}`, 'next', 'qf'] as [string, Go, Go]))
    expect(stepsFlow(many).reachable.every(Boolean)).toBe(true)
    const ring = job(Array.from({ length: 5000 }, (_, at) => [`S${at}`, at === 4999 ? 1 : 'next', at === 4999 ? 1 : 'qs'] as [string, Go, Go]))
    expect(stepsFlow(ring).loops).toHaveLength(1)
  })
})

describe('the flow checks', () => {
  it('lists the mock\'s problems: step 1 never runs and steps 3 and 4 can repeat', () => {
    const checks = flowChecks(finance())
    expect(checks.map(check => [check.kind, check.key, check.field])).toEqual([['neverRuns', 's1', 'flow'], ['loop', 's4', 'onFail']])
    expect(checks[0]).toMatchObject({ title: 'Step 1 never runs', fix: { kind: 'makeStart' }, fixLabel: 'Make Start step' })
    expect(checks[0]!.detail).toBe('The Start step is 2 and no step goes to step 1, so Archive old extracts is skipped on every scheduled run. Start at step can still run it.')
    expect(checks[1]!.title).toBe('Steps 3 and 4 can repeat')
    expect(checks[1]!.detail).toBe('Step 4 goes back to step 3 on failure. Agent does not count passes: the loop ends only when step 3 fails (to step 6) or step 4 succeeds (to step 5).')
  })
  it('offers Make Start step only when the steps that run now still run from that step', () => {
    // Step 3 never runs and goes nowhere the Start step reaches: making it the Start step would stop steps 1 and 2.
    const checks = flowChecks(job([['A', 'next', 'qf'], ['B', 'qs', 'qf'], ['C', 'qs', 'qf']]))
    expect(checks).toMatchObject([{ kind: 'neverRuns', key: 's3' }])
    expect(checks[0]).not.toHaveProperty('fix')
    // A step only an unreachable step goes to: "no step that runs".
    const chained = flowChecks(job([['A', 'qs', 'qf'], ['B', 'next', 'qf'], ['C', 'qs', 'qf']]))
    expect(chained.map(check => check.key)).toEqual(['s2', 's3'])
    expect(chained[1]!.detail).toContain('no step that runs goes to step 3')
  })
  it('warns about a loop with no way out and a last step that goes to the next step, with fixes', () => {
    expect(flowChecks(job([['A', 'next', 'qf'], ['B', 'next', 3], ['C', 2, 2]]))).toMatchObject([{ kind: 'closedLoop', key: 's3', title: 'Steps 2 and 3 repeat with no way out' }])
    const end = flowChecks(job([['A', 'next', 'qf'], ['B', 'next', 'next']]))
    expect(end.map(check => [check.kind, check.field, check.fixLabel])).toEqual([['end', 'onSuccess', 'Quit reporting success'], ['end', 'onFail', 'Quit reporting failure']])
    expect(end[0]!.detail).toContain('"JobManager tried to run a non-existent step (3)"')
  })
  it('are warnings among the steps\' problems, so List tags them too and Save is never blocked', () => {
    const problems = agentStepProblems(finance(), { sysadmin: true })
    expect(problems.filter(problem => problem.field === 'flow' || problem.message.startsWith('Steps 3 and 4'))).toMatchObject([
      { key: 's1', field: 'flow', severity: 'warning' }, { key: 's4', field: 'onFail', severity: 'warning' }
    ])
    expect(flowChecks({ steps: [] })).toEqual([])
  })
})

describe('the flow layout', () => {
  it('keeps steps in step order and puts each jump in a lane on its side, shortest innermost', () => {
    const layout = flowLayout(stepsFlow(finance()), metrics)
    expect(layout.nodes.map(node => node.y)).toEqual([40, 124, 208, 292, 376, 460, 544])
    const jump = (from: number, which: 'success' | 'fail') => layout.edges.find(item => item.edge.from === from && item.edge.which === which)!
    expect(jump(4, 'success').lane).toBe(0)
    // Failure jumps: 4 → 3 and 7 → 6 innermost; 3 → 6 spans them both, so it takes the next lane. 5 → 6 is the step below: straight.
    expect(jump(3, 'fail').lane).toBe(0)
    expect(jump(6, 'fail').lane).toBe(0)
    expect(jump(2, 'fail').lane).toBe(1)
    expect(jump(4, 'fail')).toMatchObject({ edge: { marked: true } })
    expect(jump(4, 'fail').lane).toBeUndefined()
    // Straight edges, Quit pills and the Start arrow.
    expect(jump(1, 'success').points).toEqual([[layout.x + 102, 132 + 50], [layout.x + 102, 206]])
    expect(layout.quits.map(quit => `${quit.edge.from}${quit.edge.which}`)).toEqual(['1fail', '5success', '5fail', '6success'])
    expect(layout.start).toEqual({ from: [82, 149], to: [layout.x - 2, 149] })
    expect(layout.ends).toEqual([])
  })
  it('spreads entries into one side of a step and places the End node', () => {
    const layout = flowLayout(stepsFlow(job([['A', 'next', 4], ['B', 'next', 4], ['C', 'next', 'next'], ['D', 'qs', 'qf']])), metrics)
    const entry = (from: number) => layout.edges.find(item => item.edge.from === from && item.edge.which === 'fail')!.points.at(-1)![1]
    expect([entry(0), entry(1)]).toEqual([layout.nodes[3]!.y + 50 / 3, layout.nodes[3]!.y + 100 / 3])
    const ended = flowLayout(stepsFlow(job([['A', 'next', 'qf'], ['B', 'next', 'qf']])), metrics)
    expect(ended.ends).toMatchObject([{ edge: { from: 1, which: 'success' } }])
    // Both of the last step's actions going to the next step: an End node under each port, so neither arrow ends in empty space.
    const both = flowLayout(stepsFlow(job([['A', 'next', 'qf'], ['B', 'next', 'next']])), metrics)
    expect(both.ends.map(end => end.edge.which)).toEqual(['success', 'fail'])
    expect(both.ends[0]!.at[0]).toBe(both.ports[1]![0][0])
    expect(both.ends[1]!.at[0]).toBe(both.ports[1]![1][0])
  })
  it('draws a cut job\'s go-tos past the steps read, and its last read step\'s next step, as steps not read', () => {
    // A 51-step job read to step 50 (as here, to step 2): step 2 goes on to step 3 and jumps to step 9, both unread, neither End nor missing.
    const cut = job([['A', 'next', 'qf'], ['B', 'next', 9]])
    const flow = stepsFlow(cut, true)
    expect(flow.edges[2]!.target).toEqual({ kind: 'unread', stepId: 3 })
    expect(flow.edges[3]!.target).toEqual({ kind: 'unread', stepId: 9 })
    expect(flowActionWords(flow.edges[2]!)).toBe('go to the next step 3, past the steps Varia reads')
    expect(flowActionWords(flow.edges[3]!)).toBe('go to step 9, past the steps Varia reads')
    const layout = flowLayout(flow, metrics)
    expect(layout.ends).toEqual([])
    expect(layout.quits.map(quit => `${quit.edge.from}${quit.edge.which}`)).toEqual(['0fail', '1success', '1fail'])
    // The whole job read: the same steps end and miss.
    expect(stepsFlow(cut).edges.slice(2).map(edge => edge.target.kind)).toEqual(['end', 'missing'])
  })
  it('gives the Start arrow its own place on the Start step, apart from a jump back to it', () => {
    // Step 2 succeeds back to step 1, the Start step: the jump's arrow and Start's end on the same side, at different heights.
    const layout = flowLayout(stepsFlow(job([['A', 'next', 'qf'], ['B', 1, 'qf']])), metrics)
    const back = layout.edges.find(item => item.edge.from === 1 && item.edge.which === 'success')!, node = layout.nodes[0]!
    const end = back.points[back.points.length - 1]!
    expect(end[0]).toBe(layout.start!.to[0])
    expect(layout.start!.to[1]).toBeCloseTo(node.y + node.height / 3)
    expect(end[1]).toBeCloseTo(node.y + node.height * 2 / 3)
  })
  it("keeps a cut job's Start and reachability open where a step not read could change them", () => {
    // A 51-step job read to step 50 that starts at step 51, which jumps back to step 2: the draft as Varia builds it falls back to step 1.
    const records = Array.from({ length: 50 }, (_, at) => ({ id: at + 1, name: `Step ${at + 1}`, subsystem: 'TSQL', onSuccessAction: 2, onFailAction: 2 }))
    const draft = initialStepsDraft(records, 51)
    expect(draft.startKey).toBe('s1')
    const flow = stepsFlow(draft, true, 51)
    expect(flow).toMatchObject({ start: -1, startUnread: 51, partial: true })
    expect(flowLayout(flow, metrics).start).toBeUndefined()
    expect(flowNeverRuns(flow, 1)).toBe(false)
    expect(flowReachedFrom(flow, 1)).toBe('perhaps steps Varia does not read')
    // Its Start read: that step, not the draft's fallback; what reaches a step still qualified.
    const read = stepsFlow(initialStepsDraft(records, 7), true, 7)
    expect(read).toMatchObject({ start: 6, partial: true })
    expect(read.startUnread).toBeUndefined()
    expect(flowReachedFrom(read, 6)).toBe("The job's start, perhaps steps Varia does not read")
    // The whole job read: a step nothing reaches never runs.
    const whole = stepsFlow(job([['A', 'qs', 'qf'], ['B', 'qs', 'qf']]))
    expect(flowNeverRuns(whole, 1)).toBe(true)
    expect(flowReachedFrom(whole, 1)).toBe('No step')
  })
})
