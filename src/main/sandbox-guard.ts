/** Chromium's switches that open the DevTools protocol to another program, which the fuses (RunAsNode, `--inspect`) do not cover. */
export const remoteDebuggingSwitches = ['remote-debugging-port', 'remote-debugging-pipe'] as const

/**
 * Takes the remote debugging switches off a packaged build's command line, and says whether there were any. Main runs it
 * as its module loads, before Chromium starts the DevTools handler (which reads its command line once the app is getting
 * ready), so a shortcut, file association or other program that adds one never gets a debugging port, even for the
 * moment before the refusal. Unpackaged runs are left alone.
 */
export function stripRemoteDebugging(commandLine: { hasSwitch(name: string): boolean; removeSwitch(name: string): void }, packaged: boolean): boolean {
  if (!packaged) return false
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
