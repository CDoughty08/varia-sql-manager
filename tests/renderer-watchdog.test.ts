import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { processAlive, RendererWatchdog, type WatchedContents } from '../src/main/renderer-watchdog'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

/** A window's contents and the OS processes, as the watchdog sees them; `tick` runs one check. */
function watched(pid = 100) {
  const state = { pid, crashed: false, destroyed: false, dead: new Set<number>() }
  const gone: number[] = []
  let callback: (() => void) | undefined, cleared = false
  const contents: WatchedContents = { isDestroyed: () => state.destroyed, isCrashed: () => state.crashed, getOSProcessId: () => state.pid }
  const watchdog = new RendererWatchdog(contents, {
    alive: id => !state.dead.has(id), gone: id => gone.push(id),
    timers: { setInterval: run => { callback = run; return 1 }, clearInterval: () => { cleared = true } }
  })
  return { state, gone, watchdog, tick: (times = 1) => { for (let index = 0; index < times; index++) callback?.() }, cleared: () => cleared }
}

describe('renderer watchdog', () => {
  it('reports a renderer whose process exited unseen by Chromium once, on the second check in a row', () => {
    const { state, gone, tick } = watched()
    tick(5)
    expect(gone).toEqual([])
    state.dead.add(100)
    tick()
    expect(gone).toEqual([])
    tick()
    expect(gone).toEqual([100])
    tick(5)
    expect(gone).toEqual([100])
  })
  it('leaves a renderer Chromium saw go to Chromium\'s own report, even when it noticed between checks', () => {
    const { state, gone, tick } = watched()
    state.dead.add(100)
    tick()
    state.crashed = true
    tick(5)
    expect(gone).toEqual([])
  })
  it('watches each new renderer process, and none while the next one is launching', () => {
    const { state, gone, tick } = watched()
    state.dead.add(100)
    tick(2)
    state.pid = 0
    tick(3)
    state.pid = 200
    tick(3)
    expect(gone).toEqual([100])
    state.dead.add(200)
    tick(2)
    expect(gone).toEqual([100, 200])
  })
  it('restarts its count when the process changes between checks', () => {
    const { state, gone, tick } = watched()
    state.dead.add(100).add(200)
    tick()
    state.pid = 200
    tick()
    expect(gone).toEqual([])
    tick()
    expect(gone).toEqual([200])
  })
  it('stops with its window', () => {
    const { state, gone, tick, cleared } = watched()
    state.destroyed = true
    state.dead.add(100)
    tick(3)
    expect({ gone, cleared: cleared() }).toEqual({ gone: [], cleared: true })
  })
  it('tells a running process from one that has exited', async () => {
    expect(processAlive(process.pid)).toBe(true)
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await once(child, 'exit')
    expect(processAlive(child.pid!)).toBe(false)
  })
  it('rejects process-group and invalid PIDs without probing the OS', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      for (const pid of [0, -1, -100, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(processAlive(pid)).toBe(false)
      expect(kill).not.toHaveBeenCalled()
    } finally { kill.mockRestore() }
  })
  it('recognizes Linux terminal states without misreading comm or treating an unavailable procfs as death', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const read = vi.mocked(readFileSync), kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
      // Linux comm can contain parentheses and newlines; the state follows its final closing parenthesis.
      for (const state of ['Z', 'X', 'x', 'R', 'S', 'D', 'T', 't', 'I']) {
        read.mockReturnValue(`123 (renderer ) name\n(with parens)) ${state} 42 0 0 0\n`)
        expect(processAlive(123), state).toBe(!['Z', 'X', 'x'].includes(state))
      }
      expect(read).toHaveBeenLastCalledWith('/proc/123/stat', 'utf8')
      for (const malformed of ['', '999 (renderer) Z 42 0', '123 (renderer Z 42 0', '123 (renderer) Z', '123 (renderer) Z not-a-ppid', '123 (renderer) ? 42 0']) {
        read.mockReturnValue(malformed)
        expect(processAlive(123), malformed).toBe(true)
      }
      read.mockImplementation(() => { throw Object.assign(new Error('Restricted procfs'), { code: 'EACCES' }) })
      expect(processAlive(123)).toBe(true)
      read.mockClear()
      kill.mockImplementation(() => { throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }) })
      expect(processAlive(123)).toBe(true)
      kill.mockImplementation(() => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }) })
      expect(processAlive(123)).toBe(false)
      expect(read).not.toHaveBeenCalled()
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      kill.mockReturnValue(true)
      expect(processAlive(123)).toBe(true)
      expect(read).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', platform)
      kill.mockRestore()
      read.mockImplementation(actual.readFileSync)
    }
  })
  it.runIf(process.platform === 'linux')('reports a real unreaped Linux child even while signal 0 still succeeds', async () => {
    // Stop the child's Node parent before ending the child, so libuv cannot reap it until the test resumes the parent.
    const parent = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      process.on('message', () => child.kill('SIGKILL'))
      child.once('spawn', () => process.send({ pid: child.pid }))
      child.once('exit', () => { process.send({ reaped: true }); process.disconnect() })
    `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const exited = once(parent, 'exit')
    const state = (pid: number) => {
      try { return /^State:\s+(\S+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] } catch { return undefined }
    }
    let childPid: number | undefined
    try {
      const [message] = await once(parent, 'message', { signal: AbortSignal.timeout(5000) }) as [{ pid: number }]
      childPid = message.pid
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true)
      process.kill(parent.pid!, 'SIGSTOP')
      await expect.poll(() => state(parent.pid!)).toBe('T')
      process.kill(childPid, 'SIGKILL')
      await expect.poll(() => state(childPid!)).toBe('Z')
      expect(process.kill(childPid, 0)).toBe(true)
      expect(processAlive(childPid)).toBe(false)
      const gone: number[] = []
      const watchdog = new RendererWatchdog({ isDestroyed: () => false, isCrashed: () => false, getOSProcessId: () => childPid! }, {
        alive: processAlive, gone: pid => gone.push(pid), timers: { setInterval: () => 1, clearInterval: () => {} }
      })
      try {
        watchdog.check()
        expect(gone).toEqual([])
        watchdog.check()
        watchdog.check()
        expect(gone).toEqual([childPid])
      } finally { watchdog.stop() }
    } finally {
      if (childPid !== undefined) { try { process.kill(childPid, 'SIGKILL') } catch { /* Already reaped. */ } }
      if (parent.exitCode === null && parent.signalCode === null) {
        // Resume first so the real parent reaps its zombie; an IPC cleanup also covers failure before its PID arrived.
        try { process.kill(parent.pid!, 'SIGCONT') } catch { /* Parent already exited. */ }
        if (parent.connected) parent.send('cleanup', () => {})
        const timer = setTimeout(() => parent.kill('SIGKILL'), 5000)
        try { await exited } finally { clearTimeout(timer) }
      }
      if (childPid !== undefined) expect(state(childPid)).toBeUndefined()
    }
  }, 30000)
})
