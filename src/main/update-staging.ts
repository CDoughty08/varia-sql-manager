import { spawn, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { StagingBusy, type UpdateStaging } from './updater'

/** Where the installed Windows build stages a release, and the helper that unpacks and swaps it. */
export interface StagingPaths {
  /** The installation's folder (the executable's). */
  readonly installDir: string
  /** The executable's file name. */
  readonly exe: string
  /** A folder beside the installation, on its volume, so the swap is two renames. */
  readonly root: string
  /** `Varia.Updater.exe` in the installation's resources (backend/Varia.Updater). */
  readonly helper: string
}

export const stagingLimits = {
  /** Unpacking a release; the helper is stopped after this long. */
  stageTimeoutMs: 10 * 60_000,
  /** The helper's short answers: whether a release is staged, and forgetting a recovery. */
  askTimeoutMs: 30_000,
  markerBytes: 4096
} as const

/** The helper's exit codes that main tells apart (backend/Varia.Updater/Program.cs). */
const helperExit = { done: 0, busy: 4 } as const

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ReturnType<typeof spawn>
export interface StagingHost {
  readonly env: NodeJS.ProcessEnv
  /** Main's own record of the release that could not be staged or swapped in: a file in the profile, which only this user writes. */
  readonly record: string
  readonly spawn?: Spawn
}

/** A small JSON file, or undefined when it is missing, too large or not an object. */
async function readMarker(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    if ((await stat(path)).size > stagingLimits.markerBytes) return undefined
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

const failedVersion = (value: Record<string, unknown> | undefined) => value && typeof value.version === 'string' && value.version.length <= 64 && versionPattern.test(value.version) ? value.version : undefined

/** Runs the installation's helper to its end; resolves to its exit code (null when it was stopped). */
function run(paths: StagingPaths, host: StagingHost, args: readonly string[], options: { readonly timeout: number; readonly signal?: AbortSignal }): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = (host.spawn ?? spawn)(paths.helper, args, { stdio: 'ignore', windowsHide: true, timeout: options.timeout, ...(options.signal ? { signal: options.signal } : {}) })
    child.once('error', reject)
    child.once('exit', code => resolve(code))
  })
}

const where = (paths: StagingPaths) => ['--root', paths.root, '--install', paths.installDir] as const

async function writeFailure(host: StagingHost, version: string, reported: boolean): Promise<void> {
  await mkdir(dirname(host.record), { recursive: true })
  await writeFile(`${host.record}.tmp`, JSON.stringify({ version, reported }))
  await rename(`${host.record}.tmp`, host.record)
}

/**
 * Staging through the helper: `stage` runs it from the installation to check the archive again and unpack it into
 * `<root>/app` (with the installer's uninstaller, which the archive lacks), leaving `staged.json`; the helper's `swap`
 * (`applyStaged`) leaves `failed.json` when it had to put the old version back.
 *
 * The staging folder's name can be guessed, and beside a custom installation other people may be able to make folders.
 * So the helper makes it for this user alone and refuses one that somebody else made, and main believes nothing in it
 * by itself: whether a release is staged is the helper's answer (`check`), which looks at whose folder it is first.
 * Main's own record that a release cannot be staged (it could not be unpacked, or the swap was started and did not
 * finish) is in the profile, and outlives `clear`, so that release keeps installing with the installer in later runs.
 * Nothing here asks for elevation: an installation this user cannot write to (per-machine, in Program Files) is not
 * staged and keeps the installer.
 */
