// How main sends each backend method over protocol v2 (docs/ipc.md). Erasable TypeScript with type-only imports, so
// the fake backend (tests/fixtures/backend.mjs) can load it through Node's type stripping.
// A new unary method needs one entry here, usually `metadata`; the C# lane table is SqlService.LaneOf.
import type { BackendMethod, BackendMethods } from '../contracts'

export type MethodKind = 'unary' | 'stream'
/** Backend scheduling: control runs at once, metadata waits for one of 8 slots, query takes the session path, results
 *  one of 16 read slots, and explorer runs at once under Object Explorer's own gates (4 per connection, 8 in all; static
 *  folders need none), and actions runs object action DDL at once under the action service's own gates (1 per connection,
 *  2 in all), so a DROP waiting on a lock never holds a metadata slot; Kill Process runs there under gates of its own, so
 *  it never queues behind such a DROP. ssis runs SSIS Catalog reads and writes at once under the SSIS services' own gates
 *  (reads 2 per connection, 4 in all; writes 1 and 2), so a request waiting on SSISDB never holds a metadata slot either.
 *  Main reserves 32 extra pending requests for the control lane. A Microsoft Entra MFA connect or Load databases holds its
 *  metadata slot while the user signs in in the web browser, for up to 3 minutes; those sign-ins run one at a time. A live
 *  subscription (lane live) takes no slot: its own task samples on its own schedule, one tick at a time. Its statements,
 *  and those of a unary method on lane live, run under the live gates (2 per connection, 8 in all, each waited for at most
 *  the statement's budget, then BUSY). */
export type MethodLane = 'control' | 'metadata' | 'query' | 'results' | 'explorer' | 'actions' | 'live' | 'ssis'

export interface MethodPolicy<M extends BackendMethod = BackendMethod> {
  readonly kind: MethodKind
  readonly lane: MethodLane
  /** The REQUEST header deadline in ms (0 = none). The backend answers TIMEOUT when it passes. */
  readonly deadlineMs: number | ((params: BackendMethods[M]['params']) => number)
  /** Main's own backstop when the header carries no deadline; otherwise the backstop is the deadline plus 5 s. */
  readonly backstopMs?: (params: BackendMethods[M]['params']) => number
  /** The request carries a password: its frame is zeroed once written. */
  readonly sensitive?: boolean
  /** Its EVENT frames are charged against its credit, and only one may be unacknowledged (docs/ipc.md, Live
   *  subscriptions). Only live.subscribe sets it; such a request has no DATA frames. */
  readonly creditedEvents?: boolean
}

const metadata = { kind: 'unary', lane: 'metadata', deadlineMs: 45_000 } as const
const control = { kind: 'unary', lane: 'control', deadlineMs: 10_000 } as const
const backstopGraceMs = 5000
/** How long an Entra MFA connect or Load databases may wait for the browser sign-in (the backend's own limit). */
export const entraSignInMs = 180_000
const signIn = (params: { authentication: string }) => params.authentication === 'entraMfa' ? entraSignInMs : 0

