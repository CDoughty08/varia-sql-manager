import { commandDescriptor, commandIds, type CommandId, type KeybindingSpec } from './catalog'
import { compileWhen, type WhenAst } from './when'

export type Platform = 'win32' | 'linux' | 'darwin'
export const platforms: readonly Platform[] = ['win32', 'linux', 'darwin']
/** Electron's `process.platform`, with every other Unix treated as Linux. */
export const toPlatform = (value: unknown): Platform => value === 'win32' || value === 'darwin' ? value : 'linux'

/**
 * A chord is one key press in canonical form: lowercase, modifiers in the order `ctrl+shift+alt+meta`, then the key
 * (`ctrl+shift+p`, `shift+meta+z`, `f5`). A keybinding is one chord, or two for native editor chords (`ctrl+k ctrl+c`).
 */
const modifiers = ['ctrl', 'shift', 'alt', 'meta'] as const
type Modifier = typeof modifiers[number]
const isModifier = (value: string): value is Modifier => (modifiers as readonly string[]).includes(value)
const functionKeys = Array.from({ length: 24 }, (_, index) => `f${index + 1}`)
const namedKeys = ['enter', 'escape', 'tab', 'space', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'pause', 'contextmenu', ...functionKeys]
const punctuationKeys = ['/', '\\', ',', '.', ';', "'", '[', ']', '-', '=', '`']
const characterKeys = [...'abcdefghijklmnopqrstuvwxyz0123456789', ...punctuationKeys]
export const keyNames: ReadonlySet<string> = new Set([...characterKeys, ...namedKeys])

export class KeySpecError extends Error {
  constructor(message: string) { super(message); this.name = 'KeySpecError' }
}

/** Splits a canonical chord into its modifiers and key. */
export function splitChord(chord: string): { modifiers: ReadonlySet<Modifier>; key: string } {
  const parts = chord.split('+'), key = parts.pop()!
  return { modifiers: new Set(parts.filter(isModifier)), key }
}

function parsePart(part: string, spec: string, platform: Platform): string {
  const tokens = part.split('+'), key = tokens.pop()!
  if (!keyNames.has(key)) throw new KeySpecError(`"${spec}": unknown key "${key}".`)
  const pressed = new Set<Modifier>()
  for (const token of tokens) {
    const modifier = token === 'mod' ? (platform === 'darwin' ? 'meta' : 'ctrl') : token === 'option' ? 'alt' : token === 'cmd' ? 'meta' : token
    if (!isModifier(modifier)) throw new KeySpecError(`"${spec}": unknown modifier "${token}".`)
    if (pressed.has(modifier)) throw new KeySpecError(`"${spec}": "${token}" repeats a modifier.`)
    pressed.add(modifier)
  }
  return [...modifiers.filter(modifier => pressed.has(modifier)), key].join('+')
}

/**
 * Parses `part [' ' part]`, where a part is `(mod|ctrl|shift|alt|option|cmd|meta '+')* key`. `mod` is Ctrl on Windows
 * and Linux and ⌘ on macOS. Returns the canonical chords; throws `KeySpecError`.
 */
export function parseKeySpec(spec: string, platform: Platform): string[] {
  const parts = spec.trim().toLowerCase().split(/ +/)
  if (parts.length > 2) throw new KeySpecError(`"${spec}": a keybinding has at most two parts.`)
  return parts.map(part => parsePart(part, spec, platform))
}

