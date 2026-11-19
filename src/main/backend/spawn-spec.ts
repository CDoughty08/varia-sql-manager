import { isAbsolute, join } from 'node:path'
import type { SpawnSpec } from './connection'
import { sqlToolsEnvironment } from './sqltools-runtime'

/** The packaged self-contained backend, or the framework-dependent build under `dotnet` in development (Release for
 *  smoke tests, so they exercise the build CI checks). No credentials or ports ever go into the arguments.
 *  Unpackaged smoke tests may instead name a fake backend scenario in VARIA_TEST_BACKEND (`mode` or `mode:argument`),
 *  which runs tests/fixtures/backend.mjs under the absolute VARIA_TEST_NODE. `locale` (the OS's) reaches the backend as
 *  VARIA_LOCALE: scripts date their headers in it, as SSMS does, and macOS GUI launches have no LANG to read. */
export function backendSpawnSpec(options: { packaged: boolean; root: string; resourcesPath: string; platform: NodeJS.Platform; smokeTest: boolean; env?: NodeJS.ProcessEnv; locale?: string; userData?: string }): SpawnSpec {
  // The result memory limit is the setting's alone (resultMemoryEnvironment, at each launch), never the shell's.
  // Whatever its case: Windows, and .NET on it, read environment names without regard to it.
  const runtimeEnv = { ...sqlToolsEnvironment(options) }
  for (const name of Object.keys(runtimeEnv)) if (name.toUpperCase() === resultMemoryVariable) delete runtimeEnv[name]
  // VARIA_USER_DATA: BigQuery never reads a federation subject token from Varia's own files (SubjectTokens).
  for (const name of Object.keys(runtimeEnv)) if (name.toUpperCase() === 'VARIA_USER_DATA') delete runtimeEnv[name]
  const o = { ...options, env: { ...runtimeEnv, ...options.locale ? { VARIA_LOCALE: options.locale } : {}, ...options.userData ? { VARIA_USER_DATA: options.userData } : {} } as NodeJS.ProcessEnv }
  if (o.packaged) return { command: join(o.resourcesPath, 'backend', o.platform === 'win32' ? 'Varia.Backend.exe' : 'Varia.Backend'), args: [], cwd: o.resourcesPath, env: withBigQueryEndpoint(withoutTestHooks(o.env), o), packaged: true }
  const fake = o.smokeTest ? o.env?.VARIA_TEST_BACKEND : undefined
  if (fake) {
    const node = o.env?.VARIA_TEST_NODE
    if (!node || !isAbsolute(node)) throw new Error('VARIA_TEST_BACKEND needs an absolute VARIA_TEST_NODE.')
    const [mode, argument] = fake.split(':', 2)
    return { command: node, args: ['--disable-warning=ExperimentalWarning', join(o.root, 'tests/fixtures/backend.mjs'), mode, ...argument === undefined ? [] : [argument]], cwd: o.root, packaged: false }
  }
  const dll = join(o.root, 'backend/Varia.Backend/bin', o.smokeTest ? 'Release' : 'Debug', 'net11.0/Varia.Backend.dll')
  return { command: 'dotnet', args: [dll], cwd: o.root, env: withBigQueryEndpoint(o.smokeTest ? o.env : withoutTestHooks(o.env), o), packaged: false, requires: dll }
}

const resultMemoryVariable = 'VARIA_RESULT_MEMORY_MIB'
const bigQueryEndpointVariable = 'VARIA_TEST_BIGQUERY_ENDPOINT'

/** The BigQuery emulator VARIA_TEST_BIGQUERY_ENDPOINT names, honoured only by unpackaged builds and only as a loopback http
 *  address with no path (BigQueryEnvironment.EmulatorEndpoint checks it again): emulator mode, with anonymous credentials. */
export function bigQueryEmulatorEndpoint(options: { packaged: boolean; env?: NodeJS.ProcessEnv }): string | undefined {
  const value = options.packaged ? undefined : options.env?.[bigQueryEndpointVariable]?.trim()
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' && !/[?#]/.test(value) ? `${url.origin}/` : undefined
  } catch { return undefined }
}

/** The backend gets VARIA_TEST_BIGQUERY_ENDPOINT only as bigQueryEmulatorEndpoint accepts it: never in a packaged build,
 *  whatever the shell sets (in any case: Windows ignores it), and never an address the backend would refuse to start with. */
function withBigQueryEndpoint(env: NodeJS.ProcessEnv | undefined, options: { packaged: boolean; env?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv | undefined {
  if (!env) return undefined
  const endpoint = bigQueryEmulatorEndpoint(options)
  const copy = { ...env }
  for (const name of Object.keys(copy)) if (name.toUpperCase() === bigQueryEndpointVariable) delete copy[name]
  if (endpoint !== undefined) copy[bigQueryEndpointVariable] = endpoint
  return copy
}

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
