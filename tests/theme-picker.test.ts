import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../src/shared/contracts'
import { themeChoice } from '../src/shared/theme/choice'
import { defaultThemePreference } from '../src/shared/theme/format'
import { resolveBuiltin } from '../src/shared/theme/resolve'
import type { ResolvedTheme, ThemePreference, ThemePreferencePatch, ThemeState, ThemeSummary, ThemeType } from '../src/shared/theme/types'
import { CommandService } from '../src/renderer/src/core/commands'
import { themeContribution, themePickerItems, themePreviewDelay, themePreviewTarget, type ThemePickerApi, type ThemePickerItem } from '../src/renderer/src/contributions/theme'
import { QuickInputService } from '../src/renderer/src/quickinput/QuickInputService'
import { ThemeService, type ThemeApi, type ThemeTarget } from '../src/renderer/src/services/theme'
import { deferred } from './fixtures/documents'
import { fakeFocus, manualTimers, workbenchFixture } from './fixtures/workbench'

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const summary = (id: string, name: string, types: ThemeType[], fields: Partial<ThemeSummary> = {}): ThemeSummary => ({ id, name, source: 'user', types, usable: true, errors: 0, warnings: 0, ...fields })
const themes: ThemeSummary[] = [
  summary('varia-dark', 'Varia Dark', ['dark'], { source: 'builtin' }), summary('varia-light', 'Varia Light', ['light'], { source: 'builtin' }),
  summary('dusk', 'Dusk', ['dark']), summary('harbor', 'Harbor', ['dark', 'light']), summary('paper', 'Paper', ['light']), summary('broken', 'broken', [], { usable: false, errors: 3 })
]
/** A resolved theme as main would send it: the built-in colors of that type under the theme's id. */
const resolved = (id: string, type: ThemeType): ResolvedTheme => ({ ...resolveBuiltin(type), id, name: themes.find(theme => theme.id === id)?.name ?? id })
/** Main's state; System mode shows the dark theme, as on a dark desktop. */
const state = (revision: number, preference: Partial<ThemePreference> = {}): ThemeState => {
  const full = { ...defaultThemePreference, ...preference }
  const type: ThemeType = full.mode === 'light' ? 'light' : 'dark'
  return { revision, preference: full, active: resolved(type === 'dark' ? full.darkTheme : full.lightTheme, type), fallback: false, themes, problems: [], problemsOmitted: 0, noticeId: 0 }
}
const ids = (items: readonly ThemePickerItem[]) => items.map(item => [item.id, item.label, item.group, item.description ?? '', !!item.disabled])
const shown = (theme: ResolvedTheme) => `${theme.id}/${theme.type}`

let errors: ReturnType<typeof vi.spyOn>
beforeEach(() => { errors = vi.spyOn(console, 'error').mockImplementation(() => {}) })
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); errors.mockRestore(); vi.restoreAllMocks() })

/** A real ThemeService and quick input with fake IPC: main resolves previews from `themes` and applies choices to its own state. */
async function picker(initial: ThemeState = state(1)) {
  let push: (value: unknown) => void = () => {}
  const themeApi: ThemeApi = {
    getThemeState: async () => ok(initial),
    reloadThemes: vi.fn<ThemeApi['reloadThemes']>(async () => ok(state(50))),
    openThemesFolder: vi.fn<ThemeApi['openThemesFolder']>(async () => ok(undefined)),
    onThemeChanged: callback => { push = callback as (value: unknown) => void; return () => {} }
  }
  const applied: string[] = []
  const target: ThemeTarget = { apply: theme => { applied.push(shown(theme)) } }
  const theme = await ThemeService.create(themeApi, target)
  applied.length = 0
  let main = initial
  const api = {
    previewTheme: vi.fn<ThemePickerApi['previewTheme']>(async selection => ok(selection ? resolved(selection.id, selection.type) : null)),
    setThemePreference: vi.fn<ThemePickerApi['setThemePreference']>(async (patch: ThemePreferencePatch) => {
      const preference = { ...main.preference, ...patch }
      main = state(main.revision + 1, preference)
      push(main)
      return ok(main)
    }),
    createCustomTheme: vi.fn<ThemePickerApi['createCustomTheme']>(async () => ok(undefined))
  }
  const clock = manualTimers(), focus = fakeFocus()
  const quickInput = new QuickInputService(focus.adapter, clock.timers)
  const commands = new CommandService()
  const contribution = themeContribution({ commands, quickInput, theme }, api, clock.timers)
  cleanups.push(() => { quickInput.dispose(); contribution.dispose(); commands.dispose(); theme.dispose() })
  const view = () => quickInput.getSnapshot()
  const active = () => view().rows[view().activeIndex]?.item.id
  /** Opens the picker; the returned promise settles when the command finishes (after the picker closes). */
  const open = () => commands.execute('preferences.colorTheme', undefined, 'palette')
  /** Makes a row active and lets the debounce run. */
  const select = async (id: string) => {
    quickInput.setActive(view().rows.findIndex(row => row.item.id === id))
    clock.advance(themePreviewDelay)
    await settle()
  }
  return { theme, themeApi, api, applied, quickInput, commands, clock, view, active, open, select, push: (value: ThemeState) => push(value), main: () => main }
}

