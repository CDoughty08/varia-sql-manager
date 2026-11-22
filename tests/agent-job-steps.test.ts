import { describe, expect, it } from 'vitest'
import { agentJobChangeCount, agentJobCompare, agentJobProblems, agentJobSave, agentJobSaveProblems, agentJobSaveSchema, initialAgentJobDraft, rebaseAgentJobDraft, type AgentJobDocumentModel, type AgentJobDraft } from '../src/shared/actions/agent-job'
import { agentJobSaveCalls, agentLimits, stepFlags } from '../src/shared/agent/catalog'
import {
  addStep, agentStepProblems, agentStepsSaveProblems, agentStepsSaveSchema, deleteStep, initialStepsDraft, moveStep, newStepDraft, planAgentSteps, stepFlagChoices, stepFlagsWith,
  stepOptionsSummary, stepTargetShort, stepText, temporaryStepPrefix, undoStepDeletion, withSubsystem, type AgentJobStepRecord, type AgentStepDraft, type AgentStepsDraft, type AgentStepsSave, type AgentStepWrite
} from '../src/shared/agent/steps'
import {
  buildSsisCommand, newSsisCommand, parseSsisCommand, ssisAdvancedSummary, ssisParameterRows, ssisProblems, withSsisPackage, withSsisParameter
} from '../src/shared/agent/ssis-step'
import type { SsisParameter } from '../src/shared/ssis/schema'

const step = (id: number, name: string, patch: Partial<AgentJobStepRecord> = {}): AgentJobStepRecord => ({
  id, name, subsystem: 'TSQL', command: `-- ${name}`, flags: 0, cmdexecSuccessCode: 0, onSuccessAction: 3, onSuccessStepId: 0, onFailAction: 2, onFailStepId: 0, server: '', databaseName: 'master',
  databaseUserName: '', retryAttempts: 0, retryInterval: 0, osRunPriority: 0, outputFileName: '', proxyId: 0, ...patch
})
/** Index maintenance from the mocks: steps 2 and 3 go to step 4 on failure. */
const described = [
  step(1, 'Check integrity'), step(2, 'Rebuild', { onFailAction: 4, onFailStepId: 4 }), step(3, 'Statistics', { onSuccessAction: 1, onFailAction: 4, onFailStepId: 4 }),
  step(4, 'Notify', { subsystem: 'PowerShell', databaseName: '', onSuccessAction: 2, flags: 32 | 64 & 0 })
]
let guidAt = 0
const guid = () => (++guidAt).toString(16).padStart(32, '0')
const plan = (draft: AgentStepsDraft, start = 1) => { guidAt = 0; return planAgentSteps(described, draft, start, guid) }
const opened = () => initialStepsDraft(described, 1)
/** What msdb holds after the planner's calls run in order: a simulation of sp_delete_jobstep, sp_update_jobstep and sp_add_jobstep's
 *  renumbering (their go-to rewrites are overwritten by the writes, so only content by id matters). */
function simulate(before: readonly AgentJobStepRecord[], save: AgentStepsSave): Map<number, AgentStepWrite | { name: string }> {
  let steps: { name: string; write?: AgentStepWrite }[] = [...before].sort((a, b) => a.id - b.id).map(item => ({ name: item.name }))
  const names = () => new Set(steps.map(item => item.name))
  for (const id of save.deletes ?? []) { expect(id).toBeLessThanOrEqual(steps.length); steps.splice(id - 1, 1) }
  for (const item of save.temporary ?? []) { expect(names().has(item.name)).toBe(false); steps[item.id - 1]!.name = item.name }
  for (const item of save.adds ?? []) { expect(item.id).toBeLessThanOrEqual(steps.length + 1); expect(names().has(item.name)).toBe(false); steps.splice(item.id - 1, 0, { name: item.name }) }
  for (const write of save.writes ?? []) {
    const others = steps.filter((_, at) => at !== write.id - 1).map(item => item.name)
    // sp_verify_jobstep checks a new name against every step (14261).
    expect(others).not.toContain(write.name)
    steps[write.id - 1] = { name: write.name, write }
  }
  return new Map(steps.map((item, at) => [at + 1, item.write ?? { name: item.name }]))
}
const names = (state: Map<number, AgentStepWrite | { name: string }>) => [...state.values()].map(item => item.name)

