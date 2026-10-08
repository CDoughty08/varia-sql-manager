// How main sends each backend method over protocol v2 (docs/ipc.md). Erasable TypeScript with type-only imports, so
// the fake backend (tests/fixtures/backend.mjs) can load it through Node's type stripping.
// A new unary method needs one entry here, usually `metadata`; the C# lane table is SqlService.LaneOf.
import type { RpcMethod, RpcMethods } from '../contracts'

export type MethodKind = 'unary' | 'stream'
/** Backend scheduling: control runs at once, metadata waits for one of 8 slots, query takes the session path, results
 *  one of 16 read slots. Main reserves 32 extra pending requests for the control lane. */
export type MethodLane = 'control' | 'metadata' | 'query' | 'results'

export interface MethodPolicy<M extends RpcMethod = RpcMethod> {
  readonly kind: MethodKind
  readonly lane: MethodLane
  /** The REQUEST header deadline in ms (0 = none). The backend answers TIMEOUT when it passes. */
  readonly deadlineMs: number | ((params: RpcMethods[M]['params']) => number)
  /** Main's own backstop when the header carries no deadline; otherwise the backstop is the deadline plus 5 s. */
  readonly backstopMs?: (params: RpcMethods[M]['params']) => number
  /** The request carries a password: its frame is zeroed once written. */
  readonly sensitive?: boolean
}

const metadata = { kind: 'unary', lane: 'metadata', deadlineMs: 45_000 } as const
const control = { kind: 'unary', lane: 'control', deadlineMs: 10_000 } as const
const backstopGraceMs = 5000

export const methodPolicies: { readonly [M in RpcMethod]: MethodPolicy<M> } = {
  'system.health': control,
  // Today's rule: the connect timeout plus 30 s, and 0 waits as long as the provider does.
  'connections.connect': { kind: 'unary', lane: 'metadata', deadlineMs: params => params.advanced?.connectTimeout === 0 ? 0 : ((params.advanced?.connectTimeout ?? 15) + 30) * 1000, sensitive: true },
  'connections.databases': { ...metadata, sensitive: true },
  'connections.discover': metadata,
  'connections.preview': { ...control, lane: 'metadata', sensitive: true },
  'connections.disconnect': { ...control, deadlineMs: 30_000 },
  'databases.list': metadata,
  'server.objects.list': metadata,
  'tables.list': metadata,
  'tables.script': metadata,
  // The script's own timeout ends it inside the backend (status timedOut); main only guards against a lost answer.
  'query.execute': { kind: 'unary', lane: 'query', deadlineMs: 0, backstopMs: params => params.timeoutSeconds === 0 ? 0 : (params.timeoutSeconds + 30) * 1000 },
  'query.cancel': control,
  'query.session.close': control
}

/** Every method main may call; a backend whose HELLO lacks one of them is from a different build. */
export const backendMethods = Object.keys(methodPolicies) as readonly RpcMethod[]

export function isBackendMethod(method: string): method is RpcMethod { return Object.hasOwn(methodPolicies, method) }

/** The header deadline and main's backstop for one request, in ms (0 = none). */
export function deadlineFor<M extends RpcMethod>(method: M, params: RpcMethods[M]['params']): { deadlineMs: number; backstopMs: number } {
  const policy = methodPolicies[method] as MethodPolicy<M>
  const deadlineMs = typeof policy.deadlineMs === 'function' ? policy.deadlineMs(params) : policy.deadlineMs
  const backstopMs = policy.backstopMs ? policy.backstopMs(params) : deadlineMs === 0 ? 0 : deadlineMs + backstopGraceMs
  return { deadlineMs, backstopMs }
}
