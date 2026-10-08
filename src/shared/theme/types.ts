import type { ColorKey, SqlScope } from './registry'

export type ThemeType = 'dark' | 'light'
export type ThemeFileType = ThemeType | 'dual'
export type ThemeMode = 'system' | 'dark' | 'light'
export interface ThemePreference { version: 1; mode: ThemeMode; darkTheme: string; lightTheme: string }
export type ThemePreferencePatch = Partial<Pick<ThemePreference, 'mode' | 'darkTheme' | 'lightTheme'>>
export interface SyntaxStyle { foreground: string; fontStyle: string }
/** The canonical theme that crosses IPC: every registry key and SQL scope, as lowercase #rrggbb or #rrggbbaa. */
export interface ResolvedTheme { id: string; name: string; type: ThemeType; colors: Record<ColorKey, string>; syntax: Record<SqlScope, SyntaxStyle> }
export interface ThemeSummary { id: string; name: string; source: 'builtin' | 'user'; types: ThemeType[]; usable: boolean; errors: number; warnings: number }
/**
 * `revision` grows whenever anything changes; `noticeId` only when an action reports something (even the same text
 * again), so a dismissed notice stays hidden across theme-only updates and a repeated action shows its notice again.
 */
export interface ThemeState {
  revision: number; preference: ThemePreference; active: ResolvedTheme; fallback: boolean
  themes: ThemeSummary[]; problems: ThemeProblem[]; problemsOmitted: number; notice?: string; noticeId: number
}

export const themeErrorCodes = ['E_READ', 'E_TOO_LARGE', 'E_ENCODING', 'E_JSON', 'E_COMPLEX', 'E_NOT_OBJECT', 'E_KIND', 'E_VERSION', 'E_FIELD', 'E_LIMIT', 'E_FILE_NAME', 'E_DUPLICATE_ID', 'E_RESERVED'] as const
export const themeWarningCodes = ['W_FIELD', 'W_KEY_INVALID', 'W_KEY_UNKNOWN', 'W_KEYS_UNUSED', 'W_VALUE', 'W_VARIANT_NOT_DUAL', 'W_REF_UNKNOWN', 'W_REF_CYCLE', 'W_SCOPE', 'W_SETTING', 'W_FONT_STYLE', 'W_TEXT_SANITISED', 'W_TOO_MANY_FILES'] as const
export type ThemeErrorCode = typeof themeErrorCodes[number]
export type ThemeWarningCode = typeof themeWarningCodes[number]
export type ThemeProblemCode = ThemeErrorCode | ThemeWarningCode
/** `path` is an RFC 6901 JSON Pointer into the file ('' for the whole file); `file` is the base name only. */
export interface ThemeProblem { severity: 'error' | 'warning'; code: ThemeProblemCode; file: string; path: string; message: string }

/** A validated `color` (hex or `$slot[/pct]`), or a `{dark, light}` variant object (dual themes only). */
export type ThemeValue = string | { readonly dark?: string; readonly light?: string }
export interface ThemeRule { scope: SqlScope; foreground?: ThemeValue; fontStyle?: string; path: string }
/** A theme file after validation. Maps keep untrusted keys away from object prototypes. */
export interface ParsedTheme {
  id: string; fileName: string; name: string; type: ThemeFileType
  description?: string; author?: string
  palette: ReadonlyMap<string, ThemeValue>; colors: ReadonlyMap<ColorKey, ThemeValue>; rules: readonly ThemeRule[]
}
export interface ThemeParseResult { theme: ParsedTheme | null; problems: ThemeProblem[]; problemsOmitted: number }
export interface ThemeResolution { theme: ResolvedTheme; palette: ReadonlyMap<string, string>; problems: ThemeProblem[] }
