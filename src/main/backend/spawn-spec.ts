import { join } from 'node:path'
import type { SpawnSpec } from './connection'

/** The packaged self-contained backend, or the framework-dependent build under `dotnet` in development (Release for
 *  smoke tests, so they exercise the build CI checks). No credentials or ports ever go into the arguments. */
export function backendSpawnSpec(o: { packaged: boolean; root: string; resourcesPath: string; platform: NodeJS.Platform; smokeTest: boolean }): SpawnSpec {
  if (o.packaged) return { command: join(o.resourcesPath, 'backend', o.platform === 'win32' ? 'Varia.Backend.exe' : 'Varia.Backend'), args: [], cwd: o.root, packaged: true }
  return { command: 'dotnet', args: [join(o.root, 'backend/Varia.Backend/bin', o.smokeTest ? 'Release' : 'Debug', 'net10.0/Varia.Backend.dll')], cwd: o.root, packaged: false }
}
