import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { _electron, expect as baseExpect } from '@playwright/test'
import { holdForEntry } from '../machine-lock.mjs'
import { ignoreCrashedTargetReplies } from './playwright-races.mjs'

ignoreCrashedTargetReplies()

// Every smoke suite and Electron benchmark imports this fixture, so each takes the machine lock's exclusive tier as it loads:
// it shares the clipboard, focus and CPU with nothing (scripts/machine-lock.mjs). vitest files importing it take none.
await holdForEntry()

/**
 * Windows runners can take seconds to open, flush, or replace a new file while antivirus and indexer scans hold it, and
 * many steps wait on a preferences write (a connection's history, a saved layout, a theme choice). Assertions there
 * wait 15 seconds instead of Playwright's 5; they still return as soon as they pass.
 */
export const expect = baseExpect.configure({ timeout: process.platform === 'win32' ? 15000 : 5000 })

/**
 * Settles as `promise` does or, after `ms`, with `onTimeout()`'s value (or its throw), and clears its timer either way.
 * Race app.close() or an exit only through this: a bare setTimeout or timers/promises delay in a Promise.race stays
 * pending after the app closes and keeps the suite's process alive for its full length (10 to 30 s a suite).
 */
export function within(promise, ms, onTimeout = () => undefined) {
  let timer
  const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => { try { resolve(onTimeout()) } catch (error) { reject(error) } }, ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const slowMs = 500
/** How long app.close() may take before the fixture kills the app; a healthy close takes a few seconds, even on Windows runners. */
export const closeMs = 45_000
export const frameRateSwitch = '--disable-frame-rate-limit'

/** Records main's file opens, flushes, and renames that take `slowMs` or longer, or fail other than as missing or taken. */
async function traceFileOperations(application) {
  await application.evaluate((_, threshold) => {
    if (globalThis.variaFileOperations) return
    const fs = process.getBuiltinModule('node:fs/promises'), { syncBuiltinESMExports } = process.getBuiltinModule('node:module'), { basename } = process.getBuiltinModule('node:path')
    const operations = globalThis.variaFileOperations = []
    const record = (operation, path, started, error) => {
      const ms = Math.round(performance.now() - started), code = error?.code
      if ((ms >= threshold || (error && code !== 'ENOENT' && code !== 'EEXIST')) && operations.length < 200) operations.push({ operation, file: basename(String(path)), ms, ...(error ? { error: code ?? 'error' } : {}) })
    }
    const timed = (operation, path, run) => {
      const started = performance.now()
      return run().then(value => { record(operation, path, started); return value }, error => { record(operation, path, started, error); throw error })
    }
    const { open, rename } = fs
    fs.rename = (from, to) => timed('rename', to, () => rename(from, to))
    fs.open = (path, ...rest) => timed('open', path, () => open(path, ...rest)).then(handle => {
      const sync = handle.sync
      handle.sync = () => timed('sync', path, () => sync.call(handle))
      return handle
    })
    // The bundled main imports these by name; this points its bindings at the wrappers.
    syncBuiltinESMExports()
  }, slowMs)
}

/** Prints the traced operations, if any; a main process that no longer answers is skipped after two seconds. */
async function reportFileOperations(application) {
  let timer
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, 2000, null) })
  const operations = await Promise.race([application.evaluate(() => globalThis.variaFileOperations ?? null), timeout]).catch(() => null)
  clearTimeout(timer)
  if (operations?.length) console.log(`Main's slow or refused file operations (${slowMs} ms or more): ` + operations.map(({ operation, file, ms, error }) => `${operation} ${file} ${ms} ms${error ? ` (${error})` : ''}`).join('; '))
}

// On Windows Playwright starts Electron through cmd.exe, so the launched process is that shell and kill() ended only it:
// an app that would not close kept running, orphaned beyond the reach of a later tree kill, holding the clipboard every
// following suite reads. There kill() ends the whole tree, and so does the suite's exit for any app still running.
const running = new Set()
const killTree = pid => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* Already gone. */ } }
if (process.platform === 'win32') process.on('exit', () => { for (const pid of running) killTree(pid) })

/**
 * Linux: the processes in a process group as `name pid state` (state T is stopped), at most 20. Playwright's close waits for
 * the app's pipes, which the backend and its language server inherit, so a close that hangs after main exited names its holder.
 */
export function groupMembers(group) {
  const members = []
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid) || members.length >= 20) continue
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), end = stat.lastIndexOf(')')
        const [state, , pgid] = stat.slice(end + 2).split(' ')
        if (Number(pgid) === group) members.push(`${stat.slice(stat.indexOf('(') + 1, end)} ${pid} ${state}`)
      } catch { /* It exited meanwhile. */ }
    }
  } catch { /* No /proc on this platform. */ }
  return members
}

