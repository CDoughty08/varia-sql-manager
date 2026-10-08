import type { ThemePreference, ThemePreferencePatch, ThemeSummary, ThemeType } from './types'

/**
 * The preference change for choosing a theme from a list: a dual theme fills both slots, and a fixed mode follows the
 * list. The application menu and the palette's theme picker share it so they cannot disagree.
 */
export function themeChoice(preference: ThemePreference, theme: Pick<ThemeSummary, 'id' | 'types'>, list: ThemeType): ThemePreferencePatch {
  const patch: ThemePreferencePatch = theme.types.length > 1 ? { darkTheme: theme.id, lightTheme: theme.id } : list === 'dark' ? { darkTheme: theme.id } : { lightTheme: theme.id }
  if (preference.mode !== 'system' && preference.mode !== list) patch.mode = list
  return patch
}
