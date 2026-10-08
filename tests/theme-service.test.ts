import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../src/shared/contracts'
import { contrast, hexColor } from '../src/shared/theme/color'
import { connectionAccent, connectionAccentSurfaces } from '../src/shared/theme/connection-colors'
import { defaultThemePreference } from '../src/shared/theme/format'
import { colorKeys, cssVariable } from '../src/shared/theme/registry'
import { resolveBuiltin } from '../src/shared/theme/resolve'
import type { ResolvedTheme, ThemeState, ThemeType } from '../src/shared/theme/types'
import { domThemeTarget, ThemeService, type ThemeApi, type ThemeTarget } from '../src/renderer/src/services/theme'

vi.mock('../src/shared/theme/connection-colors', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/shared/theme/connection-colors')>()
  return { ...actual, connectionAccent: vi.fn(actual.connectionAccent) }
})

const state = (revision: number, type: ThemeType = 'dark', patch: Partial<ThemeState> = {}): ThemeState =>
  ({ revision, preference: defaultThemePreference, active: resolveBuiltin(type), fallback: false, themes: [], problems: [], problemsOmitted: 0, ...patch })
const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
const noHandler = () => new Error("Error invoking remote method 'varia:theme-state': Error: No handler registered for 'varia:theme-state'")
function fakeApi(initial: () => Promise<ApiResult<ThemeState>> = async () => ok(state(1))) {
  let listener: ((value: ThemeState) => void) | undefined
  const api = {
    getThemeState: vi.fn(initial),
    reloadThemes: vi.fn<ThemeApi['reloadThemes']>(async () => ok(state(9, 'light'))),
    openThemesFolder: vi.fn<ThemeApi['openThemesFolder']>(async () => ok(undefined)),
    onThemeChanged: vi.fn((callback: (value: ThemeState) => void) => { listener = callback; return () => { listener = undefined } })
  } satisfies ThemeApi
  return { api, push: (value: unknown) => listener?.(value as ThemeState), subscribed: () => !!listener }
}
function fakeTarget(apply: (theme: ResolvedTheme) => string | void = () => {}) {
  const applied: ResolvedTheme[] = []
  const target = { apply: vi.fn((theme: ResolvedTheme) => { applied.push(theme); return apply(theme) }), dispose: vi.fn() } satisfies ThemeTarget
  return { target, applied }
}
let errors: ReturnType<typeof vi.spyOn>
beforeEach(() => { errors = vi.spyOn(console, 'error').mockImplementation(() => {}); vi.mocked(connectionAccent).mockClear() })
afterEach(() => { errors.mockRestore(); vi.useRealTimers() })

