import { describe, expect, it } from 'vitest'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { parseThemeFile } from '../src/shared/theme/format'
import { toMonacoTheme } from '../src/shared/theme/monaco'
import { colorKeys, sqlScopes } from '../src/shared/theme/registry'
import { resolveBuiltin, resolveTheme } from '../src/shared/theme/resolve'

type Action = string | { token?: string; cases?: Record<string, Action> } | Action[]
interface Language { tokenPostfix: string; defaultToken: string; brackets: { token: string }[]; tokenizer: Record<string, (unknown[] | { include: string })[]> }

/** Every token Monaco's SQL tokenizer can emit, read from the installed monaco-editor so an upgrade cannot drift silently. */
async function sqlTokens(): Promise<Set<string>> {
  const specifier = 'monaco-editor/languages/definitions/sql/sql.js'
  const { language } = await import(specifier) as { language: Language }
  const tokens = new Set<string>()
  const collect = (action: Action): void => {
    if (Array.isArray(action)) action.forEach(collect)
    else if (typeof action === 'string') {
      if (action === '@brackets') language.brackets.forEach(bracket => tokens.add(bracket.token))
      else if (action && !action.startsWith('@')) tokens.add(action)
    } else {
      if (action.token !== undefined) collect(action.token)
      if (action.cases) Object.values(action.cases).forEach(collect)
    }
  }
  for (const rules of Object.values(language.tokenizer)) for (const rule of rules) if (Array.isArray(rule)) collect(rule[1] as Action)
  expect(language.tokenPostfix).toBe('.sql')
  expect(language.defaultToken).toBe('')
  return new Set([...tokens].map(token => token + language.tokenPostfix))
}

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
  it('carries every color key, opaque rule colors without "#", and the base of the type', () => {
    for (const type of ['dark', 'light'] as const) {
      const theme = resolveBuiltin(type)
      const data: Monaco.editor.IStandaloneThemeData = toMonacoTheme(theme)
      expect(data.base).toBe(type === 'dark' ? 'vs-dark' : 'vs')
      expect(data.inherit).toBe(true)
      expect(Object.keys(data.colors)).toHaveLength(196)
      expect(Object.keys(data.colors)).toEqual([...colorKeys])
      for (const value of Object.values(data.colors)) expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
      expect(data.rules[0]).toEqual({ token: '', foreground: theme.colors['editor.foreground'].slice(1), background: theme.colors['editor.background'].slice(1) })
      expect(data.rules).toHaveLength(17)
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
    expect(data.rules.filter(rule => rule.token.startsWith('comment')).map(rule => rule.fontStyle)).toEqual(['italic underline', 'italic underline'])
  })
})
