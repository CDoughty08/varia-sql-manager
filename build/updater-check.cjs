const { existsSync } = require('node:fs')
const { join } = require('node:path')

// electron-builder only warns when an extraResources folder is missing, so a Windows package built before the update
// helper was published would ship without it and every copy installed from it would quietly update with the installer
// instead of staging (docs/updates.md). Refuse to build one.
const helper = ['artifacts', 'updater', 'Varia.Updater.exe']

/** Why a package for `platform` cannot be built from `projectDir` yet, or null. */
function updaterProblem(platform, projectDir) {
  if (platform !== 'win32' || existsSync(join(projectDir, ...helper))) return null
  return `The update helper is not built (${helper.join('/')}). Publish it first: dotnet publish backend/Varia.Updater/Varia.Updater.csproj -c Release -r win-x64 -o artifacts/updater`
}

module.exports = { updaterProblem }
