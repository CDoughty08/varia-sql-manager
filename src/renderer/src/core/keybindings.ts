import type { CommandId } from '../../../shared/commands/catalog'
import { findConflicts, isBlockingConflict } from '../../../shared/commands/conflicts'
import type { ContextKeys } from '../../../shared/commands/context-keys'
import { chordFromEvent, defaultRules, keybindingLabel, workbenchRules, type KeybindingLabel, type KeyEventLike, type Platform, type ResolvedRule } from '../../../shared/commands/keybindings'
import { menuCommandIds, menuMayShowChords } from '../../../shared/commands/menus'
import { evaluateWhen } from '../../../shared/commands/when'
import type { CommandService } from './commands'
import { onUnexpectedError } from './errors'
import type { CommandArgs, Disposable } from './types'

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
  /** What a key's command acts on, when focus names it (a focused query tab: `tabId`); menus and the palette act on the active document. */
  readonly keyArgs?: (command: CommandId) => CommandArgs | undefined
  /** Every key release, after the menus': Peek forgets a Ctrl+hover when Ctrl goes up with the pointer still. Never consumes. */
  readonly keyUp?: (event: KeyDownEvent) => void
}
/** A captured chord: one canonical chord (`ctrl+shift+e`), or two separated by a space after Ctrl/⌘+K (`ctrl+k ctrl+c`). */
export type CaptureListener = (chord: string, event: KeyDownEvent) => void
export interface CaptureOptions {
  /** Ctrl/⌘+K was pressed and waits for a second chord (the box shows "Ctrl+K, …"). */
  readonly onPrefix?: (chord: string, event: KeyDownEvent) => void
}
interface CaptureState { readonly onChord: CaptureListener; readonly options: CaptureOptions; prefix?: { readonly chord: string; readonly at: number } }
/** Monaco leaves chord mode 5 s after the prefix (`_scheduleLeaveChordMode`); from then on the next key is a plain key again. */
export const nativeChordTimeout = 5000
/** The one chord prefix a capture box takes in v1: Ctrl+K, or ⌘K on macOS (two-part chords are `mod+k X` in the editor). */
export const captureChordPrefix = (platform: Platform): string => platform === 'darwin' ? 'meta+k' : 'ctrl+k'

/**
 * The workbench's only key dispatcher: capture listeners on window, so it runs before Monaco and React. Open menus see
 * keys first, then menu access keys; otherwise it consumes a key only when a rule's `when` matches, even if the command
 * is then unavailable, and leaves every other key alone. Native rules (Monaco's) are never dispatched; after a native
 * chord prefix in editor text (Ctrl/⌘+K), the next key goes to Monaco if it comes within Monaco's chord timeout. That
 * pass-through also delivers Varia's own two-part chords (bridge keybindings), which Monaco dispatches to the catalogue.
 */
