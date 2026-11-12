import type { Disposable } from '../core/types'
import { windows } from '../core/windows'
import type { Workbench } from '../core/workbench'

/**
 * Tools › Options… opens once main's stored settings are in, so OK never saves a draft that started from the defaults
 * over settings the user saved before; a failed read opens nothing. Search Options (Ctrl+E, ⌘E) focuses and selects the
 * open dialog's search box.
 */
export function settingsContribution({ commands, settings }: Pick<Workbench, 'commands' | 'settings'>): Disposable {
  const registrations = [
    commands.register('preferences.options', { run: async args => { if (await settings.load()) settings.openDialog(args?.settingsPage) } }),
    commands.register('options.focusSearch', {
      run: () => {
        const search = windows.activeElement()?.closest('[data-options-dialog]')?.querySelector<HTMLInputElement>('[data-options-search]')
        search?.focus()
        search?.select()
      }
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
