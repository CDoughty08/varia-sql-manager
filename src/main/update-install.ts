import { spawn, type SpawnOptions } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { link, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { InstallKind } from '../shared/updates'
import type { StagingPaths } from './update-staging'

/** How this copy was started, as far as updates care. */
export interface LaunchFacts {
  readonly packaged: boolean
  readonly platform: NodeJS.Platform
  readonly execPath: string
  readonly env: NodeJS.ProcessEnv
  readonly userData: string
}

export interface InstallTarget {
  readonly kind: InstallKind
  /** Where the update downloads to: the portable app and the AppImage are swapped in place, so theirs is their own folder. */
  readonly downloadDir: string
  readonly privateDir: boolean
  /** The installed Windows build that carries the update helper: a release can be unpacked beside it while it runs. */
  readonly staging?: StagingPaths
}

/**
 * The installed (NSIS) build has electron-builder's uninstaller beside it, named after the executable (both come from
 * electron-builder.yml's productName, which the packaged package.json lacks, so app.getName() is the npm name); the portable build's launcher names itself in
 * PORTABLE_EXECUTABLE_FILE; an AppImage's runtime sets APPIMAGE. Anything else (an unpacked folder, a development run)
 * cannot update itself, and neither can a macOS build: it is not code signed, so it only points to the releases page.
 */
export function installTargetFor(facts: LaunchFacts): InstallTarget {
  const updates = join(facts.userData, 'updates')
  const unsupported: InstallTarget = { kind: 'unsupported', downloadDir: updates, privateDir: true }
  if (!facts.packaged) return unsupported
  if (facts.platform === 'win32') {
    const portable = facts.env.PORTABLE_EXECUTABLE_FILE
    if (portable && /\.exe$/i.test(portable)) return { kind: 'portable', downloadDir: dirname(portable), privateDir: false }
    const installDir = dirname(facts.execPath), exe = basename(facts.execPath)
    if (!existsSync(join(installDir, `Uninstall ${exe}`))) return unsupported
    const helper = join(installDir, 'resources', 'updater', 'Varia.Updater.exe')
    // The staging folder's name starts with a dot, so the installer's "is Varia running from the installation's folder"
    // check (a prefix match on that folder) never takes the helper running there for the application.
    // An installation at a drive's root has no folder beside it.
    const staging = existsSync(helper) && basename(installDir) ? { staging: { installDir, exe, helper, root: join(dirname(installDir), `.${basename(installDir)}.update`) } } : {}
    return { kind: 'nsis', downloadDir: updates, privateDir: true, ...staging }
  }
  if (facts.platform === 'linux') {
    const image = facts.env.APPIMAGE
    return image && /\.AppImage$/.test(image) ? { kind: 'appimage', downloadDir: dirname(image), privateDir: false } : unsupported
  }
  return unsupported
}

/** Smoke runs (a loopback test feed): any kind but unsupported, downloading to the profile; nothing installs. */
export function testUpdateTarget(kind: string | undefined, userData: string): InstallTarget {
  const kinds: readonly InstallKind[] = ['nsis', 'portable', 'appimage', 'unsupported']
  return { kind: kinds.find(candidate => candidate === kind) ?? 'nsis', downloadDir: join(userData, 'updates'), privateDir: true }
}

export interface ApplyHost {
  readonly env: NodeJS.ProcessEnv
  readonly currentVersion: string
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ReturnType<typeof spawn>
  /** How long a replaced AppImage waits for the new one to say it started (tests shorten it). */
  readonly confirmMs?: number
}

/** The new AppImage normally confirms within a few seconds; after this the previous one stays until the next start removes it. */
export const appImageConfirmMs = 30_000

/** Where the AppImage an update replaces waits, named after the image that replaced it so that one can find and remove it. */
export function replacedAppImage(image: string): string {
  return join(dirname(image), `.${basename(image)}.old`)
}

/** Starts a program that outlives this one, resolving once it has started (or rejecting when it cannot). */
function launch(host: ApplyHost, command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = (host.spawn ?? spawn)(command, args, { detached: true, stdio: 'ignore', env })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

/**
 * Starts the new AppImage and waits for it to confirm it started by removing the previous image (`removeReplaced` at its
 * start), or until the wait ends. It fails when it cannot start or exits before confirming, so the previous one can be put back.
 */
function launchConfirmed(host: ApplyHost, command: string, env: NodeJS.ProcessEnv, previous: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let watcher: FSWatcher | undefined, timer: NodeJS.Timeout | undefined, settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      if (error) reject(error instanceof Error ? error : new Error(String(error)))
      else resolve()
    }
    const confirmed = () => { if (!existsSync(previous)) finish() }
    const child = (host.spawn ?? spawn)(command, [], { detached: true, stdio: 'ignore', env })
    child.once('error', finish)
    child.once('exit', () => { if (existsSync(previous)) finish(new Error('The updated AppImage stopped before it started.')); else finish() })
    child.once('spawn', () => {
      if (settled) return
      child.unref()
      // Without a watch (an unusual filesystem) only an early exit or the end of the wait settles it.
      try { watcher = watch(dirname(previous), confirmed).on('error', () => {}) } catch { /* no watch */ }
      timer = setTimeout(finish, host.confirmMs ?? appImageConfirmMs)
      confirmed()
    })
  })
}