describe('theme picker items', () => {
  it('lists the modes, then each type\'s usable themes (dual themes in both), then the unusable ones', () => {
    expect(ids(themePickerItems(state(1, { mode: 'dark', darkTheme: 'dusk' }), 'dark'))).toEqual([
      ['mode.dark', 'Dark', 'mode', 'current', false], ['mode.light', 'Light', 'mode', '', false], ['mode.system', 'Follow System', 'mode', '', false],
      ['dark.varia-dark', 'Varia Dark', 'dark themes', '', false], ['dark.dusk', 'Dusk', 'dark themes', 'current', false], ['dark.harbor', 'Harbor', 'dark themes', 'user theme', false],
      ['light.varia-light', 'Varia Light', 'light themes', 'used in light mode', false], ['light.harbor', 'Harbor', 'light themes', 'user theme', false], ['light.paper', 'Paper', 'light themes', 'user theme', false],
      ['unavailable.broken', 'broken', 'unavailable', 'invalid: 3 problems', true]
    ])
    const broken = themePickerItems(state(1), 'dark').at(-1)!
    expect(broken.disabledHint).toBe('This theme has errors. Fix broken.json in the themes folder, then reload themes.')
    expect(themePickerItems({ preference: defaultThemePreference, themes: [summary('one', 'One', [], { usable: false, errors: 1 })] }, 'dark').at(-1)?.description).toBe('invalid: 1 problem')
  })
  it('says when the other type\'s theme applies, in System mode and in a fixed mode', () => {
    const descriptions = (effective: ThemeType) => Object.fromEntries(themePickerItems(state(1, { mode: 'system', lightTheme: 'harbor' }), effective).filter(item => item.description).map(item => [item.id, item.description]))
    expect(descriptions('dark')).toEqual({ 'mode.system': 'current', 'dark.varia-dark': 'current', 'dark.dusk': 'user theme', 'dark.harbor': 'user theme', 'light.harbor': 'used when the system is light', 'light.paper': 'user theme', 'unavailable.broken': 'invalid: 3 problems' })
    expect(descriptions('light')).toMatchObject({ 'dark.varia-dark': 'used when the system is dark', 'light.harbor': 'current' })
    const fixed = Object.fromEntries(themePickerItems(state(1, { mode: 'light', darkTheme: 'dusk' }), 'light').filter(item => item.description).map(item => [item.id, item.description]))
    expect(fixed).toMatchObject({ 'mode.light': 'current', 'dark.dusk': 'used in dark mode', 'light.varia-light': 'current' })
  })
  it('previews a theme row in its list, and a mode row with the theme that mode would use', () => {
    const current = state(1, { darkTheme: 'dusk', lightTheme: 'gone' })
    const item = (id: string) => themePickerItems(current, 'dark').find(row => row.id === id)
    expect(themePreviewTarget(item('light.harbor'), current)).toEqual({ id: 'harbor', type: 'light' })
    expect(themePreviewTarget(item('mode.dark'), current)).toEqual({ id: 'dusk', type: 'dark' })
    // A missing or broken choice shows the built-in, as main does.
    expect(themePreviewTarget(item('mode.light'), current)).toEqual({ id: 'varia-light', type: 'light' })
    for (const id of ['mode.system', 'unavailable.broken']) expect(themePreviewTarget(item(id), current)).toBeNull()
    expect(themePreviewTarget(undefined, current)).toBeNull()
  })
})

