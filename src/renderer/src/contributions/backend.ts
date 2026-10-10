import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

/** Restart SQL Backend: main asks first when servers are connected, because every connection closes. */
export function backendContribution({ commands, backend }: Pick<Workbench, 'commands' | 'backend'>): Disposable {
  const registration = commands.register('backend.restart', { run: async () => { await backend.restart() } })
  return { dispose: () => registration.dispose() }
}
