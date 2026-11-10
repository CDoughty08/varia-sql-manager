import { spawn, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { UpdateStaging } from './updater'

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
  markerBytes: 4096
} as const

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ReturnType<typeof spawn>
export interface StagingHost {
  readonly env: NodeJS.ProcessEnv
  readonly spawn?: Spawn
}

/** A small JSON file the helper wrote, or undefined when it is missing, too large or not an object. */
async function readMarker(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    if ((await stat(path)).size > stagingLimits.markerBytes) return undefined
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

/**
 * Staging through the helper: `stage` runs it from the installation to check the archive again and unpack it into
 * `<root>/app` (with the installer's uninstaller, which the archive lacks), leaving `staged.json`; the helper's `swap`
 * (`applyStaged`) leaves `failed.json` when it had to put the old version back, and main writes the same file when a
 * release cannot be unpacked or the swap cannot be started. That record outlives `clear`, so the release keeps installing
 * with the installer in later runs. Nothing here asks for elevation: an installation this user cannot write to
 * (per-machine, in Program Files) is not staged and keeps the installer.
 */
export function helperStaging(paths: StagingPaths, host: StagingHost): UpdateStaging {
  let available: Promise<boolean> | undefined
  const marker = join(paths.root, 'staged.json'), failure = join(paths.root, 'failed.json')
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
    async staged(version, sha512) {
      const value = await readMarker(marker)
      if (!value || value.version !== version || value.sha512 !== sha512) return false
      return stat(join(paths.root, 'app', paths.exe)).then(info => info.isFile(), () => false)
    },
    stage: (archive, version, sha512, signal) => new Promise<void>((resolve, reject) => {
      const child = (host.spawn ?? spawn)(paths.helper, ['stage', '--archive', archive, '--sha512', sha512, '--root', paths.root, '--install', paths.installDir, '--exe', paths.exe, '--version', version], { stdio: 'ignore', windowsHide: true, signal, timeout: stagingLimits.stageTimeoutMs })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('The update could not be unpacked.')))
    }),
    // Not the failure's record, the log that says why, nor the journal of a swap the next sign-in is to finish.
    async clear() {
      for (const name of ['staged.json', 'app', 'app.tmp', 'old', 'Varia.Updater.exe']) await rm(join(paths.root, name), { recursive: true, force: true, maxRetries: 2 }).catch(() => {})
    },
    remove: () => rm(paths.root, { recursive: true, force: true, maxRetries: 2 }),
    async failure() {
      const value = await readMarker(failure)
      return value && typeof value.version === 'string' && versionPattern.test(value.version) ? { version: value.version, reported: value.reported === true } : undefined
    },
    markFailed: (version, reported) => writeFailure(paths, version, reported)
  }
}

async function writeFailure(paths: StagingPaths, version: string, reported: boolean): Promise<void> {
  await mkdir(paths.root, { recursive: true })
  const file = join(paths.root, 'failed.json')
  await writeFile(`${file}.tmp`, JSON.stringify({ version, reported }))
  await rename(`${file}.tmp`, file)
}

/**
 * Restart to Update for a staged release, once the app has closed: a copy of the helper outside the installation (which
 * it renames, so it starts in the staging folder too) waits for this process to end, moves the installation aside and the staged folder into its place, starts
 * Varia, and removes the old version. When a file is still in use it puts everything back, starts the old version and
 * leaves `failed.json`, which the next start reports (`UpdateStaging.failure`). When the helper cannot be copied or
 * started, the same record is left here and this rejects: the caller starts Varia again, as it is.
 */
export async function applyStaged(paths: StagingPaths, update: { readonly version: string; readonly currentVersion: string; readonly pid: number }, host: StagingHost): Promise<void> {
  const helper = join(paths.root, 'Varia.Updater.exe')
  const args = ['swap', '--pid', String(update.pid), '--root', paths.root, '--install', paths.installDir, '--exe', paths.exe, '--version', update.version, '--from', update.currentVersion]
  try {
    await copyFile(paths.helper, helper)
    await new Promise<void>((resolve, reject) => {
      const child = (host.spawn ?? spawn)(helper, args, { detached: true, stdio: 'ignore', windowsHide: true, env: host.env, cwd: paths.root })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    })
  } catch (error) {
    await writeFailure(paths, update.version, false).catch(() => {})
    throw error
  }
}
