import type { CommandId } from '../../../shared/commands/catalog'
import { findConflicts } from '../../../shared/commands/conflicts'
import type { ContextKeys } from '../../../shared/commands/context-keys'
import { chordFromEvent, defaultRules, keybindingLabel, workbenchRules, type KeybindingLabel, type KeyEventLike, type Platform, type ResolvedRule } from '../../../shared/commands/keybindings'
import { menuCommandIds, menuMayShowChords } from '../../../shared/commands/menus'
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
/**
 * The title-bar and context menus as the dispatcher sees them (`MenuService`): they see every key first while they own
 * the keyboard, and on Windows and Linux they own F10, Alt plus a menu's letter, and a bare Alt tap.
 */
export interface MenuKeyRouter {
  noteKeyDown(event: KeyDownEvent): void
  ownsKeyboard(): boolean
  handleKeyDown(event: KeyDownEvent): 'consumed' | 'passthrough'
  handleAccessKey(chord: string, event: KeyDownEvent): boolean
  handleKeyUp(event: KeyDownEvent): void
}
export interface KeybindingServiceOptions {
  readonly platform: Platform
  readonly commands: Pick<CommandService, 'execute'>
  readonly context: { get(): ContextKeys }
  readonly modalOpen: () => boolean
  readonly editorHasTextFocus: () => boolean
  /** Whether a focus target is inside the query editor; focus moving within it keeps a pending chord prefix. */
  readonly editorContains?: (target: EventTarget | null) => boolean
  /** Defaults to the catalogue's rules for the platform. */
  readonly rules?: readonly ResolvedRule[]
  /** What to do with conflicting rules: development builds throw, production logs and keeps the first rule. */
  readonly onConflict?: 'throw' | 'log'
  /** The clock for the chord prefix's lifetime; defaults to `Date.now`, as Monaco's. */
  readonly now?: () => number
  readonly menus?: MenuKeyRouter
}
/** Monaco leaves chord mode 5 s after the prefix (`_scheduleLeaveChordMode`); from then on the next key is a plain key again. */
export const nativeChordTimeout = 5000

/**
 * The workbench's only key dispatcher: capture listeners on window, so it runs before Monaco and React. Open menus see
 * keys first, then menu access keys; otherwise it consumes a key only when a rule's `when` matches, even if the command
 * is then unavailable, and leaves every other key alone. Native rules (Monaco's) are never dispatched; after a native
 * chord prefix in editor text (Ctrl/⌘+K), the next key goes to Monaco if it comes within Monaco's chord timeout. That
 * pass-through also delivers Varia's own two-part chords (bridge keybindings), which Monaco dispatches to the catalogue.
 */
export class KeybindingService implements Disposable {
  private readonly rules: readonly ResolvedRule[]
  private readonly table: ReadonlyMap<string, readonly ResolvedRule[]>
  private readonly prefixes: ReadonlySet<string>
  private readonly macKeyEquivalents: ReadonlySet<string>
  /** When a native chord prefix was pressed in editor text, while Monaco waits for the chord's second key. */
  private pendingNativePrefix?: number
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
    // A macOS menu item's ⌘ accelerator is also a key equivalent, which Chromium offers the page first and then the menu,
    // where it would run the command where its key does not apply; consuming the key stops that.
    this.macKeyEquivalents = new Set(platform === 'darwin' ? menuCommandIds.flatMap(id => {
      const rule = this.primaryRule(id)
      return rule && !rule.native && menuMayShowChords(rule.chords, platform) ? [rule.chords[0]] : []
    }) : [])
  }
  private primaryRule(id: CommandId): ResolvedRule | undefined { return this.rules.find(rule => rule.command === id && rule.chords.length === 1) }
  /**
   * The label of the command's primary keybinding, for tooltips and the palette. A command bound only to a two-part
   * chord shows that ("Ctrl+K Ctrl+C"); native menus cannot, because Electron accelerators are single chords.
   */
  lookup(id: CommandId): KeybindingLabel | undefined {
    const rule = this.primaryRule(id) ?? this.rules.find(candidate => candidate.command === id)
    return rule && keybindingLabel(rule.chords, this.options.platform)
  }
  attach(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): Disposable {
    this.detach?.()
    const keyDown = (event: Event) => this.handleKeyDown(event as KeyboardEvent)
    const keyUp = (event: Event) => this.handleKeyUp(event as KeyboardEvent)
    const reset = () => { this.pendingNativePrefix = undefined }
    // Monaco moves focus to its IME text area while it waits for a chord's second key; that is not leaving the editor.
    const focusOut = (event: Event) => { if (!this.options.editorContains?.((event as FocusEvent).relatedTarget)) reset() }
    target.addEventListener('keydown', keyDown, true)
    target.addEventListener('keyup', keyUp, true)
    target.addEventListener('focusout', focusOut, true)
    target.addEventListener('blur', reset)
    const detach = () => {
      target.removeEventListener('keydown', keyDown, true)
      target.removeEventListener('keyup', keyUp, true)
      target.removeEventListener('focusout', focusOut, true)
      target.removeEventListener('blur', reset)
      if (this.detach === detach) this.detach = undefined
    }
    this.detach = detach
    return { dispose: detach }
  }
  handleKeyDown(event: KeyDownEvent): void {
    try {
      if (event.defaultPrevented) return
      const { platform, menus } = this.options
      // Every press counts for a bare-Alt tap, even one the menus then consume (an Alt tap also leaves the menubar).
      menus?.noteKeyDown(event)
      if (menus?.ownsKeyboard() && menus.handleKeyDown(event) === 'consumed') return
      if (event.isComposing || event.keyCode === 229) return
      const chord = chordFromEvent(event, platform)
      // Monaco ends a chord on a dead key; modifier presses leave it waiting.
      if (!chord) { if (event.key === 'Dead') this.pendingNativePrefix = undefined; return }
      const now = this.options.now ?? Date.now, pending = this.pendingNativePrefix
      if (pending !== undefined) {
        this.pendingNativePrefix = undefined
        // Monaco owns the key after its chord prefix, until it stops waiting.
        if (now() - pending <= nativeChordTimeout) return
      }
      if (this.prefixes.has(chord) && this.options.editorHasTextFocus()) { this.pendingNativePrefix = now(); return }
      if (menus?.handleAccessKey(chord, event)) return
      let rules = this.table.get(chord)
      if (!rules) return
      // Dialogs own their keys, so the key is not consumed, unless a rule is marked to work over them.
      if (this.options.modalOpen()) {
        rules = rules.filter(rule => rule.modal)
        if (!rules.length) return
      }
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
  handleKeyUp(event: KeyDownEvent): void {
    try { this.options.menus?.handleKeyUp(event) } catch (error) { onUnexpectedError(error) }
  }
  dispose(): void { this.detach?.() }
}
