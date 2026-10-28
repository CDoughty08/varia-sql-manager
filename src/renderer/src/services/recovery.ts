import type { ApiResult, RecoveryEntry, SqlFile, VariaApi } from '../../../shared/contracts'
import { recoveryLimits } from '../../../shared/files/recovery'
import type { SettingsValues } from '../../../shared/settings/catalog'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import { isCustomKind } from '../documents'
import type { DocumentService } from './documents'
import type { FileService } from './files'

type RecoveryApi = Pick<VariaApi, 'writeRecovery' | 'discardRecovery' | 'listRecovery' | 'takeRecovery'>
/** What earlier runs and pages left to recover (`hasRecoveryFiles`), and whether the Recover dialog shows them. */
export interface RecoverySnapshot { readonly entries: readonly RecoveryEntry[]; readonly open: boolean }
export interface RecoveryServiceOptions {
  readonly api: RecoveryApi
  readonly documents: DocumentService
  readonly files: Pick<FileService, 'later' | 'release' | 'exiting'>
  readonly settings: ExternalStore<{ readonly values: SettingsValues }>
  /** The server a connection is to, as the Recover dialog names it. */
  readonly server?: (connectionId: string) => string | undefined
  /** A banner warning; AutoRecover reports its first failure in a session and keeps going. */
  readonly warn: (message: string) => void
  readonly timers?: Timers
  readonly newId?: () => string
}
/** When a copy was saved, as the Recover dialog says it: "just now", "5 minutes ago", "yesterday", "3 days ago". */
export function savedAgo(savedAt: string, now: number = Date.now()): string {
  const time = Date.parse(savedAt)
  if (Number.isNaN(time)) return ''
  const seconds = Math.round((time - now) / 1000), format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (seconds > -60) return 'just now'
  if (seconds > -3600) return format.format(Math.round(seconds / 60), 'minute')
  if (seconds > -86_400) return format.format(Math.round(seconds / 3600), 'hour')
  return format.format(Math.round(seconds / 86_400), 'day')
}
/** A query's record, and the model version it holds (none until a write succeeded). */
interface Kept { readonly id: string; version?: number }
const minuteMs = 60_000
const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const failed = (error: unknown) => error instanceof Error ? error.message : 'The operation failed.'

/**
 * AutoRecover, as SSMS has it (Tools › Options › Environment › AutoRecover): every n minutes it gives main a copy of
 * each query whose text changed since its last copy and that has unsaved changes, and deletes the copy as soon as the
 * query is saved, reverted, reloaded or closed. Main keeps the copies, and offers those an earlier run or page left in
 * the Recover dialog. Calls to main run one at a time, so a copy is never deleted before the write that made it.
 */
