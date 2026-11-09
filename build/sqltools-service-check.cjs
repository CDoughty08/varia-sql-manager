const { Arch } = require('builder-util')

// Build-time only: prepare the exact target even when packaging a different architecture from the host.
module.exports = async function beforePack(context) {
  const { hostRid, prepareSqlToolsService } = await import('../scripts/prepare-sqltools-service.mjs')
  await prepareSqlToolsService({ rid: hostRid(context.electronPlatformName, Arch[context.arch]), root: context.packager.projectDir })
}
