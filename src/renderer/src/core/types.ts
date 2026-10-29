import type { QueryResult } from '../../../shared/contracts'
import type { ThemePreferencePatch } from '../../../shared/theme/types'
import type { MenuTarget } from '../menus/targets'

export type { CommandId } from '../../../shared/commands/catalog'
export interface Disposable { dispose(): void }
/** Renderer-only command arguments; they never cross IPC. */
export interface CommandContext {
  /** The tab a tab-strip button acts on. */
  readonly tabId?: string
  /** A File › Recent Files item: the opaque id main gave its path, which is all main accepts to open it. */
  readonly recentFile?: string
  /** The choice of a View › Theme item. */
  readonly theme?: ThemePreferencePatch
  /** What the context menu that runs the command was opened for. */
  readonly target?: MenuTarget
  /** The results grid cell a click or Enter opens (Open Value in New Tab), in the query tab `tabId`. */
  readonly cell?: { readonly resultIndex: number; readonly row: number; readonly column: number }
  /** What the widget a command opens is placed below: the header's search box, for the Search it opens. */
  readonly anchor?: Element
}
export type CommandArgs = CommandContext
export type WorkbenchEvent =
  | { type: 'documents.changed' }
  | { type: 'documents.activated'; tabId: string }
  | { type: 'documents.closed'; tabId: string }
  | { type: 'query.started'; tabId: string; queryId: string }
  | { type: 'query.finished'; tabId: string; queryId: string; summary?: QueryResult; error?: string }
  /** Execute ran on a query with no connection: the Connect dialog opens, and the query runs once connected. */
  | { type: 'query.connectRequested'; tabId: string }
  /** Activity Monitor ran with no server connected: the Connect dialog opens, and the monitor opens on the new connection. */
  | { type: 'activity.connectRequested' }
  /** The query's SQL session ended (closed, or found lost), and its open transaction with it. */
  | { type: 'session.ended'; tabId: string }
  /** Save Results As wrote its file; `text` is the sentence the tab's toolbar shows, such as "Saved 400 rows to w1.csv." */
  | { type: 'results.saved'; tabId: string; text: string }
  /** Object Explorer reloaded a server, a databases folder, or another node of the connection, because the user asked. */
  | { type: 'explorer.refreshed'; connectionId: string; scope: 'server' | 'databases' | 'other'; nodeId: number }
export interface ExternalStore<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