describe('ThemeService preview', () => {
  it('shows a theme without a new revision, keeps main\'s later states until it ends, and follows with accents', async () => {
    const { theme, applied, push } = await picker()
    const before = theme.getSnapshot(), published = vi.fn()
    theme.subscribe(published)
    const custom = '#202020', darkAccent = theme.accent(custom)
    theme.preview(resolved('paper', 'light'))
    expect(applied).toEqual(['paper/light'])
    expect(theme.getSnapshot()).toEqual({ ...before, active: resolved('paper', 'light') })
    expect(theme.state).toBe(before)
    // Accents follow the theme on screen, which changed without a new revision.
    expect(theme.accent(custom)).not.toBe(darkAccent)
    const pushed = state(2, { darkTheme: 'dusk' })
    push(pushed)
    expect(applied).toEqual(['paper/light'])
    expect(theme.getSnapshot()).toMatchObject({ revision: 2, preference: { darkTheme: 'dusk' }, active: { id: 'paper' } })
    expect(theme.state.active.id).toBe('dusk')
    theme.endPreview()
    expect(applied).toEqual(['paper/light', 'dusk/dark'])
    expect(theme.getSnapshot()).toBe(pushed)
    theme.endPreview()
    expect(applied).toHaveLength(2)
    expect(published).toHaveBeenCalledTimes(3)
  })
  it('ignores an invalid preview and keeps showing the previous theme when one cannot be applied', async () => {
    const { theme, applied } = await picker()
    theme.preview({ ...resolved('paper', 'light'), colors: {} })
    expect(applied).toEqual([])
    expect(errors).toHaveBeenCalled()
    const failing = await ThemeService.create({ getThemeState: async () => ok(state(1)), reloadThemes: vi.fn(), openThemesFolder: vi.fn(), onThemeChanged: () => () => {} },
      { apply: next => { if (next.id === 'paper') throw new Error('CSSOM failure') } })
    cleanups.push(() => failing.dispose())
    failing.preview(resolved('paper', 'light'))
    expect(failing.getSnapshot().active.id).toBe('varia-dark')
    expect(failing.state).toBe(failing.getSnapshot())
  })
  it('keeps a partly applied theme\'s notice once, and adds it for a state that arrived during the preview', async () => {
    let push: (value: unknown) => void = () => {}
    const partial = await ThemeService.create({ getThemeState: async () => ok(state(1)), reloadThemes: vi.fn(), openThemesFolder: vi.fn(), onThemeChanged: callback => { push = callback as (value: unknown) => void; return () => {} } },
      { apply: next => next.id === 'paper' ? undefined : 'The SQL editor kept its colors.' })
    cleanups.push(() => partial.dispose())
    expect(partial.getSnapshot().notice).toBe('The SQL editor kept its colors.')
    partial.preview(resolved('paper', 'light'))
    partial.endPreview()
    expect(partial.getSnapshot().notice).toBe('The SQL editor kept its colors.')
    partial.preview(resolved('paper', 'light'))
    push(state(2, { darkTheme: 'dusk' }))
    expect(partial.getSnapshot().notice).toBeUndefined()
    partial.endPreview()
    expect(partial.getSnapshot()).toMatchObject({ revision: 2, active: { id: 'dusk' }, notice: 'The SQL editor kept its colors.' })
  })
})