export class RecoveryService extends SnapshotStore<RecoverySnapshot> implements Disposable {
  /** Each tab's record, by tab id. */
  private kept = new Map<string, Kept>()
  private queue: Promise<void> = Promise.resolve()
  private timer: unknown
  /** The interval the timer runs at, in minutes; 0 while AutoRecover is off. */
  private interval = -1
  private warned = false
  private disposed = false
  private readonly unsubscribe: (() => void)[]
  constructor(private readonly options: RecoveryServiceOptions) {
    super({ entries: [], open: false })
    this.unsubscribe = [options.documents.subscribe(() => this.documentsChanged()), options.settings.subscribe(() => this.reschedule())]
    this.reschedule()
  }
  private get timers(): Timers { return this.options.timers ?? browserTimers }
  private values(): SettingsValues { return this.options.settings.getSnapshot().values }
  private serial(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task)
    this.queue = next.catch(() => {})
    return next
  }
  private warnOnce(message: string): void {
    if (this.warned || this.disposed) return
    this.warned = true
    this.options.warn(message)
  }

  /** Lists what earlier runs and pages left, and opens the Recover dialog when there is any: the workbench's start. */
  async start(): Promise<void> {
    if ((await this.refresh()).length && !this.disposed) this.openDialog()
  }
  /** Asks main again what there is to recover. */
  async refresh(): Promise<readonly RecoveryEntry[]> {
    let entries: RecoveryEntry[]
    try { entries = unwrap(await this.options.api.listRecovery()) } catch (error) {
      this.warnOnce(`AutoRecover could not list the queries it kept: ${failed(error)}`)
      return this.getSnapshot().entries
    }
    if (!this.disposed) this.publish({ ...this.getSnapshot(), entries })
    return entries
  }
  openDialog(): void { if (!this.disposed) this.publish({ ...this.getSnapshot(), open: true }) }
  closeDialog(): void { if (!this.disposed && this.getSnapshot().open) this.publish({ ...this.getSnapshot(), open: false }) }

  /**
   * Gives main a copy of every query with unsaved changes whose text changed since its last copy (the timer's work, and
   * the smoke tests' `__variaRecovery.flush()`). A failure is reported once a session; the rest are still written.
   */
  flush(): Promise<void> {
    return this.serial(async () => {
      if (!this.values()['environment.autoRecover.enabled']) return
      for (const { id } of this.options.documents.getSnapshot().documents) {
        // A confirmed exit has handled every query; main deletes this page's copies as the window closes.
        if (this.disposed || this.options.files.exiting) return
        await this.keep(id)
      }
    })
  }
  private async keep(tabId: string): Promise<void> {
    const { documents } = this.options, document = documents.get(tabId), model = documents.getModel(tabId)
    // A table designer has no model: AutoRecover keeps text only.
    if (!document?.dirty || !model || (document.kind !== undefined && isCustomKind(document.kind))) return
    const version = model.getAlternativeVersionId(), current = this.kept.get(tabId)
    if (current?.version === version) return
    // Kept before the write, so a save or close meanwhile deletes the copy after it is written.
    const kept: Kept = current ?? { id: this.options.newId?.() ?? crypto.randomUUID() }
    this.kept.set(tabId, kept)
    const server = document.connectionId ? this.options.server?.(document.connectionId) : undefined
    try {
      unwrap(await this.options.api.writeRecovery({
        id: kept.id, name: document.name.slice(0, recoveryLimits.nameChars), kind: document.kind ?? 'sql', ...document.file ? { fileId: document.file.id } : {},
        eol: model.getEOL() === '\r\n' ? 'crlf' : 'lf', ...server ? { server: server.slice(0, recoveryLimits.serverChars) } : {},
        ...server && document.database ? { database: document.database.slice(0, recoveryLimits.databaseChars) } : {}, text: model.getValue()
      }))
      kept.version = version
    } catch (error) { this.warnOnce(`AutoRecover could not save ${document.name}: ${failed(error)}`) }
  }
  /** A query that has no unsaved changes any more, or closed, needs no copy. */
  private documentsChanged(): void {
    if (this.disposed) return
    const ids: string[] = []
    for (const [tabId, kept] of this.kept) {
      if (this.options.documents.get(tabId)?.dirty) continue
      this.kept.delete(tabId)
      ids.push(kept.id)
    }
    if (ids.length) void this.remove(ids)
  }
  private remove(ids: readonly string[]): Promise<void> {
    return this.serial(async () => {
      try {
        for (let at = 0; at < ids.length; at += recoveryLimits.discardIds) unwrap(await this.options.api.discardRecovery(ids.slice(at, at + recoveryLimits.discardIds)))
      } catch (error) { this.warnOnce(`AutoRecover could not delete a copy it no longer needs: ${failed(error)}`) }
    })
  }
  /** Follows Options: a new interval starts from now; turning AutoRecover off stops it and deletes this page's copies. */
  private reschedule(): void {
    const values = this.values(), interval = values['environment.autoRecover.enabled'] ? values['environment.autoRecover.intervalMinutes'] : 0
    if (this.disposed || interval === this.interval) return
    this.interval = interval
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    this.timer = undefined
    if (interval) { this.arm(); return }
    const ids = [...this.kept.values()].map(kept => kept.id)
    this.kept.clear()
    if (ids.length) void this.remove(ids)
  }
  private arm(): void {
    const interval = this.interval
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      // The next save is counted from the end of this one, at whatever interval Options then says.
      void this.flush().finally(() => { if (!this.disposed && this.timer === undefined && this.interval === interval && interval) this.arm() })
    }, interval * minuteMs)
  }

  /**
   * Recover Selected: opens each kept query as an unsaved query with no connection, its line ending, and its original
   * file when that still exists, as a file task. The copy stays until the query is saved or closed. A copy that cannot be
   * taken is reported; the others still open.
   */
  async recover(ids: readonly string[]): Promise<void> {
    await this.options.files.later(async () => {
      const problems: string[] = [], files: SqlFile[] = []
      try {
        for (const id of ids) {
          if (this.disposed) return
          // Already open (a second Recover Selected that waited for the first): one record, one tab.
          if ([...this.kept.values()].some(kept => kept.id === id)) continue
          let taken
          try { taken = unwrap(await this.options.api.takeRecovery(id)) } catch (error) { problems.push(failed(error)); continue }
          if (taken.file) files.push(taken.file)
          const document = this.options.documents.restore(taken.name, taken.text, taken.kind, taken.eol, taken.file)
          this.kept.set(document.id, { id, version: this.options.documents.getModel(document.id)?.getAlternativeVersionId() })
        }
      } finally { await this.options.files.release(files) }
      if (problems.length) throw new Error(problems.join(' '))
    })
    await this.refresh()
  }
  /** Discard Selected: deletes the copies for good. */
  async discard(ids: readonly string[]): Promise<void> {
    await this.serial(async () => {
      for (let at = 0; at < ids.length; at += recoveryLimits.discardIds) unwrap(await this.options.api.discardRecovery(ids.slice(at, at + recoveryLimits.discardIds)))
    })
    await this.refresh()
  }

  dispose(): void {
    // First, before the documents go: a page that unloads (a reload, a crash's reload) leaves its copies to be offered.
    this.disposed = true
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    this.timer = undefined
    this.unsubscribe.forEach(unsubscribe => unsubscribe())
    this.clearListeners()
  }
}
