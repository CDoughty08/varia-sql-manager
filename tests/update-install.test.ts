import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyUpdate, installTargetFor, relaunchEnv, removeReplacedPortable, testUpdateTarget, type ApplyHost, type LaunchFacts } from '../src/main/update-install'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'varia-update-install-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const facts = (change: Partial<LaunchFacts>): LaunchFacts => ({ packaged: true, platform: 'win32', execPath: join(dir, 'Varia SQL Manager.exe'), env: {}, userData: join(dir, 'profile'), ...change })

/** A spawn that starts (or fails to) on the next tick, as Node's does. */
function fakeSpawn(fail?: Error) {
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined; detached: boolean | undefined }[] = []
  const spawn = vi.fn((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; detached?: boolean }) => {
    calls.push({ command, args, env: options.env, detached: options.detached })
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    setImmediate(() => fail ? child.emit('error', fail) : child.emit('spawn'))
    return child
  })
  return { calls, spawn: spawn as unknown as NonNullable<ApplyHost['spawn']> }
}

describe('installTargetFor', () => {
  it('tells the installed, portable, AppImage and macOS builds apart, and anything else cannot update', async () => {
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
    expect(installTargetFor(facts({ platform: 'darwin', execPath: '/Applications/Varia SQL Manager.app/Contents/MacOS/Varia SQL Manager' }))).toMatchObject({ kind: 'dmg', privateDir: true })
  })
  it('lets smoke runs choose a kind, always downloading to the profile', () => {
    expect(testUpdateTarget('portable', '/profile')).toEqual({ kind: 'portable', downloadDir: join('/profile', 'updates'), privateDir: true })
    expect(testUpdateTarget('anything', '/profile').kind).toBe('nsis')
  })
})

describe('applyUpdate', () => {
  it('runs the installer silently into the same installation, starting Varia afterwards', async () => {
    const { calls, spawn } = fakeSpawn()
    await applyUpdate('nsis', join(dir, 'Setup.exe'), '1.1.0', { env: { PATH: 'p', ELECTRON_RUN_AS_NODE: '1' }, currentVersion: '1.0.0', openPath: async () => '', spawn })
    expect(calls).toEqual([{ command: join(dir, 'Setup.exe'), args: ['--updated', '/S', '--force-run'], env: { PATH: 'p' }, detached: true }])
  })
  it('rejects when the installer cannot start', async () => {
    const { spawn } = fakeSpawn(new Error('spawn EACCES'))
    await expect(applyUpdate('nsis', join(dir, 'Setup.exe'), '1.1.0', { env: {}, currentVersion: '1.0.0', openPath: async () => '', spawn })).rejects.toThrow('EACCES')
  })
  it('swaps the portable executable in place, keeps the old one until the next start, and starts the new one', async () => {
    const target = join(dir, 'Varia-SQL-Manager-1.0.0-Windows-x64-Portable.exe'), staged = join(dir, '.Varia-SQL-Manager-1.1.0-Windows-x64-Portable.exe.update')
    await writeFile(target, 'old')
    await writeFile(staged, 'new')
    const { calls, spawn } = fakeSpawn()
    const env = { PORTABLE_EXECUTABLE_FILE: target, PORTABLE_EXECUTABLE_DIR: dir, PORTABLE_EXECUTABLE_APP_FILENAME: 'x', KEEP: '1' }
    await applyUpdate('portable', staged, '1.1.0', { env, currentVersion: '1.0.0', openPath: async () => '', spawn })
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
    await expect(applyUpdate('portable', join(dir, 'missing.update'), '1.1.0', { env: { PORTABLE_EXECUTABLE_FILE: target }, currentVersion: '1.0.0', openPath: async () => '', spawn })).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(calls).toEqual([])
  })
  it('replaces the AppImage, renaming it when its name carried the old version', async () => {
    await mkdir(join(dir, 'a'))
    const current = join(dir, 'a', 'Varia-SQL-Manager-1.0.0-linux-x86_64.AppImage'), staged = join(dir, 'a', '.Varia-SQL-Manager-1.1.0-linux-x86_64.AppImage.update')
    await writeFile(current, 'old')
    await writeFile(staged, 'new')
    const { calls, spawn } = fakeSpawn()
    await applyUpdate('appimage', staged, '1.1.0', { env: { APPIMAGE: current, APPDIR: '/tmp/.mount', ARGV0: 'x', OWD: dir, HOME: '/home/u' }, currentVersion: '1.0.0', openPath: async () => '', spawn })
    const renamed = join(dir, 'a', 'Varia-SQL-Manager-1.1.0-linux-x86_64.AppImage')
    expect(await readdir(join(dir, 'a'))).toEqual(['Varia-SQL-Manager-1.1.0-linux-x86_64.AppImage'])
    expect(await readFile(renamed, 'utf8')).toBe('new')
    expect(calls).toEqual([{ command: renamed, args: [], env: { HOME: '/home/u' }, detached: true }])
    // A name without the version (the user renamed it) is kept.
    const plain = join(dir, 'a', 'varia.AppImage')
    await writeFile(plain, 'old')
    await writeFile(staged, 'newer')
    await applyUpdate('appimage', staged, '1.2.0', { env: { APPIMAGE: plain }, currentVersion: '1.1.0', openPath: async () => '', spawn })
    expect(await readFile(plain, 'utf8')).toBe('newer')
  })
  it('opens the disk image on macOS, and reports Finder\'s refusal', async () => {
    const openPath = vi.fn(async () => '')
    await applyUpdate('dmg', '/updates/Varia.dmg', '1.1.0', { env: {}, currentVersion: '1.0.0', openPath })
    expect(openPath).toHaveBeenCalledWith('/updates/Varia.dmg')
    await expect(applyUpdate('dmg', '/updates/Varia.dmg', '1.1.0', { env: {}, currentVersion: '1.0.0', openPath: async () => 'Failed to open' })).rejects.toThrow('Failed to open')
    await expect(applyUpdate('unsupported', '/x', '1.1.0', { env: {}, currentVersion: '1.0.0', openPath })).rejects.toThrow()
  })
  it('starts the new copy without the old launcher\'s variables', () => {
    expect(relaunchEnv({ PATH: 'p', APPIMAGE: 'a', APPDIR: 'b', PORTABLE_EXECUTABLE_FILE: 'c', ELECTRON_RUN_AS_NODE: '1' })).toEqual({ PATH: 'p' })
  })
})
