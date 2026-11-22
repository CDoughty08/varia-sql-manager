// How main sends each backend method over protocol v2 (docs/ipc.md). Erasable TypeScript with type-only imports, so
// the fake backend (tests/fixtures/backend.mjs) can load it through Node's type stripping; value imports name their .ts file.
// A new unary method needs one entry here, usually `metadata`; the C# lane table is SqlService.LaneOf.
import type { BackendMethod, BackendMethods } from '../contracts'
import { actionDrainMs } from '../actions/catalog.ts'
import { bothProviders, providersOf, type ProviderId } from '../providers.ts'

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
  /** While such a request is pending, how long a generation main closes may run after its stdin ends before main kills it, in ms
   *  (at least the usual stop grace): the backend first finishes work that must not end half done. */
  readonly drainMs?: (params: BackendMethods[M]['params']) => number
  /** Its EVENT frames are charged against its credit, and only one may be unacknowledged (docs/ipc.md, Live
   *  subscriptions). Only live.subscribe sets it; such a request has no DATA frames. */
  readonly creditedEvents?: boolean
  /** The engines it serves; absent, SQL Server only (`defaultProviders`), so a new method is SQL Server's until it says
   *  otherwise. Main refuses a request whose connection is another provider's with UNSUPPORTED_PROVIDER before sending it
   *  (`requestProvider`), and SqlService.DispatchAsync checks again (`Providers.BothMethods` mirrors this). Methods that name a
   *  query, session or result rather than a connection are declared for both and checked only in C#. */
  readonly providers?: readonly ProviderId[]
}

const metadata = { kind: 'unary', lane: 'metadata', deadlineMs: 45_000 } as const
const control = { kind: 'unary', lane: 'control', deadlineMs: 10_000 } as const
const both = { providers: bothProviders } as const
const backstopGraceMs = 5000
/** How long an Entra MFA connect or Load databases may wait for the browser sign-in (the backend's own limit). */
export const entraSignInMs = 180_000
const signIn = (params: { authentication: string }) => params.authentication === 'entraMfa' ? entraSignInMs : 0
/** A closing generation's grace while Create Catalog runs: the backend's own wait for one past its restore (the SSIS catalogue's
 *  createDrainMs, 120 s) plus room for the rest of its shutdown. */
export const createCatalogDrainMs = 130_000
/** One server file picker listing: the backend's own 10 s budget (actionLimits.browseMs) plus room for its answer. */
export const serverFilesDeadlineMs = 15_000
/** A Restore Database describe: the backend's own 120 s budget for reading backup media (restoreLimits.mediaReadMs) plus room for its answer (critic A2). */
export const restoreDescribeDeadlineMs = 130_000

