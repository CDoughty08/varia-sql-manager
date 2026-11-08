/**
 * Why a packaged build must refuse to start, or null. The renderer is untrusted, so Varia never runs it without the
 * Chromium sandbox: electron-builder 26.18's AppImage launcher adds --no-sandbox by itself where unprivileged user
 * namespaces are unavailable (Ubuntu 23.10+ restricts them through AppArmor), and anyone can pass the switch. Unpackaged
 * runs are left alone: smoke tests as root (cloud sessions) need it.
 */
export function sandboxRefusal(options: { packaged: boolean, platform: NodeJS.Platform, noSandbox: boolean }): string | null {
  if (!options.packaged || !options.noSandbox) return null
  const remedy = options.platform === 'linux'
    ? ' On Linux this happens when unprivileged user namespaces are restricted (Ubuntu 23.10 and later restrict them through AppArmor). Allow them for Varia with an AppArmor profile that grants userns, or install a package whose chrome-sandbox helper is setuid root.'
    : ''
  return `Varia SQL Manager was started with the Chromium sandbox turned off (--no-sandbox) and will not run without it.${remedy}`
}
