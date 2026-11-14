// The machine lock: parallel agent sessions (or a developer beside them) each ran npm run check, the benchmarks and the
// smoke suites in their own worktree at once, which overloaded the machine. Time-bounded tests then missed their
// deadlines, benchmarks measured the other runs, and smoke suites overwrote each other's clipboard. So every heavy run
// takes this lock first, in one of two tiers:
//
//   shared     npm run check and npm run backend:test: up to VARIA_LOCK_SHARED (default 2) at once
//   exclusive  every smoke suite and benchmark: alone, after the shared holders finish
//
// A waiting run prints who holds the lock and carries on by itself when they finish; stopping it only loses its place.
// The lock lives in the OS temp directory (VARIA_LOCK_DIR overrides it), so it spans every worktree and clone on the
// machine. A holder's file names its process and is touched every few seconds; a file whose process is gone, or that
// stopped being touched, is cleared, so a killed run never blocks the next one. CI (CI=true) and VARIA_LOCK=off skip it. A process started under a holder (VARIA_LOCK_HELD) never waits, so
// a check that spawns vitest, or a vitest file that spawns a suite, cannot wait on itself.
//
//   node scripts/machine-lock.mjs shared <executable> [args...]   runs a command under the lock (npm run backend:test)
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export const defaultDir = () => join(tmpdir(), 'varia-machine-lock')

/** Whether the lock applies: not in CI, where each job has its runner to itself, nor with VARIA_LOCK=off. */
export const lockEnabled = (env = process.env) => env.CI !== 'true' && env.VARIA_LOCK !== 'off'

/** How many shared holders may run at once. */
export const sharedSlots = (env = process.env) => Math.max(1, Math.floor(Number(env.VARIA_LOCK_SHARED)) || 2)

/**
 * The tier an entry script needs: the smoke suites and benchmarks run alone; anything else (vitest importing a fixture) takes
 * none. scripts/fixtures/smoke.mjs takes it for the suites that import it; a suite that does not calls holdForEntry itself.
 */
export const entryMode = (script = process.argv[1] ?? '') => /-(smoke|bench)\.mjs$/.test(basename(script)) ? 'exclusive' : null

/** Whether a holder's process still runs. EPERM is a live process of another user. */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

const text = file => { try { return readFileSync(file, 'utf8') } catch { return null } }
const parse = content => { try { return JSON.parse(content) } catch { return { pid: -1 } } }
const read = file => { const content = text(file); return content === null ? null : parse(content) }