/** The subset of `KeyboardEvent` that `chordFromEvent` reads, so tests can pass plain objects. */
export interface KeyEventLike {
  readonly key: string
  readonly code: string
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly isComposing?: boolean
  readonly keyCode?: number
  getModifierState?(key: string): boolean
}
const ignoredKeys = new Set(['Dead', 'Process', 'Unidentified', 'Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper', 'Fn', 'FnLock', 'CapsLock', 'NumLock', 'ScrollLock', 'Symbol', 'SymbolLock'])
const punctuationCodes: Readonly<Record<string, string>> = {
  Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=', Backquote: '`'
}
const namedEventKeys: ReadonlyMap<string, string> = new Map([
  ['Enter', 'enter'], ['Escape', 'escape'], ['Tab', 'tab'], [' ', 'space'], ['Backspace', 'backspace'], ['Delete', 'delete'], ['Insert', 'insert'],
  ['Home', 'home'], ['End', 'end'], ['PageUp', 'pageup'], ['PageDown', 'pagedown'], ['ArrowUp', 'up'], ['ArrowDown', 'down'], ['ArrowLeft', 'left'],
  ['ArrowRight', 'right'], ['Pause', 'pause'], ['ContextMenu', 'contextmenu'], ...functionKeys.map(key => [key.toUpperCase(), key] as const)
])
// Used when `key` names no key: ⌥Space types a no-break space, and Ctrl+Pause reports `Cancel`.
const namedEventCodes: ReadonlyMap<string, string> = new Map([['Space', 'space'], ['NumpadEnter', 'enter'], ['Pause', 'pause']])

function keyFromEvent(event: KeyEventLike): string | undefined {
  const digit = /^Digit([0-9])$/.exec(event.code)
  if (digit) return digit[1]
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase()
  const letter = /^Key([A-Z])$/.exec(event.code)
  if (letter) return letter[1].toLowerCase()
  if (Object.hasOwn(punctuationCodes, event.code)) return punctuationCodes[event.code]
  const named = namedEventKeys.get(event.key)
  if (named) return named
  if (/^[0-9]$/.test(event.key)) return event.key
  return namedEventCodes.get(event.code)
}

/**
 * The chord a key press means, or undefined for presses that are not shortcuts: IME composition, dead keys, and
 * modifier-only presses. Letters follow the layout (`key`, so AZERTY's A is `a`) unless the layout types something
 * else there (Cyrillic, macOS ⌥ letters), when the physical key (`code`) is used; digits and punctuation always use
 * `code`, so Shift does not change them. AltGr is not a shortcut modifier on Windows and Linux.
 */
export function chordFromEvent(event: KeyEventLike, platform: Platform): string | undefined {
  if (event.isComposing || event.keyCode === 229 || ignoredKeys.has(event.key)) return undefined
  const key = keyFromEvent(event)
  if (!key) return undefined
  const altGraph = platform !== 'darwin' && event.getModifierState?.('AltGraph') === true
  const pressed = [event.ctrlKey && !altGraph, event.shiftKey, event.altKey && !altGraph, event.metaKey]
  return [...modifiers.filter((_, index) => pressed[index]), key].join('+')
}

/** Labels for menus, tooltips, and the palette: `parts` render as one `<kbd>` each, `aria` is read aloud. */
export interface KeybindingLabel { readonly parts: readonly string[]; readonly text: string; readonly aria: string }
const macModifierOrder: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'meta']
const macModifierGlyphs: Readonly<Record<Modifier, string>> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }
const macModifierNames: Readonly<Record<Modifier, string>> = { ctrl: 'Control', alt: 'Option', shift: 'Shift', meta: 'Command' }
const macKeyGlyphs: Readonly<Record<string, string>> = {
  enter: '↩', tab: '⇥', escape: '⎋', backspace: '⌫', delete: '⌦', up: '↑', down: '↓', left: '←', right: '→', pageup: '⇞', pagedown: '⇟'
}
const keyLabels: Readonly<Record<string, string>> = {
  enter: 'Enter', escape: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', up: 'Up', down: 'Down', left: 'Left', right: 'Right', pause: 'Pause', contextmenu: 'Menu'
}
const spokenKeys: Readonly<Record<string, string>> = {
  pageup: 'Page Up', pagedown: 'Page Down', up: 'Up Arrow', down: 'Down Arrow', left: 'Left Arrow', right: 'Right Arrow', contextmenu: 'Context Menu',
  '/': 'Slash', '\\': 'Backslash', ',': 'Comma', '.': 'Period', ';': 'Semicolon', "'": 'Quote', '[': 'Left Bracket', ']': 'Right Bracket', '-': 'Minus', '=': 'Equals', '`': 'Backquote'
}
const keyLabel = (key: string) => keyLabels[key] ?? key.toUpperCase()
const metaName = (platform: Platform) => platform === 'win32' ? 'Win' : 'Super'

/** One chord as shown: `Ctrl+Shift+P` on Windows and Linux, `⇧⌘P` on macOS. */
export function formatLabel(chord: string, platform: Platform): string {
  const { modifiers: pressed, key } = splitChord(chord)
  if (platform === 'darwin') return macModifierOrder.filter(modifier => pressed.has(modifier)).map(modifier => macModifierGlyphs[modifier]).join('') + (macKeyGlyphs[key] ?? keyLabel(key))
  const names: Readonly<Record<Modifier, string>> = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: metaName(platform) }
  return [...modifiers.filter(modifier => pressed.has(modifier)).map(modifier => names[modifier]), keyLabel(key)].join('+')
}

