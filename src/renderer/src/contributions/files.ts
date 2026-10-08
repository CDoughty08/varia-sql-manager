import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }

/** File commands act on the tab a toolbar button or query tab menu names (`tabId`), otherwise on the active query. */
export function filesContribution({ files, commands, documents }: Pick<Workbench, 'files' | 'commands' | 'documents'>, api: Pick<VariaApi, 'writeClipboardText' | 'revealSqlFile'>): Disposable {
  const tabOf = (context?: CommandArgs) => context?.tabId ?? documents.getSnapshot().activeId
  const fileOf = (context?: CommandArgs) => documents.get(tabOf(context))?.file
  const registrations = [
    commands.register('file.new', { when: () => files.canRun(), run: () => files.newFile() }),
    commands.register('file.open', { when: () => files.canRun(), run: () => files.open() }),
    commands.register('file.save', { when: context => files.canSave(context?.tabId), run: context => files.save(context?.tabId) }),
    commands.register('file.saveAs', { when: context => files.canSave(context?.tabId), run: context => files.save(context?.tabId, true) }),
    commands.register('file.close', { when: context => files.canClose(context?.tabId), run: context => files.close(context?.tabId) }),
    commands.register('file.closeOthers', {
      when: context => files.canRun() && !!documents.get(tabOf(context)),
      run: context => { const keep = tabOf(context); return files.closeMany(documents.getSnapshot().documents.flatMap(document => document.id === keep ? [] : [document.id])) }
    }),
    commands.register('file.closeAll', { when: () => files.canRun(), run: () => files.closeMany(documents.getSnapshot().documents.map(document => document.id)) }),
    // Main writes the clipboard: navigator.clipboard rejects while the window is not focused.
    commands.register('file.copyPath', { when: context => !!fileOf(context), run: async context => { const file = fileOf(context); if (file) unwrap(await api.writeClipboardText(file.path)) } }),
    // Main looks the path up by the file's id, so the renderer never names a path to show.
    commands.register('file.revealInFolder', { when: context => !!fileOf(context), run: async context => { const file = fileOf(context); if (file) unwrap(await api.revealSqlFile(file.id)) } })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
