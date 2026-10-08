import { describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createProblem, defaultThemePreference, limitProblems, parseThemeFile, parseThemeSource, quote, sanitizeLabel, starterTheme, themeIdFromFileName,
  themeLimits, themePreferencePatchSchema, themePreferenceSchema
} from '../src/shared/theme/format'
import { resolveTheme } from '../src/shared/theme/resolve'
import type { ThemeParseResult, ThemeProblemCode } from '../src/shared/theme/types'

const base = { kind: 'varia-color-theme', version: 1, name: 'Test', type: 'dual' }
const parse = (fields: Record<string, unknown>, file = 'test.json') => parseThemeFile({ ...base, ...fields }, file)
const codes = (result: ThemeParseResult) => result.problems.map(problem => problem.code)
const only = (result: ThemeParseResult) => result.problems.map(problem => [problem.code, problem.path])
const char = (code: number) => String.fromCodePoint(code)
const encode = (text: string) => new TextEncoder().encode(text)

describe('theme files', () => {
  it('load the documentation examples and the starter template with zero problems', async () => {
    const directory = join('docs', 'themes', 'examples')
    const files = (await readdir(directory)).filter(file => file.endsWith('.json')).sort()
    expect(files).toEqual(['amber-accent.json', 'harbor.json'])
    for (const file of files) {
      const result = parseThemeSource(await readFile(join(directory, file)), file)
      expect(result.problems, file).toEqual([])
      const theme = result.theme!
      for (const variant of theme.type === 'dual' ? ['dark', 'light'] as const : [theme.type]) expect(resolveTheme([theme], variant).problems, `${file} ${variant}`).toEqual([])
    }
    const harbor = parseThemeSource(await readFile(join(directory, 'harbor.json')), 'harbor.json').theme!
    expect(harbor).toMatchObject({ id: 'harbor', name: 'Harbor', type: 'dual', author: 'Jane Doe' })
    expect(harbor.rules.map(rule => rule.scope)).toEqual(['keyword', 'string', 'comment', 'comment.quote'])
    for (const type of ['dark', 'light'] as const) {
      const starter = starterTheme(type, resolveTheme([], type).palette)
      const result = parseThemeFile(JSON.parse(JSON.stringify(starter)), 'custom-theme.json')
      expect(result.problems).toEqual([])
      expect(result.theme).toMatchObject({ id: 'custom-theme', name: 'My Theme', type })
      expect(starter.palette).toEqual(type === 'dark'
        ? { accent: '#8fb7ff', accentHover: '#accaff', onAccent: '#101b2d', focus: '#76acff' }
        : { accent: '#005fb8', accentHover: '#004c94', onAccent: '#ffffff', focus: '#005fb8' })
    }
  })
  it('turn file names into lowercase ids and reject bad or reserved names', () => {
    expect(themeIdFromFileName('Harbor_Night-2.json')).toBe('harbor_night-2')
    for (const name of ['bad name.json', '-x.json', '_x.json', 'x.JSON', 'x.json5', '.json', 'a'.repeat(49) + '.json', 'ｘ.json']) {
      expect(themeIdFromFileName(name), name).toBeUndefined()
      expect(codes(parse({}, name)), name).toEqual(['E_FILE_NAME'])
    }
    expect(themeIdFromFileName('a'.repeat(48) + '.json')).toBe('a'.repeat(48))
    expect(codes(parse({}, 'Varia-Mine.json'))).toEqual(['E_RESERVED'])
    expect(parse({}, '/home/user/.config/themes/ok.json').theme?.fileName).toBe('ok.json')
  })
  it.each<[string, unknown, ThemeProblemCode, string?]>([
    ['an array', [], 'E_NOT_OBJECT'], ['a string', 'theme', 'E_NOT_OBJECT'], ['null', null, 'E_NOT_OBJECT'],
    ['no kind', { version: 1, name: 'x', type: 'dark' }, 'E_KIND', 'must be "varia-color-theme"'],
    ['a VS Code theme', { version: 1, name: 'x', type: 'dark', colors: { 'editor.background': '#000' } }, 'E_KIND', 'VS Code themes cannot be loaded yet'],
    ['another kind', { ...base, kind: 'varia-workspace-layout' }, 'E_KIND'],
    ['a newer format', { ...base, version: 2 }, 'E_VERSION', 'needs a newer Varia (theme format 2)'],
    ['a string version', { ...base, version: '1' }, 'E_VERSION'], ['version 0', { ...base, version: 0 }, 'E_VERSION'], ['version 1.5', { ...base, version: 1.5 }, 'E_VERSION'],
    ['a high-contrast type', { ...base, type: 'hc-dark' }, 'E_FIELD'], ['a missing type', { ...base, type: undefined }, 'E_FIELD'],
    ['a numeric name', { ...base, name: 5 }, 'E_FIELD'], ['a palette array', { ...base, palette: [] }, 'E_FIELD'],
    ['a colors string', { ...base, colors: 'x' }, 'E_FIELD'], ['a tokenColors object', { ...base, tokenColors: {} }, 'E_FIELD']
  ])('reject %s', (_name, json, code, message) => {
    const result = parseThemeFile(json, 'test.json')
    expect(result.theme).toBeNull()
    expect(codes(result)).toEqual([code])
    if (message) expect(result.problems[0].message).toContain(message)
  })
  it('report every top-level error together, before any warning', () => {
    const result = parseThemeFile({ kind: 'x', version: 3, name: 1, type: 'x', extra: true }, 'test.json')
    expect(only(result)).toEqual([['E_KIND', '/kind'], ['E_VERSION', '/version'], ['E_FIELD', '/type'], ['E_FIELD', '/name']])
  })
  it('report file-level failures from the bytes', () => {
    const fail = (bytes: Uint8Array) => parseThemeSource(bytes, 'test.json')
    expect(codes(fail(new Uint8Array([0x7b, 0xff, 0x7d])))).toEqual(['E_ENCODING'])
    expect(codes(fail(encode('{"kind": "varia-color-theme", // comment\n}')))).toEqual(['E_JSON'])
    const trailing = fail(encode('{"name": "x",}'))
    expect(codes(trailing)).toEqual(['E_JSON'])
    expect(trailing.problems[0].message).toMatch(/^Invalid JSON: .+\. Comments and trailing commas are not supported\.$/)
    const bom = parseThemeSource(new Uint8Array([0xef, 0xbb, 0xbf, ...encode(JSON.stringify(base))]), 'bom.json')
    expect(bom.problems).toEqual([])
    const sized = (length: number) => { const text = JSON.stringify(base); return encode(text + ' '.repeat(length - text.length)) }
    expect(parseThemeSource(sized(themeLimits.fileBytes), 'test.json').problems).toEqual([])
    expect(codes(parseThemeSource(sized(themeLimits.fileBytes + 1), 'test.json'))).toEqual(['E_TOO_LARGE'])
    const evil = fail(encode('{"a": ' + char(0x202e) + '}'))
    expect(evil.problems[0].message.length).toBeLessThanOrEqual(themeLimits.message)
    expect(evil.problems[0].message).not.toContain(char(0x202e))
  })
  it('enforce depth and node limits before reading fields', () => {
    const nested = (depth: number) => { let value: unknown = 1; for (let index = 1; index < depth; index++) value = { a: value }; return value }
    // The root object is level 1, so a value nested in 7 more objects is the deepest allowed.
    expect(codes(parse({ extra: nested(8) }))).toEqual(['W_FIELD'])
    expect(codes(parse({ extra: nested(9) }))).toEqual(['E_COMPLEX'])
    const nodes = (count: number) => parse({ extra: new Array(count).fill(0) })
    expect(codes(nodes(themeLimits.nodes - 6))).toEqual(['W_FIELD'])
    expect(codes(nodes(themeLimits.nodes - 5))).toEqual(['E_COMPLEX'])
  })
  it('enforce every count and length limit at N and N + 1', () => {
    const entries = (count: number, make: (index: number) => [string, unknown]) => Object.fromEntries(Array.from({ length: count }, (_, index) => make(index)))
    expect(codes(parse({ palette: entries(128, index => ['s' + index, '#fff']) }))).toEqual([])
    expect(only(parse({ palette: entries(129, index => ['s' + index, '#fff']) }))).toEqual([['E_LIMIT', '/palette']])
    expect(codes(parse({ colors: entries(1024, index => ['k' + index, '#fff']) }))).toEqual(['W_KEYS_UNUSED'])
    expect(only(parse({ colors: entries(1025, index => ['k' + index, '#fff']) }))).toEqual([['E_LIMIT', '/colors']])
    const rule = { scope: 'keyword', settings: { fontStyle: 'bold' } }
    expect(codes(parse({ tokenColors: new Array(256).fill(rule) }))).toEqual([])
    expect(only(parse({ tokenColors: new Array(257).fill(rule) }))).toEqual([['E_LIMIT', '/tokenColors']])
    expect(codes(parse({ tokenColors: [{ ...rule, scope: new Array(32).fill('keyword') }] }))).toEqual([])
    expect(only(parse({ tokenColors: [{ ...rule, scope: new Array(33).fill('keyword') }] }))).toEqual([['W_SCOPE', '/tokenColors/0/scope']])
    const longScope = (length: number) => 'keyword,' + ' '.repeat(length - 'keyword,string'.length) + 'string'
    expect(parse({ tokenColors: [{ ...rule, scope: longScope(128) }] }).theme!.rules.map(value => value.scope)).toEqual(['keyword', 'string'])
    expect(only(parse({ tokenColors: [{ ...rule, scope: longScope(129) }] }))).toEqual([['W_SCOPE', '/tokenColors/0/scope']])
    expect(parse({ name: 'n'.repeat(64) }).theme!.name).toHaveLength(64)
    expect(only(parse({ name: 'n'.repeat(65) }))).toEqual([['E_FIELD', '/name']])
    for (const [field, limit] of [['description', 512], ['author', 128]] as const) {
      expect(parse({ [field]: 'd'.repeat(limit) }).theme![field]).toHaveLength(limit)
      const long = parse({ [field]: 'd'.repeat(limit + 1) })
      expect(only(long)).toEqual([['W_FIELD', '/' + field]])
      expect(long.theme![field]).toHaveLength(limit)
    }
    expect(codes(parse({ $schema: 's'.repeat(256) }))).toEqual([])
    expect(only(parse({ $schema: 's'.repeat(257) }))).toEqual([['W_FIELD', '/$schema']])
    expect(codes(parse({ tokenColors: [{ ...rule, name: 'r'.repeat(64) }] }))).toEqual([])
    expect(only(parse({ tokenColors: [{ ...rule, name: 'r'.repeat(65) }] }))).toEqual([['W_FIELD', '/tokenColors/0/name']])
    expect(codes(parse({ palette: { ['s'.repeat(32)]: '#fff' } }))).toEqual([])
    expect(codes(parse({ palette: { ['s'.repeat(33)]: '#fff' } }))).toEqual(['W_KEY_INVALID'])
    expect(codes(parse({ colors: { ['k'.repeat(64)]: '#fff' } }))).toEqual(['W_KEYS_UNUSED'])
    expect(codes(parse({ colors: { ['k'.repeat(65)]: '#fff' } }))).toEqual(['W_KEY_INVALID'])
    const many = parse(entries(60, index => ['unknown' + index, true]))
    expect(many.problems).toHaveLength(themeLimits.problemsPerFile)
    expect(many.problemsOmitted).toBe(10)
  })
  it('warn about unknown fields and keys, with suggestions and one summary', () => {
    const result = parse({ extra: 1, colors: { 'editor.backgroud': '#000', 'Editor.Background': '#000', 'activityBar.background': '#000', 'focusborder': '#000', 'statusBar.background': '#123' } })
    expect(only(result)).toEqual([
      ['W_FIELD', '/extra'], ['W_KEY_INVALID', '/colors/Editor.Background'], ['W_KEY_UNKNOWN', '/colors/editor.backgroud'],
      ['W_KEY_UNKNOWN', '/colors/focusborder'], ['W_KEYS_UNUSED', '/colors']
    ])
    expect(result.problems[2].message).toBe('Unknown color key `editor.backgroud`; did you mean `editor.background`?')
    expect(result.problems[3].message).toContain('did you mean `focusBorder`?')
    expect(result.problems[4].message).toBe('1 key is not used by Varia (e.g. `activityBar.background`).')
    expect([...result.theme!.colors]).toEqual([['statusBar.background', '#123']])
    const pasted = parse({ colors: Object.fromEntries(Array.from({ length: 30 }, (_, index) => ['editor.background' + index, '#000'])) })
    expect(codes(pasted).filter(code => code === 'W_KEY_UNKNOWN')).toHaveLength(10)
    expect(pasted.problems.at(-1)!.message).toMatch(/^20 keys are not used by Varia/)
    // Only the first 64 unknown keys are compared with the registry, which keeps a large pasted block cheap.
    const late = parse({ colors: { ...Object.fromEntries(Array.from({ length: 64 }, (_, index) => ['unrelatedKey' + index, '#000'])), 'editor.backgroud': '#000' } })
    expect(codes(late)).toEqual(['W_KEYS_UNUSED'])
    expect(late.problems[0].message).toMatch(/^65 keys are not used by Varia/)
  })
  it('drop variant values in single-type themes and invalid values, keeping the rest', () => {
    const result = parse({ type: 'dark', palette: { accent: { dark: '#fff' }, focus: '#fff' }, colors: { 'focusBorder': { dark: '#fff' }, 'tab.border': 'red', 'panel.border': '#123' } })
    expect(only(result)).toEqual([['W_VARIANT_NOT_DUAL', '/palette/accent'], ['W_VARIANT_NOT_DUAL', '/colors/focusBorder'], ['W_VALUE', '/colors/tab.border']])
    expect([...result.theme!.palette]).toEqual([['focus', '#fff']])
    expect([...result.theme!.colors]).toEqual([['panel.border', '#123']])
  })
  it('never lets __proto__, constructor or prototype keys through', () => {
    const json = JSON.parse('{"kind": "varia-color-theme", "version": 1, "name": "x", "type": "dark", "__proto__": {"polluted": 1}, "palette": {"__proto__": "#fff", "constructor": "#fff", "prototype": "#fff"}, "colors": {"__proto__": "#fff", "constructor": "#000", "prototype": "#000"}, "tokenColors": [{"scope": "keyword", "settings": {"__proto__": {"foreground": "#fff"}}}]}')
    const result = parseThemeFile(json, 'proto.json')
    expect(only(result)).toEqual([
      ['W_FIELD', '/__proto__'], ['W_KEY_INVALID', '/palette/__proto__'], ['W_KEY_INVALID', '/palette/constructor'], ['W_KEY_INVALID', '/palette/prototype'],
      ['W_KEY_INVALID', '/colors/__proto__'], ['W_KEY_INVALID', '/colors/constructor'], ['W_KEY_INVALID', '/colors/prototype'], ['W_SETTING', '/tokenColors/0/settings/__proto__']
    ])
    expect(result.theme!.palette.size + result.theme!.colors.size + result.theme!.rules.length).toBe(0)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(codes(parseThemeFile(JSON.parse('{"version": 1, "name": "x", "type": "dark", "constructor": "varia-color-theme"}'), 'x.json'))).toEqual(['E_KIND'])
  })
  it('sanitizes names and descriptions and reports it', () => {
    const name = 'Ev' + char(0x202e) + 'il' + char(0) + char(0x200b) + ' Theme' + char(0x2066)
    const result = parse({ name, description: 'line one\nline two', author: '  Jane ' })
    expect(result.theme).toMatchObject({ name: 'Evil Theme', description: 'line oneline two', author: 'Jane' })
    expect(only(result)).toEqual([['W_TEXT_SANITISED', '/name'], ['W_TEXT_SANITISED', '/description']])
    const empty = parse({ name: char(0x202e) + ' ' })
    expect(empty.theme!.name).toBe('test')
    expect(codes(empty)).toEqual(['W_TEXT_SANITISED', 'W_FIELD'])
    expect(codes(parse({ description: 5 }))).toEqual(['W_FIELD'])
    expect(sanitizeLabel('  a' + char(0x9f) + char(0xfeff) + 'b' + char(0x2029) + '  ', 64)).toBe('ab')
    expect(sanitizeLabel('😀'.repeat(5), 3)).toBe('😀😀😀')
    // Every other invisible character too: format characters, tags, variation selectors, and Hangul fillers.
    for (const code of [0x2060, 0xad, 0x180e, 0x2061, 0x2064, 0x206a, 0x206f, 0xfff9, 0xe0001, 0xe0041, 0xe0100, 0x34f, 0xfe0f, 0x3164, 0x115f, 0xffa0]) {
      expect(sanitizeLabel('Varia Dark' + char(code), 64), code.toString(16)).toBe('Varia Dark')
    }
    expect(only(parse({ name: 'Varia Dark' + char(0x2060) }))).toEqual([['W_TEXT_SANITISED', '/name']])
  })
  it('maps comma-separated scopes and aliases, and warns about unknown scopes and settings', () => {
    const result = parse({ tokenColors: [
      { scope: 'keyword, string ,comment.quote', settings: { foreground: '#111' } },
      { scope: ['storage.type', 'support.function', 'meta.brace', 'source.sql', 7], settings: { fontStyle: 'italic', background: '#000', foreground: '#222' } },
      { scope: 'keyword', settings: { fontStyle: 'oblique' } },
      { scope: 'keyword', settings: {}, extra: true },
      { settings: { foreground: '#333' } },
      { scope: 'keyword' },
      'keyword'
    ] })
    expect(result.theme!.rules.map(rule => [rule.scope, rule.foreground, rule.fontStyle, rule.path])).toEqual([
      ['keyword', '#111', undefined, '/tokenColors/0'], ['string', '#111', undefined, '/tokenColors/0'], ['comment.quote', '#111', undefined, '/tokenColors/0'],
      ['keyword', '#222', 'italic', '/tokenColors/1'], ['predefined', '#222', 'italic', '/tokenColors/1'], ['delimiter', '#222', 'italic', '/tokenColors/1']
    ])
    expect(only(result)).toEqual([
      ['W_SCOPE', '/tokenColors/1/scope/3'], ['W_SCOPE', '/tokenColors/1/scope/4'], ['W_SETTING', '/tokenColors/1/settings/background'],
      ['W_FONT_STYLE', '/tokenColors/2/settings/fontStyle'], ['W_FIELD', '/tokenColors/3/extra'], ['W_SCOPE', '/tokenColors/4/scope'],
      ['W_SETTING', '/tokenColors/5/settings'], ['W_FIELD', '/tokenColors/6']
    ])
  })
  it('reports a scope list once, and keeps the work for a file of warnings proportional to the cap', () => {
    const list = parse({ tokenColors: [{ scope: 'keyword, nope, , also.nope, nope', settings: { foreground: '#111' } }] })
    expect(only(list)).toEqual([['W_SCOPE', '/tokenColors/0/scope']])
    expect(list.problems[0].message).toBe('Unknown scope `nope` and 2 more ignored; docs/themes/tokens.md lists the scopes.')
    expect(list.theme!.rules.map(rule => rule.scope)).toEqual(['keyword'])
    // 31 rules of 32 scope strings that are nothing but commas: one warning per string, all but 50 only counted.
    const commas = parse({ tokenColors: Array.from({ length: 31 }, () => ({ scope: Array.from({ length: 32 }, () => ','.repeat(127)), settings: { foreground: '#fff' } })) })
    expect(commas.problems).toHaveLength(themeLimits.problemsPerFile)
    expect(commas.problems.length + commas.problemsOmitted).toBe(31 * 32)
    const values = parse({ palette: Object.fromEntries(Array.from({ length: themeLimits.palette }, (_, index) => ['slot' + index, 'red'])) })
    expect([values.problems.length, values.problemsOmitted]).toEqual([themeLimits.problemsPerFile, themeLimits.palette - themeLimits.problemsPerFile])
  })
  it.each([
    ['', true], ['italic', true], ['bold underline', true], ['italic bold underline strikethrough', true],
    ['bold bold', false], ['Bold', false], ['bold  italic', false], [' bold', false], ['bold ', false], ['oblique', false],
    ['italic bold underline strikethrough italic', false], ['bold,italic', false]
  ])('fontStyle %j is %s', (fontStyle, valid) => {
    const result = parse({ tokenColors: [{ scope: 'keyword', settings: { fontStyle } }] })
    expect(codes(result)).toEqual(valid ? [] : ['W_FONT_STYLE'])
    expect(result.theme!.rules).toHaveLength(valid ? 1 : 0)
  })
  it('writes problem paths as escaped JSON Pointers and bounds quoted text', () => {
    const result = parse({ palette: { 'a/b': '#fff' }, colors: { 'x~y': '#fff', ['k'.repeat(100)]: '#fff', ['bad' + char(0x202e)]: '#fff' }, tokenColors: [{ scope: 'keyword', settings: { foreground: 'x'.repeat(100) } }] })
    expect(result.problems.map(problem => problem.path)).toEqual([
      '/palette/a~1b', '/colors/x~0y', '/colors/' + 'k'.repeat(39) + '…', '/colors/bad\\u{202e}', '/tokenColors/0/settings/foreground'
    ])
    for (const problem of result.problems) {
      expect(problem.message.length).toBeLessThanOrEqual(themeLimits.message)
      expect(problem.message).not.toContain(char(0x202e))
      expect(problem).toMatchObject({ severity: 'warning', file: 'test.json' })
    }
    expect(result.problems[4].message).toContain('`' + 'x'.repeat(39) + '…`')
    expect(quote('a' + char(0x1b) + 'b')).toBe('`a\\u{1b}b`')
    expect([quote(5), quote(null), quote([1]), quote({})]).toEqual(['5', 'null', 'an array', 'an object'])
  })
  it('deduplicates problems, puts errors first, and counts what it drops', () => {
    const warning = createProblem('W_FIELD', 'a.json', '/x', 'm'), error = createProblem('E_JSON', '/dir/a.json', '', 'x'.repeat(400))
    expect(error).toMatchObject({ severity: 'error', file: 'a.json' })
    expect(error.message).toHaveLength(themeLimits.message)
    expect(limitProblems([warning, warning, error, warning], 1)).toEqual({ problems: [error], omitted: 1 })
    expect(limitProblems([warning, error], 5)).toEqual({ problems: [error, warning], omitted: 0 })
  })
})

describe('theme preference', () => {
  it('validates the stored preference strictly', () => {
    expect(themePreferenceSchema.parse(defaultThemePreference)).toEqual({ version: 1, mode: 'dark', darkTheme: 'varia-dark', lightTheme: 'varia-light' })
    for (const value of [
      { ...defaultThemePreference, version: 2 }, { ...defaultThemePreference, mode: 'auto' }, { ...defaultThemePreference, darkTheme: '../x' },
      { ...defaultThemePreference, lightTheme: 'Harbor' }, { ...defaultThemePreference, extra: 1 }, { ...defaultThemePreference, darkTheme: 'a'.repeat(49) }
    ]) expect(themePreferenceSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
  })
  it('accepts only non-empty patches of known fields', () => {
    expect(themePreferencePatchSchema.parse({ mode: 'system' })).toEqual({ mode: 'system' })
    expect(themePreferencePatchSchema.parse({ darkTheme: 'harbor', lightTheme: 'harbor' })).toEqual({ darkTheme: 'harbor', lightTheme: 'harbor' })
    for (const value of [{}, { mode: undefined }, { mode: 'dim' }, { darkTheme: '../x' }, { darkTheme: 'x', version: 1 }, null, 'dark'])
      expect(themePreferencePatchSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
  })
})
