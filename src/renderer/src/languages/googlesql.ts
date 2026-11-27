import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import {
  googleSqlFunction, googleSqlFunctions, googleSqlKeywords, googleSqlNiladicFunctions, googleSqlOperatorWords, googleSqlReservedKeywords, googleSqlTypes,
  parameterFor, signatureLabel
} from '../../../shared/googlesql/catalog'
import { googleSqlCallContext } from '../../../shared/googlesql/lexer'
import { languageLimits } from '../../../shared/language-service'

/** BigQuery query documents' Monaco language; SQL Server's stay `sql` (documents.ts `queryLanguages`). */
export const googleSqlLanguageId = 'googlesql'

const operators = new Set<string>(googleSqlOperatorWords)
const functionNames = googleSqlFunctions.map(entry => entry.name)
/** Namespaced functions' namespaces (`NET.HOST`); `SAFE.` is a keyword prefix of any function instead. */
const namespaces = [...new Set(functionNames.filter(name => name.includes('.')).map(name => name.slice(0, name.indexOf('.'))))]

/**
 * GoogleSQL's Monarch tokenizer. Its tokens end in `.sql`, the SQL colour scopes (src/shared/theme/registry.ts
 * `sqlScopes`), so themes and the user's syntax colours apply to both languages alike, and it emits only those scopes
 * (tests/theme-monaco.test.ts). Golden files in tests/fixtures/googlesql/ pin what it emits.
 */
export const googleSqlLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.sql',
  ignoreCase: true,
  brackets: [
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' }
  ],
  keywords: [...new Set([...googleSqlReservedKeywords, ...googleSqlKeywords, ...googleSqlTypes])].filter(word => !operators.has(word)),
  types: [...googleSqlTypes],
  operators: [...googleSqlOperatorWords],
  // A function name is a function only where it is called: many (DATE, LEFT, FORMAT) are common column names too.
  functions: [...new Set(functionNames.map(name => name.slice(name.lastIndexOf('.') + 1)))],
  niladic: [...googleSqlNiladicFunctions],
  namespaces,
  tokenizer: {
    root: [
      { include: '@whitespace' },
      { include: '@comments' },
      { include: '@strings' },
      [/`(?:[^`\\]|\\.|\\$)*`?/, 'identifier.quote'],
      // `@` is Monarch's attribute sigil in a rule's regex, so a literal one is written as a class.
      [/[@][@][A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/, 'predefined'],
      [/[@][A-Za-z_]\w*/, 'identifier'],
      { include: '@numbers' },
      [/(ARRAY|STRUCT|RANGE)(\s*)(<)/, ['keyword', 'white', { token: 'delimiter', next: '@typeArguments' }]],
      // `SAFE.` prefixes a namespaced function too (`SAFE.NET.HOST(`), whose name the next rule colours.
      [/(SAFE)(\.)(?=[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?\s*\()/, ['keyword', 'delimiter']],
      [/([A-Za-z_]\w*)(\.)([A-Za-z_]\w*)(?=\s*\()/, [{ cases: { '@namespaces': 'predefined', '@default': 'identifier' } }, 'delimiter', { cases: { '$1@namespaces': 'predefined', '@default': 'identifier' } }]],
      // A name after a dot is a column, field or table, even when it spells a keyword (`t.date`, `s.range`).
      [/(\.)([A-Za-z_]\w*)/, ['delimiter', 'identifier']],
      [/[A-Za-z_]\w*(?=\s*\()/, { cases: { '@functions': 'predefined', '@operators': 'operator', '@keywords': 'keyword', '@default': 'identifier' } }],
      [/[A-Za-z_]\w*/, { cases: { '@niladic': 'predefined', '@operators': 'operator', '@keywords': 'keyword', '@default': 'identifier' } }],
      [/[()[\]]/, '@brackets'],
      [/[;,.{}]/, 'delimiter'],
      [/[<>=!%&+\-*/|~^?:@]/, 'operator']
    ],
    whitespace: [[/\s+/, 'white']],
    comments: [
      [/(?:--|#).*$/, 'comment'],
      [/\/\*/, { token: 'comment.quote', next: '@blockComment' }]
    ],
    blockComment: [
      [/[^*/]+/, 'comment'],
      [/\*\//, { token: 'comment.quote', next: '@pop' }],
      [/[*/]/, 'comment']
    ],
    // r, b, rb and br prefixes; triple-quoted strings span lines, the others end at their line's end when unclosed. A
    // backslash keeps the next character in the string, raw strings included.
    strings: [
      [/(?:rb|br|r|b)?'''/, { token: 'string', next: '@tripleSingle' }],
      [/(?:rb|br|r|b)?"""/, { token: 'string', next: '@tripleDouble' }],
      [/(?:rb|br|r|b)?'(?:[^'\\]|\\.|\\$)*'?/, 'string'],
      [/(?:rb|br|r|b)?"(?:[^"\\]|\\.|\\$)*"?/, 'string']
    ],
    tripleSingle: [
      [/[^'\\]+/, 'string'],
      [/\\.?/, 'string'],
      [/'''/, { token: 'string', next: '@pop' }],
      [/'/, 'string']
    ],
    tripleDouble: [
      [/[^"\\]+/, 'string'],
      [/\\.?/, 'string'],
      [/"""/, { token: 'string', next: '@pop' }],
      [/"/, 'string']
    ],
    numbers: [
      [/0x[0-9a-f]+/, 'number'],
      [/(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/, 'number']
    ],
    // Inside `STRUCT<…>`, `ARRAY<…>` and `RANGE<…>`: type names as keywords, field names as identifiers, nested types
    // pushed, and `>` closing one level (so `>>` closes two).
    typeArguments: [
      { include: '@whitespace' },
      { include: '@comments' },
      [/(ARRAY|STRUCT|RANGE)(\s*)(<)/, ['keyword', 'white', { token: 'delimiter', next: '@push' }]],
      [/>/, { token: 'delimiter', next: '@pop' }],
      [/`(?:[^`\\]|\\.|\\$)*`?/, 'identifier.quote'],
      { include: '@strings' },
      { include: '@numbers' },
      [/[A-Za-z_]\w*/, { cases: { '@types': 'keyword', '@keywords': 'keyword', '@default': 'identifier' } }],
      [/[()]/, '@brackets'],
      [/[,.]/, 'delimiter'],
      [/[<=!%&+\-*/|~^?:@[\]{};]/, 'operator']
    ]
  }
}

