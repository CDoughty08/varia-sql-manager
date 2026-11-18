import { peekLimits } from '../../../shared/explorer/peek'
import type { GestureService } from '../core/gestures'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable } from '../core/types'

/**
 * The column profile's peek (gestures.ts `output.profilePeekHover`): while its modifier (Ctrl, ⌘ on macOS) is held with
 * the pointer on a profile panel, that panel shows the other list (only the selected columns, or every column when
 * Selected Columns Only is on). Its snapshot is the tab whose panel peeks, or undefined.
 *
 * Held keys come from `KeybindingService`'s `keyDown`, `keyUp` and `blur` hooks, as Peek's do, never a listener of its own;
 * pointer moves report the modifier through `GestureService`. As Object Explorer's Peek on Hover, the peek starts
 * `peekLimits.pressMs` after the modifier goes down (or the pointer arrives with it held), and any other key before or
 * during it makes it a chord (Ctrl+C with the pointer resting on the panel), which ends it until the pointer moves again.
 */
export class ProfilePeekService extends SnapshotStore<string | undefined> implements Disposable {
  /** The tab whose panel the pointer is on. */
  private over: string | undefined
  private timer: unknown
  /** A chord ended the peek: the modifier still held does not start it again until the pointer moves or it is pressed again. */
  private chorded = false
  private readonly timers: Timers
  private disposed = false

  constructor(private readonly o: { readonly gestures: Pick<GestureService, 'isModifierKey'>; readonly timers?: Timers }) {
    super(undefined)
    this.timers = o.timers ?? browserTimers
  }

  /**
   * The pointer moved on the panel of `tabId` (`held`: whether the gesture's modifiers are held, from `GestureService`)
   * or left it (`tabId` undefined). A move also corrects the held state after a press or release the window did not see.
   */
  pointer(tabId: string | undefined, held = false): void {
    if (this.disposed) return
    if (tabId !== this.over) this.chorded = false
    this.over = tabId
    if (tabId === undefined || !held) { this.stop(); return }
    if (this.getSnapshot() === tabId || this.timer !== undefined) return
    this.chorded = false
    this.start()
  }

  /** A key went down anywhere in the window (the key dispatcher's `keyDown`). */
  keyDown(key: string, repeat = false): void {
    if (this.disposed) return
    if (!this.o.gestures.isModifierKey('output.profilePeekHover', key)) {
      // A chord: Ctrl+C on the panel copies the grid's selection; it is not a peek.
      if (this.timer !== undefined || this.getSnapshot() !== undefined) { this.chorded = true; this.stop() }
      return
    }
    if (repeat || this.over === undefined || this.getSnapshot() !== undefined || this.timer !== undefined) return
    this.chorded = false
    this.start()
  }

  /** A key went up anywhere in the window: releasing the modifier ends the peek. */
  keyUp(key: string): void {
    if (this.o.gestures.isModifierKey('output.profilePeekHover', key)) { this.chorded = false; this.stop() }
  }

  /** The window lost focus: the modifier's release would go unseen. */
  blur(): void { this.stop() }

  private start(): void {
    if (this.chorded) return
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      if (this.over !== undefined) this.set(this.over)
    }, peekLimits.pressMs)
  }

  private stop(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    this.timer = undefined
    this.set(undefined)
  }

  private set(tabId: string | undefined): void { if (tabId !== this.getSnapshot()) this.publish(tabId) }

  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    this.clearListeners()
  }
}
