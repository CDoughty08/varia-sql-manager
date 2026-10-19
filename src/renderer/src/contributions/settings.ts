import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

/**
 * Tools › Options… opens once main's stored settings are in, so OK never saves a draft that started from the defaults
 * over settings the user saved before; a failed read opens nothing.
 */
export function settingsContribution({ commands, settings }: Pick<Workbench, 'commands' | 'settings'>): Disposable {
  const registrations = [
    commands.register('preferences.options', { run: async () => { if (await settings.load()) settings.openDialog() } })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
