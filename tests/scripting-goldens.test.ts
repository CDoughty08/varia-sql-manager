import { describe, expect, it } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scriptErrorCodes, scriptVerbOffered, scriptVerbs, type ScriptVerb } from '../src/shared/scripting/catalog.ts'
import { defaultScriptingOptions, scriptingOptionsSchema } from '../src/shared/scripting/options.ts'
import { nodeKinds, type NodeKind, type ParentKind } from '../src/shared/explorer/catalog.ts'

// The live Script As goldens (spec G4, G5): cases.json, golden/<major>/*.sql with manifest.json, the shared
// normalization rules, and scripts/compare-ssms-scripts.mjs. The .NET checks run the cases against SQL Server and apply
// the same normalize-cases.json vectors, so both normalizers agree.

interface CompareModule {
  loadRules(folder?: string): { pattern: RegExp; replacement: string }[]
  normalize(text: string, rules?: { pattern: RegExp; replacement: string }[]): string
  framingOnly(expected: string, actual: string): boolean
  unifiedDiff(expected: string, actual: string, from?: string, to?: string): string
  goldenKey(id: string, major: number, folder?: string): string
  compareFolder(captures: string, options?: { major?: number; folder?: string }): { id: string; key?: string; status: string; diff?: string }[]
}
const compare = (): Promise<CompareModule> => import(/* @vite-ignore */ pathToFileURL(resolve('scripts/compare-ssms-scripts.mjs')).href)

interface ScriptCase {
  id: string
  target: { kind: string; name: string; schema?: string; parent?: { kind: string; schema: string; name: string } }
  verb: string
  options?: Record<string, unknown>
  minMajor?: number
  maxMajor?: number
  maxCommands?: number
  roundTrip?: number
  expectError?: string
  requires?: string
  parses?: boolean
}
const folder = resolve('tests/fixtures/scripting')
const cases = (JSON.parse(readFileSync(join(folder, 'cases.json'), 'utf8')) as { version: number; cases: ScriptCase[] }).cases
const manifest = (JSON.parse(readFileSync(join(folder, 'golden', 'manifest.json'), 'utf8')) as { files: Record<string, string> }).files
const goldenFiles = readdirSync(join(folder, 'golden'), { withFileTypes: true }).filter(entry => entry.isDirectory())
  .flatMap(entry => readdirSync(join(folder, 'golden', entry.name)).map(name => `${entry.name}/${name}`)).sort()
const applies = (item: ScriptCase, major: number) => (item.minMajor ?? 0) <= major && major <= (item.maxMajor ?? 99)

