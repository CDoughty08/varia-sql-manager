import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const renderer = join('src', 'renderer')
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : [])
/** The renderer modules allowed their own keydown or keyup listener, and why. */
const allowed: Readonly<Record<string, string>> = {
  'src/core/keybindings.ts': 'the workbench dispatcher, which routes keys to the menus first',
  'src/docking-guides.ts': 'tracks Ctrl during a panel drag; it dispatches no command'
}

describe('keyboard lint', () => {
  it('keeps workbench key handling in the dispatcher', () => {
    const listeners = files(renderer).filter(file => /addEventListener\(\s*['"`]key(down|up)['"`]/.test(readFileSync(file, 'utf8'))).map(file => relative(renderer, file).replaceAll('\\', '/'))
    expect(listeners.sort()).toEqual(Object.keys(allowed).sort())
    // Main handles no keys: F10, Alt, and every shortcut reach the renderer's dispatcher.
    expect(readFileSync(join('src', 'main', 'index.ts'), 'utf8')).not.toMatch(/before-input-event/)
    for (const file of [join('src', 'main', 'index.ts'), join('src', 'preload', 'index.ts')]) expect(readFileSync(file, 'utf8'), file).not.toMatch(/varia:menu-(popup|focus)/)
  })
  it('keeps the legacy shortcut paths deleted', () => {
    for (const file of files(join('src'))) {
      const source = readFileSync(file, 'utf8')
      for (const legacy of ['bindFileShortcuts', 'bindQueryActions', 'fileShortcut', 'menuShortcut', 'shared/shortcuts']) expect(source.includes(legacy), `${file} uses ${legacy}`).toBe(false)
    }
  })
  it('keeps the menu layer above everything else', () => {
    // Menus open over the docking guides, the quick input, and dialogs (text fields in dialogs have menus).
    const css = readFileSync(join(renderer, 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const layers = [...css.matchAll(/([^{}]+)\{[^{}]*?z-index:\s*(\d+)/g)].map(([, selector, value]) => [selector.trim(), Number(value)] as const)
    expect(layers.filter(([, value]) => value >= 30000)).toEqual([['.menu-layer', 30000]])
    expect(layers.length).toBeGreaterThan(3)
  })
})