describe('the step save planner', () => {
  it('sends nothing for an untouched draft, and only the edited step when nothing moves', () => {
    expect(plan(opened())).toBeUndefined()
    const draft = opened()
    const edited = { ...draft, steps: draft.steps.map(item => item.key === 's2' ? { ...item, command: 'EXEC dbo.IndexOptimize' } : item) }
    const save = plan(edited)!
    expect(save.writes?.map(write => [write.id, write.command])).toEqual([[2, 'EXEC dbo.IndexOptimize']])
    expect(save.deletes ?? save.temporary ?? save.adds ?? save.startStepId).toBeUndefined()
    expect(plan({ ...draft, startKey: 's3' })).toEqual({ startStepId: 3 })
  })
  it('swaps two steps by writing their contents into each other\'s ids, every survivor under a temporary name first, targets following', () => {
    const swapped = moveStep(opened(), 's4', 0)
    const save = plan(swapped)!
    expect(save.deletes).toBeUndefined()
    expect(save.temporary?.map(item => item.id)).toEqual([1, 2, 3, 4])
    expect(save.temporary?.every(item => item.name.startsWith(temporaryStepPrefix) && item.name.length < 128)).toBe(true)
    const state = simulate(described, save)
    expect(names(state)).toEqual(['Notify', 'Check integrity', 'Rebuild', 'Statistics'])
    // Rebuild and Statistics went to Notify (was 4) on failure: now 1.
    expect((state.get(3) as AgentStepWrite).onFailStepId).toBe(1)
    expect((state.get(4) as AgentStepWrite).onFailStepId).toBe(1)
    expect(save.startStepId).toBe(2)
  })
  it('rotates, inserts ahead of an unmoved step, renames into another step\'s old name and reuses a renamed step\'s name', () => {
    const rotated = moveStep(opened(), 's1', 3)
    expect(names(simulate(described, plan(rotated)!))).toEqual(['Rebuild', 'Statistics', 'Notify', 'Check integrity'])

    const inserted = addStep(opened(), { ...newStepDraft(opened().steps), name: 'Backup' }, 1)
    const insertSave = plan(inserted)!
    expect(insertSave.adds?.map(item => item.id)).toEqual([2])
    const insertState = simulate(described, insertSave)
    expect(names(insertState)).toEqual(['Check integrity', 'Backup', 'Rebuild', 'Statistics', 'Notify'])
    expect((insertState.get(3) as AgentStepWrite).onFailStepId).toBe(5)

    const renamed = opened()
    const swappedNames = { ...renamed, steps: renamed.steps.map(item => item.key === 's1' ? { ...item, name: 'Rebuild' } : item.key === 's2' ? { ...item, name: 'Check integrity' } : item) }
    expect(names(simulate(described, plan(swappedNames)!))).toEqual(['Rebuild', 'Check integrity', 'Statistics', 'Notify'])

    const reused = addStep({ ...renamed, steps: renamed.steps.map(item => item.key === 's3' ? { ...item, name: 'Update statistics' } : item) }, { ...newStepDraft(renamed.steps), name: 'Statistics' })
    expect(names(simulate(described, plan(reused)!))).toEqual(['Check integrity', 'Rebuild', 'Update statistics', 'Notify', 'Statistics'])
  })
  it('deletes from the highest id down, and a delete retargets the steps that went to it as SSMS does', () => {
    const removed = deleteStep(opened(), 's4')!
    expect(removed.deletion.retargeted).toEqual(['s2', 's3'])
    expect(removed.draft.steps.find(item => item.key === 's2')).toMatchObject({ onFail: 2 })
    expect(removed.draft.steps.find(item => item.key === 's2')).not.toHaveProperty('onFailTarget')
    const twice = deleteStep(removed.draft, 's1')!
    expect(twice.deletion.startMoved).toBe(true)
    expect(twice.draft.startKey).toBe('s2')
    const save = plan(twice.draft)!
    expect(save.deletes).toEqual([4, 1])
    expect(names(simulate(described, save))).toEqual(['Rebuild', 'Statistics'])
    expect(save.startStepId).toBe(1)
    expect(stepText.retargeted([2, 3])).toBe('Steps 2 and 3 went to it; they now quit reporting failure.')
    // Undo is the draft before the delete.
    expect(removed.deletion.before).toEqual(opened())
  })
  it('undoes a delete into the current draft: the step back in place, its referrers going to it again unless edited since, and the Start step back', () => {
    const removed = deleteStep(opened(), 's4')!
    expect(undoStepDeletion(removed.draft, removed.deletion)).toEqual(opened())
    // An edit made since the delete stays: step 3 now goes to step 1 on failure, so only step 2 goes back to Notify.
    const edited = { ...removed.draft, steps: removed.draft.steps.map(item => item.key === 's3' ? { ...item, onFail: 4 as const, onFailTarget: 's1' } : item) }
    const undone = undoStepDeletion(edited, removed.deletion)
    expect(undone.steps.map(item => item.key)).toEqual(['s1', 's2', 's3', 's4'])
    expect(undone.steps[1]).toMatchObject({ onFail: 4, onFailTarget: 's4' })
    expect(undone.steps[2]).toMatchObject({ onFail: 4, onFailTarget: 's1' })
    const start = deleteStep(opened(), 's1')!
    expect(start.draft.startKey).toBe('s2')
    expect(undoStepDeletion(start.draft, start.deletion)).toMatchObject({ startKey: 's1' })
    // A Start step chosen since the delete is kept, and a second Undo changes nothing.
    expect(undoStepDeletion({ ...start.draft, startKey: 's3' }, start.deletion).startKey).toBe('s3')
    expect(undoStepDeletion(opened(), start.deletion)).toEqual(opened())
  })
  it('carries what it does not model through a move: flags outside 2, 4, 8 and 16, the run priority and the server', () => {
    const odd = [step(1, 'A', { flags: 32 | 64 | 2, subsystem: 'CmdExec', databaseName: '', osRunPriority: 1 }), step(2, 'B')]
    const draft = moveStep(initialStepsDraft(odd, 1), 's1', 1)
    const save = planAgentSteps(odd, { ...draft, steps: draft.steps.map(item => item.key === 's1' ? { ...item, name: 'A renamed' } : item) }, 1, guid)!
    expect(save.writes?.[1]).toMatchObject({ name: 'A renamed', flags: 32 | 64 | 2, osRunPriority: 1, subsystem: 'CmdExec', databaseName: '' })
  })
  it('adds New Job\'s steps whole, in order, and sets a Start step other than the first last', () => {
    const first = newStepDraft([])
    let draft = addStep({ steps: [] }, first)
    draft = addStep(draft, newStepDraft(draft.steps, 'CmdExec'))
    expect(draft.steps.map(item => item.name)).toEqual(['Step 1', 'Step 2'])
    expect(planAgentSteps(undefined, draft, undefined)).toEqual({ writes: [expect.objectContaining({ id: 1, onSuccessAction: 3 }), expect.objectContaining({ id: 2, subsystem: 'CmdExec', databaseName: '' })] })
    expect(planAgentSteps(undefined, { ...draft, startKey: draft.steps[1]!.key }, undefined)).toMatchObject({ startStepId: 2 })
    expect(planAgentSteps(undefined, { steps: [] }, undefined)).toBeUndefined()
  })
  it('checks a save is in the planner\'s shape, and the job save stays under 255 calls at the caps', () => {
    const swap = plan(moveStep(opened(), 's4', 0))!
    expect(agentStepsSaveProblems(swap, false)).toEqual([])
    expect(agentStepsSaveSchema.safeParse(swap).success).toBe(true)
    expect(agentStepsSaveProblems({ ...swap, deletes: [1, 3] }, false)).toContain('Steps are deleted from the highest id down.')
    expect(agentStepsSaveProblems({ ...swap, writes: swap.writes!.slice(1) }, false)).toContain('After renumbering, every step is written once, in order.')
    expect(agentStepsSaveProblems({ writes: [{ ...swap.writes![0]!, id: 2 }] }, true)).toContain("A new job's steps are added in order from 1.")
    expect(agentStepsSaveProblems({ writes: [{ ...swap.writes![0]!, onSuccessAction: 4, onSuccessStepId: 1, id: 1 }] }, false)).toContain('Step 1 goes to an invalid step on success.')
    expect(agentStepsSaveSchema.safeParse({ temporary: [{ id: 1, name: 'not temporary' }] }).success).toBe(false)
    expect(agentStepsSaveSchema.safeParse({ writes: [{ ...swap.writes![0]!, command: 'x'.repeat(agentLimits.stepCommandChars + 1) }] }).success).toBe(false)
    expect(agentStepsSaveSchema.safeParse({ writes: [{ ...swap.writes![0]!, name: `${temporaryStepPrefix}x` }] }).success).toBe(false)
    expect(agentStepsSaveSchema.safeParse({ writes: [{ ...swap.writes![0]!, flags: 115 }] }).success).toBe(false)
    // Deleting every described step and adding as many is the most calls the steps make: three a step.
    expect(agentJobSaveCalls).toBeGreaterThanOrEqual(agentLimits.stepsPerJob * 3 + agentLimits.jobAlerts * 2 + 2)
  })
})

