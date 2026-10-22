// Protocol v2 constants shared by main, the results worker, the fake backend and tests. The C# side mirrors the wire
// limits in backend/Varia.Backend/Protocol/Frames.cs; docs/ipc.md is the reference.
// Everything under src/shared/ipc/wire is erasable TypeScript that imports only siblings (with .ts extensions), so Node
// can run it through type stripping (tests/ipc-lint.test.ts).

export const PROTOCOL_VERSION = 2

const KiB = 1024
const MiB = 1024 * KiB

export const limits = {
  /** Frame bodies, main → backend (a 1,000,000-unit script is at most 3,000,000 UTF-8 bytes) and backend → main. */
  requestBody: 4 * MiB,
  responseBody: 16 * MiB,
  eventBody: 256 * KiB,
  /** Essential (never dropped) events: a result set's descriptor of up to 4,096 columns. */
  essentialEventBody: 4 * MiB,
  page: { maxRows: 4096, maxColumns: 4096, sealBytes: 256 * KiB, firstPageRows: 64, firstPageMs: 20, idleSealMs: 200 },
  rowBytes: 8 * MiB,
  /** Stored cell caps: characters for text, bytes for binary. */
  cell: { text: 65_535, document: 2_097_152, vector: 65_535, binary: 32_766 },
  maxResultSets: { min: 1, max: 1000, default: 10 },
  maxRows: 2_147_483_647,
  /** `lateErrors`: error entries kept after the count or character cap, so the error that stopped a script is never lost. */
  messages: { count: 1000, characters: 1_000_000, errorCharacters: 16_384, lateErrors: 20 },
  pending: { requests: 256, control: 32, stdinBytes: 32 * MiB },
  backend: { inFlight: 288, metadataSlots: 8, sessions: 32, resultReads: 16 },
  credit: { min: 64 * KiB, max: 16 * MiB, workerDefault: 4 * MiB, perStream: 16 * MiB, perPort: 64 * MiB },
  port: { outstanding: 64, invalidMessages: 100, opensPerMinute: 10 },
  worker: { cacheBytes: 64 * MiB, cachePages: 512, windowRows: 4096, windowCells: 262_144, windowCharacters: 4_000_000, displayCharacters: 1024 },
  timers: { helloMs: 20_000, pingMs: 5000, unresponsiveMs: 15_000, stopGraceMs: 2000, backstopMs: 5000, progressPerSecond: 10, messagesFlushMs: 100 },
  restart: { delaysMs: [0, 1000, 2000], breakerLosses: 3, breakerWindowMs: 120_000, resetAfterMs: 300_000 },
  ids: { maxRequestId: 2 ** 31 - 1 },
  registries: { lostConnections: 1024, abandonedRequests: 4096, ownedResults: 100_000, stderrLines: 32, stderrCharacters: 512 },
  /** Copy and Save Results As (one of each per window). Copy text is capped before any work; progress is pushed at most
   *  4 times a second. */
  jobs: { copyBytes: 64 * MiB, chunkBytes: MiB, copyCredit: 16 * MiB, copyDeadlineMs: 120_000, progressPerSecond: 4, suggestedName: 128, path: 32_767 },
  /** Live subscriptions (docs/ipc.md, Live subscriptions): each has at most one unacknowledged EVENT. Its initial credit
   *  is 64 KiB, and the backend sends an EVENT only while all of it is back. An EVENT is at most `eventBody`; the
   *  catalogue's worst case stays within `frameBudget`. `perServer` counts subscriptions by the server a connection reaches,
   *  whatever its login or database. They reach C# through the embedded Live/live-catalog.json (LiveCatalog.Limits).
   *  The scheduler's own: live statements run under gates (`statementsPerConnection` per connection id, `statements` in the
   *  backend, shared with unary methods on lane live); a statement's budget is 0.8 × its probe's interval within the
   *  probe's `budgetMs`, itself within `budgetMs` here; a failing or costly probe backs off up to `backoffMs` (or its asked
   *  interval when that is longer); and a subscription returns its connection to the pool while every probe is
   *  paused or its next probe is at least `idleMs` away.
   *  Tables (Live/LiveTables.cs): a snapshot revision holds at most `snapshotRows`; an append segment rolls at
   *  `segmentRows` or `segmentBytes`, `segments` segments' worth kept (one that stopped early for memory counts
   *  what it holds) in at most `segmentResults` stored results per table; an append read takes at most `batchRows` new rows a tick. A
   *  subscription's tables share `subscriptionBytes`, and all live tables at most `budgetShare` of the result budget.
   *  Facets: `facetColumns` columns of `facetValues` values of `facetCharacters` characters, at most `facetBytes` of
   *  UTF-8 text in one tick. A source whose `hidden` policy is statusOnly samples at most every `hiddenIntervalMs` while hidden. */
  live: {
    portStreams: 16, backendSubscriptions: 32, perServer: 8, probes: 8, tablesPerProbe: 4, appendPerProbe: 4, tablesPerTick: 8,
    series: 64, statuses: 16, statusCharacters: 128, errors: 8, messageCharacters: 2000, noteCharacters: 400, columns: 64,
    intervalMs: { min: 1000, max: 3_600_000 }, initialCredit: 64 * KiB, frameBudget: 192 * KiB,
    sortColumns: 4, filterCharacters: 400, filterColumns: 8, trackedKeys: 64, keyCharacters: 512, resumeCharacters: 256, kept: 64,
    statementsPerConnection: 2, statements: 8, budgetMs: { min: 500, max: 10_000 }, backoffMs: 60_000, idleMs: 30_000,
    snapshotRows: 10_000, segmentRows: 200_000, segmentBytes: 32 * MiB, segments: 2, segmentResults: 8, batchRows: 10_000, subscriptionBytes: 64 * MiB, budgetShare: 0.25,
    facetColumns: 7, facetValues: 100, facetCharacters: 128, facetBytes: 32 * KiB, hiddenIntervalMs: 30_000
  }
} as const

