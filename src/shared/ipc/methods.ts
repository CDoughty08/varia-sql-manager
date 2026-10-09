// How main sends each backend method over protocol v2 (docs/ipc.md). Erasable TypeScript with type-only imports, so
// the fake backend (tests/fixtures/backend.mjs) can load it through Node's type stripping.
// A new unary method needs one entry here, usually `metadata`; the C# lane table is SqlService.LaneOf.
import type { BackendMethod, BackendMethods } from '../contracts'

export type MethodKind = 'unary' | 'stream'
/** Backend scheduling: control runs at once, metadata waits for one of 8 slots, query takes the session path, results
 *  one of 16 read slots, and explorer runs at once under Object Explorer's own gates (4 per connection, 8 in all; static
 *  folders need none). Main reserves 32 extra pending requests for the control lane. */
export type MethodLane = 'control' | 'metadata' | 'query' | 'results' | 'explorer'

export interface MethodPolicy<M extends BackendMethod = BackendMethod> {
  readonly kind: MethodKind
  readonly lane: MethodLane
  /** The REQUEST header deadline in ms (0 = none). The backend answers TIMEOUT when it passes. */
  readonly deadlineMs: number | ((params: BackendMethods[M]['params']) => number)
  /** Main's own backstop when the header carries no deadline; otherwise the backstop is the deadline plus 5 s. */
  readonly backstopMs?: (params: BackendMethods[M]['params']) => number
  /** The request carries a password: its frame is zeroed once written. */
  readonly sensitive?: boolean
}

const metadata = { kind: 'unary', lane: 'metadata', deadlineMs: 45_000 } as const
const control = { kind: 'unary', lane: 'control', deadlineMs: 10_000 } as const
const backstopGraceMs = 5000

export const methodPolicies: { readonly [M in BackendMethod]: MethodPolicy<M> } = {
  'system.health': control,
  // Today's rule: the connect timeout plus 30 s, and 0 waits as long as the provider does.
  'connections.connect': { kind: 'unary', lane: 'metadata', deadlineMs: params => params.advanced?.connectTimeout === 0 ? 0 : ((params.advanced?.connectTimeout ?? 15) + 30) * 1000, sensitive: true },
  'connections.databases': { ...metadata, sensitive: true },
  'connections.discover': metadata,
  'connections.preview': { ...control, lane: 'metadata', sensitive: true },
  'connections.disconnect': { ...control, deadlineMs: 30_000 },
  'databases.list': metadata,
  'tables.script': metadata,
  'tables.columns': metadata,
  // The script's own timeout ends it inside the backend (status timedOut); main only guards against a lost answer.
  'query.execute': { kind: 'unary', lane: 'query', deadlineMs: 0, backstopMs: params => params.timeoutSeconds === 0 ? 0 : (params.timeoutSeconds + 30) * 1000 },
  'query.cancel': control,
  'query.session.close': control,
  // Pages arrive as DATA frames within the stream's credit; the RESPONSE ends the stream.
  'results.read': { kind: 'stream', lane: 'results', deadlineMs: 60_000 },
  'results.close': control,
  // The backend answers its own 40 s budget as a TIMEOUT value; main cancels it from the renderer (varia:explorer-cancel).
  'explorer.children': { kind: 'unary', lane: 'explorer', deadlineMs: 45_000 },
  // The backend answers its own 55 s budget as a TIMEOUT value, inside this deadline; main cancels it from the renderer (varia:scripting-cancel).
  'scripting.script': { kind: 'unary', lane: 'metadata', deadlineMs: 60_000 },
  'debug.results.synthesize': { kind: 'unary', lane: 'metadata', deadlineMs: 120_000 }
}

/** Every method main may call; a backend whose HELLO lacks one of them is from a different build. `debug.*` methods
 *  exist only in a backend started with test hooks, so HELLO need not list them. */
export const backendMethods = (Object.keys(methodPolicies) as BackendMethod[]).filter(method => !method.startsWith('debug.')) as readonly BackendMethod[]

export function isBackendMethod(method: string): method is BackendMethod { return Object.hasOwn(methodPolicies, method) }

/** The header deadline and main's backstop for one request, in ms (0 = none). */
export function deadlineFor<M extends BackendMethod>(method: M, params: BackendMethods[M]['params']): { deadlineMs: number; backstopMs: number } {
  const policy = methodPolicies[method] as MethodPolicy<M>
  const deadlineMs = typeof policy.deadlineMs === 'function' ? policy.deadlineMs(params) : policy.deadlineMs
  const backstopMs = policy.backstopMs ? policy.backstopMs(params) : deadlineMs === 0 ? 0 : deadlineMs + backstopGraceMs
  return { deadlineMs, backstopMs }
}