describe('scripting golden cases', () => {
  it('names each case once, with a verb its kind offers and valid options', () => {
    expect(cases.length).toBeGreaterThan(150)
    expect(new Set(cases.map(item => item.id)).size).toBe(cases.length)
    for (const item of cases) {
      expect(item.id, item.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(scriptVerbs, item.id).toContain(item.verb)
      expect(nodeKinds, item.id).toContain(item.target.kind)
      expect(scriptVerbOffered(item.target.kind as NodeKind, item.verb as ScriptVerb, item.target.parent?.kind as ParentKind | undefined), item.id).toBe(true)
      expect(scriptingOptionsSchema.safeParse({ ...defaultScriptingOptions, ...item.options }).success, item.id).toBe(true)
      if (item.expectError) expect(scriptErrorCodes, item.id).toContain(item.expectError)
      if (item.requires) expect(['sqlLogin', 'snapshot'], item.id).toContain(item.requires)
    }
    const orders = cases.flatMap(item => item.roundTrip === undefined ? [] : [item.roundTrip])
    expect(orders.length).toBeGreaterThanOrEqual(20)
    expect(new Set(orders).size).toBe(orders.length)
    expect(cases.filter(item => item.roundTrip !== undefined).every(item => item.verb === 'create' && !item.options)).toBe(true)
    // Every verb of every row in B3 that the scratch fixture can hold appears at least once.
    expect(new Set(cases.map(item => item.verb))).toEqual(new Set(scriptVerbs))
  })
  it('has a golden for every case that scripts, and a manifest entry for every golden', () => {
    expect(Object.keys(manifest).sort()).toEqual(goldenFiles)
    for (const [key, source] of Object.entries(manifest)) {
      expect(key, key).toMatch(/^(14|15|16|17)\/[a-z0-9-]+\.sql$/)
      expect(source, key).toMatch(/^(varia|ssms-\d+(\.\d+)*)$/)
      expect(cases.map(item => item.id), key).toContain(key.split('/')[1].replace(/\.sql$/, ''))
    }
    for (const item of cases.filter(item => !item.expectError)) {
      for (const major of [14, 15, 16, 17].filter(major => applies(item, major))) {
        const own = `${major}/${item.id}.sql`, baseline = `16/${item.id}.sql`
        expect(manifest[own] ?? manifest[baseline], `${item.id} on ${major}`).toBeDefined()
      }
    }
    for (const item of cases.filter(item => item.expectError)) expect(goldenFiles.filter(file => file.endsWith(`/${item.id}.sql`)), item.id).toEqual([])
  })
  it('keeps goldens byte-exact: LF only, trailing spaces kept, no byte order mark', () => {
    for (const file of goldenFiles) {
      const text = readFileSync(join(folder, 'golden', file), 'utf8')
      expect(text.includes('\r\n') || text.startsWith('\uFEFF'), file).toBe(false)
      expect(text.endsWith('GO\n\n') || text.endsWith('\n\n'), file).toBe(true)
    }
    const execute = readFileSync(join(folder, 'golden', '16', 'procedure-execute.sql'), 'utf8')
    expect(execute).toContain('EXECUTE @RC = [Sales].[usp_Orders] \n   @CustomerId\n')
  })
})

describe('script normalization and SSMS comparison', () => {
  it('normalizes the shared vectors exactly as the C# checks do', async () => {
    const { normalize, loadRules } = await compare()
    const rules = loadRules()
    const vectors = (JSON.parse(readFileSync(join(folder, 'normalize-cases.json'), 'utf8')) as { cases: { name: string; input: string; output: string }[] }).cases
    expect(vectors.length).toBeGreaterThanOrEqual(10)
    for (const vector of vectors) expect(normalize(vector.input, rules), vector.name).toBe(vector.output)
    expect(normalize('\uFEFFUSE [x]\r\n', rules)).toBe('USE [x]\n')
  })
  it('tells framing from content and prints unified diffs', async () => {
    const { framingOnly, unifiedDiff } = await compare()
    expect(framingOnly('SELECT 1\nGO\n\n', 'SELECT 1  \n\nGO\n')).toBe(true)
    expect(framingOnly('SELECT 1\nGO\n', 'SELECT 2\nGO\n')).toBe(false)
    expect(unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'x', 'y')).toBe('--- x\n+++ y\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n ')
    expect(unifiedDiff('same\n', 'same\n')).toBe('--- varia\n+++ ssms')
  })
  it('compares a folder of captures with the goldens', async () => {
    const { compareFolder, goldenKey } = await compare()
    const captures = mkdtempSync(join(tmpdir(), 'varia-ssms-'))
    try {
      const golden = (id: string) => readFileSync(join(folder, 'golden', '16', id + '.sql'), 'utf8')
      // SSMS saves with a byte order mark, CRLF and its own date.
      writeFileSync(join(captures, 'table-delete.sql'), '\uFEFF' + golden('table-delete').replaceAll('\n', '\r\n'))
      writeFileSync(join(captures, 'view-create.sql'), golden('view-create').replace('Script Date: <date>', 'Script Date: 10/9/2026 7:52:05 PM'))
      writeFileSync(join(captures, 'table-select.sql'), golden('table-select').replace(/\nGO\n\n$/, '\nGO\n'))
      writeFileSync(join(captures, 'table-update.sql'), golden('table-update').replace('[Code]', '[Kode]'))
      writeFileSync(join(captures, 'no-such-case.sql'), 'SELECT 1')
      copyFileSync(join(folder, 'golden', '16', 'schema-create.sql'), join(captures, 'schema-create.sql'))
      const rows = Object.fromEntries(compareFolder(captures).map(row => [row.id, row]))
      expect(Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, row.status]))).toEqual({
        'no-such-case': 'unknown', 'schema-create': 'match', 'table-delete': 'match', 'table-select': 'framing', 'table-update': 'content', 'view-create': 'match'
      })
      expect(rows['table-update'].diff).toContain('-   SET [Code] = <Code, nchar(8),>')
      // SQL Server 2017 scripts indexes without OPTIMIZE_FOR_SEQUENTIAL_KEY, so it has an overlay; DELETE is the same everywhere.
      expect([goldenKey('index-create', 14), goldenKey('index-create', 16), goldenKey('table-delete', 14)]).toEqual(['14/index-create.sql', '16/index-create.sql', '16/table-delete.sql'])
    } finally { rmSync(captures, { recursive: true, force: true }) }
  })
})
