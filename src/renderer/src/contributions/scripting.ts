import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

/**
 * Scripting's commands. Tools › Options… opens once main's stored options are in, so OK never writes a draft that
 * started from the defaults over options the user saved before.
 */
export function scriptingContribution({ commands, scriptingOptions }: Pick<Workbench, 'commands' | 'scriptingOptions'>): Disposable {
  const registrations = [
    commands.register('preferences.options', { run: async () => { await scriptingOptions.load(); scriptingOptions.openDialog() } })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
