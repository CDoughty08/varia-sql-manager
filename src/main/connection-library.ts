import { z } from 'zod'
import { connectionEnvironmentInputSchema, connectionProfileInputSchema, type ConnectionLibrary, type ConnectionLibraryView, type SecretStorageState } from '../shared/connections'
import type { ConnectionStore } from './connection-store'
import type { SavedPasswordStore } from './saved-passwords'

export interface ConnectionLibraryDeps {
  connections: Pick<ConnectionStore, 'load' | 'save' | 'remove' | 'setEnvironment'>
  savedPasswords: Pick<SavedPasswordStore, 'reconcile' | 'forget' | 'state'>
}

/**
 * The saved connection library as main hands it to the renderer: every change reconciles the remembered passwords, so an
 * entry removed, pruned, or moved by Save changes to another server or login loses its password at once.
 */
export function connectionLibrary(deps: ConnectionLibraryDeps) {
  const current = async () => (await deps.connections.load()).library
  // The renderer learns only which entries have a remembered password. A file that cannot be read hides them; it is not
  // a reason to fail the library.
  const view = async (library: ConnectionLibrary): Promise<ConnectionLibraryView & { passwordWarning?: string }> => {
    const saved = await deps.savedPasswords.reconcile(current).catch(() => ({ ids: [] as string[], warning: 'Saved passwords could not be read.' }))
    return { library, savedPasswords: saved.ids, ...(saved.warning ? { passwordWarning: saved.warning } : {}) }
  }
  return {
    async load(): Promise<ConnectionLibraryView & { warning?: string; passwordStorage: SecretStorageState; passwordWarning?: string }> {
      const { library, warning } = await deps.connections.load()
      return { ...await view(library), passwordStorage: await deps.savedPasswords.state(), ...(warning ? { warning } : {}) }
    },
    async save(value: unknown): Promise<ConnectionLibraryView> {
      const { library, savedPasswords } = await view(await deps.connections.save(connectionProfileInputSchema.parse(value)))
      return { library, savedPasswords }
    },
    async setEnvironment(value: unknown): Promise<ConnectionLibraryView> {
      const { library, savedPasswords } = await view(await deps.connections.setEnvironment(connectionEnvironmentInputSchema.parse(value)))
      return { library, savedPasswords }
    },
    // The password goes first, so a failure leaves the entry listed with it rather than an orphaned password.
    async remove(value: unknown): Promise<ConnectionLibraryView> {
      const id = z.uuid().parse(value)
      await deps.savedPasswords.forget(id)
      const { library, savedPasswords } = await view(await deps.connections.remove(id))
      return { library, savedPasswords }
    }
  }
}