/** Windows reports a file being deleted, or held by antivirus or the indexer, as busy: taken for now, so try again later. */
const busy = error => ['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(error.code)

/**
 * A holder refreshes its file's time every heartbeatMs; one older than staleMs belongs to a process that stopped, or to
 * an unrelated process that took a dead holder's pid (Windows reuses them soon).
 */
export const heartbeatMs = 10_000, staleMs = 90_000

/** The holder of `file`, or null when it is free or its holder is gone (the stale file is removed). */
function holder(file, isAlive, now = Date.now()) {
  const content = text(file)
  if (content === null) return null
  const record = parse(content)
  let fresh = false
  try { fresh = now - statSync(file).mtimeMs < staleMs } catch { return null }
  if (fresh && isAlive(record.pid)) return record
  // Only the file just judged stale: another waiter may have cleared it and a new holder taken its place meanwhile.
  if (text(file) === content) try { unlinkSync(file) } catch { /* another waiter cleared it first */ }
  return null
}

/** Creates `file` holding `record` only if it does not exist: written beside it and linked, so nobody reads it half written. */
function create(file, record) {
  const staged = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`
  writeFileSync(staged, JSON.stringify(record))
  try { linkSync(staged, file); return true } catch (error) {
    if (busy(error)) return false
    throw error
  } finally { try { unlinkSync(staged) } catch { /* a scanner holds it; the name is unique, so it harms nothing */ } }
}

const describe = record => `${record.label} (pid ${record.pid}, ${record.cwd}, since ${new Date(record.started).toLocaleTimeString()})`

/**
 * Waits for the lock in `mode` ('shared' or 'exclusive') and holds it until `release()` or the process exits. Returns
 * `{ release, others }`, where `others` is how many shared holders were running when it was taken.
 */
export async function acquire(mode, { label = basename(process.argv[1] ?? 'node'), env = process.env, dir = env.VARIA_LOCK_DIR || defaultDir(), slots = sharedSlots(env), pollMs = 1000, beatMs = heartbeatMs, log = text => process.stderr.write(text + '\n'), isAlive = alive } = {}) {
  if (!lockEnabled(env) || env.VARIA_LOCK_HELD) return { release() {}, others: 0 }
  mkdirSync(dir, { recursive: true })
  // The token tells this hold's files from any other's, including another hold in the same process (the tests).
  const record = { pid: process.pid, token: randomUUID(), mode, label, cwd: process.cwd(), started: Date.now() }
  const mine = file => read(file)?.token === record.token
  const exclusive = join(dir, 'exclusive.lock')
  const slotFiles = Array.from({ length: slots }, (_, index) => join(dir, `shared-${index}.lock`))
  // Every shared holder, including slots past this run's own VARIA_LOCK_SHARED that a run with a larger setting took.
  const allSlots = () => { try { return readdirSync(dir).filter(name => /^shared-\d+\.lock$/.test(name)).map(name => join(dir, name)) } catch { return slotFiles } }
  const owned = []
  // Files to remove that Windows held busy: retried on every look, and on release.
  const leftovers = new Set()
  const drop = file => {
    if (!mine(file)) { leftovers.delete(file); return }
    try { unlinkSync(file); leftovers.delete(file) } catch (error) { if (error.code === 'ENOENT') leftovers.delete(file); else leftovers.add(file) }
  }
  let heartbeat
  const lost = new Set()
  const release = () => {
    clearInterval(heartbeat)
    process.off('exit', release)
    for (const file of owned.splice(0)) drop(file)
    for (const file of leftovers) drop(file)
  }
  // A run killed outright (Ctrl+C with no handler, a closed terminal) skips this; its file is cleared as stale instead.
  process.once('exit', release)
  // A holder whose file was cleared as stale while it still ran (the machine slept past staleMs) takes it back if it can.
  heartbeat = setInterval(() => {
    for (const file of owned) try { utimesSync(file, new Date(), new Date()) } catch {
      let back = false
      try { back = create(file, record) } catch { /* the directory is gone too */ }
      if (!back && !lost.has(file)) lost.add(file) && log(`The machine lock (${mode}) for ${label} was taken over while this run still held it.`)
    }
  }, beatMs)
  heartbeat.unref()

  const waitedSince = Date.now()
  let reported = '', lastNote = waitedSince
  const report = blockers => {
    const text = blockers.map(describe).join('; ')
    if (text !== reported) {
      reported = text
      log(`Waiting for the machine lock (${mode}) for ${label}, held by ${text}. This run continues by itself when they finish; do not stop it (scripts/machine-lock.mjs).`)
    } else if (Date.now() - lastNote >= 60_000) {
      lastNote = Date.now()
      log(`Still waiting for the machine lock after ${Math.round((Date.now() - waitedSince) / 1000)} s.`)
    }
  }
  const sharedHolders = () => allSlots().map(file => holder(file, isAlive)).filter(Boolean)

  for (;;) {
    for (const file of leftovers) drop(file)
    if (mode === 'exclusive') {
      if (!owned.includes(exclusive) && create(exclusive, record)) owned.push(exclusive)
      if (owned.includes(exclusive)) {
        const running = sharedHolders()
        if (!running.length) break
        report(running)
      } else {
        const other = holder(exclusive, isAlive)
        if (other) report([other])
      }
    } else {
      const writer = holder(exclusive, isAlive)
      if (writer) report([writer])
      else {
        const free = slotFiles.find(file => !holder(file, isAlive) && create(file, record))
        if (free) {
          // An exclusive run that arrived meanwhile goes first: give the slot back rather than both waiting on each other.
          if (!holder(exclusive, isAlive)) { owned.push(free); break }
          drop(free)
        } else report(sharedHolders())
      }
    }
    await delay(pollMs)
  }
  if (reported) log(`Took the machine lock (${mode}) after ${Math.round((Date.now() - waitedSince) / 1000)} s.`)
  env.VARIA_LOCK_HELD = mode
  const others = mode === 'shared' ? allSlots().filter(file => !owned.includes(file) && holder(file, isAlive)).length : 0
  return { release, others }
}

/** Takes the lock an entry script needs (see entryMode): the smoke and benchmark fixtures call this as they load. */
export const holdForEntry = (script = process.argv[1]) => {
  const mode = entryMode(script)
  return mode ? acquire(mode) : Promise.resolve({ release() {}, others: 0 })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [mode, ...command] = process.argv.slice(2)
  if (!['shared', 'exclusive'].includes(mode) || !command.length) {
    console.error('usage: node scripts/machine-lock.mjs shared|exclusive <executable> [args...]')
    process.exit(2)
  }
  await acquire(mode, { label: command.join(' ') })
  // No shell, so arguments pass through as given; the command is an executable (dotnet), not a .cmd shim.
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
}
