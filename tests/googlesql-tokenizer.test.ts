// @vitest-environment happy-dom
// Golden files for the GoogleSQL Monarch tokenizer: each tests/fixtures/googlesql/*.sql is tokenized by the real Monaco,
// and its .tokens file pins every token. A changed tokenizer is reviewed through the .tokens diff; regenerate with
// `npx vitest run tests/googlesql-tokenizer.test.ts -u` only after reading it.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { googleSqlLanguageId, registerGoogleSql } from '../src/renderer/src/languages/googlesql'

const fixtures = join('tests', 'fixtures', 'googlesql')
let monaco: typeof Monaco

/** One line per source line, then its tokens (whitespace left out) as `scope  text`, without the shared `.sql` postfix. */
function render(text: string): string {
  const lines = text.split('\n'), out: string[] = []
  monaco.editor.tokenize(text, googleSqlLanguageId).forEach((tokens, index) => {
    const line = lines[index]
    out.push(`${index + 1}: ${line}`)
    tokens.forEach((token, at) => {
      const end = tokens[at + 1]?.offset ?? line.length, value = line.slice(token.offset, end)
      if (token.type === 'white.sql' || !value) return
      out.push(`    ${(token.type.replace(/\.sql$/, '') || '(text)').padEnd(22)} ${value}`)
    })
  })
  return out.join('\n') + '\n'
}

beforeAll(async () => {
  monaco = await import('monaco-editor/editor/editor.api.js')
  registerGoogleSql(monaco)
})

describe('GoogleSQL tokenizer golden files', () => {
  const files = readdirSync(fixtures).filter(file => file.endsWith('.sql')).sort()
  it('has one golden file per area the plan names', () => {
    expect(files).toEqual(['comments.sql', 'functions.sql', 'identifiers.sql', 'literals.sql', 'scripting.sql', 'types.sql'])
  })
  for (const file of files) {
    it(file, async () => {
      const text = readFileSync(join(fixtures, file), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
      await expect(render(text)).toMatchFileSnapshot(join('fixtures', 'googlesql', file.replace(/\.sql$/, '.tokens')))
    })
  }
  it('emits only the SQL colour scopes, so every token has a theme rule', () => {
    const scopes = new Set<string>()
    for (const file of files) for (const line of monaco.editor.tokenize(readFileSync(join(fixtures, file), 'utf8'), googleSqlLanguageId)) for (const token of line) scopes.add(token.type)
    expect([...scopes].filter(scope => scope !== '' && !scope.endsWith('.sql'))).toEqual([])
  })
})
