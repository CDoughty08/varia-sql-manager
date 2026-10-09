import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { themeChoice } from '../../../shared/theme/choice'
import { builtinThemes } from '../../../shared/theme/palette'
import type { ResolvedTheme, ThemeMode, ThemePreference, ThemePreferencePatch, ThemePreview, ThemeState, ThemeSummary, ThemeType } from '../../../shared/theme/types'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import type { QuickPickItem } from '../quickinput/QuickInputService'
import type { ThemeService } from '../services/theme'

/** A row of the Color Theme picker: a mode (Dark, Light, Follow System) or a theme in one of its lists. */
export interface ThemePickerItem extends QuickPickItem {
  readonly mode?: ThemeMode
  readonly theme?: ThemeSummary
  /** The list a theme row is in; a dual theme is in both. */
  readonly list?: ThemeType
}
export type ThemePickerApi = Pick<VariaApi, 'previewTheme' | 'setThemePreference' | 'createCustomTheme'>
export type ThemeController = Pick<ThemeService, 'state' | 'preview' | 'endPreview' | 'receive' | 'reload' | 'openFolder'>
/** Moving through the list previews each row only once it stays active this long (milliseconds). */
export const themePreviewDelay = 100

const types: readonly ThemeType[] = ['dark', 'light']
const modes: readonly { mode: ThemeMode; label: string }[] = [{ mode: 'dark', label: 'Dark' }, { mode: 'light', label: 'Light' }, { mode: 'system', label: 'Follow System' }]
const slotOf = (type: ThemeType) => type === 'dark' ? 'darkTheme' as const : 'lightTheme' as const
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const errorText = (error: unknown) => error instanceof Error && error.message ? error.message : 'The operation failed.'

/**
 * The picker's rows for main's theme state: the modes, then the usable themes of each type (a dual theme in both lists),
 * then the themes that cannot be used. `effectiveType` is the type shown now: its list's choice is "current", and the
 * other list's choice says when it applies.
 */
export function themePickerItems(state: Pick<ThemeState, 'preference' | 'themes'>, effectiveType: ThemeType): ThemePickerItem[] {
  const { preference, themes } = state
  const items: ThemePickerItem[] = modes.map(({ mode, label }) => ({ id: `mode.${mode}`, label, group: 'mode', mode, ...preference.mode === mode ? { description: 'current' } : {} }))
  for (const list of types) {
    for (const theme of themes) {
      if (!theme.usable || !theme.types.includes(list)) continue
      const description = preference[slotOf(list)] !== theme.id ? theme.source === 'user' ? 'user theme' : undefined
        : list === effectiveType ? 'current' : preference.mode === 'system' ? `used when the system is ${list}` : `used in ${list} mode`
      items.push({ id: `${list}.${theme.id}`, label: theme.name, group: `${list} themes`, theme, list, ...description ? { description } : {} })
    }
  }
  for (const theme of themes) {
    if (theme.usable) continue
    items.push({ id: `unavailable.${theme.id}`, label: theme.name, group: 'unavailable', theme, disabled: true, description: `invalid: ${plural(theme.errors, 'problem', 'problems')}`,
      disabledHint: `This theme has errors. Fix ${theme.id}.json in the themes folder, then reload themes.` })
  }
  return items
}

/** What a row shows while it is active: its theme, or for Dark and Light the theme that mode would use; null shows main's theme. */
export function themePreviewTarget(item: ThemePickerItem | undefined, state: Pick<ThemeState, 'preference' | 'themes'>): ThemePreview | null {
  if (!item || item.disabled) return null
  if (item.theme && item.list) return { id: item.theme.id, type: item.list }
  if (item.mode !== 'dark' && item.mode !== 'light') return null
  const id = state.preference[slotOf(item.mode)], type = item.mode
  // Main shows the built-in when the chosen theme is missing or broken, and so does the preview.
  return { id: state.themes.some(theme => theme.id === id && theme.usable && theme.types.includes(type)) ? id : builtinThemes[type].id, type }
}

