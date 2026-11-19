// Writes backend/package-licenses.json: every NuGet package the backend resolves (packages.lock.json, every target) with
// the license its .nuspec declares, read from the local NuGet cache after a restore (docs/bigquery.md, Packages).
// tests/backend-licenses.test.ts keeps the inventory in step with the lock file and every license on the allowed list.
// Usage: node scripts/package-licenses.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const lockPath = 'backend/Varia.Backend/packages.lock.json'
const inventoryPath = 'backend/package-licenses.json'

/** Every package a lock file resolves, once per id and version, in a stable order. */
export function lockedPackages(lock) {
  const packages = new Map()
  for (const target of Object.values(lock.dependencies))
    for (const [id, entry] of Object.entries(target)) if (entry.type !== 'Project') packages.set(`${id}/${entry.resolved}`, { id, version: entry.resolved })
  return [...packages.values()].sort((a, b) => a.id.localeCompare(b.id, 'en') || a.version.localeCompare(b.version, 'en'))
}

/** A package's license as its .nuspec declares it: an SPDX expression, `file:<path>` in the package, or the license URL. */
function license(cache, id, version) {
  const nuspec = join(cache, id.toLowerCase(), version.toLowerCase(), `${id.toLowerCase()}.nuspec`)
  if (!existsSync(nuspec)) throw new Error(`${id} ${version} is not in the NuGet cache; run dotnet restore first.`)
  const text = readFileSync(nuspec, 'utf8')
  const expression = /<license\s+type="expression"\s*>([^<]+)<\/license>/.exec(text)?.[1]?.trim()
  if (expression) return expression
  const file = /<license\s+type="file"\s*>([^<]+)<\/license>/.exec(text)?.[1]?.trim()
  if (file) return `file:${file}`
  const url = /<licenseUrl>([^<]+)<\/licenseUrl>/.exec(text)?.[1]?.trim()
  if (url) return url
  throw new Error(`${id} ${version} declares no license.`)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const cache = process.env.NUGET_PACKAGES || join(homedir(), '.nuget', 'packages')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const inventory = lockedPackages(lock).map(({ id, version }) => ({ id, version, license: license(cache, id, version) }))
  writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + '\n')
  console.log(`${inventory.length} packages: ${[...new Set(inventory.map(item => item.license))].join(', ')}`)
}
