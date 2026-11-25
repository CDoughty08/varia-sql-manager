import { isSsisDocumentKind, ssisVerbs, ssisVerbSpecs } from '../../../shared/ssis/catalog.ts'
import { operationsPresets, operationsPresetSpecs, type OperationsPreset } from '../../../shared/ssis/operations'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, type ExplorerMenuNode } from '../menus/targets'

/**
 * The SSIS Catalog's verbs (src/shared/ssis/catalog.ts): Properties on a folder, project, package or environment opens
 * its properties document, acting on the node its menu was opened for, else the selected one (the palette, Enter and a
 * double-click on a package or environment), on a live server. Refresh reads the document whose header runs it
 * (`tabId`), else the active one.
 *
 * The Integration Services document (src/shared/ssis/operations.ts, ./execution.ts): Active Operations, All Executions, All
 * Validations and All Operations open a connection's document at its list with their filters; on the SSISDB node they act on
 * its server, from View or the palette on the server of the Object Explorer selection, else of the active document, else the
 * only connected one. A package's Executions and Last Execution open it at the package's runs or its newest run. The document's own
 * commands (Open, Back, Forward, Refresh, …) act on the document whose menu or header runs them (`tabId`), else the active one.
 */
export function ssisContribution({ commands, explorer, ssisProperties, operations, documents, connections, settings }: Pick<Workbench, 'commands' | 'explorer' | 'ssisProperties' | 'operations' | 'documents' | 'connections' | 'settings'>): Disposable {
  const nodeOf = (args?: CommandArgs): ExplorerMenuNode | undefined => args?.target ? explorerNodeOf(args) : explorer.menuNode(explorer.getSnapshot().selected)
  const connectionFor = (args?: CommandArgs): string | undefined => {
    const node = explorerNodeOf(args)
    if (node) return node.kind === 'ssisCatalog' && !node.lost && connections.isLiveSqlServer(node.connectionId) ? node.connectionId : undefined
    const selected = explorer.menuNode(explorer.getSnapshot().selected)
    if (selected && !selected.lost && connections.isLiveSqlServer(selected.connectionId)) return selected.connectionId
    const active = documents.active?.connectionId
    if (active && connections.isLiveSqlServer(active)) return active
    const live = connections.liveSqlServer()
    return live.length === 1 ? live[0].id : undefined
  }
  // A package node's folder, project and name, on a live server.
  const packageOf = (args?: CommandArgs) => {
    const node = nodeOf(args)
    const target = node && !node.lost && node.kind === 'ssisPackage' && node.ref.type === 'object' ? node.ref.object : undefined
    return node && target?.name && target.ssisFolder && target.ssisProject && connections.isLiveSqlServer(node.connectionId)
      ? { connectionId: node.connectionId, folder: target.ssisFolder, project: target.ssisProject, name: target.name } : undefined
  }
  const onPackage = (action: (target: NonNullable<ReturnType<typeof packageOf>>) => unknown) => ({
    when: (args?: CommandArgs) => !!packageOf(args),
    run: (args?: CommandArgs) => {
      const target = packageOf(args)
      if (!target) return
      action(target)
      documents.focusActive()
    }
  })
  const documentOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return operations.get(id) ? id : undefined }
  const open = (preset: OperationsPreset) => ({
    when: (args?: CommandArgs) => !!connectionFor(args),
    run: (args?: CommandArgs) => {
      const connectionId = connectionFor(args)
      if (!connectionId) return
      operations.open(connectionId, preset)
      documents.focusActive()
    }
  })
  const on = (action: (id: string) => unknown, when: (id: string) => boolean = () => true) => ({
    when: (args?: CommandArgs) => { const id = documentOf(args); return !!id && when(id) },
    run: async (args?: CommandArgs) => { const id = documentOf(args); if (id && when(id)) await action(id) }
  })
  const registrations = [
    ...ssisVerbs.map(verb => {
      const spec = ssisVerbSpecs[verb]
      const target = (args?: CommandArgs) => {
        const node = nodeOf(args)
        return node && !node.lost && node.kind !== 'folder' && spec.kinds.includes(node.kind) && node.ref.type === 'object' && connections.isLiveSqlServer(node.connectionId) ? node : undefined
      }
      return commands.register(spec.command, {
        when: args => !!target(args),
        run: args => {
          const node = target(args)
          if (!node) return
          ssisProperties.open(node)
          // The document's focus waits a frame for it to mount (the workbench's provider focus), after a menu returns focus to the tree.
          documents.focusActive()
        }
      })
    }),
    commands.register('ssis.refreshProperties', {
      when: args => { const id = args?.tabId ?? documents.getSnapshot().activeId; return isSsisDocumentKind(documents.get(id)?.kind) && ssisProperties.canRefresh(id) },
      run: args => ssisProperties.refresh(args?.tabId ?? documents.getSnapshot().activeId)
    }),
    ...operationsPresets.map(preset => commands.register(operationsPresetSpecs[preset].command, open(preset))),
    commands.register('ssis.stopOperation', on(id => operations.requestStop(id), id => operations.stoppable(id))),
    commands.register('ssis.refreshOperations', on(id => operations.refreshPlace(id), id => operations.placeRefreshable(id))),
    commands.register('ssis.pauseOperations', on(id => operations.togglePause(id), id => operations.pausable(id))),
    commands.register('ssis.copyOperations', on(id => operations.copy(id, settings.getSnapshot().values['queryResults.grid.copyColumnHeaders']))),
    commands.register('ssis.copyOperationsWithHeaders', on(id => operations.copy(id, true))),
    // Open on an execution's row drills to its run page in place; Back and Forward walk the document's places.
    commands.register('ssis.openExecution', on(async id => {
      const execution = await operations.selectedExecution(id)
      if (execution) operations.go(id, { kind: 'execution', executionId: execution.executionId })
    }, id => operations.executionSelected(id))),
    commands.register('ssis.goBack', on(id => operations.step(id, -1), id => operations.canGoBack(id))),
    commands.register('ssis.goForward', on(id => operations.step(id, 1), id => operations.canGoForward(id))),
    commands.register('ssis.packageExecutions', onPackage(target => operations.openPackage(target.connectionId, target.folder, target.project, target.name))),
    commands.register('ssis.lastRun', onPackage(target => operations.openLastRun(target.connectionId, target.folder, target.project, target.name)))
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
