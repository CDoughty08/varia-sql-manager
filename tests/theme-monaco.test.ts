import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { parseThemeFile } from '../src/shared/theme/format'
import { documentTokenScopes, toMonacoTheme } from '../src/shared/theme/monaco'
import { jsonLanguage } from '../src/renderer/src/languages/json'
import { colorKeys, sqlScopes } from '../src/shared/theme/registry'
import { resolveBuiltin, resolveTheme } from '../src/shared/theme/resolve'

type Action = string | { token?: string; cases?: Record<string, Action> } | Action[]
interface Language { tokenPostfix?: string; defaultToken?: string; brackets?: { token: string }[]; tokenizer: Record<string, (unknown[] | { include: string })[]> }

/** Every token a Monarch tokenizer can emit, with its postfix; '' (plain text) is left out. */
function tokensOf(language: Language): Set<string> {
  const tokens = new Set<string>()
  const collect = (action: Action): void => {
    if (Array.isArray(action)) action.forEach(collect)
    else if (typeof action === 'string') {
      if (action === '@brackets') language.brackets?.forEach(bracket => tokens.add(bracket.token))
      else if (action && !action.startsWith('@')) tokens.add(action)
    } else {
      if (action.token !== undefined) collect(action.token)
      if (action.cases) Object.values(action.cases).forEach(collect)
    }
  }
  for (const rules of Object.values(language.tokenizer)) for (const rule of rules) if (Array.isArray(rule)) collect(rule[1] as Action)
  expect(language.defaultToken).toBe('')
  return new Set([...tokens].map(token => token + language.tokenPostfix))
}
/**
 * Every token one of Monaco's tokenizers can emit, read from the installed monaco-editor so an upgrade cannot drift
 * silently. The XML module imports the browser-only editor API (for its indent rules), so its source is evaluated
 * without that import.
 */
async function monacoTokens(name: 'sql' | 'xml'): Promise<Set<string>> {
  let language: Language
  if (name === 'sql') ({ language } = await import('monaco-editor/languages/definitions/sql/sql.js' as string) as { language: Language })
  else {
    const source = readFileSync(join('node_modules', 'monaco-editor', 'esm', 'vs', 'languages', 'definitions', 'xml', 'xml.js'), 'utf8')
    const body = source.replace(/^import .*$/m, 'const languages = { IndentAction: {} };').replace(/^export \{ conf, language \};$/m, 'return language;')
    expect(body).not.toBe(source)
    language = new Function(body)() as Language
  }
  expect(language.tokenPostfix).toBe('.' + name)
  return tokensOf(language)
}
const sqlTokens = () => monacoTokens('sql')

describe('Monaco theme', () => {
  it('has an exact rule for every token the SQL tokenizer emits except whitespace', async () => {
    const emitted = await sqlTokens()
    expect(emitted.has('white.sql')).toBe(true)
    emitted.delete('white.sql')
    expect([...emitted].sort()).toEqual(sqlScopes.map(scope => scope + '.sql').sort())
    for (const type of ['dark', 'light'] as const) {
      const data = toMonacoTheme(resolveBuiltin(type))
      const tokens = data.rules.map(rule => rule.token)
      for (const token of emitted) expect(tokens.filter(value => value === token), token).toHaveLength(1)
    }
  })
  it('colours every token of the XML and JSON tokenizers exactly once, as the SQL scope it stands for', async () => {
    const emitted = [...await monacoTokens('xml'), ...tokensOf(jsonLanguage as Language)]
    expect(emitted.sort()).toEqual(Object.keys(documentTokenScopes).sort())
    for (const type of ['dark', 'light'] as const) {
      const theme = resolveBuiltin(type), data = toMonacoTheme(theme)
      for (const token of emitted) {
        const rules = data.rules.filter(rule => rule.token === token), scope = documentTokenScopes[token]
        expect(rules, token).toEqual([{ token, foreground: theme.syntax[scope].foreground.slice(1), fontStyle: theme.syntax[scope].fontStyle }])
      }
      // Tags and JSON literals are keywords; names are identifiers; values are strings.
      expect(data.rules.find(rule => rule.token === 'tag.xml')?.foreground).toBe(data.rules.find(rule => rule.token === 'keyword.sql')?.foreground)
      expect(data.rules.find(rule => rule.token === 'string.key.json')?.foreground).toBe(data.rules.find(rule => rule.token === 'identifier.sql')?.foreground)
      expect(data.rules.find(rule => rule.token === 'attribute.value.xml')?.foreground).toBe(data.rules.find(rule => rule.token === 'string.sql')?.foreground)
    }
  })
  it('carries every color key, opaque rule colors without "#", and the base of the type', () => {
    for (const type of ['dark', 'light'] as const) {
      const theme = resolveBuiltin(type)
      const data: Monaco.editor.IStandaloneThemeData = toMonacoTheme(theme)
      expect(data.base).toBe(type === 'dark' ? 'vs-dark' : 'vs')
      expect(data.inherit).toBe(true)
      expect(Object.keys(data.colors)).toHaveLength(205)
      expect(Object.keys(data.colors)).toEqual([...colorKeys])
      for (const value of Object.values(data.colors)) expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
      expect(data.rules[0]).toEqual({ token: '', foreground: theme.colors['editor.foreground'].slice(1), background: theme.colors['editor.background'].slice(1) })
      expect(data.rules).toHaveLength(17 + Object.keys(documentTokenScopes).length)
      for (const rule of data.rules) {
        expect(rule.foreground).toMatch(/^[0-9a-f]{6}$/)
        if (rule.background !== undefined) expect(rule.background).toMatch(/^[0-9a-f]{6}$/)
      }
    }
    expect(toMonacoTheme(resolveBuiltin('dark')).rules.find(rule => rule.token === 'string.sql')).toEqual({ token: 'string.sql', foreground: 'ff4040', fontStyle: '' })
  })
  it('makes a translucent editor foreground opaque and passes font styles through', () => {
    const parsed = parseThemeFile({ kind: 'varia-color-theme', version: 1, name: 'x', type: 'dark', colors: { 'editor.foreground': '#ffffff80' },
      tokenColors: [{ scope: 'comment', settings: { fontStyle: 'italic underline' } }] }, 'x.json').theme!
    const data = toMonacoTheme(resolveTheme([parsed], 'dark').theme)
    expect(data.rules[0]).toEqual({ token: '', foreground: '888a8e', background: '11151c' })
    expect(data.colors['editor.foreground']).toBe('#ffffff80')
    // comment.sql, comment.quote.sql, and the three XML comment tokens.
    expect(data.rules.filter(rule => rule.token.startsWith('comment')).map(rule => rule.fontStyle)).toEqual(Array(5).fill('italic underline'))
  })
})
