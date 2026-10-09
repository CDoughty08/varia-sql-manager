import type { QueryResult } from '../../../shared/contracts'
import type { ThemePreferencePatch } from '../../../shared/theme/types'
import type { MenuTarget } from '../menus/targets'

export type { CommandId } from '../../../shared/commands/catalog'
export interface Disposable { dispose(): void }
/** Renderer-only command arguments; they never cross IPC. */
export interface CommandContext {
  /** The tab a tab-strip button acts on. */
  readonly tabId?: string
  /** The choice of a View › Theme item. */
  readonly theme?: ThemePreferencePatch
  /** What the context menu that runs the command was opened for. */
  readonly target?: MenuTarget
}
export type CommandArgs = CommandContext
export type WorkbenchEvent =
  | { type: 'documents.changed' }
  | { type: 'documents.activated'; tabId: string }
  | { type: 'documents.closed'; tabId: string }
  | { type: 'query.started'; tabId: string; queryId: string }
  | { type: 'query.finished'; tabId: string; queryId: string; summary?: QueryResult; error?: string }
  /** Object Explorer reloaded a server, a databases folder, or another node of the connection. */
  | { type: 'explorer.refreshed'; connectionId: string; scope: 'server' | 'databases' | 'other' }
export interface ExternalStore<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