export function helperStaging(paths: StagingPaths, host: StagingHost): UpdateStaging {
  let available: Promise<boolean> | undefined
  return {
    available: () => available ??= (async () => {
      // The swap renames the installation's folder and a sibling: this user must be able to write in the installation
      // and beside it. Windows reports only the read-only attribute through access(), so a file and a folder are
      // created and removed instead; the staging folder itself is not made until a release is staged.
      const suffix = randomUUID()
      const file = join(paths.installDir, `.varia-update-probe-${suffix}`), folder = join(dirname(paths.root), `.varia-update-probe-${suffix}`)
      try {
        await (await open(file, 'wx')).close()
        await mkdir(folder)
        return true
      } catch { return false } finally {
        await rm(file, { force: true }).catch(() => {})
        await rmdir(folder).catch(() => {})
      }
    })(),
    staged: (version, sha512) => run(paths, host, ['check', ...where(paths), '--exe', paths.exe, '--version', version, '--sha512', sha512], { timeout: stagingLimits.askTimeoutMs }).then(code => code === helperExit.done, () => false),
    async stage(archive, version, sha512, signal) {
      const code = await run(paths, host, ['stage', '--archive', archive, '--sha512', sha512, ...where(paths), '--exe', paths.exe, '--version', version], { timeout: stagingLimits.stageTimeoutMs, signal })
      if (code === helperExit.busy) throw new StagingBusy()
      if (code !== helperExit.done) throw new Error('The update could not be unpacked.')
    },
    // Not the failure's record, the log that says why, nor the journal of a swap the next sign-in is to finish.
    async clear() {
      for (const name of ['staged.json', 'app', 'app.tmp', 'old', 'Varia.Updater.exe']) await rm(join(paths.root, name), { recursive: true, force: true, maxRetries: 2 }).catch(() => {})
    },
    async remove() {
      // A recovery still registered for the next sign-in would name a helper that is about to be deleted.
      await run(paths, host, ['forget', ...where(paths)], { timeout: stagingLimits.askTimeoutMs }).catch(() => {})
      await rm(host.record, { force: true }).catch(() => {})
      // The marker first, as everywhere: a folder that could only partly be removed is then not a staged release.
      await rm(join(paths.root, 'staged.json'), { force: true }).catch(() => {})
      await rm(paths.root, { recursive: true, force: true, maxRetries: 2 })
    },
    // The helper's record of a swap it had to undo carries only the version: nobody has been told yet. A record in a
    // folder somebody else made can at worst send this release to the installer.
    async failure() {
      const own = await readMarker(host.record), ownVersion = failedVersion(own)
      const helper = failedVersion(await readMarker(join(paths.root, 'failed.json')))
      if (helper && helper !== ownVersion) return { version: helper, reported: false }
      return ownVersion ? { version: ownVersion, reported: own?.reported === true } : undefined
    },
    async markFailed(version, reported) {
      await writeFailure(host, version, reported)
      await rm(join(paths.root, 'failed.json'), { force: true }).catch(() => {})
    }
  }
}

/**
 * Restart to Update for a staged release, once the app has closed: a copy of the helper outside the installation (which
 * it renames, so it starts in the staging folder too) waits for this process to end, moves the installation aside and
 * the staged folder into its place, starts Varia, and removes the old version. When a file is still in use it puts everything back, starts the old version and
 * leaves `failed.json`, which the next start reports (`UpdateStaging.failure`).
 *
 * The attempt is recorded as failed before the helper is started, and nothing afterwards takes that back: the new
 * version ignores a record that is not newer than itself. So a helper that cannot be copied or started (this rejects,
 * and the caller starts Varia again as it is), and one that is ended before it can say anything (by security software,
 * or the power), both leave this release to the installer and are reported at the next start, instead of leaving it
 * "ready" for a restart that fails the same way every time.
 */
export async function applyStaged(paths: StagingPaths, update: { readonly version: string; readonly currentVersion: string; readonly pid: number }, host: StagingHost): Promise<void> {
  const helper = join(paths.root, 'Varia.Updater.exe')
  const args = ['swap', '--pid', String(update.pid), ...where(paths), '--exe', paths.exe, '--version', update.version, '--from', update.currentVersion]
  await writeFailure(host, update.version, false).catch(() => {})
  await copyFile(paths.helper, helper)
  await new Promise<void>((resolve, reject) => {
    const child = (host.spawn ?? spawn)(helper, args, { detached: true, stdio: 'ignore', windowsHide: true, env: host.env, cwd: paths.root })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
