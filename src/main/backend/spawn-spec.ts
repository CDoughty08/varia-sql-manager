import { isAbsolute, join } from 'node:path'
import type { SpawnSpec } from './connection'
import { sqlToolsEnvironment } from './sqltools-runtime'

/** The packaged self-contained backend, or the framework-dependent build under `dotnet` in development (Release for
 *  smoke tests, so they exercise the build CI checks). No credentials or ports ever go into the arguments.
 *  Unpackaged smoke tests may instead name a fake backend scenario in VARIA_TEST_BACKEND (`mode` or `mode:argument`),
 *  which runs tests/fixtures/backend.mjs under the absolute VARIA_TEST_NODE. `locale` (the OS's) reaches the backend as
 *  VARIA_LOCALE: scripts date their headers in it, as SSMS does, and macOS GUI launches have no LANG to read. */
export function backendSpawnSpec(options: { packaged: boolean; root: string; resourcesPath: string; platform: NodeJS.Platform; smokeTest: boolean; env?: NodeJS.ProcessEnv; locale?: string }): SpawnSpec {
  // The result memory limit is the setting's alone (resultMemoryEnvironment, at each launch), never the shell's.
  const runtimeEnv = { ...sqlToolsEnvironment(options) }
  delete runtimeEnv[resultMemoryVariable]
  const o = { ...options, env: options.locale ? { ...runtimeEnv, VARIA_LOCALE: options.locale } : runtimeEnv }
  if (o.packaged) return { command: join(o.resourcesPath, 'backend', o.platform === 'win32' ? 'Varia.Backend.exe' : 'Varia.Backend'), args: [], cwd: o.resourcesPath, env: withoutTestHooks(o.env), packaged: true }
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

const resultMemoryVariable = 'VARIA_RESULT_MEMORY_MIB'

/** What a launch adds to the backend's environment for Tools › Options' result memory limit (in GiB; 0 is automatic,
 *  and adds nothing): the backend reads it once, when it starts. */
export function resultMemoryEnvironment(limitGiB: unknown): Record<string, string> {
  return typeof limitGiB === 'number' && Number.isInteger(limitGiB) && limitGiB > 0 ? { [resultMemoryVariable]: String(Math.min(limitGiB, 1024) * 1024) } : {}
}

/** The backend honours its test hooks (synthetic results, a budget override) only when main passes them: in smoke runs. */
function withoutTestHooks(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (!env) return undefined
  const copy = { ...env }
  delete copy.VARIA_BACKEND_TEST_HOOKS
  delete copy.VARIA_RESULT_BUDGET_BYTES
  return copy
}
