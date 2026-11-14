import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { resolveBlocks } from '../grid/selection'
import { outputOf, type LiveOutput, type MenuTargetService, type OutputTarget } from '../menus/targets'
import { entryOf, type SelectionFilter } from '../results/ResultsService'
import { requestFrame, windows } from '../core/windows'
import { focusHeld } from '../core/modal'

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
 * focus. Open Value opens the XML, JSON or plan cell a click or Enter names, else the focused grid's active cell. A live
 * view's grid (view `live`) is the same grid with a live source: the commands it takes act through its `LiveOutput`.
 */
export function outputContribution({ commands, results, menuTargets, documents, settings, resultsSearch, panes }: Pick<Workbench, 'commands' | 'results' | 'menuTargets' | 'documents' | 'settings' | 'resultsSearch' | 'panes'>, api: Pick<VariaApi, 'writeClipboardText'>): Disposable {
  // The setting changes once main has saved it, so a second toggle meanwhile toggles the layout still being saved: two quick
  // presses cancel out, as SettingsService.toggle's do.
  let layoutTarget: 'stacked' | 'tabs' | undefined
  const toggleLayout = async () => {
    const next = (layoutTarget ?? settings.getSnapshot().values['queryResults.grid.layout']) === 'tabs' ? 'stacked' : 'tabs'
    layoutTarget = next
    try { await settings.choose('queryResults.grid.layout', next) } finally { if (layoutTarget === next) layoutTarget = undefined }
  }
  const showWhitespace = (mode: 'spaces' | 'all') =>
    settings.choose('queryResults.grid.whitespace', settings.getSnapshot().values['queryResults.grid.whitespace'] === mode ? 'none' : mode)
  const targetOf = (args?: CommandArgs) => outputOf(args) ?? (args?.target ? undefined : focusedOutput(menuTargets))
  /** The grid's result set (its tab and entry key with it), while its results are still readable and its entry still shows
   *  the stored result the target was read from. */
  const grid = (target: OutputTarget | undefined) => {
    if (target?.view !== 'grid') return undefined
    const set = entryOf(results.getSnapshot()[target.tabId]?.sets, target.entry)
    const state = set?.handle.getSnapshot()
    const current = !target.result || (set?.descriptor.generation === target.result.generation && set.descriptor.resultId === target.result.resultId)
    return set && current && state && state.state !== 'lost' && state.state !== 'released' ? { tabId: target.tabId, key: set.key, set, rows: state.rowsAvailable, columns: set.descriptor.columns.length } : undefined
  }
  const valueCell = (args?: CommandArgs) => {
    let cell: (NonNullable<CommandArgs['cell']> & { tabId: string }) | undefined
    if (args?.cell && args.tabId) cell = { tabId: args.tabId, ...args.cell }
    else {
      const target = targetOf(args), active = target?.view === 'grid' && target.entry !== undefined ? results.selection(target.tabId, target.entry)?.active : undefined
      if (target?.entry !== undefined && active) cell = { tabId: target.tabId, entry: target.entry, row: active.row, column: active.column }
    }
    const tab = cell && results.getSnapshot()[cell.tabId]
    const role = cell && entryOf(cell.capturedPlan ? tab?.planSets : tab?.sets, cell.entry)?.descriptor.columns[cell.column]?.role
    return role && valueRoles.has(role) ? cell : undefined
  }
  /** The grid, when it has cells selected. */
  const selected = (target: OutputTarget | undefined) => {
    const shown = grid(target)
    const selection = shown && results.selection(shown.tabId, shown.key)
    return shown && selection && resolveBlocks(selection, shown.rows, shown.columns).length > 0 ? shown : undefined
  }
  /** The hasResults context key for a query (results not closed, nor lost with a stopped backend), which Find and Save
   *  check in their handlers: a live view's grid has rows without a query's results. */
  const hasResults = (tabId: string | undefined) => !!tabId && !!results.context.getSnapshot()[tabId]
  // What Find and Save say without results: a query's, since a live view's grid always has its own source.
  const noResults = 'Execute a query that returns results first.'
  /** A live grid's commands, and the column captured by its menu, else its active cell's. */
  const liveOf = (args?: CommandArgs): LiveOutput | undefined => { const target = targetOf(args); return target?.view === 'live' ? target.live : undefined }
  const liveColumn = (args?: CommandArgs): { live: LiveOutput; column: number } | undefined => {
    const target = targetOf(args), live = target?.view === 'live' ? target.live : undefined
    const column = live && (target!.column ?? live.activeColumn())
    return live && column !== undefined ? { live, column } : undefined
  }
  const showSortText = (mode: 'chars' | 'bytes') =>
    settings.choose('queryResults.grid.sortText', settings.getSnapshot().values['queryResults.grid.sortText'] === mode ? 'value' : mode)
  /** The column captured by the menu, else the focused grid's active cell. */
  const sortTarget = (args?: CommandArgs) => {
    const target = targetOf(args), shown = grid(target)
    const active = shown && results.selection(shown.tabId, shown.key)?.active
    const column = target?.column ?? active?.column
    return shown && column !== undefined && Number.isInteger(column) && column >= 0 && column < shown.columns && shown.set.descriptor.columns[column].role !== 'tone'
      ? { tabId: shown.tabId, key: shown.key, set: shown.set, column } : undefined
  }
  /**
   * Fit Column in a grid drawn transposed: a drawn column there shows one row of the result, so it is the target's row
   * that is fitted (a cell's or a drawn header's; from the keyboard the active cell's). A target with a column and no row
   * is a name in the frozen first column, and fits that column to its names.
   */
  const drawnFit = (args?: CommandArgs) => {
    const target = targetOf(args), shown = grid(target)
    return shown && results.orientation(shown.tabId, shown.key).transposed ? { tabId: shown.tabId, key: shown.key, row: target?.row } : undefined
  }
  const liveSort = (args?: CommandArgs) => { const at = liveColumn(args); return at && at.live.sortable && at.live.canSort(at.column) ? at : undefined }
  const sortCommand = (direction: 'ascending' | 'descending', add: boolean) => ({
    when: (args?: CommandArgs) => !!sortTarget(args) || !!liveSort(args),
    run: (args?: CommandArgs) => {
      const at = sortTarget(args), live = liveSort(args)
      if (at) results.sortBy(at.tabId, at.key, at.column, direction, add)
      else if (live) live.live.sort(live.column, direction === 'descending', add)
    }
  })
  /** A filter by the grid's selection: the menu's grid, else the focused one. */
  const selectionFilter = (kind: SelectionFilter) => ({
    when: (args?: CommandArgs) => { const shown = grid(targetOf(args)); return !!shown && results.canFilterSelection(shown.tabId, shown.key, kind) },
    run: (args?: CommandArgs) => { const shown = grid(targetOf(args)); if (shown) results.filterSelection(shown.tabId, shown.key, kind) }
  })
  const duplicatesFilter = (allColumns: boolean) => ({
    when: (args?: CommandArgs) => { const shown = grid(targetOf(args)); return !!shown && results.canFilterDuplicates(shown.tabId, shown.key, allColumns) },
    run: (args?: CommandArgs) => { const shown = grid(targetOf(args)); if (shown) results.filterDuplicates(shown.tabId, shown.key, allColumns) }
  })
  /** The tab search in results acts on: the focused output's, else the active query's. */
  const searchTab = (args?: CommandArgs) => targetOf(args)?.tabId ?? documents.getSnapshot().activeId
  const closeTab = (args?: CommandArgs) => {
    const target = outputOf(args) ?? (args?.tabId || args?.target ? undefined : focusedOutput(menuTargets))
    if (args?.target && !target) return undefined
    if (target?.view === 'grid' && (target.bare || !grid(target))) return undefined
    return target?.tabId ?? args?.tabId ?? documents.getSnapshot().activeId
  }
  /** The view Close Result closes: the menu's grid, else the focused one, else (from the palette) the grid that last had
   *  the focus in the named or active query tab, and nothing when none has had it; once the run has ended, and never a
   *  Peek grid. */
  const closeEntry = (args?: CommandArgs) => {
    const named = outputOf(args), focused = named || args?.tabId || args?.target ? undefined : focusedOutput(menuTargets)
    if (args?.target && !named) return undefined
    // A menu's target must be a grid. Focus in Messages (a key, the palette) names no grid: the one last used, as from the editor.
    const target = named ?? (focused?.view === 'grid' ? focused : undefined)
    if (named ? named.view !== 'grid' : focused?.view === 'live') return undefined
    if (target && (target.bare || !grid(target))) return undefined
    const tabId = target?.tabId ?? focused?.tabId ?? args?.tabId ?? documents.getSnapshot().activeId
    const tab = tabId ? results.getSnapshot()[tabId] : undefined
    // Never the run's first result for want of one: closing has no undo, so it takes a grid the user has used.
    const key = target?.entry ?? tab?.focused
    return tabId && tab && key !== undefined && !tab.bare && tab.status !== 'running' && tab.status !== 'closed' ? { tabId, key } : undefined
  }
  /** F3 in a grid moves its active cell to the match as well; from the search box or the editor it only scrolls. */
  const fromGrid = (args?: CommandArgs) => targetOf(args)?.view === 'grid'
  const registrations = [
    commands.register('output.find', {
      unavailable: args => liveOf(args) ? undefined : noResults,
      // A query's results (no hasResults precondition: a live view's grid finds through its owner's filter box).
      when: args => { const live = liveOf(args); return live ? live.canFind() : hasResults(searchTab(args)) },
      run: args => {
        const live = liveOf(args)
        if (live) { live.find(); return }
        const tabId = searchTab(args)
        if (!tabId || !results.getSnapshot()[tabId]?.sets.length) return
        // The box is in the Results view's toolbar.
        results.setView(tabId, 'results')
        resultsSearch.focus(tabId)
      }
    }),
    commands.register('output.findNext', { run: args => { const tabId = searchTab(args); if (tabId) resultsSearch.step(tabId, 1, fromGrid(args)) } }),
    commands.register('output.findPrevious', { run: args => { const tabId = searchTab(args); if (tabId) resultsSearch.step(tabId, -1, fromGrid(args)) } }),
    commands.register('output.sortAscending', sortCommand('ascending', false)),
    commands.register('output.sortDescending', sortCommand('descending', false)),
    commands.register('output.thenSortAscending', sortCommand('ascending', true)),
    commands.register('output.thenSortDescending', sortCommand('descending', true)),
    commands.register('output.clearSort', {
      when: args => { const shown = grid(targetOf(args)), live = liveOf(args); return live ? live.sortable && live.sorted() : !!shown && !!results.sortOf(shown.tabId, shown.key)?.keys.length },
      run: args => { const shown = grid(targetOf(args)), live = liveOf(args); if (live) { if (live.sortable) live.clearSort() } else if (shown) results.clearSort(shown.tabId, shown.key) }
    }),
    commands.register('output.filterColumnValues', {
      when: args => { const at = sortTarget(args), live = liveColumn(args); return live ? live.live.canFilter(live.column) : !!at && results.canFilterColumn(at.tabId, at.key, at.column) },
      run: args => { const at = sortTarget(args), live = liveColumn(args); if (live) { if (live.live.canFilter(live.column)) live.live.filterColumn(live.column) } else if (at) results.filterColumn(at.tabId, at.key, at.column) }
    }),
    commands.register('output.filterSelection', selectionFilter('in')),
    commands.register('output.excludeSelection', selectionFilter('notIn')),
    commands.register('output.filterBetween', selectionFilter('between')),
    commands.register('output.excludeNulls', selectionFilter('notNull')),
    commands.register('output.filterDuplicates', duplicatesFilter(false)),
    commands.register('output.filterDuplicateRows', duplicatesFilter(true)),
    commands.register('output.keepSelectedRows', {
      when: args => { const shown = grid(targetOf(args)); return !!shown && results.canKeepSelectedRows(shown.tabId, shown.key) },
      run: args => { const shown = grid(targetOf(args)); if (shown) results.keepSelectedRows(shown.tabId, shown.key) }
    }),
    commands.register('output.clearFilters', {
      when: args => { const shown = grid(targetOf(args)), live = liveOf(args); return live ? live.filtered() : !!shown && !!results.sortOf(shown.tabId, shown.key)?.filters.length },
      run: args => { const shown = grid(targetOf(args)), live = liveOf(args); if (live) live.clearFilters(); else if (shown) results.clearFilters(shown.tabId, shown.key) }
    }),
    commands.register('output.sortTextByChars', { run: () => showSortText('chars') }),
    commands.register('output.sortTextByBytes', { run: () => showSortText('bytes') }),
    commands.register('output.copy', {
      when: args => { const target = targetOf(args), live = liveOf(args); return live ? live.hasSelection() : !!selected(target) || (target?.view !== 'grid' && !!target?.selectedText) },
      run: async args => {
        const target = targetOf(args), cells = selected(target), live = liveOf(args)
        if (live) { if (live.hasSelection()) live.copy(settings.get('queryResults.grid.includeColumnHeaders')); return }
        // Tools › Options › Query Results › Results to Grid decides the header row; Copy with Headers always has one.
        if (cells) { const failure = await results.copy(cells.tabId, cells.key, settings.get('queryResults.grid.includeColumnHeaders')); if (failure) commands.reportError(failure) }
        else if (target && target.view !== 'grid' && target.selectedText) unwrap(await api.writeClipboardText(target.selectedText))
      }
    }),
    commands.register('output.copyWithHeaders', {
      when: args => { const live = liveOf(args); return live ? live.hasSelection() : !!selected(targetOf(args)) },
      run: async args => {
        const live = liveOf(args)
        if (live) { if (live.hasSelection()) live.copy(true); return }
        const cells = selected(targetOf(args))
        const failure = cells && await results.copy(cells.tabId, cells.key, true)
        if (failure) commands.reportError(failure)
      }
    }),
    commands.register('output.copyColumnName', {
      when: args => { const live = liveColumn(args); return live ? live.live.columnName(live.column) !== undefined : !!sortTarget(args) },
      run: async args => {
        const at = sortTarget(args), live = liveColumn(args), name = live?.live.columnName(live.column)
        if (name !== undefined) unwrap(await api.writeClipboardText(name))
        else if (at) unwrap(await api.writeClipboardText(at.set.descriptor.columns[at.column].name))
      }
    }),
    commands.register('output.fitColumn', {
      when: args => {
        const drawn = drawnFit(args), at = sortTarget(args), live = liveColumn(args)
        return live ? live.live.hasRows() : drawn ? results.canFitDrawn(drawn.tabId, drawn.key, drawn.row) : !!at && results.canFitColumn(at.tabId, at.key, at.column)
      },
      run: args => {
        const drawn = drawnFit(args), at = sortTarget(args), live = liveColumn(args)
        if (live) live.live.fitColumn(live.column)
        else if (drawn) results.fitDrawn(drawn.tabId, drawn.key, drawn.row)
        else if (at) results.fitColumn(at.tabId, at.key, at.column)
      }
    }),
    commands.register('output.saveResultsAs', {
      unavailable: args => liveOf(args) ? undefined : noResults,
      // A query's results, or a live view's grid with rows (which has no query, so no hasResults precondition).
      when: args => { const live = liveOf(args); return live ? live.hasRows() : hasResults(targetOf(args)?.tabId ?? documents.getSnapshot().activeId) },
      run: async args => {
        const live = liveOf(args)
        if (live) { if (live.hasRows()) live.save(); return }
        const target = targetOf(args), tabId = target?.tabId ?? documents.getSnapshot().activeId
        const tab = results.getSnapshot()[tabId]
        if (!tab?.sets.length) return
        // The grid the menu or the caption's button names, else the one that last had the focus.
        const key = target?.view === 'grid' ? target.entry : results.focusedEntry(tabId)?.key
        if (key === undefined) return
        const name = documents.getSnapshot().documents.find(document => document.id === tabId)?.name ?? ''
        const failure = await results.saveAs(tabId, key, baseName(name))
        if (failure) commands.reportError(failure)
      }
    }),
    commands.register('output.openValue', {
      when: args => !!valueCell(args),
      run: async args => {
        const cell = valueCell(args)
        if (!cell) return
        const { opened, message } = await results.openValue(cell.tabId, cell.entry, cell.row, cell.column, cell.capturedPlan)
        if (message) commands.reportError(message)
        // The value's tab is active now; typing goes to it, as in SSMS.
        if (opened) documents.focusActive()
      }
    }),
    commands.register('output.closeResult', {
      when: args => !!closeEntry(args),
      run: args => {
        const target = closeEntry(args)
        if (!target) return
        // The grid unmounts: the focus goes to the grid the service gives it to, else to the Results tab, which stays.
        // Only when the focus is in a grid that closes; elsewhere it stays where it is.
        const closing = new Set(results.closing(target.tabId, target.key).map(entry => entry.key))
        const from = windows.activeElement()?.closest('[data-result-grid]')
        const own = from && closing.has(from.getAttribute('data-result-entry') ?? '') ? from.closest('.output-panel') : undefined
        own?.querySelector<HTMLElement>('[role="tab"][data-output-tab="results"]')?.focus({ preventScroll: true })
        if (!results.removeEntry(target.tabId, target.key) || !own) return
        const next = results.getSnapshot()[target.tabId]?.focused
        if (next !== undefined) own.querySelector<HTMLElement>(`[data-result-grid][data-result-entry="${next}"]`)?.focus({ preventScroll: true })
      }
    }),
    commands.register('output.closeResults', {
      when: args => { const tabId = closeTab(args); return !!tabId && !!results.context.getSnapshot()[tabId] && results.getSnapshot()[tabId]?.status !== 'running' },
      run: args => {
        const tabId = closeTab(args)
        if (!tabId) return
        // The grid and its tools unmount. Leave focus on the surviving Results tab in their own window; closing another
        // query's contextual results leaves focus in the current query alone.
        const active = windows.activeElement(), panel = active?.closest('.output-panel')
        const ownPanel = panel?.getAttribute('data-tab-id') === tabId ? panel : undefined
        const before = ownPanel?.querySelector<HTMLElement>('[role="tab"][data-output-tab="results"]')
        before?.focus({ preventScroll: true })
        results.closeResults(tabId)
        if (ownPanel && ownPanel.getAttribute('data-output-panel') !== 'results') {
          const doc = ownPanel.ownerDocument, queryId = results.getSnapshot()[tabId]?.queryId
          let moved = false
          const input = () => { moved = true }, events = ['pointerdown', 'focusin'] as const
          for (const event of events) doc.addEventListener(event, input, true)
          panes.select('results')
          // Messages' copy of the Results tab leaves when its panel switches. Focus the surviving tab after that render,
          // provided the same output still owns focus; a later editor, menu, dialog or execution takes precedence.
          requestFrame(() => {
            for (const event of events) doc.removeEventListener(event, input, true)
            const focused = doc.activeElement, run = results.getSnapshot()[tabId]
            if (moved || focusHeld() || windows.activeDocument() !== doc || !run || run.queryId !== queryId || run.status !== 'closed'
              || focused && focused !== doc.body && focused !== before && focused !== active) return
            const target = doc.querySelector<HTMLElement>('[data-output-panel="results"] [data-output-tab="results"]')
            if (target?.closest('[data-tab-id]')?.getAttribute('data-tab-id') === tabId && target.checkVisibility()) target.focus({ preventScroll: true })
          })
        }
      }
    }),
    commands.register('output.selectAll', {
      when: args => {
        const target = targetOf(args)
        if (target?.view === 'live') return !!target.live?.hasRows()
        if (target?.view === 'grid') { const shown = grid(target); return !!shown && shown.rows > 0 && shown.columns > 0 }
        return !!target?.element.textContent
      },
      run: args => {
        const target = targetOf(args)
        if (target?.view === 'live') { if (target.live?.hasRows()) target.live.selectAll() }
        else if (target?.view === 'grid') { const shown = grid(target); if (shown) results.selectAll(shown.tabId, shown.key) }
        // Messages keep text selection; Chromium's Select All would select the whole window.
        else if (target) target.element.ownerDocument.getSelection()?.selectAllChildren(target.element)
      }
    }),
    // Saved, or applied for this session when the save fails (SettingsService.choose); a choice already on turns the marks off.
    commands.register('output.showSpaces', { run: () => showWhitespace('spaces') }),
    commands.register('output.showAllWhitespace', { run: () => showWhitespace('all') }),
    commands.register('output.toggleColumnProfile', { run: () => settings.toggle('queryResults.grid.columnProfile') }),
    commands.register('output.toggleResultsTabs', { run: toggleLayout }),
    commands.register('output.toggleRowSize', { run: () => settings.toggle('queryResults.grid.rowSize') })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
