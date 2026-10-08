import type { QueryResult } from '../../../shared/contracts'
import type { ThemePreferencePatch } from '../../../shared/theme/types'

export type { CommandId } from '../../../shared/commands/catalog'
export interface Disposable { dispose(): void }
/** Renderer-only command arguments; they never cross IPC. */
export interface CommandContext {
  /** The tab a tab-strip button acts on. */
  readonly tabId?: string
  /** The choice of a View › Theme item. */
  readonly theme?: ThemePreferencePatch
}
export type CommandArgs = CommandContext
export type WorkbenchEvent =
  | { type: 'documents.changed' }
  | { type: 'documents.activated'; tabId: string }
  | { type: 'documents.closed'; tabId: string }
  | { type: 'query.started'; tabId: string; queryId: string }
  | { type: 'query.finished'; tabId: string; queryId: string; result?: QueryResult; error?: string }
export interface ExternalStore<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
