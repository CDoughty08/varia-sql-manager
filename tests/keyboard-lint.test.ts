import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const renderer = join('src', 'renderer')
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : [])
/** The renderer modules allowed their own keydown listener, and why. */
const allowed: Readonly<Record<string, string>> = {
  'src/core/keybindings.ts': 'the workbench dispatcher',
  'src/TitleBar.tsx': 'Alt mnemonics and F10 sent by the test driver, until PR3 moves menu access to the renderer',
  'src/docking-guides.ts': 'tracks Ctrl during a panel drag; it dispatches no command'
}

describe('keyboard lint', () => {
  it('keeps workbench key handling in the dispatcher', () => {
    const listeners = files(renderer).filter(file => /addEventListener\(\s*['"`]key(down|up)['"`]/.test(readFileSync(file, 'utf8'))).map(file => relative(renderer, file).replaceAll('\\', '/'))
    expect(listeners.sort()).toEqual(Object.keys(allowed).sort())
  })
  it('keeps the legacy shortcut paths deleted', () => {
    for (const file of files(join('src'))) {
      const source = readFileSync(file, 'utf8')
      for (const legacy of ['bindFileShortcuts', 'bindQueryActions', 'fileShortcut', 'menuShortcut', 'shared/shortcuts']) expect(source.includes(legacy), `${file} uses ${legacy}`).toBe(false)
    }
  })
})
