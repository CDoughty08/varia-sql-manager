import { isAbsolute, resolve } from 'node:path'

/** Chromium's switches that open the DevTools protocol to another program, which the fuses (RunAsNode, `--inspect`) do not cover. */
export const remoteDebuggingSwitches = ['remote-debugging-port', 'remote-debugging-pipe'] as const

/** Set to 1 by scripts/packaged-smoke.mjs and scripts/portable-smoke.mjs, which drive a packaged build over its debugging port. */
export const packagedSmokeVariable = 'VARIA_PACKAGED_SMOKE'

interface SwitchReader { hasSwitch(name: string): boolean; getSwitchValue(name: string): string }

/**
 * The profile a packaged smoke run may keep its debugging port on, or null. With --inspect fused off, Chromium's debugging
 * port is the only way the packaged and portable smoke tests reach the page, so a packaged build keeps
 * --remote-debugging-port only when all of these hold: the environment sets VARIA_PACKAGED_SMOKE=1, the command line gives
 * no --remote-debugging-pipe or --remote-debugging-address (Chromium then listens on loopback alone), and it names an
 * absolute --user-data-dir other than the user's own profile. Main then runs on that profile and never decrypts a saved
 * password (secret-cipher.ts's lockedCipher): the Keychain key on macOS belongs to the app, not the profile, so a
 * saved-passwords.json copied into a throwaway profile would otherwise be readable through the port.
 */
export function smokeDebuggingProfile(options: { packaged: boolean, env: NodeJS.ProcessEnv, commandLine: SwitchReader, defaultProfile: string, platform: NodeJS.Platform }): string | null {
  const { commandLine } = options
  if (!options.packaged || options.env[packagedSmokeVariable] !== '1') return null
  if (!commandLine.hasSwitch('remote-debugging-port') || commandLine.hasSwitch('remote-debugging-pipe') || commandLine.hasSwitch('remote-debugging-address')) return null
  const profile = commandLine.hasSwitch('user-data-dir') ? commandLine.getSwitchValue('user-data-dir') : ''
  if (!profile || !isAbsolute(profile)) return null
  const fold = (path: string) => options.platform === 'linux' ? resolve(path) : resolve(path).toLowerCase()
  return fold(profile) === fold(options.defaultProfile) ? null : resolve(profile)
}

/**
 * Takes the remote debugging switches off a packaged build's command line, and says whether there were any. Main runs it
 * as its module loads, before Chromium starts the DevTools handler (which reads its command line once the app is getting
 * ready), so a shortcut, file association or other program that adds one never gets a debugging port, even for the
 * moment before the refusal. Unpackaged runs, and a packaged smoke run on its own profile (smokeDebuggingProfile), are left alone.
 */
export function stripRemoteDebugging(commandLine: { hasSwitch(name: string): boolean; removeSwitch(name: string): void }, packaged: boolean, smokeProfile: string | null = null): boolean {
  if (!packaged || smokeProfile) return false
  const found = remoteDebuggingSwitches.filter(name => commandLine.hasSwitch(name))
  for (const name of found) commandLine.removeSwitch(name)
  return found.length > 0
}

/**
 * Why a packaged build must refuse to start, or null. The renderer is untrusted, so Varia never runs it without the
 * Chromium sandbox: electron-builder 26.18's AppImage launcher adds --no-sandbox by itself where unprivileged user
 * namespaces are unavailable (Ubuntu 23.10+ restricts them through AppArmor), and anyone can pass the switch. Nor does it
 * run with remote debugging, which would let another program drive the page and main's IPC. Unpackaged runs are left
 * alone: smoke tests as root (cloud sessions) need --no-sandbox, and development may debug.
 */
export function sandboxRefusal(options: { packaged: boolean, platform: NodeJS.Platform, noSandbox: boolean, remoteDebugging?: boolean }): string | null {
  if (!options.packaged) return null
  if (options.noSandbox) {
    const remedy = options.platform === 'linux'
      ? ' On Linux this happens when unprivileged user namespaces are restricted (Ubuntu 23.10 and later restrict them through AppArmor). Allow them for Varia with an AppArmor profile that grants userns, or install a package whose chrome-sandbox helper is setuid root.'
      : ''
    return `Varia SQL Manager was started with the Chromium sandbox turned off (--no-sandbox) and will not run without it.${remedy}`
  }
  if (options.remoteDebugging) return 'Varia SQL Manager was started with remote debugging turned on (--remote-debugging-port or --remote-debugging-pipe), which would let another program control it, and will not run with it. Start it without those switches.'
  return null
}
