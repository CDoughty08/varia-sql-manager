import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { VariaApi } from '../../../shared/contracts'
import { connectionAccent } from '../../../shared/theme/connection-colors'
import { defaultThemePreference } from '../../../shared/theme/format'
import { toMonacoTheme } from '../../../shared/theme/monaco'
import { builtinThemes } from '../../../shared/theme/palette'
import { colorKeys, cssVariable } from '../../../shared/theme/registry'
import { isResolvedTheme, resolveBuiltin } from '../../../shared/theme/resolve'
import type { ResolvedTheme, ThemeState, ThemeSummary, ThemeType } from '../../../shared/theme/types'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

export type ThemeApi = Pick<VariaApi, 'getThemeState' | 'reloadThemes' | 'openThemesFolder' | 'onThemeChanged'>
/** Where a validated theme is applied: the document and Monaco in the app, a fake in tests. */
export interface ThemeTarget {
  /** Returns a notice when part of the theme could not be applied; throws when nothing could be. */
  apply(theme: ResolvedTheme): string | void
  dispose?(): void
}
export interface ThemeServiceOptions {
  /** How long to wait for the main process before showing a built-in theme (milliseconds). */
  timeout?: number
  prefersDark?: () => boolean
}
type MonacoThemes = { editor: Pick<typeof Monaco.editor, 'defineTheme' | 'setTheme'> }

const types: readonly ThemeType[] = ['dark', 'light']
const builtinSummaries: ThemeSummary[] = types.map(type => ({ ...builtinThemes[type], source: 'builtin', types: [type], usable: true, errors: 0, warnings: 0 }))
const systemPrefersDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
const maxCachedAccents = 256

function isThemeState(value: unknown): value is ThemeState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Partial<Record<keyof ThemeState, unknown>>
  const text = (entry: unknown, key: string) => typeof (entry as Record<string, unknown>)[key] === 'string'
  return Number.isSafeInteger(state.revision) && typeof state.fallback === 'boolean' && Number.isSafeInteger(state.problemsOmitted)
    && (state.notice === undefined || typeof state.notice === 'string') && isResolvedTheme(state.active)
    && Array.isArray(state.problems) && state.problems.every(problem => typeof problem === 'object' && problem !== null && text(problem, 'file') && text(problem, 'path') && text(problem, 'message'))
}
function fallbackState(type: ThemeType, notice?: string): ThemeState {
  return { revision: -1, preference: defaultThemePreference, active: resolveBuiltin(type), fallback: false, themes: builtinSummaries, problems: [], problemsOmitted: 0, ...(notice ? { notice } : {}) }
}
const withNotice = (state: ThemeState, notice: string): ThemeState => ({ ...state, notice: state.notice ? state.notice + ' ' + notice : notice })

/**
 * The active theme in the renderer. Main resolves themes; this re-validates each state, applies it through the target,
 * and only then publishes it, so subscribers (Dockview, connection accents, the notice) never see an unapplied theme.
 */
export class ThemeService extends SnapshotStore<ThemeState> implements Disposable {
  private accents = new Map<string, string | undefined>()
  private accentRevision: number
  private disposed = false

