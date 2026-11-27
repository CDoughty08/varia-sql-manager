import type { SecretStorageState } from '../../../shared/connections'

const reasons: Record<'no-keyring' | 'unknown-backend', string> = {
  'no-keyring': 'it needs a system keyring (GNOME Keyring or KWallet) to hold the index’s key, and none was found',
  'unknown-backend': 'the operating system has no key store to hold the index’s key'
}

/**
 * What Options › Object Explorer › Commands says beside the Search Objects settings where the system has no key store
 * (docs/object-search.md, Saved index): that nothing is being saved and how to opt in, or, once opted in, that the index
 * is saved unencrypted. Empty while a key store is available, while it is not known yet, or while saving is off.
 * `save` and `unencrypted` are the page's values as they stand, saved or not.
 */
export function indexStorageNote(storage: SecretStorageState | undefined, save: boolean, unencrypted: boolean): string {
  if (!storage || storage.available || !save) return ''
  // A key store that is there but not reachable yet (locked): nothing is saved, encrypted or not, until it answers.
  if ((storage.reason ?? 'unavailable') === 'unavailable') return 'Search Objects indexes are not being saved yet: the operating system’s key store, which holds the index’s key, is not reachable (it may be locked). They are saved, encrypted, once it answers.'
  const why = reasons[storage.reason as 'no-keyring' | 'unknown-backend']
  return unencrypted
    ? `Search Objects indexes are saved unencrypted on this system, as chosen below: ${why}. Any program or person that can read your files can read the saved object names and definitions.`
    : `Search Objects indexes are not being saved on this system: ${why}. To save them without encryption, turn on “Save index unencrypted when there is no key store” below.`
}
