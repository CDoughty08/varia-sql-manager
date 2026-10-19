import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { processAlive, RendererWatchdog, type WatchedContents } from '../src/main/renderer-watchdog'

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
})