/** One chord as read aloud: `Control+Shift+P`, or `Shift+Command+P` on macOS. */
export function ariaLabel(chord: string, platform: Platform): string {
  const { modifiers: pressed, key } = splitChord(chord)
  const names: Readonly<Record<Modifier, string>> = platform === 'darwin' ? macModifierNames : { ctrl: 'Control', shift: 'Shift', alt: 'Alt', meta: platform === 'win32' ? 'Windows' : 'Super' }
  const order = platform === 'darwin' ? macModifierOrder : modifiers
  return [...order.filter(modifier => pressed.has(modifier)).map(modifier => names[modifier]), spokenKeys[key] ?? keyLabel(key)].join('+')
}

export function keybindingLabel(chords: readonly string[], platform: Platform): KeybindingLabel {
  const parts = chords.map(chord => formatLabel(chord, platform))
  return { parts, text: parts.join(' '), aria: chords.map(chord => ariaLabel(chord, platform)).join(', then ') }
}

const acceleratorKeys: Readonly<Record<string, string>> = {
  enter: 'Enter', escape: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', up: 'Up', down: 'Down', left: 'Left', right: 'Right'
}
/**
 * The Electron accelerator for a one-chord keybinding, or undefined when Electron cannot show it (chords, Pause, the
 * context-menu key). Menus only display it: main never registers command accelerators.
 */
export function toAccelerator(chords: readonly string[], platform: Platform): string | undefined {
  if (chords.length !== 1) return undefined
  const { modifiers: pressed, key } = splitChord(chords[0])
  const name = acceleratorKeys[key] ?? (characterKeys.includes(key) || functionKeys.includes(key) ? key.toUpperCase() : undefined)
  if (!name) return undefined
  const order: [Modifier, string][] = platform === 'darwin'
    ? [['meta', 'Cmd'], ['ctrl', 'Ctrl'], ['alt', 'Alt'], ['shift', 'Shift']]
    : [['ctrl', 'Ctrl'], ['shift', 'Shift'], ['alt', 'Alt'], ['meta', 'Super']]
  return [...order.filter(([modifier]) => pressed.has(modifier)).map(([, label]) => label), name].join('+')
}

/** A keybinding resolved for one platform. Native rules are never dispatched by the workbench. */
export interface ResolvedRule {
  readonly command: CommandId
  readonly chords: readonly string[]
  readonly when?: WhenAst
  readonly whenSource?: string
  readonly native: boolean
  readonly allowRepeat: boolean
}

/** The spec string that applies on `platform`, or undefined when the keybinding is unbound there. */
export function specForPlatform(spec: KeybindingSpec, platform: Platform): string | undefined {
  const override = platform === 'win32' ? spec.win : platform === 'darwin' ? spec.mac : spec.linux
  return override === null ? undefined : override ?? spec.key
}

/** Resolves one catalogue keybinding; two-part chords are only allowed on native rules until the workbench has chords. */
export function resolveKeybinding(command: CommandId, spec: KeybindingSpec, platform: Platform): ResolvedRule | undefined {
  const source = specForPlatform(spec, platform)
  if (source === undefined) return undefined
  const chords = parseKeySpec(source, platform)
  if (chords.length > 1 && !spec.native) throw new KeySpecError(`${command}: "${source}" has two parts; only native keybindings may be chords.`)
  return {
    command, chords, native: spec.native === true, allowRepeat: spec.allowRepeat === true,
    ...(spec.when === undefined ? {} : { when: compileWhen(spec.when), whenSource: spec.when })
  }
}

const rulesByPlatform = new Map<Platform, readonly ResolvedRule[]>()
/** Every catalogue keybinding bound on `platform`, in catalogue order. */
export function defaultRules(platform: Platform): readonly ResolvedRule[] {
  let rules = rulesByPlatform.get(platform)
  if (!rules) {
    rules = Object.freeze(commandIds.flatMap(id => (commandDescriptor(id).keybindings ?? []).flatMap(spec => resolveKeybinding(id, spec, platform) ?? [])))
    rulesByPlatform.set(platform, rules)
  }
  return rules
}

/** The first one-chord rule for `id` on `platform`, workbench or native: the one labels and accelerators show. */
export const primaryRule = (id: CommandId, platform: Platform): ResolvedRule | undefined =>
  defaultRules(platform).find(rule => rule.command === id && rule.chords.length === 1)

/** First chords of native two-part rules: the workbench must let the key after them through to Monaco. */
export const nativeChordPrefixes = (platform: Platform): ReadonlySet<string> =>
  new Set(defaultRules(platform).filter(rule => rule.native && rule.chords.length > 1).map(rule => rule.chords[0]))

