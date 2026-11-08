import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ignoreCrashedTargetReplies, isCrashedTargetReply } from '../scripts/fixtures/playwright-races.mjs'

const fromSession = (message: string) => {
  const error = new Error(message)
  error.stack = `Error: ${message}\n    at assert (coreBundle.js:838:11)\n    at _CRSession._onMessage (coreBundle.js:35014:11)\n    at CRConnection._onMessage (coreBundle.js:34951:20)`
  return error
}

describe('Playwright crashed-target race', () => {
  it("recognises only CRSession's assertion on a crashed target's late reply", () => {
    expect(isCrashedTargetReply(fromSession('Target crashed'))).toBe(true)
    expect(isCrashedTargetReply(fromSession('Something else'))).toBe(false)
    expect(isCrashedTargetReply(new Error('Target crashed'))).toBe(false)
    expect(isCrashedTargetReply('Target crashed')).toBe(false)
  })

  it('keeps the suite running for that reply and exits 1 for any other uncaught exception', () => {
    const target = Object.assign(new EventEmitter(), { exit: vi.fn() })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {})
    ignoreCrashedTargetReplies(target as unknown as NodeJS.Process)
    target.emit('uncaughtException', fromSession('Target crashed'))
    expect(target.exit).not.toHaveBeenCalled()
    target.emit('uncaughtException', new Error('real failure'))
    expect(target.exit).toHaveBeenCalledWith(1)
    warn.mockRestore(); error.mockRestore()
  })

  it('is installed by the smoke fixture every suite imports', async () => {
    const { readFile } = await import('node:fs/promises')
    expect(await readFile('scripts/fixtures/smoke.mjs', 'utf8')).toMatch(/^ignoreCrashedTargetReplies\(\)$/m)
  })
})
