import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyUpdate, installTargetFor, relaunchEnv, removeReplacedPortable, testUpdateTarget, type ApplyHost, type LaunchFacts } from '../src/main/update-install'
import { applyStaged, helperStaging, stagingLimits, type StagingPaths } from '../src/main/update-staging'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'varia-update-install-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const facts = (change: Partial<LaunchFacts>): LaunchFacts => ({ packaged: true, platform: 'win32', execPath: join(dir, 'Varia SQL Manager.exe'), env: {}, userData: join(dir, 'profile'), ...change })

/** A spawn that starts (or fails to) on the next tick, as Node's does. */
function fakeSpawn(fail?: Error, exitCode?: number | null) {
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined; detached: boolean | undefined; cwd?: string }[] = []
  const spawned: { signal?: AbortSignal; timeout?: number; windowsHide?: boolean; stdio?: unknown }[] = []
  const spawn = vi.fn((command: string, args: readonly string[], given: { env?: NodeJS.ProcessEnv; detached?: boolean; cwd?: string; signal?: AbortSignal; timeout?: number; windowsHide?: boolean; stdio?: unknown }) => {
    spawned.push({ signal: given.signal, timeout: given.timeout, windowsHide: given.windowsHide, stdio: given.stdio })
    calls.push({ command, args, env: given.env, detached: given.detached, ...(given.cwd ? { cwd: given.cwd } : {}) })
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    setImmediate(() => { if (fail) child.emit('error', fail); else { child.emit('spawn'); if (exitCode !== undefined) child.emit('exit', exitCode) } })
    return child
  })
  return { calls, spawned, spawn: spawn as unknown as NonNullable<ApplyHost['spawn']> }
}

describe('installTargetFor', () => {
  it('tells the installed, portable and AppImage builds apart, and anything else (macOS included) cannot update', async () => {
    expect(installTargetFor(facts({ packaged: false }))).toMatchObject({ kind: 'unsupported' })
    // An unpacked Windows folder has no uninstaller beside it.
    expect(installTargetFor(facts({}))).toMatchObject({ kind: 'unsupported' })
    await writeFile(join(dir, 'Uninstall Varia SQL Manager.exe'), '')
    expect(installTargetFor(facts({}))).toEqual({ kind: 'nsis', downloadDir: join(dir, 'profile', 'updates'), privateDir: true })
    // The uninstaller is matched to the executable's name, not app.getName() (the npm name in a packaged build).
    expect(installTargetFor(facts({ execPath: join(dir, 'varia-sql-manager.exe') }))).toMatchObject({ kind: 'unsupported' })
    const portable = join(dir, 'usb', 'Varia-SQL-Manager-1.0.0-Windows-x64-Portable.exe')
    expect(installTargetFor(facts({ env: { PORTABLE_EXECUTABLE_FILE: portable } }))).toEqual({ kind: 'portable', downloadDir: join(dir, 'usb'), privateDir: false })
    const image = join(dir, 'apps', 'Varia-SQL-Manager-1.0.0-linux-x86_64.AppImage')
    expect(installTargetFor(facts({ platform: 'linux', execPath: '/tmp/.mount_Varia/varia-sql-manager', env: { APPIMAGE: image } }))).toEqual({ kind: 'appimage', downloadDir: join(dir, 'apps'), privateDir: false })
    expect(installTargetFor(facts({ platform: 'linux', execPath: '/opt/varia/varia-sql-manager' }))).toMatchObject({ kind: 'unsupported' })
    // macOS builds are not code signed: they say a release exists and point to the releases page, nothing more.
    expect(installTargetFor(facts({ platform: 'darwin', execPath: '/Applications/Varia SQL Manager.app/Contents/MacOS/Varia SQL Manager' }))).toMatchObject({ kind: 'unsupported' })
  })
  it('stages beside an installation that carries the update helper, in a folder the installer never takes for the application', async () => {
    const installDir = join(dir, 'Programs', 'Varia SQL Manager')
    await mkdir(join(installDir, 'resources', 'updater'), { recursive: true })
    await writeFile(join(installDir, 'Uninstall Varia SQL Manager.exe'), '')
    const execPath = join(installDir, 'Varia SQL Manager.exe')
    expect(installTargetFor(facts({ execPath })).staging).toBeUndefined()
    await writeFile(join(installDir, 'resources', 'updater', 'Varia.Updater.exe'), '')
    const target = installTargetFor(facts({ execPath }))
    expect(target).toMatchObject({ kind: 'nsis', downloadDir: join(dir, 'profile', 'updates') })
    expect(target.staging).toEqual({ installDir, exe: 'Varia SQL Manager.exe', helper: join(installDir, 'resources', 'updater', 'Varia.Updater.exe'), root: join(dir, 'Programs', '.Varia SQL Manager.update') })
    // The installer ends every process whose path starts with the installation's folder.
    expect(target.staging!.root.startsWith(installDir)).toBe(false)
  })
  it('lets smoke runs choose a kind, always downloading to the profile', () => {
    expect(testUpdateTarget('portable', '/profile')).toEqual({ kind: 'portable', downloadDir: join('/profile', 'updates'), privateDir: true })
    expect(testUpdateTarget('anything', '/profile').kind).toBe('nsis')
  })
})