function patchFor(item: ThemePickerItem, preference: ThemePreference): ThemePreferencePatch | undefined {
  if (item.mode) return { mode: item.mode }
  return item.theme && item.list ? themeChoice(preference, item.theme, item.list) : undefined
}

/**
 * Preferences › Color Theme…: a picker that previews the active row (debounced, and only the latest answer from main
 * counts) and applies the accepted one. Every other way of closing it puts main's theme back. The other theme commands
 * run the same actions as the View › Theme menu and its notice.
 */
export function themeContribution({ commands, quickInput, theme }: Pick<Workbench, 'commands' | 'quickInput'> & { theme: ThemeController }, api: ThemePickerApi, timers: Timers = browserTimers): Disposable {
  // Shared by every session, so an answer for a closed picker is recognised as stale.
  let requests = 0, sessions = 0

  async function colorTheme(): Promise<void> {
    const session = ++sessions, opened = theme.state, effectiveType = opened.active.type
    let open = true, previewed = false, timer: unknown
    const cancelTimer = () => { if (timer !== undefined) timers.clearTimeout(timer); timer = undefined }
    const endPreview = () => {
      requests++
      theme.endPreview()
      // Main shows a preview in the window chrome only after a request, so it needs to hear the end only then.
      if (previewed) { previewed = false; void api.previewTheme(null).catch(() => {}) }
    }
    const preview = (target: ThemePreview | null) => {
      if (!open) return
      const { active } = theme.state
      if (!target || (target.id === active.id && target.type === active.type)) { endPreview(); return }
      const request = ++requests
      previewed = true
      const answered = (result: ApiResult<ResolvedTheme | null>) => {
        if (!open || request !== requests) return
        if (!result.ok) quickInput.setMessage({ text: `Could not preview the theme: ${result.error}`, severity: 'error' })
        else if (result.value) theme.preview(result.value)
      }
      api.previewTheme(target).then(answered, (error: unknown) => answered({ ok: false, error: errorText(error) }))
    }
    const item = await quickInput.pick<ThemePickerItem>({
      ariaLabel: 'Select Color Theme', title: 'Select Color Theme', placeholder: 'Type to filter themes; Up and Down preview them', noun: 'themes', sort: 'none',
      items: themePickerItems(opened, effectiveType), activeId: `${effectiveType}.${opened.active.id}`,
      onDidChangeActive: active => {
        cancelTimer()
        timer = timers.setTimeout(() => { timer = undefined; preview(themePreviewTarget(active, theme.state)) }, themePreviewDelay)
      },
      onDidHide: reason => {
        open = false
        cancelTimer()
        // An accepted row keeps its preview on screen until main has applied the choice, so nothing flashes.
        if (reason !== 'accept') endPreview()
      }
    })
    if (!item) return
    const patch = patchFor(item, theme.state.preference)
    if (!patch) return
    let result: ApiResult<ThemeState>
    try { result = await api.setThemePreference(patch) } catch (error) { result = { ok: false, error: errorText(error) } }
    if (result.ok) theme.receive(result.value)
    // A picker opened since then owns whatever preview is on screen now.
    if (session === sessions) {
      theme.endPreview()
      // Main ends its preview with every choice; this covers a choice that never reached it.
      if (!result.ok && previewed) void api.previewTheme(null).catch(() => {})
    }
    if (!result.ok) throw new Error(result.error)
  }

  const registrations = [
    commands.register('preferences.colorTheme', { run: colorTheme }),
    commands.register('preferences.createTheme', { run: async () => { const result = await api.createCustomTheme(); if (!result.ok) throw new Error(result.error) } }),
    commands.register('preferences.openThemesFolder', { run: () => theme.openFolder() }),
    commands.register('preferences.reloadThemes', { run: () => theme.reload() }),
    // View › Theme's mode and theme items in custom menus; main applies the choice and publishes the new state.
    commands.register('preferences.setTheme', { when: args => !!args?.theme, run: async args => {
      if (!args?.theme) return
      let result: ApiResult<ThemeState>
      try { result = await api.setThemePreference(args.theme) } catch (error) { result = { ok: false, error: errorText(error) } }
      if (!result.ok) throw new Error(result.error)
      theme.receive(result.value)
    } })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
