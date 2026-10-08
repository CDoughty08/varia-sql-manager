import { isCommandId, type CommandId } from '../../../shared/commands/catalog'

export type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>
export const historyKey = 'varia.commandHistory.v1'
export const historyLimits = { entries: 50, bytes: 4096 } as const

function browserStorage(): HistoryStorage | undefined {
  // Reading localStorage throws where storage is blocked; the history then lives in memory only.
  try { return globalThis.localStorage } catch { return undefined }
}

/**
 * Commands recently run from the palette, most recent first. A cache in localStorage with no IPC surface: anything
 * unreadable, oversized, or unknown is dropped on read, and a failed write keeps the history in memory.
 */
export class CommandHistory {
  private entries: CommandId[]
  constructor(private readonly storage: HistoryStorage | undefined = browserStorage()) { this.entries = this.read() }
  get ids(): readonly CommandId[] { return this.entries }
  record(id: CommandId): void {
    if (!isCommandId(id)) return
    this.entries = [id, ...this.entries.filter(entry => entry !== id)].slice(0, historyLimits.entries)
    // A full or blocked storage keeps the history for this session only.
    try { this.storage?.setItem(historyKey, JSON.stringify(this.entries)) } catch { /* in memory only */ }
  }
  private read(): CommandId[] {
    let raw: string | null | undefined
    try { raw = this.storage?.getItem(historyKey) } catch { return [] }
    if (typeof raw !== 'string' || raw.length > historyLimits.bytes) return []
    let value: unknown
    try { value = JSON.parse(raw) } catch { return [] }
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter(isCommandId))].slice(0, historyLimits.entries)
  }
}