/**
 * Closes the app within `ms`. A close that never finished (a prompt nobody answers, a wedged main) used to hang its suite to
 * the job's 25 minute timeout, hiding the error that sent the suite to its finally block. Past `ms` this kills the app,
 * fails the suite through the exit code, and returns without throwing, so that error still propagates and prints.
 */
export async function boundedClose(application, close, ms = closeMs) {
  const closing = Promise.resolve().then(close)
  let hung = false
  await within(closing, ms, () => { hung = true })
  if (!hung) return
  closing.catch(() => {})
  console.error(`The app did not close within ${ms / 1000} s: killed it, and the suite fails. Its own error, if any, follows.`)
  process.exitCode = 1
  const child = application.process()
  // Playwright detaches POSIX apps into their own group; descendants can keep its stdio open after the leader dies.
  if (process.platform !== 'win32' && child?.pid) {
    const members = groupMembers(child.pid)
    if (members.length) console.error(`Still running in the app's process group (main ${(child.exitCode ?? child.signalCode ?? null) === null ? 'has not exited' : 'exited'}): ${members.join(', ')}`)
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch { /* The group may already be gone; try its leader. */ }
  }
  try { child?.kill('SIGKILL') } catch { /* Already gone. */ }
}

/** Emulates reduced motion in every window, and has firstWindow() return a window only once it applies there. */
function reduceMotion(application) {
  const applied = new WeakMap()
  const reduce = page => {
    if (!applied.has(page)) applied.set(page, page.emulateMedia({ reducedMotion: 'reduce' }).catch(() => {}))
    return applied.get(page)
  }
  application.on('window', reduce)
  for (const page of application.windows()) reduce(page)
  const firstWindow = application.firstWindow.bind(application)
  application.firstWindow = async (...args) => { const page = await firstWindow(...args); await reduce(page); return page }
}

/**
 * With VARIA_SMOKE_PROFILE=<dir>, records a Playwright trace (actions, their call logs and source lines, no snapshots) of
 * each launched app into that directory, to find slow waits in the trace viewer. A trace holds the launch environment,
 * passwords included, so it stays on the machine that made it.
 */
let profiled = 0
async function startProfile(application) {
  const dir = process.env.VARIA_SMOKE_PROFILE
  if (!dir) return null
  const { mkdirSync } = await import('node:fs'), { join, basename } = await import('node:path')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${basename(process.argv[1] ?? 'suite', '.mjs')}-${++profiled}.zip`)
  const tracing = application.context().tracing
  await tracing.start({ screenshots: false, snapshots: false, sources: true })
  return () => tracing.stop({ path: file }).catch(error => console.log('Profile unavailable: ' + error.message))
}

/**
 * Playwright's Electron launcher, with main's file operations traced and reported when the app is closed. Its windows match
 * `prefers-reduced-motion: reduce` (emulated) unless `motion: true` is passed: checks read colors and boxes as soon as a state
 * changes, and a hover fill or a menu fading in would otherwise be caught partway (the motion tokens are 0 ms then).
 */
export const electron = {
  async launch({ motion = false, ...options } = {}) {
    // Smoke runs keep the window hidden, and Chromium draws a hidden window at one frame a second even without background
    // throttling. Playwright waits for frames before every click, hover and check, so each took one to three seconds.
    const args = options.args ?? []
    // Hot exit (Restore open queries on startup) would close without the save prompts many suites answer, and reopen their
    // queries in the next launch on the same profile; only a suite that sets VARIA_TEST_HOT_EXIT=1 gets it.
    const env = { ...(options.env ?? process.env) }
    env.VARIA_TEST_HOT_EXIT ??= '0'
    const application = await _electron.launch({ ...options, env, args: args.includes(frameRateSwitch) ? args : [...args, frameRateSwitch] })
    const child = application.process()
    if (process.platform === 'win32' && child?.pid) {
      const pid = child.pid
      running.add(pid)
      child.once('exit', () => running.delete(pid))
      child.kill = () => { killTree(pid); return true }
    }
    await traceFileOperations(application).catch(error => console.log('File operation trace unavailable: ' + error.message))
    if (!motion) reduceMotion(application)
    const close = application.close.bind(application)
    const profile = await startProfile(application)
    application.close = async () => { await reportFileOperations(application); await profile?.(); await boundedClose(application, close) }
    return application
  }
}
