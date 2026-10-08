import { z } from 'zod'
import { colorKeyAliases, colorKeys, isColorKey, isSqlScope, scopeAliases, type ColorKey, type SqlScope } from './registry'
import type { ParsedTheme, ThemeFileType, ThemeParseResult, ThemePreference, ThemeProblem, ThemeProblemCode, ThemeRule, ThemeType, ThemeValue } from './types'

export const themeKind = 'varia-color-theme'
export const themeFormatVersion = 1
export const themeLimits = {
  fileBytes: 128 * 1024, depth: 8, nodes: 20_000, palette: 128, colors: 1024, tokenRules: 256, scopesPerRule: 32, scopeLength: 128,
  valueLength: 40, colorKeyLength: 64, name: 64, description: 512, author: 128, schema: 256, ruleName: 64, hops: 4, files: 64,
  problemsPerFile: 50, problemsTotal: 200, message: 300, quoted: 40, jsonReason: 120, appearanceBytes: 4096, contrastSteps: 20
} as const
/** Anchored, linear patterns; the JSON Schema uses the same sources (tests compare them). */
export const themePatterns = {
  hex: '^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$',
  ref: '^\\$[a-z][A-Za-z0-9]{0,31}(/(100|[1-9]?[0-9]))?$',
  slot: '^[a-z][A-Za-z0-9]{0,31}$',
  colorKey: '^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*){0,3}$',
  fontStyle: '^((italic|bold|underline|strikethrough)( (italic|bold|underline|strikethrough)){0,3})?$',
  themeId: '^[a-z0-9][a-z0-9_-]{0,47}$',
  themeFileName: '^[A-Za-z0-9][A-Za-z0-9_-]{0,47}\\.json$'
} as const
const patterns = Object.fromEntries(Object.entries(themePatterns).map(([name, source]) => [name, new RegExp(source)])) as Record<keyof typeof themePatterns, RegExp>
const deniedKeys = new Set(['constructor', 'prototype'])
const topLevelFields = new Set(['$schema', 'kind', 'version', 'name', 'description', 'author', 'type', 'palette', 'colors', 'tokenColors'])

// Controls, format characters (bidi controls, zero-width characters, tags) and every other default-ignorable code point
// such as variation selectors and Hangul fillers: all invisible, so a name could otherwise pose as another one.
const unsafeCharacters = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu
const hasUnsafeCharacters = (value: string) => { unsafeCharacters.lastIndex = 0; return unsafeCharacters.test(value) }
const codePoints = (value: string) => [...value].length
const clipCodePoints = (value: string, max: number) => codePoints(value) <= max ? value : [...value].slice(0, max).join('')

/** Removes control, bidi, zero-width and other invisible characters, trims, and caps the length in code points. */
export function sanitizeLabel(value: string, max: number): string {
  return clipCodePoints(value.replace(unsafeCharacters, '').trim(), max)
}

/** User text inside a problem message: at most 40 characters, with control and bidi characters escaped. */
export function quote(value: unknown): string {
  if (typeof value !== 'string') return Array.isArray(value) ? 'an array' : value === null ? 'null' : typeof value === 'object' ? 'an object' : String(value)
  const clipped = codePoints(value) > themeLimits.quoted ? clipCodePoints(value, themeLimits.quoted - 1) + '…' : value
  return '`' + clipped.replace(unsafeCharacters, character => '\\u{' + character.codePointAt(0)!.toString(16) + '}') + '`'
}

/** One escaped RFC 6901 segment; untrusted segments are shortened for display. */
export function pointerSegment(value: string | number): string {
  const text = String(value)
  const shown = codePoints(text) > themeLimits.quoted ? clipCodePoints(text, themeLimits.quoted - 1) + '…' : text
  return shown.replace(unsafeCharacters, character => '\\u{' + character.codePointAt(0)!.toString(16) + '}').replaceAll('~', '~0').replaceAll('/', '~1')
}
const pointer = (...segments: (string | number)[]) => segments.map(segment => '/' + pointerSegment(segment)).join('')