  /** Resolves once a theme has been applied: main's state, or a built-in when main does not answer in time. */
  static async create(api: ThemeApi, target: ThemeTarget, options: ThemeServiceOptions = {}): Promise<ThemeService> {
    const early: unknown[] = []
    let service: ThemeService | undefined, unsubscribe = () => {}
    try { unsubscribe = api.onThemeChanged(state => { if (service) service.receive(state); else early.push(state) }) } catch (error) { onUnexpectedError(error) }
    const request = Promise.resolve().then(() => api.getThemeState())
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      request.then(result => result.ok ? { state: result.value as unknown } : { error: new Error(result.error) }).catch((error: unknown) => ({ error })),
      new Promise<{ error: Error }>(resolve => { timer = setTimeout(() => resolve({ error: new Error('The main process did not send the theme in time.') }), options.timeout ?? 3000) })
    ])
    clearTimeout(timer)
    let initial: ThemeState
    if ('state' in outcome && isThemeState(outcome.state)) initial = outcome.state
    else {
      const error = 'error' in outcome ? outcome.error : new Error('The main process sent an invalid theme.')
      // prefers-color-scheme follows the themeSource main sets before creating the window.
      const system: ThemeType = (options.prefersDark ?? systemPrefersDark)() ? 'dark' : 'light'
      // A main process without theme handlers never sets themeSource, so the OS preference says nothing about the
      // app's mode; the default preference keeps today's look.
      if (error instanceof Error && error.message.includes('No handler registered')) initial = fallbackState(defaultThemePreference.mode === 'system' ? system : defaultThemePreference.mode)
      else {
        onUnexpectedError(error)
        initial = fallbackState(system, `Theme settings could not be loaded, so ${builtinThemes[system].name} is shown. Use Reload to try again.`)
      }
    }
    const created = new ThemeService(api, target, initial, unsubscribe)
    service = created
    for (const state of early) created.receive(state)
    // A reply that missed the timeout is still newer than the fallback (revision -1).
    if (!('state' in outcome)) void request.then(result => { if (result?.ok) created.receive(result.value) }).catch(() => {})
    return created
  }

  private constructor(private readonly api: ThemeApi, private readonly target: ThemeTarget, initial: ThemeState, private readonly unsubscribe: () => void) {
    super(initial)
    this.accentRevision = initial.revision
    const applied = this.apply(initial.active)
    if (applied.ok) { if (applied.notice) this.publish(withNotice(initial, applied.notice)) }
    else if (initial.revision >= 0) {
      const fallback = fallbackState(initial.active.type, `The theme could not be applied, so ${builtinThemes[initial.active.type].name} is shown.`)
      if (this.apply(fallback.active).ok) this.publish(fallback)
    }
  }

  /** Applies a state from main if it is newer and valid; otherwise the current theme stays. */
  receive(state: unknown): void {
    if (this.disposed) return
    const revision = typeof state === 'object' && state !== null ? (state as { revision?: unknown }).revision : undefined
    if (typeof revision === 'number' && revision <= this.getSnapshot().revision) return
    if (!isThemeState(state)) { onUnexpectedError(new Error('Ignored an invalid theme state from the main process.')); return }
    const applied = this.apply(state.active, this.getSnapshot().active)
    if (applied.ok) this.publish(applied.notice ? withNotice(state, applied.notice) : state)
  }

  /** The CSS color for a stored connection color; presets follow the theme through their variable. */
  accent = (stored: string | undefined): string | undefined => {
    if (!stored) return undefined
    const { revision, active } = this.getSnapshot()
    if (revision !== this.accentRevision || this.accents.size >= maxCachedAccents) { this.accents.clear(); this.accentRevision = revision }
    if (!this.accents.has(stored)) this.accents.set(stored, connectionAccent(stored, active))
    return this.accents.get(stored)
  }

  async reload(): Promise<void> {
    const result = await this.api.reloadThemes()
    if (!result.ok) throw new Error(result.error)
    this.receive(result.value)
  }
  async openFolder(): Promise<void> {
    const result = await this.api.openThemesFolder()
    if (!result.ok) throw new Error(result.error)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.target.dispose?.()
    this.clearListeners()
  }

  private apply(theme: ResolvedTheme, previous?: ResolvedTheme): { ok: boolean; notice?: string } {
    try { return { ok: true, notice: this.target.apply(theme) || undefined } } catch (error) {
      onUnexpectedError(error)
      // A partial apply would mix two themes; put the previous one back.
      if (previous) try { this.target.apply(previous) } catch (restore) { onUnexpectedError(restore) }
      return { ok: false }
    }
  }
}

/** Applies themes to the document root (CSSOM only) and to Monaco's `varia` theme. */
export function domThemeTarget(monaco: MonacoThemes, root: HTMLElement = document.documentElement, forcedColors: MediaQueryList = matchMedia('(forced-colors: active)')): ThemeTarget {
  // Monaco switches to vs-dark when forced colors end instead of restoring the custom theme.
  const restore = () => { if (!forcedColors.matches) monaco.editor.setTheme('varia') }
  forcedColors.addEventListener('change', restore)
  return {
    apply(theme) {
      // Variable names come from the registry, never from the payload.
      for (const key of colorKeys) root.style.setProperty(cssVariable(key), theme.colors[key])
      root.style.colorScheme = theme.type
      root.dataset.themeType = theme.type
      try { monaco.editor.defineTheme('varia', toMonacoTheme(theme)) } catch (error) {
        onUnexpectedError(error)
        return 'The SQL editor could not use this theme and keeps its previous colors.'
      }
      if (!forcedColors.matches) monaco.editor.setTheme('varia')
    },
    dispose() { forcedColors.removeEventListener('change', restore) }
  }
}
