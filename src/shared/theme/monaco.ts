import { composite, hexColor, opaqueHex } from './color'
import { colorKeys, sqlScopes, type SqlScope } from './registry'
import type { ResolvedTheme } from './types'

export interface MonacoTokenRule { token: string; foreground?: string; background?: string; fontStyle?: string }
/** Structurally an `IStandaloneThemeData`, so shared code needs no Monaco import. */
export interface MonacoThemeData { base: 'vs' | 'vs-dark'; inherit: boolean; rules: MonacoTokenRule[]; colors: Record<string, string> }

/**
 * The tokens of Monaco's XML tokenizer and of the renderer's JSON tokenizer (languages/json.ts), each coloured as a SQL
 * scope: tags and JSON literals as keywords, names as identifiers, values as strings.
 */
export const documentTokenScopes: Readonly<Record<string, SqlScope>> = {
  'tag.xml': 'keyword', 'metatag.xml': 'keyword', 'attribute.name.xml': 'identifier', 'attribute.value.xml': 'string', 'string.escape.xml': 'string',
  'comment.xml': 'comment', 'comment.content.xml': 'comment', 'comment.content.invalid.xml': 'comment', 'delimiter.xml': 'delimiter', 'delimiter.cdata.xml': 'delimiter',
  'keyword.json': 'keyword', 'string.key.json': 'identifier', 'string.value.json': 'string', 'number.json': 'number',
  'delimiter.bracket.json': 'delimiter', 'delimiter.array.json': 'delimiter', 'delimiter.colon.json': 'delimiter', 'delimiter.comma.json': 'delimiter'
}

/**
 * Monaco receives every key (it ignores ids it does not register) and one exact rule per SQL, XML and JSON token, so the
 * `vs` and `vs-dark` rules for `string.sql`, `operator.sql`, `predefined.sql` and the XML tokens can never win.
 */
export function toMonacoTheme(theme: ResolvedTheme): MonacoThemeData {
  const background = hexColor(theme.colors['editor.background'])
  const foreground = opaqueHex(composite(hexColor(theme.colors['editor.foreground']), background))
  const colors: Record<string, string> = {}
  for (const key of colorKeys) colors[key] = theme.colors[key]
  return {
    base: theme.type === 'dark' ? 'vs-dark' : 'vs', inherit: true, colors,
    rules: [{ token: '', foreground: foreground.slice(1), background: opaqueHex(background).slice(1) },
      ...sqlScopes.map(scope => ({ token: scope + '.sql', foreground: theme.syntax[scope].foreground.slice(1), fontStyle: theme.syntax[scope].fontStyle })),
      ...Object.entries(documentTokenScopes).map(([token, scope]) => ({ token, foreground: theme.syntax[scope].foreground.slice(1), fontStyle: theme.syntax[scope].fontStyle }))]
  }
}