const baseName = (fileName: string) => fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1)

export function createProblem(code: ThemeProblemCode, file: string, path: string, message: string): ThemeProblem {
  return { severity: code.startsWith('E_') ? 'error' : 'warning', code, file: sanitizeLabel(baseName(file), 64), path, message: message.slice(0, themeLimits.message) }
}

/** Removes duplicates (a dual theme is resolved twice), puts errors first, and keeps at most `max`. */
export function limitProblems(problems: readonly ThemeProblem[], max: number): { problems: ThemeProblem[]; omitted: number } {
  const seen = new Set<string>(), unique: ThemeProblem[] = []
  for (const problem of problems) {
    const identity = JSON.stringify([problem.code, problem.file, problem.path, problem.message])
    if (!seen.has(identity)) { seen.add(identity); unique.push(problem) }
  }
  const ordered = [...unique.filter(problem => problem.severity === 'error'), ...unique.filter(problem => problem.severity === 'warning')]
  return { problems: ordered.slice(0, max), omitted: Math.max(0, ordered.length - max) }
}

class Problems {
  private list: ThemeProblem[] = []
  private dropped = 0
  constructor(private file: string) {}
  add(code: ThemeProblemCode, path: string, message: string) {
    // Errors are few and all come first; warnings past a small multiple of the cap are only counted, so a file built to
    // produce thousands of them costs no more than one that produces the cap.
    if (code.startsWith('W_') && this.list.length >= themeLimits.problemsPerFile * 2) { this.dropped++; return }
    this.list.push(createProblem(code, this.file, path, message))
  }
  get hasErrors() { return this.list.some(problem => problem.severity === 'error') }
  result(theme: ParsedTheme | null): ThemeParseResult {
    const { problems, omitted } = limitProblems(this.list, themeLimits.problemsPerFile)
    return { theme, problems, problemsOmitted: omitted + this.dropped }
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
const own = (value: Record<string, unknown>, key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined

/** True for a single color: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `$slot`, or `$slot/pct`. Length is checked before any pattern. */
export function isColorText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= themeLimits.valueLength && (patterns.hex.test(value) || patterns.ref.test(value))
}

export type ValueResult = { ok: true; value: ThemeValue } | { ok: false; code: 'W_VALUE' | 'W_VARIANT_NOT_DUAL'; message: string }
const colorHint = 'Expected a color such as "#1e1e1e", "#1e1e1e80", "$accent", or "$accent/20"'
/** The A5 value grammar: a color, or a `{dark, light}` object when the theme is dual. */
export function parseThemeValue(raw: unknown, type: ThemeFileType): ValueResult {
  if (isColorText(raw)) return { ok: true, value: raw }
  if (!isPlainObject(raw)) return { ok: false, code: 'W_VALUE', message: `${colorHint}; got ${quote(raw)}.` }
  if (type !== 'dual') return { ok: false, code: 'W_VARIANT_NOT_DUAL', message: '{"dark", "light"} values are allowed only when "type" is "dual"; the default is used.' }
  const keys = Object.keys(raw)
  if (!keys.length || keys.some(key => key !== 'dark' && key !== 'light')) return { ok: false, code: 'W_VALUE', message: 'A variant value is an object with "dark", "light", or both, and no other fields.' }
  const value: { dark?: string; light?: string } = {}
  for (const key of keys as ('dark' | 'light')[]) {
    const color = raw[key]
    if (!isColorText(color)) return { ok: false, code: 'W_VALUE', message: `${colorHint} for "${key}"; got ${quote(color)}.` }
    value[key] = color
  }
  return { ok: true, value }
}

export function isFontStyle(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !patterns.fontStyle.test(value)) return false
  const words = value ? value.split(' ') : []
  return new Set(words).size === words.length
}

/** The theme id for a file name, or undefined when the name breaks the A1 grammar. */
export function themeIdFromFileName(fileName: string): string | undefined {
  return patterns.themeFileName.test(fileName) ? fileName.slice(0, -'.json'.length).toLowerCase() : undefined
}
export const isReservedThemeId = (id: string) => id.startsWith('varia-')

function tooComplex(value: unknown): boolean {
  const stack: [unknown, number][] = [[value, 1]]
  let nodes = 0
  while (stack.length) {
    const [item, depth] = stack.pop()!
    if (++nodes > themeLimits.nodes) return true
    if (typeof item !== 'object' || item === null) continue
    if (depth > themeLimits.depth) return true
    const children = Array.isArray(item) ? item : Object.keys(item).map(key => (item as Record<string, unknown>)[key])
    for (const child of children) stack.push([child, depth + 1])
  }
  return false
}

// Banded Levenshtein: only distances up to `limit` matter, so each row looks at 2 * limit + 1 cells. Keys are at most
// 64 characters, so two fixed rows serve every comparison.
const rows = [new Int32Array(themeLimits.colorKeyLength + 1), new Int32Array(themeLimits.colorKeyLength + 1)]
function withinDistance(a: string, b: string, limit: number): number | undefined {
  if (Math.abs(a.length - b.length) > limit || b.length > themeLimits.colorKeyLength) return undefined
  let [previous, current] = rows
  for (let j = 0; j <= b.length; j++) previous[j] = j
  for (let i = 1; i <= a.length; i++) {
    current.fill(limit + 1, 0, b.length + 1)
    current[0] = i
    let best = i
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1))
      best = Math.min(best, current[j])
    }
    if (best > limit) return undefined
    const done = previous; previous = current; current = done
  }
  return previous[b.length] <= limit ? previous[b.length] : undefined
}
const lowerColorKeys = colorKeys.map(key => [key, key.toLowerCase()] as const)
/** Unknown keys looked at for a "did you mean"; the rest of a pasted VS Code block only counts toward the summary. */
const suggestionAttempts = 64
function suggestKey(key: string): ColorKey | undefined {
  const lower = key.toLowerCase()
  let best: ColorKey | undefined, bestDistance = 3
  for (const [candidate, candidateLower] of lowerColorKeys) {
    const distance = withinDistance(lower, candidateLower, 2)
    if (distance !== undefined && distance < bestDistance) { best = candidate; bestDistance = distance }
  }
  return best
}

