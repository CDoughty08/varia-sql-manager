import { z } from 'zod'
import { connectionEnvironmentInputSchema, connectionProfileInputSchema, type ConnectionLibrary, type ConnectionLibraryView, type ConnectionSaveView, type SecretStorageState } from '../shared/connections'
import { forgetSavedPassword, rememberCheckedPassword, takeVerifiedPassword } from './connection-requests'
import type { ConnectionStore } from './connection-store'
import type { SavedPasswordStore } from './saved-passwords'

export interface ConnectionLibraryDeps {
  connections: Pick<ConnectionStore, 'load' | 'save' | 'saveEntry' | 'remove' | 'setEnvironment'>
  savedPasswords: Pick<SavedPasswordStore, 'reconcile' | 'forget' | 'forgetCredentials' | 'state' | 'set' | 'storageAvailable'>
}

/**
 * The saved connection library as main hands it to the renderer: every change reconciles the remembered passwords, so an
 * entry removed, pruned, or moved by Save changes to another server or login loses its password at once.
 */
export function connectionLibrary(deps: ConnectionLibraryDeps) {
  // A library read since connections.json was quarantined is not the user's, so it prunes no remembered password.
  const current = async () => { const read = await deps.connections.load(); return read.trusted === false ? null : read.library }
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
    /**
     * Save. With `rememberPassword`, the typed password is remembered under the saved entry only when a check signed in
     * with it moments ago (the dialog checks it first); otherwise nothing is saved, so the settings and password agree.
     */
    async save(value: unknown): Promise<ConnectionSaveView> {
      const input = connectionProfileInputSchema.parse(value)
      if (input.forgetPassword) {
        const { forgetPassword: _forget, ...entry } = input
        const saved = await deps.connections.saveEntry(entry)
        // Unavailable storage forgets nothing, so it is reported rather than claimed, as Connect's Forget does.
        let passwordForgotten = false
        try { passwordForgotten = await forgetSavedPassword(deps.savedPasswords, saved.id, input.options) } catch { passwordForgotten = false }
        const { library, savedPasswords } = await view(saved.library)
        return { library, savedPasswords, passwordForgotten }
      }
      if (!input.rememberPassword) {
        const { library, savedPasswords } = await view(await deps.connections.save(input))
        return { library, savedPasswords }
      }
      if (!takeVerifiedPassword(deps.savedPasswords, input.options)) throw new Error('The password was not checked with the server. Save again to check it.')
      const { rememberPassword: _remember, ...entry } = input
      const saved = await deps.connections.saveEntry(entry)
      let passwordSaved = true, passwordReplaced = false
      try { passwordReplaced = await rememberCheckedPassword(deps.savedPasswords, saved.id, input.options) } catch { passwordSaved = false }
      const { library, savedPasswords } = await view(saved.library)
      return { library, savedPasswords, passwordSaved, passwordReplaced }
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
