import type { ApiResult, SqlFile, VariaApi } from '../../../shared/contracts'
import { displayText, refKey, type ExplorerTarget, type ObjectRef } from '../../../shared/explorer/refs.ts'
import { scriptLimits, scriptMenuState, scriptUnavailableHint, type ScriptDestination, type ScriptVerb } from '../../../shared/scripting/catalog.ts'
import type { ScriptingOptions } from '../../../shared/scripting/options.ts'
import type { ScriptResult } from '../../../shared/scripting/schema.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import type { LiveConnection } from '../services/connections'

/** A running request; `visible` once it has run long enough to show in the status bar. */
export interface ScriptingJob { readonly id: string; readonly label: string; readonly visible: boolean }
/** `id` changes with every notice, so the status bar announces a repeated one again. */
export interface ScriptingNotice { readonly id: number; readonly text: string; readonly title?: string; readonly kind: 'info' | 'warning' }
export interface ScriptingSnapshot { readonly jobs: readonly ScriptingJob[]; readonly notice?: ScriptingNotice }
export interface ScriptingServiceOptions {
  readonly api: Pick<VariaApi, 'scriptObjects' | 'cancelScripting' | 'writeClipboardText'>
  readonly documents: { newQuery(sql: string, name: string | undefined, connectionId: string, database: string, unsaved: boolean): unknown }
  readonly files: { saveCopy(name: string, content: string): Promise<SqlFile | undefined> }
  readonly connections: ExternalStore<readonly LiveConnection[]>
  /** The options every request carries: Tools › Options › Scripting. */
  readonly options: ExternalStore<{ readonly options: ScriptingOptions }>
  /** Puts the caret at the start of a new script's editor and focuses it (on the next frame in the app). */
  readonly focusEditor?: () => void
  readonly timers?: Timers
  /** When batched cancels go out: a microtask by default, so they never wait for a hidden window's frames. */
  readonly schedule?: (callback: () => void) => void
  readonly newId?: () => string
}

export const scriptingMessages = {
  notConnected: 'Connect to a SQL Server first.',
  cap: 'Four scripting operations are already running. Wait for one to finish or cancel it.',
  disconnected: 'The server was disconnected before scripting finished.',
  clipboard: 'Script copied to the clipboard.',
  cancelled: 'Scripting cancelled.'
} as const
const maxLabel = 400
/** How a status line or message names an object: `schema.name` or `name`, with hidden characters made visible. */
export function scriptObjectLabel(object: ObjectRef): string {
  const characters = [...displayText(object.schema !== undefined ? `${object.schema}.${object.name ?? ''}` : object.name ?? '')]
  return characters.length > maxLabel ? characters.slice(0, maxLabel - 1).join('') + '…' : characters.join('')
}
/** File… suggests `schema.name.sql`, `schema.table.name.sql` for an index, key or trigger, or `name.sql`; main makes it safe. */
export function scriptFileName(object: ObjectRef): string {
  const parts = object.schema !== undefined ? [object.schema] : object.parent ? [object.parent.schema, object.parent.name] : []
  return [...parts, object.name ?? 'Script'].join('.') + '.sql'
}

interface Job { readonly id: string; readonly key: string; readonly label: string; readonly connectionId: string; visible: boolean; cancelled: boolean; disconnected: boolean; timer?: unknown }
class FlagStore extends SnapshotStore<boolean> {
  set(value: boolean) { if (value !== this.getSnapshot()) this.publish(value) }
  clear() { this.clearListeners() }
}
const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }

/**
 * Script As in the renderer: one request per verb and destination for an Object Explorer object, at most four at once,
 * each shown in the status bar after 300 ms with a Cancel button, and its script delivered to a new query window, a
 * file, or the clipboard. A failure throws its message, which the command banner shows. Cancelling, or disconnecting
 * the server, drops the request's result; cancels go to main in one batch per tick.
 */