describe('Color Theme picker', () => {
  it('opens on the current theme with the modes, both lists, and the unusable themes', async () => {
    const { open, view, active, api, clock } = await picker(state(1, { darkTheme: 'harbor' }))
    void open()
    expect(view()).toMatchObject({ visible: true, ariaLabel: 'Select Color Theme', title: 'Select Color Theme', noun: 'themes' })
    expect(active()).toBe('dark.harbor')
    expect(view().rows.filter(row => row.group).map(row => row.group)).toEqual(['mode', 'dark themes', 'light themes', 'unavailable'])
    // The current theme is already on screen, so opening previews nothing.
    clock.advance(themePreviewDelay)
    expect(api.previewTheme).not.toHaveBeenCalled()
  })
  it('previews the row that stays active for 100 ms, and only main\'s latest answer counts', async () => {
    const { open, quickInput, api, clock, theme, applied, select } = await picker()
    void open()
    quickInput.move('next')
    quickInput.move('next')
    clock.advance(themePreviewDelay - 1)
    expect(api.previewTheme).not.toHaveBeenCalled()
    clock.advance(1)
    expect(api.previewTheme.mock.calls).toEqual([[{ id: 'harbor', type: 'dark' }]])
    await settle()
    expect(theme.getSnapshot()).toMatchObject({ revision: 1, active: { id: 'harbor', type: 'dark' } })
    expect(applied).toEqual(['harbor/dark'])
    // Answers arrive out of order: the earlier request is dropped.
    const first = deferred<ApiResult<ResolvedTheme | null>>(), second = deferred<ApiResult<ResolvedTheme | null>>()
    api.previewTheme.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await select('light.paper')
    await select('light.varia-light')
    second.resolve(ok(resolved('varia-light', 'light')))
    first.resolve(ok(resolved('paper', 'light')))
    await settle()
    expect(theme.getSnapshot().active.id).toBe('varia-light')
    expect(applied).toEqual(['harbor/dark', 'varia-light/light'])
  })
  it('previews mode rows, ends the preview on Follow System and on the current theme, and reports a failed preview', async () => {
    const { open, api, theme, select, view } = await picker(state(1, { lightTheme: 'paper' }))
    void open()
    await select('mode.light')
    expect(api.previewTheme.mock.lastCall).toEqual([{ id: 'paper', type: 'light' }])
    expect(theme.getSnapshot().active.id).toBe('paper')
    await select('mode.system')
    expect(api.previewTheme.mock.lastCall).toEqual([null])
    expect(theme.getSnapshot().active.id).toBe('varia-dark')
    await select('light.harbor')
    await select('dark.varia-dark')
    expect(api.previewTheme.mock.calls.map(call => call[0])).toEqual([{ id: 'paper', type: 'light' }, null, { id: 'harbor', type: 'light' }, null])
    expect(theme.getSnapshot().active.id).toBe('varia-dark')
    api.previewTheme.mockResolvedValueOnce({ ok: false, error: 'Unknown or unusable theme.' })
    await select('dark.dusk')
    expect(view().message).toEqual({ text: 'Could not preview the theme: Unknown or unusable theme.', severity: 'error' })
    expect(theme.getSnapshot().active.id).toBe('varia-dark')
  })
  it('puts main\'s theme back when it closes any way but accept, dropping answers still on their way', async () => {
    for (const close of ['cancel', 'blur', 'replace'] as const) {
      const { open, quickInput, api, theme, applied, select, clock } = await picker()
      const running = open()
      await select('light.paper')
      expect(theme.getSnapshot().active.id).toBe('paper')
      const late = deferred<ApiResult<ResolvedTheme | null>>()
      api.previewTheme.mockReturnValueOnce(late.promise)
      await select('dark.dusk')
      if (close === 'replace') quickInput.show({ ariaLabel: 'Other', placeholder: '', noun: 'items', items: [], onDidAccept: () => {} })
      else quickInput.hide(close)
      expect(theme.getSnapshot().active.id, close).toBe('varia-dark')
      expect(api.previewTheme.mock.lastCall, close).toEqual([null])
      late.resolve(ok(resolved('dusk', 'dark')))
      clock.advance(themePreviewDelay)
      await settle()
      expect(theme.getSnapshot().active.id, close).toBe('varia-dark')
      expect(applied, close).toEqual(['paper/light', 'varia-dark/dark'])
      expect(await running, close).toBe(true)
      expect(api.setThemePreference).not.toHaveBeenCalled()
    }
  })
  it('closes without telling main when nothing was previewed', async () => {
    const { open, quickInput, api, clock } = await picker()
    void open()
    clock.advance(themePreviewDelay)
    quickInput.hide('cancel')
    await settle()
    expect(api.previewTheme).not.toHaveBeenCalled()
  })
  it('chooses the accepted row as the View › Theme menu would, keeping its preview on screen until main has applied it', async () => {
    const cases: [Partial<ThemePreference>, string, ThemePreferencePatch][] = [
      [{ mode: 'dark' }, 'light.harbor', { darkTheme: 'harbor', lightTheme: 'harbor', mode: 'light' }],
      [{ mode: 'dark' }, 'dark.dusk', { darkTheme: 'dusk' }],
      [{ mode: 'system' }, 'light.paper', { lightTheme: 'paper' }],
      [{ mode: 'system' }, 'mode.light', { mode: 'light' }]
    ]
    for (const [preference, id, patch] of cases) {
      const { open, quickInput, api, theme, applied, select, main } = await picker(state(1, preference))
      const running = open()
      await select(id)
      const previewed = [...applied]
      quickInput.accept()
      expect(await running, id).toBe(true)
      expect(api.setThemePreference.mock.calls, id).toEqual([[patch]])
      const item = themePickerItems(state(1, preference), 'dark').find(row => row.id === id)!
      if (item.theme) expect(patch).toEqual(themeChoice(state(1, preference).preference, item.theme, item.list!))
      expect(theme.getSnapshot(), id).toEqual(main())
      expect(theme.state, id).toBe(theme.getSnapshot())
      // Main's new theme is applied once, straight from the preview, with nothing in between.
      expect(applied.slice(previewed.length), id).toEqual([shown(main().active)])
      expect(api.previewTheme.mock.calls.filter(call => call[0] === null), id).toEqual([])
    }
  })
  it('puts main\'s theme back and reports a choice main refuses', async () => {
    const { open, quickInput, api, theme, commands, select } = await picker()
    api.setThemePreference.mockResolvedValueOnce({ ok: false, error: 'Unknown or unusable theme.' })
    const running = open()
    await select('dark.dusk')
    quickInput.accept()
    expect(await running).toBe(false)
    expect(theme.getSnapshot().active.id).toBe('varia-dark')
    expect(api.previewTheme.mock.lastCall).toEqual([null])
    expect(commands.getSnapshot().error).toBe('Could not run “Preferences: Color Theme…”: Unknown or unusable theme.')
    api.setThemePreference.mockRejectedValueOnce(new Error('IPC failed'))
    const again = open()
    await select('light.paper')
    quickInput.accept()
    expect(await again).toBe(false)
    expect(theme.getSnapshot().active.id).toBe('varia-dark')
    expect(commands.getSnapshot().error).toBe('Could not run “Preferences: Color Theme…”: IPC failed')
  })
  it('leaves a newer picker\'s preview alone when an earlier choice finishes', async () => {
    const { open, quickInput, api, theme, select } = await picker()
    const pending = deferred<ApiResult<ThemeState>>()
    api.setThemePreference.mockReturnValueOnce(pending.promise)
    const first = open()
    await select('dark.dusk')
    quickInput.accept()
    void open()
    await select('light.paper')
    pending.resolve(ok(state(2, { darkTheme: 'dusk' })))
    expect(await first).toBe(true)
    expect(theme.getSnapshot()).toMatchObject({ revision: 2, active: { id: 'paper' } })
    quickInput.hide('cancel')
    expect(theme.getSnapshot().active.id).toBe('dusk')
  })
  it('ends the preview when the workbench goes away', async () => {
    const { open, quickInput, theme, select, api } = await picker()
    void open()
    await select('light.paper')
    quickInput.dispose()
    expect(theme.getSnapshot().active.id).toBe('varia-dark')
    expect(api.previewTheme.mock.lastCall).toEqual([null])
  })
})