/** The environment a relaunched copy starts with: none of this one's launcher's variables, which name the old file. */
export function relaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env }
  for (const key of ['PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_APP_FILENAME', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'ELECTRON_RUN_AS_NODE']) delete copy[key]
  return copy
}

/**
 * Installs a verified update once the app has closed (its windows are gone and the backend has stopped). A staged release
 * is swapped in instead (`applyStaged` in update-staging.ts); otherwise:
 * - the installer runs silently (`--updated /S`) into the same folder and mode as before, elevating itself when that is
 *   per-machine, then starts Varia (`--force-run`);
 * - the portable executable is swapped: Windows lets a running file be renamed, so the old one becomes `.old` (removed
 *   at the next start) and the new one takes its name, then starts;
 * - the AppImage is replaced (renamed to the new version when its name carried the old one), then starts; the previous
 *   one stays beside it, hidden, until the new one has started, and is put back when the new one cannot start or exits first.
 */
export async function applyUpdate(kind: InstallKind, file: string, version: string, host: ApplyHost): Promise<void> {
  if (kind === 'nsis') return launch(host, file, ['--updated', '/S', '--force-run'], relaunchEnv(host.env))
  if (kind === 'portable') {
    const target = host.env.PORTABLE_EXECUTABLE_FILE
    if (!target) throw new Error('The portable executable is unknown.')
    const old = `${target}.old`
    await rm(old, { force: true })
    await rename(target, old)
    try { await rename(file, target) } catch (error) { await rename(old, target).catch(() => {}); throw error }
    return launch(host, target, [], relaunchEnv(host.env))
  }
  if (kind === 'appimage') {
    const current = host.env.APPIMAGE
    if (!current) throw new Error('The AppImage is unknown.')
    const name = basename(current)
    const target = name.includes(host.currentVersion) ? join(dirname(current), name.replace(host.currentVersion, version)) : current
    const previous = replacedAppImage(target)
    await rm(previous, { force: true })
    // A hard link keeps the previous image without the AppImage ever missing from its place; a filesystem without links
    // moves it aside instead. Moved or deleted while Varia ran, there is nothing to keep, so it installs as it is.
    const kept = await link(current, previous).then(() => 'linked' as const, async (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 'gone' as const
      await rename(current, previous)
      return 'moved' as const
    })
    if (kept === 'gone') {
      await rename(file, target)
      return launch(host, target, [], relaunchEnv(host.env))
    }
    try { await rename(file, target) } catch (error) {
      await (kept === 'moved' ? rename(previous, current) : rm(previous, { force: true })).catch(() => {})
      throw error
    }
    if (kept === 'linked' && target !== current) await rm(current, { force: true }).catch(() => {})
    try { await launchConfirmed(host, target, relaunchEnv(host.env), previous) } catch (error) {
      try {
        await rename(previous, current)
        if (target !== current) await rm(target, { force: true })
      } catch { /* the error below still says the update failed */ }
      throw error
    }
    return
  }
  throw new Error('This copy of Varia cannot update itself.')
}

/**
 * At start, the copy an earlier update replaced: the portable executable's launcher may still hold it for a moment, so
 * failures wait for a later start. Removing the previous AppImage is also how the new one confirms it started.
 */
export async function removeReplaced(kind: InstallKind, env: NodeJS.ProcessEnv): Promise<void> {
  const previous = kind === 'portable' && env.PORTABLE_EXECUTABLE_FILE ? `${env.PORTABLE_EXECUTABLE_FILE}.old`
    : kind === 'appimage' && env.APPIMAGE ? replacedAppImage(env.APPIMAGE) : undefined
  if (previous) await rm(previous, { force: true }).catch(() => {})
}
