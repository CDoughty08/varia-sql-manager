import { afterEach, describe, expect, it } from 'vitest'
import type { Platform } from '../src/shared/commands/keybindings'
import { applicationMenus } from '../src/shared/commands/menus'
import type { ThemeState, ThemeSummary } from '../src/shared/theme/types'
import type { ResolvedMenuItem } from '../src/renderer/src/menus/resolve'
import { connectionInfo, workbenchFixture } from './fixtures/workbench'
import { deferred } from './fixtures/documents'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const themes: ThemeSummary[] = [
  { id: 'varia-dark', name: 'Varia Dark', source: 'builtin', types: ['dark'], usable: true, errors: 0, warnings: 0 },
  { id: 'varia-light', name: 'Varia Light', source: 'builtin', types: ['light'], usable: true, errors: 0, warnings: 0 },
  { id: 'harbor', name: 'Harbor & Sea', source: 'user', types: ['dark', 'light'], usable: true, errors: 0, warnings: 0 }
]
const states = ['disconnected', 'connected', 'running', 'busy'] as const

/** Every title-bar menu, resolved as the custom menus show it, in each workbench state: one snapshot per state. */
async function resolveAll(platform: Platform): Promise<(readonly ResolvedMenuItem[])[][]> {
  const fixture = workbenchFixture({ platform })
  cleanups.push(fixture.dispose)
  const theme = fixture.theme as { state: ThemeState }
  theme.state = { ...theme.state, themes }
  fixture.context.set({ backendReady: true })
  fixture.panes.set({ explorer: true, editor: true, output: true })
  const tab = fixture.documents.create('SQLQuery1.sql', 'SELECT 1', 'master')
  const snapshots: (readonly ResolvedMenuItem[])[][] = []
  const capture = () => { snapshots.push(applicationMenus.map(menu => fixture.menus.resolve(menu.id))) }
  capture()
  fixture.connections.add(connectionInfo('server-a'))
  fixture.targets.update(tab.id, { connectionId: 'server-a' })
  capture()
  const running = fixture.startQuery()
  capture()
  await running.finish()
  const task = deferred<void>(), busy = fixture.documents.runTask(() => task.promise)
  capture()
  task.resolve()
  await busy
  return snapshots
}

/**
 * One line per item: the title with `&` before its access key, its keys, its check or radio mark, and whether it is
 * enabled in each state (+ or -, in the order of `states`).
 */
function describeMenus(platform: Platform, snapshots: (readonly ResolvedMenuItem[])[][]): string {
  const lines = [`# Title-bar menus on ${platform}; enablement per state: ${states.join(', ')}`]
  const visit = (levels: (readonly ResolvedMenuItem[])[], depth: number) => {
    levels[0].forEach((item, index) => {
      const indent = '  '.repeat(depth)
      if (item.kind === 'separator') { lines.push(indent + '---'); return }
      const title = item.mnemonic < 0 ? item.title : item.title.slice(0, item.mnemonic) + '&' + item.title.slice(item.mnemonic)
      if (item.kind === 'submenu') {
        lines.push(`${indent}${title} >`)
        visit(levels.map(level => { const same = level[index]; return same.kind === 'submenu' ? same.items : [] }), depth + 1)
        return
      }
      const mark = item.checked === undefined ? '' : item.radio ? (item.checked ? ' (*)' : ' ( )') : (item.checked ? ' [x]' : ' [ ]')
      const enabled = levels.map(level => { const same = level[index]; return same.kind === 'command' && same.enabled ? '+' : '-' }).join('')
      lines.push(`${indent}${title}${item.keybinding ? `  ${item.keybinding.text}` : ''}${mark}  ${enabled}`)
    })
  }
  applicationMenus.forEach((menu, index) => {
    lines.push(menu.label)
    visit(snapshots.map(snapshot => snapshot[index]), 1)
  })
  return lines.join('\n') + '\n'
}

describe('title-bar menu content', () => {
  it.each(['win32', 'linux'] as const)('is pinned on %s', async platform => {
    const snapshots = await resolveAll(platform)
    // Regenerate deliberately with `npx vitest run tests/menus-content.test.ts -u`, and review it against the spec's menu tables.
    await expect(describeMenus(platform, snapshots)).toMatchFileSnapshot(`fixtures/menus-content.${platform}.txt`)
  })
  it('shows the same structure in every state, with the platform\'s Exit or Quit', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const snapshots = await resolveAll(platform)
      const shape = (items: readonly ResolvedMenuItem[]): unknown[] => items.map(item => item.kind === 'submenu' ? [item.key, shape(item.items)] : item.key)
      for (const snapshot of snapshots) expect(snapshot.map(shape)).toEqual(snapshots[0].map(shape))
      expect(snapshots[0][0].at(-1)).toMatchObject(platform === 'win32' ? { title: 'Exit', keybinding: { text: 'Alt+F4' } } : { title: 'Quit', keybinding: { text: 'Ctrl+Q' } })
    }
  })
})
