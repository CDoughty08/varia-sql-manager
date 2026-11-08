const { checkNsis } = require('./nsis-check.cjs')
const { fuseConfig } = require('./fuses.cjs')

/** electron-builder's afterPack: the NSIS template check, then Electron's fuses on the packaged executable (before
 *  signing, which electron-builder does after this hook). */
module.exports = async function afterPack(context) {
  await checkNsis(context)
  await context.packager.addElectronFuses(context, fuseConfig(context.electronPlatformName))
}
