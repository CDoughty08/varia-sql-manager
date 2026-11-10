import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyUpdate, installTargetFor, relaunchEnv, removeReplacedPortable, testUpdateTarget, type ApplyHost, type LaunchFacts } from '../src/main/update-install'
import { applyStaged, helperStaging, stagingLimits, type StagingPaths } from '../src/main/update-staging'
import { StagingBusy } from '../src/main/updater'

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
  // Main's own record, in the profile.
  const record = () => join(dir, 'profile', 'update-failed.json')
  const host = (spawn?: ApplyHost['spawn']) => ({ env: {}, record: record(), ...(spawn ? { spawn } : {}) })
  const where = (paths: StagingPaths) => ['--root', paths.root, '--install', paths.installDir]

  it('stages only where it can write the installation\'s folder and a folder beside it, leaving no probe behind', async () => {
    const paths = await installation()
    expect(await helperStaging(paths, host()).available()).toBe(true)
    // Neither a probe nor the staging folder: an installation that never updates gets nothing beside it.
    expect(await readdir(paths.installDir)).toEqual(['resources'])
    expect(await readdir(dir)).toEqual(['Varia SQL Manager'])
    expect(await helperStaging({ ...paths, installDir: join(dir, 'missing') }, host()).available()).toBe(false)
    // A file where the staging folder's parent would be: nothing can be made beside the installation.
    await writeFile(join(dir, 'blocked'), '')
    expect(await helperStaging({ ...paths, root: join(dir, 'blocked', 'update') }, host()).available()).toBe(false)
  })
  it('runs the installation\'s helper to check and unpack the archive, and rejects when it fails', async () => {
    const paths = await installation()
    const ok = fakeSpawn(undefined, 0), stop = new AbortController()
    await helperStaging(paths, host(ok.spawn)).stage(join(dir, 'release.zip'), '1.1.0', sha, stop.signal)
    expect(ok.calls).toEqual([{ command: paths.helper, args: ['stage', '--archive', join(dir, 'release.zip'), '--sha512', sha, ...where(paths), '--exe', 'Varia SQL Manager.exe', '--version', '1.1.0'], env: undefined, detached: undefined }])
    // Hidden, stopped when Varia closes, and never left unpacking for ever.
    expect(ok.spawned).toEqual([{ signal: stop.signal, timeout: stagingLimits.stageTimeoutMs, windowsHide: true, stdio: 'ignore' }])
    const stage = (spawn: ApplyHost['spawn']) => helperStaging(paths, host(spawn)).stage(join(dir, 'release.zip'), '1.1.0', sha, stop.signal)
    await expect(stage(fakeSpawn(undefined, 1).spawn)).rejects.toThrow('could not be unpacked')
    // The staging folder is not this user's alone (somebody else made it first).
    await expect(stage(fakeSpawn(undefined, 3).spawn)).rejects.toThrow('could not be unpacked')
    // Ended by a signal (the timeout, or Varia closing): no exit code, and not a success.
    await expect(stage(fakeSpawn(undefined, null).spawn)).rejects.toThrow('could not be unpacked')
    await expect(stage(fakeSpawn(new Error('spawn ENOENT')).spawn)).rejects.toThrow('ENOENT')
    // Another stage is still unpacking there: not this release's failure.
    await expect(stage(fakeSpawn(undefined, 4).spawn)).rejects.toBeInstanceOf(StagingBusy)
  })
  // The folder's name can be guessed, and somebody else may have made it and put a marker there: whether a release is
  // staged is the helper's answer, which looks at whose folder it is. Main reads no marker itself.
  it('asks the helper whether a release is staged, and believes no marker by itself', async () => {
    const paths = await installation()
    await mkdir(join(paths.root, 'app'), { recursive: true })
    await writeFile(join(paths.root, 'staged.json'), JSON.stringify({ version: '1.1.0', sha512: sha }))
    await writeFile(join(paths.root, 'app', 'Varia SQL Manager.exe'), 'planted')
    const yes = fakeSpawn(undefined, 0)
    expect(await helperStaging(paths, host(yes.spawn)).staged('1.1.0', sha)).toBe(true)
    expect(yes.calls).toEqual([{ command: paths.helper, args: ['check', ...where(paths), '--exe', 'Varia SQL Manager.exe', '--version', '1.1.0', '--sha512', sha], env: undefined, detached: undefined }])
    expect(yes.spawned).toEqual([{ signal: undefined, timeout: stagingLimits.askTimeoutMs, windowsHide: true, stdio: 'ignore' }])
    for (const answer of [fakeSpawn(undefined, 3), fakeSpawn(undefined, 1), fakeSpawn(undefined, null), fakeSpawn(new Error('spawn EACCES'))]) expect(await helperStaging(paths, host(answer.spawn)).staged('1.1.0', sha)).toBe(false)
  })
  // The record is what keeps a release on the installer in later runs, and the log says why it failed.
  it('clears the staged release but keeps the failure\'s records, the log and a swap\'s journal, until all of it is removed', async () => {
    const paths = await installation(), forgot = fakeSpawn(undefined, 0), staging = helperStaging(paths, host(forgot.spawn))
    await mkdir(join(paths.root, 'app', 'resources'), { recursive: true })
    await mkdir(join(paths.root, 'app.tmp'))
    await mkdir(join(paths.root, 'old'))
    for (const name of ['staged.json', 'failed.json', 'swap.json', 'update.log', 'Varia.Updater.exe', join('app', 'resources', 'app.asar')]) await writeFile(join(paths.root, name), '{}')
    await staging.markFailed('1.1.0', true)
    await writeFile(join(paths.root, 'failed.json'), '{}')
    await staging.clear()
    expect((await readdir(paths.root)).sort()).toEqual(['failed.json', 'swap.json', 'update.log'])
    expect(await readdir(join(dir, 'profile'))).toEqual(['update-failed.json'])
    expect(forgot.calls).toEqual([])
    // Everything, once the running version is the latest; the helper first ends a recovery registered for the next
    // sign-in, which would otherwise name a helper that is no longer there.
    await staging.remove()
    expect(forgot.calls).toEqual([{ command: paths.helper, args: ['forget', ...where(paths)], env: undefined, detached: undefined }])
    expect((await readdir(dir)).sort()).toEqual(['Varia SQL Manager', 'profile'].sort())
    expect(await readdir(join(dir, 'profile'))).toEqual([])
    await staging.clear()
    // A helper that cannot run does not stop the removal.
    await helperStaging(paths, host(fakeSpawn(new Error('spawn ENOENT')).spawn)).remove()
  })
  it('keeps a failed release\'s record in the profile, with whether it has been said, and reads only a version from one', async () => {
    const paths = await installation(), staging = helperStaging(paths, host())
    expect(await staging.failure()).toBeUndefined()
    // The helper's own record of a swap it had to undo carries only the version: nobody has been told yet.
    await mkdir(paths.root, { recursive: true })
    await writeFile(join(paths.root, 'failed.json'), JSON.stringify({ version: '1.1.0' }))
    expect(await staging.failure()).toEqual({ version: '1.1.0', reported: false })
    expect(await staging.failure()).toEqual({ version: '1.1.0', reported: false })
    // Said: main keeps it in the profile, and the helper's is gone.
    await staging.markFailed('1.1.0', true)
    expect(await staging.failure()).toEqual({ version: '1.1.0', reported: true })
    expect(await readdir(paths.root)).toEqual([])
    expect(JSON.parse(await readFile(record(), 'utf8'))).toEqual({ version: '1.1.0', reported: true })
    // A later swap the helper had to undo, of another release, is news again.
    await writeFile(join(paths.root, 'failed.json'), JSON.stringify({ version: '1.2.0' }))
    expect(await staging.failure()).toEqual({ version: '1.2.0', reported: false })
    // The same release again is not.
    await writeFile(join(paths.root, 'failed.json'), JSON.stringify({ version: '1.1.0' }))
    expect(await staging.failure()).toEqual({ version: '1.1.0', reported: true })
    for (const bad of [JSON.stringify({ version: '..\\x' }), JSON.stringify({ version: `1.1.0-${'x'.repeat(70)}` }), '[1]', '{ not json', ' '.repeat(stagingLimits.markerBytes + 1)]) {
      await writeFile(join(paths.root, 'failed.json'), bad)
      await writeFile(record(), bad)
      expect(await staging.failure(), bad.slice(0, 20)).toBeUndefined()
    }
    // Recorded before anything was ever staged (the archive could not be unpacked): nothing is made beside the installation.
    await staging.remove()
    await staging.markFailed('1.2.0', true)
    expect(await staging.failure()).toEqual({ version: '1.2.0', reported: true })
    expect((await readdir(dir)).sort()).toEqual(['Varia SQL Manager', 'profile'].sort())
  })
  it('swaps with a copy of the helper outside the installation, started in the staging folder and left running', async () => {
    const paths = await installation()
    await mkdir(paths.root, { recursive: true })
    const { calls, spawn } = fakeSpawn()
    await applyStaged(paths, { version: '1.1.0', currentVersion: '1.0.0', pid: 4242 }, { env: { PATH: 'p' }, record: record(), spawn })
    const copy = join(paths.root, 'Varia.Updater.exe')
    expect(await readFile(copy, 'utf8')).toBe('helper')
    expect(calls).toEqual([{ command: copy, args: ['swap', '--pid', '4242', ...where(paths), '--exe', 'Varia SQL Manager.exe', '--version', '1.1.0', '--from', '1.0.0'], env: { PATH: 'p' }, detached: true, cwd: paths.root }])
  })
  // The helper may be ended before it can say anything (by security software, or the power), and main has exited by
  // then. Without a record made beforehand the release would stay "ready", and every restart would fail the same way.
  it('records the swap as failed before it starts the helper, and nothing takes that back', async () => {
    const paths = await installation(), staging = helperStaging(paths, host())
    await mkdir(paths.root, { recursive: true })
    let recorded: unknown
    const { spawn } = fakeSpawn()
    const watching = ((...args: Parameters<NonNullable<ApplyHost['spawn']>>) => { recorded = JSON.parse(readFileSync(record(), 'utf8')); return spawn(...args) }) as NonNullable<ApplyHost['spawn']>
    await applyStaged(paths, { version: '1.1.0', currentVersion: '1.0.0', pid: 1 }, host(watching))
    expect(recorded).toEqual({ version: '1.1.0', reported: false })
    expect(await staging.failure()).toEqual({ version: '1.1.0', reported: false })
    await staging.remove()
    // The helper cannot be started, or even copied (it is gone from the installation): the same record, and a rejection.
    await mkdir(paths.root, { recursive: true })
    await expect(applyStaged(paths, { version: '1.1.0', currentVersion: '1.0.0', pid: 1 }, host(fakeSpawn(new Error('spawn EACCES')).spawn))).rejects.toThrow('EACCES')
    expect(await staging.failure()).toEqual({ version: '1.1.0', reported: false })
    await staging.remove()
    await rm(paths.helper)
    const none = fakeSpawn()
    await expect(applyStaged(paths, { version: '1.2.0', currentVersion: '1.0.0', pid: 1 }, host(none.spawn))).rejects.toThrow()
    expect(none.calls).toEqual([])
    expect(await staging.failure()).toEqual({ version: '1.2.0', reported: false })
  })
})
