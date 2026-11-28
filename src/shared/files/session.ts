import type { DocumentKind, LineEnding, SqlFile } from '../contracts'
import type { EditorGroupsLayout } from '../editor-groups'
import type { ConnectionWorkspace } from '../connection-targets'
import type { ProviderId } from '../providers'
import type { RestoredJob } from '../bigquery/jobs'
import type { KeptAgentKind } from '../agent/kept'

/** What a kept tab is: a text document's kind, or a SQL Server Agent document whose `text` is its kept state (shared/agent/kept.ts). */
export type KeptDocumentKind = DocumentKind | KeptAgentKind

/**
 * Hot exit (Tools › Options › Environment › Documents › Restore open queries on startup), as VS Code has it: a normal
 * close keeps the open text tabs in `<userData>/WorkbenchSession/session.json`, readable only by the user, instead of asking to
 * save them, and the next start reopens them. Only text and nonsecret connection targets: never results or live handles.
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
  databaseChars: 128,
  /** A BigQuery tab's dataset (its `database`): BigQuery's 1,024 characters, on BigQuery tabs only. */
  datasetChars: 1024,
  /** Targets kept on a multi-server or cross-engine query tab. */
  multiTargets: 32
} as const

/** A tab name the user chose (Rename Tab): trimmed, at most this many characters. */
export const tabNameChars = 128
/** The name a rename keeps: trimmed, line breaks and other control characters dropped, at most `tabNameChars`. */
export function cleanTabName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, tabNameChars).trim()
}

/** One target of a multi-server or cross-engine query tab kept for Hot Exit (never `connectionId` or `jobKey`). */
export interface MultiTargetSessionEntry {
  readonly targetId?: string
  readonly database: string
  readonly enabled: boolean
  readonly provider: ProviderId
  readonly attachWanted?: boolean
  readonly lastServer?: string
}

/**
 * One tab as the page asks main to keep it. `name` is what the tab shows; `baseName` is the name it would show without
 * the user's rename (absent when not renamed). `text` is absent only for a clean tab with a file, which reopens from its
 * file; main adds the path from its own registration of `fileId`. `server` and `database` are where the query was
 * connected, as a legacy display hint. `targetId` is the exact durable association; `attachWanted` remembers whether
 * reconnecting that target should attach the query. Every associated query keeps its own database. `provider` is the
 * tab's engine (absent: SQL Server, as in every 0.9.0 record); a BigQuery tab's `database` is its dataset, and `jobKey` the
 * key its jobs are recorded under (docs/bigquery.md, Re-attaching to jobs), so the restored tab re-attaches to them. A SQL Server Agent
 * document (AG-6g) keeps its state as `text`, with its connection target, and never a file, provider or job key.
 */
export interface SessionDocumentWrite {
  readonly name: string
  readonly baseName?: string
  readonly kind: KeptDocumentKind
  readonly eol: LineEnding
  readonly dirty: boolean
  readonly pinned?: boolean
  readonly fileId?: string
  readonly server?: string
  readonly database?: string
  readonly targetId?: string
  readonly attachWanted?: boolean
  readonly provider?: ProviderId
  readonly jobKey?: string
  readonly text?: string
  readonly multiMode?: 'same' | 'cross'
  readonly multiTargets?: readonly MultiTargetSessionEntry[]
  readonly crossView?: 'split' | 'file'
}
/**
 * The tabs in group order (each group's tabs in strip order), the active one's index (-1 when none of them is active),
 * and the editor groups they are in, by index; without `groups`, one group holds them all.
 */
export interface SessionWrite {
  readonly documents: readonly SessionDocumentWrite[]
  readonly activeIndex: number
  readonly groups?: EditorGroupsLayout
  readonly workspace?: ConnectionWorkspace
}

/** A one-use Reload Window snapshot and each eligible tab's AutoRecover id, in the same order as the tabs. */
export interface ReloadPins { readonly session: SessionWrite; readonly recoveryIds: readonly (string | null)[] }

/** A kept tab reopened: its text (read again from its file when it was clean), and its file when that still opens. */
export interface RestoredDocument {
  readonly name: string
  readonly baseName?: string
  readonly kind: KeptDocumentKind
  readonly eol: LineEnding
  readonly dirty: boolean
  readonly pinned?: boolean
  readonly recoveryId?: string
  readonly text: string
  readonly file?: SqlFile
  readonly server?: string
  readonly database?: string
  readonly targetId?: string
  readonly attachWanted?: boolean
  /** The tab's engine as kept (absent: SQL Server); a query reopens in its language without its connection. */
  readonly provider?: ProviderId
  /** A BigQuery tab's job key, and the jobs main still has records of under it, to re-attach to once it connects. */
  readonly jobKey?: string
  readonly jobs?: readonly RestoredJob[]
  readonly multiMode?: 'same' | 'cross'
  readonly multiTargets?: readonly MultiTargetSessionEntry[]
  readonly crossView?: 'split' | 'file'
}
/** What the next start reopens; `problems` are fixed sentences about tabs that could not reopen (their file is gone). */
export interface RestoredSession {
  readonly documents: readonly RestoredDocument[]
  readonly activeIndex: number
  /** The editor groups as they were, by the restored documents' places. */
  readonly groups?: EditorGroupsLayout
  readonly workspace?: ConnectionWorkspace
  readonly problems: readonly string[]
  /** The checkpoint is released once this page has reopened its tabs. */
  readonly restoreGeneration?: number
}