/** Workbench (non-native) one-chord rules by chord, each list in catalogue order: the dispatcher's lookup table. */
export function workbenchRules(rules: readonly ResolvedRule[]): ReadonlyMap<string, readonly ResolvedRule[]> {
  const table = new Map<string, ResolvedRule[]>()
  for (const rule of rules) {
    if (rule.native || rule.chords.length !== 1) continue
    const list = table.get(rule.chords[0])
    if (list) list.push(rule)
    else table.set(rule.chords[0], [rule])
  }
  return table
}

const mnemonics = ['alt+f', 'alt+e', 'alt+v', 'alt+q', 'alt+w']
const reserve = (reason: string, chords: string[]) => chords.map(chord => [chord, reason] as const)
const windowsAndLinux = [
  ...reserve('opens a menu', [...mnemonics, 'f10']),
  ...reserve('an Electron role or system key', ['ctrl+r', 'ctrl+shift+i', 'ctrl+0', 'ctrl+=', 'ctrl+shift+=', 'ctrl+-', 'f11', 'alt+f4', 'shift+f10', 'contextmenu']),
  ...reserve('clipboard or text editing', ['ctrl+c', 'ctrl+x', 'ctrl+v', 'ctrl+a', 'ctrl+insert', 'shift+insert', 'shift+delete', 'ctrl+z', 'ctrl+y', 'ctrl+shift+z',
    ...['left', 'right', 'backspace', 'delete'].flatMap(key => [`ctrl+${key}`, `ctrl+shift+${key}`])]),
  ...reserve('find or comment in the editor', ['ctrl+f', 'ctrl+h', 'f3', 'shift+f3', 'ctrl+f3', 'ctrl+shift+f3', 'alt+enter', 'ctrl+alt+enter', 'ctrl+shift+1',
    'alt+c', 'alt+w', 'alt+r', 'alt+p', 'alt+l', 'ctrl+/', 'shift+alt+a', 'ctrl+shift+\\']),
  ...reserve("the editor's chord prefix", ['ctrl+k']),
  ...reserve('moves focus or closes a widget', ['tab', 'shift+tab', 'escape', 'alt+pageup', 'alt+pagedown'])
]
// A chord listed twice (Alt+W opens the Window menu and toggles whole-word search) keeps its first reason.
const reasons = (entries: readonly (readonly [string, string])[]) => {
  const map = new Map<string, string>()
  for (const [chord, reason] of entries) if (!map.has(chord)) map.set(chord, reason)
  return map
}
const reservedByPlatform: Readonly<Record<Platform, ReadonlyMap<string, string>>> = {
  win32: reasons(windowsAndLinux),
  // Electron's quit role registers Ctrl+Q except on Windows, and Monaco binds Ctrl+Shift+A to block comments on Linux.
  linux: reasons([...windowsAndLinux, ...reserve('an Electron role or system key', ['ctrl+q']), ...reserve('find or comment in the editor', ['ctrl+shift+a'])]),
  darwin: reasons([
    ...reserve('a macOS system key', ['meta+q', 'meta+h', 'alt+meta+h', 'meta+m', 'meta+`']),
    ...reserve('an Electron role', ['ctrl+meta+f', 'alt+meta+i', 'meta+r', 'meta+0', 'meta+=', 'shift+meta+=', 'meta+-']),
    ...reserve('clipboard or undo', ['meta+c', 'meta+x', 'meta+v', 'meta+a', 'meta+z', 'shift+meta+z']),
    ...reserve('find or comment in the editor', ['meta+f', 'alt+meta+f', 'meta+g', 'shift+meta+g', 'meta+e', 'meta+/', ...[...'cwrpl'].map(key => `alt+meta+${key}`)]),
    ...reserve("the editor's chord prefix", ['meta+k']),
    ...reserve('an emacs editing key', [...'abdefhknopt'].map(key => `ctrl+${key}`))
  ])
}

/** Chords listed as never available to workbench keybindings on `platform`, with the reason. */
export const reservedChords = (platform: Platform): ReadonlyMap<string, string> => reservedByPlatform[platform]

/** Why a workbench keybinding may not use `chord` on `platform`, or undefined when it may. */
export function reservedReason(chord: string, platform: Platform): string | undefined {
  const listed = reservedByPlatform[platform].get(chord)
  if (listed) return listed
  const { modifiers: pressed, key } = splitChord(chord)
  if (platform !== 'darwin' && pressed.has('ctrl') && pressed.has('alt') && !pressed.has('meta') && /^[a-z]$/.test(key)) return 'AltGr types characters with Ctrl+Alt'
  if (platform === 'darwin' && pressed.has('alt') && !pressed.has('ctrl') && !pressed.has('meta') && (characterKeys.includes(key) || key === 'space')) return '⌥ types characters on macOS'
  return undefined
}
