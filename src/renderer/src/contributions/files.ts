import type { ApiResult, RecentFile, VariaApi } from '../../../shared/contracts'
import { shortenPath } from '../../../shared/files/recent'
import { browserTimers, type Timers } from '../core/timers'
import type { CommandArgs, Disposable, ExternalStore } from '../core/types'
import type { Workbench } from '../core/workbench'
import type { FileService } from '../services/files'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }

const frame = (callback: () => void) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback); else callback() }

/**
 * File commands act on the tab a toolbar button or query tab menu names (`tabId`), otherwise on the active query. New
 * Query with Object Explorer focused opens on the selected node's server and database, as in SSMS.
 */
export function filesContribution({ files, commands, documents, context, explorer, connections, recentFiles, quickInput, recovery }: Pick<Workbench, 'files' | 'commands' | 'documents'> & {
  readonly context: Pick<Workbench['context'], 'get'>; readonly explorer: Pick<Workbench['explorer'], 'queryTarget'>; readonly connections: Pick<Workbench['connections'], 'get'>
  readonly recentFiles?: ExternalStore<readonly RecentFile[]>; readonly quickInput?: Pick<Workbench['quickInput'], 'pick'>
  readonly recovery?: Pick<Workbench['recovery'], 'getSnapshot' | 'refresh' | 'openDialog'>
}, api: Pick<VariaApi, 'writeClipboardText' | 'revealSqlFile'> & Partial<Pick<VariaApi, 'clearRecentFiles'>>): Disposable {
  const tabOf = (context?: CommandArgs) => context?.tabId ?? documents.getSnapshot().activeId
  const fileOf = (context?: CommandArgs) => documents.get(tabOf(context))?.file
  const newQuery = () => {
    const target = context.get().activePanel === 'explorer' ? explorer.queryTarget() : undefined
    if (!target) { files.newFile(); return }
    files.newFile(target.connectionId, target.database ?? connections.get(target.connectionId)?.database)
    // Focus stays in the tree otherwise; SSMS puts it in the new query window.
    frame(() => documents.boundEditor?.focus())
  }
  const listed = (id: string) => !!recentFiles?.getSnapshot().some(file => file.id === id)
  /** Open Recent File… from the palette: the list, newest first, filtered by name or path. */
  const pickRecent = async () => {
    const list = recentFiles?.getSnapshot() ?? []
    const item = await quickInput?.pick({
      ariaLabel: 'Open Recent File', title: 'Open Recent File', placeholder: 'Type to filter recently opened files', noun: 'files', sort: 'none', matchOnDescription: true,
      items: list.map(file => ({ id: file.id, label: file.name, description: shortenPath(file.path, 120), tooltip: file.path, icon: 'history' as const }))
    })
    if (item) await files.openRecent(item.id)
  }
  const registrations = [
    commands.register('file.new', { when: () => files.canRun(), run: newQuery }),
    commands.register('file.open', { when: () => files.canRun(), run: () => files.open() }),
    commands.register('file.save', { when: context => files.canSave(context?.tabId), run: context => files.save(context?.tabId) }),
    commands.register('file.saveAs', { when: context => files.canSave(context?.tabId), run: context => files.save(context?.tabId, true) }),
    commands.register('file.saveAll', { when: () => files.canSaveAll(), run: () => files.saveAll() }),
    // A Recent Files item names its entry; the palette picks one.
    commands.register('file.openRecent', {
      when: context => files.canRun() && (context?.recentFile ? listed(context.recentFile) : !!recentFiles?.getSnapshot().length),
      run: context => context?.recentFile ? files.openRecent(context.recentFile) : pickRecent()
    }),
    commands.register('file.clearRecent', {
      when: () => !!recentFiles?.getSnapshot().length,
      run: async () => { if (api.clearRecentFiles) unwrap(await api.clearRecentFiles()) }
    }),
    // Asks main again first: the dialog lists what is there now.
    commands.register('file.recoverUnsaved', {
      when: () => !!recovery?.getSnapshot().entries.length,
      run: async () => {
        if (!recovery) return
        if (!(await recovery.refresh()).length) throw new Error('AutoRecover has nothing to recover.')
        recovery.openDialog()
      }
    }),
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

/** How long focus must settle before files are checked: switching windows quickly checks once. */
export const externalCheckDelayMs = 500
/**
 * Checks open files for changes made outside when the window gets focus (Visual Studio checks on activation), while
 * Tools › Options › Environment › Documents › Detect when file is changed outside the environment is on.
 */
export function watchExternalChanges(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, files: Pick<FileService, 'checkExternalChanges'>, enabled: () => boolean, timers: Timers = browserTimers): Disposable {
  let timer: unknown
  const focused = () => {
    if (timer !== undefined) timers.clearTimeout(timer)
    timer = timers.setTimeout(() => { timer = undefined; if (enabled()) void files.checkExternalChanges() }, externalCheckDelayMs)
  }
  target.addEventListener('focus', focused)
  return { dispose: () => { target.removeEventListener('focus', focused); if (timer !== undefined) timers.clearTimeout(timer) } }
}
