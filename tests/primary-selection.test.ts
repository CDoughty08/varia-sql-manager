import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blockPrimaryPaste } from '../src/renderer/src/core/primary-selection'

const release = (type: string, button: number) => Object.assign(new Event(type, { cancelable: true }), { button })

describe('PRIMARY selection paste', () => {
  it('cancels only middle-button releases, pointerup and chorded pointermove included, and only on Linux', () => {
    const target = new EventTarget()
    const guard = blockPrimaryPaste(target, 'linux')
    // A cancelled pointerdown leaves no mouseup, and Chromium still pastes unless the pointerup is cancelled.
    // A chorded release (another button still held) comes as a pointermove whose button is the middle one.
    for (const type of ['mouseup', 'pointerup', 'pointermove']) {
      const middle = release(type, 1), left = release(type, 0), down = release(type.replace(/up|move/, 'down'), 1), none = release(type, -1)
      for (const event of [middle, left, down, none]) target.dispatchEvent(event)
      expect([middle.defaultPrevented, left.defaultPrevented, down.defaultPrevented, none.defaultPrevented], type).toEqual([true, false, false, false])
    }
    guard.dispose()
    for (const type of ['mouseup', 'pointerup', 'pointermove']) {
      const after = release(type, 1)
      target.dispatchEvent(after)
      expect(after.defaultPrevented, type).toBe(false)
    }
    for (const platform of ['win32', 'darwin'] as const) {
      const other = new EventTarget()
      blockPrimaryPaste(other, platform)
      for (const type of ['mouseup', 'pointerup', 'pointermove', 'paste']) {
        const event = release(type, 1)
        other.dispatchEvent(event)
        expect(event.defaultPrevented, platform + ' ' + type).toBe(false)
      }
    }
  })
  it('hides a paste in the same task as a middle-button release from every other listener, and no other paste', async () => {
    const target = new EventTarget(), seen: string[] = []
    const guard = blockPrimaryPaste(target, 'linux')
    target.addEventListener('paste', () => seen.push('paste'), { capture: true })
    const paste = () => { const event = new Event('paste', { cancelable: true }); target.dispatchEvent(event); return event.defaultPrevented }
    // The Paste role's paste: no middle button in its task.
    expect(paste()).toBe(false)
    for (const type of ['auxclick', 'mouseup', 'pointerup', 'pointermove']) {
      await new Promise(resolve => setTimeout(resolve))
      target.dispatchEvent(release(type, 1))
      expect(paste(), type).toBe(true)
    }
    await new Promise(resolve => setTimeout(resolve))
    // The task ended: a later paste is the Paste role's again. A left-button release marks nothing.
    target.dispatchEvent(release('auxclick', 0))
    expect(paste()).toBe(false)
    expect(seen).toEqual(['paste', 'paste'])
    guard.dispose()
  })
  it('guards the main window and every popout, and keeps Monaco off the selection clipboard', () => {
    const workbench = readFileSync(join('src', 'renderer', 'src', 'core', 'workbench.ts'), 'utf8')
    expect(workbench.match(/blockPrimaryPaste\(window, platform\)/g)).toHaveLength(1)
    // attachWindow: each popout window while it is open.
    expect(workbench).toMatch(/attachWindow: target => \{\n\s+const attached = \[[^\]]*blockPrimaryPaste\(target, platform\)/)
    expect(readFileSync(join('src', 'renderer', 'src', 'editor', 'create-editor.ts'), 'utf8')).toMatch(/selectionClipboard: false/)
  })
})
