// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeShortcutsService } from '../src/renderer/src/core/ShortcutsService.fake'
import { ShortcutsProvider } from '../src/renderer/src/core/ShortcutsContext'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import OptionsDialog from '../src/renderer/src/settings/OptionsDialog'
import { SettingsService } from '../src/renderer/src/settings/SettingsService'
import { defaultSettings, type SettingsValues } from '../src/shared/settings/catalog'
import type { SettingsPatch } from '../src/shared/settings/schema'
import { defaultThemePreference } from '../src/shared/theme/format'
import { resolveBuiltin } from '../src/shared/theme/resolve'

// A profile whose saved values differ from their defaults, set outside Options: the column profile from the grid's
// toolbar, the plan's pane widths by dragging, the theme mode from View › Theme. Opening Options shows none as Modified.
const saved: SettingsValues = {
  ...defaultSettings,
  'queryResults.grid.columnProfile': true,
  'queryResults.plan.outlineWidth': 300,
  'queryResults.plan.propertiesWidth': 468,
  'textEditor.sql.viewWhiteSpace': true
}
const gridPage = 'queryResults.sqlServer.grid'

describe('Options Modified filter', () => {
  let root: Root, host: HTMLElement
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => { act(() => root.unmount()); host.remove() })

  const mount = async () => {
    let values = saved, revision = 1
    const updateSettings = vi.fn(async (patch: SettingsPatch) => {
      values = { ...values, ...patch } as SettingsValues
      return { ok: true, value: { revision: ++revision, values } }
    })
    const settings = new SettingsService({
      getSettings: async () => ({ ok: true, value: { revision, values } }),
      updateSettings,
      onSettingsChanged: () => () => {}
    } as never)
    await settings.load()
    settings.openDialog(gridPage)
    const themeState = { revision: 0, preference: { ...defaultThemePreference, mode: 'system' as const }, active: resolveBuiltin('dark'), fallback: false, themes: [], problems: [], problemsOmitted: 0, noticeId: 0 }
    const theme = { subscribe: () => () => {}, getSnapshot: () => themeState, preview: vi.fn(), endPreview: vi.fn() }
    const workbench = { settings, platform: 'win32', keybindings: { capture: () => () => {} }, documents: { focusActive: vi.fn() }, theme } as unknown as Workbench
    await act(async () => root.render(createElement(WorkbenchProvider, { workbench, children: createElement(ShortcutsProvider, { shortcuts: createFakeShortcutsService(), children: createElement(OptionsDialog, { page: gridPage }) }) })))
    return { updateSettings }
  }
  const modified = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim().startsWith('Modified ('))!
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name)!
  const outline = () => host.querySelector<HTMLInputElement>('input[role="switch"][data-setting="queryResults.plan.outline"]')!

  it('counts only edits not saved yet, not saved values that differ from their defaults', async () => {
    const { updateSettings } = await mount()
    await vi.waitFor(() => expect(host.querySelector('[data-setting="queryResults.plan.outlineWidth"]')).not.toBeNull())
    expect(modified().textContent).toBe('Modified (0)')
    expect(host.querySelector('[data-modified]')).toBeNull()

    // An edit is Modified until it is saved; changing it back to the saved value clears it.
    await act(async () => outline().click())
    expect(modified().textContent).toBe('Modified (1)')
    expect(host.querySelector(`[data-page="${gridPage}"]`)?.hasAttribute('data-modified')).toBe(true)
    await act(async () => outline().click())
    expect(modified().textContent).toBe('Modified (0)')

    await act(async () => outline().click())
    await act(async () => modified().click())
    expect(host.textContent).toContain('Modified Settings')
    expect(host.querySelector('input[role="switch"][data-setting="queryResults.plan.outline"]')).not.toBeNull()
    expect(host.querySelector('[data-setting="queryResults.plan.outlineWidth"]')).toBeNull()

    // Apply saves it: nothing is Modified any more.
    await act(async () => button('Apply').click())
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ 'queryResults.plan.outline': false }))
    await vi.waitFor(() => expect(modified().textContent).toBe('Modified (0)'))
    expect(host.textContent).toContain('No unsaved changes.')
  })
})
