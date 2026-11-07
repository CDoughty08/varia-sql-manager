import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blockPrimaryPaste } from '../src/renderer/src/core/primary-selection'

const release = (type: string, button: number) => Object.assign(new Event(type, { cancelable: true }), { button })

describe('PRIMARY selection paste', () => {
  it('cancels only middle-button releases, pointerup included, and only on Linux', () => {
    const target = new EventTarget()
    const guard = blockPrimaryPaste(target, 'linux')
    // A cancelled pointerdown leaves no mouseup, and Chromium still pastes unless the pointerup is cancelled.
    for (const type of ['mouseup', 'pointerup']) {
      const middle = release(type, 1), left = release(type, 0), down = release(type.replace('up', 'down'), 1)
      for (const event of [middle, left, down]) target.dispatchEvent(event)
      expect([middle.defaultPrevented, left.defaultPrevented, down.defaultPrevented], type).toEqual([true, false, false])
    }
    guard.dispose()
    for (const type of ['mouseup', 'pointerup']) {
      const after = release(type, 1)
      target.dispatchEvent(after)
      expect(after.defaultPrevented, type).toBe(false)
    }
    for (const platform of ['win32', 'darwin'] as const) {
      const other = new EventTarget()
      blockPrimaryPaste(other, platform)
      for (const type of ['mouseup', 'pointerup']) {
        const event = release(type, 1)
        other.dispatchEvent(event)
        expect(event.defaultPrevented, platform + ' ' + type).toBe(false)
      }
    }
  })
  it('guards the main window and every popout, and keeps Monaco off the selection clipboard', () => {
    const workbench = readFileSync(join('src', 'renderer', 'src', 'core', 'workbench.ts'), 'utf8')
    expect(workbench.match(/blockPrimaryPaste\(window, platform\)/g)).toHaveLength(1)
    // attachWindow: each popout window while it is open.
    expect(workbench).toMatch(/attachWindow: target => \{\n\s+const attached = \[[^\]]*blockPrimaryPaste\(target, platform\)/)
    expect(readFileSync(join('src', 'renderer', 'src', 'editor', 'create-editor.ts'), 'utf8')).toMatch(/selectionClipboard: false/)
  })
})
