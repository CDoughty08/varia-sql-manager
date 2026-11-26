// A job step's menu in the Steps section's Flow view (mock rx-flow-menu): On success ›, On failure › and Add step after › list their items
// from the draft. The same lists feed macOS's pickers (On success…, On failure…, Add step after…) and a port dropped on empty space, whose
// native menus cannot show items built at open time.
import { stepTypeShort, type AgentStepsDraft, type StepAction } from '../../../shared/agent/steps.ts'
import type { DynamicMenuItem } from '../menus/resolve'
import type { CommandArgs } from '../core/types'
import type { DynamicSubmenu } from '../../../shared/commands/menus'
import { agentStepOf } from '../menus/targets'
import type { JobDocumentService } from './JobDocumentService'

/** One choice for a step's On success or On failure, in the List editor's wording. */
export interface StepActionChoice {
  readonly id: string
  readonly label: string
  readonly action: StepAction
  readonly target?: string
  readonly checked: boolean
  /** Before it: a separator in the menu. */
  readonly group: 'next' | 'steps' | 'quit'
}

/** Go to the next step (with the step it is, or that there is none), Go to step N: name for every other step, and the two Quits. */
export function stepActionChoices(draft: AgentStepsDraft, key: string, which: 'success' | 'fail'): readonly StepActionChoice[] {
  const steps = draft.steps, at = steps.findIndex(step => step.key === key), step = steps[at]
  if (!step) return []
  const action = which === 'success' ? step.onSuccess : step.onFail, target = which === 'success' ? step.onSuccessTarget : step.onFailTarget
  const below = steps[at + 1]
  return [
    { id: 'next', label: below ? `Go to the next step (${at + 2} · ${below.name || 'Unnamed step'})` : 'Go to the next step (none: the job fails)', action: 3, checked: action === 3, group: 'next' },
    ...steps.flatMap((item, position): StepActionChoice[] => item.key === key ? [] : [{
      id: `goto:${item.key}`, label: `Go to step ${position + 1}: ${item.name || 'Unnamed step'}`, action: 4, target: item.key, checked: action === 4 && target === item.key, group: 'steps'
    }]),
    { id: 'quit-success', label: 'Quit the job reporting success', action: 1, checked: action === 1, group: 'quit' },
    { id: 'quit-failure', label: 'Quit the job reporting failure', action: 2, checked: action === 2, group: 'quit' }
  ]
}

/** The step menu's dynamic submenus, for MenuService: each item runs its command on the menu's step with the choice it is. */
export function stepMenuProviders(jobDocuments: Pick<JobDocumentService, 'get' | 'canEditSteps' | 'canAddStep' | 'stepTypes'>): { readonly [K in DynamicSubmenu]?: (args?: CommandArgs) => readonly DynamicMenuItem[] } {
  const actions = (which: 'success' | 'fail') => (args?: CommandArgs): readonly DynamicMenuItem[] => {
    const step = agentStepOf(args), draft = step ? jobDocuments.get(step.tabId)?.draft?.steps : undefined
    if (!step || !draft) return []
    const enabled = jobDocuments.canEditSteps(step.tabId)
    const items: DynamicMenuItem[] = []
    let group: StepActionChoice['group'] | undefined
    for (const choice of stepActionChoices(draft, step.key, which)) {
      if (group && group !== choice.group) items.push({ kind: 'separator' })
      group = choice.group
      items.push({
        kind: 'command', key: `${which}:${choice.id}`, id: 'agentJob.setStepAction', title: choice.label, mnemonic: null, icon: null, checked: choice.checked, radio: true, enabled,
        args: { ...args, agentStep: { which, action: choice.action, ...choice.target ? { target: choice.target } : {} } }
      })
    }
    return items
  }
  return {
    agentStepSuccess: actions('success'),
    agentStepFailure: actions('fail'),
    agentStepAdd: args => {
      const step = agentStepOf(args)
      if (!step) return []
      const enabled = jobDocuments.canAddStep(step.tabId)
      return jobDocuments.stepTypes(step.tabId).map((subsystem): DynamicMenuItem => ({
        kind: 'command', key: `add:${subsystem}`, id: 'agentJob.addStepAfter', title: stepTypeShort(subsystem), icon: null, enabled, args: { ...args, agentStep: { subsystem } }
      }))
    }
  }
}
