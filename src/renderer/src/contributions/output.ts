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

/** Columns whose values open in a document tab: XML (FOR XML too), JSON (FOR JSON too) and execution plans. */
const valueRoles: ReadonlySet<string> = new Set(['xml', 'json', 'plan'])

/** "SQLQuery1" for SQLQuery1.sql: the start of Save Results As's suggested file name. */
const baseName = (name: string) => name.replace(/\.[^.]*$/, '') || 'Results'

/**
 * Copy, Copy with Headers, Select All, Save Results As, Close Results and Open Value in Query Output. A grid copies its
 * selected cells through the backend (ResultsService.copy: SSMS's tab-separated text, with Windows line breaks on
 * Windows); Messages copy the text selected in them. The commands act on the menu's target, else on the view that has
 * focus (Ctrl+C, Ctrl+Shift+C, Ctrl+S, Edit › Copy); Save Results As from the palette acts on the grid that last had
 * focus. Open Value opens the XML, JSON or plan cell a click or Enter names, else the focused grid's active cell.
 */
export function outputContribution({ commands, results, menuTargets, documents, settings }: Pick<Workbench, 'commands' | 'results' | 'menuTargets' | 'documents' | 'settings'>, api: Pick<VariaApi, 'writeClipboardText'>): Disposable {
  const targetOf = (args?: CommandArgs) => outputOf(args) ?? (args?.target ? undefined : focusedOutput(menuTargets))
  /** The grid's result set, while its results are still readable. */
  const grid = (target: OutputTarget | undefined) => {
    if (target?.view !== 'grid') return undefined
    const set = results.getSnapshot()[target.tabId]?.sets[target.resultIndex]
    const state = set?.handle.getSnapshot()
    return set && state && state.state !== 'lost' && state.state !== 'released' ? { set, rows: state.rowsAvailable, columns: set.descriptor.columns.length } : undefined
  }
  const valueCell = (args?: CommandArgs) => {
    let cell: { tabId: string; resultIndex: number; row: number; column: number } | undefined
    if (args?.cell && args.tabId) cell = { tabId: args.tabId, ...args.cell }
    else {
      const target = targetOf(args), active = target?.view === 'grid' ? results.selection(target.tabId, target.resultIndex)?.active : undefined
      if (target && active) cell = { tabId: target.tabId, resultIndex: target.resultIndex, row: active.row, column: active.column }
    }
    const role = cell && results.getSnapshot()[cell.tabId]?.sets[cell.resultIndex]?.descriptor.columns[cell.column]?.role
    return role && valueRoles.has(role) ? cell : undefined
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
        // Tools › Options › Query Results › Results to Grid decides the header row; Copy with Headers always has one.
        if (cells) { const failure = await results.copy(cells.tabId, cells.resultIndex, settings.get('queryResults.grid.includeColumnHeaders')); if (failure) commands.reportError(failure) }
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
    commands.register('output.saveResultsAs', {
      run: async args => {
        const target = targetOf(args), tabId = target?.tabId ?? documents.getSnapshot().activeId
        const tab = results.getSnapshot()[tabId]
        if (!tab?.sets.length) return
        const index = target?.view === 'grid' ? target.resultIndex : Math.min(results.viewState(tabId).focusedIndex, tab.sets.length - 1)
        const name = documents.getSnapshot().documents.find(document => document.id === tabId)?.name ?? ''
        const failure = await results.saveAs(tabId, index, baseName(name))
        if (failure) commands.reportError(failure)
      }
    }),
    commands.register('output.openValue', {
      when: args => !!valueCell(args),
      run: async args => {
        const cell = valueCell(args)
        if (!cell) return
        const { opened, message } = await results.openValue(cell.tabId, cell.resultIndex, cell.row, cell.column)
        if (message) commands.reportError(message)
        // The value's tab is active now; typing goes to it, as in SSMS.
        if (opened) documents.boundEditor?.focus()
      }
    }),
    commands.register('output.closeResults', {
      run: () => {
        const tabId = documents.getSnapshot().activeId
        if (!tabId) return
        // Closing unmounts the grids and Messages, which would drop focus held in them to <body>, and selects the Results
        // tab, which stays (saying the results were closed): focus in the view or on its tabs moves there first. Focus
        // anywhere else stays put.
        const view = typeof document === 'undefined' ? null : document.activeElement?.closest('.output-view, .output-toolbar [role="tablist"]')
        view?.closest('.output-panel')?.querySelector<HTMLElement>('[role="tab"][data-output-tab="results"]')?.focus({ preventScroll: true })
        results.closeResults(tabId)
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
