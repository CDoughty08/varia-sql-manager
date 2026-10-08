import type { CommandId } from '../../../shared/commands/catalog'
import { findConflicts } from '../../../shared/commands/conflicts'
import type { ContextKeys } from '../../../shared/commands/context-keys'
import { chordFromEvent, defaultRules, keybindingLabel, workbenchRules, type KeybindingLabel, type KeyEventLike, type Platform, type ResolvedRule } from '../../../shared/commands/keybindings'
import { menuCommandIds } from '../../../shared/commands/menus'
import { evaluateWhen } from '../../../shared/commands/when'
import type { CommandService } from './commands'
import { onUnexpectedError } from './errors'
import type { Disposable } from './types'

/** The parts of a `KeyboardEvent` the dispatcher reads and calls, so tests can pass plain objects. */
export interface KeyDownEvent extends KeyEventLike {
  readonly defaultPrevented: boolean
  readonly repeat: boolean
  preventDefault(): void
  stopPropagation(): void
}
export interface KeybindingServiceOptions {
  readonly platform: Platform
  readonly commands: Pick<CommandService, 'execute'>
  readonly context: { get(): ContextKeys }
  readonly modalOpen: () => boolean
  readonly editorHasTextFocus: () => boolean
  /** Defaults to the catalogue's rules for the platform. */
  readonly rules?: readonly ResolvedRule[]
  /** What to do with conflicting rules: development builds throw, production logs and keeps the first rule. */
  readonly onConflict?: 'throw' | 'log'
}

/**
 * The workbench's only key dispatcher: a capture listener on window, so it runs before Monaco, the title bar, and React.
 * It consumes a key only when a rule's `when` matches, even if the command is then unavailable, and leaves every other
 * key alone. Native rules (Monaco's) are never dispatched; after a native chord prefix in editor text (Ctrl/⌘+K), the
 * next key goes to Monaco.
 */
export class KeybindingService implements Disposable {
  private readonly rules: readonly ResolvedRule[]
  private readonly table: ReadonlyMap<string, readonly ResolvedRule[]>
  private readonly prefixes: ReadonlySet<string>
  private readonly macKeyEquivalents: ReadonlySet<string>
  private pendingNativePrefix = false
  private detach?: () => void
  constructor(private readonly options: KeybindingServiceOptions) {
    const { platform } = options
    this.rules = options.rules ?? defaultRules(platform)
    const conflicts = findConflicts(this.rules, platform)
    if (conflicts.length) {
      const message = 'Keybinding conflicts:\n' + conflicts.map(conflict => conflict.message).join('\n')
      if ((options.onConflict ?? (import.meta.env?.DEV ? 'throw' : 'log')) === 'throw') throw new Error(message)
      console.error(message)
    }
    this.table = workbenchRules(this.rules)
    this.prefixes = new Set(this.rules.filter(rule => rule.native && rule.chords.length > 1).map(rule => rule.chords[0]))
    // A menu item's accelerator is also a macOS key equivalent, which would run the command where its key does not apply
    // (F5 in Query Output); consuming the key stops that.
    this.macKeyEquivalents = new Set(platform === 'darwin' ? menuCommandIds.flatMap(id => {
      const rule = this.primaryRule(id)
      return rule && !rule.native ? [rule.chords[0]] : []
    }) : [])
  }
  private primaryRule(id: CommandId): ResolvedRule | undefined { return this.rules.find(rule => rule.command === id && rule.chords.length === 1) }
  /** The label of the command's primary keybinding, for menus, tooltips, and the palette. */
  lookup(id: CommandId): KeybindingLabel | undefined {
    const rule = this.primaryRule(id)
    return rule && keybindingLabel(rule.chords, this.options.platform)
  }
  attach(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): Disposable {
    this.detach?.()
    const keyDown = (event: Event) => this.handleKeyDown(event as KeyboardEvent)
    const reset = () => { this.pendingNativePrefix = false }
    target.addEventListener('keydown', keyDown, true)
    target.addEventListener('focusout', reset, true)
    target.addEventListener('blur', reset)
    const detach = () => {
      target.removeEventListener('keydown', keyDown, true)
      target.removeEventListener('focusout', reset, true)
      target.removeEventListener('blur', reset)
      if (this.detach === detach) this.detach = undefined
    }
    this.detach = detach
    return { dispose: detach }
  }
  handleKeyDown(event: KeyDownEvent): void {
    try {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const { platform } = this.options
      const chord = chordFromEvent(event, platform)
      if (!chord) return
      // Monaco owns the key after its chord prefix.
      if (this.pendingNativePrefix) { this.pendingNativePrefix = false; return }
      if (this.prefixes.has(chord) && this.options.editorHasTextFocus()) { this.pendingNativePrefix = true; return }
      const rules = this.table.get(chord)
      if (!rules) return
      // Dialogs own their keys, so the key is not consumed.
      if (this.options.modalOpen()) return
      const context = this.options.context.get()
      const rule = rules.find(candidate => !candidate.when || evaluateWhen(candidate.when, context))
      if (!rule) {
        if (this.macKeyEquivalents.has(chord)) { event.preventDefault(); event.stopPropagation() }
        return
      }
      // Consumed even when the command is unavailable: the key must not fall through to the editor or the menu.
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat && !rule.allowRepeat) return
      void this.options.commands.execute(rule.command, undefined, 'keybinding')
    } catch (error) { onUnexpectedError(error) }
  }
  dispose(): void { this.detach?.() }
}
