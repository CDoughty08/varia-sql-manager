import type { DocumentKind, LineEnding, SqlFile } from '../contracts'

/**
 * AutoRecover (Tools › Options › Environment › AutoRecover). Main keeps one record a query in `<userData>/AutoRecover/`,
 * readable only by the user; the renderer names records by uuid and never sees a path it did not already show.
 */
export const recoveryLimits = {
  /** Records kept at once, and their bytes on disk in all. */
  records: 64,
  totalBytes: 256 * 1024 * 1024,
  /** One record, read or written: a 5,000,000-character query is at most 30 MB as JSON. */
  recordBytes: 32 * 1024 * 1024,
  nameChars: 512,
  pathChars: 4096,
  serverChars: 256,
  databaseChars: 128,
  /** Ids in one discard. */
  discardIds: 256
} as const
/** Why a write was refused at the caps; a fixed sentence, as the banner shows it. */
export const recoveryCapMessage = 'AutoRecover keeps at most 64 queries (256 MB).'

/** What the renderer asks main to keep for one query: main adds the file's path from its own registration. */
export interface RecoveryWrite {
  readonly id: string
  readonly name: string
  readonly kind: DocumentKind
  readonly fileId?: string
  readonly eol: LineEnding
  readonly server?: string
  readonly database?: string
  readonly text: string
}
/** A kept query as the Recover dialog lists it: no text. `savedAt` is an ISO time; `path` is the file it was saved to. */
export interface RecoveryEntry {
  readonly id: string
  readonly name: string
  readonly kind: DocumentKind
  readonly path?: string
  readonly savedAt: string
  readonly characters: number
  readonly server?: string
  readonly database?: string
}
/** A kept query taken to open again; `file` is its original file, registered again when it still exists. */
export interface RecoveredDocument {
  readonly text: string
  readonly name: string
  readonly kind: DocumentKind
  readonly eol: LineEnding
  readonly file?: SqlFile
}

/** The crash, hang and reload prompts' details: AutoRecover's wording once it has kept this page's queries. */
export interface LossDetails { readonly stopped: string; readonly unresponsive: string; readonly reload: string }
export function lossDetails(autoRecover: { readonly enabled: boolean; readonly minutes: number; readonly saved: boolean }): LossDetails {
  if (!autoRecover.enabled || !autoRecover.saved) {
    return {
      stopped: 'Unsaved queries were lost. Connections were closed and uncommitted transactions were rolled back.',
      unresponsive: 'The workbench is not responding. Unsaved queries will be lost.',
      reload: 'Unsaved queries will be lost. Connections are closed and uncommitted transactions are rolled back.'
    }
  }
  const minutes = autoRecover.minutes === 1 ? 'minute' : `${autoRecover.minutes} minutes`
  return {
    stopped: `Queries saved by AutoRecover can be recovered after reloading; changes from the last ${minutes} may be lost. Connections were closed and uncommitted transactions were rolled back.`,
    unresponsive: 'The workbench is not responding. Changes since the last AutoRecover save will be lost; the rest is offered when Varia SQL Manager starts again.',
    reload: 'Changes since the last AutoRecover save will be lost. Connections are closed and uncommitted transactions are rolled back.'
  }
}
