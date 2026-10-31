import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

/**
 * Restart SQL Backend: main asks first when servers are connected, because every connection closes, and names any long
 * run it would stop. A long run (a restore, Create Catalog) would stop part way, so while the backend answers, Restart is
 * refused with a message naming it (Stop it first). A backend that does not answer cannot stop the run either, and
 * Restart is then the way out, so it goes on to main's prompt.
 */
export function backendContribution({ commands, backend, longRuns }: Pick<Workbench, 'commands' | 'backend' | 'longRuns'>): Disposable {
  const registration = commands.register('backend.restart', {
    run: async () => {
      const refusal = backend.getSnapshot().state.status === 'ready' ? longRuns.restartRefusal() : undefined
      if (refusal) { commands.reportError(refusal); return }
      await backend.restart()
    }
  })
  return { dispose: () => registration.dispose() }
}
