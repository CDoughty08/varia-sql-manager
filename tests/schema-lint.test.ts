import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { boundedRecord, boundedRecords } from '../src/shared/zod-bounds'
import { actionExecuteRequestSchema } from '../src/shared/actions/schema'
import { shortcutFileSchema, shortcutLimits } from '../src/shared/commands/shortcut-schema'

// Main's modules that read `electron` at import only need it to exist; main's entry point itself runs the app on import.
vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {}, BrowserWindow: class {}, Menu: class {}, nativeTheme: {}, screen: {}, safeStorage: {} }))

const root = join(__dirname, '..', 'src')
const sources = (readdirSync(root, { recursive: true }) as string[]).filter(file => /\.tsx?$/.test(file)).map(file => join(root, file))
const zodModules = sources.filter(file => !file.includes(join('src', 'renderer')) && file !== join(root, 'main', 'index.ts') && /from 'zod'/.test(readFileSync(file, 'utf8')))

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

/**
 * Why `pattern` can backtrack exponentially, or undefined: a repeated group that holds a repeat (`(a+)+`, `(a{1,3}){2,9}`) or,
 * under an unbounded repeat, an alternation (`(a|a)*`). Zod runs a schema's regex even on a string that already failed its
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
      if (repeated && quantifier.max === Infinity && atom.alternates) return `${source}: an alternation under an unbounded repeat`
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

describe('schema lint', () => {
  it('reads backtracking-prone patterns', () => {
    for (const bad of [/^(a|a)*$/, /^(a+)+$/, /^(?:[a-z]{1,3}){2,5}$/, /^((ab)*c)+$/, /^(?:(?:a|b)c)+$/, /^(?<word>\w+)*$/]) expect(backtrackingProblem(bad), bad.source).toBeDefined()
    for (const good of [/^\d{4}(\.\d{1,7})?$/, /^v1\.(a|b|c)\.[A-Za-z0-9_-]{1,1600}$/, /^(?:x|y){2}$/, /^[(|)*+]+$/, /^\((a)\)+$/, /^\p{L}+$/u, /^(?=a)[a-z]+$/, /^(?:-[0-9A-Za-z.-]+)?$/]) expect(backtrackingProblem(good), good.source).toBeUndefined()
  })

  it('finds every record and regex in the schemas main and the backend take', async () => {
    const records: string[] = [], patterns: string[] = []
    let schemas = 0
    for (const file of zodModules) {
      const where = relative(root, file).replaceAll('\\', '/')
      const exports = await import(file) as Record<string, unknown>
      const roots: Schema[] = []
      const collect = (value: unknown) => {
        if (isSchema(value)) roots.push(value)
        else if (value instanceof RegExp) { const problem = backtrackingProblem(value); if (problem) patterns.push(`${where}: ${problem}`) }
        else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) Object.values(value).forEach(collect)
      }
      Object.values(exports).forEach(collect)
      for (const schema of reachable(roots)) {
        schemas++
        if (schema._zod.def.type === 'record' && !boundedRecords.has(schema)) records.push(where)
        for (const pattern of regexChecks(schema)) { const problem = backtrackingProblem(pattern); if (problem) patterns.push(`${where}: ${problem}`) }
      }
    }
    // The walk must see the request schemas, or it proves nothing.
    expect(schemas).toBeGreaterThan(1000)
    expect(records, 'z.record without boundedRecord').toEqual([])
    expect(patterns).toEqual([])
  })

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
    const started = performance.now()
    const parsed = actionExecuteRequestSchema.safeParse(request)
    expect(parsed.success).toBe(false)
    // One issue for the count, not one per key; the time is a loose bound (the unbounded record took about 430 ms here).
    expect(parsed.error!.issues.length).toBeLessThanOrEqual(4)
    expect(performance.now() - started).toBeLessThan(400)
    const gestures = shortcutFileSchema.safeParse({ version: 1, scheme: 'default', bindings: [], unknown: [], gestures: many(shortcutLimits.gestures * 1000, index => [`grid.g${index}`, 'ctrl']) })
    expect(gestures.error?.issues).toEqual([expect.objectContaining({ path: ['gestures'], message: `at most ${shortcutLimits.gestures} gestures` })])
    const small = boundedRecord(z.record(z.string(), z.number()), 2)
    expect(small.safeParse({ a: 1, b: 2 }).success).toBe(true)
    expect(small.safeParse({ a: 1, b: 2, c: 3 }).error?.issues).toHaveLength(1)
    expect(small.safeParse('a').error?.issues[0].code).toBe('invalid_type')
  })
})
