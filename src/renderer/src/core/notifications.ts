import type { ErrorReport } from '../kit/format'
import { onUnexpectedError } from './errors'
import { SnapshotStore } from './store'
import { browserTimers, type Timers } from './timers'
import type { Disposable } from './types'

export type ToastSeverity = 'info' | 'warning' | 'error'
export interface ToastAction { readonly label: string; readonly run: () => void }
export interface ToastInput {
  readonly severity: ToastSeverity
  /** One or two sentences, shown as they are; cut at `notificationLimits.message`. */
  readonly message: string
  /** At most `notificationLimits.actions` buttons, such as "Show results". Running one dismisses the toast. */
  readonly actions?: readonly ToastAction[]
  /** A failure's code and details: an error toast then offers Copy details (`errorDetailsText`). */
  readonly report?: Omit<ErrorReport, 'message'>
  /** A toast with the same key replaces the one shown, so a repeated outcome never stacks up. */
  readonly key?: string
}
export interface Toast extends ToastInput { readonly id: number }
export interface NotificationSnapshot {
  /** The toasts on screen, oldest first; at most `notificationLimits.visible`. */
  readonly visible: readonly Toast[]
  /** How many more wait for a place. */
  readonly queued: number
  /** The newest toast's sentence for the live regions: errors are read at once, the rest politely. */
  readonly announcement?: { readonly id: number; readonly text: string; readonly assertive: boolean }
}

/**
 * Toasts are bounded: three on screen and twenty waiting (the oldest waiting one goes first), each sentence at most 500
 * characters. A toast that is only information leaves by itself after 8 s, paused while the pointer or focus is on it;
 * errors and toasts with actions stay until dismissed, so nobody has to race a timer to act on one.
 */
export const notificationLimits = { visible: 3, queued: 20, message: 500, actions: 2, autoHideMs: 8000 } as const

const bounded = (text: string) => text.length > notificationLimits.message ? text.slice(0, notificationLimits.message - 1) + '…' : text
/** Whether a toast leaves by itself. */
export const autoHides = (toast: ToastInput) => toast.severity !== 'error' && !toast.actions?.length

/**
 * Toasts for work that finishes out of sight: a save whose results are not shown, and later live and SSIS outcomes. Never
 * for what the person is looking at (the view's own status says it) and never for failures that need a decision (those
 * are banners and dialogs). The page holds them only in memory.
 */
export class NotificationService extends SnapshotStore<NotificationSnapshot> implements Disposable {
  private toasts: Toast[] = []
  private nextId = 1
  private readonly timers: Timers
  private readonly hideTimers = new Map<number, unknown>()
  private readonly held = new Set<number>()
  private announcement: NotificationSnapshot['announcement']
  private disposed = false

  constructor(options: { timers?: Timers } = {}) {
    super({ visible: [], queued: 0 })
    this.timers = options.timers ?? browserTimers
  }

  /** Shows a toast (or queues it behind three), and returns its id for `dismiss`. */
  notify(input: ToastInput): number {
    if (this.disposed) return 0
    const id = this.nextId++
    const toast: Toast = { ...input, id, message: bounded(input.message), actions: input.actions?.slice(0, notificationLimits.actions) }
    const replaced = input.key === undefined ? -1 : this.toasts.findIndex(item => item.key === input.key)
    if (replaced >= 0) {
      this.forget(this.toasts[replaced].id)
      this.toasts[replaced] = toast
    } else {
      this.toasts.push(toast)
      // Over the bound, the oldest toast still waiting for a place goes; the ones on screen stay.
      if (this.toasts.length > notificationLimits.visible + notificationLimits.queued) this.toasts.splice(notificationLimits.visible, 1)
    }
    this.announcement = { id, text: toast.message, assertive: toast.severity === 'error' }
    this.update()
    return id
  }

  dismiss(id: number): void {
    const index = this.toasts.findIndex(toast => toast.id === id)
    if (index < 0) return
    this.toasts.splice(index, 1)
    this.forget(id)
    this.update()
  }

  /** Notifications: Clear All. */
  clear(): void {
    for (const toast of this.toasts) this.forget(toast.id)
    this.toasts = []
    this.update()
  }

  /** Runs one of a toast's actions and dismisses the toast; a failing action still dismisses it. */
  run(id: number, action: ToastAction): void {
    this.dismiss(id)
    try { action.run() } catch (error) { onUnexpectedError(error) }
  }

  /** The pointer or focus is on the toast (`true`), or left it: its timer waits meanwhile, then starts over. */
  hold(id: number, holding: boolean): void {
    if (holding === this.held.has(id) || !this.toasts.some(toast => toast.id === id)) return
    if (holding) {
      this.held.add(id)
      this.clearTimer(id)
    } else {
      this.held.delete(id)
      this.schedule()
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.hideTimers.values()) this.timers.clearTimeout(timer)
    this.hideTimers.clear()
    this.toasts = []
    this.clearListeners()
  }

  private forget(id: number): void {
    this.clearTimer(id)
    this.held.delete(id)
  }

  private clearTimer(id: number): void {
    const timer = this.hideTimers.get(id)
    if (timer !== undefined) this.timers.clearTimeout(timer)
    this.hideTimers.delete(id)
  }

  /** Only toasts on screen count down: a queued one gets its full time once it shows. */
  private schedule(): void {
    for (const toast of this.toasts.slice(0, notificationLimits.visible)) {
      if (!autoHides(toast) || this.held.has(toast.id) || this.hideTimers.has(toast.id)) continue
      this.hideTimers.set(toast.id, this.timers.setTimeout(() => { this.hideTimers.delete(toast.id); this.dismiss(toast.id) }, notificationLimits.autoHideMs))
    }
  }

  private update(): void {
    if (this.disposed) return
    this.schedule()
    this.publish({ visible: this.toasts.slice(0, notificationLimits.visible), queued: Math.max(0, this.toasts.length - notificationLimits.visible), ...this.announcement ? { announcement: this.announcement } : {} })
  }
}