/**
 * Validates a parsed JSON value as a theme file (pure; never throws for content problems). Errors make the theme
 * unusable; warnings drop the offending entry so its default applies.
 */
export function parseThemeFile(json: unknown, fileName: string): ThemeParseResult {
  const file = baseName(fileName), problems = new Problems(file)
  const id = themeIdFromFileName(file)
  if (id === undefined) { problems.add('E_FILE_NAME', '', 'Theme file names are 1-48 letters, digits, "-" or "_", ending in ".json".'); return problems.result(null) }
  if (isReservedThemeId(id)) { problems.add('E_RESERVED', '', 'Theme ids starting with "varia-" are reserved for the built-in themes.'); return problems.result(null) }
  if (tooComplex(json)) { problems.add('E_COMPLEX', '', `The file is nested more than ${themeLimits.depth} levels deep or has more than ${themeLimits.nodes} values.`); return problems.result(null) }
  if (!isPlainObject(json)) { problems.add('E_NOT_OBJECT', '', 'A theme file contains one JSON object.'); return problems.result(null) }

  const kind = own(json, 'kind')
  if (kind === undefined) problems.add('E_KIND', '/kind', Object.hasOwn(json, 'colors') || Object.hasOwn(json, 'tokenColors')
    ? '"kind" is missing. This looks like a VS Code color theme; VS Code themes cannot be loaded yet.'
    : `"kind" is missing; it must be "${themeKind}".`)
  else if (kind !== themeKind) problems.add('E_KIND', '/kind', `"kind" must be "${themeKind}".`)
  const version = own(json, 'version')
  if (Number.isInteger(version) && (version as number) > themeFormatVersion) problems.add('E_VERSION', '/version', `This theme needs a newer Varia (theme format ${version}).`)
  else if (version !== themeFormatVersion) problems.add('E_VERSION', '/version', `"version" must be ${themeFormatVersion}.`)
  const rawType = own(json, 'type')
  const type = rawType === 'dark' || rawType === 'light' || rawType === 'dual' ? rawType : undefined
  if (!type) problems.add('E_FIELD', '/type', '"type" must be "dark", "light", or "dual".')
  const rawName = own(json, 'name')
  let name = ''
  if (typeof rawName !== 'string') problems.add('E_FIELD', '/name', '"name" must be a string.')
  else {
    name = sanitizeLabel(rawName, Infinity)
    if (codePoints(name) > themeLimits.name) problems.add('E_FIELD', '/name', `"name" must be at most ${themeLimits.name} characters.`)
  }
  const sections = { palette: own(json, 'palette'), colors: own(json, 'colors'), tokenColors: own(json, 'tokenColors') }
  const limits = { palette: themeLimits.palette, colors: themeLimits.colors, tokenColors: themeLimits.tokenRules }
  for (const section of ['palette', 'colors', 'tokenColors'] as const) {
    const value = sections[section]
    if (value === undefined) continue
    const isArray = section === 'tokenColors'
    if (isArray ? !Array.isArray(value) : !isPlainObject(value)) { problems.add('E_FIELD', '/' + section, `"${section}" must be ${isArray ? 'an array' : 'an object'}.`); continue }
    const count = isArray ? (value as unknown[]).length : Object.keys(value as object).length
    if (count > limits[section]) problems.add('E_LIMIT', '/' + section, `"${section}" has ${count} entries; the limit is ${limits[section]}.`)
  }
  if (problems.hasErrors || !type || typeof rawName !== 'string') return problems.result(null)

  for (const key of Object.keys(json)) if (!topLevelFields.has(key)) problems.add('W_FIELD', pointer(key), `Unknown field ${quote(key)} ignored.`)
  const schema = own(json, '$schema')
  if (schema !== undefined && (typeof schema !== 'string' || schema.length > themeLimits.schema)) problems.add('W_FIELD', '/$schema', `"$schema" must be a string of at most ${themeLimits.schema} characters; ignored.`)
  if (hasUnsafeCharacters(rawName)) problems.add('W_TEXT_SANITISED', '/name', 'Control, bidirectional, and other invisible characters were removed from "name".')
  if (!name) { name = id; problems.add('W_FIELD', '/name', '"name" is empty; the theme id is shown instead.') }
  const text = (field: 'description' | 'author', max: number): string | undefined => {
    const raw = own(json, field)
    if (raw === undefined) return undefined
    if (typeof raw !== 'string') { problems.add('W_FIELD', '/' + field, `"${field}" must be a string; ignored.`); return undefined }
    if (hasUnsafeCharacters(raw)) problems.add('W_TEXT_SANITISED', '/' + field, `Control, bidirectional, and other invisible characters were removed from "${field}".`)
    const clean = sanitizeLabel(raw, Infinity)
    if (codePoints(clean) > max) problems.add('W_FIELD', '/' + field, `"${field}" is longer than ${max} characters and was shortened.`)
    return clipCodePoints(clean, max) || undefined
  }
  const description = text('description', themeLimits.description), author = text('author', themeLimits.author)

  const palette = new Map<string, ThemeValue>()
  const rawPalette = sections.palette as Record<string, unknown> | undefined
  for (const slot of rawPalette ? Object.keys(rawPalette) : []) {
    const path = pointer('palette', slot)
    if (!patterns.slot.test(slot) || deniedKeys.has(slot)) { problems.add('W_KEY_INVALID', path, `Palette slot ${quote(slot)} is invalid: names start with a lowercase letter and use up to 32 letters and digits.`); continue }
    const value = parseThemeValue(rawPalette![slot], type)
    if (!value.ok) { problems.add(value.code, path, value.message); continue }
    palette.set(slot, value.value)
  }

  const colors = new Map<ColorKey, ThemeValue>(), unknown: string[] = []
  const rawColors = sections.colors as Record<string, unknown> | undefined
  for (const rawKey of rawColors ? Object.keys(rawColors) : []) {
    const path = pointer('colors', rawKey)
    if (rawKey.length > themeLimits.colorKeyLength || !patterns.colorKey.test(rawKey) || deniedKeys.has(rawKey)) {
      problems.add('W_KEY_INVALID', path, `Color key ${quote(rawKey)} is invalid: keys look like "editor.background" (up to 4 dot-separated words, at most 64 characters).`)
      continue
    }
    const renamed = colorKeyAliases.get(rawKey)
    if (renamed) problems.add('W_KEY_UNKNOWN', path, `${quote(rawKey)} was renamed to \`${renamed}\`; the old name still works for now.`)
    const key = renamed ?? rawKey
    if (!isColorKey(key)) { unknown.push(rawKey); continue }
    const value = parseThemeValue(rawColors![rawKey], type)
    if (!value.ok) { problems.add(value.code, path, value.message); continue }
    colors.set(key, value.value)
  }
  let suggestions = 0
  const unused = unknown.filter((key, index) => {
    const suggestion = suggestions < 10 && index < suggestionAttempts ? suggestKey(key) : undefined
    if (!suggestion) return true
    suggestions++
    problems.add('W_KEY_UNKNOWN', pointer('colors', key), `Unknown color key ${quote(key)}; did you mean \`${suggestion}\`?`)
    return false
  })
  if (unused.length) problems.add('W_KEYS_UNUSED', '/colors', `${unused.length} ${unused.length === 1 ? 'key is' : 'keys are'} not used by Varia (e.g. ${quote(unused[0])}).`)

  const rules: ThemeRule[] = []
  const rawRules = (sections.tokenColors as unknown[] | undefined) ?? []
  rawRules.forEach((rule, index) => {
    const path = pointer('tokenColors', index)
    if (!isPlainObject(rule)) { problems.add('W_FIELD', path, 'Each "tokenColors" rule is an object with "scope" and "settings"; ignored.'); return }
    for (const key of Object.keys(rule)) if (key !== 'name' && key !== 'scope' && key !== 'settings') problems.add('W_FIELD', path + pointer(key), `Unknown field ${quote(key)} ignored.`)
    const ruleName = own(rule, 'name')
    if (ruleName !== undefined && (typeof ruleName !== 'string' || ruleName.length > themeLimits.ruleName)) problems.add('W_FIELD', path + '/name', `"name" must be a string of at most ${themeLimits.ruleName} characters; ignored.`)
    const scope = own(rule, 'scope')
    const items = typeof scope === 'string' ? [scope] : Array.isArray(scope) && scope.length <= themeLimits.scopesPerRule ? scope : undefined
    if (!items) { problems.add('W_SCOPE', path + '/scope', `"scope" must be a string or an array of at most ${themeLimits.scopesPerRule} strings; the rule is ignored.`); return }
    const scopes = new Set<SqlScope>()
    items.forEach((item: unknown, itemIndex: number) => {
      const itemPath = path + '/scope' + (Array.isArray(scope) ? '/' + itemIndex : '')
      if (typeof item !== 'string' || item.length > themeLimits.scopeLength) { problems.add('W_SCOPE', itemPath, `Each scope is a string of at most ${themeLimits.scopeLength} characters; ignored.`); return }
      const unknownParts = new Set<string>()
      for (const part of item.split(',').map(value => value.trim())) {
        const mapped = isSqlScope(part) ? part : scopeAliases.get(part)
        if (mapped) scopes.add(mapped)
        else unknownParts.add(part)
      }
      // One warning per item: a comma list is one entry, however many of its parts are unknown.
      const [first, ...others] = unknownParts
      if (first !== undefined) problems.add('W_SCOPE', itemPath, `Unknown scope ${quote(first)}${others.length ? ` and ${others.length} more` : ''} ignored; docs/themes/tokens.md lists the scopes.`)
    })
    const settings = own(rule, 'settings')
    if (!isPlainObject(settings)) { problems.add('W_SETTING', path + '/settings', '"settings" must be an object; the rule is ignored.'); return }
    let foreground: ThemeValue | undefined, fontStyle: string | undefined
    for (const key of Object.keys(settings)) {
      const settingPath = path + '/settings' + pointer(key)
      if (key === 'foreground') {
        const value = parseThemeValue(settings[key], type)
        if (value.ok) foreground = value.value
        else problems.add(value.code, settingPath, value.message)
      } else if (key === 'fontStyle') {
        if (isFontStyle(settings[key])) fontStyle = settings[key]
        else problems.add('W_FONT_STYLE', settingPath, '"fontStyle" is "" or up to four of italic, bold, underline, and strikethrough, separated by single spaces.')
      } else problems.add('W_SETTING', settingPath, `${quote(key)} is not supported; token settings take "foreground" and "fontStyle" only.`)
    }
    if (foreground === undefined && fontStyle === undefined) return
    for (const value of scopes) rules.push({ scope: value, ...(foreground !== undefined && { foreground }), ...(fontStyle !== undefined && { fontStyle }), path })
  })

  return problems.result({ id, fileName: file, name, type, ...(description && { description }), ...(author && { author }), palette, colors, rules })
}