export const methodPolicies: { readonly [M in BackendMethod]: MethodPolicy<M> } = {
  'language.status': control,
  'language.complete': { kind: 'unary', lane: 'metadata', deadlineMs: 30_000 },
  'language.hover': { kind: 'unary', lane: 'metadata', deadlineMs: 30_000 },
  'language.diagnostics': { kind: 'unary', lane: 'metadata', deadlineMs: 30_000 },
  // Refresh cancels obsolete language work before rebuilding metadata, so it must reach an occupied metadata lane.
  'language.refresh': { kind: 'unary', lane: 'control', deadlineMs: 30_000 },
  'language.close': control,
  'language.definition': { kind: 'unary', lane: 'metadata', deadlineMs: 15_000 },
  'plans.parse': { kind: 'unary', lane: 'metadata', deadlineMs: 15_000 },
  // EstimatedPlanCapture: 30 s acquisition + 2 s isolated-session cleanup, inside this fixed deadline.
  'plans.estimate': { kind: 'unary', lane: 'query', deadlineMs: 35_000 },
  'system.health': { ...control, ...both },
  // The connect timeout plus 30 s, and 0 waits as long as the provider does; Entra MFA adds the browser sign-in's 3 minutes.
  // Stop (varia:connections-cancel) ends either at any time.
  'connections.connect': { kind: 'unary', lane: 'metadata', deadlineMs: params => params.nonInteractive ? 15_000 : params.provider === 'bigquery' ? 45_000 : params.advanced?.connectTimeout === 0 ? 0 : ((params.advanced?.connectTimeout ?? 15) + 30) * 1000 + signIn(params), sensitive: true, ...both },
  // BigQuery: the project's datasets (the dialog's Default dataset), signed in with main's credential like connect.
  'connections.databases': { kind: 'unary', lane: 'metadata', deadlineMs: params => params.nonInteractive ? 15_000 : 45_000 + signIn(params), sensitive: true, ...both },
  'connections.discover': metadata,
  'connections.preview': { ...control, lane: 'metadata', sensitive: true },
  'connections.disconnect': { ...control, ...both, deadlineMs: 30_000 },
  // BigQuery before connecting (the dialog's account line and project picker): main injects the credential material.
  'bigquery.account': { ...control, deadlineMs: 30_000, sensitive: true, providers: ['bigquery'] },
  'bigquery.projects': { ...control, deadlineMs: 30_000, sensitive: true, providers: ['bigquery'] },
  // Before every backend stop main makes: idle sessions' ABORT_SESSION jobs in parallel, bounded so a stop never waits long.
  'bigquery.endIdleSessions': { ...control, deadlineMs: 10_000, providers: ['bigquery'] },
  // A saved profile's jobs without a handle: sign in, then cancel, wait for DONE and end each job's session in parallel.
  'bigquery.cancelJobs': { ...control, deadlineMs: 60_000, sensitive: true, providers: ['bigquery'] },
  // The free estimate and dry-run diagnostics on a connected handle (docs/bigquery.md, Cost).
  // Metadata, as language.diagnostics: automatic edit-time requests must not take the pending slots kept for Cancel and closes.
  'bigquery.dryRun': { ...metadata, deadlineMs: 30_000, providers: ['bigquery'] },
  // A table-like object's Properties facts: one tables.get, free (docs/bigquery.md, Properties).
  'bigquery.properties': { ...metadata, deadlineMs: 30_000, providers: ['bigquery'] },
  // GSSAPI reads the credential cache without contacting the KDC; one lookup at a time (SqlService.IdentityAsync).
  'connections.identity': { ...control, lane: 'metadata' },
  // A BigQuery handle lists its billing project's datasets (a query tab's Dataset box).
  'databases.list': { ...metadata, ...both },
  'tables.columns': metadata,
  // The script's own timeout ends it inside the backend (status timedOut); main only guards against a lost answer.
  'query.execute': { kind: 'unary', lane: 'query', deadlineMs: 0, backstopMs: params => params.timeoutSeconds === 0 ? 0 : (params.timeoutSeconds + 30) * 1000, ...both },
  'query.cancel': { ...control, ...both },
  // A re-attached BigQuery job runs like a query, as long as BigQuery takes; Stop is query.cancel.
  'query.attach': { kind: 'unary', lane: 'query', deadlineMs: 0, backstopMs: () => 0, providers: ['bigquery'] },
  // Load into memory runs like a query, as long as BigQuery takes; Stop is query.cancel.
  'results.remoteQuery': { kind: 'unary', lane: 'query', deadlineMs: 0, backstopMs: () => 0, providers: ['bigquery'] },
  // A commit first waits for SQL Server's log flush; a rollback is bounded inside the backend (closing the session rolls back too).
  // A commit covers a queued COMMIT and the session's end inside the backend's budgets; every other close (decision 54)
  // allows one BigQuery ABORT_SESSION job and its poll. The deadline cannot see the provider.
  'query.session.close': { ...control, ...both, deadlineMs: params => params.transaction === 'commit' ? 60_000 : 30_000 },
  // One SELECT @@TRANCOUNT in an idle session (a busy one answers at once); a prompt waits on it, so it is short.
  'query.session.state': { ...control, ...both, deadlineMs: 5000 },
  // Bookkeeping only (ResultVisibility): answered at once, so it never queues behind reads.
  'results.visibility': { ...control, ...both },
  // Pages arrive as DATA frames within the stream's credit; the RESPONSE ends the stream.
  'results.read': { kind: 'stream', lane: 'results', deadlineMs: 60_000, ...both },
  'results.close': { ...control, ...both },
  // Tools › Options' result memory limit, from main: it changes two figures in memory, at once.
  'results.setMemoryLimit': { ...control, ...both },
  // Reads the lengths recorded beside stored pages: memory only, at most 16,384 numbers.
  'results.rowBytes': { ...control, ...both },
  // Sorts a result's stored rows in memory off the frame loop (5 million rows take seconds); Stop cancels it.
  'results.view': { kind: 'unary', lane: 'results', deadlineMs: 120_000, ...both },
  'results.viewClose': { ...control, ...both },
  // Hashes every row of a stored result off the frame loop (seconds for millions of rows when no key is unique).
  'results.identify': { kind: 'unary', lane: 'results', deadlineMs: 120_000, ...both },
  // Reads at most 16,384 stored identities.
  'results.rowIds': { ...control, ...both },
  // Scans a result's identities in memory: milliseconds per million rows.
  'results.findRows': { kind: 'unary', lane: 'results', deadlineMs: 60_000, ...both },
  // Aligns two stored results and writes their unified diff off the frame loop (seconds for millions of rows).
  'results.diff': { kind: 'unary', lane: 'results', deadlineMs: 120_000, ...both },
  // Searches a result's stored rows in memory off the frame loop, as results.view sorts them; a newer search cancels it.
  'results.search': { kind: 'unary', lane: 'results', deadlineMs: 120_000, ...both },
  // Profiles stored rows in memory off the frame loop, two passes over the pages; Stop and a newer profile cancel it.
  'results.profile': { kind: 'unary', lane: 'results', deadlineMs: 120_000, ...both },
  // Groups and aggregates stored rows in memory off the frame loop, then stores the pivot as a result; Stop cancels it.
  'results.pivot': { kind: 'unary', lane: 'results', deadlineMs: 120_000, ...both },
  // Groups a column's stored values in memory off the frame loop, as a filter compares them; a newer request cancels it.
  'results.distinct': { kind: 'unary', lane: 'results', deadlineMs: 120_000, ...both },
  // A window of a kept snapshot; a new search scans its values once, in memory, off the frame loop.
  'results.distinctRead': { kind: 'unary', lane: 'results', deadlineMs: 30_000, ...both },
  // Ticks in a kept snapshot; ticking a search's values scans them once, as a read does.
  'results.distinctTick': { kind: 'unary', lane: 'results', deadlineMs: 30_000, ...both },
  'results.distinctClose': { ...control, ...both },
  // Reads a comparison's change index and one row's tone; finding a partner under a view is one pass over its order.
  'results.diffSeek': { kind: 'unary', lane: 'results', deadlineMs: 10_000, ...both },
  // The backend answers its own 40 s budget as a TIMEOUT value; main cancels it from the renderer (varia:explorer-cancel).
  'explorer.children': { kind: 'unary', lane: 'explorer', deadlineMs: 45_000, ...both },
  // A build reads every database (each within its own 120 s budget) and only Stop (varia:explorer-cancel), a newer build or a
  // disconnect ends it; a search answers its own 5 s budget as a partial value.
  'explorer.index': { kind: 'unary', lane: 'explorer', deadlineMs: 0, ...both },
  'explorer.search': { kind: 'unary', lane: 'explorer', deadlineMs: 15_000, ...both },
  // The backend answers its own 15 s budget (peekLimits.budgetMs) as a TIMEOUT value, inside this deadline.
  'explorer.peek': { kind: 'unary', lane: 'explorer', deadlineMs: 30_000 },
  'explorer.peekDependencies': { kind: 'unary', lane: 'explorer', deadlineMs: 30_000 },
  'explorer.peekDefinition': { kind: 'unary', lane: 'explorer', deadlineMs: 30_000 },
  'explorer.dependencies': { kind: 'unary', lane: 'explorer', deadlineMs: 30_000 },
  // Copy streams its text as DATA within credit; an export writes the file the user chose and only CANCEL ends it.
  'results.copy': { kind: 'stream', lane: 'results', deadlineMs: 120_000, ...both },
  'results.export': { kind: 'unary', lane: 'results', deadlineMs: 0, ...both },
  // The backend answers its own 55 s budget as a TIMEOUT value, inside this deadline; main cancels it from the renderer (varia:scripting-cancel).
  'scripting.script': { kind: 'unary', lane: 'metadata', deadlineMs: 60_000, ...both },
  // Object actions: describe and script answer their own 40 s and 25 s budgets as TIMEOUT values. DDL waits for locks as
  // SSMS does, without a deadline; Stop (varia:actions-cancel) always ends it. Database Properties uses the same three
  // methods (describe 'databaseProperties', action 'properties'), so its reads and DDL keep these deadlines and lanes. The
  // server file picker's listing (describe 'serverFiles') answers its own 10 s budget the same way, inside 15 s, and
  // Restore Database's reads of msdb and backup media (describe 'restoreDatabase') their own 120 s budget, inside 130 s.
  // actions.execute is sensitive as a whole (critic A3): New Login and Login Properties carry passwords in it, and a
  // per-request flag would leave the frame unzeroed the day an action forgets to set it.
  'actions.describe': { kind: 'unary', lane: 'metadata', deadlineMs: params => params.dialog === 'serverFiles' ? serverFilesDeadlineMs : params.dialog === 'restoreDatabase' ? restoreDescribeDeadlineMs : 45_000 },
  'actions.script': { kind: 'unary', lane: 'metadata', deadlineMs: 30_000 },
  // A long action (a restore or backup) stops itself and runs its cleanup when its generation is closed, so main waits that long.
  'actions.execute': { kind: 'unary', lane: 'actions', deadlineMs: 0, sensitive: true, drainMs: params => actionDrainMs(params.action) },
  // SSIS Catalog reads answer their own 40 s budget as a TIMEOUT value; main cancels them from the renderer (varia:ssis-cancel).
  'ssis.describe': { kind: 'unary', lane: 'ssis', deadlineMs: 45_000 },
  // SSIS Catalog writes wait for locks as SSMS does, without a deadline; Stop (varia:ssis-cancel) ends them, except Create
  // Catalog once its restore began, which finishes or removes what it created, also when its generation is closed (a quit, a
  // reload, Restart Backend), so main waits longer before it kills that generation. Sensitive: Create Catalog carries the
  // catalog's encryption password, and later verbs sensitive parameter and variable values.
  'ssis.execute': { kind: 'unary', lane: 'ssis', deadlineMs: 0, sensitive: true, drainMs: params => params.action.verb === 'createCatalog' ? createCatalogDrainMs : 0 },
  // Create Catalog's dialog read answers its own 40 s budget as a TIMEOUT value, as a describe does.
  'ssis.catalogSetup': { kind: 'unary', lane: 'ssis', deadlineMs: 45_000 },
  // Activity Monitor's session actions. Details answers its own 10 s budget as an error: TIMEOUT value, inside this deadline;
  // main cancels it from the renderer (varia:activity-cancel). Kill answers its own 25 s budget the same way, with the
  // outcomes of the sessions it tried, so the deadline never leaves a kill's outcome unknown; it is never re-sent.
  'activity.details': { kind: 'unary', lane: 'live', deadlineMs: 15_000 },
  'activity.kill': { kind: 'unary', lane: 'actions', deadlineMs: 30_000 },
  // SQL Server Agent's capability read: one small batch in msdb on the Object Explorer pool, on its own slot per connection (as
  // Peek, never queued behind the tree's paging). Its own 10 s budget starts once it holds that slot and ends as a TIMEOUT value (unless msdb already refused the login: then the profile with no role). SQL Server only (no `providers`), so a BigQuery handle gets UNSUPPORTED_PROVIDER.
  'agent.profile': { kind: 'unary', lane: 'explorer', deadlineMs: 15_000 },
  // The Log File Viewer's whole message: the action service's read gates and DescribeBudget (TIMEOUT as a value) inside this deadline.
  'agent.historyMessage': { kind: 'unary', lane: 'metadata', deadlineMs: 45_000 },
  'agent.counterValues': { kind: 'unary', lane: 'metadata', deadlineMs: 45_000 },
  // Help › Clear Entra ID Token Cache: empties memory only, at once.
  'entra.cache.clear': control,
  // No deadline and no backstop: only CANCEL, a disconnect, a loss or the source ending ends it.
  'live.subscribe': { kind: 'stream', lane: 'live', deadlineMs: 0, creditedEvents: true },
  // Applied at once to the subscription's settings; its next scheduler wake uses them.
  'live.update': control,
  'debug.results.synthesize': { kind: 'unary', lane: 'metadata', deadlineMs: 120_000 }
}

