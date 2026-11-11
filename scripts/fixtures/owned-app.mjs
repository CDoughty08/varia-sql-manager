import { rmSync } from 'node:fs'
import { within } from './smoke.mjs'

// Cleanup for the smoke scripts that start the packaged app themselves (packaged-smoke.mjs, portable-smoke.mjs). It runs in
// their finally blocks, so nothing here throws: a throw there replaces the error that sent the script to its finally.

/** Whether `child` has exited, waiting up to `ms` for it: a kill returns before the process and its file handles are gone. */
export async function exited(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  let onExit
  const exit = new Promise(resolve => { onExit = () => resolve(true); child.once('exit', onExit) })
  try { return await within(exit, ms, () => false) } finally { child.off('exit', onExit) }
}

/**
 * Removes a run's temporary profile, best effort. A process that outlived the kill, or a scanner reading the new files, can
 * hold one past every retry; the removal then warns and returns false, and the run's own result stands.
 */
export function removeProfile(directory, remove = rmSync) {
  try {
    remove(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    return true
  } catch (error) {
    console.warn(`Warning: could not remove the temporary profile ${directory}: ${error instanceof Error ? error.message : error}`)
    return false
  }
}
