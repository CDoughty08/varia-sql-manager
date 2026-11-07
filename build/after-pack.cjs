const patchNsis = require('./patch-nsis.cjs')
const { fuseConfig } = require('./fuses.cjs')

/** electron-builder's afterPack: the NSIS template backport, then Electron's fuses on the packaged executable (before
 *  signing, which electron-builder does after this hook). */
module.exports = async function afterPack(context) {
  await patchNsis(context)
  await context.packager.addElectronFuses(context, fuseConfig(context.electronPlatformName))
}
