import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { boundedClose, groupMembers, trackElectronProcess } from '../scripts/fixtures/smoke.mjs'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync: vi.fn()
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let exitCode: typeof process.exitCode

beforeEach(() => {
  exitCode = process.exitCode
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  process.exitCode = exitCode
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const usePlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...platform, value })
const fakeApplication = () => {
  const child = { pid: 4321, kill: vi.fn(() => true) }
  return { child, application: { process: () => child } }
}

describe('smoke close backstop', () => {
  it('owns a raw Windows app tree only until that exact child exits, even when another launch reuses its pid', () => {
    usePlatform('win32')
    const child = Object.assign(new EventEmitter(), { pid: 4321, kill: vi.fn((_signal?: NodeJS.Signals) => true) })
    const replacement = Object.assign(new EventEmitter(), { pid: child.pid, kill: vi.fn((_signal?: NodeJS.Signals) => true) })
    const application = { process: () => child } as unknown as Parameters<typeof trackElectronProcess>[0]
    const next = { process: () => replacement } as unknown as Parameters<typeof trackElectronProcess>[0]
    vi.mocked(execFileSync).mockClear()
    try {
      expect(trackElectronProcess(application)).toBe(application)
      expect(child.kill('SIGKILL')).toBe(true)
      expect(execFileSync).toHaveBeenCalledExactlyOnceWith('taskkill', ['/PID', '4321', '/T', '/F'], { stdio: 'ignore' })
      child.emit('exit', 0, null)
      vi.mocked(execFileSync).mockClear()
      expect(child.kill('SIGKILL')).toBe(false)
      expect(execFileSync).not.toHaveBeenCalled()
      trackElectronProcess(next)
      expect(child.kill('SIGKILL')).toBe(false)
      expect(execFileSync).not.toHaveBeenCalled()
      expect(replacement.kill('SIGKILL')).toBe(true)
      expect(execFileSync).toHaveBeenCalledExactlyOnceWith('taskkill', ['/PID', '4321', '/T', '/F'], { stdio: 'ignore' })
    } finally { child.emit('exit', 0, null); replacement.emit('exit', 0, null) }
  })

  it.each(['linux', 'darwin'] as const)('kills a hung app\'s process group on %s so descendants release its pipes', async value => {
    usePlatform(value)
    const { child, application } = fakeApplication()
    let releasePipes!: () => void
    const closed = new Promise<void>(resolve => { releasePipes = resolve })
    vi.mocked(process.kill).mockImplementation((pid, signal) => {
      // Killing the leader alone leaves the descendant holding stdout open.
      if (pid === -child.pid && signal === 'SIGKILL') releasePipes()
      return true
    })
    process.exitCode = 7
    const closing = boundedClose(application, () => closed, 100)
    await vi.advanceTimersByTimeAsync(99)
    expect(process.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await closing
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-child.pid, 'SIGKILL')
    expect(child.kill).not.toHaveBeenCalled()
    await expect(closed).resolves.toBeUndefined()
    expect(process.exitCode).toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('the suite fails'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps Windows cleanup on the child kill override that ends its whole tree', async () => {
    usePlatform('win32')
    const { child, application } = fakeApplication()
    const closing = boundedClose(application, () => new Promise(() => {}), 100)
    await vi.advanceTimersByTimeAsync(100)
    await closing
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(process.kill).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('falls back to the leader when its process group is already gone and retains the failure', async () => {
    usePlatform('linux')
    const { child, application } = fakeApplication()
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }) })
    child.kill.mockReturnValue(false)
    const closing = boundedClose(application, () => new Promise(() => {}), 100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(closing).resolves.toBeUndefined()
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-child.pid, 'SIGKILL')
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(process.exitCode).toBe(1)
  })

  it('leaves a normal close and its exit code alone without keeping its timer', async () => {
    const { child, application } = fakeApplication()
    process.exitCode = 7
    await boundedClose(application, async () => {}, 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(process.kill).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(7)
    expect(vi.getTimerCount()).toBe(0)
  })

  // A hung close on CI showed only that main had exited; the process that still held its pipes went unnamed.
  it.runIf(process.platform === 'linux')('names the processes still in a process group', async () => {
    vi.useRealTimers()
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
    try {
      await once(child, 'spawn')
      expect(groupMembers(child.pid!)).toEqual([expect.stringMatching(new RegExp(`^.+ ${child.pid} [RSD]$`))])
    } finally {
      child.stdin.end()
      await once(child, 'exit')
    }
    expect(groupMembers(child.pid!)).toEqual([])
  })

  it('propagates a close error without replacing it with timeout cleanup', async () => {
    const { child, application } = fakeApplication()
    process.exitCode = 7
    await expect(boundedClose(application, async () => { throw new Error('close failed') }, 100)).rejects.toThrow('close failed')
    await vi.advanceTimersByTimeAsync(100)
    expect(process.kill).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(7)
    expect(vi.getTimerCount()).toBe(0)
  })
})
