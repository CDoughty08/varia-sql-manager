import type { VariaApi } from '../../../shared/contracts'
import type { UpdateState } from '../../../shared/updates'
import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { updateToast, type UpdateToastActions } from '../updates/toasts'

type UpdateCommandsApi = Pick<VariaApi, 'checkForUpdates' | 'downloadUpdate' | 'restartToUpdate' | 'openReleasesPage'>

/** The outcome a toast announces once: a version found or ready. */
const announcement = (state: UpdateState) => state.status === 'ready' || state.status === 'available' ? `${state.status}:${state.version}` : undefined

/**
 * Help's update commands and the toasts for what main's checks find. An automatic check speaks only when it finds a
 * release (once a version) or a download fails; one that fails quietly shows in the status bar alone, so a network that
 * blocks GitHub is not a toast every few hours. Check for Updates always answers, the latest version included.
 */
export function updatesContribution({ commands, notifications, updates }: Pick<Workbench, 'commands' | 'notifications' | 'updates'>, api: UpdateCommandsApi): Disposable {
  const announced = new Set<string>()
  const run = (id: 'help.checkForUpdates' | 'help.downloadUpdate' | 'help.restartToUpdate' | 'help.releaseNotes') => () => { void commands.execute(id, undefined, 'toolbar') }
  const actions: UpdateToastActions = { restart: run('help.restartToUpdate'), download: run('help.downloadUpdate'), releaseNotes: run('help.releaseNotes'), retry: run('help.checkForUpdates') }
  const show = (state: UpdateState) => { const toast = updateToast(state, actions); if (toast) notifications.notify(toast) }
  let previous = updates.getSnapshot()
  const unsubscribe = updates.subscribe(() => {
    const state = updates.getSnapshot(), before = previous
    previous = state
    if (state === before) return
    const id = announcement(state)
    if (id && !announced.has(id)) { announced.add(id); show(state) }
    else if (state.status === 'error' && before.status !== 'error' && (state.manual || state.during !== 'check')) show(state)
  })
  const registrations = [
    commands.register('help.checkForUpdates', {
      run: async () => {
        const seen = new Set(announced)
        const result = await api.checkForUpdates()
        if (!result.ok) throw new Error(result.error)
        const state = result.value
        if (!state.enabled) { commands.reportWarning('This copy of Varia SQL Manager is a development build, which does not check for updates.'); return }
        // A release announced before this check gets its toast again; one announced by this check already has it.
        const id = announcement(state)
        if (state.status === 'upToDate' || (id && seen.has(id))) show(state)
      }
    }),
    commands.register('help.downloadUpdate', {
      run: async () => {
        const result = await api.downloadUpdate()
        if (!result.ok) throw new Error(result.error)
      }
    }),
    commands.register('help.restartToUpdate', {
      run: async () => {
        const result = await api.restartToUpdate()
        if (!result.ok) throw new Error(result.error)
        if (!result.value) commands.reportWarning('No verified update is ready to install. Check for updates again.')
      }
    }),
    commands.register('help.releaseNotes', {
      run: async () => {
        const result = await api.openReleasesPage()
        if (!result.ok) throw new Error(result.error)
      }
    })
  ]
  return { dispose: () => { unsubscribe(); registrations.forEach(registration => registration.dispose()) } }
}