/** Decodes and parses theme file bytes: size, strict UTF-8 (a BOM is allowed), JSON, then `parseThemeFile`. */
export function parseThemeSource(bytes: Uint8Array, fileName: string): ThemeParseResult {
  const fail = (code: ThemeProblemCode, message: string): ThemeParseResult => ({ theme: null, problems: [createProblem(code, fileName, '', message)], problemsOmitted: 0 })
  if (bytes.length > themeLimits.fileBytes) return fail('E_TOO_LARGE', `The file is larger than ${themeLimits.fileBytes / 1024} KiB.`)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return fail('E_ENCODING', 'The file is not valid UTF-8.') }
  let json: unknown
  try { json = JSON.parse(text) } catch (error) {
    const reason = sanitizeLabel(error instanceof Error ? error.message : 'unreadable', Infinity)
    return fail('E_JSON', `Invalid JSON: ${clipCodePoints(reason, themeLimits.jsonReason)}. Comments and trailing commas are not supported.`)
  }
  return parseThemeFile(json, fileName)
}

export const themeIdSchema = z.string().max(48).regex(patterns.themeId)
const themeModeSchema = z.enum(['system', 'dark', 'light'])
export const themePreferenceSchema = z.object({ version: z.literal(1), mode: themeModeSchema, darkTheme: themeIdSchema, lightTheme: themeIdSchema }).strict()
export const themePreferencePatchSchema = z.object({ mode: themeModeSchema.optional(), darkTheme: themeIdSchema.optional(), lightTheme: themeIdSchema.optional() }).strict()
  .refine(patch => patch.mode !== undefined || patch.darkTheme !== undefined || patch.lightTheme !== undefined, 'Nothing to change.')
/** Dark keeps today's look; following the system is opt-in. */
export const defaultThemePreference: ThemePreference = { version: 1, mode: 'dark', darkTheme: 'varia-dark', lightTheme: 'varia-light' }

/** The file written by Create Custom Theme…, seeded with the active theme's accent slots. */
export function starterTheme(type: ThemeType, palette: ReadonlyMap<string, string>) {
  const slot = (name: string) => {
    const value = palette.get(name)
    if (!value) throw new Error('The resolved palette has no ' + name + ' slot.')
    return value
  }
  return {
    $schema: './varia-theme.schema.json', kind: themeKind, version: themeFormatVersion, name: 'My Theme', type,
    description: 'Edit this file, then choose View > Theme > Reload Themes.',
    palette: { accent: slot('accent'), accentHover: slot('accentHover'), onAccent: slot('onAccent'), focus: slot('focus') }, colors: {}, tokenColors: []
  }
}
