import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { resolveBlocks } from '../grid/selection'
import { outputOf, type MenuTargetService, type OutputTarget } from '../menus/targets'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }

/** The Query Output view that has focus, read as its menu would be: keys and the Edit menu act on it. */
export function focusedOutput(menuTargets: Pick<MenuTargetService, 'targetFor'>): OutputTarget | undefined {
  const hit = typeof document === 'undefined' ? undefined : menuTargets.targetFor(document.activeElement)
  return hit?.target.kind === 'output' ? hit.target : undefined
}

/**
 * Copy, Copy with Headers, and Select All in Query Output. A grid copies its selected cells through the backend
 * (ResultsService.copy: SSMS's tab-separated text, with Windows line breaks on Windows); Messages copy the text selected
 * in them. The commands act on the menu's target, else on the view that has focus (Ctrl+C, Ctrl+Shift+C, Edit › Copy).
 */
export function outputContribution({ commands, results, menuTargets }: Pick<Workbench, 'commands' | 'results' | 'menuTargets'>, api: Pick<VariaApi, 'writeClipboardText'>): Disposable {
  const targetOf = (args?: CommandArgs) => outputOf(args) ?? (args?.target ? undefined : focusedOutput(menuTargets))
  /** The grid's result set, while its results are still readable. */
  const grid = (target: OutputTarget | undefined) => {
    if (target?.view !== 'grid') return undefined
    const set = results.getSnapshot()[target.tabId]?.sets[target.resultIndex]
    const state = set?.handle.getSnapshot()
    return set && state && state.state !== 'lost' && state.state !== 'released' ? { set, rows: state.rowsAvailable, columns: set.descriptor.columns.length } : undefined
  }
  const selected = (target: OutputTarget | undefined) => {
    const shown = grid(target)
    const selection = shown && results.selection(target!.tabId, target!.resultIndex)
    return shown && selection && resolveBlocks(selection, shown.rows, shown.columns).length > 0 ? target : undefined
  }
  const registrations = [
    commands.register('output.copy', {
      when: args => { const target = targetOf(args); return !!selected(target) || (target?.view !== 'grid' && !!target?.selectedText) },
      run: async args => {
        const target = targetOf(args), cells = selected(target)
        if (cells) { const failure = await results.copy(cells.tabId, cells.resultIndex, false); if (failure) commands.reportError(failure) }
        else if (target && target.view !== 'grid' && target.selectedText) unwrap(await api.writeClipboardText(target.selectedText))
      }
    }),
    commands.register('output.copyWithHeaders', {
      when: args => !!selected(targetOf(args)),
      run: async args => {
        const cells = selected(targetOf(args))
        const failure = cells && await results.copy(cells.tabId, cells.resultIndex, true)
        if (failure) commands.reportError(failure)
      }
    }),
    commands.register('output.selectAll', {
      when: args => {
        const target = targetOf(args)
        if (target?.view === 'grid') { const shown = grid(target); return !!shown && shown.rows > 0 && shown.columns > 0 }
        return !!target?.element.textContent
      },
      run: args => {
        const target = targetOf(args)
        if (target?.view === 'grid') { if (grid(target)) results.selectAll(target.tabId, target.resultIndex) }
        // Messages keep text selection; Chromium's Select All would select the whole window.
        else if (target) target.element.ownerDocument.getSelection()?.selectAllChildren(target.element)
      }
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
