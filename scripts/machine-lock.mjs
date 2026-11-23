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

/** Windows reports a file being deleted, or held by antivirus or the indexer, as busy: taken for now, so try again later. */
const busy = error => ['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(error.code)
const defaultFs = { linkSync, readFileSync, statSync, unlinkSync, writeFileSync }

function readText(file, ops = defaultFs) {
  try { return { ok: true, content: ops.readFileSync(file, 'utf8') } }
  catch (error) {
    if (error.code === 'ENOENT') return { ok: false, missing: true }
    if (busy(error)) return { ok: false, error }
    throw error
  }
}
function statFile(file, ops = defaultFs) {
  try { return { ok: true, stat: ops.statSync(file, { bigint: true }) } }
  catch (error) {
    if (error.code === 'ENOENT') return { ok: false, missing: true }
    if (busy(error)) return { ok: false, error }
    throw error
  }
}
const sameFile = (a, b) => !!a && !!b && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.birthtimeNs === b.birthtimeNs && a.size === b.size
function parse(content) {
  try {
    const value = JSON.parse(content)
    return value && typeof value === 'object' && Number.isInteger(value.pid) ? value : null
  } catch { return null }
}

/**
 * A holder refreshes its file's time every heartbeatMs; one older than staleMs belongs to a process that stopped, or to
 * an unrelated process that took a dead holder's pid (Windows reuses them soon). birthGraceMs protects a newly created
 * `wx` fallback lock file during the brief window before its JSON lands on disk.
 */
export const heartbeatMs = 10_000, staleMs = 90_000, birthGraceMs = 5_000

const startingHolder = now => ({ pid: 0, label: 'starting run', cwd: '', started: now, starting: true })

/**
 * Inspects `file`: returns `{ record, error }`, where `record` is the live/starting holder (or null when free/cleared)
 * and `error` reports a stat, read or unlink failure so persistent permission errors fail fast instead of blocking forever.
 */
function holder(file, isAlive, now = Date.now(), graceMs = birthGraceMs, ops = defaultFs) {
  const before = statFile(file, ops)
  if (!before.ok) return before.missing ? { record: null } : { record: null, error: before.error }
  const age = now - Number(before.stat.mtimeNs / 1_000_000n)
  const result = readText(file, ops)
  if (!result.ok) {
    if (result.missing) return { record: null }
    if (age < staleMs) return { record: startingHolder(now), error: result.error }
    const after = statFile(file, ops)
    if (after.ok && sameFile(before.stat, after.stat)) {
      try { ops.unlinkSync(file); return { record: null } }
      catch (error) { if (error.code === 'ENOENT') return { record: null }; return { record: null, error } }
    }
    return { record: null, error: result.error }
  }
  const { content } = result
  const record = parse(content)
  if (!record) {
    if (age < graceMs) return { record: startingHolder(now) }
  } else if (age < staleMs && isAlive(record.pid)) {
    return { record }
  }
  // Confirm both content and file identity (inode/timestamps/size) before unlinking so two empty files never collide.
  const latest = readText(file, ops)
  const after = statFile(file, ops)
  if (latest.ok && latest.content === content && after.ok && sameFile(before.stat, after.stat)) {
    try { ops.unlinkSync(file) } catch (error) {
      if (error.code !== 'ENOENT') return { record: record ?? startingHolder(now), error }
    }
  }
  return { record: null }
}

/**
 * Creates `file` holding `record` only if it does not exist.
 * Primary path writes a uniquely named staged file and hard-links it into place so other runs (including older worktrees)
 * never see an empty file. When hard links are denied (Windows sandboxes deny CreateHardLinkW with EPERM), falls back to
 * atomic exclusive creation (`wx` = CREATE_NEW / O_CREAT|O_EXCL) and verifies our token landed on disk before claiming ownership.
 */
function create(file, record, ops = defaultFs) {
  const payload = JSON.stringify(record)
  const staged = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`
  try {
    ops.writeFileSync(staged, payload)
    try {
      ops.linkSync(staged, file)
      return { ok: true }
    } catch (error) {
      if (error.code === 'EEXIST') return { ok: false, busy: true }
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error.code)) {
        if (busy(error)) return { ok: false, error }
        throw error
      }
    } finally {
      try { ops.unlinkSync(staged) } catch { /* a scanner holds it; the name is unique, so it harms nothing */ }
    }
  } catch (error) {
    if (busy(error)) return { ok: false, error }
    throw error
  }
  try {
    ops.writeFileSync(file, payload, { flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') return { ok: false, busy: true }
    if (busy(error)) return { ok: false, error }
    throw error
  }
  // Verify the file on disk still belongs to us in case a waiter unlinked it during a stalled birth or from an older worktree.
  // Distinguish a read error from a token mismatch so a transient EBUSY never abandons our own live lock file on disk.
  try {
    const check = readText(file, ops)
    if (check.ok) return parse(check.content)?.token === record.token ? { ok: true } : { ok: false, busy: true }
    if (check.missing) return { ok: false, busy: true }
    return { ok: false, error: check.error, cleanup: file }
  } catch (error) {
    return { ok: false, error, cleanup: file, fatal: true }
  }
}

const describe = record => record.starting
  ? 'a starting run'
  : `${record.label} (pid ${record.pid}, ${record.cwd}, since ${new Date(record.started).toLocaleTimeString()})`

const maxIoErrors = 5

/**
 * Waits for the lock in `mode` ('shared' or 'exclusive') and holds it until `release()` or the process exits. Returns
 * `{ release, others }`, where `others` is how many shared holders were running when it was taken.
 */
export async function acquire(mode, { label = basename(process.argv[1] ?? 'node'), env = process.env, dir = env.VARIA_LOCK_DIR || defaultDir(), slots = sharedSlots(env), pollMs = 1000, beatMs = heartbeatMs, graceMs = birthGraceMs, fsOps, log = text => process.stderr.write(text + '\n'), isAlive = alive, signal } = {}) {
  signal?.throwIfAborted()
  if (!lockEnabled(env) || env.VARIA_LOCK_HELD) return { release() {}, others: 0 }
  const ops = fsOps ? { ...defaultFs, ...fsOps } : defaultFs
  mkdirSync(dir, { recursive: true })
  // The token tells this hold's files from any other's, including another hold in the same process (the tests).
  const record = { pid: process.pid, token: randomUUID(), mode, label, cwd: process.cwd(), started: Date.now() }
  const exclusive = join(dir, 'exclusive.lock')
  const slotFiles = Array.from({ length: slots }, (_, index) => join(dir, `shared-${index}.lock`))
  // Every shared holder, including slots past this run's own VARIA_LOCK_SHARED that a run with a larger setting took.
  const allSlots = () => { try { return readdirSync(dir).filter(name => /^shared-\d+\.lock$/.test(name)).map(name => join(dir, name)) } catch { return slotFiles } }
  const owned = []
  // Files to remove that Windows held busy: retried on every look, and on release.
  const leftovers = new Set()
  const drop = file => {
    let content
    try { content = ops.readFileSync(file, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') { leftovers.delete(file); return null }
      leftovers.add(file)
      return error
    }
    if (parse(content)?.token !== record.token) { leftovers.delete(file); return null }
    try { ops.unlinkSync(file); leftovers.delete(file); return null } catch (error) {
      if (error.code === 'ENOENT') { leftovers.delete(file); return null }
      leftovers.add(file)
      return error
    }
  }
  let heartbeat
  const lost = new Set()
  const release = () => {
    clearInterval(heartbeat)
    process.off('exit', release)
    for (const file of owned.splice(0)) drop(file)
    for (const file of [...leftovers]) drop(file)
  }
  // A run killed outright (Ctrl+C with no handler, a closed terminal) skips this; its file is cleared as stale instead.
  process.once('exit', release)
  // A holder whose file was cleared as stale while it still ran (the machine slept past staleMs) takes it back if it can.
  heartbeat = setInterval(() => {
    for (const file of [...leftovers]) if (!owned.includes(file)) drop(file)
    for (const file of owned) try { utimesSync(file, new Date(), new Date()) } catch {
      let back = false
      try {
        const attempt = create(file, record, ops)
        // `file` is already owned, so a `wx` write that hit a read-back error (`cleanup`) still re-created our own file:
        // keep it on disk instead of dropping it or putting an owned file into `leftovers`.
        back = attempt.ok || attempt.cleanup === file
      } catch { /* the directory is gone too */ }
      if (!back && !lost.has(file)) lost.add(file) && log(`The machine lock (${mode}) for ${label} was taken over while this run still held it.`)
    }
  }, beatMs)
  heartbeat.unref()

  const waitedSince = Date.now()
  let reported = '', lastNote = waitedSince, ioErrors = 0
  const report = blockers => {
    if (!blockers.length) return
    const text = blockers.map(describe).join('; ')
    if (text !== reported) {
      reported = text
      log(`Waiting for the machine lock (${mode}) for ${label}, held by ${text}. This run continues by itself when they finish; do not stop it (scripts/machine-lock.mjs).`)
    } else if (Date.now() - lastNote >= 60_000) {
      lastNote = Date.now()
      log(`Still waiting for the machine lock after ${Math.round((Date.now() - waitedSince) / 1000)} s.`)
    }
  }
  const sharedHolders = () => {
    const records = []
    let firstError = null
    for (const file of allSlots()) {
      const state = holder(file, isAlive, Date.now(), graceMs, ops)
      if (state.record) records.push(state.record)
      if (state.error && !firstError) firstError = { error: state.error, file }
    }
    return { records, error: firstError }
  }
  const failAccess = ({ error, file }) => {
    throw new Error(`Could not access machine lock file ${file} (${error.code}): ${error.message}. Run outside a restricted sandbox or set VARIA_LOCK=off.`)
  }

  try {
    for (;;) {
      signal?.throwIfAborted()
      const leftoverErrors = new Map()
      for (const file of [...leftovers]) {
        if (owned.includes(file)) { leftovers.delete(file); continue }
        const error = drop(file)
        if (error) leftoverErrors.set(file, error)
      }
      if (mode === 'exclusive') {
        let pollError = leftoverErrors.has(exclusive) ? { error: leftoverErrors.get(exclusive), file: exclusive } : null
        if (!owned.includes(exclusive) && !leftovers.has(exclusive)) {
          const attempt = create(exclusive, record, ops)
          if (attempt.ok) owned.push(exclusive)
          else {
            if (attempt.cleanup) drop(attempt.cleanup)
            if (attempt.fatal) throw attempt.error
            if (attempt.error) pollError = { error: attempt.error, file: exclusive }
          }
        }
        if (owned.includes(exclusive)) {
          const { records, error } = sharedHolders()
          if (!records.length && !error) break
          if (error) { if (++ioErrors >= maxIoErrors) failAccess(error) }
          else ioErrors = 0
          report(records)
        } else if (leftovers.has(exclusive)) {
          // Our own wx-created file is still stuck busy on disk; retry cleanup on the next poll instead of waiting on ourselves.
          if (pollError && ++ioErrors >= maxIoErrors) failAccess(pollError)
        } else {
          const state = holder(exclusive, isAlive, Date.now(), graceMs, ops)
          const accessError = state.error ? { error: state.error, file: exclusive } : pollError
          if (state.record) report([state.record])
          if (accessError) { if (++ioErrors >= maxIoErrors) failAccess(accessError) }
          else ioErrors = 0
        }
      } else {
        const writer = holder(exclusive, isAlive, Date.now(), graceMs, ops)
        if (writer.error) {
          if (writer.record) report([writer.record])
          if (++ioErrors >= maxIoErrors) failAccess({ error: writer.error, file: exclusive })
        } else if (writer.record) {
          ioErrors = 0
          report([writer.record])
        } else if (leftovers.size > 0) {
          // Clean up any stuck leftover slot of ours before claiming another slot so we never hold two slots at once.
          const [file, error] = leftoverErrors.entries().next().value ?? []
          if (error && ++ioErrors >= maxIoErrors) failAccess({ error, file })
        } else {
          let claimed = null, slotError = null
          for (const file of slotFiles) {
            const state = holder(file, isAlive, Date.now(), graceMs, ops)
            if (state.error) { slotError ??= { error: state.error, file }; continue }
            if (state.record) continue
            const attempt = create(file, record, ops)
            if (attempt.ok) { claimed = file; break }
            if (attempt.cleanup) drop(attempt.cleanup)
            if (attempt.fatal) throw attempt.error
            if (attempt.error) slotError ??= { error: attempt.error, file }
            if (leftovers.size > 0) break
          }
          if (claimed) {
            ioErrors = 0
            // An exclusive run that arrived meanwhile goes first: give the slot back rather than both waiting on each other.
            if (!holder(exclusive, isAlive, Date.now(), graceMs, ops).record) { owned.push(claimed); break }
            drop(claimed)
          } else {
            if (slotError) { if (++ioErrors >= maxIoErrors) failAccess(slotError) }
            else ioErrors = 0
            if (leftovers.size === 0) {
              const { records } = sharedHolders()
              report(records)
            }
          }
        }
      }
      await delay(pollMs, undefined, { signal })
    }
    signal?.throwIfAborted()
    if (reported) log(`Took the machine lock (${mode}) after ${Math.round((Date.now() - waitedSince) / 1000)} s.`)
    env.VARIA_LOCK_HELD = mode
    const others = mode === 'shared' ? allSlots().filter(file => !owned.includes(file) && holder(file, isAlive, Date.now(), graceMs, ops).record).length : 0
    return { release, others }
  } catch (error) { release(); throw error }
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
