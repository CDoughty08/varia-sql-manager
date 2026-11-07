const { FuseV1Options, FuseVersion } = require('@electron/fuses')
// FuseState is not exported from the package's entry: '0' off, '1' on, as bytes.
const FuseState = { DISABLE: 48, ENABLE: 49 }

/**
 * The Electron fuses every packaged build has (build/after-pack.cjs flips them; scripts/packaged-smoke.mjs reads them back).
 * - GrantFileProtocolExtraPrivileges off: file: pages lose their extra privileges. The workbench is app://varia/
 *   (src/main/app-protocol.ts), never a file: page.
 * - RunAsNode, NODE_OPTIONS and --inspect off: another process running as the user cannot turn Varia into a Node runtime
 *   or attach a debugger to main, and so cannot make it decrypt remembered passwords through its own safeStorage identity.
 * - Cookie encryption on, and the app loads only from its app.asar, whose embedded integrity is checked where Electron
 *   supports it (Windows and macOS; electron-builder writes the hashes there).
 */
const fuses = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
}

/** The configuration `flipFuses` takes for one platform. Flipping fuses invalidates an ad-hoc macOS signature, so it is
 *  redone there (arm64 refuses to start an unsigned binary); real signing comes after afterPack. */
function fuseConfig(platform) {
  return { version: FuseVersion.V1, resetAdHocDarwinSignature: platform === 'darwin', ...fuses }
}

module.exports = { fuses, fuseConfig }

/** The fuses a packaged executable's wire (from `getCurrentFuseWire`) does not set as `fuses` says, by name. */
function fuseMismatches(wire) {
  return Object.entries(fuses).filter(([index, on]) => wire[index] !== (on ? FuseState.ENABLE : FuseState.DISABLE)).map(([index]) => FuseV1Options[index])
}

/** The path `getCurrentFuseWire` reads for a packaged executable: on macOS the app bundle, whose framework holds the wire. */
function fuseTarget(executable) {
  const bundle = /^(.*?\.app)(?:[\/]|$)/.exec(executable)
  return bundle ? bundle[1] : executable
}

module.exports.fuseMismatches = fuseMismatches
module.exports.fuseTarget = fuseTarget
