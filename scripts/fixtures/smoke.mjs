import { execFileSync } from 'node:child_process'
import { _electron, expect as baseExpect } from '@playwright/test'

/**
 * Windows runners can take seconds to open, flush, or replace a new file while antivirus and indexer scans hold it, and
 * many steps wait on a preferences write (a connection's history, a saved layout, a theme choice). Assertions there
 * wait 15 seconds instead of Playwright's 5; they still return as soon as they pass.
 */
export const expect = baseExpect.configure({ timeout: process.platform === 'win32' ? 15000 : 5000 })

const slowMs = 500

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

/** Playwright's Electron launcher, with main's file operations traced and reported when the app is closed. */
export const electron = {
  async launch(options) {
    const application = await _electron.launch(options)
    const child = application.process()
    if (process.platform === 'win32' && child?.pid) {
      const pid = child.pid
      running.add(pid)
      child.once('exit', () => running.delete(pid))
      child.kill = () => { killTree(pid); return true }
    }
    await traceFileOperations(application).catch(error => console.log('File operation trace unavailable: ' + error.message))
    const close = application.close.bind(application)
    application.close = async () => { await reportFileOperations(application); return close() }
    return application
  }
}
