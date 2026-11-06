import type { DocumentKind, LineEnding, SqlFile } from '../contracts'
import type { EditorGroupsLayout } from '../editor-groups'

/**
 * Hot exit (Tools › Options › Environment › Documents › Restore open queries on startup), as VS Code has it: a normal
 * close keeps the open text tabs in `<userData>/Session/session.json`, readable only by the user, instead of asking to
 * save them, and the next start reopens them. Text only: never results, connections or credentials.
 */
export const sessionLimits = {
  /** Tabs kept at once; tabs past it are asked about as without hot exit. */
  documents: 64,
  /** The session file's bytes. The page budgets its tabs to fit, with `slackBytes` to spare for main's own fields. */
  totalBytes: 64 * 1024 * 1024,
  slackBytes: 64 * 1024,
  nameChars: 512,
  pathChars: 4096,
  serverChars: 256,
  databaseChars: 128
} as const

/** A tab name the user chose (Rename Tab): trimmed, at most this many characters. */
export const tabNameChars = 128
/** The name a rename keeps: trimmed, line breaks and other control characters dropped, at most `tabNameChars`. */
export function cleanTabName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, tabNameChars).trim()
}

/**
 * One tab as the page asks main to keep it. `name` is what the tab shows; `baseName` is the name it would show without
 * the user's rename (absent when not renamed). `text` is absent only for a clean tab with a file, which reopens from its
 * file; main adds the path from its own registration of `fileId`. `server` and `database` are where the query was
 * connected, to show and to keep the database when it connects to that server again.
 */
export interface SessionDocumentWrite {
  readonly name: string
  readonly baseName?: string
  readonly kind: DocumentKind
  readonly eol: LineEnding
  readonly dirty: boolean
  readonly pinned?: boolean
  readonly fileId?: string
  readonly server?: string
  readonly database?: string
  readonly text?: string
}
/**
 * The tabs in group order (each group's tabs in strip order), the active one's index (-1 when none of them is active),
 * and the editor groups they are in, by index; without `groups`, one group holds them all.
 */
export interface SessionWrite { readonly documents: readonly SessionDocumentWrite[]; readonly activeIndex: number; readonly groups?: EditorGroupsLayout }

/** A one-use Reload Window snapshot and each pin's AutoRecover id, in the same order as the tabs. */
export interface ReloadPins { readonly session: SessionWrite; readonly recoveryIds: readonly (string | null)[] }

/** A kept tab reopened: its text (read again from its file when it was clean), and its file when that still opens. */
export interface RestoredDocument {
  readonly name: string
  readonly baseName?: string
  readonly kind: DocumentKind
  readonly eol: LineEnding
  readonly dirty: boolean
  readonly pinned?: boolean
  readonly recoveryId?: string
  readonly text: string
  readonly file?: SqlFile
  readonly server?: string
  readonly database?: string
}
/** What the next start reopens; `problems` are fixed sentences about tabs that could not reopen (their file is gone). */
export interface RestoredSession {
  readonly documents: readonly RestoredDocument[]
  readonly activeIndex: number
  /** The editor groups as they were, by the restored documents' places. */
  readonly groups?: EditorGroupsLayout
  readonly problems: readonly string[]
  /** The checkpoint is released once this page has reopened its tabs. */
  readonly restoreGeneration?: number
}
