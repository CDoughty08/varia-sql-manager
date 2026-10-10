import type * as Monaco from 'monaco-editor/editor/editor.api.js'

// JSON values opened from the results grid are coloured by this Monarch tokenizer alone. Monaco's JSON language service
// would bring its own worker and validation, which a value read from the database does not need.

/** Its tokens, with `.json` appended, are coloured by `documentTokenScopes` (src/shared/theme/monaco.ts). */
export const jsonLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.json',
  tokenizer: {
    root: [
      [/[ \t\r\n]+/, ''],
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
      [/"(?:[^"\\]|\\.)*"/, 'string.value'],
      [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/(?:true|false|null)\b/, 'keyword'],
      [/[{}]/, 'delimiter.bracket'],
      [/[[\]]/, 'delimiter.array'],
      [/:/, 'delimiter.colon'],
      [/,/, 'delimiter.comma']
    ]
  }
}
export const jsonConfiguration: Monaco.languages.LanguageConfiguration = {
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }],
  surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"' }]
}

/** Registers the `json` language for value documents. */
export function registerJson(monaco: typeof Monaco): void {
  monaco.languages.register({ id: 'json', extensions: ['.json'], aliases: ['JSON', 'json'] })
  monaco.languages.setMonarchTokensProvider('json', jsonLanguage)
  monaco.languages.setLanguageConfiguration('json', jsonConfiguration)
}
