import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, type ApplicationMenuActions } from '../src/main/application-menu'
import { platforms } from '../src/shared/commands/keybindings'
import type { ThemeSummary } from '../src/shared/theme/types'

const theme = (id: string, name: string, types: ThemeSummary['types'], usable = true): ThemeSummary => ({ id, name, source: 'user', types, usable, errors: usable ? 0 : 1, warnings: 0 })
const themes: ThemeSummary[] = [
  { id: 'varia-dark', name: 'Varia Dark', source: 'builtin', types: ['dark'], usable: true, errors: 0, warnings: 0 },
  { id: 'varia-light', name: 'Varia Light', source: 'builtin', types: ['light'], usable: true, errors: 0, warnings: 0 },
  theme('harbor', 'Harbor & Sea', ['dark', 'light']), theme('dusk', 'Dusk', ['dark']), theme('paper', 'Paper', ['light']), theme('broken', 'broken', [], false)
]

/**
 * Every item of the native template with its click replaced by what the click does, so a change to the generated
 * menus (ids, labels, roles, accelerators, order, or actions) shows up as a snapshot diff. Regenerate deliberately with
 * `npx vitest run tests/application-menu-snapshot.test.ts -u`.
 */
function describeTemplate(platform: NodeJS.Platform): string {
  const calls: unknown[] = []
  const actions: ApplicationMenuActions = {
    command: id => calls.push(['command', id]), isChecked: id => id === 'editor.toggleWordWrap', setTheme: patch => calls.push(['setTheme', patch]),
    createTheme: () => calls.push(['createTheme']), openThemesFolder: () => calls.push(['openThemesFolder']), reloadThemes: () => calls.push(['reloadThemes'])
  }
  const template = applicationMenuTemplate({ theme: { preference: { version: 1, mode: 'system', darkTheme: 'dusk', lightTheme: 'gone' }, themes } }, actions, platform)
  // One line per item, indented by depth, so a diff names the items that changed.
  const visit = (items: readonly MenuItemConstructorOptions[], depth: number): string[] => items.flatMap(item => {
    const { click, submenu, ...rest } = item
    // Key order and Electron's default `enabled: true` are not behaviour.
    const described: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([key, value]) => key !== 'enabled' || value !== true).sort(([a], [b]) => a < b ? -1 : 1))
    if (click) {
      calls.length = 0
      const target = { checked: false }
      ;(click as (menuItem: typeof target) => void)(target)
      described.click = [...calls]
      if (item.type === 'checkbox') described.checkedAfterClick = target.checked
    }
    return ['  '.repeat(depth) + JSON.stringify(described), ...Array.isArray(submenu) ? visit(submenu, depth + 1) : []]
  })
  return visit(template, 0).join('\n') + '\n'
}

describe('native application menu template', () => {
  it.each(platforms)('is pinned on %s', async platform => {
    await expect(describeTemplate(platform)).toMatchFileSnapshot(`fixtures/application-menu.${platform}.txt`)
  })
})
