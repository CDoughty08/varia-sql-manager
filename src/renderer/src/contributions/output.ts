import type { ApiResult, DisplayResultSet, VariaApi } from '../../../shared/contracts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { isEmptyRange, maxCopyLength, rangeOf, tooLargeToCopy, toTsv, type GridSelection } from '../grid/selection'
import { outputOf, type MenuTargetService, type OutputTarget } from '../menus/targets'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }

/** The Query Output view that has focus, read as its menu would be: keys and the Edit menu act on it. */
export function focusedOutput(menuTargets: Pick<MenuTargetService, 'targetFor'>): OutputTarget | undefined {
  const hit = typeof document === 'undefined' ? undefined : menuTargets.targetFor(document.activeElement)
  return hit?.target.kind === 'output' ? hit.target : undefined
}

/**
 * Copy, Copy with Headers, and Select All in Query Output. The grid copies its selected cells as tab-separated text
 * (SSMS's format, with Windows line breaks on Windows); Messages and the XML plan copy the text selected in them. The
 * commands act on the menu's target, else on the view that has focus (Ctrl+Shift+C).
 */
export function outputContribution({ commands, queries, menuTargets, resultSelection, platform }: Pick<Workbench, 'commands' | 'queries' | 'menuTargets' | 'resultSelection' | 'platform'>,
  api: Pick<VariaApi, 'writeClipboardText'>): Disposable {
  const eol = platform === 'win32' ? '\r\n' : '\n'
  const targetOf = (args?: CommandArgs) => outputOf(args) ?? (args?.target ? undefined : focusedOutput(menuTargets))
  /** The grid's result set and its selection, when that result is still showing for a query that still has it. */
  const grid = (target: OutputTarget | undefined): { set: DisplayResultSet; selection?: GridSelection } | undefined => {
    if (target?.view !== 'grid') return undefined
    const set = queries.getSnapshot()[target.tabId]?.result?.resultSets[target.resultIndex]
    return set && set.kind !== 'executionPlan' ? { set, selection: resultSelection.get(target.tabId, target.resultIndex) } : undefined
  }
  const selected = (target: OutputTarget | undefined) => {
    const shown = grid(target)
    return shown?.selection && !isEmptyRange(rangeOf(shown.selection, shown.set.rows.length, shown.set.columns.length)) ? { set: shown.set, selection: shown.selection } : undefined
  }
  const write = async (text: string) => {
    if (text.length > maxCopyLength) throw new RangeError(tooLargeToCopy)
    unwrap(await api.writeClipboardText(text))
  }
  const registrations = [
    commands.register('output.copy', {
      when: args => { const target = targetOf(args); return !!selected(target) || (target?.view !== 'grid' && !!target?.selectedText) },
      run: async args => {
        const target = targetOf(args), cells = selected(target)
        if (cells) await write(toTsv(cells.set, cells.selection, { headers: false, eol }))
        else if (target && target.view !== 'grid' && target.selectedText) await write(target.selectedText)
      }
    }),
    commands.register('output.copyWithHeaders', {
      when: args => !!selected(targetOf(args)),
      run: async args => { const cells = selected(targetOf(args)); if (cells) await write(toTsv(cells.set, cells.selection, { headers: true, eol })) }
    }),
    commands.register('output.selectAll', {
      when: args => {
        const target = targetOf(args)
        if (target?.view === 'grid') { const shown = grid(target); return !!shown && shown.set.rows.length > 0 && shown.set.columns.length > 0 }
        return !!target?.element.textContent
      },
      run: args => {
        const target = targetOf(args)
        if (target?.view === 'grid') { if (grid(target)) resultSelection.selectAll(target.tabId, target.resultIndex) }
        // Messages and the plan keep text selection; Chromium's Select All would select the whole window.
        else if (target) target.element.ownerDocument.getSelection()?.selectAllChildren(target.element)
      }
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