describe('the steps draft', () => {
  it('encodes More options as SSMS scripts @flags, keeping the other bits, and moves the history bit with the type', () => {
    const tsql = { flags: 64 & 0, subsystem: 'TSQL' }
    expect(stepFlagsWith(tsql, { logToTable: true })).toBe(stepFlags.logToTable)
    expect(stepFlagsWith(tsql, { logToTable: true, appendTable: true })).toBe(stepFlags.logToTableAppend)
    expect(stepFlagsWith(tsql, { appendOutput: true, includeOutput: true })).toBe(2 | 4)
    expect(stepFlagsWith({ flags: 64, subsystem: 'CmdExec' }, { includeOutput: true })).toBe(64 | 32)
    expect(stepFlagChoices({ flags: 16, subsystem: 'TSQL' })).toEqual({ appendOutput: false, includeOutput: false, logToTable: true, appendTable: true })
    const ps = withSubsystem({ ...newStepDraft([]), flags: 4 | 8 }, 'PowerShell')
    expect(ps).toMatchObject({ subsystem: 'PowerShell', flags: 32 | 8, databaseUserName: '' })
    expect(withSubsystem({ ...newStepDraft([]), flags: 4 }, 'CmdExec')).toMatchObject({ databaseName: '', flags: 32 })
    expect(withSubsystem({ ...ps, flags: 32 | 64 }, 'TSQL')).toMatchObject({ flags: 4, databaseName: 'master' })
  })
  it('shows targets in the list and More options in one line', () => {
    const draft = opened()
    expect(stepTargetShort(draft, draft.steps[1]!, 'fail')).toBe('Step 4')
    expect(stepTargetShort(draft, draft.steps[3]!, 'success')).toBe('Quit, failure')
    const moved = moveStep(draft, 's4', 0)
    expect(stepTargetShort(moved, moved.steps[2]!, 'fail')).toBe('Step 1')
    expect(stepOptionsSummary({ ...draft.steps[0]!, retryAttempts: 2, retryInterval: 5, outputFileName: 'D:\\AgentLogs\\x.txt', flags: 2 | 4, databaseUserName: 'dbo' }))
      .toBe('Retry 2 times, 5 minutes apart · output to D:\\AgentLogs\\x.txt (append) · include step output in history · run as dbo')
  })
  it('holds limits on what a save writes only when the steps are saved, and never saves a command the describe cut', () => {
    const long = 'x'.repeat(agentLimits.stepCommandChars + 1)
    const read = [...described.slice(0, 3), step(4, 'Notify', { command: long.slice(0, agentLimits.stepCommandChars), commandTruncated: true })]
    const original = initialStepsDraft(read, 1)
    expect(original.steps[3]).toMatchObject({ truncated: true })
    // Untouched, the cut step only warns, so the job's other settings still save.
    expect(agentStepProblems(original, { sysadmin: true, original }).map(problem => [problem.key, problem.severity])).toEqual([['s4', 'warning']])
    const edited = { ...original, steps: original.steps.map(item => item.key === 's1' ? { ...item, command: 'SELECT 9;' } : item) }
    expect(agentStepProblems(edited, { sysadmin: true, original }).filter(problem => problem.severity === 'error').map(problem => [problem.key, problem.message]))
      .toEqual([['s4', stepText.truncatedSave]])
    // A step over stepCommandChars written in SSMS blocks only a save that sends the steps.
    const big = initialStepsDraft([...described.slice(0, 3), step(4, 'Notify', { command: long })], 1)
    expect(agentStepProblems(big, { sysadmin: true, original: big })).toEqual([])
    expect(agentStepProblems({ ...big, startKey: 's2' }, { sysadmin: true, original: big }).map(problem => problem.field)).toEqual(['command'])
  })
  it('drops a proxy when a step becomes T-SQL, which msdb refuses (14517)', () => {
    const cmd = { ...newStepDraft([], 'CmdExec'), proxyId: 5 }
    expect(withSubsystem(cmd, 'TSQL').proxyId).toBe(0)
    expect(withSubsystem(cmd, 'PowerShell').proxyId).toBe(5)
    const draft = initialStepsDraft([step(1, 'A', { subsystem: 'TSQL', proxyId: 7 })], 1)
    expect(planAgentSteps(undefined, draft, undefined, guid)!.writes?.[0]?.proxyId).toBe(0)
  })
  it('refuses, only when the steps are saved, what a save cannot send: too many steps, a go-to past them, unmodelled flags and long retries', () => {
    const many = initialStepsDraft(Array.from({ length: agentLimits.stepsPerJob }, (_, at) => step(at + 1, `S${at + 1}`)), 1)
    const added = addStep(many, newStepDraft(many.steps))
    expect(agentStepProblems(added, { sysadmin: true, original: many }).map(problem => problem.message)).toEqual([stepText.tooMany])
    const odd = initialStepsDraft([step(1, 'A', { onFailAction: 4, onFailStepId: agentLimits.stepsPerJob + 3, flags: 128, retryAttempts: agentLimits.stepRetries + 1 }), step(2, 'B')], 1)
    expect(agentStepProblems(odd, { sysadmin: true, original: odd }).filter(problem => problem.severity === 'error')).toEqual([])
    const moved = moveStep(odd, 's2', 0)
    expect(agentStepProblems(moved, { sysadmin: true, original: odd }).filter(problem => problem.severity === 'error').map(problem => problem.message))
      .toEqual([stepText.targetPast, stepText.unsavableOptions, stepText.retriesPast])
    // Names compare upper-cased, as the backend's OrdinalIgnoreCase does.
    const dotless = initialStepsDraft([step(1, 'ı'), step(2, 'I')], 1)
    expect(agentStepProblems(dotless, { sysadmin: true }).filter(problem => problem.field === 'name')).toHaveLength(2)
  })
  it('writes a dangling go-to by its id only while no step has that id', () => {
    const read = [step(1, 'A', { onFailAction: 4, onFailStepId: 3 }), step(2, 'B')]
    const dangling = initialStepsDraft(read, 1)
    expect(planAgentSteps(read, dangling, 1, guid)).toBeUndefined()
    const grown = addStep(dangling, newStepDraft(dangling.steps))
    expect(planAgentSteps(read, grown, 1, guid)!.writes?.[0]).toMatchObject({ onFailAction: 2, onFailStepId: 0 })
    const moved = moveStep(dangling, 's2', 0)
    expect(planAgentSteps(read, moved, 1, guid)!.writes?.[1]).toMatchObject({ onFailAction: 4, onFailStepId: 3 })
  })
  it('flags what msdb refuses as errors and what will not work as warnings', () => {
    const draft = opened()
    const broken: AgentStepsDraft = { ...draft, steps: draft.steps.map(item => item.key === 's2' ? { ...item, name: 'Check integrity', onSuccess: 4, onSuccessTarget: 's2' } : item.key === 's3' ? { ...item, onFailTarget: 's9' } : item) }
    const problems = agentStepProblems(broken, { sysadmin: false, proxies: [{ id: 3, name: 'Writer', enabled: true, subsystems: ['CmdExec'] }] })
    expect(problems.filter(problem => problem.severity === 'error').map(problem => [problem.key, problem.field])).toEqual([['s1', 'name'], ['s2', 'name'], ['s2', 'onSuccess']])
    expect(problems.find(problem => problem.key === 's3')).toMatchObject({ field: 'onFail', severity: 'warning' })
    // The PowerShell step runs as the service account, which only sysadmin may use.
    expect(problems.find(problem => problem.key === 's4')).toMatchObject({ field: 'runAs', severity: 'warning' })
    const proxied = { ...draft, steps: draft.steps.map(item => item.key === 's4' ? { ...item, proxyId: 3 } : item) }
    expect(agentStepProblems(proxied, { sysadmin: true, proxies: [{ id: 3, name: 'Writer', enabled: true, subsystems: ['CmdExec'] }] })[0]?.message).toBe('Writer is not active for PowerShell.')
  })
})

