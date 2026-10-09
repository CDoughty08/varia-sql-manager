import type { DisplayQueryResult } from '../../../shared/contracts'

export type { CommandId } from '../../../shared/commands/catalog'
export interface Disposable { dispose(): void }
export interface CommandContext { readonly tabId?: string }
/** The only command argument: the tab a tab-strip button acts on. Keys, menus, and the palette never pass arguments. */
export type CommandArgs = CommandContext
export type WorkbenchEvent =
  | { type: 'documents.changed' }
  | { type: 'documents.activated'; tabId: string }
  | { type: 'documents.closed'; tabId: string }
  | { type: 'query.started'; tabId: string; queryId: string }
  | { type: 'query.finished'; tabId: string; queryId: string; result?: DisplayQueryResult; error?: string }
export interface ExternalStore<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