export class KeybindingService implements Disposable {
  private rules: readonly ResolvedRule[] = []
  private table: ReadonlyMap<string, readonly ResolvedRule[]> = new Map()
  private prefixes: ReadonlySet<string> = new Set()
  private macKeyEquivalents: ReadonlySet<string> = new Set()
  private revision = 0
  private readonly listeners = new Set<() => void>()
  /** When a native chord prefix was pressed in editor text, while Monaco waits for the chord's second key. */
  private pendingNativePrefix?: number
  private captureState?: CaptureState
  private readonly detachers = new Set<() => void>()
  constructor(private readonly options: KeybindingServiceOptions) {
    this.apply(options.rules ?? defaultRules(options.platform), options.onConflict ?? (import.meta.env?.DEV ? 'throw' : 'log'))
  }
  private apply(rules: readonly ResolvedRule[], onConflict: 'throw' | 'log'): void {
    const { platform } = this.options
    const conflicts = findConflicts(rules, platform).filter(conflict => isBlockingConflict(conflict, platform))
    if (conflicts.length) {
      const message = 'Keybinding conflicts:\n' + conflicts.map(conflict => conflict.message).join('\n')
      if (onConflict === 'throw') throw new Error(message)
      console.error(message)
    }
    const primary = (id: CommandId) => rules.find(rule => rule.command === id && rule.chords.length === 1)
    this.rules = rules
    this.table = workbenchRules(rules)
    this.prefixes = new Set(rules.filter(rule => rule.native && rule.chords.length > 1).map(rule => rule.chords[0]))
    // A macOS menu item's ⌘ accelerator is also a key equivalent, which Chromium offers the page first and then the menu,
    // where it would run the command where its key does not apply; consuming the key stops that.
    this.macKeyEquivalents = new Set(platform === 'darwin' ? menuCommandIds.flatMap(id => {
      const rule = primary(id)
      return rule && !rule.native && menuMayShowChords(rule.chords, platform) ? [rule.chords[0]] : []
    }) : [])
  }
  /**
   * Replaces the rules every key, label and menu reads (the Shortcuts page's effective rules), then tells subscribers.
   * Conflicts are logged, never thrown: `effectiveRules` already refused any it would have caused. A pending native chord
   * prefix is kept: Monaco, not the rules, waits for the chord's second key, and still takes it within its timeout.
   */
  setRules(rules: readonly ResolvedRule[]): void {
    if (rules === this.rules) return
    this.apply(rules, 'log')
    this.revision++
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { onUnexpectedError(error) }
    }
  }
  /** The rules in force: the catalogue's until `setRules`. */
  getRules(): readonly ResolvedRule[] { return this.rules }
  /** Counts `setRules` calls: a snapshot for `useSyncExternalStore`, so labels follow a remap. */
  getRevision(): number { return this.revision }
  /** Calls `listener` after every `setRules`. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  /**
   * Routes key presses to `onChord` instead of menus, access keys and dispatch, until the returned function is called
   * (the Shortcuts page's capture box), so this stays the only key listener. Every chord is recorded, Escape and Enter
   * included, but Tab and Shift+Tab are never captured, so focus can leave the box; modifier presses, IME composition and
   * dead keys record nothing. After Ctrl/⌘+K the next chord within `nativeChordTimeout` makes a two-part chord
   * (`ctrl+k ctrl+c`), as Monaco's would; the prefix alone goes to `onPrefix`. A later capture replaces an earlier one.
   */
  capture(onChord: CaptureListener, options: CaptureOptions = {}): () => void {
    const state: CaptureState = { onChord, options }
    this.captureState = state
    return () => { if (this.captureState === state) this.captureState = undefined }
  }
  /** Whether a capture box is recording keys now. */
  get capturing(): boolean { return !!this.captureState }
  private primaryRule(id: CommandId): ResolvedRule | undefined { return this.rules.find(rule => rule.command === id && rule.chords.length === 1) }
  /**
   * The label of the command's primary keybinding, for tooltips and the palette. A command bound only to a two-part
   * chord shows that ("Ctrl+K Ctrl+C"); native menus cannot, because Electron accelerators are single chords.
   */
  lookup(id: CommandId): KeybindingLabel | undefined {
    const rule = this.primaryRule(id) ?? this.rules.find(candidate => candidate.command === id)
    return rule && keybindingLabel(rule.chords, this.options.platform)
  }
  /** Listens in `target`: the main window, and each popout window while it is open. */
  attach(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): Disposable {
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
      this.detachers.delete(detach)
    }
    this.detachers.add(detach)
    return { dispose: detach }
  }
  handleKeyDown(event: KeyDownEvent): void {
    try {
      if (event.defaultPrevented) return
      if (this.captureState) { this.captureKey(this.captureState, event); return }
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
      void this.options.commands.execute(rule.command, this.options.keyArgs?.(rule.command), 'keybinding')
    } catch (error) { onUnexpectedError(error) }
  }
  private captureKey(state: CaptureState, event: KeyDownEvent): void {
    const { platform } = this.options
    if (event.isComposing || event.keyCode === 229) return
    const chord = chordFromEvent(event, platform)
    // Tab and Shift+Tab move focus out of the box (and forget a prefix); every other chord is the box's.
    if (chord === 'tab' || chord === 'shift+tab') { state.prefix = undefined; return }
    if (!chord) { if (event.key === 'Dead') state.prefix = undefined; return }
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat) return
    const now = (this.options.now ?? Date.now)(), prefix = state.prefix
    state.prefix = undefined
    if (prefix && now - prefix.at <= nativeChordTimeout) { state.onChord(`${prefix.chord} ${chord}`, event); return }
    if (chord === captureChordPrefix(platform)) { state.prefix = { chord, at: now }; state.options.onPrefix?.(chord, event); return }
    state.onChord(chord, event)
  }
  handleKeyUp(event: KeyDownEvent): void {
    // While a capture box records, a bare Alt release is part of a chord, not a tap that focuses the menubar.
    if (!this.captureState) try { this.options.menus?.handleKeyUp(event) } catch (error) { onUnexpectedError(error) }
    try { this.options.keyUp?.(event) } catch (error) { onUnexpectedError(error) }
  }
  dispose(): void { for (const detach of [...this.detachers]) detach() }
}