/** Comments for Toggle Comment (`--`, which GoogleSQL reads as `#` too), and the brackets and quotes that pair. */
export const googleSqlConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '--', blockComment: ['/*', '*/'] },
  brackets: [['(', ')'], ['[', ']']],
  wordPattern: /(?<![A-Za-z0-9_`])(-?\d*\.\d\w*)|((?:[A-Za-z_][A-Za-z0-9_]*|\d+[A-Za-z_][A-Za-z0-9_]*)(?:-[A-Za-z0-9_]+)+)|([^\`\~\!\@\#\$\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '\'', close: '\'', notIn: ['string', 'comment'] },
    { open: '"', close: '"', notIn: ['string', 'comment'] },
    { open: '`', close: '`', notIn: ['string', 'comment'] }
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '\'', close: '\'' },
    { open: '"', close: '"' },
    { open: '`', close: '`' }
  ]
}

/**
 * Signature help for the call the caret is in, from the function catalogue: every signature of the function, the one
 * whose parameters reach the caret's argument active, and that parameter highlighted. Undefined outside a known
 * function's call, or in a string or comment. `text` is the document up to the caret. `previous` is the help already
 * showing: a signature the user stepped to (Up/Down) for the same function stays active while it reaches the argument.
 */
export function googleSqlSignatureHelp(text: string, previous?: Monaco.languages.SignatureHelp): Monaco.languages.SignatureHelp | undefined {
  const call = googleSqlCallContext(text, text.length)
  const entry = call ? googleSqlFunction(call.name) : undefined
  if (!call || !entry) return undefined
  const signatures = entry.signatures.map(signature => {
    const { label, parameters } = signatureLabel(entry.name, signature)
    return { label, documentation: entry.summary, parameters: parameters.map(range => ({ label: range })) }
  })
  const kept = previous && previous.signatures.length === signatures.length && previous.signatures.every((signature, index) => signature.label === signatures[index].label)
    && parameterFor(entry.signatures[previous.activeSignature] ?? { parameters: [], returns: '' }, call.argument) !== undefined ? previous.activeSignature : -1
  const active = kept >= 0 ? kept : Math.max(0, entry.signatures.findIndex(signature => parameterFor(signature, call.argument) !== undefined))
  const parameter = parameterFor(entry.signatures[active], call.argument)
  return { signatures, activeSignature: active, activeParameter: parameter ?? entry.signatures[active].parameters.length }
}

export const googleSqlSignatureHelpProvider: Monaco.languages.SignatureHelpProvider = {
  signatureHelpTriggerCharacters: ['(', ','],
  signatureHelpRetriggerCharacters: [')'],
  provideSignatureHelp(model, position, _token, context) {
    // As for SQL Server's language services, a document over the limit gets none.
    if (model.getValueLength() > languageLimits.documentCharacters) return null
    const help = googleSqlSignatureHelp(model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column }), context.activeSignatureHelp)
    return help ? { value: help, dispose: () => {} } : null
  }
}

/** Registers the `googlesql` language: no file extension (a .sql file opens as Transact-SQL until a BigQuery connection). */
export function registerGoogleSql(monaco: typeof Monaco): Monaco.IDisposable {
  monaco.languages.register({ id: googleSqlLanguageId, aliases: ['GoogleSQL', 'googlesql'] })
  const registrations = [
    monaco.languages.setMonarchTokensProvider(googleSqlLanguageId, googleSqlLanguage),
    monaco.languages.setLanguageConfiguration(googleSqlLanguageId, googleSqlConfiguration),
    monaco.languages.registerSignatureHelpProvider(googleSqlLanguageId, googleSqlSignatureHelpProvider)
  ]
  return { dispose: () => { for (const registration of registrations) registration.dispose() } }
}
