import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { boundedRecord } from '../src/shared/zod-bounds'
import { actionExecuteRequestSchema } from '../src/shared/actions/schema'
import { shortcutFileSchema, shortcutLimits } from '../src/shared/commands/shortcut-schema'

// Main's modules that read `electron` at import only need it to exist; main's entry point itself runs the app on import.
vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {}, BrowserWindow: class {}, Menu: class {}, nativeTheme: {}, screen: {}, safeStorage: {} }))

const root = join(__dirname, '..', 'src')
const sources = (readdirSync(root, { recursive: true }) as string[]).filter(file => /\.tsx?$/.test(file)).map(file => join(root, file))
const outsideRenderer = (file: string) => !file.startsWith(join(root, 'renderer'))
// Every module main, preload and the backend's contracts share, loaded to read its schemas and the patterns it builds; main's
// entry point runs the app and preload calls contextBridge on import, so the literal scan alone reads those two.
const trustModules = sources.filter(file => outsideRenderer(file) && file !== join(root, 'main', 'index.ts') && !file.startsWith(join(root, 'preload')))

type Schema = z.ZodType & { _zod: { def: Record<string, unknown> } }
const isSchema = (value: unknown): value is Schema => typeof value === 'object' && value !== null && '_zod' in value && typeof (value as Schema)._zod?.def === 'object'

/** Every schema `root` reaches, through objects, unions, pipes, records, arrays, lazies and wrappers. */
function reachable(roots: readonly Schema[]): Schema[] {
  const seen = new Set<Schema>(), stack = [...roots]
  const push = (value: unknown): void => {
    if (isSchema(value)) stack.push(value)
    else if (Array.isArray(value)) value.forEach(push)
  }
  while (stack.length) {
    const schema = stack.pop()!
    if (seen.has(schema)) continue
    seen.add(schema)
    for (const [key, value] of Object.entries(schema._zod.def)) {
      if (key === 'checks') continue
      if (key === 'getter' && typeof value === 'function') push(value())
      else if (key === 'shape' && value && typeof value === 'object') Object.values(value).forEach(push)
      else push(value)
    }
  }
  return [...seen]
}
const regexChecks = (schema: Schema): RegExp[] => ((schema._zod.def.checks ?? []) as unknown as Schema[]).flatMap(check => check._zod.def.format === 'regex' ? [check._zod.def.pattern as RegExp] : [])

/** The most repetitions an alternation may take: overlapping branches cost at most 2^8 tries, a bit more for wider ones. */
const maxAlternationRepeat = 8

/**
 * Why `pattern` can backtrack exponentially, or undefined: a repeated group that holds a repeat (`(a+)+`, `(a{1,3}){2,9}`) or,
 * under an unbounded or long repeat, an alternation (`(a|a)*`, `(a|a){1,40}`). Zod runs a schema's regex even on a string that already failed its
 * `.max()`, so a pattern at a trust boundary must stay linear in what a page sends. Character classes, escapes and lookarounds
 * are read as atoms; adjacent repeats (polynomial at worst) are left alone.
 */
export function backtrackingProblem(pattern: RegExp): string | undefined {
  const source = pattern.source
  interface Frame { repeats: boolean; alternates: boolean }
  const frames: Frame[] = [{ repeats: false, alternates: false }]
  let atom: Frame | undefined
  const settle = (quantifier?: { max: number }) => {
    const frame = frames[frames.length - 1]
    if (atom) {
      const repeated = !!quantifier && quantifier.max > 1
      if (repeated && atom.repeats) return `${source}: a repeated group holds a repeat`
      // Overlapping branches try branches^max ways; a few repetitions (`(?:x|y){2}`) stay cheap, many are as bad as unbounded.
      if (repeated && quantifier.max > maxAlternationRepeat && atom.alternates) return `${source}: an alternation under a repeat of more than ${maxAlternationRepeat}`
      frame.repeats ||= atom.repeats || repeated
      frame.alternates ||= atom.alternates
    } else if (quantifier && quantifier.max > 1) frame.repeats = true
    atom = undefined
    return undefined
  }
  for (let at = 0; at < source.length;) {
    const char = source[at]
    const quantifier = /^(?:([*+?])|\{(\d+)(,(\d*))?\})\??/.exec(source.slice(at))
    if (quantifier) {
      const max = quantifier[1] ? (quantifier[1] === '?' ? 1 : Infinity) : quantifier[3] === undefined ? Number(quantifier[2]) : quantifier[4] === '' ? Infinity : Number(quantifier[4])
      const problem = settle({ max })
      if (problem) return problem
      at += quantifier[0].length
      continue
    }
    const problem = settle()
    if (problem) return problem
    if (char === '\\') at += source[at + 1] === 'p' || source[at + 1] === 'P' || source[at + 1] === 'u' && source[at + 2] === '{' ? source.indexOf('}', at) + 1 : 2
    else if (char === '[') {
      let end = at + 1
      if (source[end] === '^') end++
      if (source[end] === ']') end++
      while (end < source.length && source[end] !== ']') end += source[end] === '\\' ? 2 : 1
      at = end + 1
    } else if (char === '(') { frames.push({ repeats: false, alternates: false }); at += source[at + 1] === '?' ? (source[at + 2] === '<' && source[at + 3] !== '=' && source[at + 3] !== '!' ? source.indexOf('>', at) + 1 - at : source[at + 2] === '<' ? 4 : 3) : 1 }
    else if (char === ')') { atom = frames.pop(); at++ }
    else { if (char === '|') frames[frames.length - 1].alternates = true; at++ }
  }
  return settle()
}

