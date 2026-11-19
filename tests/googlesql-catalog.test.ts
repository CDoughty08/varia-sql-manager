import { describe, expect, it } from 'vitest'
import {
  googleSqlCategories, googleSqlFunction, googleSqlFunctions, googleSqlKeywords, googleSqlNiladicFunctions, googleSqlOperatorWords, googleSqlReservedKeywords,
  googleSqlTypes, parameterFor, signatureLabel
} from '../src/shared/googlesql/catalog'
import { renderGoogleSqlDocs } from '../src/shared/googlesql/docs'
import { googleSqlCallContext, scanGoogleSql } from '../src/shared/googlesql/lexer'
import { googleSqlConfiguration, googleSqlLanguage, googleSqlSignatureHelp, googleSqlSignatureHelpProvider } from '../src/renderer/src/languages/googlesql'

const unique = (list: readonly string[]) => new Set(list).size === list.length

describe('GoogleSQL catalogue', () => {
  it('lists each word once, in upper case, with GoogleSQL\'s reserved keywords kept apart from the others', () => {
    for (const list of [googleSqlReservedKeywords, googleSqlKeywords, googleSqlTypes, googleSqlOperatorWords, googleSqlNiladicFunctions]) {
      expect(unique(list)).toBe(true)
      for (const word of list) expect(word, word).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
    expect(googleSqlKeywords.filter(word => (googleSqlReservedKeywords as readonly string[]).includes(word))).toEqual([])
    // Every operator word is a reserved keyword.
    for (const word of googleSqlOperatorWords) expect(googleSqlReservedKeywords as readonly string[], word).toContain(word)
    for (const word of ['SELECT', 'QUALIFY', 'UNNEST', 'STRUCT', 'TABLESAMPLE', 'ASSERT_ROWS_MODIFIED']) expect(googleSqlReservedKeywords as readonly string[]).toContain(word)
  })

  it('gives every function a category, a summary sentence and well-formed signatures', () => {
    expect(unique(googleSqlFunctions.map(entry => entry.name))).toBe(true)
    expect(googleSqlFunctions.length).toBeGreaterThan(250)
    for (const entry of googleSqlFunctions) {
      expect(entry.name, entry.name).toMatch(/^(?:[A-Z][A-Z0-9_]*\.)?[A-Z][A-Z0-9_]*$/)
      expect(Object.keys(googleSqlCategories), entry.name).toContain(entry.category)
      expect(entry.summary, entry.name).toMatch(/^[A-Z].*\.$/)
      expect(entry.summary.length, entry.name).toBeLessThanOrEqual(120)
      expect(entry.signatures.length, entry.name).toBeGreaterThan(0)
      for (const signature of entry.signatures) {
        expect(signature.returns, entry.name).not.toBe('')
        expect(signature.parameters.every(parameter => parameter.length > 0), entry.name).toBe(true)
        // `...` repeats the parameter before it, so it is never first, and comes once at the end.
        const repeat = signature.parameters.indexOf('...')
        if (repeat >= 0) expect([repeat > 0, repeat === signature.parameters.length - 1], entry.name).toEqual([true, true])
      }
    }
    for (const category of Object.keys(googleSqlCategories)) expect(googleSqlFunctions.some(entry => entry.category === category), category).toBe(true)
    // Each function without parentheses is in the catalogue too.
    for (const name of googleSqlNiladicFunctions) expect(googleSqlFunction(name), name).toBeDefined()
  })

  it('finds a function in any case, with its namespace, and through SAFE.', () => {
    expect(googleSqlFunction('substr')?.name).toBe('SUBSTR')
    expect(googleSqlFunction('Net.Host')?.name).toBe('NET.HOST')
    expect(googleSqlFunction('SAFE.substr')?.name).toBe('SUBSTR')
    expect(googleSqlFunction('safe.net.ip_from_string')?.name).toBe('NET.IP_FROM_STRING')
    expect([googleSqlFunction('host'), googleSqlFunction('my_udf'), googleSqlFunction('SAFE')]).toEqual([undefined, undefined, undefined])
  })

  it('labels signatures with each parameter\'s place, and maps arguments to parameters, repeats included', () => {
    const substr = googleSqlFunction('SUBSTR')!.signatures[0]
    const { label, parameters } = signatureLabel('SUBSTR', substr)
    expect(label).toBe('SUBSTR(value, position, [length]) → STRING or BYTES')
    expect(parameters.map(([start, end]) => label.slice(start, end))).toEqual(['value', 'position', '[length]'])
    expect([0, 1, 2, 3].map(argument => parameterFor(substr, argument))).toEqual([0, 1, 2, undefined])
    const concat = googleSqlFunction('CONCAT')!.signatures[0]
    expect(concat.parameters).toEqual(['value', '...'])
    expect([0, 1, 5].map(argument => parameterFor(concat, argument))).toEqual([0, 0, 0])
    expect(signatureLabel('CURRENT_TIMESTAMP', googleSqlFunction('CURRENT_TIMESTAMP')!.signatures[0]).label).toBe('CURRENT_TIMESTAMP() → TIMESTAMP')
    // Commas inside a parameter's own brackets or types stay in it.
    expect(googleSqlFunction('JSON_KEYS')!.signatures[0].parameters).toEqual(['json_expr', '[max_depth]', '[mode => {\'strict\' | \'lax\' | \'lax recursive\'}]'])
    expect(googleSqlFunction('APPROX_TOP_COUNT')!.signatures[0].returns).toBe('ARRAY<STRUCT<value, count INT64>>')
  })

  it('feeds the tokenizer its words, so it colours what the catalogue lists', () => {
    const language = googleSqlLanguage as unknown as Record<string, string[]>
    for (const word of [...googleSqlReservedKeywords, ...googleSqlKeywords, ...googleSqlTypes]) {
      expect([...language.keywords, ...language.operators], word).toContain(word)
    }
    expect(language.operators).toEqual([...googleSqlOperatorWords])
    for (const entry of googleSqlFunctions) expect(language.functions, entry.name).toContain(entry.name.slice(entry.name.lastIndexOf('.') + 1))
    expect(language.namespaces.sort()).toEqual(['AEAD', 'HLL_COUNT', 'KEYS', 'NET'])
    expect(googleSqlConfiguration.comments).toEqual({ lineComment: '--', blockComment: ['/*', '*/'] })
    expect(googleSqlConfiguration.autoClosingPairs?.map(pair => pair.open)).toEqual(['(', '[', '\'', '"', '`'])
  })

  it('keeps docs/googlesql.md in sync', async () => {
    await expect(renderGoogleSqlDocs()).toMatchFileSnapshot('../docs/googlesql.md')
  })
})

describe('GoogleSQL scanner', () => {
  const kinds = (text: string) => scanGoogleSql(text).filter(token => token.kind !== 'whitespace').map(token => `${token.kind}:${text.slice(token.start, token.end)}${token.open ? '…' : ''}`)
  it('covers the text without gaps and reads GoogleSQL\'s literals, names and comments', () => {
    const text = "SELECT r'a\\'b', b\"\"\"x\ny\"\"\", `p-1.d.t`, @x, @@a.b, .5e3, 0xFF -- c\n#h\n/* b */ 'open"
    const tokens = scanGoogleSql(text)
    expect(tokens.map(token => text.slice(token.start, token.end)).join('')).toBe(text)
    expect(kinds(text)).toEqual(['word:SELECT', "string:r'a\\'b'", 'punctuation:,', 'string:b"""x\ny"""', 'punctuation:,', 'quotedIdentifier:`p-1.d.t`', 'punctuation:,', 'parameter:@x', 'punctuation:,',
      'systemVariable:@@a.b', 'punctuation:,', 'number:.5e3', 'punctuation:,', 'number:0xFF', 'comment:-- c…', 'comment:#h…', 'comment:/* b */', "string:'open…"])
    // A single-quoted string ends at its line's end when unclosed; a word ending in a prefix letter is a word.
    expect(kinds("'a\nb")).toEqual(["string:'a…", 'word:b'])
    expect(kinds("ab'c'")).toEqual(['word:ab', "string:'c'"])
    expect(kinds("rr'x'")).toEqual(['word:rr', "string:'x'"])
  })
})

describe('GoogleSQL call context and signature help', () => {
  const at = (text: string) => { const caret = text.indexOf('|'); return googleSqlCallContext(text.replace('|', ''), caret) }
  it('finds the innermost named call and the argument the caret is in', () => {
    expect(at('SELECT SUBSTR(|')).toEqual({ name: 'SUBSTR', argument: 0, open: 13 })
    expect(at('SELECT SUBSTR(name, |')).toMatchObject({ name: 'SUBSTR', argument: 1 })
    expect(at('SELECT SUBSTR(UPPER(name), 2, |')).toMatchObject({ name: 'SUBSTR', argument: 2 })
    expect(at('SELECT SUBSTR(UPPER(name|')).toMatchObject({ name: 'UPPER', argument: 0 })
    expect(at('SELECT net.host (url|')).toMatchObject({ name: 'net.host', argument: 0 })
    expect(at('SELECT SAFE.SUBSTR(a, |')).toMatchObject({ name: 'SAFE.SUBSTR', argument: 1 })
    // Reserved keywords that are functions too are calls; a user's function is a call the catalogue does not know.
    expect([at('SELECT IF(a, |')?.name, at('SELECT CAST(|')?.name, at('SELECT my_ds.fn(a, |')?.name]).toEqual(['IF', 'CAST', 'my_ds.fn'])
    // Commas in nested brackets, array literals and STRUCT<…> types are not the call's.
    expect(at('SELECT IF(x IN (1, 2, 3), [4, 5], |')).toMatchObject({ name: 'IF', argument: 2 })
    expect(at('SELECT CAST(x AS STRUCT<a INT64, b STRING>|')).toMatchObject({ name: 'CAST', argument: 0 })
    expect(at('SELECT COALESCE(a, ARRAY<INT64>[1, 2], |')).toMatchObject({ name: 'COALESCE', argument: 2 })
    // A field named like a type after a dot is compared, not given type arguments.
    for (const text of ['SELECT IF(t.range < 5, a, |', 'SELECT IF(`p.d.t`.range < 5, a, |', 'SELECT IF(f(x).array < 5, a, |', 'SELECT IF(arr[OFFSET(0)].struct < 5, a, |', 'SELECT IF(@p.range < 5, a, |']) {
      expect(at(text), text).toMatchObject({ name: 'IF', argument: 2 })
    }
    // A backslash at a line's end does not carry a single-quoted string onto the next line.
    expect(at("SELECT IF(x, 'a\\\n, |")).toMatchObject({ name: 'IF', argument: 2 })
    // Commas and parentheses inside strings, comments and quoted names are text.
    expect(at("SELECT CONCAT('a, (b', /* , ) */ `c,)`, |")).toMatchObject({ name: 'CONCAT', argument: 2 })
    expect(at('SELECT CONCAT(a, -- x, y\n b, |')).toMatchObject({ name: 'CONCAT', argument: 2 })
  })
  it('is undefined outside a call, after it closes, in an unnamed parenthesis, or in a string or comment', () => {
    for (const text of ['SELECT |', 'SELECT SUBSTR(a, 1)|', 'SELECT (a, |', 'SELECT x IN (1, |', 'SELECT ROW_NUMBER() OVER (PARTITION BY a, |', 'SELECT CONCAT(\'a, |', 'SELECT CONCAT(a -- note (b, |', 'SELECT CONCAT(a /* (b, |', 'SELECT CONCAT((SELECT |', 'SELECT `fn(|']) {
      expect(at(text), text).toBeUndefined()
    }
  })
  it('shows the function\'s signatures with the active one and parameter', () => {
    const help = googleSqlSignatureHelp('SELECT SUBSTR(name, ')!
    expect(help.signatures.map(signature => signature.label)).toEqual(['SUBSTR(value, position, [length]) → STRING or BYTES'])
    expect([help.activeSignature, help.activeParameter]).toEqual([0, 1])
    expect(help.signatures[0].documentation).toBe('Returns part of a value from a position, of an optional length.')
    // DATE has three forms: the third argument fits only the first; the first argument fits all of them.
    expect(googleSqlSignatureHelp('SELECT DATE(2026, 11, ')).toMatchObject({ activeSignature: 0, activeParameter: 2 })
    expect(googleSqlSignatureHelp('SELECT DATE(ts, ')).toMatchObject({ activeSignature: 0, activeParameter: 1 })
    expect(googleSqlSignatureHelp('SELECT DATE(')!.signatures).toHaveLength(3)
    // Past the last parameter, nothing is highlighted; a repeated parameter stays highlighted.
    expect(googleSqlSignatureHelp('SELECT SUBSTR(a, 1, 2, ')).toMatchObject({ activeSignature: 0, activeParameter: 3 })
    expect(googleSqlSignatureHelp('SELECT CONCAT(a, b, c, ')).toMatchObject({ activeParameter: 0 })
    expect(googleSqlSignatureHelp('SELECT SAFE.NET.HOST(')!.signatures[0].label).toBe('NET.HOST(url) → STRING')
    for (const text of ['SELECT my_udf(', 'SELECT x IN (', 'SELECT ']) expect(googleSqlSignatureHelp(text), text).toBeUndefined()
  })
  it('keeps the signature the user stepped to while it still reaches the argument', () => {
    const shown = googleSqlSignatureHelp('SELECT DATE(')!
    expect(googleSqlSignatureHelp('SELECT DATE(ts, ', { ...shown, activeSignature: 1 })).toMatchObject({ activeSignature: 1, activeParameter: 1 })
    // Past that signature's parameters, or for another function, the first that fits is active again.
    expect(googleSqlSignatureHelp('SELECT DATE(a, b, ', { ...shown, activeSignature: 1 })).toMatchObject({ activeSignature: 0, activeParameter: 2 })
    expect(googleSqlSignatureHelp('SELECT SUBSTR(a, ', { ...shown, activeSignature: 1 })).toMatchObject({ activeSignature: 0 })
  })
  it('answers through Monaco\'s provider on ( and ,, and gives none for a document over the language limit', () => {
    expect(googleSqlSignatureHelpProvider.signatureHelpTriggerCharacters).toEqual(['(', ','])
    const model = (text: string) => ({ getValueLength: () => text.length, getValueInRange: () => text }) as never
    const position = { lineNumber: 1, column: 1 } as never, token = {} as never, context = {} as never
    const answer = googleSqlSignatureHelpProvider.provideSignatureHelp(model('SELECT LEFT('), position, token, context) as { value: { signatures: { label: string }[] } }
    expect(answer.value.signatures[0].label).toBe('LEFT(value, length) → STRING or BYTES')
    expect(googleSqlSignatureHelpProvider.provideSignatureHelp(model('SELECT LEFT(' + ' '.repeat(250_000)), position, token, context)).toBeNull()
    // The help already showing reaches the catalogue, so a signature the user stepped to stays active.
    const shown = { ...googleSqlSignatureHelp('SELECT DATE(')!, activeSignature: 1 }
    const kept = googleSqlSignatureHelpProvider.provideSignatureHelp(model('SELECT DATE(ts, '), position, token, { activeSignatureHelp: shown } as never) as { value: { activeSignature: number } }
    expect(kept.value.activeSignature).toBe(1)
  })
})