/** Methods only main sends, on its own behalf: no renderer schema (requestSchemas) or port schema accepts them. */
export const mainOnlyMethods = ['results.copy', 'results.export', 'entra.cache.clear', 'results.setMemoryLimit', 'debug.results.synthesize', 'bigquery.endIdleSessions', 'bigquery.cancelJobs'] as const satisfies readonly BackendMethod[]

/** Every method main may call; a backend whose HELLO lacks one of them is from a different build. `debug.*` methods
 *  exist only in a backend started with test hooks, so HELLO need not list them. */
export const backendMethods = (Object.keys(methodPolicies) as BackendMethod[]).filter(method => !method.startsWith('debug.')) as readonly BackendMethod[]

export function isBackendMethod(method: string): method is BackendMethod { return Object.hasOwn(methodPolicies, method) }

/** The engines a method serves (its policy's `providers`, or SQL Server only). */
export function methodProviders(method: BackendMethod): readonly ProviderId[] { return providersOf(methodPolicies[method]) }
/** The methods whose provider comes from their parameters (`provider`; absent: SQL Server): they open a connection. */
export const providerParamMethods = ['connections.connect', 'connections.databases', 'connections.preview'] as const satisfies readonly BackendMethod[]
/**
 * The provider a request is for, as main can tell it: the connection options' for a method that opens one, the handle's
 * (`providerOfConnection`, main's record of what each connect opened) for a method that names a `connectionId`, and
 * undefined for one that names neither (a query, session or result id: C# resolves those).
 */
