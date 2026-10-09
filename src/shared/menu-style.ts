/** How context menus show: the workbench's own themed menus, or the operating system's (macOS). */
export type MenuStyle = 'custom' | 'native'

const prefix = '--varia-menu-style='
/**
 * Main's choice, made once at launch: native context menus on macOS, the workbench's elsewhere. Smoke tests can choose
 * either, so the native path runs on Linux too.
 */
export function menuStyleFor(platform: string, env: Readonly<Record<string, string | undefined>>): MenuStyle {
  const override = env.VARIA_SMOKE_TEST === '1' ? env.VARIA_SMOKE_MENU_STYLE : undefined
  return override === 'native' || override === 'custom' ? override : platform === 'darwin' ? 'native' : 'custom'
}
/** The renderer argument (`webPreferences.additionalArguments`) that tells the preload main's choice. */
export const menuStyleArgument = (style: MenuStyle): string => prefix + style
/** The preload's reading of that argument: exactly one of the two values, else the platform's default. */
export function menuStyleFromArgv(argv: readonly string[], platform: string): MenuStyle {
  const values = new Set(argv.filter(argument => argument.startsWith(prefix)).map(argument => argument.slice(prefix.length)))
  if (values.size === 1 && (values.has('native') || values.has('custom'))) return [...values][0] as MenuStyle
  return platform === 'darwin' ? 'native' : 'custom'
}
