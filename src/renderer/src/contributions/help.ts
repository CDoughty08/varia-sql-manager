import type { VariaApi } from '../../../shared/contracts'
import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

/** Help › Clear Entra ID Token Cache: main asks first, then the backend forgets every Microsoft Entra token. A failure
 *  shows in the command banner as any command's does; success is a notice there. */
export function helpContribution({ commands }: Pick<Workbench, 'commands'>, api: Pick<VariaApi, 'clearEntraTokenCache'>): Disposable {
  const registration = commands.register('help.clearEntraTokenCache', {
    run: async () => {
      const result = await api.clearEntraTokenCache()
      if (!result.ok) throw new Error(result.error)
      if (result.value) commands.reportWarning('Entra ID token cache cleared.')
    }
  })
  return { dispose: () => registration.dispose() }
}