describe('theme commands', () => {
  it('create, open the folder, and reload through main, reporting failures in the command banner', async () => {
    const { commands, api, themeApi, theme } = await picker()
    expect(await commands.execute('preferences.createTheme', undefined, 'palette')).toBe(true)
    expect(api.createCustomTheme).toHaveBeenCalledOnce()
    api.createCustomTheme.mockResolvedValueOnce({ ok: false, error: 'The themes folder already has 64 theme files, the most Varia loads; remove one before creating another.' })
    expect(await commands.execute('preferences.createTheme', undefined, 'palette')).toBe(false)
    expect(commands.getSnapshot().error).toBe('Could not run “Preferences: Create Custom Theme…”: The themes folder already has 64 theme files, the most Varia loads; remove one before creating another.')
    expect(await commands.execute('preferences.openThemesFolder', undefined, 'palette')).toBe(true)
    expect(themeApi.openThemesFolder).toHaveBeenCalledOnce()
    expect(await commands.execute('preferences.reloadThemes', undefined, 'palette')).toBe(true)
    expect(theme.getSnapshot().revision).toBe(50)
  })
  it('opens the picker from the palette after the palette has returned focus', async () => {
    const fixture = workbenchFixture()
    cleanups.push(fixture.dispose)
    fixture.focus.focused = 'grid'
    await fixture.commands.execute('workbench.showCommands', undefined, 'keybinding')
    fixture.focus.focused = 'quick input'
    fixture.quickInput.filter('>color theme')
    expect(fixture.quickInput.getSnapshot().rows[0].item).toMatchObject({ id: 'preferences.colorTheme', label: 'Preferences: Color Theme…', icon: 'symbol-color' })
    fixture.quickInput.accept()
    await settle()
    expect(fixture.quickInput.getSnapshot()).toMatchObject({ visible: true, ariaLabel: 'Select Color Theme' })
    fixture.quickInput.hide('cancel')
    expect(fixture.focus.focused).toBe('grid')
    expect(fixture.theme.endPreview).toHaveBeenCalled()
  })
})
