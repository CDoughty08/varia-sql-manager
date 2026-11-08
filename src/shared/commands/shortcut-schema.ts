import { z } from 'zod'
import { isCommandId, type CommandId } from './catalog'
import { KeySpecError, parseKeySpec, platforms, type Platform } from './keybindings'
import { scopeIds, type ScopeId } from './scopes'
import { boundedRecord } from '../zod-bounds'

/**
 * The user's shortcuts file, `<userData>/shortcuts.json`, which only main reads and writes. Bindings are additions and
 * removals over the catalogue and the scheme (`effectiveRules`). Records this build does not understand (a command,
 * scope, member, key or gesture it does not know) move to `unknown` and are written back verbatim, so a downgrade or a
 * file from a newer build loses nothing.
 */
export const shortcutLimits = {
  /** The file's size in UTF-8 bytes. */
  fileBytes: 128 * 1024,
  bindings: 1024,
  key: 64,
  command: 128,
  scheme: 32,
  gestures: 64,
  gestureId: 64,
  gestureChoice: 32,
  unknown: 256,
  /** One unknown record's size as JSON, in UTF-8 bytes. */
  unknownBytes: 1024
} as const

export const shortcutFileVersion = 1

export interface ShortcutBinding {
  readonly command: CommandId
  /** A key spec as `parseKeySpec` reads it, with the platform-neutral `mod` where recording wrote one. */
  readonly key: string
  /** Additions only; absent is Global. */
  readonly scope?: ScopeId
  /** Removes the catalogue or scheme binding of `command` to `key` instead of adding one. */
  readonly remove?: true
  /** Applies only on this platform; entries for another platform are kept and not applied. */
  readonly platform?: Platform
}
export interface ShortcutFile {
  readonly version: typeof shortcutFileVersion
  readonly scheme: string
  readonly bindings: readonly ShortcutBinding[]
  readonly gestures: Readonly<Record<string, string>>
  readonly unknown: readonly unknown[]
}
export const emptyShortcutFile: ShortcutFile = Object.freeze({ version: shortcutFileVersion, scheme: 'default', bindings: Object.freeze([]), gestures: Object.freeze({}), unknown: Object.freeze([]) })

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length
const jsonBytes = (value: unknown) => { try { return utf8Bytes(JSON.stringify(value) ?? '') } catch { return Infinity } }
/** Every key spec in a binding must parse on every platform, so a file moves between machines unchanged. */
const keyParses = (key: string) => platforms.every(platform => { try { parseKeySpec(key, platform); return true } catch (error) { if (error instanceof KeySpecError) return false; throw error } })

const keySchema = z.string().min(1).max(shortcutLimits.key).refine(keyParses, 'not a key this build knows')
const bindingFields = {
  command: z.string().max(shortcutLimits.command).refine(isCommandId, 'not a command this build knows'),
  key: keySchema,
  platform: z.enum(platforms).optional()
}
const additionSchema = z.strictObject({ ...bindingFields, scope: z.enum(scopeIds).optional() })
const removalSchema = z.strictObject({ ...bindingFields, remove: z.literal(true) })
export const shortcutBindingSchema = z.union([additionSchema, removalSchema])
const gestureIdPattern = new RegExp(`^[a-z][A-Za-z0-9.]{0,${shortcutLimits.gestureId - 1}}$`)
/** `Object.prototype`'s names (`constructor`, `toString`, ...) are refused too, so no `in` or `obj.hasOwnProperty` check ever mistakes one for a gesture. */
const prototypeNames: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype))
const isGestureIdText = (id: string) => gestureIdPattern.test(id) && !prototypeNames.has(id)
const gestureChoicePattern = new RegExp(`^[a-z][A-Za-z0-9]{0,${shortcutLimits.gestureChoice - 1}}$`)
const unknownRecordSchema = z.custom<unknown>(value => value !== undefined && jsonBytes(value) <= shortcutLimits.unknownBytes, `an unknown record is limited to ${shortcutLimits.unknownBytes} bytes`)

