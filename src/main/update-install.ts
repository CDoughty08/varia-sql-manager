import { spawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { InstallKind } from '../shared/updates'

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
}

/**
 * The installed (NSIS) build has electron-builder's uninstaller beside it, named after the executable (both come from
 * electron-builder.yml's productName, which the packaged package.json lacks, so app.getName() is the npm name); the portable build's launcher names itself in
 * PORTABLE_EXECUTABLE_FILE; an AppImage's runtime sets APPIMAGE; a packaged macOS app runs from its bundle. Anything else
 * (an unpacked folder, a development run) cannot update itself.
 */
export function installTargetFor(facts: LaunchFacts): InstallTarget {
  const updates = join(facts.userData, 'updates')
  const unsupported: InstallTarget = { kind: 'unsupported', downloadDir: updates, privateDir: true }
  if (!facts.packaged) return unsupported
  if (facts.platform === 'win32') {
    const portable = facts.env.PORTABLE_EXECUTABLE_FILE
    if (portable && /\.exe$/i.test(portable)) return { kind: 'portable', downloadDir: dirname(portable), privateDir: false }
    if (existsSync(join(dirname(facts.execPath), `Uninstall ${basename(facts.execPath)}`))) return { kind: 'nsis', downloadDir: updates, privateDir: true }
    return unsupported
  }
  if (facts.platform === 'linux') {
    const image = facts.env.APPIMAGE
    return image && /\.AppImage$/.test(image) ? { kind: 'appimage', downloadDir: dirname(image), privateDir: false } : unsupported
  }
  if (facts.platform === 'darwin' && /\.app\/Contents\/MacOS\/[^/]+$/.test(facts.execPath)) return { kind: 'dmg', downloadDir: updates, privateDir: true }
  return unsupported
}

/** Smoke runs (a loopback test feed): any kind but unsupported, downloading to the profile; nothing installs. */
export function testUpdateTarget(kind: string | undefined, userData: string): InstallTarget {
  const kinds: readonly InstallKind[] = ['nsis', 'portable', 'appimage', 'dmg', 'unsupported']
  return { kind: kinds.find(candidate => candidate === kind) ?? 'nsis', downloadDir: join(userData, 'updates'), privateDir: true }
}

export interface ApplyHost {
  readonly env: NodeJS.ProcessEnv
  readonly currentVersion: string
  /** Opens the disk image in Finder (shell.openPath); resolves to an error message, empty on success. */
  readonly openPath: (path: string) => Promise<string>
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ReturnType<typeof spawn>
}

/** Starts a program that outlives this one, resolving once it has started (or rejecting when it cannot). */
function launch(host: ApplyHost, command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = (host.spawn ?? spawn)(command, args, { detached: true, stdio: 'ignore', env })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

/** The environment a relaunched copy starts with: none of this one's launcher's variables, which name the old file. */
export function relaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env }
  for (const key of ['PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_APP_FILENAME', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'ELECTRON_RUN_AS_NODE']) delete copy[key]
  return copy
}

/**
 * Installs a verified update once the app has closed (its windows are gone and the backend has stopped):
 * - the installer runs silently (`--updated /S`) into the same folder and mode as before, elevating itself when that is
 *   per-machine, then starts Varia (`--force-run`);
 * - the portable executable is swapped: Windows lets a running file be renamed, so the old one becomes `.old` (removed
 *   at the next start) and the new one takes its name, then starts;
 * - the AppImage is replaced (renamed to the new version when its name carried the old one), then starts;
 * - the disk image opens in Finder for the app to be dragged to Applications, as an unsigned app cannot replace itself.
 */
export async function applyUpdate(kind: InstallKind, file: string, version: string, host: ApplyHost): Promise<void> {
  if (kind === 'nsis') return launch(host, file, ['--updated', '/S', '--force-run'], relaunchEnv(host.env))
  if (kind === 'dmg') {
    const error = await host.openPath(file)
    if (error) throw new Error(error)
    return
  }
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
    await rename(file, target)
    if (target !== current) await rm(current, { force: true }).catch(() => {})
    return launch(host, target, [], relaunchEnv(host.env))
  }
  throw new Error('This copy of Varia cannot update itself.')
}

/** The portable executable an earlier update replaced; its launcher may still hold it for a moment, so failures wait. */
export async function removeReplacedPortable(env: NodeJS.ProcessEnv): Promise<void> {
  const target = env.PORTABLE_EXECUTABLE_FILE
  if (target) await rm(`${target}.old`, { force: true }).catch(() => {})
}