export function requestProvider(method: BackendMethod, params: unknown, providerOfConnection: (id: string) => ProviderId | undefined): ProviderId | undefined {
  const record = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {}
  if ((providerParamMethods as readonly string[]).includes(method)) return record.provider === 'bigquery' ? 'bigquery' : 'sqlserver'
  // A language request names its connection in its context.
  const context = record.context !== null && typeof record.context === 'object' ? record.context as Record<string, unknown> : {}
  const connectionId = typeof record.connectionId === 'string' ? record.connectionId : typeof context.connectionId === 'string' ? context.connectionId : undefined
  return connectionId === undefined ? undefined : providerOfConnection(connectionId)
}
/** Whether `method` may be sent for a request of `provider` (undefined: main cannot tell, and C# checks). */
export function methodAllows(method: BackendMethod, provider: ProviderId | undefined): boolean { return provider === undefined || methodProviders(method).includes(provider) }

/** Whether a request's options mean anything to its connection's engine: query.execute's SQL Server options (stop on
 *  error, actual and live plans, client statistics) are not BigQuery's, and a dataset is not SQL Server's. C# checks again
 *  (SqlService.ExecuteAsync). */
export function optionsAllow(method: BackendMethod, provider: ProviderId | undefined, params: unknown): boolean {
  if (method !== 'query.execute' || provider === undefined || typeof params !== 'object' || params === null) return true
  const options = params as Partial<BackendMethods['query.execute']['params']>
  if (provider === 'bigquery') return !options.stopOnError && !options.includeActualPlan && !options.includeLivePlan && !options.includeClientStatistics
  return options.dataset === undefined && options.maximumBytesBilled === undefined && options.prices === undefined && options.preview === undefined && options.residence === undefined && options.windowCacheMiB === undefined
}

/** The header deadline and main's backstop for one request, in ms (0 = none). */
export function deadlineFor<M extends BackendMethod>(method: M, params: BackendMethods[M]['params']): { deadlineMs: number; backstopMs: number } {
  const policy = methodPolicies[method] as MethodPolicy<M>
  const deadlineMs = typeof policy.deadlineMs === 'function' ? policy.deadlineMs(params) : policy.deadlineMs
  const backstopMs = policy.backstopMs ? policy.backstopMs(params) : deadlineMs === 0 ? 0 : deadlineMs + backstopGraceMs
  return { deadlineMs, backstopMs }
}
