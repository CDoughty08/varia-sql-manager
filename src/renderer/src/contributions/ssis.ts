import { operationsPresets, operationsPresetSpecs, type OperationsPreset } from '../../../shared/ssis/operations'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf } from '../menus/targets'

/**
 * Integration Services Operations (src/shared/ssis/operations.ts): Active Operations, All Executions, All Validations and All
 * Operations open a connection's document with their filters; on the SSISDB node they act on its server, from View or the
 * palette on the server of the Object Explorer selection, else of the active document, else the only connected one. The
 * document's own commands act on the document whose menu or header runs them (`tabId`), else the active one.
 */
export function ssisContribution({ commands, explorer, operations, documents, connections }: Pick<Workbench, 'commands' | 'explorer' | 'operations' | 'documents' | 'connections'>): Disposable {
  const connectionFor = (args?: CommandArgs): string | undefined => {
    const node = explorerNodeOf(args)
    if (node) return node.kind === 'ssisCatalog' && !node.lost && connections.isLive(node.connectionId) ? node.connectionId : undefined
    const selected = explorer.menuNode(explorer.getSnapshot().selected)
    if (selected && !selected.lost && connections.isLive(selected.connectionId)) return selected.connectionId
    const active = documents.active?.connectionId
    if (active && connections.isLive(active)) return active
    const live = connections.getSnapshot().filter(connection => !connection.lost)
    return live.length === 1 ? live[0].id : undefined
  }
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
    ...operationsPresets.map(preset => commands.register(operationsPresetSpecs[preset].command, open(preset))),
    commands.register('ssis.stopOperation', on(id => operations.requestStop(id), id => operations.stoppable(id))),
    commands.register('ssis.refreshOperations', on(id => operations.refresh(id), id => operations.refreshable(id))),
    commands.register('ssis.pauseOperations', on(id => operations.togglePause(id), id => operations.pausable(id))),
    commands.register('ssis.copyOperations', on(id => operations.copy(id, false))),
    commands.register('ssis.copyOperationsWithHeaders', on(id => operations.copy(id, true)))
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