const regexAllowedAfter = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await'])

/**
 * Every regular expression literal in `text`, a TypeScript source: comments, strings and template text are skipped, and a
 * `/` starts a literal only where an expression can begin (after an operator, an opening bracket or a keyword). Text the
 * scanner reads as a literal that does not compile is returned as a string, so a scanner mistake fails the lint loudly.
 */
export function regexLiterals(text: string): (RegExp | string)[] {
  const found: (RegExp | string)[] = []
  const braces: number[] = [] // for each open template substitution, the brace depth it started at
  let depth = 0, previous = '', at = 0
  const skipTemplate = () => { // from inside template text to its end or its next substitution
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue }
      if (text[at] === '`') { at++; previous = 'x'; return }
      if (text.startsWith('${', at)) { at += 2; braces.push(depth); depth++; previous = '{'; return }
      at++
    }
  }
  while (at < text.length) {
    const char = text[at]
    if (/\s/.test(char)) { at++; continue }
    if (text.startsWith('//', at)) { const end = text.indexOf('\n', at); at = end < 0 ? text.length : end; continue }
    if (text.startsWith('/*', at)) { at = text.indexOf('*/', at + 2) + 2; continue }
    if (char === '"' || char === '\'') {
      at++
      while (at < text.length && text[at] !== char) at += text[at] === '\\' ? 2 : 1
      at++; previous = 'x'; continue
    }
    if (char === '`') { at++; skipTemplate(); continue }
    if (char === '{') { depth++; previous = '{'; at++; continue }
    if (char === '}') {
      depth--; at++
      if (braces.length && braces[braces.length - 1] === depth) { braces.pop(); skipTemplate() } else previous = '}'
      continue
    }
    if (char === '/' && regexAllowedAfter.has(previous)) {
      let end = at + 1, inClass = false
      while (end < text.length && text[end] !== '\n' && (inClass || text[end] !== '/')) {
        if (text[end] === '\\') end++
        else if (text[end] === '[') inClass = true
        else if (text[end] === ']') inClass = false
        end++
      }
      const flags = /^[a-z]*/.exec(text.slice(end + 1))![0]
      const literal = text.slice(at, end + 1 + flags.length)
      try { found.push(new RegExp(text.slice(at + 1, end), flags)) } catch { found.push(literal) }
      at = end + 1 + flags.length; previous = 'x'; continue
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(at, at + 64))
    if (word) { previous = word[0]; at += word[0].length; continue }
    const number = /^[0-9][\w.]*/.exec(text.slice(at, at + 64))
    if (number) { previous = 'x'; at += number[0].length; continue }
    previous = char === ')' || char === ']' ? 'x' : char
    at++
  }
  return found
}

/**
 * Patterns the analyser cannot read as linear but that are, with why. Each must still be in source (a stale entry fails),
 * and a change to one is a new pattern that needs review.
 */
const reviewedPatterns: Record<string, string> = {
  // Each repetition starts with `\.`, which no inner repeat matches, so the input splits into repetitions one way only.
  '^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*){1,4}$': 'settings/catalog.ts settingKeyPattern',
  // The same shape: theme colour keys.
  '^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*){0,3}$': 'theme/format.ts themePatterns.colorKey'
}

