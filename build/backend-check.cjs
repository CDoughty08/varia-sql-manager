const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

// electron-builder only warns when an extraResources folder is missing, so `npm run package` without the self-contained
// backend publish built an app that failed at launch with "Could not start the SQL backend" (spawn ENOENT). A publish
// left over for another target or .NET version, or one that needs an installed .NET, fails the same way on the user's
// machine. Refuse to build any of them. One target per run: every target publishes to the same folder.
const folder = ['artifacts', 'release-backend']

const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }

/** The backend project's .NET version (11.0), or undefined when its csproj is missing or not one plain TargetFramework. */
function backendFramework(projectDir) {
  try { return /<TargetFramework>net(\d+\.\d+)<\/TargetFramework>/.exec(readFileSync(join(projectDir, 'backend', 'Varia.Backend', 'Varia.Backend.csproj'), 'utf8'))?.[1] } catch { return undefined }
}

/** Why a package for `rid` (osx-arm64, win-x64, ...) cannot be built from `projectDir` yet, or null. */
function backendProblem(rid, projectDir) {
  const fix = `Publish it for ${rid} first (one target per package run): node scripts/package-prepare.mjs --rid ${rid}`
  const dir = join(projectDir, ...folder), where = folder.join('/')
  const executable = `Varia.Backend${rid.startsWith('win-') ? '.exe' : ''}`
  if (!existsSync(join(dir, executable))) return `The SQL backend is not published (${where}/${executable}). ${fix}`
  const target = read(join(dir, 'Varia.Backend.deps.json'))?.runtimeTarget?.name
  if (typeof target !== 'string') return `The published SQL backend in ${where} has no readable Varia.Backend.deps.json. ${fix}`
  const [framework, published = 'no runtime'] = target.split('/')
  if (published !== rid) return `The published SQL backend in ${where} is for ${published}, not ${rid}. ${fix}`
  const tfm = backendFramework(projectDir)
  if (!tfm) return `Could not read the .NET version from backend/Varia.Backend/Varia.Backend.csproj's <TargetFramework>; update build/backend-check.cjs to match it.`
  if (framework !== `.NETCoreApp,Version=v${tfm}`) return `The published SQL backend in ${where} is from a different build (${framework}, not .NET ${tfm}). ${fix}`
  if (!Array.isArray(read(join(dir, 'Varia.Backend.runtimeconfig.json'))?.runtimeOptions?.includedFrameworks))
    return `The published SQL backend in ${where} is not self-contained. ${fix}`
  return null
}

module.exports = { backendFramework, backendProblem }
