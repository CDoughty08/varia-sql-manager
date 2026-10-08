import { menuCommandIds, toggleCommandIds, type MenuState } from '../../../shared/commands/menus'
import type { CommandService } from './commands'
import { onUnexpectedError } from './errors'
import { browserTimers, type Timers } from './timers'
import type { Disposable } from './types'

/** Which native menu commands are unavailable and which checkboxes are on. */
export function computeMenuState(commands: Pick<CommandService, 'isEnabled' | 'isToggled'>): MenuState {
  return { disabled: menuCommandIds.filter(id => !commands.isEnabled(id)), checked: toggleCommandIds.filter(id => commands.isToggled(id)) }
}

export type { Timers } from './timers'
const delay = 50

/**
 * Sends the native menu's state to main: at once on start, then 50 ms after a context or handler change (later changes
 * join the pending send), and only when it differs from what was last sent. `flush` sends synchronously, before a menu opens.
 */
export class MenuStatePublisher implements Disposable {
  private timer: unknown
  private last = ''
  private stop?: () => void
  constructor(private readonly options: {
    commands: Pick<CommandService, 'isEnabled' | 'isToggled' | 'onDidChangeHandlers'>
    context: { subscribe(listener: () => void): () => void }
    send(state: MenuState): void
    timers?: Timers
  }) {}
  private get timers(): Timers { return this.options.timers ?? browserTimers }
  /** Starts publishing; the returned handle stops it (React effects start and stop it again in development). */
  start(): Disposable {
    this.stop?.()
    const unsubscribe = this.options.context.subscribe(() => this.schedule())
    const handlers = this.options.commands.onDidChangeHandlers(() => this.schedule())
    const stop = () => {
      unsubscribe(); handlers.dispose(); this.cancel()
      if (this.stop === stop) this.stop = undefined
    }
    this.stop = stop
    this.flush()
    return { dispose: stop }
  }
  flush(): void {
    this.cancel()
    try {
      const state = computeMenuState(this.options.commands), text = JSON.stringify(state)
      if (text === this.last) return
      this.last = text
      this.options.send(state)
    } catch (error) { onUnexpectedError(error) }
  }
  // The first change starts the timer and later ones join it, so a stream of changes still publishes every 50 ms.
  private schedule(): void {
    if (this.timer !== undefined) return
    this.timer = this.timers.setTimeout(() => { this.timer = undefined; this.flush() }, delay)
  }
  private cancel(): void {
    if (this.timer === undefined) return
    this.timers.clearTimeout(this.timer)
    this.timer = undefined
  }
  dispose(): void { this.stop?.(); this.cancel() }
}
