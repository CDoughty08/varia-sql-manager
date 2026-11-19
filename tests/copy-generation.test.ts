// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { beginCopy, latestCopy } from '../src/renderer/src/grid/copy-generation'

describe('copy generations', () => {
  afterEach(() => { Reflect.deleteProperty(window, 'varia') })
  it('keep only the latest copy, and stop it once the page writes other text to the clipboard', () => {
    let writes = 0
    Object.defineProperty(window, 'varia', { configurable: true, value: { clipboardWrites: () => writes } })
    const first = beginCopy()
    expect(latestCopy(first)).toBe(true)
    const second = beginCopy()
    expect(latestCopy(first)).toBe(false)
    expect(latestCopy(second)).toBe(true)
    // Script As, Copy Path or any other text written meanwhile supersedes it, as main's write cancels a results copy.
    writes++
    expect(latestCopy(second)).toBe(false)
    expect(latestCopy(beginCopy())).toBe(true)
  })
})