describe('applyUpdate', () => {
  it('runs the installer silently into the same installation, starting Varia afterwards', async () => {
    const { calls, spawn } = fakeSpawn()
    await applyUpdate('nsis', join(dir, 'Setup.exe'), '1.1.0', { env: { PATH: 'p', ELECTRON_RUN_AS_NODE: '1' }, currentVersion: '1.0.0', spawn })
    expect(calls).toEqual([{ command: join(dir, 'Setup.exe'), args: ['--updated', '/S', '--force-run'], env: { PATH: 'p' }, detached: true }])
  })
  it('rejects when the installer cannot start', async () => {
    const { spawn } = fakeSpawn(new Error('spawn EACCES'))
    await expect(applyUpdate('nsis', join(dir, 'Setup.exe'), '1.1.0', { env: {}, currentVersion: '1.0.0', spawn })).rejects.toThrow('EACCES')
  })
  it('swaps the portable executable in place, keeps the old one until the next start, and starts the new one', async () => {
    const target = join(dir, 'Varia-SQL-Manager-1.0.0-Windows-x64-Portable.exe'), staged = join(dir, '.Varia-SQL-Manager-1.1.0-Windows-x64-Portable.exe.update')
    await writeFile(target, 'old')
    await writeFile(staged, 'new')
    const { calls, spawn } = fakeSpawn()
    const env = { PORTABLE_EXECUTABLE_FILE: target, PORTABLE_EXECUTABLE_DIR: dir, PORTABLE_EXECUTABLE_APP_FILENAME: 'x', KEEP: '1' }
    await applyUpdate('portable', staged, '1.1.0', { env, currentVersion: '1.0.0', spawn })
    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await readFile(`${target}.old`, 'utf8')).toBe('old')
    expect(calls).toEqual([{ command: target, args: [], env: { KEEP: '1' }, detached: true }])
    await removeReplacedPortable(env)
    expect((await readdir(dir)).sort()).toEqual(['Varia-SQL-Manager-1.0.0-Windows-x64-Portable.exe'])
  })
  it('puts the portable executable back when the new one cannot take its place', async () => {
    const target = join(dir, 'Varia.exe')
    await writeFile(target, 'old')
    const { calls, spawn } = fakeSpawn()
    await expect(applyUpdate('portable', join(dir, 'missing.update'), '1.1.0', { env: { PORTABLE_EXECUTABLE_FILE: target }, currentVersion: '1.0.0', spawn })).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(calls).toEqual([])
  })
  it('replaces the AppImage, renaming it when its name carried the old version', async () => {
    await mkdir(join(dir, 'a'))
    const current = join(dir, 'a', 'Varia-SQL-Manager-1.0.0-linux-x86_64.AppImage'), staged = join(dir, 'a', '.Varia-SQL-Manager-1.1.0-linux-x86_64.AppImage.update')
    await writeFile(current, 'old')
    await writeFile(staged, 'new')
    const { calls, spawn } = fakeSpawn()
    await applyUpdate('appimage', staged, '1.1.0', { env: { APPIMAGE: current, APPDIR: '/tmp/.mount', ARGV0: 'x', OWD: dir, HOME: '/home/u' }, currentVersion: '1.0.0', spawn })
    const renamed = join(dir, 'a', 'Varia-SQL-Manager-1.1.0-linux-x86_64.AppImage')
    expect(await readdir(join(dir, 'a'))).toEqual(['Varia-SQL-Manager-1.1.0-linux-x86_64.AppImage'])
    expect(await readFile(renamed, 'utf8')).toBe('new')
    expect(calls).toEqual([{ command: renamed, args: [], env: { HOME: '/home/u' }, detached: true }])
    // A name without the version (the user renamed it) is kept.
    const plain = join(dir, 'a', 'varia.AppImage')
    await writeFile(plain, 'old')
    await writeFile(staged, 'newer')
    await applyUpdate('appimage', staged, '1.2.0', { env: { APPIMAGE: plain }, currentVersion: '1.1.0', spawn })
    expect(await readFile(plain, 'utf8')).toBe('newer')
  })
  it('installs nothing for a copy that cannot update itself', async () => {
    const { calls, spawn } = fakeSpawn()
    await expect(applyUpdate('unsupported', '/x', '1.1.0', { env: {}, currentVersion: '1.0.0', spawn })).rejects.toThrow()
    expect(calls).toEqual([])
  })
  it('starts the new copy without the old launcher\'s variables', () => {
    expect(relaunchEnv({ PATH: 'p', APPIMAGE: 'a', APPDIR: 'b', PORTABLE_EXECUTABLE_FILE: 'c', ELECTRON_RUN_AS_NODE: '1' })).toEqual({ PATH: 'p' })
  })
})

