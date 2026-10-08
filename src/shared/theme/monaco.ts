import { composite, hexColor, opaqueHex } from './color'
import { colorKeys, sqlScopes } from './registry'
import type { ResolvedTheme } from './types'

export interface MonacoTokenRule { token: string; foreground?: string; background?: string; fontStyle?: string }
/** Structurally an `IStandaloneThemeData`, so shared code needs no Monaco import. */
export interface MonacoThemeData { base: 'vs' | 'vs-dark'; inherit: boolean; rules: MonacoTokenRule[]; colors: Record<string, string> }

/**
 * Monaco receives every key (it ignores ids it does not register) and one exact rule per SQL token, so the `vs` and
 * `vs-dark` rules for `string.sql`, `operator.sql` and `predefined.sql` can never win.
 */
export function toMonacoTheme(theme: ResolvedTheme): MonacoThemeData {
  const background = hexColor(theme.colors['editor.background'])
  const foreground = opaqueHex(composite(hexColor(theme.colors['editor.foreground']), background))
  const colors: Record<string, string> = {}
  for (const key of colorKeys) colors[key] = theme.colors[key]
  return {
    base: theme.type === 'dark' ? 'vs-dark' : 'vs', inherit: true, colors,
    rules: [{ token: '', foreground: foreground.slice(1), background: opaqueHex(background).slice(1) },
      ...sqlScopes.map(scope => ({ token: scope + '.sql', foreground: theme.syntax[scope].foreground.slice(1), fontStyle: theme.syntax[scope].fontStyle }))]
  }
}
