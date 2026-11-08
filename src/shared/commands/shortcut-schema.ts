import { z } from 'zod'
import { isCommandId, type CommandId } from './catalog'
import { KeySpecError, parseKeySpec, platforms, type Platform } from './keybindings'
import { scopeIds, type ScopeId } from './scopes'

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
  gestures: z.record(z.string().regex(gestureIdPattern).refine(isGestureIdText, 'not a gesture id'), z.string().regex(gestureChoicePattern)).refine(value => Object.keys(value).length <= shortcutLimits.gestures, `at most ${shortcutLimits.gestures} gestures`),
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
  const keepUnknown = (value: unknown, what: string) => {
    if (unknown.length >= shortcutLimits.unknown) problems.push(`${what} was dropped: the file keeps at most ${shortcutLimits.unknown} unknown records.`)
    else if (!unknownRecordSchema.safeParse(value).success) problems.push(`${what} was dropped: an unknown record is limited to ${shortcutLimits.unknownBytes} bytes.`)
    else unknown.push(value)
  }
  if (Array.isArray(raw.unknown)) raw.unknown.forEach((value, index) => keepUnknown(value, `Unknown record ${index + 1}`))
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

  const gestures: Record<string, string> = Object.create(null)
  if (isRecord(raw.gestures)) Object.entries(raw.gestures).forEach(([id, choice], index) => {
    const what = `Gesture ${index + 1}`
    if (!isGestureIdText(id) || typeof choice !== 'string' || !gestureChoicePattern.test(choice)) { problems.push(`${what} was dropped: it is not a gesture setting.`); return }
    const choices = options.gestures?.get(id)
    if (options.gestures && !choices?.includes(choice)) keepUnknown({ gesture: id, choice }, what)
    else if (Object.keys(gestures).length >= shortcutLimits.gestures) problems.push(`${what} was dropped: the file keeps at most ${shortcutLimits.gestures} gestures.`)
    else gestures[id] = choice
  })
  else if (raw.gestures !== undefined) problems.push('The gesture settings were dropped: they were not an object.')

  for (const key of Object.keys(raw)) if (!['version', 'scheme', 'bindings', 'gestures', 'unknown'].includes(key)) keepUnknown({ [key]: raw[key] }, 'A member this build does not know')
  const file: ShortcutFile = { version: shortcutFileVersion, scheme, bindings, gestures: { ...gestures }, unknown }
  // Moving records to `unknown` can make the file a little larger than the text it came from: a file that loads must also save.
  if (shortcutFileText(file) === undefined) return { ok: false, error: 'size' }
  return { ok: true, file, problems }
}

/**
 * The file's text as main writes it, or undefined when it is over `shortcutLimits.fileBytes`. It is indented for hand
 * edits when that fits and compact when only that fits, so the limit measures the same form on read (the raw bytes) and
 * on write: a compact file near the limit that loads can also be saved.
 */
export function shortcutFileText(file: ShortcutFile): string | undefined {
  const pretty = JSON.stringify(file, null, 2) + '\n'
  if (utf8Bytes(pretty) <= shortcutLimits.fileBytes) return pretty
  // No newline here: a hand-written file at the limit may end without one.
  const compact = JSON.stringify(file)
  return utf8Bytes(compact) <= shortcutLimits.fileBytes ? compact : undefined
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
