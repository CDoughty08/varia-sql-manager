import { describe, expect, it } from 'vitest'
import { stepsFlow } from '../src/shared/agent/flow'
import { currentStepSeconds, lastRunDrawing, liveRunDrawing, nextWords, runPasses, runStepIndex } from '../src/shared/agent/flow-run'
import type { JobHistoryStep } from '../src/shared/agent/job-history'
import { newStepDraft, type AgentStepDraft, type AgentStepsDraft, type StepAction } from '../src/shared/agent/steps'

// The fake backend's flow-run Nightly (tests/fixtures/backend.mjs › agent-flow-runs): 1 ✓ next ✗ quit failure; 2 ✓ next ✗ go to 1;
// 3 ✓ quit success ✗ go to 4; 4 quits reporting failure either way.
type Go = 'next' | 'qs' | 'qf' | number
const code = (go: Go): StepAction => go === 'next' ? 3 : go === 'qs' ? 1 : go === 'qf' ? 2 : 4
function job(steps: readonly [string, Go, Go][]): AgentStepsDraft {
  const drafted = steps.map(([name, ok, fail], at): AgentStepDraft => ({
    ...newStepDraft([]), key: `s${at + 1}`, from: at + 1, name, onSuccess: code(ok), onFail: code(fail),
    ...typeof ok === 'number' ? { onSuccessTarget: `s${ok}` } : {}, ...typeof fail === 'number' ? { onFailTarget: `s${fail}` } : {}
  }))
  return { steps: drafted, startKey: 's1' }
}
const nightly = () => job([['Check integrity', 'next', 'qf'], ['Rebuild indexes', 'next', 1], ['Update statistics', 'qs', 4], ['Notify operators', 'qf', 'qf']])
let instance = 0
const row = (stepId: number, name: string, outcome: string, started: string, seconds?: number): JobHistoryStep => ({
  instance: ++instance, stepId, name, outcome, started, ...seconds !== undefined ? { seconds } : {}, duration: '', retries: 0, message: `${name}: ${outcome}`,
  tone: outcome === 'Failed' ? 'error' : outcome === 'Retry' ? 'muted' : 'ok'
})
// The newest failed run: 1 retried once then ✓, 2 ✗ back to 1, 1 ✓, 2 ✓, 3 ✗ to 4, 4 ✓ (which quits reporting failure).
const failedRun = () => [
  row(1, 'Check integrity', 'Retry', '2026-11-09 02:00:00', 4), row(1, 'Check integrity', 'Succeeded', '2026-11-09 02:00:34', 6),
  row(2, 'Rebuild indexes', 'Failed', '2026-11-09 02:00:40', 20), row(1, 'Check integrity', 'Succeeded', '2026-11-09 02:01:00', 5),
  row(2, 'Rebuild indexes', 'Succeeded', '2026-11-09 02:01:05', 55), row(3, 'Update statistics', 'Failed', '2026-11-09 02:02:00', 3),
  row(4, 'Notify operators', 'Succeeded', '2026-11-09 02:02:03', 1), row(0, '(Job outcome)', 'Failed', '2026-11-09 02:00:00', 124)
]