/** CANCEL frame reasons (the frame's arg). */
export const cancelReasons = { user: 1, deadline: 2, consumerGone: 3, shutdown: 4 } as const
export type CancelReason = typeof cancelReasons[keyof typeof cancelReasons]

export const errorCodes = [
  // Backend, existing in v1.
  'INVALID_REQUEST', 'INVALID_PARAMS', 'METHOD_NOT_FOUND', 'BUSY', 'CANCELLED', 'SQL_ERROR', 'SMO_ERROR', 'BACKEND_ERROR',
  'NOT_CONNECTED', 'NOT_FOUND', 'DUPLICATE_QUERY', 'SESSION_BUSY', 'SESSION_LOST', 'SESSION_CLOSED', 'SESSION_TARGET',
  'SESSION_LIMIT', 'AUTH_UNSUPPORTED', 'INVALID_SCRIPT',
  // Backend: integrated authentication on Linux and macOS without a usable Kerberos ticket (AUTH_UNSUPPORTED: no GSSAPI library).
  'AUTH_KERBEROS',
  // Backend: a Microsoft Entra sign-in failed or must be repeated; the message says what to do.
  'AUTH_ENTRA',
  // Backend, new in v2.
  'TIMEOUT', 'TOO_LARGE', 'RESPONSE_TOO_LARGE', 'RESULT_NOT_FOUND', 'RESULT_RELEASED',
  // Backend, results jobs: an export failure (its message is one token: ACCESS, DISK_FULL, IN_USE, NOT_FOUND,
  // IS_DIRECTORY or IO) and an export of a set still loading.
  'EXPORT_FAILED', 'RESULT_OPEN',
  // Backend and main: an Object Explorer requestId that is already running.
  'DUPLICATE_REQUEST',
  // GOAWAY.
  'PROTOCOL_ERROR', 'PROTOCOL_UNSUPPORTED', 'BACKEND_CRASH',
  // Main.
  'BACKEND_LOST', 'BACKEND_UNAVAILABLE', 'CONNECTION_LOST', 'RESULT_UNAVAILABLE', 'TOO_MANY_REQUESTS', 'STREAM_PROTOCOL', 'PORT_CLOSED',
  // Main: a second Save Results As in the same window.
  'JOB_BUSY',
  // Renderer.
  'PAGE_INVALID', 'RESULT_DECODER_FAILED'
] as const
export type ErrorCode = typeof errorCodes[number]
