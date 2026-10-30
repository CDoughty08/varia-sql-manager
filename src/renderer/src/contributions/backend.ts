import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

/**
 * Restart SQL Backend: main asks first when servers are connected, because every connection closes. A long run (a
 * restore, Create Catalog) would stop part way, so it is refused while one runs, with a message naming it.
 */
export function backendContribution({ commands, backend, longRuns }: Pick<Workbench, 'commands' | 'backend' | 'longRuns'>): Disposable {
  const registration = commands.register('backend.restart', {
    run: async () => {
      const refusal = longRuns.restartRefusal()
      if (refusal) { commands.reportError(refusal); return }
      await backend.restart()
    }
  })
  return { dispose: () => registration.dispose() }
}