describe('staging through the update helper', () => {
  const sha = 'a'.repeat(86) + '=='
  async function installation(): Promise<StagingPaths> {
    const installDir = join(dir, 'Varia SQL Manager')
    await mkdir(join(installDir, 'resources', 'updater'), { recursive: true })
    const helper = join(installDir, 'resources', 'updater', 'Varia.Updater.exe')
    await writeFile(helper, 'helper')
    return { installDir, exe: 'Varia SQL Manager.exe', helper, root: join(dir, '.Varia SQL Manager.update') }
  }
  it('stages only where it can write the installation\'s folder and a folder beside it, leaving no probe behind', async () => {
    const paths = await installation()
    expect(await helperStaging(paths, { env: {} }).available()).toBe(true)
    // Neither a probe nor the staging folder: an installation that never updates gets nothing beside it.
    expect(await readdir(paths.installDir)).toEqual(['resources'])
    expect(await readdir(dir)).toEqual(['Varia SQL Manager'])
    expect(await helperStaging({ ...paths, installDir: join(dir, 'missing') }, { env: {} }).available()).toBe(false)
    // A file where the staging folder would go: it cannot be made.
    await writeFile(join(dir, 'blocked'), '')
    expect(await helperStaging({ ...paths, root: join(dir, 'blocked', 'update') }, { env: {} }).available()).toBe(false)
  })
  it('runs the installation\'s helper to check and unpack the archive, and rejects when it fails', async () => {
    const paths = await installation()
    const ok = fakeSpawn(undefined, 0), stop = new AbortController()
    await helperStaging(paths, { env: {}, spawn: ok.spawn }).stage(join(dir, 'release.zip'), '1.1.0', sha, stop.signal)
    // Hidden, stopped when Varia closes, and never left unpacking for ever.
    expect(ok.spawned).toEqual([{ signal: stop.signal, timeout: stagingLimits.stageTimeoutMs, windowsHide: true, stdio: 'ignore' }])
    // Ended by a signal (the timeout, or Varia closing): no exit code, and not a success.
    await expect(helperStaging(paths, { env: {}, spawn: fakeSpawn(undefined, null).spawn }).stage(join(dir, 'release.zip'), '1.1.0', sha, stop.signal)).rejects.toThrow('could not be unpacked')
    expect(ok.calls).toEqual([{ command: paths.helper, args: ['stage', '--archive', join(dir, 'release.zip'), '--sha512', sha, '--root', paths.root, '--install', paths.installDir, '--exe', 'Varia SQL Manager.exe', '--version', '1.1.0'], env: undefined, detached: undefined }])
    await expect(helperStaging(paths, { env: {}, spawn: fakeSpawn(undefined, 1).spawn }).stage(join(dir, 'release.zip'), '1.1.0', sha, new AbortController().signal)).rejects.toThrow('could not be unpacked')
    await expect(helperStaging(paths, { env: {}, spawn: fakeSpawn(new Error('spawn ENOENT')).spawn }).stage(join(dir, 'release.zip'), '1.1.0', sha, new AbortController().signal)).rejects.toThrow('ENOENT')
  })
  it('takes a release as staged only when the helper\'s marker names it and the application is there', async () => {
    const paths = await installation(), staging = helperStaging(paths, { env: {} })
    expect(await staging.staged('1.1.0', sha)).toBe(false)
    await mkdir(join(paths.root, 'app'), { recursive: true })
    await writeFile(join(paths.root, 'staged.json'), JSON.stringify({ version: '1.1.0', sha512: sha }))
    expect(await staging.staged('1.1.0', sha)).toBe(false)
    await writeFile(join(paths.root, 'app', 'Varia SQL Manager.exe'), 'new')
    expect(await staging.staged('1.1.0', sha)).toBe(true)
    expect(await staging.staged('1.2.0', sha)).toBe(false)
    expect(await staging.staged('1.1.0', 'b'.repeat(86) + '==')).toBe(false)
    await writeFile(join(paths.root, 'staged.json'), '{ not json')
    expect(await staging.staged('1.1.0', sha)).toBe(false)
  })
  // The record is what keeps a release on the installer in later runs, and the log says why it failed.
  it('clears the staged release but keeps the failure\'s record, the log and a swap\'s journal, until all of it is removed', async () => {
    const paths = await installation(), staging = helperStaging(paths, { env: {} })
    await mkdir(join(paths.root, 'app', 'resources'), { recursive: true })
    await mkdir(join(paths.root, 'app.tmp'))
    await mkdir(join(paths.root, 'old'))
    for (const name of ['staged.json', 'failed.json', 'swap.json', 'update.log', 'Varia.Updater.exe', join('app', 'resources', 'app.asar')]) await writeFile(join(paths.root, name), '{}')
    await staging.clear()
    expect((await readdir(paths.root)).sort()).toEqual(['failed.json', 'swap.json', 'update.log'])
    await staging.remove()
    expect(await readdir(dir)).toEqual(['Varia SQL Manager'])
    await staging.clear()
    await staging.remove()
  })
  it('keeps a failed release\'s record, with whether it has been said, and reads only a version from it', async () => {
    const paths = await installation(), staging = helperStaging(paths, { env: {} })
    expect(await staging.failure()).toBeUndefined()
    // The helper's own record of a failed swap carries only the version: nobody has been told yet.
    await mkdir(paths.root, { recursive: true })
    await writeFile(join(paths.root, 'failed.json'), JSON.stringify({ version: '1.1.0' }))
    expect(await staging.failure()).toEqual({ version: '1.1.0', reported: false })
    expect(await staging.failure()).toEqual({ version: '1.1.0', reported: false })
    await staging.markFailed('1.1.0', true)
    expect(await staging.failure()).toEqual({ version: '1.1.0', reported: true })
    expect(await readdir(paths.root)).toEqual(['failed.json'])
    await writeFile(join(paths.root, 'failed.json'), JSON.stringify({ version: '..\\x', reported: true }))
    expect(await staging.failure()).toBeUndefined()
    // Recorded before anything was ever staged (the archive could not be unpacked): the folder is made for it.
    await staging.remove()
    await staging.markFailed('1.2.0', true)
    expect(await staging.failure()).toEqual({ version: '1.2.0', reported: true })
  })
  it('swaps with a copy of the helper outside the installation, started in the staging folder and left running', async () => {
    const paths = await installation()
    await mkdir(paths.root, { recursive: true })
    const { calls, spawn } = fakeSpawn()
    await applyStaged(paths, { version: '1.1.0', currentVersion: '1.0.0', pid: 4242 }, { env: { PATH: 'p' }, spawn })
    const copy = join(paths.root, 'Varia.Updater.exe')
    expect(await readFile(copy, 'utf8')).toBe('helper')
    expect(calls).toEqual([{ command: copy, args: ['swap', '--pid', '4242', '--root', paths.root, '--install', paths.installDir, '--exe', 'Varia SQL Manager.exe', '--version', '1.1.0', '--from', '1.0.0'], env: { PATH: 'p' }, detached: true, cwd: paths.root }])
    expect(await helperStaging(paths, { env: {} }).failure()).toBeUndefined()
  })
  // Otherwise the release stays "ready", and every Restart to Update fails the same way.
  it('records a swap that could not be started, so that the next start says so and uses the installer', async () => {
    const paths = await installation(), staging = helperStaging(paths, { env: {} })
    await mkdir(paths.root, { recursive: true })
    await expect(applyStaged(paths, { version: '1.1.0', currentVersion: '1.0.0', pid: 1 }, { env: {}, spawn: fakeSpawn(new Error('spawn EACCES')).spawn })).rejects.toThrow('EACCES')
    expect(await staging.failure()).toEqual({ version: '1.1.0', reported: false })
    await staging.remove()
    // The helper cannot even be copied (it is gone from the installation).
    await rm(paths.helper)
    const { calls, spawn } = fakeSpawn()
    await expect(applyStaged(paths, { version: '1.1.0', currentVersion: '1.0.0', pid: 1 }, { env: {}, spawn })).rejects.toThrow()
    expect(calls).toEqual([])
    expect(await staging.failure()).toEqual({ version: '1.1.0', reported: false })
  })
})
