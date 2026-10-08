import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

export function filesContribution({ files, commands, documents }: Pick<Workbench, 'files' | 'commands' | 'documents'>): Disposable {
  const registrations = [
    commands.register('file.new', { when: () => files.canRun(), run: () => files.newFile() }),
    commands.register('file.open', { when: () => files.canRun(), run: () => files.open() }),
    commands.register('file.save', { when: context => files.canSave(context?.tabId), run: context => files.save(context?.tabId) }),
    commands.register('file.saveAs', { when: context => files.canSave(context?.tabId), run: context => files.save(context?.tabId, true) }),
    commands.register('file.close', { when: context => files.canClose(context?.tabId), run: context => files.close(context?.tabId) }),
    commands.register('file.closeAll', { when: () => files.canRun(), run: () => files.closeMany(documents.getSnapshot().documents.map(document => document.id)) })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