export const methodPolicies: { readonly [M in BackendMethod]: MethodPolicy<M> } = {
  'system.health': control,
  // The connect timeout plus 30 s, and 0 waits as long as the provider does; Entra MFA adds the browser sign-in's 3 minutes.
  // Stop (varia:connections-cancel) ends either at any time.
  'connections.connect': { kind: 'unary', lane: 'metadata', deadlineMs: params => params.advanced?.connectTimeout === 0 ? 0 : ((params.advanced?.connectTimeout ?? 15) + 30) * 1000 + signIn(params), sensitive: true },
  'connections.databases': { kind: 'unary', lane: 'metadata', deadlineMs: params => 45_000 + signIn(params), sensitive: true },
  'connections.discover': metadata,
  'connections.preview': { ...control, lane: 'metadata', sensitive: true },
  'connections.disconnect': { ...control, deadlineMs: 30_000 },
  // GSSAPI reads the credential cache without contacting the KDC; one lookup at a time (SqlService.IdentityAsync).
  'connections.identity': { ...control, lane: 'metadata' },
  'databases.list': metadata,
  'tables.columns': metadata,
  // The script's own timeout ends it inside the backend (status timedOut); main only guards against a lost answer.
  'query.execute': { kind: 'unary', lane: 'query', deadlineMs: 0, backstopMs: params => params.timeoutSeconds === 0 ? 0 : (params.timeoutSeconds + 30) * 1000 },
  'query.cancel': control,
  // A commit first waits for SQL Server's log flush; a rollback is bounded inside the backend (closing the session rolls back too).
  'query.session.close': { ...control, deadlineMs: params => params.transaction === 'commit' ? 60_000 : 10_000 },
  // One SELECT @@TRANCOUNT in an idle session (a busy one answers at once); a prompt waits on it, so it is short.
  'query.session.state': { ...control, deadlineMs: 5000 },
  // Pages arrive as DATA frames within the stream's credit; the RESPONSE ends the stream.
  'results.read': { kind: 'stream', lane: 'results', deadlineMs: 60_000 },
  'results.close': control,
  // The backend answers its own 40 s budget as a TIMEOUT value; main cancels it from the renderer (varia:explorer-cancel).
  'explorer.children': { kind: 'unary', lane: 'explorer', deadlineMs: 45_000 },
  // Copy streams its text as DATA within credit; an export writes the file the user chose and only CANCEL ends it.
  'results.copy': { kind: 'stream', lane: 'results', deadlineMs: 120_000 },
  'results.export': { kind: 'unary', lane: 'results', deadlineMs: 0 },
  // The backend answers its own 55 s budget as a TIMEOUT value, inside this deadline; main cancels it from the renderer (varia:scripting-cancel).
  'scripting.script': { kind: 'unary', lane: 'metadata', deadlineMs: 60_000 },
  // Object actions: describe and script answer their own 40 s and 25 s budgets as TIMEOUT values. DDL waits for locks as
  // SSMS does, without a deadline; Stop (varia:actions-cancel) always ends it. Database Properties uses the same three
  // methods (describe 'databaseProperties', action 'properties'), so its reads and DDL keep these deadlines and lanes.
  'actions.describe': { kind: 'unary', lane: 'metadata', deadlineMs: 45_000 },
  'actions.script': { kind: 'unary', lane: 'metadata', deadlineMs: 30_000 },
  'actions.execute': { kind: 'unary', lane: 'actions', deadlineMs: 0 },
  // SSIS Catalog reads answer their own 40 s budget as a TIMEOUT value; main cancels them from the renderer (varia:ssis-cancel).
  'ssis.describe': { kind: 'unary', lane: 'ssis', deadlineMs: 45_000 },
  // SSIS Catalog writes wait for locks as SSMS does, without a deadline; Stop (varia:ssis-cancel) always ends them. Sensitive,
  // because later verbs carry sensitive parameter and variable values.
  'ssis.execute': { kind: 'unary', lane: 'ssis', deadlineMs: 0, sensitive: true },
  // Activity Monitor's session actions. Details answers its own 10 s budget as an error: TIMEOUT value, inside this deadline;
  // main cancels it from the renderer (varia:activity-cancel). Kill answers its own 25 s budget the same way, with the
  // outcomes of the sessions it tried, so the deadline never leaves a kill's outcome unknown; it is never re-sent.
  'activity.details': { kind: 'unary', lane: 'live', deadlineMs: 15_000 },
  'activity.kill': { kind: 'unary', lane: 'actions', deadlineMs: 30_000 },
  // Help › Clear Entra ID Token Cache: empties memory only, at once.
  'entra.cache.clear': control,
  // No deadline and no backstop: only CANCEL, a disconnect, a loss or the source ending ends it.
  'live.subscribe': { kind: 'stream', lane: 'live', deadlineMs: 0, creditedEvents: true },
  // Applied at once to the subscription's settings; its next scheduler wake uses them.
  'live.update': control,
  'debug.results.synthesize': { kind: 'unary', lane: 'metadata', deadlineMs: 120_000 }
}

/** Methods only main sends, on its own behalf: no renderer schema (requestSchemas) or port schema accepts them. */
export const mainOnlyMethods = ['results.copy', 'results.export', 'entra.cache.clear', 'debug.results.synthesize'] as const satisfies readonly BackendMethod[]

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
