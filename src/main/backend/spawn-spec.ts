import { isAbsolute, join } from 'node:path'
import type { SpawnSpec } from './connection'

/** The packaged self-contained backend, or the framework-dependent build under `dotnet` in development (Release for
 *  smoke tests, so they exercise the build CI checks). No credentials or ports ever go into the arguments.
 *  Unpackaged smoke tests may instead name a fake backend scenario in VARIA_TEST_BACKEND (`mode` or `mode:argument`),
 *  which runs tests/fixtures/backend.mjs under the absolute VARIA_TEST_NODE. */
export function backendSpawnSpec(o: { packaged: boolean; root: string; resourcesPath: string; platform: NodeJS.Platform; smokeTest: boolean; env?: NodeJS.ProcessEnv }): SpawnSpec {
  if (o.packaged) return { command: join(o.resourcesPath, 'backend', o.platform === 'win32' ? 'Varia.Backend.exe' : 'Varia.Backend'), args: [], cwd: o.root, env: withoutTestHooks(o.env), packaged: true }
  const fake = o.smokeTest ? o.env?.VARIA_TEST_BACKEND : undefined
  if (fake) {
    const node = o.env?.VARIA_TEST_NODE
    if (!node || !isAbsolute(node)) throw new Error('VARIA_TEST_BACKEND needs an absolute VARIA_TEST_NODE.')
    const [mode, argument] = fake.split(':', 2)
    return { command: node, args: ['--disable-warning=ExperimentalWarning', join(o.root, 'tests/fixtures/backend.mjs'), mode, ...argument === undefined ? [] : [argument]], cwd: o.root, packaged: false }
  }
  const dll = join(o.root, 'backend/Varia.Backend/bin', o.smokeTest ? 'Release' : 'Debug', 'net10.0/Varia.Backend.dll')
  return { command: 'dotnet', args: [dll], cwd: o.root, env: o.smokeTest ? o.env : withoutTestHooks(o.env), packaged: false, requires: dll }
}

/** The backend honours its test hooks (synthetic results, a budget override) only when main passes them: in smoke runs. */
function withoutTestHooks(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (!env) return undefined
  const copy = { ...env }
  delete copy.VARIA_BACKEND_TEST_HOOKS
  delete copy.VARIA_RESULT_BUDGET_BYTES
  return copy
}