const model = (patch: Partial<AgentJobDocumentModel> = {}): AgentJobDocumentModel => ({
  job: {
    jobId: '11111111-1111-1111-1111-111111111111', name: 'Index maintenance', enabled: true, description: '', category: 'x', owner: 'sa', emailLevel: 0, emailOperator: '', pageLevel: 0,
    pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 0, deleteLevel: 0, created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 7, startStepId: 1
  },
  login: 'sa', sysadmin: true, platform: 'windows', categories: ['x'], steps: described, alertsEditable: true, mail: { checked: false, sysadmin: true }, ...patch
})

describe('steps in the job save', () => {
  it('opens the steps with the job, counts step changes and sends them with the STALE guard', () => {
    const opened = model(), draft = initialAgentJobDraft(opened)
    expect(draft.steps.steps.map(item => item.name)).toEqual(['Check integrity', 'Rebuild', 'Statistics', 'Notify'])
    const removed = deleteStep(draft.steps, 's4')!.draft
    const changed = { ...draft, steps: removed }
    // The deleted step and the two steps whose failure target changed.
    expect(agentJobChangeCount(draft, changed)).toBe(3)
    const save = agentJobSave(opened, changed)!
    expect(save).toMatchObject({ version: 7, modified: '2026-11-20T14:32:07.123', steps: { deletes: [4] } })
    expect(agentJobSaveProblems(save, false)).toEqual([])
    expect(agentJobSaveSchema.safeParse(save).success).toBe(true)
    expect(agentJobProblems(opened, { ...changed, steps: { ...removed, steps: removed.steps.map(item => ({ ...item, name: 'Same' })) } }).filter(problem => problem.field === 'steps')).toHaveLength(3)
  })
  it('rebases the steps by name over a reload: another session\'s renames, deletes, inserts and Start step stand, the user\'s edits land on the step they edited', () => {
    const openedModel = model(), draft = initialAgentJobDraft(openedModel)
    const edited = (patch: Partial<AgentStepDraft>, key = 's1') => ({ ...draft, steps: { ...draft.steps, steps: draft.steps.steps.map(item => item.key === key ? { ...item, ...patch } : item) } })
    const names = (rebased: AgentJobDraft) => rebased.steps.steps.map(item => [item.name, item.from])
    const at = (steps: AgentJobStepRecord[], start = 1) => model({ job: { ...openedModel.job!, version: 9, startStepId: start }, steps })
    // Renamed elsewhere, untouched here: the server's name stands, with no copy of the old step.
    const renamed = at([described[0]!, step(2, 'Rebuild all'), described[2]!, described[3]!])
    const mine = edited({ command: 'mine' })
    expect(names(rebaseAgentJobDraft(openedModel, renamed, mine))).toEqual([['Check integrity', 1], ['Rebuild all', 2], ['Statistics', 3], ['Notify', 4]])
    expect(agentJobSave(renamed, rebaseAgentJobDraft(openedModel, renamed, mine))!.steps).toEqual({ writes: [expect.objectContaining({ id: 1, command: 'mine' })] })
    // Deleted elsewhere, untouched here: it stays deleted, and the steps that went to it quit reporting failure as msdb left them.
    const deleted = at([described[0]!, step(2, 'Rebuild'), step(3, 'Statistics', { onSuccessAction: 1 })])
    expect(names(rebaseAgentJobDraft(openedModel, deleted, mine))).toEqual([['Check integrity', 1], ['Rebuild', 2], ['Statistics', 3]])
    // Inserted elsewhere: every step keeps its own content at its new id, the edit lands on Check integrity (now 2), and nothing is duplicated.
    const inserted = at([step(1, 'Precheck'), step(2, 'Check integrity'), step(3, 'Rebuild', { onFailAction: 4, onFailStepId: 5 }), step(4, 'Statistics', { onSuccessAction: 1, onFailAction: 4, onFailStepId: 5 }), step(5, 'Notify', { subsystem: 'PowerShell', databaseName: '', onSuccessAction: 2 })], 2)
    const rebased = rebaseAgentJobDraft(openedModel, inserted, mine)
    expect(names(rebased)).toEqual([['Precheck', 1], ['Check integrity', 2], ['Rebuild', 3], ['Statistics', 4], ['Notify', 5]])
    expect(stepTargetShort(rebased.steps, rebased.steps.steps[2]!, 'fail')).toBe('Step 5')
    expect(agentJobSave(inserted, rebased)!.steps).toEqual({ writes: [expect.objectContaining({ id: 2, command: 'mine' })] })
    // The Start step: the server's (Check integrity, read as 2), since the user did not change it.
    expect(rebased.steps.steps.find(item => item.key === rebased.steps.startKey)?.name).toBe('Check integrity')
    // An edited step the job no longer has under its name becomes a new step, never written over another by number.
    const gone = at([described[0]!, described[2]!, described[3]!].map((item, index) => ({ ...item, id: index + 1 })))
    expect(names(rebaseAgentJobDraft(openedModel, gone, edited({ command: 'mine' }, 's2')))).toEqual([['Check integrity', 1], ['Rebuild', undefined], ['Statistics', 2], ['Notify', 3]])
  })
  it("keeps the server's steps over a reload when the job now has more steps than the describe reads, and never plans over them", () => {
    const openedModel = model(), draft = initialAgentJobDraft(openedModel)
    const mine = { ...draft, steps: { ...draft.steps, steps: draft.steps.steps.map(item => item.key === 's1' ? { ...item, command: 'mine' } : item) } }
    const current = model({ job: { ...openedModel.job!, version: 9 }, stepsTruncated: true })
    const rebased = rebaseAgentJobDraft(openedModel, current, mine)
    expect(rebased.steps.steps[0]?.command).toBe('-- Check integrity')
    expect(agentJobSave(current, { ...mine, description: 'x' })).not.toHaveProperty('steps')
  })
  it('keeps the Start step another session set unless the user changed it, and says what each side changed in the compare', () => {
    const openedModel = model(), draft = initialAgentJobDraft(openedModel)
    const current = model({ job: { ...openedModel.job!, version: 9, startStepId: 2 } })
    const mine = { ...draft, steps: { ...draft.steps, steps: draft.steps.steps.map(item => item.key === 's1' ? { ...item, command: 'mine' } : item) } }
    const rebased = rebaseAgentJobDraft(openedModel, current, mine)
    expect(rebased.steps.startKey).toBe('s2')
    expect(agentJobSave(current, rebased)!.steps?.startStepId).toBeUndefined()
    expect(rebaseAgentJobDraft(openedModel, current, { ...mine, steps: { ...mine.steps, startKey: 's3' } }).steps.startKey).toBe('s3')
    const rows = agentJobCompare(openedModel, model({ job: { ...openedModel.job!, version: 9 }, steps: [described[0]!, step(2, 'Rebuild', { command: 'theirs' }), described[2]!, described[3]!] }), mine)
    expect(rows.find(row => row.field === 'steps')).toMatchObject({ server: 'Edited Rebuild', yours: 'Edited Check integrity' })
  })
  it('counts a step deleted and undone as untouched over a reload, so another session\'s edit of a step that went to it stands', () => {
    const openedModel = model(), draft = initialAgentJobDraft(openedModel)
    const removed = deleteStep(draft.steps, 's4')!
    const undone = { ...draft, steps: undoStepDeletion(removed.draft, removed.deletion), description: 'x' }
    const current = model({ job: { ...openedModel.job!, version: 9 }, steps: [described[0]!, step(2, 'Rebuild', { command: 'theirs', onFailAction: 4, onFailStepId: 4 }), described[2]!, described[3]!] })
    expect(rebaseAgentJobDraft(openedModel, current, undone).steps.steps[1]).toMatchObject({ command: 'theirs' })
  })
  it("keeps another session's edit of a step the user did not touch, and the user's edit of one they did", () => {
    const openedModel = model(), draft = initialAgentJobDraft(openedModel)
    const mine = { ...draft, steps: { ...draft.steps, steps: draft.steps.steps.map(item => item.key === 's1' ? { ...item, command: 'mine' } : item) } }
    const current = model({ job: { ...openedModel.job!, version: 9 }, steps: [step(1, 'Check integrity', { command: 'theirs 1' }), step(2, 'Rebuild', { command: 'theirs 2', onFailAction: 4, onFailStepId: 4 }), described[2]!, described[3]!] })
    const rebased = rebaseAgentJobDraft(openedModel, current, mine)
    expect(rebased.steps.steps.map(item => item.command)).toEqual(['mine', 'theirs 2', '-- Statistics', '-- Notify'])
    expect(agentJobSave(current, rebased)!.steps).toEqual({ writes: [expect.objectContaining({ id: 1, command: 'mine' })] })
  })
  it('rebases twice in a row: each step is compared with its own, the Start step follows its step, and the job order stands', () => {
    const openedModel = model(), draft = initialAgentJobDraft(openedModel)
    const mine = { ...draft, steps: { ...draft.steps, steps: draft.steps.steps.map(item => item.key === 's1' ? { ...item, command: 'mine' } : item) } }
    // Another session inserts a step first and moves the Start step to Check integrity (now 2).
    const first = model({ job: { ...openedModel.job!, version: 9, startStepId: 2 }, steps: [step(1, 'Precheck'), step(2, 'Check integrity'), step(3, 'Rebuild', { onFailAction: 4, onFailStepId: 5 }), step(4, 'Statistics', { onSuccessAction: 1, onFailAction: 4, onFailStepId: 5 }), step(5, 'Notify', { subsystem: 'PowerShell', databaseName: '', onSuccessAction: 2 })] })
    const once = rebaseAgentJobDraft(openedModel, first, mine)
    expect(once.steps.steps.map(item => item.key)).toEqual(['s1', 's2', 's3', 's4', 's5'])
    expect(once.steps.steps.map(item => item.from)).toEqual([1, 2, 3, 4, 5])
    // Then it edits Rebuild (3) and reorders Statistics before Rebuild; the user's edit of Check integrity still lands on it.
    const second = model({ job: { ...openedModel.job!, version: 10, startStepId: 2 }, steps: [step(1, 'Precheck'), step(2, 'Check integrity'), step(3, 'Statistics', { onSuccessAction: 1, onFailAction: 4, onFailStepId: 5 }), step(4, 'Rebuild', { command: 'theirs', onFailAction: 4, onFailStepId: 5 }), step(5, 'Notify', { subsystem: 'PowerShell', databaseName: '', onSuccessAction: 2 })] })
    const twice = rebaseAgentJobDraft(first, second, once)
    expect(twice.steps.steps.map(item => [item.name, item.command])).toEqual([['Precheck', '-- Precheck'], ['Check integrity', 'mine'], ['Statistics', '-- Statistics'], ['Rebuild', 'theirs'], ['Notify', '-- Notify']])
    expect(twice.steps.steps.find(item => item.key === twice.steps.startKey)?.name).toBe('Check integrity')
    expect(agentJobSave(second, twice)!.steps).toEqual({ writes: [expect.objectContaining({ id: 2, command: 'mine' })] })
  })
  it('keeps the user\'s order when they reordered, and calls a renamed step edited without marking the steps that go to it', () => {
    const openedModel = model(), draft = initialAgentJobDraft(openedModel)
    const moved = { ...draft, steps: moveStep(draft.steps, 's4', 0) }
    const current = model({ job: { ...openedModel.job!, version: 9 }, steps: [described[0]!, step(2, 'Rebuild', { command: 'theirs', onFailAction: 4, onFailStepId: 4 }), described[2]!, described[3]!] })
    expect(rebaseAgentJobDraft(openedModel, current, moved).steps.steps.map(item => item.name)).toEqual(['Notify', 'Check integrity', 'Rebuild', 'Statistics'])
    const renamed = { ...draft, steps: { ...draft.steps, steps: draft.steps.steps.map(item => item.key === 's4' ? { ...item, name: 'Alert' } : item) } }
    const rows = agentJobCompare(openedModel, current, renamed)
    expect(rows.find(row => row.field === 'steps')?.yours).toBe('Edited Alert')
  })
})

