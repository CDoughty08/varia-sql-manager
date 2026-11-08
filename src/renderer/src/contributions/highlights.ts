import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { highlightColors } from '../grid/highlights'
import { outputOf } from '../menus/targets'
import { focusedOutput } from './output'

/**
 * Highlight Rows (its key and each colour of the grid menu's Highlight submenu), Clear Highlight and Clear All Highlights
 * (HighlightsService). They act on the menu's grid, else the focused one, and only once its result has every row.
 */
export function highlightsContribution({ commands, highlights, menuTargets }: Pick<Workbench, 'commands' | 'highlights' | 'menuTargets'>): Disposable {
  /** The colour Highlight Rows applies: the last one picked from the submenu. */
  let last = 1
  const targetOf = (args?: CommandArgs) => {
    const target = outputOf(args) ?? (args?.target ? undefined : focusedOutput(menuTargets))
    return target?.view === 'grid' && highlights.canHighlight(target.tabId, target.resultIndex) ? target : undefined
  }
  const highlight = (color: () => number) => ({
    when: (args?: CommandArgs) => !!targetOf(args),
    run: async (args?: CommandArgs) => { const target = targetOf(args); if (target) await highlights.highlight(target.tabId, target.resultIndex, color()) }
  })
  const registrations = [
    commands.register('output.highlightRows', highlight(() => last)),
    ...highlightColors.map((color, index) => commands.register(`output.highlight${color[0].toUpperCase()}${color.slice(1)}` as 'output.highlightYellow', highlight(() => (last = index + 1)))),
    commands.register('output.clearHighlight', highlight(() => 0)),
    commands.register('output.clearAllHighlights', {
      when: args => { const target = targetOf(args); return !!target && highlights.hasHighlights(target.tabId, target.resultIndex) },
      run: args => { const target = targetOf(args); if (target) highlights.clear(target.tabId, target.resultIndex) }
    })
  ]
  return { dispose: () => { for (const registration of registrations) registration.dispose() } }
}
