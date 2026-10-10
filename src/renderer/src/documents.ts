import type { DisplayQueryResult, SqlFile } from '../../shared/contracts'

export interface QueryDocument {
  readonly id: string
  readonly name: string
  readonly dirty: boolean
  readonly savedVersionId: number | null
  readonly connectionId?: string
  readonly database: string
  readonly file?: SqlFile
  /** Reconnect moved this query to a new session; its next execution says so before its own messages. */
  readonly sessionNotice?: boolean
}

// Presentation projection; results are owned by QueryService.
export interface QueryTab extends QueryDocument { result?: DisplayQueryResult; error?: string }

export function afterClose<T extends { id: string }>(tabs: readonly T[], activeId: string, closingId: string): { tabs: T[]; activeId: string } {
  const index = tabs.findIndex(tab => tab.id === closingId)
  const remaining = tabs.filter(tab => tab.id !== closingId)
  return { tabs: remaining, activeId: activeId === closingId ? remaining[Math.min(index, remaining.length - 1)]?.id ?? '' : activeId }
}
