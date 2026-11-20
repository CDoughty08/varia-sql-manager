import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { windows } from '../core/windows'
import { beginCopy } from '../grid/copy-generation'
import { planOutlineOf, planPropertiesOf, type PlanOutlineTarget } from '../menus/targets'
import { propertiesCopyText } from '../plans/plan-copy'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }

/**
 * The execution plan viewer's copies, formatted by the results text writer: the outline's operator (its menu's, else the
 * focused outline's selection, from Ctrl+C), with a header line when Include column headers when copying the results is
 * on; the Properties pane's facts as Name<TAB>Value lines, or their values.
 */
export function plansContribution({ commands, menuTargets, settings, platform }: Pick<Workbench, 'commands' | 'menuTargets' | 'settings' | 'platform'>, api: Pick<VariaApi, 'writeClipboardText'>): Disposable {
  const outline = (args?: CommandArgs): PlanOutlineTarget | undefined => {
    if (args?.target) return planOutlineOf(args)
    const hit = typeof document === 'undefined' ? undefined : menuTargets.targetFor(windows.activeElement())
    return hit?.target.kind === 'planOutline' ? hit.target : undefined
  }
  const write = async (text: Promise<string>) => {
    // Any copy supersedes a local grid's still formatting (copy-generation.ts).
    beginCopy()
    const copied = await text
    if (copied) unwrap(await api.writeClipboardText(copied))
  }
  const crlf = platform === 'win32'
  const registrations = [
    commands.register('plan.copyOperator', {
      when: args => !!outline(args)?.copy,
      run: async args => { const copy = outline(args)?.copy; if (copy) await write(copy(settings.get('queryResults.grid.copyColumnHeaders'))) }
    }),
    commands.register('plan.copyProperties', {
      when: args => !!planPropertiesOf(args)?.facts.length,
      run: async args => { const facts = planPropertiesOf(args)?.facts; if (facts?.length) await write(propertiesCopyText(facts, { values: false, crlf })) }
    }),
    commands.register('plan.copyPropertyValues', {
      when: args => !!planPropertiesOf(args)?.facts.length,
      run: async args => { const facts = planPropertiesOf(args)?.facts; if (facts?.length) await write(propertiesCopyText(facts, { values: true, crlf })) }
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