describe('ThemeService', () => {
  it('applies the state from main before it resolves', async () => {
    const { api } = fakeApi(), { target, applied } = fakeTarget()
    const service = await ThemeService.create(api, target)
    expect(applied.map(theme => theme.id)).toEqual(['varia-dark'])
    expect(service.getSnapshot().revision).toBe(1)
    expect(errors).not.toHaveBeenCalled()
  })
  it('ignores stale revisions, including ones pushed while the first request is pending', async () => {
    let answer!: (value: ApiResult<ThemeState>) => void
    const { api, push } = fakeApi(() => new Promise(resolve => { answer = resolve })), { target, applied } = fakeTarget()
    const created = ThemeService.create(api, target)
    await Promise.resolve()
    push(state(5, 'light'))
    answer(ok(state(4)))
    const service = await created
    expect(service.getSnapshot().revision).toBe(5)
    expect(service.getSnapshot().active.type).toBe('light')
    const published = vi.fn()
    service.subscribe(published)
    push(state(5, 'dark')); push(state(3, 'dark'))
    expect(service.getSnapshot().active.type).toBe('light')
    push(state(6, 'dark'))
    expect(service.getSnapshot().active.type).toBe('dark')
    expect(published).toHaveBeenCalledTimes(1)
    expect(applied.map(theme => theme.type)).toEqual(['dark', 'light', 'dark'])
  })
  it('rejects an invalid payload and keeps the previous theme', async () => {
    const { api, push } = fakeApi(), { target, applied } = fakeTarget()
    const service = await ThemeService.create(api, target)
    const light = resolveBuiltin('light')
    const invalid = [
      { ...state(2, 'light'), active: { ...light, colors: { ...light.colors, 'focusBorder': 'red;}body{display:none' } } },
      { ...state(3, 'light'), active: { ...light, colors: { ...light.colors, 'editor.background': undefined } } },
      { ...state(4, 'light'), active: { ...light, syntax: { ...light.syntax, string: { foreground: '#ff000080', fontStyle: '' } } } },
      { ...state(5, 'light'), problems: [{ file: 'x.json', path: '', message: { toString: () => 'object' } }] },
      { ...state(6, 'light'), revision: '7' },
      null
    ]
    for (const payload of invalid) push(payload)
    expect(applied).toHaveLength(1)
    expect(service.getSnapshot().revision).toBe(1)
    expect(errors).toHaveBeenCalledTimes(invalid.length)
  })
  it('restores the previous theme when applying fails, and reports a partial apply', async () => {
    const { api, push } = fakeApi()
    const { target, applied } = fakeTarget(theme => { if (theme.type === 'light') throw new Error('CSSOM failure') })
    const service = await ThemeService.create(api, target)
    push(state(2, 'light'))
    expect(applied.map(theme => theme.type)).toEqual(['dark', 'light', 'dark'])
    expect(service.getSnapshot().revision).toBe(1)
    const partial = await ThemeService.create(fakeApi().api, fakeTarget(() => 'The SQL editor kept its colors.').target)
    expect(partial.getSnapshot().notice).toBe('The SQL editor kept its colors.')
  })
  it('falls back to a built-in by prefers-color-scheme when main does not answer in time, then applies the late answer', async () => {
    let answer!: (value: ApiResult<ThemeState>) => void
    const { api } = fakeApi(() => new Promise(resolve => { answer = resolve })), { target, applied } = fakeTarget()
    const service = await ThemeService.create(api, target, { timeout: 5, prefersDark: () => false })
    expect(service.getSnapshot()).toMatchObject({ revision: -1, fallback: false, active: { id: 'varia-light', type: 'light' } })
    expect(service.getSnapshot().notice).toMatch(/could not be loaded.*Varia Light/)
    answer(ok(state(0, 'dark')))
    await vi.waitFor(() => expect(service.getSnapshot().revision).toBe(0))
    expect(applied.map(theme => theme.type)).toEqual(['light', 'dark'])
  })
  it('falls back the same way when main reports an error', async () => {
    const service = await ThemeService.create(fakeApi(async () => ({ ok: false, error: 'boom' })).api, fakeTarget().target, { prefersDark: () => true })
    expect(service.getSnapshot()).toMatchObject({ revision: -1, active: { id: 'varia-dark' } })
    expect(service.getSnapshot().notice).toContain('Varia Dark')
    const garbage = await ThemeService.create(fakeApi(async () => ok({ revision: 1 } as unknown as ThemeState)).api, fakeTarget().target, { prefersDark: () => true })
    expect(garbage.getSnapshot().revision).toBe(-1)
  })
  it('shows the default theme without a notice when main has no theme handlers', async () => {
    const service = await ThemeService.create(fakeApi(async () => { throw noHandler() }).api, fakeTarget().target, { prefersDark: () => false })
    expect(service.getSnapshot()).toMatchObject({ revision: -1, fallback: false, active: { id: 'varia-dark' }, problems: [] })
    expect(service.getSnapshot().notice).toBeUndefined()
    expect(service.getSnapshot().themes.map(theme => theme.id)).toEqual(['varia-dark', 'varia-light'])
  })
  it('falls back to a built-in when the first theme cannot be applied', async () => {
    const { target, applied } = fakeTarget(theme => { if (theme.id === 'harbor') throw new Error('broken') })
    const harbor = { ...resolveBuiltin('dark'), id: 'harbor', name: 'Harbor' }
    const service = await ThemeService.create(fakeApi(async () => ok(state(3, 'dark', { active: harbor }))).api, target)
    expect(applied.map(theme => theme.id)).toEqual(['harbor', 'varia-dark'])
    expect(service.getSnapshot()).toMatchObject({ revision: -1, active: { id: 'varia-dark' } })
    expect(service.getSnapshot().notice).toContain('could not be applied')
  })
  it('turns presets into theme variables and custom colors into readable accents, cached per revision', async () => {
    const { api, push } = fakeApi()
    const service = await ThemeService.create(api, fakeTarget().target)
    expect(service.accent('#e66b73')).toBe('var(--varia-connection-red)')
    expect(service.accent('#E66B73')).toBe('var(--varia-connection-red)')
    expect(service.accent('#71a7df')).toBe('var(--varia-connection-blue)')
    expect(service.accent(undefined)).toBeUndefined()
    expect(service.accent('')).toBeUndefined()
    expect(service.accent('not a color')).toBeUndefined()
    const dark = service.accent('#202020')!
    expect(dark).toMatch(/^#[0-9a-f]{6}$/)
    for (const surface of connectionAccentSurfaces) expect(contrast(hexColor(dark), hexColor(resolveBuiltin('dark').colors[surface]))).toBeGreaterThanOrEqual(3)
    const calls = vi.mocked(connectionAccent).mock.calls.length
    expect(service.accent('#202020')).toBe(dark)
    expect(vi.mocked(connectionAccent).mock.calls.length).toBe(calls)
    push(state(2, 'light'))
    expect(service.accent('#202020')).toBe('#202020')
    expect(vi.mocked(connectionAccent).mock.calls.length).toBe(calls + 1)
  })
  it('reloads through main and stops listening when disposed', async () => {
    const { api, subscribed } = fakeApi(), { target, applied } = fakeTarget()
    const service = await ThemeService.create(api, target)
    await service.reload()
    expect(service.getSnapshot()).toMatchObject({ revision: 9, active: { type: 'light' } })
    api.reloadThemes.mockResolvedValueOnce({ ok: false, error: 'Themes folder is unreadable.' })
    await expect(service.reload()).rejects.toThrow('Themes folder is unreadable.')
    api.openThemesFolder.mockResolvedValueOnce({ ok: false, error: 'No file manager.' })
    await expect(service.openFolder()).rejects.toThrow('No file manager.')
    service.dispose()
    expect(subscribed()).toBe(false)
    expect(target.dispose).toHaveBeenCalledOnce()
    service.receive(state(10, 'dark'))
    expect(applied).toHaveLength(2)
  })
})

describe('domThemeTarget', () => {
  function fakeDom(forced = false) {
    const properties = new Map<string, string>(), listeners = new Set<() => void>()
    const root = { style: { setProperty: vi.fn((name: string, value: string) => { properties.set(name, value) }), colorScheme: '' }, dataset: {} as Record<string, string> }
    const media = { matches: forced, addEventListener: vi.fn((_: string, listener: () => void) => { listeners.add(listener) }), removeEventListener: vi.fn((_: string, listener: () => void) => { listeners.delete(listener) }) }
    const monaco = { editor: { defineTheme: vi.fn(), setTheme: vi.fn() } }
    const target = domThemeTarget(monaco, root as unknown as HTMLElement, media as unknown as MediaQueryList)
    return { properties, root, media, monaco, target, listeners }
  }
  it('sets one variable per registry key, never names from the payload', () => {
    const { properties, root, target, monaco } = fakeDom()
    const light = resolveBuiltin('light')
    target.apply({ ...light, colors: { ...light.colors, '--evil': 'url(x)', 'constructor': '#000000' } as ResolvedTheme['colors'] })
    expect([...properties.keys()]).toEqual(colorKeys.map(cssVariable))
    for (const key of colorKeys) expect(properties.get(cssVariable(key))).toBe(light.colors[key])
    expect(root.style.colorScheme).toBe('light')
    expect(root.dataset.themeType).toBe('light')
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith('varia', expect.objectContaining({ base: 'vs', inherit: true }))
    expect(monaco.editor.setTheme).toHaveBeenCalledWith('varia')
  })
  it('leaves Monaco on its high-contrast theme in forced colors and restores varia afterwards', () => {
    const { media, monaco, target, listeners } = fakeDom(true)
    target.apply(resolveBuiltin('dark'))
    expect(monaco.editor.defineTheme).toHaveBeenCalledOnce()
    expect(monaco.editor.setTheme).not.toHaveBeenCalled()
    media.matches = false
    for (const listener of listeners) listener()
    expect(monaco.editor.setTheme).toHaveBeenCalledWith('varia')
    target.dispose?.()
    expect(listeners.size).toBe(0)
  })
  it('keeps the CSS and reports a notice when Monaco rejects the theme', () => {
    const { properties, monaco, target } = fakeDom()
    monaco.editor.defineTheme.mockImplementation(() => { throw new Error('bad theme') })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(target.apply(resolveBuiltin('dark'))).toMatch(/SQL editor/)
    expect(properties.size).toBe(colorKeys.length)
    expect(monaco.editor.setTheme).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
