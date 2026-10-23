import { isSsisDocumentKind, ssisVerbs, ssisVerbSpecs } from '../../../shared/ssis/catalog.ts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, type ExplorerMenuNode } from '../menus/targets'

/**
 * The SSIS Catalog's verbs (src/shared/ssis/catalog.ts): Properties on a folder, project, package or environment opens
 * its properties document, acting on the node its menu was opened for, else the selected one (the palette, Enter and a
 * double-click on a package or environment), on a live server. Refresh reads the document whose header runs it
 * (`tabId`), else the active one.
 */
export function ssisContribution({ commands, explorer, ssisProperties, documents, connections }: Pick<Workbench, 'commands' | 'explorer' | 'ssisProperties' | 'documents' | 'connections'>): Disposable {
  const nodeOf = (args?: CommandArgs): ExplorerMenuNode | undefined => args?.target ? explorerNodeOf(args) : explorer.menuNode(explorer.getSnapshot().selected)
  const registrations = [
    ...ssisVerbs.map(verb => {
      const spec = ssisVerbSpecs[verb]
      const target = (args?: CommandArgs) => {
        const node = nodeOf(args)
        return node && !node.lost && node.kind !== 'folder' && spec.kinds.includes(node.kind) && node.ref.type === 'object' && connections.isLive(node.connectionId) ? node : undefined
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
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
