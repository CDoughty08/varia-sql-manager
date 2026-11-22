// The proxy and credential documents' secret slot (AG-8b): what their password and confirm fields hold, per document, kept here and nowhere
// else. A snapshot learns only SecretFacts (empty or set, confirmed, well formed, within its bound); the value leaves only in the
// actions.execute request that sends it, and the slot is emptied after a save and when the document closes. The fields are uncontrolled
// PasswordFields: React never holds a value either. ObjectDialogService has its own slot for its modal dialogs; this one is per document.
import { agentLimits } from '../../../shared/agent/catalog.ts'
import { emptySecretFacts, type SecretFacts } from '../../../shared/actions/agent-proxy.ts'
import { wellFormed } from '../../../shared/ssis/schema.ts'

export type SecretSlotField = 'secret' | 'confirm'

export class SecretSlot {
  private readonly values = new Map<string, Partial<Record<SecretSlotField, string>>>()

  /** A field changed: its value is kept, and the facts it leaves are returned. */
  set(id: string, field: SecretSlotField, value: string): SecretFacts {
    const entry = { ...this.values.get(id) }
    if (value) entry[field] = value
    else delete entry[field]
    if (entry.secret === undefined && entry.confirm === undefined) this.values.delete(id)
    else this.values.set(id, entry)
    return this.facts(id)
  }
  facts(id: string): SecretFacts {
    const entry = this.values.get(id)
    const secret = entry?.secret ?? ''
    if (!entry) return emptySecretFacts
    return { secret: secret ? 'set' : 'empty', matches: secret === (entry.confirm ?? ''), wellFormed: wellFormed(secret), tooLong: secret.length > agentLimits.credentialSecretChars }
  }
  /** The secret, for the one request that sends it. */
  value(id: string): string { return this.values.get(id)?.secret ?? '' }
  clear(id: string): void { this.values.delete(id) }
  clearAll(): void { this.values.clear() }
  /** For tests: whether any document's fields hold a value. */
  get holdsSecrets(): boolean { return this.values.size > 0 }
}
