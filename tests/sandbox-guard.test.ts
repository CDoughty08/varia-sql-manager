import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { join, resolve, sep } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { RecentFilesStore } from '../src/main/recent-files-store'
import { RecoveryStore } from '../src/main/recovery-store'
import { SessionStore } from '../src/main/session-store'
import { SqlFileStore } from '../src/main/sql-files'
import { launchFilesRefused, packagedSmokeVariable, profilePathsRefused, remoteDebuggingSwitches, sandboxRefusal, smokeDebuggingProfile, stripRemoteDebugging } from '../src/main/sandbox-guard'
import { LaunchQueue } from '../src/main/launch-files'
import { lockedCipher } from '../src/main/secret-cipher'

const require = createRequire(import.meta.url)

describe('Chromium sandbox guard', () => {
  it('refuses a packaged build started with --no-sandbox on every platform, with the Linux remedy on Linux', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(sandboxRefusal({ packaged: true, platform, noSandbox: false })).toBeNull()
      expect(sandboxRefusal({ packaged: true, platform, noSandbox: true })).toMatch(/will not run without it/)
      // Unpackaged runs keep --no-sandbox for smoke tests as root.
      expect(sandboxRefusal({ packaged: false, platform, noSandbox: true })).toBeNull()
    }
    expect(sandboxRefusal({ packaged: true, platform: 'linux', noSandbox: true })).toMatch(/AppArmor/)
    expect(sandboxRefusal({ packaged: true, platform: 'win32', noSandbox: true })).not.toMatch(/AppArmor/)
  })

  it('strips and refuses remote debugging in packaged builds only', () => {
    const commandLine = (switches: string[]) => {
      const present = new Set(switches)
      return { present, hasSwitch: (name: string) => present.has(name), removeSwitch: (name: string) => { present.delete(name) } }
    }
    for (const name of remoteDebuggingSwitches) {
      const packaged = commandLine([name, 'lang'])
      expect(stripRemoteDebugging(packaged, true)).toBe(true)
      expect([...packaged.present]).toEqual(['lang'])
      const unpackaged = commandLine([name])
      expect(stripRemoteDebugging(unpackaged, false)).toBe(false)
      expect([...unpackaged.present]).toEqual([name])
    }
    expect(stripRemoteDebugging(commandLine(['lang']), true)).toBe(false)
    expect(remoteDebuggingSwitches).toEqual(['remote-debugging-port', 'remote-debugging-pipe'])
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(sandboxRefusal({ packaged: true, platform, noSandbox: false, remoteDebugging: true })).toMatch(/remote debugging/)
      expect(sandboxRefusal({ packaged: false, platform, noSandbox: false, remoteDebugging: true })).toBeNull()
    }
  })

  it('strips remote debugging as main loads, before Chromium starts the DevTools handler', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    const strip = main.indexOf('const remoteDebugging = stripRemoteDebugging(app.commandLine, app.isPackaged, smokeProfile)')
    const lastImport = main.lastIndexOf('\nimport ')
    expect(strip).toBeGreaterThan(lastImport)
    // Nothing runs between the imports and the strip but the smoke allowance it reads.
    expect(main.slice(main.indexOf('\n', lastImport + 1), strip).split('\n').filter(line => line.trim() && !line.trim().startsWith('//')))
      .toEqual(["const smokeProfile = smokeDebuggingProfile({ packaged: app.isPackaged, env: process.env, commandLine: app.commandLine, defaultProfile: join(app.getPath('appData'), app.getName()), platform: process.platform })"])
  })

  // #284 refused every packaged debugging port, which also stopped scripts/packaged-smoke.mjs and portable-smoke.mjs.
  it('keeps the debugging port only for a packaged smoke run on a profile other than the user\'s', () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\me\\AppData\\Roaming' : '/home/me/.config'
    const defaultProfile = join(home, 'Varia SQL Manager')
    const throwaway = join(home, '..', 'smoke-profile')
    const commandLine = (switches: Record<string, string>) => ({ hasSwitch: (name: string) => name in switches, getSwitchValue: (name: string) => switches[name] ?? '' })
    const smoke = { [packagedSmokeVariable]: '1' }
    const allowed = (options: { packaged?: boolean, env?: NodeJS.ProcessEnv, switches: Record<string, string> }) =>
      smokeDebuggingProfile({ packaged: options.packaged ?? true, env: options.env ?? smoke, commandLine: commandLine(options.switches), defaultProfile, platform: process.platform })
    const port = { 'remote-debugging-port': '9222', 'user-data-dir': throwaway }
    expect(allowed({ switches: port })).toBe(throwaway)
    expect(packagedSmokeVariable).toBe('VARIA_PACKAGED_SMOKE')
    // Not packaged (nothing is stripped there anyway), no variable, or any other value of it.
    expect(allowed({ packaged: false, switches: port })).toBeNull()
    expect(allowed({ env: {}, switches: port })).toBeNull()
    for (const value of ['true', 'yes', '0', ' 1', '']) expect(allowed({ env: { [packagedSmokeVariable]: value }, switches: port }), value).toBeNull()
    // Only the port, listening on loopback: no pipe, no other address.
    expect(allowed({ switches: { ...port, 'remote-debugging-pipe': '' } })).toBeNull()
    expect(allowed({ switches: { ...port, 'remote-debugging-address': '0.0.0.0' } })).toBeNull()
    expect(allowed({ switches: { 'remote-debugging-pipe': '', 'user-data-dir': throwaway } })).toBeNull()
    // An explicit, absolute profile that is not the user's own, however it is spelled.
    expect(allowed({ switches: { 'remote-debugging-port': '9222' } })).toBeNull()
    expect(allowed({ switches: { ...port, 'user-data-dir': '' } })).toBeNull()
    expect(allowed({ switches: { ...port, 'user-data-dir': 'relative/profile' } })).toBeNull()
    expect(allowed({ switches: { ...port, 'user-data-dir': defaultProfile } })).toBeNull()
    expect(allowed({ switches: { ...port, 'user-data-dir': `${defaultProfile}${process.platform === 'win32' ? '\\' : '/'}` } })).toBeNull()
    expect(allowed({ switches: { ...port, 'user-data-dir': join(defaultProfile, '..', 'Varia SQL Manager') } })).toBeNull()
    if (process.platform !== 'linux') expect(allowed({ switches: { ...port, 'user-data-dir': defaultProfile.toUpperCase() } })).toBeNull()
    // Kept switches stay on the command line, and the refusal sees none.
    const present = new Set(['remote-debugging-port', 'user-data-dir'])
    const line = { hasSwitch: (name: string) => present.has(name), removeSwitch: (name: string) => { present.delete(name) } }
    expect(stripRemoteDebugging(line, true, allowed({ switches: port }))).toBe(false)
    expect([...present]).toEqual(['remote-debugging-port', 'user-data-dir'])
    expect(stripRemoteDebugging(line, true, null)).toBe(true)
    expect([...present]).toEqual(['user-data-dir'])
  })

  it('runs a packaged smoke run on its own profile with saved passwords locked', async () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    const switchProfile = main.indexOf("app.setPath('userData', smokeProfile)")
    expect(switchProfile).toBeGreaterThan(main.indexOf('const remoteDebugging = stripRemoteDebugging('))
    // Before anything reads the profile or takes the single-instance lock, which Chromium keeps in it.
    expect(switchProfile).toBeLessThan(main.indexOf("app.getPath('userData')"))
    expect(switchProfile).toBeLessThan(main.indexOf('app.requestSingleInstanceLock('))
    expect(main).toContain('const secretCipher = smokeProfile ? lockedCipher() :')
    const cipher = lockedCipher()
    expect(await cipher.state()).toEqual({ available: false, reason: 'unavailable' })
    await expect(cipher.encrypt('secret')).rejects.toThrow('The operating system could not protect the secret.')
    await expect(cipher.decrypt(Buffer.from('ciphertext'))).rejects.toThrow('The operating system could not read the protected secret.')
    // The smoke scripts that need the port ask for it, each on a profile of its own.
    for (const file of ['scripts/packaged-smoke.mjs', 'scripts/portable-smoke.mjs']) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).toContain("VARIA_PACKAGED_SMOKE: '1'")
      expect(source, file).toContain('`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`')
    }
  })

  // #322: macOS grants file access to the app, so a program without it could read a file through a smoke run's port.
  it('opens no launch file in a packaged smoke run: from the command line, a second instance, open-file or a drop', () => {
    expect(launchFilesRefused(null)).toBe(false)
    expect(launchFilesRefused(join('somewhere', 'smoke-profile'))).toBe(true)
    const file = process.platform === 'win32' ? 'C:\\Users\\me\\Documents\\secret.sql' : '/Users/me/Documents/secret.sql'
    const closed = new LaunchQueue(launchFilesRefused('smoke-profile')), open = new LaunchQueue(launchFilesRefused(null))
    closed.add([file])
    open.add([file])
    expect(closed.take()).toEqual([])
    expect(open.take()).toEqual([file])
    const main = readFileSync('src/main/index.ts', 'utf8')
    // The one queue main delivers files from is closed by the smoke profile.
    expect(main.match(/new LaunchQueue\(/g)).toHaveLength(1)
    expect(main).toContain('const launchFiles = new LaunchQueue(launchFilesRefused(smokeProfile))')
    expect(main.match(/deliverWaiting\(/g)).toHaveLength(1)
    expect(main).toContain('deliverWaiting(launchFiles, {')
    // All four sources reach the page only through that queue: nothing else calls what reads them.
    expect(main.match(/openPaths/g)).toHaveLength(2)
    expect(main).toContain('open: openPaths,')
    expect(main.match(/launchFiles\.add\(/g)).toHaveLength(4)
    const handler = (start: string) => { const from = main.indexOf(start); expect(from, start).toBeGreaterThan(-1); return main.slice(from, from + 400) }
    for (const start of ["app.on('second-instance'", "app.on('open-file'", "ipcMain.on('varia:files-dropped'"]) expect(handler(start), start).toContain('launchFiles.add(')
    // Nor does a smoke run hand its own to another instance on its profile.
    expect(main).toContain('const ownFiles = launchFilesRefused(smokeProfile) ? [] : commandLineFiles(process.argv, process.cwd())')
    expect(main).toContain('app.requestSingleInstanceLock({ files: ownFiles }')
  })

  // #322 again: the program that starts the smoke run chooses its profile, so every path stored there is that program's.
  it('reads no file a packaged smoke run\'s profile names: hot exit\'s session, AutoRecover or Recent Files', async () => {
    expect(profilePathsRefused(null)).toBe(false)
    expect(profilePathsRefused(join('somewhere', 'smoke-profile'))).toBe(true)
    await mkdir('artifacts', { recursive: true })
    const directory = await mkdtemp(join(resolve('artifacts'), 'smoke-profile-test-'))
    try {
      // The file the other program wants, and the profile it plants: each store names it as main itself would have.
      const secret = join(directory, 'Documents', 'secret.sql'), profile = join(directory, 'profile'), id = randomUUID()
      await mkdir(join(directory, 'Documents'))
      await writeFile(secret, 'SELECT secret')
      const plant = async () => {
        await mkdir(join(profile, 'Session'), { recursive: true })
        await mkdir(join(profile, 'AutoRecover'), { recursive: true })
        const savedAt = '2026-11-10T09:00:00.000Z'
        await writeFile(join(profile, 'Session', 'session.json'), JSON.stringify({ version: 1, savedAt, activeIndex: 0, documents: [
          { name: 'secret.sql', kind: 'sql', eol: 'lf', dirty: false, path: secret },
          { name: 'secret.sql', kind: 'sql', eol: 'lf', dirty: true, path: secret, text: 'x' }
        ] }))
        await writeFile(join(profile, 'AutoRecover', id + '.json'), JSON.stringify({ version: 1, id, owner: { instance: randomUUID(), generation: 0 }, name: 'secret.sql', kind: 'sql', path: secret, eol: 'lf', savedAt, text: 'x' }))
        await writeFile(join(profile, 'recent-files.json'), JSON.stringify({ version: 1, files: [{ path: secret, openedAt: savedAt }] }))
      }
      // What main does with each store's answer (index.ts's reopenDocument, varia:recovery-take, openRecent): every path it
      // is handed, and what reading those gives the page.
      const handed = async (pathsRefused: boolean) => {
        await plant()
        const session = await new SessionStore(join(profile, 'Session'), { pathsRefused }).take(true)
        const recovery = new RecoveryStore(join(profile, 'AutoRecover'), { pathsRefused })
        await recovery.list(1)
        const recovered = await recovery.take(id, 1)
        const recent = new RecentFilesStore(join(profile, 'recent-files.json'), { pathsRefused })
        await recent.load()
        const paths = [...session?.documents.map(document => document.path) ?? [], recovered.path, ...recent.list().map(file => recent.pathOf(file.id))].filter(path => path !== undefined)
        const files = new SqlFileStore()
        return { paths, read: await Promise.all(paths.map(async path => (await files.read(path)).content)), texts: [...session?.documents.map(document => document.text) ?? [], recovered.text] }
      }
      // A normal run reopens the files; the planted records are valid, so this is what a smoke run did before.
      expect(await handed(false)).toEqual({ paths: [secret, secret, secret, secret], read: Array(4).fill('SELECT secret'), texts: [undefined, 'x', 'x'] })
      // A smoke run is handed no path, so it has nothing to read: the kept text still comes back.
      expect(await handed(true)).toEqual({ paths: [], read: [], texts: [undefined, 'x', 'x'] })
    } finally {
      expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true)
      await rm(directory, { recursive: true, force: true })
    }
    const main = readFileSync('src/main/index.ts', 'utf8')
    // The three stores that keep file paths in the profile all follow the smoke profile.
    expect(main).toContain('const pathsRefused = profilePathsRefused(smokeProfile)')
    expect(main).toContain("const recent = new RecentFilesStore(join(app.getPath('userData'), 'recent-files.json'), { ...systemRecent ? { system: systemRecent } : {}, pathsRefused })")
    expect(main).toContain("const recovery = new RecoveryStore(join(app.getPath('userData'), 'AutoRecover'), { pathsRefused })")
    expect(main).toContain("const openSession = new SessionStore(join(app.getPath('userData'), 'Session'), { pathsRefused })")
    for (const store of ['RecentFilesStore', 'RecoveryStore', 'SessionStore']) expect(main.match(new RegExp(`new ${store}\\(`, 'g')), store).toHaveLength(1)
    // Every read or registration of a path in main: launch files and Recent Files (openPath), a restored session
    // (reopenDocument, twice), the Open dialog, and a recovered query. A new one needs its source checked against this rule.
    expect(main.match(/files\.(read|register)\(/g)).toHaveLength(5)
    expect(main).toContain('const file = record.path && generation === rendererGeneration ? await files.register(record.path, record.kind) : undefined')
    expect(main.match(/(?<!shell\.)\bopenPath\(/g)).toHaveLength(2)
    expect(main).toContain('open: openPath, describe: openFailure,')
    // Nothing else in main reads a document: the stores go through json-file.ts, and imports take a dialog's path.
    expect(main).not.toMatch(/\breadFile(Sync)?\(|readRegularFile\(|createReadStream\(/)
  })

  it('runs before main registers the app protocol or opens a window', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    const ready = main.indexOf('app.whenReady().then(async () => {')
    const guard = main.indexOf("sandboxRefusal({ packaged: app.isPackaged, platform: process.platform, noSandbox: app.commandLine.hasSwitch('no-sandbox'), remoteDebugging })")
    expect(ready).toBeGreaterThan(0)
    expect(guard).toBeGreaterThan(ready)
    expect(guard).toBeLessThan(main.indexOf('protocol.handle(appScheme', ready))
    expect(main.slice(guard, main.indexOf('protocol.handle(appScheme', ready))).toMatch(/app\.exit\(1\)\s+return/)
  })

  it('is needed: the AppImage launcher adds --no-sandbox by itself, so the desktop entry must not add it too', () => {
    // electron-builder 26.18's AppRun falls back to --no-sandbox when `unshare -Ur true` fails (GHSA-7g7r-gx96-252g's release).
    const { generateAppRunScript } = require('app-builder-lib/out/targets/appimage/appImageUtil.js')
    expect(generateAppRunScript({ ProductName: 'Varia SQL Manager', ExecutableName: 'varia-sql-manager', DesktopFileName: 'varia-sql-manager.desktop', ResourceName: 'varia-sql-manager' })).toMatch(/NO_SANDBOX=\(--no-sandbox\)/)
    // Its default desktop entry is `AppRun --no-sandbox %U`, which the guard would refuse on every launch.
    expect(readFileSync('electron-builder.yml', 'utf8')).toMatch(/^linux:\n(?: {2}.*\n)*? {2}executableArgs: \[\]$/m)
  })
})
