import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { resolveBlocks } from '../grid/selection'
import { outputOf, type MenuTargetService, type OutputTarget } from '../menus/targets'
import { windows } from '../core/windows'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }

/** The Query Output view that has focus, read as its menu would be: keys and the Edit menu act on it. */
export function focusedOutput(menuTargets: Pick<MenuTargetService, 'targetFor'>): OutputTarget | undefined {
  const hit = typeof document === 'undefined' ? undefined : menuTargets.targetFor(windows.activeElement())
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
export function outputContribution({ commands, results, menuTargets, documents, settings, resultsSearch }: Pick<Workbench, 'commands' | 'results' | 'menuTargets' | 'documents' | 'settings' | 'resultsSearch'>, api: Pick<VariaApi, 'writeClipboardText'>): Disposable {
  const showWhitespace = (mode: 'spaces' | 'all') =>
    settings.choose('queryResults.grid.whitespace', settings.getSnapshot().values['queryResults.grid.whitespace'] === mode ? 'none' : mode)
  const targetOf = (args?: CommandArgs) => outputOf(args) ?? (args?.target ? undefined : focusedOutput(menuTargets))
  /** The grid's result set, while its results are still readable. */
  const grid = (target: OutputTarget | undefined) => {
    if (target?.view !== 'grid') return undefined
    const set = results.getSnapshot()[target.tabId]?.sets[target.resultIndex]
    const state = set?.handle.getSnapshot()
    const current = !target.result || (set?.descriptor.generation === target.result.generation && set.descriptor.resultId === target.result.resultId)
    return set && current && state && state.state !== 'lost' && state.state !== 'released' ? { set, rows: state.rowsAvailable, columns: set.descriptor.columns.length } : undefined
  }
  const valueCell = (args?: CommandArgs) => {
    let cell: (NonNullable<CommandArgs['cell']> & { tabId: string }) | undefined
    if (args?.cell && args.tabId) cell = { tabId: args.tabId, ...args.cell }
    else {
      const target = targetOf(args), active = target?.view === 'grid' ? results.selection(target.tabId, target.resultIndex)?.active : undefined
      if (target && active) cell = { tabId: target.tabId, resultIndex: target.resultIndex, row: active.row, column: active.column }
    }
    const tab = cell && results.getSnapshot()[cell.tabId]
    const role = cell && (cell.capturedPlan ? tab?.planSets : tab?.sets)?.[cell.resultIndex]?.descriptor.columns[cell.column]?.role
    return role && valueRoles.has(role) ? cell : undefined
  }
  const selected = (target: OutputTarget | undefined) => {
    const shown = grid(target)
    const selection = shown && results.selection(target!.tabId, target!.resultIndex)
    return shown && selection && resolveBlocks(selection, shown.rows, shown.columns).length > 0 ? target : undefined
  }
  const showSortText = (mode: 'chars' | 'bytes') =>
    settings.choose('queryResults.grid.sortText', settings.getSnapshot().values['queryResults.grid.sortText'] === mode ? 'value' : mode)
  /** The column captured by the menu, else the focused grid's active cell. */
  const sortTarget = (args?: CommandArgs) => {
    const target = targetOf(args), shown = grid(target)
    const active = shown && results.selection(target!.tabId, target!.resultIndex)?.active
    const column = target?.column ?? active?.column
    return shown && column !== undefined && Number.isInteger(column) && column >= 0 && column < shown.columns && shown.set.descriptor.columns[column].role !== 'tone'
      ? { tabId: target!.tabId, index: target!.resultIndex, column } : undefined
  }
  const sortCommand = (direction: 'ascending' | 'descending', add: boolean) => ({
    when: (args?: CommandArgs) => !!sortTarget(args),
    run: (args?: CommandArgs) => { const at = sortTarget(args); if (at) results.sortBy(at.tabId, at.index, at.column, direction, add) }
  })
  /** The tab search in results acts on: the focused output's, else the active query's. */
  const searchTab = (args?: CommandArgs) => targetOf(args)?.tabId ?? documents.getSnapshot().activeId
  const closeTab = (args?: CommandArgs) => {
    const target = outputOf(args) ?? (args?.tabId || args?.target ? undefined : focusedOutput(menuTargets))
    if (args?.target && !target) return undefined
    if (target?.view === 'grid' && !grid(target)) return undefined
    return target?.tabId ?? args?.tabId ?? documents.getSnapshot().activeId
  }
  const registrations = [
    commands.register('output.find', {
      run: args => {
        const tabId = searchTab(args)
        if (!tabId || !results.getSnapshot()[tabId]?.sets.length) return
        // The box is in the Results view's toolbar.
        results.setView(tabId, 'results')
        resultsSearch.focus(tabId)
      }
    }),
    commands.register('output.findNext', { run: args => { const tabId = searchTab(args); if (tabId) resultsSearch.step(tabId, 1) } }),
    commands.register('output.findPrevious', { run: args => { const tabId = searchTab(args); if (tabId) resultsSearch.step(tabId, -1) } }),
    commands.register('output.sortAscending', sortCommand('ascending', false)),
    commands.register('output.sortDescending', sortCommand('descending', false)),
    commands.register('output.thenSortAscending', sortCommand('ascending', true)),
    commands.register('output.thenSortDescending', sortCommand('descending', true)),
    commands.register('output.clearSort', {
      when: args => { const target = targetOf(args); return !!grid(target) && !!results.sortOf(target!.tabId, target!.resultIndex) },
      run: args => { const target = targetOf(args); if (target && grid(target)) results.clearSort(target.tabId, target.resultIndex) }
    }),
    commands.register('output.sortTextByChars', { run: () => showSortText('chars') }),
    commands.register('output.sortTextByBytes', { run: () => showSortText('bytes') }),
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
    commands.register('output.copyColumnName', {
      when: args => !!sortTarget(args),
      run: async args => {
        const at = sortTarget(args)
        if (at) unwrap(await api.writeClipboardText(results.getSnapshot()[at.tabId].sets[at.index].descriptor.columns[at.column].name))
      }
    }),
    commands.register('output.fitColumn', {
      when: args => { const at = sortTarget(args); return !!at && results.canFitColumn(at.tabId, at.index, at.column) },
      run: args => { const at = sortTarget(args); if (at) results.fitColumn(at.tabId, at.index, at.column) }
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
        const { opened, message } = await results.openValue(cell.tabId, cell.resultIndex, cell.row, cell.column, cell.capturedPlan)
        if (message) commands.reportError(message)
        // The value's tab is active now; typing goes to it, as in SSMS.
        if (opened) documents.focusActive()
      }
    }),
    commands.register('output.closeResults', {
      when: args => { const tabId = closeTab(args); return !!tabId && !!results.context.getSnapshot()[tabId] && results.getSnapshot()[tabId]?.status !== 'running' },
      run: args => {
        const tabId = closeTab(args)
        if (!tabId) return
        // The grid and its tools unmount. Leave focus on the surviving Results tab in their own window; closing another
        // query's contextual results leaves focus in the current query alone.
        const panel = windows.activeElement()?.closest('.output-panel')
        if (panel?.getAttribute('data-tab-id') === tabId) panel.querySelector<HTMLElement>('[role="tab"][data-output-tab="results"]')?.focus({ preventScroll: true })
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
    }),
    // Saved, or applied for this session when the save fails (SettingsService.choose); a choice already on turns the marks off.
    commands.register('output.showSpaces', { run: () => showWhitespace('spaces') }),
    commands.register('output.showAllWhitespace', { run: () => showWhitespace('all') }),
    commands.register('output.toggleColumnProfile', { run: () => settings.toggle('queryResults.grid.columnProfile') }),
    commands.register('output.toggleRowSize', { run: () => settings.toggle('queryResults.grid.rowSize') })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
