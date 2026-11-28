const { Arch } = require('builder-util')
const { updaterProblem } = require('./updater-check.cjs')
const { backendProblem } = require('./backend-check.cjs')

function hostRid(platform, arch) {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'osx' : platform
  return `${os}-${arch}`
}

// Build-time only: verify the published backend and update helper, and prepare Electron for the target architecture.
module.exports = async function beforePack(context) {
  const problem = updaterProblem(context.electronPlatformName, context.packager.projectDir)
  if (problem) throw new Error(problem)
  const rid = hostRid(context.electronPlatformName, Arch[context.arch])
  const backend = backendProblem(rid, context.packager.projectDir)
  if (backend) throw new Error(backend)
  const { prepareElectron } = await import('../scripts/prepare-electron.mjs')
  const electron = await prepareElectron({ projectRoot: context.packager.projectDir, platform: context.electronPlatformName, arch: Arch[context.arch] })
  context.packager.config.electronDownload = { cache: electron.cacheRoot }
}
