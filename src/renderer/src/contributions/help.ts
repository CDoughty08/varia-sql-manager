import type { VariaApi } from '../../../shared/contracts'
import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

/** About and fixed project/support links, plus the confirmed Entra token-cache action. */
export function helpContribution({ commands, events }: Pick<Workbench, 'commands' | 'events'>, api: Pick<VariaApi, 'clearEntraTokenCache' | 'openProductLink'>): Disposable {
  const registrations = [
    commands.register('help.about', { run: () => { events.emit({ type: 'help.aboutRequested' }) } }),
    commands.register('help.openProject', { run: async () => { const result = await api.openProductLink('project'); if (!result.ok) throw new Error(result.error) } }),
    commands.register('help.reportIssue', { run: async () => { const result = await api.openProductLink('issues'); if (!result.ok) throw new Error(result.error) } }),
    commands.register('help.clearEntraTokenCache', {
      run: async () => {
        const result = await api.clearEntraTokenCache()
        if (!result.ok) throw new Error(result.error)
        if (result.value) commands.reportWarning('Entra ID token cache cleared.')
      }
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