/** The file as this build writes it: strict, with every limit. */
export const shortcutFileSchema = z.strictObject({
  version: z.literal(shortcutFileVersion),
  scheme: z.string().regex(/^[a-z][A-Za-z0-9]*$/).max(shortcutLimits.scheme),
  bindings: z.array(shortcutBindingSchema).max(shortcutLimits.bindings),
  gestures: boundedRecord(z.record(z.string().regex(gestureIdPattern).refine(isGestureIdText, 'not a gesture id'), z.string().regex(gestureChoicePattern)), shortcutLimits.gestures, `at most ${shortcutLimits.gestures} gestures`),
  unknown: z.array(unknownRecordSchema).max(shortcutLimits.unknown)
})

export type ShortcutReadResult =
  | { readonly ok: true; readonly file: ShortcutFile; readonly problems: readonly string[] }
  /** `newer`: a later version, which this build must leave alone; `invalid`: not a shortcuts file; `size`: too large. */
  | { readonly ok: false; readonly error: 'invalid' | 'newer' | 'size' }

export interface ShortcutReadOptions {
  /** The gesture catalogue's ids and their choices; without it every well-formed gesture is kept as is. */
  readonly gestures?: ReadonlyMap<string, readonly string[]>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/** A binding this build cannot apply but a later one might: right shape and size, unknown content. */
function isForeignBinding(value: Record<string, unknown>): boolean {
  return typeof value.command === 'string' && value.command.length <= shortcutLimits.command && typeof value.key === 'string' && value.key.length >= 1 &&
    value.key.length <= shortcutLimits.key && (value.scope === undefined || typeof value.scope === 'string') && (value.platform === undefined || typeof value.platform === 'string')
}

/**
 * Reads a parsed shortcuts file, entry by entry: valid entries are kept, records this build does not understand move
 * to `unknown`, and malformed ones are dropped and reported in `problems` (fixed wording, never file content), so main
 * can salvage a damaged file. The whole file fails only when it is not an object, is a later version, or breaks a limit
 * on its size. Never throws.
 */
export function readShortcutFile(raw: unknown, options: ShortcutReadOptions = {}): ShortcutReadResult {
  if (!isRecord(raw)) return { ok: false, error: 'invalid' }
  if (typeof raw.version === 'number' && raw.version > shortcutFileVersion) return { ok: false, error: 'newer' }
  if (raw.version !== shortcutFileVersion) return { ok: false, error: 'invalid' }
  const problems: string[] = []
  const unknown: unknown[] = []
  /** Records this read moved to `unknown` (not those the file already kept there), by their index in `unknown`. */
  const moved: { index: number; what: string }[] = []
  const keepUnknown = (value: unknown, what: string, move = true): boolean => {
    if (unknown.length >= shortcutLimits.unknown) { problems.push(`${what} was dropped: the file keeps at most ${shortcutLimits.unknown} unknown records.`); return false }
    if (!unknownRecordSchema.safeParse(value).success) { problems.push(`${what} was dropped: an unknown record is limited to ${shortcutLimits.unknownBytes} bytes.`); return false }
    if (move) moved.push({ index: unknown.length, what })
    unknown.push(value)
    return true
  }
  // An earlier or older build kept these for a build that understands them: a binding that now parses and a gesture choice
  // now offered go back where they belong (after the file's own entries, in their order), so a downgrade and an upgrade
  // lose nothing. The rest stay verbatim.
  const restoredBindings: ShortcutBinding[] = []
  const restoredGestures: [string, string][] = []
  if (Array.isArray(raw.unknown)) raw.unknown.forEach((value, index) => {
    const binding = isRecord(value) ? shortcutBindingSchema.safeParse(value) : undefined
    if (binding?.success) { restoredBindings.push(binding.data as ShortcutBinding); return }
    if (options.gestures && isRecord(value) && Object.keys(value).length === 2 && typeof value.gesture === 'string' && typeof value.choice === 'string' &&
      isGestureIdText(value.gesture) && options.gestures.get(value.gesture)?.includes(value.choice)) { restoredGestures.push([value.gesture, value.choice]); return }
    keepUnknown(value, `Unknown record ${index + 1}`, false)
  })
  else if (raw.unknown !== undefined) problems.push('The unknown records were dropped: they were not a list.')

  let scheme = 'default'
  if (raw.scheme !== undefined) {
    if (shortcutFileSchema.shape.scheme.safeParse(raw.scheme).success) scheme = raw.scheme as string
    else problems.push('The scheme was reset to the default: it was not a scheme name.')
  }

  const bindings: ShortcutBinding[] = []
  if (Array.isArray(raw.bindings)) raw.bindings.forEach((value, index) => {
    const what = `Shortcut ${index + 1}`
    const parsed = shortcutBindingSchema.safeParse(value)
    if (parsed.success) {
      if (bindings.length < shortcutLimits.bindings) bindings.push(parsed.data as ShortcutBinding)
      else problems.push(`${what} was dropped: the file keeps at most ${shortcutLimits.bindings} shortcuts.`)
    } else if (isRecord(value) && isForeignBinding(value)) keepUnknown(value, what)
    else problems.push(`${what} was dropped: it is not a shortcut.`)
  })
  else if (raw.bindings !== undefined) problems.push('The shortcuts were dropped: they were not a list.')
  restoredBindings.forEach((binding, index) => {
    if (bindings.length < shortcutLimits.bindings) bindings.push(binding)
    else problems.push(`Restored shortcut ${index + 1} was dropped: the file keeps at most ${shortcutLimits.bindings} shortcuts.`)
  })

  const gestures: Record<string, string> = Object.create(null)
  if (isRecord(raw.gestures)) Object.entries(raw.gestures).forEach(([id, choice], index) => {
    const what = `Gesture ${index + 1}`
    if (!isGestureIdText(id) || typeof choice !== 'string' || !gestureChoicePattern.test(choice)) { problems.push(`${what} was dropped: it is not a gesture setting.`); return }
    const choices = options.gestures?.get(id)
    // A choice this build does not offer moves to `unknown`; when that is full it stays here, where no view applies it.
    if (options.gestures && !choices?.includes(choice) && unknown.length < shortcutLimits.unknown) keepUnknown({ gesture: id, choice }, what)
    else if (Object.keys(gestures).length >= shortcutLimits.gestures) problems.push(`${what} was dropped: the file keeps at most ${shortcutLimits.gestures} gestures.`)
    else gestures[id] = choice
  })
  else if (raw.gestures !== undefined) problems.push('The gesture settings were dropped: they were not an object.')
  // The file's own setting wins over one kept for later.
  restoredGestures.forEach(([id, choice], index) => {
    if (Object.hasOwn(gestures, id)) return
    if (Object.keys(gestures).length < shortcutLimits.gestures) gestures[id] = choice
    else problems.push(`Restored gesture ${index + 1} was dropped: the file keeps at most ${shortcutLimits.gestures} gestures.`)
  })

  for (const key of Object.keys(raw)) if (!['version', 'scheme', 'bindings', 'gestures', 'unknown'].includes(key)) keepUnknown({ [key]: raw[key] }, 'A member this build does not know')
  let file: ShortcutFile = { version: shortcutFileVersion, scheme, bindings, gestures: { ...gestures }, unknown }
  // Moving records to `unknown` wraps each in a few bytes, so a file just under the limit can come out over it: a file that
  // loads must also save. The records this read moved go first, last moved first, so the file's own entries stay.
  while (!shortcutFileFits(file) && moved.length) {
    const { index, what } = moved.pop()!
    problems.push(`${what} was dropped: keeping it would make the file larger than ${shortcutLimits.fileBytes / 1024} KiB.`)
    file = { ...file, unknown: file.unknown.filter((_, at) => at !== index) }
  }
  if (!shortcutFileFits(file)) return { ok: false, error: 'size' }
  return { ok: true, file, problems }
}

/**
 * The file's text as main writes it, or undefined when it is over `shortcutLimits.fileBytes`. It is indented for hand
 * edits when that fits and compact when only that fits, so the limit measures the same form on read (the raw bytes) and
 * on write: a compact file near the limit that loads can also be saved.
 */
export function shortcutFileText(file: ShortcutFile): string | undefined {
  const form = shortcutFileForm(file)
  // No newline after the compact form: a hand-written file at the limit may end without one.
  return form === 'pretty' ? JSON.stringify(file, null, 2) + '\n' : form === 'compact' ? JSON.stringify(file) : undefined
}
/** Whether `shortcutFileText` has a form that fits, without building it. */
const shortcutFileFits = (file: ShortcutFile): boolean => shortcutFileForm(file) !== undefined
/**
 * Which form fits. The compact text is about the size of what was read; the indented size is counted by walking the
 * value with an early stop, since indentation grows with depth (a deeply nested unknown record under its 1 KiB limit
 * indents to half a megabyte) and building that text on every read would stall main.
 */
function shortcutFileForm(file: ShortcutFile): 'pretty' | 'compact' | undefined {
  const compact = utf8Bytes(JSON.stringify(file))
  if (compact > shortcutLimits.fileBytes) return undefined
  return prettyBytesWithin(file, shortcutLimits.fileBytes) ? 'pretty' : 'compact'
}
/** Whether `JSON.stringify(value, null, 2)` is at most `limit` UTF-8 bytes, for plain JSON values; stops once over. */
function prettyBytesWithin(value: unknown, limit: number): boolean {
  let total = 0
  const add = (bytes: number) => (total += bytes) <= limit
  const walk = (node: unknown, depth: number): boolean => {
    if (Array.isArray(node)) {
      if (!node.length) return add(2)
      if (!add(4 + 2 * depth)) return false // "[\n" (2), then "\n" + indent + "]" (2 + 2 * depth)
      for (let index = 0; index < node.length; index++) {
        const item = node[index]
        if (!add(2 * (depth + 1) + (index ? 2 : 0))) return false // indent, and ",\n" before every item but the first
        if (!walk(item === undefined || typeof item === 'function' || typeof item === 'symbol' ? null : item, depth + 1)) return false
      }
      return true
    }
    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node).filter(([, item]) => item !== undefined && typeof item !== 'function' && typeof item !== 'symbol')
      if (!entries.length) return add(2)
      if (!add(4 + 2 * depth)) return false
      for (let index = 0; index < entries.length; index++) {
        const [key, item] = entries[index]
        if (!add(2 * (depth + 1) + (index ? 2 : 0) + utf8Bytes(JSON.stringify(key)) + 2)) return false // indent, key and ": "
        if (!walk(item, depth + 1)) return false
      }
      return true
    }
    return add(utf8Bytes(JSON.stringify(node) ?? 'null'))
  }
  // The text ends with a newline.
  return walk(value, 0) && add(1)
}

/** Parses and reads the file's text: `size` when it is over `shortcutLimits.fileBytes`, `invalid` when it is not JSON. */
export function parseShortcutText(text: string, options: ShortcutReadOptions = {}): ShortcutReadResult {
  if (text.length > shortcutLimits.fileBytes || utf8Bytes(text) > shortcutLimits.fileBytes) return { ok: false, error: 'size' }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { ok: false, error: 'invalid' } }
  return readShortcutFile(raw, options)
}

/** Whether `binding` applies on `platform`. */
export const bindingApplies = (binding: Pick<ShortcutBinding, 'platform'>, platform: Platform): boolean => binding.platform === undefined || binding.platform === platform
