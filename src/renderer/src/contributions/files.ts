import { fileShortcut } from '../../../shared/shortcuts'
import type { CommandService } from '../core/commands'
import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

export function filesContribution({ files, commands }: Pick<Workbench, 'files' | 'commands'>): Disposable {
  const registrations = [
    commands.register('file.new', { when: () => files.canRun(), run: () => files.newFile() }),
    commands.register('file.open', { when: () => files.canRun(), run: () => files.open() }),
    commands.register('file.save', { when: context => files.canSave(context?.tabId), run: context => files.save(context?.tabId) }),
    commands.register('file.saveAs', { when: context => files.canSave(context?.tabId), run: context => files.save(context?.tabId, true) }),
    commands.register('file.close', { when: context => files.canClose(context?.tabId), run: context => files.close(context?.tabId) })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}

export function bindFileShortcuts(target: Document, platform: string, commands: CommandService): Disposable {
  const keyDown = (event: KeyboardEvent) => {
    const primary = platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    if (!primary || event.altKey) return
    const action = fileShortcut(event.key, event.shiftKey)
    if (action) { event.preventDefault(); event.stopPropagation(); void commands.run(action) }
  }
  target.addEventListener('keydown', keyDown, true)
  return { dispose: () => target.removeEventListener('keydown', keyDown, true) }
}
