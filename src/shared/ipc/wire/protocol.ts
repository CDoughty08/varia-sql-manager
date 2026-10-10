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
  page: { maxRows: 4096, maxColumns: 4096, sealBytes: 256 * KiB, firstPageRows: 64, firstPageMs: 20, idleSealMs: 200 },
  rowBytes: 8 * MiB,
  /** Stored cell caps: characters for text, bytes for binary. */
  cell: { text: 65_535, document: 2_097_152, vector: 65_535, binary: 32_766 },
  maxResultSets: { min: 1, max: 1000, default: 10 },
  maxRows: 2_147_483_647,
  messages: { count: 1000, characters: 1_000_000, errorCharacters: 16_384 },
  pending: { requests: 256, control: 32, stdinBytes: 32 * MiB },
  backend: { inFlight: 288, metadataSlots: 8, sessions: 32, resultReads: 16 },
  credit: { min: 64 * KiB, max: 16 * MiB, workerDefault: 4 * MiB, perStream: 16 * MiB, perPort: 64 * MiB },
  port: { outstanding: 64, invalidMessages: 100, opensPerMinute: 10 },
  worker: { cacheBytes: 64 * MiB, cachePages: 512, windowRows: 4096, windowCells: 262_144, windowCharacters: 4_000_000, displayCharacters: 1024 },
  timers: { helloMs: 20_000, pingMs: 5000, unresponsiveMs: 15_000, stopGraceMs: 2000, backstopMs: 5000, progressPerSecond: 10, messagesFlushMs: 100 },
  restart: { delaysMs: [0, 1000, 2000], breakerLosses: 3, breakerWindowMs: 120_000, resetAfterMs: 300_000 },
  ids: { maxRequestId: 2 ** 31 - 1 },
  registries: { lostConnections: 1024, abandonedRequests: 4096, ownedResults: 100_000, stderrLines: 32, stderrCharacters: 512 }
} as const

/** CANCEL frame reasons (the frame's arg). */
export const cancelReasons = { user: 1, deadline: 2, consumerGone: 3, shutdown: 4 } as const
export type CancelReason = typeof cancelReasons[keyof typeof cancelReasons]

export const errorCodes = [
  // Backend, existing in v1.
  'INVALID_REQUEST', 'INVALID_PARAMS', 'METHOD_NOT_FOUND', 'BUSY', 'CANCELLED', 'SQL_ERROR', 'SMO_ERROR', 'BACKEND_ERROR',
  'NOT_CONNECTED', 'NOT_FOUND', 'DUPLICATE_QUERY', 'SESSION_BUSY', 'SESSION_LOST', 'SESSION_CLOSED', 'SESSION_TARGET',
  'SESSION_LIMIT', 'AUTH_UNSUPPORTED', 'INVALID_SCRIPT',
  // Backend, new in v2.
  'TIMEOUT', 'TOO_LARGE', 'RESPONSE_TOO_LARGE', 'RESULT_NOT_FOUND', 'RESULT_RELEASED',
  // GOAWAY.
  'PROTOCOL_ERROR', 'PROTOCOL_UNSUPPORTED', 'BACKEND_CRASH',
  // Main.
  'BACKEND_LOST', 'BACKEND_UNAVAILABLE', 'CONNECTION_LOST', 'RESULT_UNAVAILABLE', 'TOO_MANY_REQUESTS', 'STREAM_PROTOCOL', 'PORT_CLOSED',
  // Renderer.
  'PAGE_INVALID', 'RESULT_DECODER_FAILED'
] as const
export type ErrorCode = typeof errorCodes[number]
