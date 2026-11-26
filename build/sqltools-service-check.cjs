const { Arch } = require('builder-util')
const { updaterProblem } = require('./updater-check.cjs')
const { backendProblem } = require('./backend-check.cjs')

// Build-time only: prepare the exact target even when packaging a different architecture from the host.
module.exports = async function beforePack(context) {
  const problem = updaterProblem(context.electronPlatformName, context.packager.projectDir)
  if (problem) throw new Error(problem)
  const { hostRid, prepareSqlToolsService } = await import('../scripts/prepare-sqltools-service.mjs')
  const rid = hostRid(context.electronPlatformName, Arch[context.arch])
  const backend = backendProblem(rid, context.packager.projectDir)
  if (backend) throw new Error(backend)
  const { prepareElectron } = await import('../scripts/prepare-electron.mjs')
  await prepareSqlToolsService({ rid, root: context.packager.projectDir })
  const electron = await prepareElectron({ projectRoot: context.packager.projectDir, platform: context.electronPlatformName, arch: Arch[context.arch] })
  context.packager.config.electronDownload = { cache: electron.cacheRoot }
}
