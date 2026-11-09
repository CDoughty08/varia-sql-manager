import type { Workbench } from '../core/workbench'
import type { CommandArgs, Disposable } from '../core/types'

/** Errors carry structured source lines; old menus and edited query text never redirect into another execution. */
export function messagesContribution({ commands, documents, queries, results }: Pick<Workbench, 'commands' | 'documents' | 'queries' | 'results'>): Disposable {
  const location = (args?: CommandArgs) => {
    const tabId = args?.tabId, selected = args?.message
    if (!tabId || !selected || !Number.isInteger(selected.index) || selected.index < 0) return undefined
    const tab = results.getSnapshot()[tabId], entry = tab?.messages[selected.index]
    if (tab?.queryId !== selected.queryId || entry?.kind !== 'error' || entry.line !== selected.line) return undefined
    const line = queries.sourceLine(tabId, selected.queryId, entry.line)
    return line === undefined ? undefined : { tabId, line, revision: documents.revision(tabId) }
  }
  return commands.register('output.revealError', {
    when: args => !!location(args),
    run: args => { const at = location(args); if (at) documents.revealLine(at.tabId, at.line, at.revision) }
  })
}