export class ScriptingService extends SnapshotStore<ScriptingSnapshot> implements Disposable {
  private readonly runningStore = new FlagStore(false)
  private readonly timers: Timers
  private readonly schedule: (callback: () => void) => void
  private readonly newId: () => string
  private jobs: Job[] = []
  private cancels: string[] = []
  private cancelScheduled = false
  private noticeTimer?: unknown
  private notices = 0
  private disposed = false
  private readonly unsubscribe: () => void

  constructor(private readonly options: ScriptingServiceOptions) {
    super({ jobs: [] })
    this.timers = options.timers ?? browserTimers
    this.schedule = options.schedule ?? (callback => queueMicrotask(callback))
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.unsubscribe = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (error) { onUnexpectedError(error) } })
  }

  /** Whether a request is running: `scriptingRunning`, which enables Cancel Scripting. */
  get running(): ExternalStore<boolean> { return this.runningStore }
  /** Whether `verb` can be scripted for `target` now: an object whose kind offers it enabled, on a live connection. */
  canRun(verb: ScriptVerb, target: ExplorerTarget | undefined): boolean {
    return !!target && target.ref.type === 'object' && scriptMenuState(scriptTarget(target)).verbs[verb] === 'enabled' && this.isLive(target.connectionId)
  }

  async run(verb: ScriptVerb, destination: ScriptDestination, target: ExplorerTarget | undefined): Promise<void> {
    if (this.disposed) return
    const object = target?.ref.type === 'object' ? target.ref.object : undefined
    if (!target || !object || scriptMenuState(scriptTarget(target)).verbs[verb] !== 'enabled') throw new Error(scriptUnavailableHint)
    const { connectionId } = target
    if (!this.isLive(connectionId)) throw new Error(scriptingMessages.notConnected)
    // A second click while the same script is on its way adds nothing.
    const key = JSON.stringify([refKey(connectionId, target.ref), verb, destination])
    if (this.jobs.some(job => job.key === key)) return
    if (this.jobs.length >= scriptLimits.rendererJobs) throw new Error(scriptingMessages.cap)
    const job: Job = { id: this.newId(), key, label: scriptObjectLabel(object), connectionId, visible: false, cancelled: false, disconnected: false }
    job.timer = this.timers.setTimeout(() => { if (this.jobs.includes(job)) { job.visible = true; this.changed() } }, scriptLimits.statusDelayMs)
    this.jobs = [...this.jobs, job]
    this.changed()
    let result: ApiResult<ScriptResult>
    try {
      result = await this.options.api.scriptObjects({ connectionId, requestId: job.id, targets: [object], verb, options: this.options.options.getSnapshot().options })
    } catch (error) {
      if (job.cancelled || this.disposed) return
      throw job.disconnected ? new Error(scriptingMessages.disconnected) : error
    } finally { this.remove(job) }
    if (job.cancelled || this.disposed) return
    // The backend cancels a script on its own only when its server disconnects (or the backend stops), and that answer
    // can arrive before the connection list drops the server.
    if (job.disconnected || !this.isLive(connectionId) || !result.ok && result.code === 'CANCELLED') throw new Error(scriptingMessages.disconnected)
    const value = unwrap(result)
    if (value.error) throw new Error(value.error.message)
    if (value.text === undefined) throw new Error(`SQL Server Management Objects produced no script for ${job.label}.`)
    await this.deliver(destination, value.text, value.database, connectionId, object)
    if (value.warnings.length) this.notify({ text: `Scripted ${job.label} with a warning: ${value.warnings[0]}`, title: value.warnings.join('\n'), kind: 'warning' }, scriptLimits.warningNoticeMs)
  }

  /** Cancels running requests by id: their results are dropped and main cancels them on the backend. */
  cancel(ids: readonly string[]): void {
    const wanted = new Set(ids), cancelled = this.jobs.filter(job => wanted.has(job.id))
    if (!cancelled.length) return
    for (const job of cancelled) { job.cancelled = true; this.remove(job, false); this.queueCancel(job.id) }
    this.notify({ text: scriptingMessages.cancelled, kind: 'info' }, scriptLimits.noticeMs)
  }
  cancelAll(): void { this.cancel(this.jobs.map(job => job.id)) }
  dismissNotice(): void {
    if (this.noticeTimer !== undefined) this.timers.clearTimeout(this.noticeTimer)
    this.noticeTimer = undefined
    if (this.getSnapshot().notice) this.publish({ jobs: this.getSnapshot().jobs })
  }

  dispose(): void {
    if (this.disposed) return
    for (const job of this.jobs) { job.cancelled = true; this.timers.clearTimeout(job.timer); this.queueCancel(job.id) }
    this.jobs = []
    this.flushCancels()
    this.disposed = true
    if (this.noticeTimer !== undefined) this.timers.clearTimeout(this.noticeTimer)
    this.unsubscribe()
    this.runningStore.set(false)
    this.runningStore.clear()
    this.clearListeners()
  }

  private async deliver(destination: ScriptDestination, text: string, database: string, connectionId: string, object: ObjectRef): Promise<void> {
    switch (destination) {
      case 'newQuery':
        // Not marked unsaved, as with Select Top 1000 Rows: the menu can always produce it again.
        this.options.documents.newQuery(text, undefined, connectionId, database, false)
        this.options.focusEditor?.()
        return
      case 'file': {
        const saved = await this.options.files.saveCopy(scriptFileName(object), text)
        if (saved) this.notify({ text: `Saved ${displayText(saved.name)}.`, kind: 'info' }, scriptLimits.noticeMs)
        return
      }
      case 'clipboard':
        unwrap(await this.options.api.writeClipboardText(text))
        this.notify({ text: scriptingMessages.clipboard, kind: 'info' }, scriptLimits.noticeMs)
    }
  }
  private isLive(connectionId: string): boolean {
    return this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }
  /** A disconnected or lost server's requests stop: their status goes, and the backend is told to stop them. */
  private connectionsChanged(): void {
    const gone = this.jobs.filter(job => !this.isLive(job.connectionId))
    if (!gone.length) return
    for (const job of gone) { job.disconnected = true; this.remove(job, false); this.queueCancel(job.id) }
    this.changed()
  }
  private remove(job: Job, publish = true): void {
    this.timers.clearTimeout(job.timer)
    if (!this.jobs.includes(job)) return
    this.jobs = this.jobs.filter(item => item !== job)
    if (publish) this.changed()
  }
  private changed(): void {
    if (this.disposed) return
    const { notice } = this.getSnapshot()
    this.publish({ jobs: this.jobs.map(job => ({ id: job.id, label: job.label, visible: job.visible })), ...(notice ? { notice } : {}) })
    this.runningStore.set(this.jobs.length > 0)
  }
  private notify(notice: Omit<ScriptingNotice, 'id'>, ms: number): void {
    if (this.disposed) return
    if (this.noticeTimer !== undefined) this.timers.clearTimeout(this.noticeTimer)
    const shown: ScriptingNotice = { ...notice, id: ++this.notices }
    this.noticeTimer = this.timers.setTimeout(() => { if (this.getSnapshot().notice === shown) this.dismissNotice() }, ms)
    this.publish({ jobs: this.jobs.map(job => ({ id: job.id, label: job.label, visible: job.visible })), notice: shown })
    this.runningStore.set(this.jobs.length > 0)
  }
  private queueCancel(id: string): void {
    this.cancels.push(id)
    if (this.cancelScheduled || this.disposed) return
    this.cancelScheduled = true
    this.schedule(() => this.flushCancels())
  }
  private flushCancels(): void {
    this.cancelScheduled = false
    const ids = this.cancels
    this.cancels = []
    for (let start = 0; start < ids.length; start += scriptLimits.cancelIds) {
      try {
        void this.options.api.cancelScripting(ids.slice(start, start + scriptLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError)
      } catch (error) { onUnexpectedError(error) }
    }
  }
}

/** What `scriptMenuState` needs of a node: its kind, subtype and, for an index, key or trigger, its parent's kind. */
export const scriptTarget = (target: ExplorerTarget) =>
  ({ kind: target.kind, subtype: target.subtype, parentKind: target.ref.type === 'object' ? target.ref.object.parent?.kind : undefined })