describe('schema lint', () => {
  it('reads backtracking-prone patterns', () => {
    for (const bad of [/^(a|a)*$/, /^(a+)+$/, /^(?:[a-z]{1,3}){2,5}$/, /^((ab)*c)+$/, /^(?:(?:a|b)c)+$/, /^(?<word>\w+)*$/, /^(a|a){1,40}$/, /^(?:[a-z]|\w){1,64}$/, /^(?:a|b){9}$/]) expect(backtrackingProblem(bad), bad.source).toBeDefined()
    for (const good of [/^\d{4}(\.\d{1,7})?$/, /^v1\.(a|b|c)\.[A-Za-z0-9_-]{1,1600}$/, /^(?:x|y){2}$/, /^[(|)*+]+$/, /^\((a)\)+$/, /^\p{L}+$/u, /^(?=a)[a-z]+$/, /^(?:-[0-9A-Za-z.-]+)?$/]) expect(backtrackingProblem(good), good.source).toBeUndefined()
  })

  it('reads regex literals out of source, and nothing else', () => {
    const text = [
      'const a = /^(a+)+$/u // a comment with /slashes/',
      'const b = x / 2 / y, c = f(/[/]x/g), d = \'/not/\' + "/not/" + `/not/${/^t$/.source}/not/`',
      '/* /not/ */ if (ok) return /^r$/i',
      'const e = items[0] / 3, g = (n) / 4'
    ].join('\n')
    expect(regexLiterals(text).map(found => String(found))).toEqual(['/^(a+)+$/u', '/[/]x/g', '/^t$/', '/^r$/i'])
  })

  it('finds every record and regex in the schemas main and the backend take', async () => {
    const records: string[] = [], patterns: string[] = [], reviewed = new Set<string>()
    const check = (where: string, pattern: RegExp | string) => {
      if (typeof pattern === 'string') { patterns.push(`${where}: ${pattern} does not compile; the scanner misread it`); return }
      if (pattern.source in reviewedPatterns) { reviewed.add(pattern.source); return }
      const problem = backtrackingProblem(pattern)
      if (problem) patterns.push(`${where}: ${problem}`)
    }
    // Patterns built at run time (`new RegExp(...)`, in any module, exported or not): every one a module makes as it loads.
    const constructed: RegExp[] = []
    const NativeRegExp = globalThis.RegExp
    globalThis.RegExp = new Proxy(NativeRegExp, {
      construct: (target, args, newTarget) => { const made = Reflect.construct(target, args, newTarget) as RegExp; constructed.push(made); return made },
      apply: (target, self, args) => { const made = Reflect.apply(target, self, args) as RegExp; constructed.push(made); return made }
    })
    let schemas = 0
    try {
      // Loaded afresh, so each module's patterns are made again under the spy; boundedRecords must be the fresh one too.
      vi.resetModules()
      const { boundedRecords } = await import('../src/shared/zod-bounds')
      for (const file of trustModules) {
        const where = relative(root, file).replaceAll('\\', '/')
        constructed.length = 0
        const exports = await import(file) as Record<string, unknown>
        // A module is loaded once, so a pattern is reported under the first module here that loads it.
        constructed.forEach(pattern => check(`${where} (or a module it loads)`, pattern))
        const roots: Schema[] = []
        const collect = (value: unknown) => {
          if (isSchema(value)) roots.push(value)
          else if (value instanceof NativeRegExp) check(where, value)
          else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) Object.values(value).forEach(collect)
        }
        Object.values(exports).forEach(collect)
        for (const schema of reachable(roots)) {
          schemas++
          if (schema._zod.def.type === 'record' && !boundedRecords.has(schema)) records.push(where)
          for (const pattern of regexChecks(schema)) check(where, pattern)
        }
      }
    } finally { globalThis.RegExp = NativeRegExp }
    // Literal patterns anywhere outside the renderer, main's entry point and preload included, used in a refine or not.
    for (const file of sources.filter(outsideRenderer)) {
      const where = relative(root, file).replaceAll('\\', '/')
      for (const pattern of regexLiterals(readFileSync(file, 'utf8'))) check(where, pattern)
    }
    // The walk must see the request schemas, or it proves nothing.
    expect(schemas).toBeGreaterThan(1000)
    expect(records, 'z.record without boundedRecord').toEqual([])
    expect(patterns).toEqual([])
    expect([...reviewed].sort(), 'reviewed patterns no longer in source').toEqual(Object.keys(reviewedPatterns).sort())
  }, 60_000) // loads every module outside the renderer afresh

  it('wraps every record in source in boundedRecord, main\'s entry point and the renderer included', () => {
    const found = sources.flatMap(file => readFileSync(file, 'utf8').split('\n').flatMap((line, index) => {
      const where = `${relative(root, file).replaceAll('\\', '/')}:${index + 1}`
      if (/z\.(partialRecord|looseRecord)\(/.test(line)) return [where]
      const records = line.split('z.record(').length - 1, bounded = line.split('boundedRecord(z.record(').length - 1
      return records > bounded ? [where] : []
    }))
    expect(found).toEqual([])
  })

  it('refuses an oversized record before parsing its keys', () => {
    const many = (count: number, entry: (index: number) => [string, string]) => Object.fromEntries(Array.from({ length: count }, (_, index) => entry(index)))
    const request = { action: 'properties', connectionId: crypto.randomUUID(), requestId: crypto.randomUUID(), target: { kind: 'database', name: 'AppData' }, closeConnections: false, changes: { options: many(200_000, index => [`option${index}`, 'ON']) } }
    const parsed = actionExecuteRequestSchema.safeParse(request)
    expect(parsed.success).toBe(false)
    // One issue for the count, not one per key: the record refused the object before it parsed any key.
    expect(parsed.error!.issues.length).toBeLessThanOrEqual(4)
    const gestures = shortcutFileSchema.safeParse({ version: 1, scheme: 'default', bindings: [], unknown: [], gestures: many(shortcutLimits.gestures * 1000, index => [`grid.g${index}`, 'ctrl']) })
    expect(gestures.error?.issues).toEqual([expect.objectContaining({ path: ['gestures'], message: `at most ${shortcutLimits.gestures} gestures` })])
    const small = boundedRecord(z.record(z.string(), z.number()), 2)
    expect(small.safeParse({ a: 1, b: 2 }).success).toBe(true)
    expect(small.safeParse({ a: 1, b: 2, c: 3 }).error?.issues).toHaveLength(1)
    expect(small.safeParse('a').error?.issues[0].code).toBe('invalid_type')
  })
})
