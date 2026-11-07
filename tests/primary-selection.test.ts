import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blockPrimaryPaste } from '../src/renderer/src/core/primary-selection'

const mouseUp = (button: number) => Object.assign(new Event('mouseup', { cancelable: true }), { button })

describe('PRIMARY selection paste', () => {
  it('cancels only the middle-button mouseup, and only on Linux', () => {
    const target = new EventTarget()
    const guard = blockPrimaryPaste(target, 'linux')
    const middle = mouseUp(1), left = mouseUp(0)
    target.dispatchEvent(middle); target.dispatchEvent(left)
    expect([middle.defaultPrevented, left.defaultPrevented]).toEqual([true, false])
    guard.dispose()
    const after = mouseUp(1)
    target.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
    for (const platform of ['win32', 'darwin'] as const) {
      const other = new EventTarget(), event = mouseUp(1)
      blockPrimaryPaste(other, platform)
      other.dispatchEvent(event)
      expect(event.defaultPrevented, platform).toBe(false)
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
