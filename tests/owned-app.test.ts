import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exited, removeProfile } from '../scripts/fixtures/owned-app.mjs'

// packaged-smoke.mjs and portable-smoke.mjs removed their temporary profile with a bare rmSync as the last statement of
// finally, right after the kill: a file the dying app still held made it throw EBUSY, which replaced the run's real error
// and failed a run that had passed (#323).

class Child extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
}

describe('owned application cleanup', () => {
  afterEach(() => { vi.restoreAllMocks() })
  it('waits for the killed process to exit, and leaves no listener behind', async () => {
    const child = new Child()
    const waiting = exited(child, 60_000)
    child.exitCode = 1
    child.emit('exit', 1, null)
    expect(await waiting).toBe(true)
    expect(child.listenerCount('exit')).toBe(0)
  })
  it('answers at once for a process that already exited or was signalled', async () => {
    expect(await exited(Object.assign(new Child(), { exitCode: 0 }), 60_000)).toBe(true)
    expect(await exited(Object.assign(new Child(), { signalCode: 'SIGKILL' as const }), 60_000)).toBe(true)
  })
  it('gives up after its bound on a process that never exits', async () => {
    const child = new Child()
    expect(await exited(child, 1)).toBe(false)
    expect(child.listenerCount('exit')).toBe(0)
  })
  it('removes the profile', () => {
    const profile = mkdtempSync(join(tmpdir(), 'varia-owned-app-test-'))
    writeFileSync(join(profile, 'Preferences'), '{}')
    expect(removeProfile(profile)).toBe(true)
    expect(existsSync(profile)).toBe(false)
  })
  it('warns instead of throwing when a file is still held', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const busy = () => { throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' }) }
    expect(removeProfile('varia-packaged-smoke-held', busy)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not remove the temporary profile varia-packaged-smoke-held: EBUSY/))
  })
  it('is the only way the smoke scripts remove their profile, after waiting for the exit', () => {
    for (const script of ['scripts/packaged-smoke.mjs', 'scripts/portable-smoke.mjs']) {
      const code = readFileSync(script, 'utf8')
      expect(code, script).not.toMatch(/\brmSync\b/)
      expect(code.indexOf('await exited(child, closeMs)'), script).toBeGreaterThan(code.indexOf('finally {'))
      expect(code.indexOf('removeProfile('), script).toBeGreaterThan(code.indexOf('await exited(child, closeMs)'))
    }
  })
})