describe('the Flow view\'s run overlays', () => {
  it('reads a run\'s rows as passes: retries with their step, the job row left out, loops as more than one pass', () => {
    const passes = runPasses([...failedRun()].reverse(), nightly().steps)
    expect(passes.map(pass => `${pass.at}${pass.tone}`)).toEqual(['0ok', '1bad', '0ok', '1ok', '2bad', '3ok'])
    expect(passes[0]).toMatchObject({ retries: 1, seconds: 10, outcome: 'Succeeded' })
    expect(passes[1]!.retries).toBe(0)
  })
  it('leaves out a running step\'s trailing retries, and a pass with a row of no duration has none', () => {
    const rows = [row(1, 'Check integrity', 'Succeeded', '2026-11-09 02:00:00'), row(2, 'Rebuild indexes', 'Retry', '2026-11-09 02:00:10', 3)]
    const passes = runPasses(rows, nightly().steps)
    expect(passes).toHaveLength(1)
    expect(passes[0]!.seconds).toBeUndefined()
  })
  it('matches history to the draft by a name one step has, else by the saved id', () => {
    const steps = [{ from: 1, name: 'A' }, { from: 2, name: 'B' }, { from: 3, name: 'B' }]
    expect(runStepIndex(steps, { stepId: 9, name: 'A' })).toBe(0)
    expect(runStepIndex(steps, { stepId: 3, name: 'B' })).toBe(2)
    expect(runStepIndex(steps, { stepId: 2, name: 'Renamed' })).toBe(1)
    expect(runStepIndex(steps, { stepId: 7, name: 'Gone' })).toBe(-1)
  })
  it('draws Last run: the path bold and numbered, an edge taken twice numbered twice, the last pass to its quit', () => {
    const flow = stepsFlow(nightly())
    const drawing = lastRunDrawing(flow, runPasses(failedRun(), nightly().steps), true)
    expect([...drawing.hot].sort()).toEqual(['0:success', '1:fail', '1:success', '2:fail', '3:success'])
    expect(Object.fromEntries(drawing.sequence)).toEqual({ '0:success': '1 · 3', '1:fail': '2', '1:success': '4', '2:fail': '5' })
    expect(drawing.steps[0]!.right.map(part => part.text)).toEqual(['1 retry', '×2', '✓ 00:00:10', '✓ 00:00:05'])
    expect(drawing.steps[1]!.right.map(part => part.text)).toEqual(['×2', '✗ 00:00:20', '✓ 00:00:55'])
    expect(drawing.steps[2]).toMatchObject({ fade: false, right: [{ text: '✗ 00:00:03', tone: 'bad' }] })
    expect(drawing.unplaced).toBe(0)
  })
  it('fades the steps a run never reached, leaves off an edge the draft has changed since, and counts passes of deleted steps', () => {
    const changed = job([['Check integrity', 'next', 'qf'], ['Rebuild indexes', 'qs', 1], ['Update statistics', 'qs', 4], ['Notify operators', 'qf', 'qf']])
    const rows = [row(1, 'Check integrity', 'Succeeded', '2026-11-09 02:00:00', 1), row(2, 'Rebuild indexes', 'Succeeded', '2026-11-09 02:00:01', 1),
      row(3, 'Update statistics', 'Succeeded', '2026-11-09 02:00:02', 1), row(8, 'Dropped step', 'Succeeded', '2026-11-09 02:00:03', 1)]
    const drawing = lastRunDrawing(stepsFlow(changed), runPasses(rows, changed.steps), true)
    expect(drawing.hot.has('1:success')).toBe(false)
    expect(drawing.hot.has('0:success')).toBe(true)
    expect(drawing.steps[3]).toMatchObject({ fade: true, right: [{ text: 'Not run' }] })
    expect(drawing.unplaced).toBe(1)
  })
  it('draws Live run: the current step ringed with its time, usual and bar, both its edges lit, the rest Waiting or On failure only', () => {
    const flow = stepsFlow(nightly())
    const passes = runPasses([row(1, 'Check integrity', 'Succeeded', '2026-11-09 02:00:00', 4)], nightly().steps)
    const drawing = liveRunDrawing(flow, passes, { at: 1, retrying: false, seconds: 30, usual: 60 }, true)
    expect(drawing.steps[1]).toMatchObject({ current: true, bar: 0.5, right: [{ text: '▶ 00:00:30', tone: 'run' }, { text: 'usual 00:01:00' }] })
    expect([...drawing.lit].sort()).toEqual(['1:fail', '1:success'])
    expect([...drawing.hot]).toEqual(['0:success'])
    expect(drawing.sequence.get('0:success')).toBe('1')
    expect(drawing.steps[2]!.right[0]!.text).toBe('Waiting')
    expect(drawing.steps[3]!.right[0]!.text).toBe('On failure only')
    const unknown = liveRunDrawing(flow, passes, { at: 1, retrying: true }, false)
    expect(unknown.steps[1]!.right[0]!.text).toBe('▶ Between retries')
    expect(unknown.steps[0]).toMatchObject({ fade: true, right: [{ text: '—' }] })
    expect(unknown.hot.size).toBe(0)
    // Step 2 again after failing back to step 1: its failed pass stays before the running one.
    const again = runPasses([row(1, 'Check integrity', 'Succeeded', '2026-11-09 02:00:00', 4), row(2, 'Rebuild indexes', 'Failed', '2026-11-09 02:00:04', 9), row(1, 'Check integrity', 'Succeeded', '2026-11-09 02:00:13', 5)], nightly().steps)
    expect(liveRunDrawing(flow, again, { at: 1, retrying: false, seconds: 4 }, true).steps[1]!.right.map(part => part.text)).toEqual(['✗ 00:00:09', '▶ 00:00:04'])
  })
  it('says where the current step goes next, and how long it has run from the server\'s clock', () => {
    const flow = stepsFlow(nightly())
    expect(nextWords(flow, 1, 'success')).toBe('step 3')
    expect(nextWords(flow, 0, 'fail')).toBe('quit reporting failure')
    expect(nextWords(flow, 2, 'success')).toBe('quit reporting success')
    expect(nextWords(stepsFlow(job([['A', 'next', 'qf']])), 0, 'success')).toBe('the end (the job fails)')
    const rows = [row(1, 'Check integrity', 'Succeeded', '2026-11-09 02:00:00', 10)]
    expect(currentStepSeconds(rows, 20261109020000, 20261109020025)).toBe(15)
    expect(currentStepSeconds([], 20261109020000, 20261109020025)).toBe(25)
    expect(currentStepSeconds([], undefined, 20261109020025)).toBeUndefined()
    expect(currentStepSeconds(rows, 20261109020000, undefined)).toBeUndefined()
  })
})
