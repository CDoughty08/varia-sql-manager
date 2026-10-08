import type { QueryResult, WorkbenchCommand } from '../../../shared/contracts'

export interface Disposable { dispose(): void }
export type CommandId = WorkbenchCommand | 'query.execute' | 'query.cancel'
export interface CommandContext { readonly tabId?: string }
export type WorkbenchEvent =
  | { type: 'documents.changed' }
  | { type: 'documents.activated'; tabId: string }
  | { type: 'documents.closed'; tabId: string }
  | { type: 'query.started'; tabId: string; queryId: string }
  | { type: 'query.finished'; tabId: string; queryId: string; result?: QueryResult; error?: string }
export interface ExternalStore<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