describe('the SSIS step', () => {
  const ssms = '/ISSERVER "\\"\\SSISDB\\Finance\\ETL\\LoadStagingSales.dtsx\\"" /SERVER "\\"sql-prod-01\\"" /ENVREFERENCE 3 /Par "\\"$Project::TargetSchema\\"";stg /Par "\\"BatchSize(Int32)\\"";50000 '
    + '/Par "\\"$ServerOption::LOGGING_LEVEL(Int16)\\"";1 /Par "\\"$ServerOption::SYNCHRONIZED(Boolean)\\"";True /X86 /CALLERINFO SQLAGENT /REPORTING E'
  it('reads SSMS\'s command line into fields and writes it back the same', () => {
    const parsed = parseSsisCommand(ssms)!
    expect(parsed).toMatchObject({ folder: 'Finance', project: 'ETL', package: 'LoadStagingSales.dtsx', server: 'sql-prod-01', environmentReference: 3, x86: true, loggingLevel: 1 })
    expect(parsed.parameters).toEqual([{ scope: 'project', name: 'TargetSchema', value: 'stg' }, { scope: 'package', name: 'BatchSize', type: 'Int32', value: '50000' }])
    expect(buildSsisCommand(parsed)).toBe(ssms)
    const spaced = withSsisParameter(parsed, 'package', 'Label', 'a "quoted" value; with spaces')
    expect(parseSsisCommand(buildSsisCommand(spaced))?.parameters.find(item => item.name === 'Label')?.value).toBe('a "quoted" value; with spaces')
    expect(ssisAdvancedSummary(parsed)).toBe('Logging level Basic · no dump on errors · no property overrides')
  })
  it('keeps SYNCHRONIZED as written, writes no /SERVER the command had none of, and escapes quotes in names', () => {
    const unsynced = ssms.replace('SYNCHRONIZED(Boolean)\\"";True', 'SYNCHRONIZED(Boolean)\\"";False')
    expect(buildSsisCommand(parseSsisCommand(unsynced)!)).toBe(unsynced)
    const local = ssms.replace(' /SERVER "\\"sql-prod-01\\""', '')
    expect(parseSsisCommand(local)?.server).toBe('')
    expect(buildSsisCommand(parseSsisCommand(local)!)).toBe(local)
    const quoted = withSsisParameter(parseSsisCommand(ssms)!, 'package', 'Odd"Name', 'v')
    expect(parseSsisCommand(buildSsisCommand(quoted))?.parameters.find(item => item.name === 'Odd"Name')?.value).toBe('v')
  })
  it('keeps only the project\'s values when another package of the same project is picked, and none in another project', () => {
    const command = parseSsisCommand(ssms.replace(' /X86', ' /Par "\\"Batch\\"";5 /Par "\\"CM.Src.ConnectionString\\"";x /X86'))!
    expect(command.parameters.map(item => item.scope)).toEqual(['project', 'package', 'package', 'connection'])
    const other = withSsisPackage(command, command.folder, command.project, 'B.dtsx')
    expect(other).toMatchObject({ package: 'B.dtsx', environmentReference: command.environmentReference })
    expect(other.parameters.map(item => item.name)).toEqual(['TargetSchema'])
    expect(withSsisPackage(command, command.folder, command.project, command.package)).toBe(command)
    expect(withSsisPackage(command, command.folder, 'Other', 'A.dtsx')).toMatchObject({ parameters: [], environmentReference: undefined })
  })
  it('trims a step\'s database, user and output path of spaces only, as msdb does', () => {
    const stored = [step(1, 'One', { databaseName: 'Sales\u00a0', outputFileName: 'C:\out.txt\t' }), step(2, 'Two')]
    guidAt = 0
    const save = planAgentSteps(stored, moveStep(initialStepsDraft(stored, 1), 's2', 0), 1, guid)!
    expect(save.writes?.find(write => write.name === 'One')).toMatchObject({ databaseName: 'Sales\u00a0', outputFileName: 'C:\out.txt\t' })
  })
  it('keeps a command it cannot lay out as text', () => {
    expect(parseSsisCommand('/FILE "\\"D:\\pkg.dtsx\\"" /CHECKPOINTING OFF /REPORTING E')).toBeUndefined()
    expect(parseSsisCommand(ssms.replace('/X86', '/MAXCONCURRENT 4'))).toBeUndefined()
    expect(parseSsisCommand('/ISSERVER "\\"\\SSISDB\\a\\b\\c.dtsx\\""')).toBeUndefined()
    expect(parseSsisCommand(buildSsisCommand(newSsisCommand('srv', 'F', 'P', 'p.dtsx')))).toMatchObject({ folder: 'F', project: 'P', package: 'p.dtsx', server: 'srv' })
  })
  it('says where each parameter\'s value comes from, and flags a required one without a value', () => {
    const parameter = (name: string, patch: Partial<SsisParameter> = {}): SsisParameter => ({ name, dataType: 'String', required: false, sensitive: false, valueType: 'V', valueSet: false, ...patch })
    const parsed = parseSsisCommand(ssms)!
    const rows = ssisParameterRows(parsed, [parameter('TargetSchema'), parameter('SourceConnection', { required: true }), parameter('Mode', { valueSet: true, valueType: 'R', variable: 'Mode' })],
      [parameter('BatchSize', { dataType: 'Int32', designDefault: '1000' }), parameter('BatchDate', { designDefault: '1900-01-01' })])
    expect(rows.map(row => [row.name, row.source, row.value])).toEqual([
      ['TargetSchema', 'step', 'stg'], ['SourceConnection', 'none', undefined], ['Mode', 'environment', 'Mode'], ['BatchSize', 'step', '50000'], ['BatchDate', 'default', '1900-01-01']
    ])
    expect(ssisProblems(rows)).toEqual(['SourceConnection is required and has no value.'])
  })
})

describe('the step problems of what msdb already holds', () => {
  const context = (draft: AgentStepsDraft) => ({ sysadmin: true, original: draft })
  it('warns of a duplicate or reserved name until a save writes the steps, then refuses it', () => {
    const draft = initialStepsDraft([step(1, 'Same'), step(2, 'same'), step(3, `${temporaryStepPrefix}x`)], 1)
    expect(agentStepProblems(draft, context(draft)).filter(item => item.field === 'name').map(item => item.severity)).toEqual(['warning', 'warning', 'warning'])
    const edited = { ...draft, steps: draft.steps.map(item => item.key === 's1' ? { ...item, command: 'x' } : item) }
    expect(agentStepProblems(edited, context(draft)).filter(item => item.field === 'name').map(item => item.severity)).toEqual(['error', 'error', 'error'])
  })
  it('reads a subsystem msdb stored in another case as the catalogue spells it, keeping a T-SQL step\'s Run as user', () => {
    const read = initialStepsDraft([step(1, 'A', { subsystem: 'tsql', databaseUserName: 'etl_user', flags: 4 }), step(2, 'B', { subsystem: 'CMDEXEC', databaseName: '' })], 1)
    expect(read.steps.map(item => item.subsystem)).toEqual(['TSQL', 'CmdExec'])
    const save = planAgentSteps([step(1, 'A', { subsystem: 'tsql', databaseUserName: 'etl_user', flags: 4 }), step(2, 'B', { subsystem: 'CMDEXEC', databaseName: '' })], moveStep(read, 's2', 0), 1, guid)!
    expect(save.writes?.map(write => [write.name, write.subsystem, write.databaseUserName])).toEqual([['B', 'CmdExec', ''], ['A', 'TSQL', 'etl_user']])
    expect(agentStepsSaveSchema.safeParse(save).success).toBe(true)
  })
  it('asks an Analysis Services step for its server, and drops an output file a type cannot write', () => {
    const draft = initialStepsDraft([step(1, 'One', { outputFileName: 'C:\out.txt' })], 1)
    const olap = { ...draft, steps: [withSubsystem(draft.steps[0]!, 'ANALYSISQUERY')] }
    expect(agentStepProblems(olap, context(draft)).find(item => item.field === 'server')?.message).toBe(stepText.serverNeeded)
    expect(agentStepProblems({ ...olap, steps: [{ ...olap.steps[0]!, server: 'olap01' }] }, context(draft)).filter(item => item.field === 'server')).toEqual([])
    expect(withSubsystem(draft.steps[0]!, 'Snapshot').outputFileName).toBe('')
    expect(withSubsystem(draft.steps[0]!, 'PowerShell').outputFileName).toBe('C:\out.txt')
    expect(withSubsystem({ ...olap.steps[0]!, server: 'olap01' }, 'TSQL').server).toBe('')
  })
  it("keeps an edited step's go-to on a step renamed elsewhere, and answers one deleted elsewhere as msdb does", () => {
    const opened = [step(1, 'A', { onSuccessAction: 4, onSuccessStepId: 2, onFailAction: 4, onFailStepId: 2 }), step(2, 'B')]
    const openedModel = model({ steps: opened }), draft = initialAgentJobDraft(openedModel)
    const mine = { ...draft, steps: { ...draft.steps, steps: draft.steps.steps.map(item => item.key === 's1' ? { ...item, command: 'mine' } : item) } }
    const renamed = model({ job: { ...openedModel.job!, version: 9 }, steps: [opened[0]!, step(2, 'C')] })
    const kept = rebaseAgentJobDraft(openedModel, renamed, mine)
    expect(stepTargetShort(kept.steps, kept.steps.steps[0]!, 'success')).toBe('Step 2')
    expect(kept.steps.steps.map(item => item.name)).toEqual(['A', 'C'])
    expect(agentJobSave(renamed, kept)!.steps).toEqual({ writes: [expect.objectContaining({ id: 1, command: 'mine', onSuccessAction: 4, onSuccessStepId: 2, onFailAction: 4, onFailStepId: 2 })] })
    const deleted = model({ job: { ...openedModel.job!, version: 9 }, steps: [step(1, 'A', { onSuccessAction: 1, onFailAction: 2 })] })
    expect(rebaseAgentJobDraft(openedModel, deleted, mine).steps.steps[0]).toMatchObject({ onSuccess: 1, onFail: 2 })
  })
  it('keeps a go-to past the last step over a reload, as msdb keeps it', () => {
    const openedModel = model(), draft = initialAgentJobDraft(openedModel)
    const mine = { ...draft, steps: { ...draft.steps, steps: draft.steps.steps.map(item => item.key === 's1' ? { ...item, command: 'mine' } : item) } }
    const current = model({ job: { ...openedModel.job!, version: 9 }, steps: [described[0]!, step(2, 'Rebuild', { onFailAction: 4, onFailStepId: 7 }), described[2]!, described[3]!] })
    const rebased = rebaseAgentJobDraft(openedModel, current, mine)
    expect(rebased.steps.steps[1]).toMatchObject({ onFail: 4, onFailTarget: 's7' })
    expect(agentJobSave(current, rebased)!.steps).toEqual({ writes: [expect.objectContaining({ id: 1, command: 'mine' })] })
  })
  it('sets the Start step back to 1 when every step is deleted, which msdb would leave past the last step', () => {
    let draft = opened()
    for (const key of ['s1', 's2', 's3', 's4']) draft = deleteStep(draft, key)!.draft
    const save = plan(draft, 2)!
    expect(save).toEqual({ deletes: [4, 3, 2, 1], startStepId: 1 })
    expect(agentStepsSaveProblems(save, false)).toEqual([])
    expect(agentStepsSaveSchema.safeParse(save).success).toBe(true)
  })
  it('keeps a name msdb stored with a tab as it is, so editing another step writes only that step', () => {
    const stored = [step(1, 'Load\t'), step(2, 'B'), step(3, 'C', { outputFileName: 'C:\out.txt' })]
    const read = initialStepsDraft(stored, 1)
    expect(agentStepProblems(read, { sysadmin: true, original: read }).filter(item => item.field === 'name')).toEqual([])
    const edited = { ...read, steps: read.steps.map(item => item.key === 's2' ? { ...item, command: 'mine' } : item) }
    guidAt = 0
    expect(planAgentSteps(stored, edited, 1, guid)).toEqual({ writes: [expect.objectContaining({ id: 2, name: 'B', command: 'mine' })] })
    const twins = initialStepsDraft([step(1, 'Load'), step(2, 'Load\t')], 1)
    expect(agentStepProblems(twins, { sysadmin: true, original: twins }).filter(item => item.field === 'name')).toEqual([])
  })
  it('refuses an output file or table log on a step type msdb refuses them for', () => {
    const draft = initialStepsDraft([step(1, 'One', { subsystem: 'Snapshot', databaseName: '' })], 1)
    const output = { ...draft, steps: [{ ...draft.steps[0]!, outputFileName: 'C:\out.txt' }] }
    expect(agentStepProblems(output, { sysadmin: true, original: draft }).map(item => item.message)).toContain(stepText.outputUnsupported)
    const table = { ...draft, steps: [{ ...draft.steps[0]!, flags: 8 }] }
    expect(agentStepProblems(table, { sysadmin: true, original: draft }).map(item => item.message)).toContain(stepText.outputUnsupported)
  })
  it('refuses a save that writes negative retries msdb stored', () => {
    const draft = initialStepsDraft([step(1, 'One', { retryAttempts: -1 })], 1)
    const edited = { ...draft, steps: [{ ...draft.steps[0]!, command: 'x' }] }
    expect(agentStepProblems(edited, { sysadmin: true, original: draft }).map(item => item.message)).toContain(stepText.retriesPast)
  })
  it('refuses a save with a success exit code past int32 or a NUL character', () => {
    const draft = initialStepsDraft([step(1, 'One')], 1)
    const past = { ...draft, steps: [{ ...draft.steps[0]!, cmdexecSuccessCode: 2_147_483_648 }] }
    expect(agentStepProblems(past, context(draft)).map(item => item.message)).toContain(stepText.exitCodePast)
    const nul = { ...draft, steps: [{ ...draft.steps[0]!, command: 'SELECT 1\u0000' }] }
    expect(agentStepProblems(nul, context(draft)).map(item => item.message)).toContain(stepText.nulCharacter)
    expect(agentStepProblems(draft, context(draft))).toEqual([])
  })
})
