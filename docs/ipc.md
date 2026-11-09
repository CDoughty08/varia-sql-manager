# IPC protocol v2

How the Electron main process, the .NET backend, and the renderer's results worker talk to each other: the frame format,
the MessagePack subset, the handshake, requests and streams, result pages, the result store, the results port, the
supervisor's restart rules, every limit and error code, the SSMS display formats, and the benchmarks.

The code is the reference implementation; this document describes it.

| Part | TypeScript | C# (`backend/Varia.Backend`) |
| --- | --- | --- |
| Constants, limits, error codes | `src/shared/ipc/wire/protocol.ts` | `Protocol/Frames.cs` |
| MessagePack subset | `src/shared/ipc/wire/msgpack.ts` | `Protocol/MsgPack.cs`, `Protocol/JsonBridge.cs` |
| Frames | `src/shared/ipc/wire/frames.ts` | `Protocol/Frames.cs`, `Protocol/Outbound.cs` |
| Result pages | `src/shared/ipc/wire/pages.ts`, `cells.ts` | `Results/PageBuilder.cs`, `CellFormat.cs`, `ColumnReaders.cs` |
| Method policies | `src/shared/ipc/methods.ts` | `SqlService.LaneOf`, `SqlService.MethodNames` |
| One backend process | `src/main/backend/connection.ts` | `Protocol/ProtocolHost.cs`, `RequestContext.cs` |
| Generations and restarts | `src/main/backend/supervisor.ts` | — |
| Results port | `src/main/backend/results-port.ts`, `src/shared/ipc/port-messages.ts` | — |
| Result store | — | `Results/ResultStore.cs`, `ResultSetBuffer.cs`, `QueryEventSink.cs`, `ForXmlCollector.cs` |
| Copy and Save Results As | `src/main/results-jobs.ts`; the fake backend's `tests/fixtures/backend/text-writer.mjs` | `Results/ResultJobs.cs`, `ResultTextWriter.cs`, `PageView.cs` |
| Results worker | `src/renderer/src/results/` | — |
| Live subscriptions | `src/shared/live/` (catalogue, schemas, docs/live.md); main's parts in `connection.ts`, `supervisor.ts`, `results-port.ts`; the renderer's `LiveService` in `src/renderer/src/live/` | `Live/LiveService.cs` (registry, scheduler), `LiveCatalog.cs`, `SqlSampler.cs` (pools, prologues, table reads), `LiveSql.cs` (probe text, lint), `LiveSqlReader.cs` (multi-statement sources), `Activity/ActivityReader.cs` and `ActivityRows.cs` (the Activity Monitor source), `LiveTables.cs` (snapshot and append writers), `LiveStart.cs`, `LiveDeltas.cs`, `LiveGates.cs`, `LiveResume.cs`, `LiveErrors.cs`, `SyntheticSampler.cs` |

## Contents

- [Shape](#shape)
- [Frames](#frames)
- [MessagePack subset](#messagepack-subset)
- [Handshake](#handshake)
- [Requests, deadlines, and cancellation](#requests-deadlines-and-cancellation)
- [Methods](#methods)
- [Streams and credits](#streams-and-credits)
- [Query execution](#query-execution)
- [Query events](#query-events)
- [Result pages](#result-pages)
- [Result store and memory budget](#result-store-and-memory-budget)
- [Cell lengths and row sizes](#cell-lengths-and-row-sizes)
- [Sorted views](#sorted-views)
- [Row identities and highlights](#row-identities-and-highlights)
- [Result diffs](#result-diffs)
- [Search in results](#search-in-results)
- [Column profiles](#column-profiles)
- [Messages](#messages)
- [Copy and Save Results As](#copy-and-save-results-as)
- [Live subscriptions](#live-subscriptions)
- [Results port and results worker](#results-port-and-results-worker)
- [Malformed input](#malformed-input)
- [Backend threads and exit codes](#backend-threads-and-exit-codes)
- [Generations, restarts, and lost connections](#generations-restarts-and-lost-connections)
- [Limits](#limits)
- [Error codes and fixed sentences](#error-codes-and-fixed-sentences)
- [Display formats](#display-formats)
- [Security](#security)
- [Testing](#testing)
- [Benchmarks](#benchmarks)

## Shape

```text
Renderer (sandboxed)                          Main                                         .NET backend
 UI thread                                     BackendSupervisor (generations)               ProtocolHost
  services ─ window.varia.* ─ invoke ───────►  zod → methodPolicies → BackendConnection ═══►  reader thread ─ dispatch (Task)
  BackendStateService ◄─ varia:backend-state   lost registry, watchdog, stderr ring    ◄═══  writer thread: control lane │ bulk lane
  ResultClient ◄─ windows (transfer) ─┐        ResultsPortHost: portRequestSchema,           SqlService ─ ResultStore (budget)
 results worker: pages, LRU, text ◄═══╪═══════ MessagePort (one per renderer load) ═══►       PageBuilder, ColumnReaders
                                               DATA bodies forwarded opaque (exact size)
  stdin/stdout: [16-byte header][MessagePack body]…   stderr: fixed-format diagnostics only
```

- **Unary methods** stay on `ipcRenderer.invoke('varia:request')`: `trusted()`, strict zod (`requestSchemas`), and
  `ApiResult` results, now with an error `code`. `connections.connect` and `.databases` take an optional fourth
  argument, a strict `ConnectContext` (`{ profileId?, remember?, requestId? }`: the history entry whose remembered
  password main may fill in, whether to remember the password once connected, and the uuid the dialog's Stop cancels the
  request by); any other method with one fails with `Invalid request.`. A failure after main filled in a remembered
  password that was rejected (SQL Server's 18456 under SQL Server Authentication, AADSTS50126 or 7000215 under Microsoft
  Entra Password or Service Principal) carries `passwordForgotten: true`.
- **One MessagePort per renderer load** carries query events, the memory push, and the `results.read` / `results.close`
  streams between main and the results worker. The preload never decodes MessagePack and exposes no port.
- **Rows stay in the backend.** `query.execute` returns a summary with a descriptor per result set; the results worker
  reads pages on demand. Reading from SQL Server never waits for the UI.
- **Main never decodes pages.** It checks each DATA frame's header, stream, sequence and credit, copies the body into an
  exact-size `ArrayBuffer`, and posts it to the worker. Electron cannot transfer an `ArrayBuffer` from main to a
  renderer, so each page is copied once there; inside the renderer, window flags are transferred.
- **The supervisor restarts the process, never sessions.** A request belongs to one backend generation and is never
  re-sent; connections of an ended generation are shown as lost until the user reconnects.

## Frames

Every frame is a 16-byte little-endian header followed immediately by its body.

| Offset | Size | Field | Rule |
| --- | --- | --- | --- |
| 0 | 2 | magic | `56 0A` ("V", LF). Anything else is a fatal desync. |
| 2 | 1 | kind | One of the kinds below, legal for the direction. |
| 3 | 1 | flags | Must be 0. |
| 4 | 4 | length | Body bytes, at most the direction's maximum. Only CANCEL, CREDIT, PING and PONG have (and must have) an empty body. |
| 8 | 4 | id | Request id; 0 for HELLO, PING, PONG, GOAWAY and a global EVENT. |
| 12 | 4 | arg | REQUEST: deadline in ms (0 = none). DATA: sequence number, from 1, contiguous per stream. CANCEL: reason. CREDIT: bytes. PING, PONG: nonce. Otherwise 0. |

| Code | Kind | Direction | Body |
| --- | --- | --- | --- |
| 1 | HELLO | both; the first frame each way, exactly once | map, see [Handshake](#handshake) |
| 2 | REQUEST | main → backend | `{ method: str ≤ 64, params: map, credit?: uint }`; `credit` only for stream methods (64 KiB – 16 MiB) |
| 3 | RESPONSE | backend → main | `{ result: any }` or `{ error: { code: str, message: str ≤ 16,384, details?: map } }` ([details](#error-codes-and-fixed-sentences)); exactly one per REQUEST |
| 4 | EVENT | backend → main | id of a `query.execute` request: a [query event](#query-events). id 0: `{ type: 'results.memory' or 'explorer.index.memory', usedBytes, globalBytes, seq }` |
| 5 | DATA | backend → main | One [result page](#result-pages); id of a `results.read` request |
| 6 | CANCEL | main → backend | Empty. arg: 1 user, 2 deadline backstop, 3 consumer gone, 4 shutdown |
| 7 | CREDIT | main → backend | Empty. arg: bytes, 1 – 16,777,216 |
| 8 / 9 | PING / PONG | main → backend / backend → main | Empty. arg: nonce |
| 10 | GOAWAY | backend → main | `{ code, message, versions?: [min, max] }`, written just before the backend exits |

A REQUEST with id 1 for `system.health` and a 10,000 ms deadline:

```text
56 0A 02 00 1E 00 00 00 01 00 00 00 10 27 00 00 | 82 A6 6D 65 74 68 6F 64 AD 73 79 73 74 65 6D 2E 68 65 61 6C 74 68 A6 70 61 72 61 6D 73 80
magic kind flags length=30  id=1        arg=10000 | { "method": "system.health", "params": {} }
```

**Parsing.** `FrameParser` (TypeScript) validates magic, kind, direction, flags and length before allocating anything,
then copies the body into its own `new Uint8Array(length)` (`byteOffset 0`, exactly `length` bytes, never pooled). A body
over the maximum is skipped and reported as an oversize frame, so the stream stays in sync; any other violation leaves
the parser dead. On the backend, `FrameReader` reads the header with `ReadExactly`, validates it, and reads the body into
a new array; an oversized REQUEST body is drained through a 64 KiB scratch buffer and answered `TOO_LARGE`.

**Writing.** Main writes one exact buffer per frame (`encodeFrame`) and bounds what it has queued for stdin at 32 MiB.
The backend's `Outbound` writer drains a control lane before a bulk lane through a 64 KiB buffer, flushing when both
lanes are empty; bodies over 64 KiB go straight through. Stored pages are written as they are, without copying.

## MessagePack subset

Both sides hand-roll the same subset (no runtime dependency): nil, false, true; positive and negative fixint, uint8 – 64,
int8 – 64; float64 (`cb`); fixstr, str8/16/32; bin8/16/32 (page bodies only); fixarray, array16/32; fixmap, map16/32.
`c1`, float32 and every ext type are rejected.

**Canonical encoding.** The smallest form always, with the unsigned family for non-negative integers; a JavaScript
number is an integer when `Number.isSafeInteger` holds and float64 otherwise; `-0` is written as 0. `undefined` object
properties are omitted, as in JSON; `undefined` in an array is an error. The C# writer produces identical bytes
(`tests/fixtures/ipc-vectors.json`).

**Decoding control bodies** (`decodeControl`, `MsgPackReader` with `JsonBridge`):

- JSON-shaped only: string keys, no bin, no duplicate keys, and no `__proto__`, `constructor` or `prototype` keys.
- Strict UTF-8 (overlong forms, surrogates and truncated sequences are rejected); NaN and ±Infinity are rejected; a
  float64 `-0` decodes as 0.
- Integers of any width, range-checked to ±(2⁵³ − 1).
- Depth ≤ 16 (tracked without recursion, so a nesting bomb fails at 17), maps ≤ 4,096 entries, arrays ≤ 1,048,576
  items, keys ≤ 128 bytes, and every length checked against the remaining bytes before anything is allocated.
- The whole body must be consumed.

The backend transcodes REQUEST params to a `JsonElement` and results from System.Text.Json output (`JsonBridge`), so the
STJ records with `UnmappedMemberHandling.Disallow` keep rejecting unknown members. JSON integers beyond ±(2⁵³ − 1)
become float64, which TypeScript accepts. Requests that carry a password or a sensitive value (`connections.connect`,
`.databases`, `.preview`, `ssis.execute`, which carries Create Catalog's encryption password, and `actions.execute`, whose
`secrets` carries New Login's password (and will carry Login Properties'); `actions.script` refuses `secrets` in main's schema and in
the backend) are encoded into buffers that are zeroed after use on both sides; the
JavaScript and .NET strings they came from cannot be zeroed. Main zeroes the methods whose `methodPolicies` entry is
`sensitive`, the backend those in `SqlService.SensitiveMethods` (`IRequestDispatcher.Sensitive`), and
`tests/validation.test.ts` keeps the two lists equal.

## Handshake

1. Main spawns the backend (stdio pipes, `windowsHide`) and writes HELLO
   `{ versions: [2, 2], generation, maxFrameBytes: 16777216, app }`. Nothing else is written until HELLO completes.
2. The backend opens stdout, then sends `Console.Out` to stderr and empties `Console.In`, installs an unhandled-exception
   handler (best-effort GOAWAY `BACKEND_CRASH`, exit 70), and waits for main's HELLO. Any other frame first, or no HELLO
   within 20 s: GOAWAY `PROTOCOL_ERROR`, exit 64. No common version: GOAWAY `PROTOCOL_UNSUPPORTED` with
   `versions: [2, 2]`, exit 65.
3. The backend answers HELLO
   `{ version: 2, generation, pid, runtime, platform, sqlClientVersion, maxFrameBytes: 4194304, resultBudget: { globalBytes, queryBytes }, methods }`.
   SMO is not loaded for this; `system.health` still reports its version.
4. Main validates it with zod: version 2, the echoed generation, `maxFrameBytes` ≥ 4 MiB, and `methods` containing every
   method main may call (`backendMethods`). Any failure is `failed (incompatible)`, with no retry: a stale build after
   C# changes is caught here.
5. A protocol 1 backend reads lines, so the magic's LF ends the line `V`, which it answers at once with a JSON error.
   A first stdout byte of `{` therefore means a protocol 1 backend, reported as incompatible within milliseconds.

## Requests, deadlines, and cancellation

- **Envelope.** `{ method, params, credit? }`. The backend's reader thread validates only the envelope; params are
  transcoded and checked on the dispatched task (`INVALID_PARAMS` is not fatal).
- **Exactly one RESPONSE per REQUEST id**, including streams, cancellations and deadlines (an interlocked settle flag on
  the backend; a pending table on main).
- **Deadlines.** The header deadline is linked to the request's cancellation token. When it passes and the work does
  not stop, the backend answers `TIMEOUT` within 100 ms, discards the late result, and frees the metadata slot only when
  the work really ends (SMO cannot be interrupted). `query.execute` sends no header deadline; the script's own timeout
  still ends with status `timedOut`.
- **Main's backstop** fires 5 s after the header deadline (for `query.execute`, `timeoutSeconds + 30` s, none when the
  timeout is 0). It first yields one `setImmediate` turn, because timers run before I/O is polled and the answer may
  already be in the pipe; if the request is still pending, it fails with `TIMEOUT`, sends CANCEL reason 2, and adds the
  id to a 4,096-entry ring of abandoned ids whose late frames are dropped and counted.
- **CANCEL** for an unknown or finished id is ignored. Otherwise the request's token is cancelled: reason 1 is a user
  cancel (`query.execute` ends `cancelled`), unary methods answer `CANCELLED`, and `results.read` answers `CANCELLED`
  after its current page.
- **Ordering.** Unary RESPONSEs and all EVENTs use the control lane, so a query's events precede its summary. A stream's
  DATA frames and its final RESPONSE use the bulk lane, in order. Between the invoke and port channels, the summary is
  authoritative.
- **Ids** are u32 from 1 per generation and stay below 2³¹; reaching that ends the generation.

## Methods

`methodPolicies` (`src/shared/ipc/methods.ts`) gives each method its kind, lane and deadline. Lanes decide how the
backend schedules it: `control` runs at once, `metadata` waits for one of 8 slots (at most 30 s or the remaining
deadline, then `BUSY`), `query` uses the per-tab session path, `results` takes one of 16 read slots, `explorer`
runs at once under Object Explorer's own gates (4 statements per connection, 8 in all; static folders need neither), and
`actions` runs object action DDL at once under the action service's own gates (1 per Varia connection, 2 in all, each waited
for at most 30 s, then `BUSY`; a long action, a restore or backup, takes the long gate instead, also 1 per connection and 2 in
all), so a DROP waiting on a lock never holds a metadata slot; Kill Process (`activity.kill`)
runs there too, under gates of its own (1 per connection, 2 in all, waited for at most 5 s, then `BUSY`), so it never queues behind a
DROP that may be waiting on the very session it kills. `live` takes no slot either: a live subscription samples on its
own task, and its statements, like those of a unary method on lane `live` (`activity.details`, through
`LiveService.RunGatedAsync`), run under the live gates (2 per connection, 8 in all, each waited for at most the
statement's budget, and for Details at most its 10 s budget, then `BUSY`; only for a connected id, else `NOT_CONNECTED`, so ids a request names
never pile up).
`ssis` runs SSIS Catalog reads and writes at once under the SSIS services' own gates (reads 2 per connection and 4 in all,
writes 1 and 2, each waited for at most 30 s, then `BUSY`), so a request waiting on SSISDB never holds a metadata slot either.

| Method | Renderer path | Kind | Lane | Header deadline |
| --- | --- | --- | --- | --- |
| `system.health` | invoke | unary | control | 10 s |
| `connections.connect` | invoke; cancelled with `cancelConnectionRequests` (Stop) | unary | metadata | (connect timeout, default 15) + 30 s, plus 180 s for Microsoft Entra MFA's browser sign-in; 0 means none. Password zeroed. A failed open carries error `details`. |
| `connections.databases` | invoke; cancelled with `cancelConnectionRequests` | unary | metadata | 45 s, plus 180 s for Microsoft Entra MFA. Password zeroed. A failed open carries error `details`. |
| `connections.discover` | invoke | unary | metadata | 45 s |
| `connections.preview` | invoke | unary | metadata | 10 s. Password zeroed. |
| `connections.disconnect` | invoke | unary | control | 30 s; answered locally `{ disconnected: false }` for a lost connection or a failed backend |
| `connections.identity` | invoke | unary | metadata | 10 s. Takes `{}`; main checks the answer (integrated identity, below). |
| `databases.list` | invoke | unary | metadata | 45 s |
| `tables.columns` | invoke | unary | metadata | 45 s; the backend also stops its own query after 30 s. Tables and views, read through `QUOTENAME(@db) + '.sys.sp_executesql'` so no pooled connection stays in the database |
| `plans.parse` | invoke | unary | metadata | 15 s; parses Showplan data only, without a SQL connection. Main compresses raw XML before the 4 MiB request boundary; see Execution plan viewer below |
| `plans.estimate` | invoke | unary | query | 35 s; fixed 30 s compilation budget; optional `mode: isolated | session` (default isolated), two acquisitions, 64 documents / 2,097,152 total XML characters; cancelled by `query.cancel(requestId)`. No query events or execution summary fields. See [estimated plans](estimated-plans.md) |
| `query.execute` | invoke, events on the port | unary with EVENTs | query | none; backstop `timeoutSeconds + 30` s |
| `query.cancel` | invoke | unary | control | 10 s |
| `query.session.close` | invoke | unary | control | 10 s, 60 s with `transaction: 'commit'`; answered locally `{ closed: false }` for a session of an ended generation |
| `query.session.state` | invoke | unary | control | 5 s; answered locally `SESSION_LOST` for a session of an ended generation |
| `results.read` | port | stream | results | 60 s |
| `results.close` | port | unary | control | 10 s |
| `results.rowBytes` | port | unary | control | 10 s; each row's bytes for 1 – 16,384 sealed rows ([Cell lengths and row sizes](#cell-lengths-and-row-sizes)) |
| `results.view` | port | unary | results | 120 s; a sorted or filtered view of a result's sealed rows ([Sorted views](#sorted-views)) |
| `results.viewClose` | port | unary | control | 10 s |
| `results.identify` | port | unary | results | 120 s; tells a complete result's rows apart ([Row identities and highlights](#row-identities-and-highlights)) |
| `results.rowIds` | port | unary | control | 10 s; 1 – 16,384 rows' identities |
| `results.findRows` | port | unary | results | 60 s; where 1 – 10,000 identities are in a result or view |
| `results.diff` | port | unary | results | 120 s; the unified diff of two results of one query, stored as a new result ([Result diffs](#result-diffs)) |
| `results.search` | port | unary | results | 120 s; the cells of a result (or a view) containing a text ([Search in results](#search-in-results)) |
| `results.profile` | port | unary | results | 120 s; aggregates over a result's or a view's rows ([Column profiles](#column-profiles)) |
| `live.subscribe` | port | stream of credited EVENTs ([Live subscriptions](#live-subscriptions)) | live (no slot) | none, and no backstop: only CANCEL, a disconnect, a shutdown, a failure or its source ending ends it |
| `live.update` | port | unary | control | 10 s |
| `explorer.children` | invoke; cancelled with `explorerCancel` | unary | explorer | 45 s; the backend answers its own 40 s budget as an `error: TIMEOUT` value |
| `explorer.index` | invoke; cancelled with `explorerCancel` | unary with droppable `explorer.index.progress` EVENTs (relayed to the requesting window, at most 4 a second) | explorer | none; each database has its own 120 s budget ([Search Objects](object-search.md)) |
| `explorer.search` | invoke; cancelled with `explorerCancel` | unary | explorer | 15 s; the backend stops at 5 s and answers `partial` |
| `explorer.peek` | invoke; cancelled with `explorerCancel` | unary | explorer (Peek's own slot per connection) | 30 s; the backend answers its own 15 s budget, from when it has the slot, as an `error: TIMEOUT` value |
| `explorer.peekDependencies` | invoke; cancelled with `explorerCancel` | unary | explorer (Peek's own slot per connection) | 30 s; as `explorer.peek` |
| `results.copy` | main only (`varia:results-copy`) | stream, with EVENTs | results | 120 s |
| `results.export` | main only (`varia:results-save`) | unary with EVENTs | results | none, and no backstop: only CANCEL (reason 1) ends it |
| `scripting.script` | invoke; cancelled with `cancelScripting` | unary | metadata | 60 s; the backend answers its own 55 s budget as an `error: TIMEOUT` value |
| `actions.describe` | invoke; cancelled with `cancelObjectActions` | unary | metadata | 45 s; the backend answers its own 40 s budget as an `error: TIMEOUT` value (reads wait at most 10 s for a lock: `BLOCKED`). The server file picker (`dialog: 'serverFiles'`): 15 s around the backend's 10 s budget per listing. Restore Database (`dialog: 'restoreDatabase'`): 130 s around the backend's 120 s budget for reading backup media |
| `actions.script` | invoke; cancelled with `cancelObjectActions` | unary | metadata | 30 s; the backend answers its own 25 s budget as an `error: TIMEOUT` value |
| `actions.execute` | invoke; cancelled with `cancelObjectActions` (Stop); progress through `onActionProgress` | unary with EVENTs | actions | none, and no backstop: DDL waits for locks as SSMS does, and only CANCEL (reason 1) ends it, answered with its steps once SQL Server has ended the statement and the action's compensation and cleanup steps have run (at most 10 s plus its `cleanupMs` later). A long action's steps send droppable `action.progress` EVENTs (below), and while one is pending main closes its generation with a grace of 10 s plus its `cleanupMs` plus 5 s (`drainMs`, `actionDrainMs`), because the backend's shutdown stops it and waits for its cleanup. Sensitive (frame zeroed). Main checks the answer (`actionExecuteResultSchema`: each step's title, message, detail and progress bounded). Never re-sent |
| `ssis.describe` | invoke; cancelled with `cancelSsis` | unary | ssis | 45 s; the backend answers its own 40 s budget as an `error: TIMEOUT` value (reads wait at most 5 s for a lock, the profile's role checks 1 s: `BLOCKED`) |
| `ssis.execute` | invoke; cancelled with `cancelSsis` (Stop) | unary | ssis | none, and no backstop: a write waits for locks as SSMS does, and only CANCEL (reason 1) ends it, answered with its steps once SQL Server has ended the statement (at most 10 s later); its preflight answers its own 25 s budget as `error: TIMEOUT` (10 s lock timeout: `BLOCKED`). Sensitive (frame zeroed). Never re-sent. Create Catalog: Stop ends it at any statement but its restore, and its reply waits (past the grace, a disconnect included) for the restore to end and for the removal of what was created; while one is pending, main closes its generation with a 130 s grace instead of 2 s (`drainMs`), because the backend's shutdown waits up to 120 s for it |
| `ssis.catalogSetup` | invoke; cancelled with `cancelSsis` | unary | ssis | 45 s; the backend answers its own 40 s budget as an `error: TIMEOUT` value (10 s lock timeout: `BLOCKED`) |
| `activity.details` | invoke; cancelled with `cancelActivity` (closing Details) | unary | live (the live gates) | 15 s; the backend answers its own 10 s budget as an `error: TIMEOUT` value |
| `activity.kill` | invoke | unary | actions (its own gates) | 30 s; the backend answers its own 25 s budget as an `error: TIMEOUT` value with the outcomes of the sessions it tried. Never re-sent |
| `entra.cache.clear` | main only (`varia:entra-cache-clear`, after its confirmation) | unary | control | 10 s. Takes `{}` (unknown members refused); answers `{ cleared: true }` |
| `debug.results.synthesize` | `__variaTest` and tests only | unary | metadata | 120 s; exists only with `VARIA_BACKEND_TEST_HOOKS=1` |

`mainOnlyMethods` (`results.copy`, `results.export`, `entra.cache.clear`, `debug.results.synthesize`) are sent only by
main on its own behalf: they are in no renderer schema (`requestSchemas`) and no port schema (`portRequestSchema`).

**Microsoft Entra ID.** The six Entra types (`authentication`: `entraMfa`, `entraPassword`, `entraIntegrated`,
`entraServicePrincipal`, `entraManagedIdentity`, `entraDefault`; `src/shared/auth.ts` and the backend's
`EntraModes.cs` list the same eight types) become SqlClient's `Authentication` keyword, so every pool derived from the
connection gets tokens through Varia's own `SqlAuthenticationProvider` (registered for SqlClient's seven Entra methods,
not device code flow or workload identity). Tokens stay in the backend's memory for its lifetime (MSAL's in-memory caches,
one per sign-in authority plus one for Entra Integrated, so Integrated never reuses an account MFA or Password signed
in; MSAL's managed identity cache; and Azure.Identity's credentials); none is written to disk or crosses IPC. The provider runs
inside SqlClient's synchronous login, where no cancellation reaches it, so it never waits for a person: for MFA it only
looks for a cached token and otherwise records, by the attempt's `ClientConnectionId`, that a sign-in is needed. Only
`connections.connect` and `.databases` then sign in through the system web browser (MSAL, SqlClient's public client
`2fd908ad-0664-4344-b9be-cd3e8b574c38`, redirect `http://localhost`, no WAM), under the request's own token and a
3-minute limit that includes waiting for another sign-in, one sign-in at a time, and open again with a new connection.
MFA without a user name opens unpooled (a pool's token is reused without asking the provider), the provider records which
account its token was for, and the stored connection string names that account, whether the browser ran or not; later
opens then find that account's token when several are signed in to the tenant. A provider failure that was not recorded
(SqlClient's error 0, class 11, on an Entra connection) answers `AUTH_ENTRA` with SqlClient's own text. Every other open answers `AUTH_ENTRA` ("Your Microsoft Entra
sign-in for this server has expired or was revoked…") instead. Authority hosts and resources the server names are
checked against an allowlist (the public, US Government and China clouds; SQL audiences) before any token is requested.
The allowlist limits where Varia signs in and which audience a token is for, not which server receives it: every Entra
mode sends the token to the server the request names, as SqlClient and SSMS do. As with Windows authentication's
credentials, a connect or Load databases with MFA (a cached account), Integrated, Managed Identity or Default sends it with
no browser step or prompt, and a hostile server could replay it against Azure SQL until it expires (60 to 90 minutes).
Main does not gate this: the workbench page can start such a connect without a user gesture, and nothing binds cached
tokens to servers the user connected to before. That matches SSMS (the owner's rule) and is the owner's to revisit.
Every connect and Load databases, under any authentication, gives its open up as soon as its token is cancelled, and the
abandoned connection is closed when SqlClient's login ends, so Stop answers at once.

**Connect cancellation** works as the others do (`RendererRequests`, `varia:connections-cancel`, 1–16 ids, 64 tombstones
for 60 s; 8 running): a connect or Load databases is registered by the `requestId` of its context, only when it has one,
and the Connect dialog's Stop (its Cancel button, or Escape, while connecting), a changed form, and a closed dialog cancel
it with a CANCEL frame (reason 1), answered `CANCELLED`.

**A backend method is added in five places:** `RpcMethods` (`src/shared/contracts.ts`); `requestSchemas`
(`src/main/validation.ts`) for invoke or `portRequestSchema` for the port; a `methodPolicies` entry (a new unary method
is usually one `metadata` line); a preload or `ResultClient` method; and a `SqlService.DispatchAsync` case with its
`MethodNames` entry and record in `Contracts.cs`. A backend whose HELLO lacks a method main may call is refused, and
lists that could exceed 16 MiB must be paged (`RESPONSE_TOO_LARGE`).

**Integrated identity.** Under Windows Authentication the Connect dialog's User name shows who will sign in, as SSMS
does: `DOMAIN\user` on Windows (main answers it with the connection library), and off Windows the principal of the
default credential cache's ticket, from `connections.identity`. The renderer asks when the dialog opens, as SSMS reads
the identity then, so saved Windows Authentication connections show it too, and again each time Windows Authentication is
chosen; a new question clears the last answer, so a principal since destroyed never shows while it is pending. The backend acquires the default initiator credential (`gss_acquire_cred`), names it (`gss_inquire_cred`,
`gss_display_name`), and releases everything; none of it contacts the KDC. Only a valid ticket answers a principal (MIT
will not inquire an expired credential); Windows, a missing or expired ticket, a missing library, or any GSSAPI failure
answer `{}`, and the dialog shows the OS user name. One lookup runs at a time and concurrent requests share it, so a
credential cache that does not answer holds one thread pool thread, and each request still ends at its deadline. The
answer is `{ principal?: str ≤ 256 }`: the backend drops a principal with control or formatting characters (Unicode
categories Cc and Cf) and cuts a longer one to 256 characters with an ellipsis, never inside a surrogate pair; main
checks the same bounds, by code point as the backend does (`resultSchemas` in `src/main/validation.ts`) and answers an invalid one as a failure.

**Object Explorer cancellation** has no backend method. Each `explorer.children` load carries the renderer's
`requestId`; main (`ExplorerRequests`) maps it to the REQUEST frame it went out as, and `explorerCancel(requestIds)`
(`varia:explorer-cancel`, 1–256 ids) sends a CANCEL frame with reason 1 for each, so the load answers `CANCELLED`. A
cancel that reaches main before the load was written is sent right after it; one for an id main has not seen is kept for
60 s (1,024 ids), and that load is then refused with `CANCELLED`. A running `requestId` sent again is
`DUPLICATE_REQUEST`. Catalog failures (permission, access, a missing object, a lock, the 40 s budget, a lost connection)
are not envelope errors but `result.error` values with their own codes, so each tree node shows its own failure.
A database row also carries its runtime state as `sys.databases` lists it, `database: { state: int, userAccess: int,
readOnly: bool, standby: bool }` (`state_desc` and `user_access_desc` as their numbers), so menus can narrow a database's
actions by it; a newer live status sample wins (`currentDatabaseRuntime`), but one cut at its row cap only for the
databases it has rows for. A login row carries `connectDenied: true` when CONNECT SQL is denied to it; its `status` stays
`disabled` when it is disabled too, so the row can show both. `connections.connect` answers `linux: bool`
when the server's profile was read (SQL Server on Linux or in a Linux container), for the `explorerServerLinux` context key;
`engineEdition` gives `explorerServerEngine` (`box`, `managedInstance` for edition 8, `cloud` for Azure SQL Database).

**Scripting cancellation** works the same way (`ScriptingRequests`, `varia:scripting-cancel`, 1–64 ids, 256 tombstones
for 60 s). The backend sends an attention for the statement SMO has in flight, answers at once, and keeps the job's
gate (2 per connection, 4 in all) until its thread ends; scripting failures are `result.error` values (docs/scripting.md).

**Object action cancellation** works the same way (`ActionRequests`, `varia:actions-cancel`, 1–16 ids, 64 tombstones for
60 s; 128 running): the object dialog's Stop, the status bar's Stop for a rename, and a disconnect cancel
`actions.describe`, `actions.script` and `actions.execute` by `requestId` (main routes exactly these and
`explorer.children`, `explorer.index`, `explorer.search` and `scripting.script` to a cancel channel, `cancellableRequests`). The backend cancels the statement
in SQL Server (an attention, which rolls it back). A describe, a script, or a disconnect answers `CANCELLED` at once, and
the action's job keeps its gate and connection until the statement has ended. A user CANCEL (reason 1) of
`actions.execute`, the one method on the `actions` lane, is the exception: ProtocolHost does not answer it, and the
request waits up to 10 s (`stopGraceMs`) for SQL Server to end the statement, then answers its result with each step
`done`, `cancelled` or `skipped` and `error: CANCELLED` (or a success, if the last statement finished first), so the
renderer can say what completed; past the grace it answers envelope `CANCELLED`, an unknown outcome. DDL runs on
its own unpooled connection (`ConnectRetryCount=0`, so it is never retried) with `LOCK_TIMEOUT -1`, after a preflight in
the same connection; describe and script use `LOCK_TIMEOUT 10000`. A lost backend answers `BACKEND_LOST`, which the
renderer reports as an unknown outcome ("Refresh Object Explorer to check"), since main never sends a request twice.
Failures the user can act on are `result.error` values, not envelope codes: `NOT_FOUND`, `NOT_SUPPORTED` (also every
action on Azure SQL Database, before any connection opens), `PERMISSION_DENIED`, `IN_USE`, `BLOCKED`, `DEPENDENTS`,
`NAME_IN_USE`, `PATH_NOT_FOUND` (the server file picker and backup files), `FILE_ACCESS` (a database or backup file SQL Server cannot open, or its service account may not read), `MEDIA` (backup media a restore cannot use), `DATABASE_UNAVAILABLE`, `TIMEOUT`, `CONNECTION_LOST`, `SQL_ERROR`, `CANCELLED` (Stop), `AUTH_KERBEROS`,
`AUTH_UNSUPPORTED` and `AUTH_ENTRA` (docs/object-actions.md). `actions.execute` answers `{ steps: { status: done | failed | skipped |
cancelled | rolledBack, title, message?, detail?, compensates?, progress? }[], messages: str[] (≤ 32 × 512), elapsedMs, error? }`: statements run
in order and stop at the first failure. `rolledBack` marks a step that completed in a transaction a later failure or Stop rolled
back (the table designer's Save, Unlock), whose message then names no step as completed. The backend's DryRun, which selects a statement instead of running it, exists only for
the .NET checks and is not reachable from the wire. Delete Object's `actions.describe` answers `deleteTarget { name, type, owner?,
warnings: { text, blocking }[], dependentsTruncated, isSnapshot?, sessions?, withTransaction?, blockers?: { sessionId, program?,
host?, openTransaction }[], blockersTruncated?, closeConnectionsNote?, transactionTabs?, login?, mappings? }`: for a database, the session count
(sessions in it or with a transaction in it, from any database), those with an open transaction, the sessions listed (at
most 8, never the backend's own pooled sessions; program and host at most 128 characters) and `transactionTabs` (the
session ids of Varia's query tabs holding an open transaction there, at most 1,000) need VIEW SERVER STATE, and
`closeConnectionsNote` says why Close existing connections is unavailable (Managed Instance, an offline database). For a
login (D4c), `login` is its facts (as `loginFacts` answers them, plus `ownedJobs?`, absent when msdb cannot be read, and
`grantedPermissions`, the server permissions it granted to others) and `mappings { users: { database, user, ownedSchemas,
ownedRoles, readOnly, ownedSecurables, grantedPermissions, canDrop }[] (≤ 100), mapped, checked, notChecked }` the database
users mapped to its SID, read one database at a time within `loginLimits.scanMs`; a database not read (the server's total
is read on its own) is counted in `notChecked`, never an error.

**Action progress** (D1c). A long action (the catalogue's `long`: a restore, a verify, a backup) runs its DDL under the long
gate (1 per Varia connection, 2 in all; the next waits up to 30 s, then `BUSY` "Another restore or backup is running on this
connection.", or "Restores or backups are already running on other connections." when the two slots are taken elsewhere; the
execute gate words its two cases the same way), not the execute gate, so a rename on the same connection still runs. Every
action statement runs through a data reader, never `ExecuteNonQuery` (`tests/action-reader-lint.test.ts`), because SqlClient
raises informational messages as they arrive only for a reader; SQL Server's message 3211 ("n percent processed.", from
`STATS`) becomes the running step's percent, and a long action's request sends droppable `{ type: 'action.progress', step,
percent }` EVENTs (`step` is the step's index in the reply, 0 – 519; `percent` 0 – 100): each step's start at once as percent 0,
then its percents at most every 250 ms (`progressEventMs`, on a Stopwatch), a percent held inside the interval going out when it
ends or before the next step's start. A Stop reaches a statement through `ActionService.StatementStop`, never SqlClient's token:
once a statement has sent an informational message (a RESTORE's STATS), SqlClient's cancel from another thread waits until the
statement ends (probed: a restore stopped at 5 % ran to 100 %), while from the reader's own thread it goes out at once, so the
reader cancels at the next message (or, if none comes within a second, the Stop's thread after all), and the job's token is
cancelled off the frame loop (`CancelAsync`), which would otherwise stop reading frames, PINGs included, until then. A
statement whose Stop came before its reader reported the end is listed cancelled, never done: SqlClient now and then ends a
cancelled statement's reader as if it had finished (query batches are handled the same way).
3211 lines are not among the 32 kept messages; the reply's steps carry the last percent each
reached (`progress`). Main checks each EVENT (`actionProgressEventSchema`); an invalid one is dropped, not a protocol failure,
because failing the request would CANCEL a restore part way. It pushes `varia:actions-progress { requestId, step, percent }`
(`actionProgressSchema`) only to the window that sent the request, at most 4 a second per request: a new step at once, and the
latest percent held inside the interval when it ends, never after the request ended (`actionProgressRelay`); the preload's `onActionProgress(listener)` passes on only those three fields and returns its
unsubscribe. The renderer's `ActionProgressService` keeps the latest percent of each request it tracks (at most 128) and fills
the running step's progress bar in a `StepList`. Like `job.progress`, these EVENTs are per request and droppable, not periodic
data (live data flows only through the results port). When a generation closes, the backend's CancelAll stops its long
actions, and its shutdown waits (`DrainCommitted`, beside Create Catalog's) for each to end and run its cleanup steps, within 10 s
plus its cleanup budget.

**Integration Services** (docs/integration-services.md). The SSIS Catalog's tree is Object Explorer's: `explorer.children`
serves the server's Integration Services Catalogs folder (from SQL Server 2016) and the catalog's folders, projects, packages
and environments, whose refs carry `ssisFolder` and `ssisProject` (docs/object-explorer.md). Those listings run on the SSIS
read pool (the program name plus " - Integration Services", Initial Catalog the catalog's database), never the Object
Explorer pool, at READ UNCOMMITTED with `LOCK_TIMEOUT 5000`; packages page by `package_id` (`@kb`), since their names
(≤ 260) can be longer than a sysname cursor key. On SQL Server on Linux, and on Azure SQL Database without a visible
catalog, the folder answers a `NOT_SUPPORTED` value that says why; a catalog node whose database is gone answers
`NOT_FOUND`, one whose database is offline, restoring or single-user in use `DATABASE_UNAVAILABLE` (retryable), and one the
login may not open `NO_DB_ACCESS`. While a catalog node is open, the renderer keeps the tree current through the `ssis.catalog`
live source ([Live subscriptions](#live-subscriptions)): a catalog view whose fingerprint changed reconciles, in the
background, only the listed nodes that show it (docs/integration-services.md, The live tree). The view runs only while the
catalog node shows; one that ends opens again after a back-off (2 s doubling to 60 s), unless it ended `PERMISSION_DENIED`,
`LOGIN_FAILED`, `NOT_SUPPORTED` (the catalog lacks a view or column the probe reads), `INVALID_PARAMS` or `PORT_CLOSED`
(`catalogProbeFinalCodes`): the catalog node then notes why until a refresh of it, of a node in it or of its server (`explorer.refreshed`
names the refreshed node), or until it is closed and opened again. `ssis.describe { connectionId, requestId, view: 'catalog' | 'folder' | 'project' | 'package' | 'environment',
target }` (the target an Object Explorer ref of the view's own SSIS kind; the catalog only by its database's name) answers
`{ model?, revision?, elapsedMs, error? }`: one batch per view on the same pool, READ COMMITTED when the catalog's database
runs RCSI and READ UNCOMMITTED otherwise, read once more after error 601. `model.view` names it: the catalog's profile
(`band`, `cloud`, `hostPlatform`, `auth`: sql, integrated or entra, `rcsi`, `features`, `roles`: `sysadmin`, `admin` for
sysadmin or ssis_admin, and `ssisAdmin` and `ssisLogreader`, read only for logins that are not sysadmin), its folder count and,
for ssis_admin and sysadmin, `properties`; a folder's row and counts; a project's row, packages, parameters and
references; a package's row and parameters; an environment's row and variables. Lists hold at most 2,048 rows and the
answer about 4,000,000 bytes, past which `truncated` is set; values are text of at most 4,000 characters, and a sensitive
parameter or variable never has one. `revision` (64 hex characters) is a SHA-256 of what a later write depends on: names,
descriptions, a project's `object_version_lsn` and last deployment, parameter values, references, variables and catalog
properties, never validation results, counts or the profile, which change without a write; a truncated answer has none,
because it does not cover the rows it left out. The first request on a
connection reads its SSIS profile, cached until disconnect, with the role checks at `LOCK_TIMEOUT 1000` (`IS_MEMBER`
waits on a pending change to a role's members; a sysadmin's are not evaluated). Failures are `result.error` values:
`CATALOG_MISSING`, `NO_DB_ACCESS`, `DATABASE_UNAVAILABLE`, `BLOCKED`, `TIMEOUT`, `PERMISSION_DENIED`, `NOT_FOUND`, `NOT_SUPPORTED` (before 2016,
and on Linux), `CONNECTION_LOST`, `AUTH_KERBEROS`, `AUTH_UNSUPPORTED`, `AUTH_ENTRA` and `SQL_ERROR`. **SSIS cancellation**
works as the object actions' does (`SsisRequests`, `varia:ssis-cancel`, 1–64 ids, 64 tombstones for 60 s; 256 running): main
routes every `ssis.*` method there, the backend sends an attention, and the request answers `CANCELLED`.

**SSIS writes.** `ssis.execute { connectionId, requestId, action: { verb: 'stopOperation', operationId }, revision? }`
(`operationId` 1 to 2^53 − 1; `revision`, 64 lowercase hex characters, only for a verb that takes one, which Stop Operation
does not; the verbs, their steps and the procedures they may call are `ssisActions` in `src/shared/ssis/catalog.ts`) answers
`{ steps: { status: done | failed | skipped | cancelled, message? }[], elapsedMs, error? }`. Its policy is sensitive, so the
frame is zeroed once written, because later verbs carry sensitive values. Before it connects, the backend refuses a server
older than 2016 or on Linux (`NOT_SUPPORTED`) and, for a verb SSISDB refuses to SQL Server logins (error 27123, every verb
that changes the catalog), a connection that signed in with SQL Server authentication to a box server
(`WINDOWS_AUTH_REQUIRED`; Azure SQL Database and Managed Instance excepted). It then takes the SSIS write gates (1 per
connection, 2 in all; 64 registered) and opens a connection of its own: unpooled, never retried, no command timeout,
Initial Catalog the catalog's database, under the program name plus " - Integration Services Actions". There it runs the
verb's preflight at READ COMMITTED with `LOCK_TIMEOUT 10000` (`BLOCKED`) within 25 s (`TIMEOUT`), then its steps in
order, each one constant template from `SsisSql` with values as parameters, waiting for locks as SSMS does
(`LOCK_TIMEOUT -1`), with no outer transaction. Stop Operation's preflight reads `catalog.operations`: no row answers
`NOT_FOUND`, a type other than an execution or validation (200, 300, 301) `NOT_SUPPORTED`, an ended or stopping one
`ALREADY_FINAL` (information, not a failure), and a created execution nobody started (it never runs) `NOT_STARTED` (not
retryable); otherwise `catalog.stop_operation` runs, and when it refuses with 27124 or 27126 the operation is read again:
`ALREADY_FINAL` if it has ended or is stopping meanwhile, `NOT_RUNNING` (retryable) if it is pending, and the catalog's own
refusal, with the step failed, if that second look fails. The catalog's 27123 is `WINDOWS_AUTH_REQUIRED`, and a permission
error `PERMISSION_DENIED` naming the action. A connection lost before the step is sent answers `CONNECTION_LOST` saying
nothing changed; lost during the step, that the outcome is unknown. Stop (CANCEL reason 1 through `varia:ssis-cancel`) ends a write at any time: the backend's protocol host leaves the
answer to the handler (`IRequestDispatcher.AnswersStop`, as for `actions.execute`), which waits up to 10 s for SQL Server to
end the statement and answers `CANCELLED` with the step `cancelled`, or, before any step, "stopped before it changed
anything"; past the grace the outcome is unknown. `catalog.stop_operation` commits its own Stop operation (type 202,
Running) before its transaction, and a cancelled statement never reaches its error path, so Stop during Stop Operation's
step rolls the stop back but may leave that row Running until SQL Server restarts; the `CANCELLED` message says so (SSMS
never cancels the call, so only Varia's Stop leaves it). A disconnect cancels a connection's writes. Nothing is logged.

**Create Catalog** (docs/integration-services.md#create-catalog). `ssis.catalogSetup { connectionId, requestId }` answers
`{ setup?: { catalog, clrEnabled, startupDefault, backupFile, dataFile, logFile }, elapsedMs, error? }` from one read on the
SSIS read pool (in the login's own database), refusing before it connects on Azure SQL Database, Managed Instance and the
explorer catalogue's other cloud editions, on SQL Server before 2016 and on Linux (`NOT_SUPPORTED`), then without sysadmin (`PERMISSION_DENIED`), while the catalog exists
(`CATALOG_EXISTS`), and without the Integration Services catalog backup or a free place for its files (`NOT_SUPPORTED`).
`ssis.execute { connectionId, requestId, action: { verb: 'createCatalog', password, enableClr, startupProcedure } }`
(`password` 1 to 128 UTF-16 code units, no U+0000, no lone surrogate; both booleans required; no `revision`) is the same sensitive write:
its own connection, in `master`, a SQL Server login allowed as in SSMS. Its preflight repeats the setup read and
`RESTORE FILELISTONLY` (within 25 s), answers `CLR_REQUIRED` when CLR integration is off and `enableClr` is false (read from the facts, before anything changes; the steps come only from `SsisCreate.Plan`), then runs
SSMS 22's steps from `SsisCreateSql`'s constant commands (values as parameters; the password reaches SQL only through the
server's own quoting in the master key's `EXEC`): CLR, the restore (never `WITH REPLACE`), the master key, the assembly
trust (the hash read before a statement of its own adds it, so an add cut short is still removed) and `sp_ssis_startup`, and the maintenance job. Stop cancels the running statement (a lock wait included), except the
restore and its switch to read-write, which get 30 s more (`restoreStopMs`) before SQL Server is asked to end them too (a
restore cancelled part way leaves its database restoring, which the removal drops). From the start of the restore the reply,
after the usual 10 s grace, waits up to 120 s more (`createDrainMs`) for the job, after a disconnect too, then answers
`CANCELLED` saying the outcome is not known yet while the job goes on. A step after
the restore that fails or is stopped adds the step "Remove the incomplete catalog" (its message, naming what failed, clipped to
2,048 characters), which ends a transaction the cancelled statement left open and drops what this request made, waiting at
most 30 s for each lock (a database left restoring only while it still is and no other session holds it), as SSMS's
DropCatalog does; when a part of it fails, the message names only what is left to delete; a restore refused because the database appeared (27135) answers `CATALOG_EXISTS` and removes nothing.
Create Catalog is a long run: while it runs the renderer refuses to close the window or quit (`LongRunService.closeRefusal`,
checked by `FileService.closeWindow`, and said in its dialog too), to disconnect its server and to restart a backend that answers, since its unload would cancel the
request, which past the restore is a Stop; main's reload prompt names it (`varia:long-runs`, below). A backend whose stdin ends
anyway (a confirmed reload, a crashed renderer) cancels everything as usual, then
waits up to 120 s (`createDrainMs`) for a Create Catalog past its restore to finish or remove what it made before it exits, and
main, which sees the pending request, waits 130 s (`createCatalogDrainMs`) instead of 2 s before it kills that generation. Only
a kill or crash inside that window leaves an incomplete `SSISDB`, which Create Catalog then refuses (`CATALOG_EXISTS`).
When other dynamic `sp_configure` changes wait for a `RECONFIGURE`, CLR in use or not, both methods answer
`CONFIGURATION_PENDING` (naming them), because enabling CLR runs `RECONFIGURE` and `sys.sp_procoption` (marking the startup
procedure, removing an earlier `sp_ssis_startup`, the removal after a failure) ends with `RECONFIGURE WITH OVERRIDE`; each of
those statements also runs behind a guard in its own batch (`SsisCreateSql.PendingGuard`, error 50000 state 42) that refuses a
change staged after the preflight the same way.

**Activity Monitor session actions** (docs/activity-monitor.md, Session actions) name a session by its id and its login
time, `YYYY-MM-DDTHH:MM:SS[.fffffff]` (server local time, as `sys.dm_exec_sessions` has it, ≤ 40 characters; main checks the form, and the backend also
refuses a time outside `datetime`'s range, 1753-01-01 to 9999-12-31T23:59:59.997, as `INVALID_PARAMS`), since SQL Server
reuses session ids. `activity.details { connectionId, requestId, sessionId: 1–32,767, loginTime, text?: statement |
batch | inputBuffer, locks?: bool }` (not `text` with `locks`) reads on the Activity Monitor's pool (" - Activity Monitor",
READ UNCOMMITTED, LOCK_TIMEOUT 1000) under one live gate, within 10 s in all, and answers `{ sessionId, state: present |
ended | changed | unknown (with `error`), session?, statement?, batch?, inputBuffer?, waits? (≤ 20), transactions? (≤ 50), transactionsTruncated?,
tempdb?, locks? (≤ 1,000, only with `locks`), locksTruncated?, sectionErrors?: { section, code, message }[], readAt?,
elapsedMs, error? }`. `changed` (another session has the id) reads nothing more. Each section is its own statement, so a
permission or a lock that stops one is a `sectionErrors` entry and the others come back; texts are `{ text, chars,
truncated }`, cut at 65,536 characters unless `text` asks for one of them, which then comes back alone, whole up to
1,000,000. Every read checks the statement's columns against its declaration. Closing Details cancels the read
(`ActivityRequests`, `varia:activity-cancel`, 1–16 ids, 64 tombstones for 60 s; 32 running): a CANCEL frame (reason 1),
an attention in SQL Server, `CANCELLED`, and a pooled connection cancelled or broken mid-statement never goes back to its
pool. `activity.kill { connectionId, sessions: { sessionId, loginTime, hostProcessId: int | null }[1..64] }` (distinct ids)
opens the object actions' own connection (" - Object Actions": unpooled, never retried, in master) and runs, per session in
order, one batch (`SET NOCOUNT ON; SET LOCK_TIMEOUT 10000;`, then `ActivitySql`'s kill template) that checks the id is not
its own session's, exists, is a user session, still has the row's login time and host process id, and is not one of this
backend's pool sessions (its host process id, and a program name among the pool names of every connection of this backend,
whatever Application Name each set), and only then runs `KILL`, built on the server from the int
parameter. It answers `{ results: { sessionId, outcome: killed | ended | changed | own | system | varia | denied |
failed, message? (≤ 2,000) }[], elapsedMs, error? }`: SQL Server's refusals map to outcomes (6102 `denied`, 6104 `own`,
6106 `ended`, 6107 `system`), a session not in `results` was not tried, and `error` says why (`CONNECTION_LOST`, `TIMEOUT`
past its 25 s budget, a sign-in failure); a session whose batch was cut off by either is `failed` with an unknown outcome.
Failures the user can act on are values with the live layer's codes (`BLOCKED`, `TIMEOUT`, `PERMISSION_DENIED`,
`CONNECTION_LOST`, `DATABASE_UNAVAILABLE`, `LOGIN_FAILED`, `AUTH_KERBEROS`, `AUTH_ENTRA`, `NOT_SUPPORTED` for a server the
monitor does not serve, `SQL_ERROR`); envelope errors are only `INVALID_PARAMS`, `NOT_CONNECTED`, `BUSY`, `CANCELLED`,
`TIMEOUT` at the header deadline, and `BACKEND_ERROR` for a statement whose columns differ from its declaration (a bug).
Neither logs a session id, login, host, SQL text or message.

**Database Properties** uses the same three methods. `actions.describe { connectionId, requestId, dialog:
'databaseProperties', target: { kind: 'database', name } }` (any database, SQL Server's own included) answers
`{ databaseProperties: { general (with `id`, the database_id, and `created`), options, scoped, compatibilityLevels, collations (≤ 8,192), logins (≤ 1,024), files
(≤ 1,024), filesTruncated, filegroups (≤ 256), filegroupsTruncated, server: { level, sysadmin, filestreamLevel,
pathSeparator, edition, containedAuthentication }, sessions?, readOnlyReason? }, elapsedMs }`, where `options` and
`scoped` map the catalogue's option keys (docs/object-actions.md) to tokens. `actions.script` and `actions.execute` take
`{ action: 'properties', connectionId, requestId, target, closeConnections, changes: { owner?, options?, scoped? }, identity?: { id, created } }`:
only changed values, at least one and at most 512 statements, each key a settable option with one of its tokens (an
integer as plain decimal text in range, a collation name of letters, digits and underscores), and `closeConnections` (the
Open Connections prompt's Yes, `WITH ROLLBACK IMMEDIATE`) only with an option SSMS closes connections for. `identity` is the database the document read (database_id ≥ 1 and create_date as the describe writes it,
`yyyy-MM-ddTHH:mm:ss.fff`): the preflight answers `NOT_FOUND` for a database that has taken the name since (renamed,
dropped or restored meanwhile), before anything runs, for Script too. Script always
writes `WITH NO_WAIT` and answers `database: 'master'`; execute runs one step per statement, titled by the option's label.
Before any statement, execute counts the database's sessions again, as SSMS does when OK is pressed: an option SSMS closes
connections for, without `closeConnections`, while other sessions are in the database answers `IN_USE` with no steps, and
the Database Properties document asks Open Connections. When execute has just closed the backend's own idle pooled connections in the database,
whose sessions SQL Server can still list for a few milliseconds, a count above zero is taken again every 50 ms for up to a
second first. Turning Database Read-Only on with a change SQL Server refuses after it on a read-only database (the owner,
scoped configurations, Target Recovery Time, Delayed Durability, FILESTREAM Non-Transacted Access) answers `NOT_SUPPORTED` before
anything runs, for Script too.
The document's Script drawer previews with `actions.script` only while it is open, one request once typing has paused
for 300 ms, and cancels a preview an edit overtook (`varia:actions-cancel`), so typing never queues requests on the
metadata lane. A script is at most 1,000,000 characters (`scriptChars`, main's query limit). The Open Connections question itself is
main's message box on its own channel, `varia:confirm-open-connections` (no payload, trusted senders only), answering
`true` only for Yes.

**Take Offline and Bring Online** (D3a) use the same three methods too, with no new method. `actions.describe { connectionId,
requestId, dialog: 'takeOffline' | 'bringOnline', target: { kind: 'database', name } }` (a user database) answers `{ databaseState:
{ name, identity: { id, created }, state, userAccess, readOnly, standby, sessions?, withTransaction?, sessionList: [{ sessionId,
login?, program?, host?, openTransactions }] (≤ 8, names clipped to 128), sessionsTruncated, warnings }, elapsedMs }`, read in
master after Take Offline's describe has closed the backend's own idle pooled connections in the database (as execute does
before SET OFFLINE): the counts and the list then include every session left, this backend's query windows too, and are
absent without VIEW SERVER STATE. It answers an `error` value instead where the action cannot run: `NOT_SUPPORTED` with the menu's reason in a
state the catalogue's database rules grey it in (docs/object-actions.md), or for a snapshot; `PERMISSION_DENIED` without ALTER ANY
DATABASE, dbcreator, ownership, or (while it is online) ALTER on the database (`HAS_PERMS_BY_NAME` on the database answers 0 to
a login with no user in it, to sysadmin while another session holds it SINGLE_USER, and on a database that is not online). `actions.script` and `actions.execute` take `{ action: 'takeOffline', connectionId, requestId, target,
dropConnections, identity? }` or `{ action: 'bringOnline', connectionId, requestId, target, identity? }` (`identity` as for
Database Properties; `dropConnections` is Drop All Active Connections, `WITH ROLLBACK IMMEDIATE`, and only Take Offline and Detach take it).
Execute repeats the describe's refusals and runs one step, `Take database offline`, `Close connections and take database
offline` or `Bring database online`; without `dropConnections`, SET OFFLINE waits for other sessions until Stop. Bring Online
adds a message when the database is still SINGLE_USER or RESTRICTED_USER, read under a 5 s budget of its own after SET ONLINE
completed (left out if it cannot be read, so a late Stop never turns the success into `CANCELLED`). SQL Server's error 5011 (no ALTER on the database)
answers `PERMISSION_DENIED`.

**Detach Database** (D3b) uses the same three methods, with no new method. `actions.describe { …, dialog: 'detachDatabase',
target: { kind: 'database', name } }` (a user database, SQL Server only: Azure SQL Database and Managed Instance answer
`NOT_SUPPORTED` before any connection opens) answers the same `databaseState` as Take Offline's, read after closing the
backend's own idle pooled connections in it, plus `files: [{ fileId, name, type: 'rows' | 'log' | 'filestream', path }]`
(≤ 256 files, `detachFiles`; names clipped to 128 and paths to 260, `filePath`; from `sys.database_files` in an online database
when `sys.master_files` shows none, and empty with a note when neither does), `filesTruncated`, and `confirmOffline: true`
for a database that is not online (OFFLINE, EMERGENCY) on Windows. A login that is neither sysadmin nor in the database's
db_owner role gets `PERMISSION_DENIED` from the describe and the execute. Its
`warnings` are blocking for what makes `sp_detach_db` fail (replication, a database snapshot of it, an availability group,
mirroring); on Linux a database that is not online adds a non-blocking note instead of `confirmOffline`, and on Windows a
SQL Server login adds one about the files' access. `actions.script` and
`actions.execute` take `{ action: 'detach', connectionId, requestId, target, dropConnections, updateStatistics,
detachOffline?, identity? }` (both booleans required; `detachOffline` only for a database that is not online on Windows, which
execute refuses as `NOT_SUPPORTED` without it; execute also refuses `updateStatistics: true` for a database that is not online,
read-only or in standby; `updateStatistics` and `detachOffline` are refused on every other action). Execute
repeats the describe's refusals and runs `Close existing connections` (`SET SINGLE_USER WITH ROLLBACK IMMEDIATE`, only with
`dropConnections`) and `Detach the database` (`sp_detach_db @dbname, @skipchecks`, `'false'` when Update Statistics is
checked); when the detach fails or is stopped after SINGLE_USER, a compensation step gives the database back the access it
had (`Restore multi-user access` or `Restore restricted user access`, `compensates: true`). A detach step that failed or was
stopped while SQL Server detached the database anyway (gone from `sys.databases`) is `done`, with SQL Server's error in
`messages`. Once `Detach the database` is
done, the result carries `filesKept`, the files read before it (≤ 256), and the backend forgets its pooled connections to the
database. SQL Server's error 3703 (in use) answers `IN_USE` with the advice to close its connections or check Drop
Connections, 3709 (a snapshot of it) `DEPENDENTS`, 3707 (suspect or recovery pending) `NOT_SUPPORTED`, and 7983 (DBCC DETACHDB without
db_owner) `PERMISSION_DENIED`. When Update
Statistics is cleared, Script adds a comment line, because SSMS's script leaves `@skipchecks` out.

**Rename of a database** (D3c) uses the same methods too. Before it renames, the page sends `actions.describe { connectionId,
requestId, dialog: 'renameDatabase', target: { kind: 'database', name } }` (a fact describe: no dialog opens), which answers
`{ renameDatabase: { name, identity: { id, created }, userAccess, sessions?, withTransaction?, loginsDefaulting, canClose,
connections }, elapsedMs }`, read in master after the backend's own idle pooled connections in the database were closed (the
counts are absent without VIEW SERVER STATE; `loginsDefaulting` counts the logins whose default database it is; `canClose` is
false on Managed Instance, which cannot set SINGLE_USER, and for a database already in single-user mode; `connections` lists the
backend's connections to the same server by `SERVERPROPERTY('ServerName')`, this one first, at most 64, so the page counts and
moves the query windows of a connection opened under another name for the same instance), or an `error` value where the rename
cannot run: `NOT_SUPPORTED` for a database that is not online, read-only or standby (902), in an availability group, or on
Managed Instance with `closeConnections`; `IN_USE` for a single-user database another session is in (MODIFY NAME would fail
with 924, and SET SINGLE_USER would wait for it); `PERMISSION_DENIED` without CONTROL SERVER, ownership or ALTER on the
database; `NAME_IN_USE`; `NOT_FOUND` for an identity that changed. The page sends the describe under the rename's own
`requestId`, so the status bar's Stop cancels it (`cancelObjectActions`) before anything runs, and the execute that follows the
describe (and the prompt) reuses that id once the describe has answered. The rename itself is
`actions.execute { action: 'rename', connectionId, requestId, target, newName, closeConnections?, identity? }` (both only for a
database; `identity` as for Database Properties). `closeConnections` runs `Close existing connections` (SINGLE_USER WITH
ROLLBACK IMMEDIATE, unless the database is already single-user), `Rename` and `Restore multi-user access` (or `Restore
restricted user access`); a failure or Stop after the first step runs a compensating step restoring the access under whichever
name the database then has. Without it, `Rename` alone waits for other sessions until Stop: where SQL Server refuses MODIFY NAME
at once as in use (5030) rather than queueing it, the backend tries it again each second until it completes or Stop. Once MODIFY
NAME has completed, the reply carries `identity: { id, created }`, the database's identity under the new name, read in the action's
connection just after (SQL Server gives a renamed database a new `create_date`); it is absent when it cannot be read within 5 s or
the name now belongs to another database. Database Properties documents that follow the rename send it with their Apply.

**Login actions** use the same three methods, with no new method. `actions.describe { connectionId, requestId, dialog:
'loginFacts', target: { kind: 'login', name } }` runs the login preflight in the action's own connection, under READ UNCOMMITTED (its facts only advise; another
session's open change to the login would otherwise hold the read until its lock timeout), and answers
`{ login: { principalId, type, subtype, disabled, connectDenied, own, sysadmin, sessions, canAlter, canControlServer, …,
service?: ≤ 256 }, elapsedMs }`, `service` naming the SQL Server service that runs as a Windows login (from
`sys.dm_server_services`, read only where VIEW SERVER STATE allows it, else from an `NT SERVICE\` name); a missing login is
`error: NOT_FOUND`. The catalogue's `describes` block maps each such id to its kind and the action whose permissions it
checks. `actions.script` and `actions.execute` take `{ action: 'disable' | 'enable', connectionId, requestId, target: { kind:
'login', name }, loginIdentity?: { sid: ^[0-9A-F]{2,172}$, created: yyyy-MM-ddTHH:mm:ss.fff } }` (strict: no other member) or
a login's `rename` with `newName` (no `loginIdentity`). `loginIdentity` is the login the describe read; the preflight refuses
a principal with another SID or creation time (`NOT_FOUND`, "…is not the one that was read…") before any DDL, so a
confirmation is never applied to a login that has taken the name since. The describe's other facts stay advisory (read
past open changes). Disable, Enable and Rename's preflight (`ActionSql.LoginAlter`) seeks only the login's own rows and
leaves out the owned counts, which would scan every principal under READ COMMITTED and wait behind any other session's
open change to one; the describe and Delete's preflight read them. They run in master, Script answers
`database: 'master'`, and execute answers `sessions`, the count of sessions connected as the login that the preflight read.
The backend re-derives the subtype from the name the catalog holds (the server collation also finds `##x## ` and a fullwidth
spelling of `##x##`) and refuses by `LoginRules` before any DDL, which then names that principal: SQL Server's own logins
(`##…##`, trailing spaces ignored; zod and `Validate` refuse such a target name as `INVALID_PARAMS` too) for every action,
the connection's own login, a SQL Server login's name with a backslash (`NOT_SUPPORTED`) and a name another login or
server role holds (`NAME_IN_USE`). A login's `newName` in the `##…##` form is `INVALID_PARAMS` (zod and `Validate`).
A login's `delete` (D4c) takes `dropMappedUsers?: boolean` and `loginIdentity` (both refused on any other kind, and
`dropMappedUsers` on any other action; `loginIdentity` required on `actions.execute`, by zod's `actionExecuteRequestSchema`
and `Validate`, optional on `actions.script`), with `closeConnections` and `deleteHistory` absent or false. Its execute
reads the login again under READ COMMITTED (identity and rules), then what blocks the DROP past open changes: sessions
answer `IN_USE`, owned databases, Agent jobs, server roles, endpoints and availability groups, and granted server
permissions `DEPENDENTS` (15173 maps there too); with `dropMappedUsers`, sessions it cannot count are `NOT_SUPPORTED`, a
database its scan could not read again `BLOCKED`, and more mapped users than it lists `NOT_SUPPORTED`, all before any DDL.
It then runs `Drop the database user` per droppable user (each step's `detail` is `user in database`) and `Drop the
login`, not in one transaction. Each DROP's batch checks the principal it was planned for (`PrincipalBinding`: the user by
name and the login's SID, the login by SID, principal id and creation time) before the DROP and again after it in one
transaction; a mismatch (50010) is `NOT_FOUND` and drops nothing. A 15434 from SQL Server (a session the preflight could
not count) is `IN_USE` with advice to end it.

**Unlock Login** (D4d) uses them too. `actions.describe { …, dialog: 'unlockLogin', target: { kind: 'login', name } }` reads the
login's facts as Disable's preflight does (`ActionSql.LoginAlter`, READ COMMITTED) and then its lock-out state with
`ActionSql.LoginLock`, the only statement that may call `LOGINPROPERTY` (for `IsLocked`, `BadPasswordCount`, `LockoutTime`,
`IsMustChange`, `IsExpired` and `DaysUntilExpiration` only, which its own lint and the catalogue's `logins.lockProperties`
check), and answers `{ login, lock: { locked, badPasswords?, lockoutTime? (the server's clock, while locked), mustChange,
expired, daysUntilExpiration? }, elapsedMs }`. `LOGINPROPERTY` waits for another session's open change to the login whatever
the isolation level, so behind one the describe answers `BLOCKED` after the read lock timeout (10 s). `actions.script` and
`actions.execute` take `{ action: 'unlock', connectionId, requestId, target: { kind: 'login', name }, mode: 'keepPassword',
loginIdentity? }` (strict; no password crosses: Unlock's other choice, Set a new password…, sends nothing itself and opens Login
Properties, whose `loginProperties` request carries the new password with `unlock: true`). The preflight applies the
login rules and the identity, reads the lock-out state again, and refuses before any DDL a login that is not a SQL Server login
enforcing the password policy, one that must change its password (SQL Server would answer 15128, `NOT_SUPPORTED`) and, for
execute only, one that is not locked out (`NOT_SUPPORTED`). Execute then runs `ALTER LOGIN … WITH CHECK_POLICY = OFF` and
`… = ON` (with `CHECK_EXPIRATION = ON` when the login had it) through runner v2's transaction mode: steps "Turn off the password
policy", "Turn the password policy back on" (or "… and expiration back on") and "Commit", rolled back on a failure or Stop
(a step that had completed is then `rolledBack`). Catalog reads and `LOGINPROPERTY` hold no lock on the login, so the first step
reads its facts and lock-out state again inside the transaction and, before its statement, answers the refusal itself (no
rollback sentence, since nothing changed) when the login is gone, replaced or refused, is no longer locked out, or another session
changed its policy or expiration since the preflight (`NOT_SUPPORTED`, the catalogue's `unlockChanged`).
Script answers the same statements as one `SET XACT_ABORT ON; BEGIN TRANSACTION; … COMMIT TRANSACTION;` batch in master.

**Object action confirmations** (A13) are main's message boxes too, on one channel, `varia:confirm-action` (trusted senders
only): the page sends `{ prompt, facts }`, a strict zod union (`actionPromptRequestSchema` in
`src/shared/actions/prompts.ts`): `renameDatabase { database: 1–128, sessions?: 0–1,000,000, transactions, tabs (the same
range), tabsWithTransactions: ≤ 8 names of ≤ 260, canClose }` or `disableLogin { login: 1–128, sessions?, service?: ≤ 256,
sysadmin, connections?: 1–8 names of ≤ 260 UTF-16 units (Varia's other connections that sign in as the login, cut with … by the page) }`. Main writes the box from that catalogue (names through `displayText`, so none can add lines or hide
characters), shows it as the page's abortable dialog, and answers with the chosen button's id (`closeAndRename`,
`renameWhenFree`, `disable`, or `cancel`, which Escape, a closed box and a reload or crash also answer). The page can
neither word a prompt nor choose its default button. No backend method is involved.

**Long runs** (`src/shared/long-runs.ts`): whenever its long runs change, the page sends main
`varia:long-runs { runs: [{ kind, server: 1–256 }] (≤ 16), total: 0–1,000,000 ≥ runs }` (strict; trusted senders only;
answers nothing), and main's reload prompt then names the first run ("Create Catalog is running on <server>: reloading
stops it part way.", or "…, with N more runs: reloading stops them part way.") before what AutoRecover keeps; so does the
Restart SQL Backend prompt ("…: restarting the backend stops it part way."), which the page lets a long run reach only while
the backend does not answer (a run on a hung backend cannot stop). A reload or crash resets it. The refusals themselves are
the renderer's (`LongRunService`); main's 130 s drain of a stopping backend stays the last resort.

The **Table Designer** uses the same three methods too, with no new method (so no new entry in the five places a method is
declared). `actions.describe { connectionId, requestId, dialog: 'tableDesigner', target: { kind: 'database', name } }` (any
database, SQL Server's own included) answers `{ tableDesigner: { database, band, schemas (≤ 2,048, sys and
INFORMATION_SCHEMA left out, dbo always among them when it exists), schemasTruncated, defaultSchema, defaultFilegroup,
caseSensitiveNames, accentSensitiveNames (how the catalog collation compares column names), canCreate? }, elapsedMs }`.
`actions.script` and `actions.execute` take `{ action: 'createTable', connectionId, requestId, target: { kind: 'database',
name }, design: { schema, name, columns: [{ name, type: { system, length?, max?, precision?, scale?, dimensions? },
allowNulls, identity?: { seed, increment } }] (1 to 1,024), primaryKey: [column index] (≤ 32) } }`, strict at every level
and checked by `designProblems` in main and `TableDesignValidator` in the backend (docs/table-designer.md): a table name
that starts with `#` (a temporary table) and column names that differ only in trailing spaces are INVALID_PARAMS, and
seeds and increments match their pattern up to the end of the text (.NET's `\z`, never `$`, which also matches before a
final line break). Script answers
SSMS's change script (at most 1,000,000 characters, `designerLimits.scriptChars`) with `database` the target and, as
warnings, what Save would refuse (a missing schema, a taken name); it runs nothing. Execute refuses those before any DDL,
then runs CREATE TABLE, the primary key and `SET (LOCK_ESCALATION = TABLE)` in one transaction, one step each, and
`Commit`; a failure or Stop rolls back and its message ends "SQL Server rolled back the transaction; the table was not
created." (a Stop during a statement marks that step `cancelled` and the rest `skipped`; one during the preflight answers
with no steps). The design reaches SQL Server only as one `nvarchar(max)` JSON parameter, which constant builder batches shred
with OPENJSON (master needs compatibility level 130, else `NOT_SUPPORTED`). The largest design is far below the 4 MiB
request body.

**New Database** (D1b) uses the same three methods, again with no new method. `actions.describe { connectionId, requestId,
dialog: 'newDatabase', target: { kind: 'server' } }` (only a server target; SQL Server only, `NOT_SUPPORTED` on Azure SQL
Database and Managed Instance) answers `{ newDatabase: { model (model as `databaseProperties` describes it), dataPath, logPath,
serverCollation, canCreate, masterLevel, linux }, elapsedMs }`, read in master. `actions.script` and `actions.execute` take
`{ action: 'createDatabase', connectionId, requestId, target: { kind: 'database', name }, design: { owner?, files: [{ name,
type: 'rows' | 'log' | 'filestream', filegroup?, sizeMb?, growth, path, fileName }] (2 to 256), filegroups: [{ name, type:
'rows' | 'filestream' | 'memoryOptimized', readOnly?, isDefault?, autogrowAllFiles? }] (PRIMARY first, 1 to 256), collation?,
containment: 'NONE' | 'PARTIAL', ledger?, options, scoped } }`, strict at every level (the design is read as the action's own
type, so a table design's members are refused) and checked by `newDatabaseProblems` in main and `NewDatabaseValidator` in
the backend: sizes are whole MB (data 1 – 16,777,215, 2,147,483,647 pages; log 1 – 2,097,152), growth 1 – 2,097,152 MB or
1 – 100 %, a maximum no smaller than the size and, in MB, no smaller than the growth (SQL Server's 5169), file names the
server's platform allows (no `\` on Linux either, which SQL Server there reads as a separator), distinct names and paths, every filegroup with a file, and
options only those Database Properties sets but collation and containment, which CREATE DATABASE writes. Script answers
CREATE DATABASE as SSMS lays it out, then Database Properties' ALTER statements, with `database: 'master'` and, as warnings,
what OK would refuse; it runs nothing. Execute refuses those first (`NAME_IN_USE` for a database or file that exists,
`PATH_NOT_FOUND` for a missing folder from SQL Server 2017, `NOT_FOUND` for an owner or collation, `PERMISSION_DENIED`
without CREATE DATABASE), then runs "Create the database", each option's step, the filegroup steps and "Set the owner"; it
never compensates, so a later failure leaves the database created and says so. The design reaches SQL Server only as one
JSON parameter; a constant builder (`CreateDatabaseSql`, checked by its own `Lint` with the table designer's OPENJSON rules in
`JsonBuilderLint`) shreds it with OPENJSON, quotes names with `QUOTENAME` and file names and paths on the server (`REPLACE`
under a binary collation), writes sizes as typed numbers with a unit (KB up to 2,097,151 MB, since SQL Server reads a size as
an int, and MB above), takes the collation only as
`sys.fn_helpcollations()` names it, and runs the statement through `QUOTENAME(@db) + N'.sys.sp_executesql'` in master. It
is a long run (`LongRunService`, kind `newDatabase`).

The **server file picker** (Locate Backup File, Locate Database Files, Locate Folder) is `actions.describe` too, again with
no new method: `{ connectionId, requestId, dialog: 'serverFiles', target: { kind: 'server' }, files: { purpose: 'backup' |
'database' | 'log' | 'folder', path?, allFiles?, exists? } }` (`files` only with that dialog, `allFiles` never with `folder`,
`exists` only with a path and no `allFiles`; a path
is `serverPathSchema` in `src/shared/actions/schema.ts` and `ServerPath.Valid` in C#: 1 – 260 UTF-16 code units, well formed,
no control characters or `*?"<>|`, a drive, a share or `/`). It answers `{ serverFiles: { separator, path?, roots: [{ path,
kind: 'drive' | 'folder', defaults?: ('data' | 'log' | 'backup')[], freeMb? }], entries: [{ name, directory, sizeBytes?,
modified? }] (≤ 2,000, folders first), truncated, notice?: 'legacyEmpty' }, elapsedMs }`: with no path the drives (`/` on
Linux) and default folders, else one level of the folder, typed with the server's separator. With `exists` it checks the
path itself, for a typed name a listing does not show (past its limit or outside the type filter): `path` is the path
checked and `entries` its own entry, or none (`legacyEmpty` when SQL Server 2016 will not tell a login outside sysadmin).
Its deadline is a function of the request (`methodPolicies`), 15 s instead of 45 s. Listings run under a gate of their
own, one per connection (`browsePerConnection`), outside the describe and script gates: SQL Server honours the attention
only once a file-system call returns (about 21 s for an unreachable share), so a listing past its budget keeps its gate
until then, and the picker runs one listing at a time and cancels those it no longer needs. A missing folder, a file or
another platform's path is `PATH_NOT_FOUND`; Azure SQL Database and Managed Instance are `NOT_SUPPORTED` before any
connection opens.

**Attach Databases** adds no method either. Its describe is `{ dialog: 'attachDatabase', target: { kind: 'server' },
attach?: { mdf } }` (`attach` only with that dialog; `mdf` a server path as above): without `attach` it answers
`{ attachDatabase: { server: { logins (≤ 1,024), loginsTruncated, separator, dataPath? } } }`, and with it also
`database: { mdf, databaseName, version?, files: [{ original, type: 'data' | 'log', current, found? }] (≤ 1,000, by file
id) }`, read with `DBCC CHECKPRIMARYFILE (@mdf, n)` (the path bound, never spliced) and each file checked as the picker's
`exists` checks one (`found` absent where SQL Server 2016 will not say, and for a share or device path the file records,
which is never probed). It runs on the picker's gate and the describe budget. A file that is not primary, or a database
newer than master's version, is `NOT_SUPPORTED`; one SQL Server cannot open is `FILE_ACCESS` (5120, 5123), a login outside
sysadmin `PERMISSION_DENIED` (2571). Its `actions.script` and `actions.execute` are `{ action: 'attach', target: { kind:
'server' }, databases: [{ name, owner?, files: path[] (1 – 1,000, none twice), rebuildLog }] (1 – 16, no name twice) }`.
Execute checks every database first (name free, owner's login present, CREATE ANY DATABASE, master at compatibility level
130 or more, the primary file no newer than the server), then runs, per
database, `Attach the database` (a builder batch: SQL Server builds `CREATE DATABASE … FOR ATTACH[_REBUILD_LOG]` from the
name through `QUOTENAME` and one JSON array of paths, each quoted on the server) and, with an owner, `Set the database
owner`; each step's `detail` is its database's name. After a failure or Stop, `Detach the database again` steps
(`compensates: true`) detach, newest first, what this request attached (an attach Stop reached counts when a database of its
name has its primary file), within the cleanup budget. Attach is a long run:
the renderer registers it while the request is in flight.
docs/object-actions.md lists the statements by version.

Restore Database reads through `actions.describe` as well, with no new method: `{ connectionId, requestId, dialog:
'restoreDatabase', target: { kind: 'server' }, restore: { kind: 'history', database? } | { kind: 'devices', devices } |
{ kind: 'historyFiles', setId } | { kind: 'mediaFiles', devices, file } }` (`restore` only with that dialog; 1 – 64 devices,
each a server path as above). It answers `{ restore: { server?, historyDatabases?, sets?, files?, …Truncated }, elapsedMs }`:
msdb's history, `RESTORE LABELONLY` and `HEADERONLY` on the files, or one set's files (msdb's `backupfile` or
`RESTORE FILELISTONLY`). Reading media can take long on a large striped set or a slow share, so its deadline is a function
of the request too: 130 s around the backend's 120 s budget (`restoreLimits`), and these reads run 2 per connection under
their own gate, outside the object actions' read gates, so a read held past its budget by an unreachable share never delays
another dialog's describe. `actions.script` with the `restore` action takes the plan (`restore: { sets, relocate, recovery,
… }`, at most 1,024 sets and 1,000 moves), is written on no connection, and answers the script SMO's restore plan would
write (at most 4,000,000 characters, checked as it is written). `actions.execute` with `restore` (D1f) takes the same plan with
`target: { kind: 'database', name }` and, over a database that exists, the `identity` the document read; it is a long action
(the long gate, Stop, `action.progress` from `STATS`, the shutdown drain, a 30 s cleanup budget). Its preflight in the action's
connection checks the identity, permission, the tail-log backup's conditions, the media's chain (`RestoreChain`), WITH REPLACE's
case (`BACKUP_MISMATCH`), Close existing connections over a database that is not online (`DATABASE_UNAVAILABLE`) and the
files it writes (`NAME_IN_USE`: another database's file, a file already on disk that is not the destination's, a standby or
tail-log file over a database file), before anything changes; the reply adds `restored` (sys.databases, read once the steps are
over) so the page names what a Stop or failure left: `{ state, userAccess }`, or `{ absent: true, filesLeft?, filesUnknown? }`
when no database has the name (`filesLeft`, at most 16 paths, are files SQL Server left on disk after a cancelled RESTORE whose
partly restored database Varia dropped; `filesUnknown` when their existence could not be checked), and no `restored` when
the read failed.
Restore Files and Filegroups (D1g) uses the same describes, where a set's file may carry `absent: true` (a file backup does not
hold it), and the action `restoreFiles` in `actions.script` and `actions.execute`: `{ target: { kind: 'database', name }, identity,
restoreFiles: { sets, files, filegroups, relocate, replace, restrictedUser, recovery, standbyFile?, logBackup?: { file } } }` (a full
or file backup then its logs, at most 1,024 sets; at most 256 files and 256 filegroups, at least one of them; 1,000 moves; and at
most 2,100 parameters in its RESTORE DATABASE; the identity is required, since the database must exist). It is a long action as
Restore Database is; its preflight adds the files variant of the chain, that the backups are the database's own, that each file
and filegroup is in the set and held by it (`NOT_FOUND`), SIMPLE's read-only rule, STANDBY over an online database, a log
backup under SIMPLE and a PRIMARY file of an online or offline database (`NOT_SUPPORTED`), a plan that does not reach the
database's log chain (`RESTORE_SEQUENCE`: a log backup taken after its last set, named from msdb where it can be read), a log
backup of a database that is not online (`DATABASE_UNAVAILABLE`), and a log backup file already on the server (`NAME_IN_USE`).
Its "Back up the log" step reads the log chain again and fails with `RESTORE_SEQUENCE` when a log backup was taken during the run. Its `restored` adds `filesRestoring` (logical names, at most 16): the database's files left
RESTORING.
docs/object-actions.md describes the planner, the steps and the limits.

**New Login** (D2a, D2b) uses the same three methods. `actions.describe` with `dialog: 'newLogin'` and the server as target
answers `{ newLogin }` (databases, each `{ name, state, accessible, readOnly }`, languages, server roles, master's certificates and
asymmetric keys (≤ 1,024 each), credentials `{ name, provider? }` (≤ 1,024), and the server's facts, `engine` among them: `box` or
`managedInstance`, D2e); with `dialog: 'loginDatabaseRoles'` and
`target: { kind: 'database', name }` it answers User Mapping's read of that database, `{ loginDatabaseRoles: { roles (≤ 256),
rolesTruncated, guest, schemas (≤ 1,024), schemasTruncated } }`, or `NOT_FOUND` and `DATABASE_UNAVAILABLE` (offline, closed or
read-only) values.
With `dialog: 'windowsPrincipal'` and `target: { kind: 'login', name }` (a `DOMAIN\name`, nothing else; D2e Check Names) it answers
`{ windowsPrincipal: { accountName (the name as typed: xp_logininfo echoes it), access, type? ('user' | 'group'), via? } }` from
xp_logininfo, or `NOT_FOUND` (15404 with Windows' 0x534), `SQL_ERROR` (any other 15404: the server could not look the account up)
and `PERMISSION_DENIED` (229) values; off SQL Server it is `NOT_SUPPORTED` before any connection.
`actions.script` and `actions.execute` take `{ action: 'createLogin', login, serverRoles, status, mappings }`, where `login` is
`{ auth, name, defaultDatabase?, defaultLanguage?, checkPolicy?, checkExpiration?, mustChange?, certificate?, asymmetricKey?,
credentials? }`: `auth` is `windows`, `sql`, `entra`, `certificate` or `asymmetricKey` (D2e), the defaults exactly for the first
three, the policy options all or none for `sql` (none on Managed Instance, all on SQL Server) and never for the others,
`certificate` and `asymmetricKey` exactly for their kind, and `credentials` at most 16 distinct names, never for `entra`;
`mappings` is at most 256 `{ database, user, defaultSchema?, rolesAdd (≤ 256, never public) }`, one per database (no
`defaultSchema` for a certificate or key login), and the whole plan at most 512 statements; only execute carries `secrets`. The
backend re-validates all of it, and refuses a kind or policy options the server's engine does not take (`NOT_SUPPORTED`) before it
connects.

**Login Properties** (D2c) too. `actions.describe { …, dialog: 'loginProperties', target: { kind: 'login', name } }` answers
`{ login, lock? (a SQL Server login's, as unlockLogin's), newLogin (New Login's lists), loginProperties: { defaultDatabase,
defaultLanguage, serverRoles (≤ 256), serverRolesTruncated, users: [{ database, user, defaultSchema?, owner }], read, credentials
(≤ 1,024), credentialsTruncated, certificate?, asymmetricKey? } }` (D2e: the credentials mapped to the login, and a certificate or
key login's certificate or key), where
`read` names the databases Delete's per-database scan read within its budget (the others are "Not read" on User Mapping).
`loginDatabaseRoles` takes an optional `login` (a name, ≤ 128; no other describe takes it), and then also answers that login's
`user? { name, defaultSchema?, owner }` there and the database roles it is a member of (`memberOf`). `actions.script` and
`actions.execute` take `{ action: 'loginProperties', connectionId, requestId, target: { kind: 'login', name }, loginIdentity?,
loginChanges, secrets? }` (strict), where `loginChanges` holds only what changed: `defaultDatabase?`, `defaultLanguage?`,
`checkPolicy?`, `checkExpiration?`, `password? { oldPassword, unlock, mustChange }` (the old password never with UNLOCK or
MUST_CHANGE), `rolesAdd?`/`rolesDrop?` (≤ 256 server roles each, distinct, never public, never both), `mappings?` (≤ 256
`{ database, change: 'map' | 'unmap' | 'update', user, newName?, defaultSchema?, rolesAdd?, rolesDrop? }`, one per database),
`credentialsAdd?`/`credentialsDrop?` (D2e: ≤ 16 credentials each, distinct, never both; never for a Microsoft Entra login),
`connect? ('grant' | 'deny')` and `enabled?`; between 1 and 512 statements. Execute needs `loginIdentity` and carries
`secrets: { password, oldPassword? }` exactly when `password` is set (`oldPassword` exactly when `password.oldPassword`); script
refuses `secrets`. Its steps run one by one without a transaction (critic A24); after a completed step a failure's message starts
"The login was changed only in part", and 15151 is `PERMISSION_DENIED` with "Check the old password." when the password step
failed with an old one.

**Securables** (D2d) adds to both. New Login's describe also answers `newLogin.securables: { server, permissions: { server,
endpoint, login, serverRole, availabilityGroup }, objects: { endpoint, login, serverRole, availabilityGroup } (≤ 1,024 names each),
truncated }`, the permissions being the catalogue's (`src/shared/actions/securables.ts`) that the server's `sys.fn_builtin_permissions`
lists. Login Properties' `loginProperties` adds `permissions` (≤ 1,024 `{ securable: { type, name? }, permission, state: 'grant' |
'withGrant' | 'deny', grantor }`, none for SQL Server's own logins) and `permissionsTruncated`. `createLogin` takes an optional
`permissions` and `loginChanges` an optional `permissions`: at most 512 `{ securable: { type, name? (1–128, exactly when the type
is not server) }, permission (one of its type's in the catalogue, never CONNECT SQL), state, cascade? }`, each securable's
permission once; `state` is `grant`, `withGrant` or `deny` for a new login, and also `revoke` or `revokeGrantOption` for Login
Properties, and `cascade: true` goes only with `deny` or `revoke`. Each counts as one statement against the 512. The Effective tab
is `actions.describe { …, dialog: 'loginEffectivePermissions', target: { kind: 'login', name }, securable: { type, name? } }` (no
other describe takes `securable`; never a `##…##` login, whose page is hidden), answering `{ effectivePermissions: { permissions (≤ 256), truncated } }`, `PERMISSION_DENIED`
when SQL Server refuses EXECUTE AS LOGIN (15406, 15517, 15151), `NOT_SUPPORTED` for a login SQL Server cannot impersonate (a group, or one
mapped to a certificate or an asymmetric key) and `NOT_FOUND` when the login is gone. A Login Properties permission step that SQL Server
runs without changing what was asked (another grantor's row left in place, or 4624 for sa, the connection's own login or the securable's
owner) fails as `NOT_SUPPORTED`, and a request with permissions for sa or the connection's own login is refused before anything runs.

## Streams and credits

`results.read { resultId: u32 ≥ 1, firstRow: 0 … 2⁵³ − 1, maxRows: 1 … 65,536 }` sends a DATA frame for every sealed page
overlapping `[firstRow, firstRow + maxRows)`, then the RESPONSE `{ nextRow, rowsAvailable, complete, pages, rows }`. Rows
still in the open page builder are not served; the worker reads again after a progress event. An unknown id is
`RESULT_NOT_FOUND`, a released one `RESULT_RELEASED`.

- **Credit counts DATA body bytes per stream.** The REQUEST's `credit` (clamped to 64 KiB – 16 MiB; the worker asks for
  4 MiB) is the initial grant.
- **Producer rule.** The backend may send a page whenever its credit is above 0, subtracting the body length, so credit
  goes negative by at most one page and a large page never deadlocks. Waiting for credit is a signal, not a poll.
- **Main's accounting.** Per stream, main tracks granted minus received and the expected sequence number. A page at
  credit ≤ 0, a sequence gap, or DATA for a request that is not a stream fails that stream (`STREAM_PROTOCOL`).
- **Who grants.** The worker grants a page's length after it has decoded and cached the page. Main relays CREDIT after
  clamping to 16 MiB outstanding per stream and 64 MiB per port; what the clamp holds back is passed on as soon as
  pages arrive or other streams end, because the worker grants only when a page arrives and a stream left without
  credit would otherwise stall. A slow or hung renderer therefore stalls its reads, never the query or SQL Server.
- Query events have no credit; they are bounded where they are produced. Live subscriptions are the one exception: their
  EVENTs are credited, one at a time ([Live subscriptions](#live-subscriptions)).

## Execution plan viewer

`plans.parse` accepts `{ xml }` from the renderer, at most 8,388,608 characters. Only main creates the wire form
`{ xml: <base64 gzip>, encoding: 'gzip' }`: asynchronous compression, at most two preparations at once, and at most
2,097,152 compressed bytes. Renderer validation rejects the encoding field. Protocol v2's frame limits are unchanged.
The backend streams decompressed UTF-8 through `XmlReader`, with DTDs and external entities prohibited, a character
limit and a 256-level depth limit. No SQL executes and no input or plan text is logged.

The response is a normalized document: version/build, ordered statements, and each statement's operators with stable
document-local IDs, parent IDs, SQL Server node IDs, operation names, object names, estimates, runtime counters,
warnings and bounded properties. Source NodeId values alone are not identities: they repeat across statements.
Parallel runtime rows, CPU and executions sum; elapsed time takes the maximum thread value. Missing counters stay
absent (the renderer's schema normalizes them to null), rather than becoming zero. Unknown operators remain visible.
Raw runtime properties include the thread identity. Repeated properties that cannot be retained are explicitly reported.
The parser permits at most 512 statements and 10,000 operators, 64 properties per operator, 1,048,576 characters of
SQL/property text, and a 12 MiB serialized response. Essential operator labels, objects and warnings keep separate
per-field caps so verbose earlier properties cannot erase them. Shortened text/properties produce an explicit notice; malformed,
oversized or overdeep documents fail with bounded, input-independent errors. Original XML is unchanged.

The renderer holds parsed models only while the viewer is mounted. A viewer combines up to 64 source documents,
16,777,216 input characters, 512 statements and 10,000 operators. Query plans are read on demand through their existing
result handles; releases and backend generation changes invalidate those sources. Existing result-cell truncation
remains in effect, and a truncated plan is never drawn as a complete graph. `.sqlplan` documents retain their text
models for editing, Save and AutoRecover, with Graph and XML source views. Plan files use their own 16 MiB byte and
8,388,608-character limits; ordinary SQL files keep their existing limits. A failed plan source is reported separately
so other valid plans in the run remain usable.

`elkjs` runs in a dedicated, cancellable module worker (20 s layout bound), independent of the results worker. A batch
has one PixiJS WebGL canvas and camera. Static spatial indices cull cards and connecting edges; zoom controls label
detail. Drawing is on demand, at most once per animation frame, and pauses while hidden. Pixi's interpreter extension
supports the existing strict CSP without adding unsafe-eval. Canvas resources and workers are destroyed on unmount;
only the last 64 small navigation states are retained. A virtualized DOM operator outline supplies keyboard and
screen-reader navigation and properties when GPU rendering is unavailable. Forced-colors mode uses the DOM views.
Capture controls, live subscriptions and client statistics are outside this viewer increment.

## Query execution

`query.execute` takes `{ connectionId, sessionId, database, sql, queryId, maxRows, timeoutSeconds, startLine?,
maxResultSets?, stopOnError?, includeActualPlan? }`. `sessionId` is the query tab's UUID: the tab's SQL session is one unpooled connection
with connection recovery off, opened on its first execution and kept until the tab closes, its server changes, or it is
lost.

- **Actual execution plans.** With `includeActualPlan`, a separate connection starts a lightweight Extended Events session
  scoped to the query's physical connection and SPID. The query session receives its original batches verbatim, preserving
  session counters such as `@@ROWCOUNT`. The observer reads its bounded in-memory ring buffer after execution and drops the
  event session. The summary's optional `planSets` holds up to 64 plans in execution order, including plans from statements
  that finished before an error or cancel. Plan storage runs after the grids and has an 8 MiB allowance within the global
  budget. The descriptors use the same page format and release lifecycle as `resultSets`. Missing permissions, an
  unsupported server, and incomplete capture are reported in Messages. The observer needs lightweight plan profiling
  and permission to create, enable, read and drop its event session. SQL Server 2025 and Azure SQL Database also set
  a maximum collector duration. If a process exits abruptly before cleanup, a collector's connection ID filter prevents
  a later session that reuses the SPID from being captured. A server-scoped collector's name records its client event GUID
  and both query/observer physical server connection IDs. A later capture checks up to 16 candidates within a one-second
  slice of its 5 s setup budget, resuming after the last one the previous capture examined on that server, so refused or
  failing definitions cannot hide later ones; a drop the server refuses skips to the next. Recovery requires both
  connections to be absent and the ownership/predicate shape to match; it rechecks the definition and liveness
  immediately before server-quoted DROP. Server-scoped single-GUID collectors from earlier builds cannot prove observer
  ownership, so they are swept only when clearly abandoned: collector-shaped with Varia's exact predicates, and either
  stopped while no connection holds the session id they watch, or created more than a day ago. Database-scoped
  collectors are not swept. SQL in `Plans/ActualPlanSql.cs` is rendered once per variant, binds
  values as typed parameters and quotes identifiers on the server; its offline lint (`ActualPlanSql.Lint`) and real
  hostile-name round trips cover that boundary. See [collector recovery](plan-capture-hardening.md) for limits and validation.
  When `SET STATISTICS XML` also returned the same execution, Varia keeps the complete SQL-returned plan and pairs it with
  one observer event in the same batch and repetition. The optional `planOrder` lists matched and retained observer result
  IDs in event order so the canvas can interleave both sources within a batch. Across batches it uses batch and repetition.
- **SET prologue.** When a session opens (and so whenever one is reopened after it closed or was lost), the backend
  runs SSMS's query-window defaults before the script: `SET ARITHABORT ON; SET ANSI_NULLS ON; SET ANSI_PADDING ON;
  SET ANSI_WARNINGS ON; SET ANSI_NULL_DFLT_ON ON; SET CONCAT_NULL_YIELDS_NULL ON; SET QUOTED_IDENTIFIER ON;
  SET NUMERIC_ROUNDABORT OFF; SET TEXTSIZE 2147483647;`. SqlClient's login already sets all of them but ARITHABORT
  (OFF) and TEXTSIZE (-1); each is sent anyway because a server's `user options` can change login defaults. A script's
  own SET statements then persist in the session as usual. ARITHABORT ON is part of a plan's cache key, so a statement
  can get a different plan in a query tab than in an application that leaves it OFF, exactly as between SSMS and that
  application. A session whose prologue fails is closed, and the next execution opens a new one.
- **Batches.** `GO` and `GO n` split the script (SQLCMD commands are refused before anything runs; a line starting with
  `::` is T-SQL). As in SSMS, a batch that raised an error (severity 11–19) ends only itself: the next batch runs, and
  Messages gets "Batch {b} raised an error; execution continued with the next batch." ("Batch {b}, repetition {k},
  raised an error; execution continued with the next repetition." or "… next batch." for `GO n`) when any batch remains.
  SQL Server decides how much of a batch runs after an error (most errors end only their statement). Severity 17–19
  errors do not stop the batch on the server either, but SqlClient raises them as exceptions. After the batch's first
  result set, SqlClient raises one where SQL Server sent it and keeps the reader, so the batch's later result sets and
  messages follow it in order, as in SSMS; one raised partway through a result set's rows (a resource error such as
  701) ends that set as `incomplete` with the rows read so far (a live check raises it through a test hook, since no
  statement raises one there on demand). Before the batch's first result set it cannot: SqlClient reads the rest of
  the batch inside `ExecuteReader` (SqlClient 7.1.1, seen with a minimal live probe), discarding the batch's later
  result sets (their row counts still appear) and delivering its later messages, and only then raises the error, so
  those messages are listed before it. SQL Server ran the whole batch either way. `FireInfoMessageEventOnUserErrors`
  routes only severity 16 and below, and no SqlClient switch changes this; recovering those result sets would take a
  fork of SqlClient's TDS reader, so it is a known difference from SSMS, pinned by a live check that fails if a
  SqlClient update changes it.
  With `stopOnError: true` (for SQLCMD's `:on error exit`), the first batch that raised an error ends the script
  instead. Nothing runs after a cancel, the script's deadline, an error of severity 20 or more, or any failure that
  closes the session.
- **Stop.** A cancel stops a batch where it finds it, also while the batch streams messages (a loop of `PRINT` or
  `RAISERROR … WITH NOWAIT`), where SqlClient's cancel from another thread would wait for the messages to stop: the
  backend then cancels from inside the next message (`StatementStop`, as object actions do). A `query.cancel` that
  overtakes its `query.execute` (each request runs on its own task, and a 1M-character script takes a while to read) is
  kept, at most 256 for a minute, and the query stops as it registers, before any SQL; its answer says
  `cancelled: false`, since nothing was running yet.

| `status` | Meaning | Status line |
| --- | --- | --- |
| `completed` | Every batch ran without an error | "Query executed successfully." |
| `completedWithErrors` | Every batch ran, and at least one raised an error; `error` (`SQL_ERROR`) holds the first 20 errors and the first batch and repetition that raised one | "Query completed with errors." |
| `failed` | An error stopped the script: opening the session or changing its database, a batch with `stopOnError`, an error that closed the session, or an unexpected failure (`BACKEND_ERROR`) | "Query failed." |
| `cancelled` | `query.cancel`, a closed tab, a disconnect, or a CANCEL frame other than main's backstop | "Query was cancelled." |
| `timedOut` | `timeoutSeconds` passed, or main's backstop cancelled the request | "Query timed out." |

`completedBatches` counts the batch executions that finished, including those that raised errors (a batch whose output a
severity 17–19 error raised before its first result set cut short counts too); with `stopOnError`, the batch that
stopped the script is not counted.
Validation errors and a missing, busy or invalid session or connection use the error envelope instead of a summary, and
nothing runs.

**Session identity.** When a session opens, the SET prologue and `SELECT SUSER_SNAME();` go in one command, so opening a
session costs no extra round trip; `spid` is `SqlConnection.ServerProcessId` (from the login acknowledgement, no round
trip). Both are read once, as SSMS shows them from the connection, and every summary returns `spid` and `login` (≤ 128
characters) while the session is still open after the script; both are absent when the session was lost or never
opened. The status bar shows `login (spid)`, as SSMS does. Varia sends no SQL on the query session after the script.
The next script can read the `@@ROWCOUNT` and `@@ERROR` left by the previous script. Session observers
(`DBCC INPUTBUFFER`, `sys.dm_exec_input_buffer`, sp_WhoIsActive) see the user's most recent SQL.

**Transaction state.** As SSMS asks a query window's session when it closes or disconnects, the renderer reads an idle
session's open transaction only when the session is about to end: `query.session.state` takes `{ sessionId }` (a UUID)
and runs `SELECT @@TRANCOUNT;` in the session, answering `{ transactionCount, checked }`. It runs on the control lane
with a 5 s deadline and never waits for the session: a session running a script answers `SESSION_BUSY` at once, an
unknown (never opened, or closed) one `SESSION_CLOSED` ("This query has no open SQL session."), and one found lost is
closed and answers `SESSION_LOST` ("The SQL session was lost, so SQL Server rolled back its transaction."); main answers
`SESSION_LOST` itself for a session of an ended generation. Under `SET SHOWPLAN_XML`, `_TEXT`, `_ALL`, `NOEXEC`,
`PARSEONLY` or `FMTONLY ON` the SELECT returns a plan or no row: the answer is then `{ transactionCount: 0, checked:
false }`, and the options are left as they are, since the user may still keep the session (a commit turns them off
first, below). The read is a statement in the session, as SSMS's own check is, and the renderer reads every idle
connected query a flow covers, not only those it then asks about: a session the user keeps (Cancel, or nothing to ask
about it) then sees `@@ROWCOUNT` 1 and `@@ERROR` 0, and other sessions see `SELECT @@TRANCOUNT;` as its most recent
SQL (`DBCC INPUTBUFFER`, `sys.dm_exec_input_buffer`); the live checks pin these. A cancel does not roll back, so a cancelled script's open transaction is still there; an error
that dooms a transaction (`XACT_ABORT`) ends it by the batch's end (3998), and the read says 0.

**Ending a session.** `query.session.close` takes `{ sessionId, transaction? }`. Without `transaction` it cancels the tab's
running script and closes the session (SQL Server rolls back what is open). With `'commit'` it first reads
`SELECT @@TRANCOUNT;` in the session: no row (or a plan) means `SET SHOWPLAN_XML`, `_TEXT`, `_ALL`, `NOEXEC`,
`PARSEONLY` or `FMTONLY` would keep the commit from executing, so it turns them off (each SHOWPLAN option in its own
batch; the session is about to close) and reads again. With a transaction open it runs
`WHILE @@TRANCOUNT > 0 COMMIT TRANSACTION; SELECT @@TRANCOUNT;`, so every nesting level commits, and checks that 0 is
left. A script still running (`SESSION_BUSY`), a commit SQL Server refuses or that leaves a transaction (`SQL_ERROR`,
"The transaction was not committed, and the query stays open. Msg …") or the deadline leaves the session open with its
transaction. A session found lost before the commit was sent is closed and answers `SESSION_LOST` ("The SQL session was
lost, so SQL Server rolled back its transaction. Nothing was committed."); one lost while the commit ran answers
`SESSION_LOST` with "The SQL session was lost while committing, so it is not known whether its transaction was
committed. Check the data before running the work again." A commit the deadline or a cancel interrupts answers `TIMEOUT` or
`CANCELLED` and leaves the session open, its outcome unknown: the session remembers it, and when a later commit or state
read finds it lost it answers `SESSION_LOST` with "The SQL session was lost after a commit that did not finish (it was
cancelled or timed out), so it is not known whether that commit took effect. Check the data before running the work
again." A severity 20 error ends the session even while its connection still reads open (managed SNI closes it later):
the state read, the commit and an execution all take it for lost. `'rollback'` is a plain close: SQL Server rolls back what a
closed session left open, and the close does not wait for it (an explicit `ROLLBACK`, or an attention sent during one,
waits for the whole rollback, which can outlast the 10 s deadline). An unknown session answers `{ closed: false }`.

**Session limit.** SSMS has no cap on query windows. The backend keeps at most 1,000 query sessions (each one unpooled
connection) only as a backstop on connections; scripts running at once are bounded by main's 256 pending requests.
Main keeps a reserve of only 32 more for control-lane requests (cancels, state reads, closes), so with 256 scripts
running at most 32 of those can be outstanding; the renderer therefore sends a flow's state reads and cancels 8 at a
time, and ends sessions one at a time. The next session is refused with `SESSION_LIMIT`: "This query was not executed:
1,000 query tabs already hold SQL sessions, the most Varia SQL Manager keeps open. Close query tabs you no longer need, or
disconnect idle ones (Query > Connection > Disconnect), then execute again." Idle sessions are never reclaimed to make
room: a session's SET options, temporary objects and open transaction cannot be seen from outside (an empty temporary
table allocates no pages, so tempdb's space views miss it), and closing it would lose them silently.

**Prompts.** Before sessions end, the renderer reads the transaction state of each idle query among them that is on a live
connection (`query.session.state`, 8 at a time, within 5 s in all: one not read by then, because the backend or the
server does not answer, is treated as unchecked, so an unresponsive backend delays the prompt by 5 s, not by every
read's deadline in turn). A count above 0 is an open transaction; `checked: false`, or any
failure other than a session that is gone (`SESSION_CLOSED`, `SESSION_LOST`, `NOT_CONNECTED`, `CONNECTION_LOST`,
`BACKEND_LOST`), such as `SESSION_BUSY`, `TIMEOUT` or `TOO_MANY_REQUESTS`, is one that may be open (`unchecked`).
A read that finds the session lost (`SESSION_LOST`) makes the query's next execution say, before its own messages,
that it runs in a new SQL session and that SQL Server rolled back the previous one's transaction, unless the query
moves to another connection or disconnects first. Executing queries are not read. It then sends main
`varia:confirm-sessions` with `{ action, tabs }` (`action`: `close`,
`closeAll`, `changeConnection`, `disconnectQuery` (Disconnect, or Change Connection to Disconnected), `disconnect` (the
server), `disconnectAll` or `exit`; at most 1,024 tabs, each `{ name ≤ 512, transactions, running, unchecked? }` and only
those with an open or unchecked transaction or a running script). Main composes the message box from these facts
(`src/shared/sessions.ts`) and shows it through its dialog queue, so a page that crashes or reloads while it is open gets
Cancel and the box closes. Open transactions ask SSMS's question, "There are uncommitted transactions. Do you wish to
commit these transactions before closing the window?" (… "before changing the connection?", "before disconnecting?",
"before disconnecting the server?", "before closing Varia SQL Manager?"), with **Yes** (commit), **No** (roll back) and
**Cancel**; Yes is the default, as in SSMS, and Escape is Cancel. The wording and the default come from SSMS as users
report it; Microsoft's documentation does not show this dialog. SSMS asks per window; several queries are asked about
once ("There are uncommitted transactions in 3 queries. …"), listing up to 10 by name with their nesting. A session
that could not be read is worded "There may be uncommitted transactions", and is listed as "not checked". A query
still executing is never committed: it is cancelled (the renderer waits up to 15 s for it to stop) and its session
rolls back. Executing queries are asked about in a box of their own, **Cancel Query and Close** or **Keep Running**,
with Keep Running the default and the Escape answer; when a flow also has open transactions, as SSMS asks each window,
the renderer sends the executing queries first and the open transactions in a second request only after Cancel Query
and Close, and cancels nothing until both are answered, so Enter never cancels a running query. (A request that mixes
both lists the executing queries under "Still executing" and defaults to Cancel.) The renderer then ends each session with `query.session.close` and
the chosen `transaction`; a commit that fails is shown and the close, move, disconnect or quit stops there. Close All and
Disconnect All Queries leave running queries alone; one that was running when their prompt opened and has finished
since is read then, and if its session may hold a transaction it stays open (or connected) and is reported, rather than
have that transaction rolled back without asking. A run that settles after its tab closed (its cancel took longer than
15 s) still has its result sets released (`results.close`).

## Query events

EVENT frames whose id is a running `query.execute` request. Main validates each with `queryEventSchema`, stamps the
generation on descriptors, registers the result as owned on `resultSet.opened`, and forwards it on the port (or drops it
when no port is open).

| type | Emitted |
| --- | --- |
| `session.opened` | Before the first batch, once a live query session is acquired. Carries its `spid` and optional `login`. The final summary still describes whether the session survived execution |
| `resultSet.opened` | When a kept result set's columns are known, before its first row; carries the descriptor |
| `progress` | At most 10 times a second per query, latest value wins; up to 64 result sets with `rowsRead`, `rowsStored`, `rowsAvailable`, `bytesStored`. A sealed page is reported at once when no progress went out in the last 100 ms, and every set's first sealed page at once whatever the spacing, so the first rows of each set (one-row sets included) are readable without waiting for a tick |
| `messages` | Every 100 ms or 64 KiB, only entries stored under the message caps: `{ text, kind: 'info' \| 'print' \| 'server' \| 'error' }` ([Messages](#messages)) |
| `resultSet.closed` | Once per kept result set, with its final descriptor |

Progress and messages are droppable: when the backend's control lane holds 1,000 frames or 8 MiB, new ones are refused,
and one over 256 KiB is dropped. `session.opened`, `resultSet.opened` and `resultSet.closed` are essential: never refused, and up to
4 MiB, enough for a descriptor of 4,096 columns with 128-character names (about 3.5 MB). RESPONSE, PONG and GOAWAY are
never dropped. The UI treats the summary as authoritative and
ignores a query's events once its summary has arrived.

### Global memory events

| type | Emitted |
| --- | --- |
| `results.memory` | Checked once a second and after `results.close`, before its answer. Reports the first sample and any change since the last report. Each query summary's `budget` counts as a report and shares this event's sequence. This lets the renderer discard an older summary when a close's event arrives first. |
| `explorer.index.memory` | Checked once a second and after a disconnect drops a connection's index. Reports the first sample and changes to the usage charged to the shared index budget. This event has its own sequence. |

Both events are droppable. A refused sample stays eligible for the next check and consumes no sequence number. Main
pairs each sequence with the backend generation, retains the latest report for each feature, and replays both when a new
results port opens.

## Result pages

A page is the body of a DATA frame: the rows `[firstRow, firstRow + rowCount)` of one result, column by column.

```text
PageBody := array(7)
  [0] uint formatVersion = 1
  [1] uint resultId                    the read's resultId
  [2] uint firstRow                    0 … 2^53 − 1
  [3] uint rowCount                    1 … 4,096
  [4] array columns                    one per descriptor column, 1 … 4,096
        ColumnChunk := array(11) [ wire (1 text | 2 binary),
          validityOff, validityLen, offsetsOff, offsetsLen, dataOff, dataLen,
          truncatedOff, truncatedLen, errorsOff, errorsLen ]          uints, relative to the data blob
  [5] bin pad (0 … 7 zero bytes)       so the blob's payload starts at a body offset ≡ 0 (mod 8)
  [6] bin32 data                       the blob
```

- **Bitmaps** (validity, truncated, errors) are LSB-first, `⌈rowCount / 8⌉` bytes or absent (length 0, offset 0: all
  valid, none truncated, no errors). Validity 1 means non-NULL. Bits past the last row are 0. A truncated cell is
  non-NULL and holds a stored prefix; a read-error cell is NULL.
- **Offsets** are `u32[rowCount + 1]`, 8-aligned in the blob, starting at 0, non-decreasing, ending at `dataLen`; a NULL
  cell has an empty span.
- **Text** cells hold the SSMS display text as UTF-8; **binary** cells hold bytes, shown as `0x` and uppercase hex.
- **Sealing.** A page is sealed at 256 KiB or 4,096 rows; the first page of a result at 64 rows or 20 ms after its first
  row; an idle page after 200 ms without rows; and at the end of the result set. An encoded row is at most 8 MiB:
  cells past that are stored as truncated prefixes.
- **Building.** `PageBuilder` writes the header with the MessagePack writer, places every region 8-aligned in the blob,
  and copies everything into one array of the exact size, which is both stored and written to stdout.
  `encodePage` (TypeScript, for tests, the fake backend and benchmarks) writes byte-identical pages; golden pages live
  in `tests/fixtures/pages/`.
- **Decoding.** `decodePage(body, columns)` in the worker checks every bound above plus each column's wire kind against
  the descriptor, that every region lies inside the blob, and that nothing trails it; it throws only `PageFormatError`.
  It returns zero-copy `Uint32Array`/`Uint8Array` views. Text is decoded only for the cells a window asks for: one
  decoder call per column and page for runs of small ASCII cells (`textRun`), otherwise per cell (`cellText`), capped
  without splitting a surrogate pair.

## Result store and memory budget

Results stay in backend memory, never on disk (`ResultStore`).

- **Budget.** Global: a quarter of the memory available to the process (container-aware `TotalAvailableMemoryBytes`),
  within 256 MiB – 2 GiB. One query may use half of it. Nothing more is stored while the operating system reports high
  memory load (checked at every page seal). `VARIA_RESULT_BUDGET_BYTES` replaces the global figure only with the test
  hooks, and turns the memory-load check off so tests see their budget's truncation reasons on a busy machine (the offline
  checks' stores never check it unless given a probe).
- **Charges.** Each sealed page costs its length plus 96 bytes plus its cell lengths ([Cell lengths and row sizes](#cell-lengths-and-row-sizes)); a result set's metadata 512 bytes plus 2 per name
  character and 64 per column, reserved like rows; the page builder's working space is reserved in 256 KiB steps and
  returned when the set ends. A failed reservation rolls back the current row, so pages never hold partial rows; later
  rows are still read and counted in `rowsRead` but not stored, later result sets of the query are not kept (they count
  in `discardedResultSets`), and execution always continues.
- **Rows per query.** `maxRows` 0 – 2,147,483,647 counted across result sets (0 means the budget only; the PR6 table
  sends 1,000). **Result sets kept** `maxResultSets` 1 – 1,000 (default 10); later sets are counted, not stored. The
  summary must fit the 16 MiB response: kept sets' descriptors may take 8 MiB, each bounded by `512 + Σ(UTF-8 name +
  UTF-8 type + 96)` bytes (messages and the error text take the rest, with room to spare), so once a set's column list
  would pass that, it and later sets are counted as discarded.
- **FOR XML and FOR JSON.** A set whose only column is `XML_F52E2B61-18A1-11d1-B105-00805F49916B` or
  `JSON_F52E2B61-18A1-11d1-B105-00805F49916B` (ntext or nvarchar) arrives as rows of about 2,033 characters;
  `ForXmlCollector` joins them into one pooled buffer of up to 2,097,152 + 1 characters (the excess marks the value
  truncated), reserving its memory from the query's budget in 256 KiB steps, and stores the value as the set's one row
  (`rowsRead` = `rowsStored` = 1) with role `xml` or `json`, as SSMS shows one link. Text past the cap is read past in
  chunks, row by row, so a long nvarchar(max) value that a query names like that column is never buffered whole.
  `FOR XML … TYPE` already arrives as one xml cell.
- **Never unowned.** If a `query.execute` summary still cannot be encoded (`RESPONSE_TOO_LARGE`), its results are
  released at once rather than left without an owner.
- **Descriptor.** `{ generation, resultId, index, batchNumber, iteration, kind: 'rows' | 'executionPlan', columns,
  rowsRead, rowsStored, rowsAvailable (rows in sealed pages), bytesStored, truncatedCells, state: 'open' | 'complete' |
  'released', truncated?, incomplete }`. Result ids are u32 from 1 per generation and always paired with it.
- **Released** by `results.close`, the next `query.execute` on the same session (whatever its connection), and process
  exit. Closing a session (`query.session.close`) and disconnecting keep results readable, copyable and saveable, as in
  SSMS; the renderer closes them when their tab closes. A release fails the result's in-flight reads with
  `RESULT_RELEASED` after the current page and stops storing at once.
- **Leases.** `results.copy` and `results.export` lease their result: released while a job runs, it leaves lookup at once
  (new reads get `RESULT_RELEASED`), but its pages and budget are freed when the last lease ends, so re-executing or
  closing a tab never breaks a save. Every 64 MiB released, counted across releases (one large result or many small ones, closed together
  or one at a time), triggers one gen2 collection shortly after (pages are large arrays that nothing else would
  collect), and so does a release that empties the store once 16 MiB were released since the last aggressive one. The
  collection is aggressive (compacting, so it returns memory to the operating system) when what remains is no more than
  what was released since the last aggressive one, and non-compacting otherwise, so its pause never copies much.

Notes appended to the summary's messages:

| `truncated` | Note |
| --- | --- |
| `rowLimit` (or truncated cells) | "Results were truncated by display limits. Display limits do not stop script execution." |
| `queryBudget`, `globalBudget` | "Results were truncated because the result memory budget ({n} MB) is full. Execution continued; close other query results to free memory." |
| `systemMemory` | "Results were truncated because the computer is low on memory. Execution continued." |
| more than `maxResultSets` sets | "Only the first ten result sets are displayed. Display limits do not stop script execution." ("first {n}" for other limits) |
| column lists past the summary's 8 MiB | "{n} later result sets are not displayed because their column lists are too large to return. Display limits do not stop script execution." |
| an error stopped the script before later batches or repetitions (`stopOnError`, or an error that closed the session) | "Batch {b} raised an error; later batches were not executed." ("Batch {b}, repetition {k}, raised …" for `GO n`); nothing when no later batch was skipped, since SQL Server may have run the batch to its end |
| a cancel or timeout skipped later batches | "Stopped at batch {b}; {c} of {t} batch executions completed." (", repetition {k}" for `GO n`) |

A cell whose typed read fails becomes NULL with the error flag; that column switches to its fallback reader and the
messages get "Column ‘{name}’ ({type}): some values could not be read and are shown as NULL." An xml value read through
the `GetXmlReader` fallback whose rest past the cap fails to parse keeps its stored prefix (truncated, an estimate), and
the messages get "Column ‘{name}’ ({type}): some values could not be read to the end and show only the part read before
the error." Under a Stop, a value that parses as malformed ends the read as the Stop instead.

## Cell lengths and row sizes

While it reads a result, the backend measures every stored cell (`Results/CellLengths.cs`): its full length in UTF-16
characters (whitespace included, as `LEN(x + 'x') - 1` counts) and its bytes as SQL Server's `DATALENGTH` counts them,
including the part of a truncated cell that was read past and not stored. Later views (sort by size, column statistics,
the row-size bar) read these numbers; nothing re-reads SQL Server.

- **One helper.** `ResultSetBuffer.CellSize(row, column)` answers `(chars, bytes, exact)` for any stored cell, or null for
  NULL. A cell with a sidecar entry answers it, with the entry's own `exact`; any other is derived from its stored UTF-8
  text or bytes by the column's rule, which is exact because the cell was stored whole. `exact` is false for an estimate
  (below), for every cell of a column whose rule is a guess (no collation), and for a truncated cell without an entry.
- **Rules per type** (`ColumnLength`, chosen once per column in `ColumnPlan`): fixed sizes for bit and tinyint (1),
  smallint (2), int, smallmoney, real, smalldatetime (4), bigint, money, float, datetime (8), date (3), time (3–5),
  datetime2 (6–8), datetimeoffset (8–10) and uniqueidentifier (16), the fractional-second part by scale as SQL Server
  stores it; decimal and numeric by value, 1 byte plus 4 per 32-bit word of the unscaled value (`DATALENGTH` of a
  decimal(38, 0) holding 1 is 5); nchar, nvarchar and ntext 2 bytes a UTF-16 unit; char, varchar and text by the column's
  collation (below); binary, varbinary, image, timestamp and CLR types their byte count; json its UTF-8 text; vector 8 + 4
  per dimension; xml and sql_variant record their bytes as they are read.
- **xml** counts the BOM-less UTF-16 text SQL Server sends, `DATALENGTH(CONVERT(nvarchar(max), x))`; `DATALENGTH` of the
  xml value itself is its binary storage, which no client can see. **json** counts UTF-8 text bytes; `DATALENGTH(json)`
  is also binary storage. So for a row with xml or json cells, `results.rowBytes` is not `SUM(DATALENGTH(...))` as SQL
  Server would compute it. An xml cell's characters are those of SQL Server's text too (bytes / 2), cut or not, so they
  compare across a column; the display text may differ (SqlClient writes `<e />` for SQL Server's `<e/>`).
  **sql_variant** counts its base value exactly where SqlClient tells the base type apart (integers, bit, decimal, real,
  float, uniqueidentifier, binary). Elsewhere it is an estimate, and its entry says so: a string arrives as SqlString,
  whether varchar or nvarchar, and is counted as nvarchar; smallmoney and smalldatetime bases arrive as money and datetime
  (8); and date, time, datetime2 and datetimeoffset bases are counted at scale 7. Its characters are those of the display
  text.
- **Collation.** For char, varchar, text, nchar, nvarchar and ntext, the backend reads each column's collation from
  SqlClient's metadata (`SqlClientCollation`, by reflection over `SqlDataReader.MetaData`, `SqlMetaDataPriv.collation` and
  `.encoding`, checked against `_SqlMetaData.column`, the column's name). The char types count bytes with the encoding
  SqlClient itself decodes with, so a code page or UTF-8 byte count equals `DATALENGTH`; the n types are UTF-16 whatever
  their collation. The descriptor's column gets `collation: { lcid, sortId, codePage, utf8, options }` (`options` are
  SqlCompareOptions bits: 1 IgnoreCase, 2 IgnoreNonSpace, 8 IgnoreKanaType, 16 IgnoreWidth, 16384 BinarySort2, 32768
  BinarySort; `codePage` 0 for a UTF-8 collation; `sortId` non-zero for SQL_ collations). If a SqlClient release moves
  these internals, the reflection finds nothing, the column has no `collation`, and its bytes count one per character,
  every cell reported as an estimate; the live checks fail first.
- **Storage.** Beside each sealed page, `PageLengths` holds a `uint32` per row (the sum of its cells' bytes; NULL counts
  0), a sorted sparse list of 24-byte `(row, column, chars, bytes)` entries for the cells whose stored text does not give
  their length (truncated cells, every xml, vector and sql_variant cell, and estimates; an estimate is marked in the
  column's sign bit), and a list of 16-byte `(row, bytes)` entries for rows of 4 GiB or more, whose `uint32` holds
  `uint.MaxValue`, so a sum never overflows (a row of several `max` values can pass 4 GiB). A row's sum is exact unless
  one of its cells is an estimate (a cell that could not be read, stored as NULL with the error flag, counts 0 bytes as
  one), or a column's rule is a guess; `results.rowBytes` names those rows. The page
  builder's open row keeps its entries until `CommitRow`, and a rolled-back row leaves none; the row-sizes array grows
  when the row that needs it begins, so that row's commit charges the growth.
- **Memory.** 4 bytes a row, 24 per entry, and 96 a page, charged to the result budget
  with the page (a page's cost is its length + 96 + its lengths' size) and freed with it; the open page's lengths count in
  the builder's working space.
- **Reading.** `results.rowBytes { resultId, firstRow, count: 1..16,384 }` answers `{ firstRow, bytes: number[],
  rowsAvailable, estimated: number[] }` for sealed rows only; fewer than `count` past `rowsAvailable` (none for a range
  past it). `estimated` lists, in increasing order, the rows of the range whose sum includes an estimate. Main forwards
  it only for a result the renderer owns in the current, ready generation (else `RESULT_UNAVAILABLE`), and only an
  answer that passes `rowBytesResultSchema`, starts at `firstRow`, has at most `count` rows and no more than
  `rowsAvailable - firstRow`, and lists estimated rows in order within them (else `BACKEND_ERROR`).
  `ResultHandle.rowBytes(first, count, signal)` answers an empty range itself and refuses a malformed one
  (`INVALID_PARAMS`) without sending it, since main closes the port after 100 invalid messages.
- **What SQL Server sent.** FOR XML and FOR JSON values count their joined text as nvarchar, which is how SQL Server
  sends them; there is no stored value whose DATALENGTH could differ. json counts the UTF-8 bytes read, exact whatever
  they hold (U+FFFD included).
- **Not measured exactly.** Live tables count text as nvarchar, and a cut cell, whose full text the probe never had, counts its kept text as an estimate. Without
  `SequentialXml`'s internals, an xml cell counts its display text as an estimate. A value read through a column's
  fallback reader (after a typed read failed) counts as text: exact for character types, an estimate for decimal, vector
  and recorded types. A _UTF8 value holding bytes that are not UTF-8 arrives with U+FFFD (3 bytes) in their place, so a
  value showing U+FFFD is an estimate; a code-page value holding bytes its code page does not map is counted as SqlClient
  decodes it, which no client can tell from real text. Synthetic test rows are not measured.

## Messages

The summary's `messages` and the `messages` events carry `MessageEntry { text, kind: 'info' | 'print' | 'server' | 'error' }`, in order, under
the caps (1,000 entries, 1,000,000 characters); the summary is authoritative, since events may be dropped. Past the caps,
"Messages were truncated by the display limit; …" marks where entries stopped, and up to 20 more error entries (each cut
at 16,384 characters) are still kept, so the error that stopped a script, or its cancellation or timeout, is in Messages
after a flood of PRINT output or row counts. An event carries at most 1,000 entries; a summary at most 1,028 (the
stored entries, the late errors, and up to 8 notes). Should a summary with an `error` still hold no error entry, the
renderer adds its `error` as one.

- **Print:** what the script printed: PRINT (message number 0) and RAISERROR with severity 0 – 10 (number 50000, or a
  user message's number above it). They read like info entries; the renderer opens the Messages strip under the results
  when one arrives, as it does for an error.
- **Server:** SQL Server's other severity 0 – 10 messages: warnings such as 8153 ("Null value is eliminated by an
  aggregate…"), SET STATISTICS IO and TIME output, and the messages of DBCC and sp_rename. They read like info entries and
  show in the Messages strip without opening it. As in SSMS, "Changed database context to …" (5701) and "Changed language
  setting to …" (5703) are left out, whether from USE, a session's login, or the toolbar's database.
- **Info:** Varia's own lines: row counts as SSMS writes them ("(1 row affected)", "({n} rows
  affected)", no digit grouping), the notes above, "Batch {b} raised an error; execution continued with the next batch."
  after a batch that raised an error when another remains ([Query execution](#query-execution)), and "The SQL session
  closed. …" when a session that had opened closed (not for one that failed to open).
- **Error:** every severity 11+ error in SSMS's two-line form, `Msg {n}, Level {l}, State {s}, Line {k}` (the line within
  the whole script or selection) or `Msg …, Procedure {p}, Line {k}` (the procedure's own line), then a line feed and the
  message. Errors that arrive with an exception are added unless InfoMessage already delivered them (matched by number,
  state, line and text over the last 20). A cancel adds "The script was cancelled. Remaining batches were not executed."
  and a timeout "The script exceeded its execution timeout. Remaining batches were not executed."; an unexpected stop adds
  "Execution stopped unexpectedly: …". The summary's `error` keeps the first 20 errors (16,384 characters) as before.
- **`completedAt`** is the backend's local time, `yyyy-MM-ddTHH:mm:ss.fffffffzzz`, for SSMS's "Completion time:" line.
- **`budget`** is `{ usedBytes, globalBytes, queryBytes, seq }` when the summary was built; main adds `generation`. `seq`
  orders it with the `results.memory` events (see [Query events](#query-events)).

## Sorted views

A results grid sorts and filters in the backend, over the rows it already holds (`Results/ResultViews.cs`); nothing
re-reads SQL Server. A view is an order of some or all of a result's base rows, read through the same calls as the result
itself by view position.

- **`results.view { resultId, sort: 0 – 16 keys, filters?: 1 – 16, replaces? }`** answers `{ viewId, rows, complete,
  approximate, filters? }`, with at least one key or filter (`INVALID_PARAMS`). A key
  is `{ column, descending, mode: 'value' | 'chars' | 'bytes' }`, columns distinct and within the result
  (`INVALID_PARAMS`). The view covers the rows sealed when it was built (`rows`); `complete` says that was every row of a
  finished set. `approximate` says a key compared a truncated value's stored prefix or a length that is only an estimate.
  `replaces` names a view of the same result that the new one supersedes: it is dropped once the new one is built, and
  left as it was when the sort fails or is cancelled. A result keeps at most 8 views; a ninth drops its oldest.
- **Order.** A stable sort, as SQL Server's ORDER BY would put the rows: NULL and unreadable cells lowest (first
  ascending, last descending); exact numerics as numbers at any precision, real and float as doubles, uniqueidentifier in
  SQL Server's byte order, datetimeoffset by its UTC instant, other date and time types by their fixed-width text, binary
  byte by byte, character columns by their collation (its locale and Ignore flags, or code points for _BIN and _BIN2),
  ignoring trailing spaces; other types by their display text's code points. `chars` and `bytes` sort character, xml and
  json columns (and binary, for `bytes`) by each cell's length from [Cell lengths and row sizes](#cell-lengths-and-row-sizes);
  other columns ignore the mode and sort by value. Equal rows keep their base order.
- **Filters.** Applied in order before the sort, each over the rows the ones before it kept; `rows` counts the rows kept.
  `{ op: 'in' | 'notIn' | 'between', column, rows: 0 – 4,096 base rows, nulls? }` compares the column's values with those
  rows' values (`nulls`: NULL is among `in`'s and `notIn`'s values; `between` takes two rows, its lowest and highest
  value, and keeps no NULL). The same filter can name selected cells instead,
  `cells: { ranges: 1 – 256 [first, count], viewId? }`, positions in a view (or the result) that the backend reads (each
  once, however the ranges overlap), reduces to one row per distinct value (at most 4,096, else `TOO_LARGE`; `between` keeps only the lowest and highest) and
  answers resolved, `{ op, column, rows, nulls }`, in `filters`, so the renderer builds the same view again from rows. A
  view named that is gone answers `VIEW_NOT_FOUND`. `{ op: 'duplicates', columns }` keeps the rows whose values in those
  distinct columns equal another row's (NULL equal to NULL, as GROUP BY has it), each group together in the order of its
  first row. Values are equal and ordered as the sort compares them, so a column's collation decides which texts match
  (case and trailing spaces under a CI collation) and `2` equals `2.0` in a float column; a truncated value compares by
  its stored prefix (`approximate`).
- **Memory.** A sort holds 8 to 16 bytes per row and key while it runs (a filter, per column it compares, and 16 bytes a row
  for the rows it keeps, a selection's rows or duplicates' groups), and a view keeps 4 bytes a row it shows, all charged
  to the result's query budget (`TOO_LARGE` past it); what building needed is returned at once, the order when the view is closed,
  replaced, or its result released.
- **Reading through a view.** `results.read`, `results.rowBytes`, `results.copy` and `results.export` take `viewId`;
  rows are then view positions. Read pages are built in view order from the stored cells (flags and truncation kept) and
  numbered by view position, so the worker caches them as it does a result's own (keyed `generation:resultId#viewId`). A
  view that is gone answers `VIEW_NOT_FOUND`. Copy through a view of a set still loading says `partial`; Save refuses it
  (`RESULT_OPEN`, "Save the results after they are sorted again.").
- **`results.viewClose { resultId, viewIds: 1 – 64 }`** answers `{ closed }`. Views end with their result too: a released
  result's views go with it, without a close.
- **Renderer.** `ResultHandle.sort(keys, { filters, replaces, signal })` validates the keys and filters before sending
  and returns a `ResultView` handle (`viewId`, `base`, `keys`, `filters` resolved, `rows`, `complete`, `approximate`) that
  reads, measures and copies like any handle; closing it sends `viewClose`, and it ends (released or lost) with its base. `ResultsService` keeps a view
  per grid: a newer sort aborts the running one, and it sends no `replaces`, so the view a grid shows stays readable until
  the grid has read the new one's rows and swapped (`viewShown`), and only then closes. A view of a set still loading is
  sorted again once the set completes, also when it completes during the sort, and the text mode (Tools › Options ›
  Query Results › Grid, Sort text columns by, and the results toolbar) sorts again every grid sorted by a text, xml, json
  or binary column when it changes. A view main sees built after its port went (a reload) is closed by main. Copy, Save Results As and opening a value follow the
  grid's order through its view; Save waits until a running or pending sort is built. A grid's filters (the grid menu's Filter
  submenu) go with its keys: a filter by the selection sends the selected cells of one column as ranges of what the grid
  shows (with its view's id), and keeps the resolved filter the view answers, so later views (a sort, another filter, the
  set completing) send rows; a failed view keeps the last view, keys and filters. The caption counts the rows a filtered
  view kept and names each filter by the values its rows hold ("name = 'x'", "id between '3' and '12'").

## Row identities and highlights

Highlights (the grid menu's Highlight submenu and Ctrl+Shift+H) follow their rows by an identity the backend computes over
the rows it holds (`Results/RowIdentity.cs`); the renderer never compares rows.

- **`results.identify { resultId, by: 'auto' | 'column' | 'row', column? }`** answers `{ column, unique, approximate, rows }`.
  The set must be complete (`RESULT_OPEN`, "Highlight rows after this result set finishes loading."). `auto` picks a key
  column: of up to 16 candidates (names ending in id, key or guid first, then integer, uniqueidentifier and decimal
  columns, then short character and date columns) the first with no NULL, no truncated value and no duplicate; with none it
  uses the whole row (`column: -1`). `column` uses the given column (`unique` says whether it had duplicates), `row` the whole
  row. An identity is a 53-bit hash of each cell's normalized value: character columns by their collation's sort key with
  trailing spaces trimmed (code points for _BIN and _BIN2), exact numerics by their canonical digits, uniqueidentifier by its
  bytes, datetimeoffset by its UTC instant, others by their stored bytes; so it matches rows equal under the collation.
  `approximate` says a hashed value was a truncated prefix. A second identify replaces the first. It holds 24 bytes a row
  while it runs (one set, reused by every candidate `auto` tries and by the whole-row fallback, which all fill one array)
  and keeps 8, charged to the query budget (`TOO_LARGE`) and freed with the result.
- **`results.rowIds { resultId, firstRow, count: 1 – 16,384, viewId? }`** answers `{ firstRow, ids, rows }`, an id per row
  (by view position with `viewId`), -1 past the identified rows. Without an identify first: `IDENTITY_NOT_FOUND`.
- **`results.findRows { resultId, ids: 1 – 10,000 in 0 – 2⁵³ − 1, viewId? }`** answers `{ positions, marks, truncated, rows }`:
  the ascending positions (view positions with `viewId`) of the rows whose identity is in `ids`, each with the index in
  `ids` it matched, at most 100,000 (`truncated`).
- **Renderer.** `HighlightsService` keeps highlights per tab and result set index: the first highlight identifies the set
  (`auto`) and fixes how its rows are told apart (the key column's name and base type, or the whole row); a re-run of the
  tab's query identifies its new set the same way once complete (a column whose length changed still counts) and finds the
  highlighted ids there, and a sorted view finds them by view position. A re-run without the key column finds nothing: the
  grid's strip and the Highlight command say the highlights follow a column these results lack. A `truncated` answer is
  drawn as far as it goes and the strip says only the first 100,000 rows are. A search that fails with `BUSY`,
  `TOO_MANY_REQUESTS` or `TIMEOUT` is tried again after 1, 4 and 16 seconds; any failed search is tried again when the user
  highlights. It colours at most 10,000 rows a command and keeps 10,000 a set. `GridView` draws the positions it is
  given by binary search per painted row, with theme colours (`resultsGrid.highlight*Background`). Highlights live only in
  the renderer's memory: they do not survive a reload, hot exit or closing the tab.

## Result diffs

Compare with Previous Result compares two results of one query in the backend (`Results/ResultDiff.cs`); the renderer
receives a new result to read like any other, never rows to compare.

- **`results.diff { left, right, exact?, context? }`** answers `{ descriptor, key, same, changed, added, removed, soft,
  approximate, leftOnly, rightOnly }`. Both results must belong to the same query (`INVALID_PARAMS` otherwise, and for a diff
  of a diff) and be complete (`RESULT_OPEN`, "Compare the results after they finish loading."). Columns pair by name,
  case-insensitively, in `left`'s order, when both hold text or both binary; at least one must pair (`INVALID_PARAMS`), at
  most 4,092 may (`INVALID_PARAMS`: the unified result adds four columns to a page's 4,096), and `leftOnly` and `rightOnly`
  name up to 64 that do not, which are not compared.
- **Alignment.** Rows match by `key`: the first shared column that is unique, NULL-free and untruncated in both results,
  of up to 16 candidates as `results.identify` ranks them; else by all shared columns' values together (`key` null), the
  k-th copy of a row matching the k-th copy. Values compare as SQL Server would (the identity hashing above): numbers by
  value, character columns by their collation, ignoring trailing spaces, each pair by `left`'s column type and collation, so
  a column whose collation or type changed between the results still matches. Matched cells compare their values, not only
  their hashes. Text equal by collation but not character for
  character is a soft difference: it leaves its row unchanged and is counted in `soft`. `exact` compares text character
  for character instead. `approximate` says a truncated value's stored prefix was compared.
- **The model.** The aligned entries (`DiffModel`: kind, row in each result, differing cells) are in unified order: the
  later result's order, each removed row after the earlier result's row it followed. The unified result below is one
  rendering of them; a side-by-side view would render the same entries.
- **The unified result** (`kind: 'diff'`, its descriptor stamped with the generation by main, which then owns it) has
  the columns `Change` (" ", "−" or "+"), `R1` and `R2` (each row's number in `left` and `right`, NULL where it has none),
  the shared columns with `right`'s names and types, and a hidden tone column: `added`, `removed` or, for an unchanged row
  with soft differences, `same`, followed by the differing cells' column numbers, a soft one prefixed with `~` and a run of
  adjacent columns of one kind written `first-last` (`removed 4-9 ~11`). It is an `nvarchar(500)`, under the 512
  characters the grid reads of a cell, so the grid always reads it whole; a row that differs in more scattered columns
  than fit stops at a whole entry and ends with `…`, and the cells past it are not marked. A changed
  row is its old row (−) then its new one (+). Only `context` unchanged rows (default 1, at most 100, -1 for all) show on
  each side of a change. Each copied cell's lengths are its source cell's, so `results.rowBytes` sums the shown values
  (not the marker, row numbers or tone). It is a result of the same query, charged to its budget (rows stop when it is
  full, with the usual truncation, never between a changed row's two halves), released with the query's other results,
  and released at once when its answer is not delivered: a CANCEL or the deadline answered first (the backend), its
  answer failed validation or its port went (main), or the page gave it up (the worker).
  While it is built the alignment holds about 80 bytes a row of both results (`ResultDiffer.WorkingBytes`) and 12 bytes
  a differing cell, charged to the budget too as they grow (`TOO_LARGE` without room).
- **Renderer.** `ResultHandle.diff(right, { exact, context, signal })` relays it; `CompareService` appends the new result
  as the run's last set (`ResultsService.addSet`), named "Differences: Result 1 → Result 2", and its grid's strip says what
  was compared, and when `approximate`. A new run in the tab gives up a comparison in flight, and `addSet` takes a diff
  only into the run that holds both compared sets; one it refuses is released. `GridView` colours added and removed rows from the tone column and marks the listed cells (`is-chg`,
  `is-soft`) with theme colours only (`resultsGrid.diff*`).

## Search in results

The results toolbar's search box searches every grid of a run in the backend, over the rows it holds
(`Results/ResultSearch.cs`), through the order the grid shows; rows never come to the renderer for it.

- **`results.search { resultId, text: 1 – 1,024 characters, fromRow, maxMatches: 1 – 10,000, backward?, viewId? }`**
  answers `{ rows, total, first, matchRows, matchColumns, complete, approximate }`. It searches the rows sealed now, or a
  view's positions with `viewId` (`VIEW_NOT_FOUND` when it is gone). One pass counts every match (`total`) and keeps a
  run of whole rows: from `fromRow` on until it holds `maxMatches`, or with `backward` the last rows before `fromRow` that
  hold `maxMatches`, so a run passes `maxMatches` by at most its last row's columns. `matchRows[k]`, `matchColumns[k]`
  are the run's cells in row then column order; `first` counts the matches before the run's first (when the run is
  empty, those before `fromRow`). `complete`: those rows were all of a finished set; `approximate`: a truncated value was
  searched by its stored prefix and did not match. A search holds its run, one row's matches and at most 1 MiB of parsed
  page layouts (one page's in base order), so it reserves no budget. It checks at points spaced by the work done (cells
  and bytes compared, so a wide or long-valued row is a checkpoint of its own): CANCEL (a newer search) stops it there,
  and so does the result's release (`RESULT_RELEASED`) or the view's close (`VIEW_NOT_FOUND`), so it never reads pages
  whose budget was returned for longer than one checkpoint.
- **Matching.** A cell matches when its grid text contains the text. NULL and unreadable cells never match. Hidden columns (a
  diff's row tone) are not searched. Character
  columns compare by their collation, as `LIKE '%text%'` would: its locale and Ignore flags (case, accents, kana type,
  width), code points for _BIN and _BIN2, and for a locale the runtime does not know its case flag alone. Text made only
  of characters the locale ignores (U+200B, U+00AD) is looked for as written, by code point. Every other
  column compares its display text ignoring case (numbers, dates, xml, json, uniqueidentifier); binary values match their
  `0x` and uppercase hex, and a column of them is skipped when the text is not hex.
- **Main** checks the request with the port schema and ownership, and the answer before forwarding it: as many columns as
  rows, cells strictly in (row, column) order inside the rows searched and on the side of `fromRow` asked, columns inside
  the result's (as its descriptor named them), and `first + matches ≤ total`.
- **Renderer.** `ResultHandle.search(text, fromRow, { maxMatches, backward, signal })` bounds the request before the port.
  `ResultsSearchService` (`results/search.ts`) runs each tab's search: typing searches once it pauses (200 ms; Enter at
  once), one grid at a time in run order, through the view a sorted grid shows, and the first match becomes active as
  soon as a grid has one. Each grid holds one run of up to 10,000 matches; a step past it reads the next run forward or
  back (or the first or last, when it wraps). A grid that shows other rows (a new run, a sort, a set that finished)
  searches again, keeping the active match's place. Columns mode matches column names from the descriptors, ignoring
  case and accents, with no backend call. Grids draw the marks through `GridView` (`grid/marks.ts`) as cell and header
  classes, never markup; the stack scrolls the grid holding the active match into view (opening it if collapsed), and the
  grid scrolls the cell. Find in Results (Ctrl+F in a grid), Find Next and Find Previous in Results (F3, Shift+F3) are
  catalogue commands.

## Column profiles

The column profile panel and the grid's row-size bar describe rows the backend holds without reading them into the
renderer (`Results/ColumnProfiles.cs`): `results.profile` answers aggregates, never rows.

- **`results.profile { resultId, columns: 0 – 32, viewId? }`** answers `{ rows, complete, rowBytes?, columns }`. Columns
  are distinct and within the result (`INVALID_PARAMS`); no columns answers only `rowBytes`. Through a view it describes
  the view's rows (its sort now, its filter once views filter), else the rows sealed when it ran; `complete` says those
  were every row of a finished set. Main forwards an answer only when it names the columns asked, in order.
- **Per column** `{ column, values, nulls, distinct, distinctExact, min?, max?, approximate, chars?, bytes?, histogram? }`.
  Values compare as a sort does ([Sorted views](#sorted-views)): NULL and unreadable cells count as `nulls` and are never
  `min` or `max`; equality follows the collation, ignoring trailing spaces, and exact numerics are equal by value (1.50
  and 1.5). `distinct` is exact up to 16,384 values, then a HyperLogLog estimate (about 1 % off; `distinctExact: false`).
  `min` and `max` are display text, binary as `0x` hex, cut to 256 characters with "…". `chars` and `bytes`
  (`{ min, max, average, exact }`) come from the stored lengths ([Cell lengths and row sizes](#cell-lengths-and-row-sizes))
  for text, xml, json (both) and binary columns (bytes); `approximate` says a truncated cell's stored prefix took part.
  `histogram` is `{ basis, low, high, counts }`, 20 equal buckets from `low` to `high`: numbers by `value`, date and time
  types by instant (`time`, .NET ticks), text by `chars`, binary by `bytes`; other types have none.
- **`rowBytes`** is the rows' sizes, `{ min, max, average, exact }` from each page's row sums: the grid's row-size bar
  scales to its `max`.
- **Work.** Two passes over the sealed pages, off the frame loop, reading rows in base order through a bitmap of the
  view's rows. Its working memory (a bit a row, and per column the exact distinct set up to its cap, 16 KiB of estimator
  registers and the kept values) is charged to the result's query budget while it runs (`TOO_LARGE` when there is no
  room) and returned when it ends. Longer keys (a long lowest or highest value, a long collation sort key) are charged
  as the profile meets them, and a refusal ends it with `TOO_LARGE`. With no columns it reads only the pages' row sums,
  never their bodies. The worker's `cancel` stops it (`CANCELLED`).
- **Renderer.** `ResultHandle.profile(columns, signal)` validates the columns before sending. The profile panel asks for
  the shown grid's columns, 32 at a time, through the view the grid shows, and again when its rows or its view change;
  a newer request cancels the older, each card's NULL share is of the rows its own request saw, and cards stay shown
  while the same rows are asked again. The row-size bar reads `results.rowBytes` for the rows in view only, through the
  shown handle, and scales them to the profile's `rowBytes.max` once the set is complete (asked again 2 s after a
  failure), or to the largest row read while that is larger.

## Copy and Save Results As

All Copy and Save text comes from one formatter, `ResultTextWriter` (C#), which reads stored pages in place through
`PageView` (a production reader of trusted pages, parsed in O(columns); `Varia.Backend.Tests/PageReader.cs` stays the
independent oracle). It works on UTF-8 bytes; CSV quoting, TSV replacement and JSON escaping are safe at byte level
because every byte that needs attention is ASCII (and U+2028/U+2029, matched as their three bytes).

| | Copy (TSV) | Save TSV (`.txt`, `.tsv`, `.tab`) | Save CSV (`.csv`) | Save JSON (`.json`) |
| --- | --- | --- | --- | --- |
| Encoding | UTF-8 to main, then the clipboard | UTF-8 with BOM | UTF-8 with BOM | UTF-8, no BOM |
| Separator, end of line | TAB; CRLF on Windows, LF elsewhere; none after the last line | TAB; CRLF after every line | `,`; CRLF after every line | `[` LF, one compact object per line joined by `,` LF, then LF `]` LF; an empty result is `[]` LF |
| Header | Copy with Headers only; one header line per part | on | on | object keys |
| NULL and read errors | `NULL` | `NULL` | empty field | `null` |
| Text | CRLF, CR, LF, TAB and NUL each become one space (Windows ends clipboard text at a NUL) | CRLF, CR, LF and TAB each become one space | quoted when it holds `,` `"` CR or LF, `"` doubled, line breaks kept; an empty string is `""` | a JSON string: `"`, `\`, C0, U+2028 and U+2029 escaped, everything else raw |
| Binary, CLR types | `0x` + uppercase hex | same | same | `"0x…"` |
| Numbers | display text | same | same | tinyint, smallint, int, bigint, decimal, numeric, money, smallmoney, real and float as the display text when it is a JSON number, otherwise a string; bit as `true`/`false`; everything else a string |
| Column names | blank → `(No column name)` | same | same, as a field | blank → `Column{ordinal}`; repeats get `_2`, `_3`… |
| Truncated cells | the stored prefix, counted in `truncatedCells` | same | same | same |

`exportDefaults` (`src/main/results-jobs.ts`, owner decision 1) sets the saves' header row and NULL text; the backend
takes `headers` and `nullText` as parameters. `tests/fixtures/results-text/cases.json` holds the golden bytes, checked
against the C# writer (`TextChecks.cs`) and the fake backend's JavaScript twin (`tests/results-text.test.ts`).

- **`results.copy { resultId, parts, headers, eol: 'crlf' | 'lf', maxBytes: 1 … 67,108,864, viewId? }`** (stream). A part is 1 –
  64 ascending, disjoint inclusive row ranges (a last row of 2⁵³ − 1 runs to the end) by 1 – 64 column ranges; up to 64
  parts, written in order. Open-ended rows end at the rows available when the copy starts, and `partial` says the set was
  still open. Before any work, `EstimateBytes` (O(pages × columns): the stored text spans, `2 × bytes + 2` per binary
  cell, 4 per NULL, separators and headers; replacements never lengthen text, so it is an upper bound) over `maxBytes`
  answers `TOO_LARGE` ("The selection is too large to copy ({n} MB; the limit is {m} MB). Use Save Results As
  instead.") with no DATA. Otherwise the text streams as DATA bodies of at most 1 MiB under the usual credit rules,
  checked for cancellation per page, then the RESPONSE `{ rows, bytes, truncatedCells, partial }`.
- **`results.export { resultId, path, format: 'csv' | 'tsv' | 'json', headers, nullText: 'empty' | 'NULL', temporaryId, viewId? }`**
  (unary). The path must be fully qualified, without NUL and without a `\\.\` or `\\?\` prefix, and `temporaryId` 32
  hex digits that main chose (`INVALID_PARAMS`); the set must be complete (`RESULT_OPEN`). It writes
  `{folder}/.varia-{temporaryId}.tmp` (`CreateNew`, `FileShare.None`, 1 MiB chunks), checking cancellation per page,
  flushes it to disk and renames it over the target (a symlink there is replaced, not followed). A regular file it
  replaces keeps its permissions: on Linux and macOS the temporary file is created with the target's mode (never wider)
  and set to it exactly, and one replacing a symlink to a file gets that file's read and write bits, narrowed by the
  umask; on Windows `File.Replace` keeps its attributes and, where the user may set them, its ACLs (merge errors are
  ignored, so a share granted Change rather than Full Control still saves), keeping the replaced file as
  `.varia-{temporaryId}.bak` until it succeeds, so a replace that fails partway leaves the old file, or puts the new one
  in place, never neither. Any failure or cancel deletes the temporary file; the target is never touched before the
  rename. When the backend stops before it could (a crash, a kill, a restart), the export fails with `BACKEND_LOST` and
  main removes the temporary file itself, at once and again after the stop grace period, and the backup once the target
  exists. Failures are `EXPORT_FAILED` whose message is one token, never a path or an OS message: `ACCESS`
  (`UnauthorizedAccessException`, HRESULT 0x80070005), `IN_USE` (0x80070020, 0x80070021, and
  0x80070497 when `File.Replace` cannot remove a file another program holds), `DISK_FULL` (0x80070070,
  0x80070027, errno 28), `NOT_FOUND` (a missing folder), `IS_DIRECTORY`, otherwise `IO`.
- **Progress.** Both send droppable `{ type: 'job.progress', rowsDone, rowsTotal, bytes }` EVENTs at most every 250 ms;
  main validates them (`jobProgressSchema`) and pushes `varia:results-job { jobId, kind, rowsDone, rowsTotal, bytes }`
  at most 4 times a second. A save's pushes also carry `fileName` (the chosen file's name, never its path), and main
  pushes one as soon as the dialog closes, so the renderer's strip ("Saving {fileName}…") starts from the export, not
  from the dialog.
- **Main (`ResultsJobHost`).** `varia:results-copy { jobId, generation, resultId, headers, parts, viewId? }` and
  `varia:results-save { jobId, generation, resultId, format?, suggestedName ≤ 128, viewId? }` are `trusted()`, strictly
  validated, and checked against `ResultsPortHost.owns(generation, resultId)` and the ready generation
  (`RESULT_UNAVAILABLE`). A copy decodes the chunks with a streaming `TextDecoder` (so a character split across chunks
  survives), regrants their credit, cancels with `TOO_LARGE` past 64 MiB + 1 MiB received, and writes the clipboard once,
  on the RESPONSE, unless the copy was cancelled (its chunks after the cancel are dropped, so a RESPONSE the backend sends
  anyway ends it with `CANCELLED` and leaves the clipboard alone); a new copy cancels the running one. A save runs one at
  a time (`JOB_BUSY`), shows the native dialog
  ("Save Grid Results", the requested format's filter first, then CSV, Text, JSON and All Files) with the suggested name
  and extension sanitised as Script As's File… names are (`src/main/file-names.ts`; a name too long is cut in the tab's
  name, never in its `-Result{n}`), takes the format from the chosen
  extension (any other extension keeps the requested format, and none is appended, so the dialog's overwrite
  confirmation stays valid), checks ownership again, and returns only the file's
  name; `EXPORT_FAILED` tokens become sentences naming only that name. `varia:results-job-cancel` sends CANCEL reason 1;
  a page reload or closed window cancels with reason 3. Main shows the page's file dialogs and prompts one at a time
  (`src/main/dialog-queue.ts`): a Script As File… dialog asked for while Save Grid Results is open waits for it, where
  Windows and Linux would show it over the first. Paths come only from the dialog, never from the renderer, and
  reach only the backend.

## Live subscriptions

Periodic data (the Activity Monitor, SSIS monitoring, later Object Explorer status) flows through one stream method,
`live.subscribe`, and one control method, `live.update`. The backend schedules every sample; the renderer never polls.
A subscription names one **source** and 1 to 8 of its **probes**, each with its own interval; a probe emits metrics
(series values), up to 4 snapshot tables (replaced by each sample) and 4 append tables (that grow), and status values.
`src/shared/live/catalog.ts` declares every source and probe and what they emit; it generates [docs/live.md](live.md) and the
backend's embedded `Live/live-catalog.json` (`npx vitest run tests/live-catalog.test.ts -u`), and the schemas in
`src/shared/live/schema.ts` are built from it. The production schemas accept only sources that are not test-only: the
Activity Monitor's `activity` (server DMVs: `activity.overview`, `activity.sessions`, `activity.resources`, declared but not sampled yet, and `activity.queries`), Object Explorer's `explorer` (the
status chips: database states, restore progress, running Agent jobs, availability group health) and the SSIS tree's
`ssis.catalog` (scope `ssisdb`; its `ssis.catalogProbe` fingerprints the catalog for Object Explorer). The test source `debug.synthetic` is accepted only by main's test schemas (`ResultsPortHost` with
`testSources`, set only in unpackaged smoke runs) and by a backend with `VARIA_BACKEND_TEST_HOOKS=1`, as
`debug.results.synthesize` is. Both methods are port methods (`PortMethods`): the renderer reaches them only through the
results port, and a backend whose HELLO lacks either is refused.

**Request** (strict at every level; the backend checks the same rules against the same catalogue):

```ts
live.subscribe { subscriptionId: uuid, connectionId: uuid, source, probes: { probe, intervalMs: 1,000..3,600,000, paused?,
                 sort?: { column, descending, table? }[1..4], view?, filter?: { text: 1..400, columns?: id[1..8] } }[1..8],
                 args?, resume?: base64url ≤ 256 }
live.update    { subscriptionId, source, paused?, probes?: (the same, intervalMs optional, clear?: (sort | view | filter)[1..3])[1..8],
                 refresh?: true, track?: { probe, table, seq: u31, keys: str ≤ 512 [≤ 64], linger?: 0..keys }[1..8], args? }
```

Every probe belongs to the source and is named once; the interval is then clamped to the probe's own minimum and maximum.
Sort names columns of the probe's snapshot tables (catalogue column ids, not ordinals; the row key breaks ties); a key with
`table` sorts only that snapshot table and must name one of its columns, a key without it sorts every snapshot table that has
the column, and each column is named once per table (or once for all). A view must be one the probe declares, and a filter needs a probe with a filter mode. `args` is checked by the source's own schema
(`liveArgsSchemas`): `debug.synthetic` takes `{ rows?: 0..10,000, tickMs?: 10..60,000, endAfterTicks?: 1..10,000,
errorEvery?: 1..1,000, logRows?: 0..10,000, logLevel?: 0..3, lateEvery?: 1..1,000, start? }`, a sampling period below the 1 s
minimum so tests run fast (samples still report the requested interval), a sample count after which the source ends, an
error value every n-th table sample, and its log's messages per sample, lowest level, late messages and start. `activity`
takes `{ filters?: activity filter[1..7], focusSession?: 0..32,767 }` (`activityLiveArgsSchema`), at least one member: one filter
per table (`activityFilterSchema`: Processes' view chip and System and Varia toggles, the filter box ≤ 400 characters, ≤ 8
column value filters of ≤ 50 values ≤ 256 characters on the table's facet columns, Hide benign waits on Resource Waits), and
the session the sessions probe's two series follow (the Details flyout; 0 for none). The first sessions sample after
`focusSession` names another session is marked `gap: 'reset'`, so a chart starts the series again rather than join one
session's points to the next's. An update replaces the filters of the
tables it names and keeps the others; a table without one shows the catalogue's defaults (system sessions, Varia's pools and
benign waits hidden). The Activity Monitor's column ids are unique within a probe (its first table keeps the catalogue's ids,
the others take a prefix: `chainSessionId`, `activeCpuMs`; docs/activity-monitor.md), so one sort list orders each table by
its own columns and never reorders another.
`ssis.operations` takes the Integration Services Operations document's filters, `{ kinds?: ('execution' | 'validation' |
'deploy' | 'other')[1..4], statuses?: (1..9)[1..9], folder?: str 1..128, project?: str 1..128, package?: str 1..260, prefix?:
boolean, caller?: str 1..128, windowHours?: 1..8,760, limit?: 1..10,000 }` (kinds and statuses distinct and from the SSIS
catalogue; `Live/SsisOperations.cs` checks the same bounds again); new args replace the old ones whole (an absent member
does not filter) and read the window again. A source
whose append tables can start elsewhere than their first row takes `start` (`liveStartSchema`): `'beginning'`,
`{ tail: 1..200,000 }` (the last rows) or `{ before: 1..2^53−1 }` (the rows before an id, ending there). Tracking names a keyed
snapshot table by its index; each key is the key columns' stored cell texts joined with U+001F, and `linger` says how many
of the first keys stay one revision when they leave (all of them when absent). A source without append
tables has nothing to resume from and refuses `resume`; a token is base64url characters only (the backend matches the whole
string, so a trailing newline is refused on both sides). An update must change something, and repeats the subscription's
source; main and the backend check it matches. In an update, an absent setting keeps its value, so `clear` drops one: the
sort (back to the source's order), the view (all rows) or the filter, each named once and never alongside a new value for
the same setting; a subscribe refuses `clear`.

**Frames.** The first EVENT is `live.opened` (seq 0, before any sample): `{ source, band?, spid?, isolation?, probes: {
probe, intervalMs, minIntervalMs, maxIntervalMs, state: ok | limited | unavailable, reason?, note? ≤ 400 }[] }`. Then one
`live.tick` per scheduler wake that sampled something (seq 1, 2, …): `{ sampledAt: Unix ms (monotonic), spid?, resume?,
samples: { probe, costMs, effectiveIntervalMs, elapsedMs? (absent for the first), gap?: baseline | reset | resumed | late,
skipped?, metrics?: (number | null)[], tables?: { table, descriptor, revision, retired?: u32[≤ 2], diff?: { added,
removed, changed }, tracked?: { seq, rows: (row | −1)[≤ 64] }, departed?: row[1..64], facets?: { column, values: { text ≤ 128,
count }[≤ 100], more?: true }[1..7] }[≤ 4], append?: { table, descriptor, segment, rolledFrom?, retired?: u32[1..8], restarted?: true
}[≤ 4], status?: { id, value: integer | str ≤ 128 }[≤ 16] }[≤ 8], errors?: probe error[1..8] }`. A probe
error is a value, never an exception, so the other probes carry on: `{ probe, code, message ≤ 2,000 (a sentence, never SQL,
names or values), number?, retryInMs, terminal, tables?, series? }` (the tables or series one failed statement of the
probe's batch would have filled; a probe can report more than one error in a tick, such as `BUDGET` for one table and
the failed statement of another, and `terminal` is true only when the probe stopped, never beside its sample), with `code` one of BLOCKED, TIMEOUT, PERMISSION_DENIED, NOT_SUPPORTED,
DATABASE_UNAVAILABLE, CONNECTION_LOST, SQL_ERROR, AUTH_KERBEROS, AUTH_ENTRA, BUDGET, BUSY, CATALOG_MISSING, NOT_FOUND or
LOGIN_FAILED.
Main checks every frame against `liveEventSchema` (each probe sampled once, metrics aligned with the catalogue's series,
tables named by their catalogue index with the catalogue's column names in order, at most 8 tables in a tick, departed rows
only for a table that keeps them, facets only for its facet columns and at most 32 KiB of facet text (UTF-8) in a tick, status
ids the probe declares, error tables and series the probe has, and `seq` 0 and then one more each time) and against the
subscription it arrived on (`liveEventFits`, in the supervisor): `live.opened` names the subscription's source and reports
each subscribed probe once, and a tick samples or fails only subscribed probes, so another source's or an unsubscribed
probe's tables are never owned. It stamps the generation on every descriptor. The catalogue's worst-case tick (every list at its maximum, every string in
three-byte characters) encodes to at most 192 KiB (`tests/live-schema.test.ts`); a tick over 256 KiB is never sent: the
backend ends the subscription `failed` with `BACKEND_ERROR`, a bug rather than a silent drop.

**Tables** (`Live/LiveTables.cs`; each table's own settings are in docs/live.md). Every table is a stored result the worker
reads with `results.read`, as a query's is: its cells are the text a query of the same value shows (CellFormat), every column
`text` on the wire, so Copy and Save treat it as any result. A source gives a table's rows from a SQL Server result set or
from its own state; the writers do the rest.
- **Snapshot tables.** Each sample writes a new result (a revision). Two stay readable: the newest, and the one before, which
  the renderer may still show until it applies the newest; stop and wait means it has, so writing revision k+1 first releases
  k−1 and names it in `retired` (a revision that could not be stored names it in the next one that is). A revision applies the
  probe's view (a predicate the source gives for each view id it declares), then its filter (`filterMode: 'memory'`: the
  stored text contains the filter text, case-insensitively, in the named columns of that table, or in all of them; columns
  of another of the probe's tables leave this one whole), sorts by the probe's sort keys for it (numbers as numbers, NULL
  first ascending, text case-insensitively and then exactly), then by the key, so equal values never trade places (a table
  that no key names keeps the source's order), and stores at most the
  table's row cap (`rowLimit` past it, the rows the source left out counted in `rowsRead`). `diff` counts keys added and
  removed and kept keys whose cells changed (a 64-bit hash of their texts); `tracked` gives each key of the latest track list
  its new row or −1. A key is its key cells' stored texts joined with U+001F, NULL as empty text, so it equals what the worker
  decodes. A table with `departed` keeps a tracked row that left the source (not one its view or filter hides) for one more
  revision, at the row it had, and lists it in `departed`; the next revision drops it. Only the track list's first `linger`
  keys stay (LiveGrid's selected rows); the others are answered −1 at once. Facet columns carry their distinct
  values over every row the source gave that its facet scope keeps (before the view and filter; NULL left out; the
  Activity Monitor's Processes counts only the rows its view chip and toggles show, before its filter box and column value
  filters, so it never offers a value only hidden sessions have, and a column's own filter never empties its list), most frequent first, at most 100 of at
  most 128 characters (values that differ only past them count together), and only when they changed since the table's last
  facets; a tick's facet text is shared by its tables up to 32 KiB, counting only the facets a sample sends, and what does
  not fit is left out (`more`) for a later tick to send.
- **Row tones.** A table may end with a tone column (catalogue `role: 'tone'`, an nvarchar that is never a key or facet, and that no sort or filter names; a filter over every column leaves it out, so its text never matches):
  each cell is `error`, `warning`, `running`, `muted` or NULL. The stored result's column keeps the role
  (`ResultColumn.role` `tone`), so the grid hides it and colours the row instead (LiveGrid, below), and Copy and Save
  Results As leave it out of every part, header and JSON object whatever columns a request names (`ResultJobs` through
  `ResultTextWriter.Hidden`; a part of only the tone copies no text).
- **Append tables.** One result (a segment) grows by the rows a source reads above the table's settled id, ordered by its one
  key, an integer id. Ids are assigned at insert, not commit, so a lower id can become visible after a higher one (under READ
  COMMITTED, or for an instant under READ UNCOMMITTED): each read covers every unsettled id again (the source reads `@top` =
  the table's rows per tick plus its unsettled ids above `@after` = its settled id), and rows already appended are skipped by
  id, so a late row is appended once, in arrival order. An id settles once first seen the table's settle ticks and
  milliseconds ago (2 and 5 s by default); unsettled ids stay within twice the rows a tick reads, the lowest settling early past
  that. Each write seals what it appended, so the rows are readable at once, and a sample carries the table only when it
  changed. At 200,000 rows or 32 MiB a segment completes and a new one starts (`rolledFrom`). Two segments' worth are kept: on
  a roll, the oldest completed segments are released and named retired while the completed ones hold more than one
  segment's 200,000 rows or 32 MiB, and two or more are left; a segment that stopped early for memory counts only what it
  holds, so the rolls after a budget stop cost no segment while the table stays under its caps. A table holds at most 8
  stored results (the current segment included); past that the oldest goes whatever it holds. A read opens at most one segment, since a sample describes only the newest: rows past a
  second one wait for the next read. A probe whose filter mode is `restart` passes its filter to SQL Server as a LIKE pattern
  (`@filter`, wildcards escaped, `ESCAPE N'\'`); a new filter, or args that change what a source reads, start the table
  again: every segment is retired (`retired` up to 8) and the next sample says `restarted`. The old segments stay
  readable until the restarted table's first read arrives, so a read that fails after a restart leaves the view whole;
  they are released only together with the new segment's open, so the sample that names them is always sent: when the
  budget refuses that open, they go first and their bytes pay for its metadata, which nothing else can take in between. A start at the last rows, or
  before an id, begins with a note row ("n earlier rows are not shown.", in the table's first text column, the other cells
  NULL); a start before an id also ends the table there (`@before`). Rows that were not stored (out of budget, or past a
  second segment) are never counted as seen, and no id at or above the lowest of them settles, so a later read stores them,
  once.
- **Memory.** Each revision and segment has its own budget, so one that does not fit never stops later ones, and a
  subscription's tables share 64 MiB; all live tables together stay within a quarter of the result budget (a revision past
  the subscription's limit says `queryBudget`, past the live share `globalBudget`), so queries keep the rest. A table that
  ran out stores what fits and the probe reports `BUDGET` naming it; one that stored nothing reports `BUDGET` alone; either
  stores again once memory is free, without giving up what it holds: an append table whose segment ran out keeps it
  (complete) and opens the next only once a row fits, never retiring a segment to make room. Live results seal 64 KiB pages, under the large object heap's threshold, and their
  releases do not count toward the store's forced gen2 collection (after every 64 MiB released), which a 1 s snapshot of a
  large table would otherwise run every few seconds; the snapshot churn benchmark measures the collections that remain.
- **Ends.** A source that ends keeps each snapshot table's newest revision and each append table's segments (the newest
  first), complete and readable, within the 64 kept results; every other end releases them all.

**Credit: stop and wait.** This is the one place EVENTs are credited, flagged by `creditedEvents` in `methodPolicies`.
- The REQUEST carries `credit: 65,536`.
- **Producer rule** (`RequestContext.TrySendCreditedEvent`): the backend queues a live EVENT, on the control lane and never
  droppable, only while its available credit is back to the initial credit (nothing unacknowledged); the body length is then
  subtracted, overdrawing by at most that one frame. The source samples nothing while a frame is outstanding
  (`WaitForAckAsync`), so a slow, hidden or hung renderer stops SQL Server work after one tick.
- **Main's rule** (`BackendConnection.route`): an EVENT of such a request is accepted only when granted − received ≥ the
  initial credit and the body is at most 256 KiB; it then counts as received. Anything else, and any DATA frame on such a
  request, is a contained violation (`STREAM_PROTOCOL`, CANCEL reason 3), as an over-credit DATA frame is.
- **Acknowledgement.** Main posts `{ t: 'live', rid, bytes, event }` to the worker, which relays it to the page without
  decoding anything; `ResultClient` applies the event's tables and forgets what it retired, the page applies the event
  and calls the stream's `ack(bytes)`, and only then does the worker send the existing `{ t: 'credit', rid, bytes }`. The
  worker grants back at most the bytes the stream's events took and the page has not acknowledged yet (more, twice, or
  for a stream that ended is dropped), and `ResultsPortHost` and `BackendConnection.credit` both clamp an acknowledgement
  to the bytes outstanding, so no acknowledgement, however large, lets two frames be in flight. A page that never
  acknowledges an event (hung, or applying it failed) stops the source after that event.
- **Schedule.** Fixed rate per probe: a probe due while a frame is unacknowledged, or late for any reason, is sampled once
  when it can be, with `gap: 'late'` and the slots it missed in `skipped`, never replayed in a burst. The first sample is
  `baseline`, the first after a pause `resumed`; `refresh` makes every unpaused probe due now (see the scheduler, below).

**End** (the RESPONSE): `{ ended: cancelled | disconnected | sourceEnded | failed | shutdown, code?, message? (failed
only), kept?: u32[≤ 64] (sourceEnded only), resume?, ticks, elapsedMs }`. CANCEL with reason 1 or 3 ends it
`cancelled`, reason 4 or the backend's shutdown `shutdown`, and `connections.disconnect` of its connection id
`disconnected`. When every probe has stopped for good (each terminal, or opened unavailable) it ends `failed` with the
first probe's own error code (a live code such as `PERMISSION_DENIED`, which `liveEndSchema` accepts beside the request
codes) and message, since nothing would ever be sampled. Every end but `sourceEnded` releases the subscription's results first; `sourceEnded` keeps `kept`
readable until the renderer closes them with `results.close`.

**Update answer:** `{ applied: true, probes: { probe, intervalMs, effectiveIntervalMs, paused }[] }` for every probe of the
subscription, applied at once to the settings its next wake uses. An unknown subscription is `NOT_FOUND`, one that is
ending `CANCELLED`.

**Ownership.** `ResultsPortHost` owns each table a tick carries (so the worker can read it with `results.read`), takes
back on `retired` only the stream's own results (never a query's or another stream's), and when the stream ends takes back
all of its results except a finished source's `kept`. Closing the port cancels its live streams with reason 3 and takes
back their results; a stream whose answer was already on its way (`sourceEnded` with `kept`) then has no reader, so main
closes what it kept with `results.close` (while that generation is still ready) rather than leave it in the budget.

**Backend** (`Live/LiveService.cs`): a registry by subscription id, at most 32 in the backend and 8 per SQL Server
(`BUSY`: "Too many live views are open for this server. Close one and retry."), a duplicate id `DUPLICATE_REQUEST`. The
per-server count goes by the server a connection reaches (`SERVERPROPERTY('ServerName')`, probed at connect, or the
connection's data source when that probe failed), so two connections to one server with other logins or databases share
its 8; a source that reaches no server (`debug.synthetic`) counts by connection id. Both refusals come before the source's
sampler is built, and a sampler acquires nothing (store, pools, connections) until the subscription runs, so a refused
request never touches what a running subscription holds. Each subscription is one task with its own schedule, so it never
overlaps itself; a source runs its due probes through an `ILiveSampler`. `debug.synthetic` (`SyntheticSampler.cs`) runs
no SQL, and its tables go through the same writers as the SQL sources' (Tables, above): its metrics probe counts samples and
draws a wave (the rate is null until a second sample); its table probe stores one snapshot per sample whose rows move on by
one id each time, so rows leave at the top and arrive at the bottom; its status probe reports the phase and the sample
count; its grid probe stores two snapshot tables from one sample, items (a view, facets, departed rows, a row tone by group)
and their groups,
which come from the source's own state rather than a query, and with `errorEvery` fails the groups alone, as one failed
statement of a batch would; its log probe grows an append table from an in-memory log (toned by level), with late
messages, a start, and a restart when its filter or level changes; and its wide probe stores the 23-column snapshot the churn benchmark swaps,
reporting the backend's gen2 collections. Its scope is `none`, so any connection id is accepted;
other scopes need a connected one (`NOT_CONNECTED`). Nothing is logged.

**Scheduler** (`LiveSubscription` in `Live/LiveService.cs`; every rule below runs on times passed in, and the offline
checks drive it on a fake clock):
- **Phase.** A subscription starts, and resumes after a pause, at a random point within a quarter of its first second,
  one phase for all its probes, so views opened together never wake together while a view's probes share ticks (one round
  of SQL and one frame).
- **Quick second sample.** After a sample the source marks `baseline` or `resumed` the next is due within a second (rates
  need two), then the probe settles on its interval. The sample decides, not the schedule: a source also starts again from
  a baseline after a failed first attempt or a lost connection. A `baseline` sample never carries `skipped`.
- **Refresh** makes every unpaused probe due now, but never within its catalogue `minGapMs`, nor its minimum interval, of
  its last attempt, so refreshes in a loop never run a probe more often than its fastest interval would. A probe that is
  backing off keeps its delay and its failure count (a refresh never hammers a failing server or sign-in); one a terminal
  error stopped starts again from a clean count (not one the source opened unavailable).
- **Error back-off.** The first failure retries at the interval; after f failures in a row the next try is
  min(interval × 2^(f−1), cap) × U(0.9, 1.1), where the cap is 60 s or the asked interval when that is longer. A sample
  resets the count. `BUDGET` retries at the interval without backing off (memory may free at any time); a terminal error
  (`PERMISSION_DENIED`, `NOT_SUPPORTED`, `LOGIN_FAILED`) stops its probe (`retryInMs` 0). Every error in a tick carries `retryInMs`.
- **Load guard.** An EWMA (α 0.3) of each probe's `costMs`: over its catalogue `maxDutyCycle` (0.25 by default, 0.2 for
  `activity.*`) of the interval in force for 3 samples in a row doubles that interval, up to the cap; under 10 % for 10
  samples halves it back toward the asked one. Samples report the interval in force as `effectiveIntervalMs` (so the UI
  can say "slowed to 4 s"), and so does the update answer. A new interval from `live.update` starts the guard again.
- **Idle.** While every probe is paused, when the next sample is at least 30 s away, and between the samples of probes
  whose intervals in force are all 30 s or longer (the wait after a sample is a little under the interval; never before a
  quick second sample), the source gives back its connection (to the pool, healthy), and opens one again when a probe comes
  due. A subscription whose probes all start paused opens none until one resumes.

**SQL sources** (`Live/SqlSampler.cs`; scope `server`, the `activity` source, and scope `ssisdb`, the `ssis.catalog` and `ssis.operations` sources): one
pooled connection per subscription from the scope's pool, the connection's own **" - Activity Monitor"** pool for server DMVs
and its **" - Integration Services"** pool (the SSIS tree's and `ssis.describe`'s, with Initial Catalog the catalog's
database, `SSISDB`, or the checks' fake catalog through the internal `SsisOptions.CatalogDatabase`) for SSISDB (`LiveConnections`; both registered with the connection's pools, so a disconnect clears them),
held while it samples so its session id is known (`live.opened`'s `spid`; a tick carries `spid` when it reopened). Every command starts with its prologue, since a pooled connection can carry another command's SET
state: `SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;`
for server DMVs and SSISDB without READ_COMMITTED_SNAPSHOT, `READ COMMITTED` instead for SSISDB with it. Connecting takes
no live gate (a server that stopped answering a login never holds one that views on other servers need) and has its own
15 s bound, a `TIMEOUT` value past it, since a profile's Connect Timeout may be 0 (none); a connect that failed in a tick
is reported for that tick's other due probes rather than tried again at once. Opening connects and runs one session
probe (2 s budget, under a gate; with the gates full, the first tick runs it): `@@SPID` and `HAS_PERMS_BY_NAME` for VIEW
SERVER PERFORMANCE STATE (SQL Server 2022 and later) or VIEW SERVER STATE (earlier, Managed Instance), the permission name
a parameter; for an SSISDB source it also reads the catalog's `is_read_committed_snapshot_on` (`sys.databases` by the catalog's
name, a parameter), which picks the prologue of its later commands and `live.opened`'s `isolation`, and whether the login is
sysadmin or in ssis_admin (`IS_SRVROLEMEMBER` first, so a sysadmin's `IS_MEMBER` is never evaluated): only they may read
`catalog.catalog_properties`. The catalog probe has two constant texts, neither taking a parameter (a parameter would run the
command through `sp_executesql`, which scopes the prologue's SET options to it): one that reads catalog_properties, for them,
and one without it (its count and checksum 0) for everyone else, so nobody else's sample touches it. An SSISDB source whose connection cannot open the catalog's database without saying why (4060,
916) reads why on a connection of the same pool in the login's own database (`sys.databases` state and user access, under a gate
and the probe's budget): no row is `CATALOG_MISSING` (terminal), a database that is not online, single-user or restricted
`DATABASE_UNAVAILABLE` (retried), and an online one the login may not open `PERMISSION_DENIED` (terminal), each with its own
sentence; an open whose errors already say the database is unavailable (942, 976 and the others below) is not looked up; when that read fails too, the open's
own error is classified as below. The Activity Monitor's source runs its capability probe in its place (Activity/ActivitySql.cs `Capabilities`):
the session id and whether the login reads server state, may end sessions (ALTER ANY CONNECTION) and sees every file's name
(VIEW ANY DEFINITION), and whether the query statistics have spills; its sessions probe sends the first two as the status
values `serverState` and `canKill` with every sample (each new connection's capability probe reads them again), so a
view that attaches later, or keeps only the latest sample, knows them. A subscription whose probes all start paused connects for neither until one resumes (no SQL while paused). A probe whose catalogue gates (version
from its band, where Managed Instance counts as the newest; EngineEdition) exclude the server opens `unavailable`
`NOT_SUPPORTED`; one that needs server state the login lacks opens `unavailable` `PERMISSION_DENIED`; neither ever runs.
When the session probe did not run as the source opened (every probe paused, the gates full, the connect failed), such a
probe opens `ok` and stops at its first tick with a terminal `PERMISSION_DENIED`, running nothing; so does one whose new
connection's session probe finds the permission gone. SqlSampler checks this for every probe, one-batch or reader.
A connection that fails to open there is reported by the first tick instead. Each statement waits for a live gate (at most
its budget, else `BUSY`), then runs with `CommandTimeout` 0 under a cancellation token that fires at its budget: 0.8 ×
the asked interval within the probe's `budgetMs` (500 ms to 5 s by default; never above 10 s), so a 2 s overview has 1.6 s,
more than `LOCK_TIMEOUT`; the catalog probe's range is 500 ms to 10 s, SSISDB's budget. A source with several statements per probe (`ILiveSqlReader`; the Activity Monitor's
`ActivityReader`) runs them one at a time on the same connection within that one budget and builds the probe's series and
rows in C#; its statements are `ActivitySql`'s constant text, checked by their own lint and the live lint, each read checked
against the columns it declares (a mismatch is a bug: `BACKEND_ERROR`). A statement the login may not run (`PERMISSION_DENIED`)
or the server lacks (`NOT_SUPPORTED`) fails alone: the sample goes on, an error beside it names the tables and series that
statement feeds, and it is not run again on that connection, only reported each sample (each new connection's capability
probe runs it again: the login may since hold the permission, or the connection reach another server). A lock wait or another statement
error stops the probe's statements: what was read arrives and the error names the rest; a probe that read nothing reports
its first error and backs off; a lost connection or the budget fails the probe as below. Without server state the sessions
probe reads one statement (the caller's own session: SQL Server shows such a login nothing else) and reports Blocking and
Active Expensive Queries as `PERMISSION_DENIED` beside each sample without SQL. Probe SQL of the other sources is constant
text per probe and band in `Live/LiveSql.cs` (Object Explorer's status probes and the SSIS tree's catalog probe; the live
checks register theirs): one batch per probe, its metrics row (when it has series or status values) with the columns it
declares, mapped to the catalogue's series and status values (whole numbers, sent as they are; a probe of status values
alone sends no metrics and no `baseline` or `resumed` gap, so it has no quick second sample), then one result set per table, in
catalogue order, whose column names and types must be the table's (the types live tables store: integers, text, bit, float,
real, decimal, the date and time types and uniqueidentifier; a column of another type, or a query that does not read each of
its probe's tables once, in order, fails the open as a bug). An append table's read takes `@after{i}`, `@top{i}` and
`@before{i}` (i its index) and may name a tail statement that returns `(after_id, earlier)` for `@tail{i}` rows, for a
start at the last rows. A snapshot result set is read up to 10,000 rows. When one statement of the batch fails after earlier
ones returned, the tables already read arrive and the error names the rest (`tables`), so the tick goes on; values only as
parameters; no metadata built-ins (they ignore
`LOCK_TIMEOUT` and the isolation level), temporary tables, `SELECT … INTO`, writes, DDL, transactions, `WAITFOR`,
`EXEC` or `sp_executesql`, remote reads (`OPENQUERY`, `OPENROWSET`, `OPENDATASOURCE`), comments (they belong in C#), and
no `TOP`, with or without parentheses, without an `ORDER BY` at its own level (one inside `OVER (…)` or another statement
orders nothing it takes). An offline lint renders every probe at every band and refuses all of those, reading literals,
comments and bracketed or quoted names as SQL Server does, so a quote in one hides no code from it and a built-in spaced
from its parenthesis still counts. Values are read by the column's declared position, so every read first checks the
result's columns against the declaration (names, order, count, numeric types); a mismatch is a bug, which ends the view
`failed` with `BACKEND_ERROR` rather than put one series' value in another's. The live checks also run every query at the
server's band and compare its columns (the SSISDB ones against the fake catalog).

**Readers.** A source whose probe runs several statements and builds its rows in C# (`ILiveSqlReader`,
`Live/LiveSqlReader.cs`) keeps everything else of a SQL source: the pooled connection, the live gates, one budget for all
of a probe's statements, the delta engine, the table writers, back-off and error mapping. Its own session probe replaces
the one above, and it may choose the prologue its statements run with. A statement error that breaks the connection or the
budget fails the probe as a batch's would; one that concerns a single statement is a value in the sample, naming the tables
or series it feeds. `ssis.operations` (`Live/SsisOperations.cs`) is one: its session probe reads `@@SPID` and whether the
catalog's database has `READ_COMMITTED_SNAPSHOT` on (`sys.databases`, the name a parameter), which picks `READ COMMITTED`
or `READ UNCOMMITTED` (owner decision 4); catalog views need no server permission, since row-level security shows a login
only what it may read. Its one probe, `ssis.operations.list`, keeps the window in backend state (a snapshot table
materialised from it, not from one result set): a baseline, after the first sample, new args or a lost connection, reads
the newest `2 × limit` operations of the scope that are open or were created in the window and pass the status filter (an
open one the status filter hides is read too and followed unseen, since it can still end in a status the filter shows),
and apart the newest `2 × limit` open operations of the scope whatever their age, so a busy hour of finished ones never
crowds out a long run; each later sample reads the operations above the newest id it has settled (an id settles after the
operations table's `settle` in the catalogue, 2 samples and 5 s, since SQL Server assigns an identity before its row
commits, so a lower id can appear after a higher one; a row read twice replaces itself) and the open ones it holds again by
id (an `xml` list `@open`, at most 256 a sample, in turn when there are more; a row no longer found leaves: the catalog's
retention cleanup removed it, or a dirty read was rolled back), then drops what it neither shows nor follows and keeps
`limit` rows, the open ones first and then the newest. The scope (kinds, names, caller) matches an execution's folder,
project and package (`catalog.executions`), a validation's folder and project (`catalog.validations`), and a deployment's
project (its `object_name`), all joined by id. The tiles ignore the scope, the status filter and the limit: every sample
counts the running and pending operations (`COUNT_BIG … WHERE status IN (2, 5)`), and every 30 s (and with each baseline)
the same batch counts the last 24 hours by final status, which samples in between repeat. Lists go in as `xml` parameters read with `.nodes('/i')` (any compatibility level), names
as `LIKE` patterns with their wildcards escaped (`ESCAPE N'\'`, a trailing `%` for a prefix), times stay
`datetimeoffset`, and the SQL passes both the live lint and the SSIS lint. A connection that cannot open the catalog's
database (4060 or 916) reads why on the same pool in the login's own database: no `sys.databases` row is
`CATALOG_MISSING` (terminal) for a login with VIEW ANY DATABASE, and `PERMISSION_DENIED` (terminal) for one without it,
which sees no row of a database it cannot open; one that is not online or is single-user or restricted is
`DATABASE_UNAVAILABLE` (retried), and an online one the login may not open is `PERMISSION_DENIED` (terminal). The
renderer's `LiveHandle.refresh` subscribes again to a view that ended `failed` or was refused (Retry), never to one that
was disconnected or whose source ended. A server on Linux, or one older than SQL Server
2016, opens the probe `unavailable` `NOT_SUPPORTED`.

**Errors** (`Live/LiveErrors.cs`): 1222 and 1205 are `BLOCKED`; the budget is `TIMEOUT`; 297, 300, 229 and 262
`PERMISSION_DENIED` (for an SSISDB source, with its own sentence: the login cannot read the catalog) and 207 and 208
`NOT_SUPPORTED` (both terminal; so are an SSIS source's `CATALOG_MISSING`, above, and `NOT_FOUND`); 4060, 911, 942, 952 and the other offline,
restoring and single-user numbers `DATABASE_UNAVAILABLE`; severity 20 and above and transport errors
`CONNECTION_LOST`; a Kerberos or Entra sign-in failure while reconnecting `AUTH_KERBEROS` or `AUTH_ENTRA` with its own
advice; a login SQL Server refuses while reconnecting (18456 failed, 18486 locked out, 18487 and 18488 password expired or
must change, 18452 untrusted domain) `LOGIN_FAILED`, terminal, since retrying alone would only count more failures against
the login and could lock it out; anything else `SQL_ERROR` with SQL Server's text. Messages are sentences that name no object or value. A lost
connection or a budget cancel drops the connection without returning it to the pool (its pool is cleared), and the next
due tick reopens it under the back-off, for as long as the view runs; only `NOT_CONNECTED` (the connection id is gone)
ends the view `disconnected`. Nothing is logged.

**Deltas** (`Live/LiveDeltas.cs`): the backend keeps baselines only; history is the renderer's. Each series has a counter
kind in the catalogue: `gauge` (as read), `rate` and `msPerSecond` (change per second), `ratio` (change over a base
counter's change; none when the base did not move) and `cpuPercent` (100 × Δ CPU ms / (elapsed × schedulers), 0 to 100).
Elapsed time is the server's own (Δ`ms_ticks` of `sys.dm_os_sys_info`) when the probe reads it, so a slow round trip never
skews a rate, and the backend's clock otherwise; `elapsedMs` reports it. A changed start time (a restart) drops every
baseline (`gap: 'reset'`), and a reader's series that follow something else from a sample on (the Activity Monitor's focus
series, another session) mark that sample `reset` too; a counter that went down rebaselines alone (null, `reset`); the first sample, the first after a
pause and the first after a lost connection (which may have reached another server) have no rates (`baseline`,
`resumed`); a sample over 3 intervals after the previous one is `late`. Reopening a connection that went back to the pool
while idle keeps the baselines. `LiveKeyedDeltas` keeps per-row baselines for snapshot rates (L2b's tables): keyed by an
identity column (a request's start time), bounded by the row cap, dropped after two samples absent, and each with the time
it was read at on the probe's sample clock, so a row missing from a sample gets a rate over its own span when it returns.
The Activity Monitor's per-session CPU and reads use their own rule (`SessionRates` in `Activity/ActivityRows.cs`): a
session's counters take in a request's work only when it ends, on a smaller scale than the request reported, so each
running request (by id and start time; a MARS session has several) counts by its own change, a new one whole, and the ended
ones only beyond what they had counted (never negative, nothing twice).

**Resume tokens** (`Live/LiveResume.cs`): base64url of `{"v":1,"source":…,"cursors":[[probe,table,settledId],…]}`, at
most 256 characters (a set of cursors that would not fit makes no token), parsed strictly against the subscription's
source and its append tables (`INVALID_PARAMS` on any other shape, a repeat or an unsafe id). A tick carries `resume` only
when a cursor moved, the end carries the last one, and a subscription resumed with one hands its source the cursors: each
append table starts after the id its cursor settled. A source without append tables (the Activity Monitor) refuses
`resume`.

**Renderer.** The results worker relays live requests and events, and `ResultClient.live` runs a stream ([Results port
and results worker](#results-port-and-results-worker)). Views never call it themselves: they open a `LiveHandle` from
`LiveService` (`src/renderer/src/live/LiveService.ts`, `workbench.live`), which owns the whole lifecycle.

- **Open.** `live.open(spec, owner)` subscribes at once with each probe's catalogue default interval unless the view asks
  for another (clamped to the probe's minimum and maximum). The owner says whether the view can be seen and what it follows:
  `documentOwner(tabId)` is visible while its tab is the active document and the editor area shows, follows the tab's
  connection, and closes with the tab. The SSIS tree's views (`SsisTreeProbe`, `src/renderer/src/ssis/`, one per
  connection whose SSISDB node is open, at most one per server row) belong to Object Explorer: visible while its pane
  shows, and following the connection while its server row is in the tree; closing SSISDB disposes the view. They are not
  `background` views: each holds an ordinary slot. At most 16 views hold a slot in a window (main's 16 streams on the port). A
  `background` view (`LiveSpec.background`: Object Explorer's status, one per connected server and login, owned by the
  pane, which `ExplorerStatusService` opens, moves to the next connection of the same server and login when its own goes,
  and disposes once it ends, opening it again on Refresh) takes only a slot no other view wants, at most 8 of them: one
  opened without a free slot waits (`status: 'dormant'`, `waiting: true`, running nothing), and a view that opens when all
  16 are taken takes the newest running background view's slot, which stops and waits again; the new view subscribes once
  that stream's end has arrived, as after a Reconnect, so main never sees a 17th. A view that closes hands its slot to the
  oldest waiting background view, which subscribes after the closed view's stream has ended (or, hidden, stays dormant
  until it shows). With every slot held by other views, another view, or one naming probes its source does not have, is a
  handle that has already ended with `TOO_MANY_REQUESTS` or `INVALID_PARAMS` as a value, never an exception, and runs
  nothing. The backend's 8 per server and 32 per backend count background views too, so they give way there as well: a
  view the backend refuses with `BUSY` before it opens takes the newest running background view's slot on the same server
  (`serverOf`: the server the connection names, as typed; without it, the same connection) and subscribes again once that
  stream has ended, once (a second refusal ends it with `BUSY`; with no such background view it ends at once). A
  background view the backend refuses waits instead of ending, and tries again when a view of the window closes.
- **Frames.** Each event is applied synchronously in the port message's own task (states, the probe's history ring, its
  tables as `ResultHandle`s), then `onTick` listeners run (an exception there is reported and changes nothing), and only
  then is it acknowledged. Snapshot listeners hear of it once an animation frame, however many frames arrived.
- **Hidden.** A view whose owner is hidden, or whose window is (`document.visibilityState`; test mode's `setPageHidden`),
  for `liveData.pauseAfterSeconds` (2 s) sends `live.update { paused: true }`; shown again it sends `paused: false` at once.
  A view opened or reconnected while hidden counts from then, and a change of either delay applies to views already
  hidden, counted from when they hid. Hidden for `liveData.stopAfterHiddenMinutes` (5 min) it cancels its subscription (the backend releases what it held) and
  is `dormant`; shown again it subscribes again with a new subscription id and the last resume token, and its history
  continues after a gap. With `liveData.pauseWhenHidden` off, hidden views keep running. A source may allow
  `hidden: 'statusOnly'` (none does yet; the backend's JSON carries the field, but only the renderer acts on it):
  a view that asks for it with `whileHidden` keeps its probes without tables at `limits.live.hiddenIntervalMs` (30 s) or slower instead of pausing, never
  goes dormant, and pauses its table probes; at most 4 such views a window, the rest pause. A view that ends, is lost,
  closes or shows gives its slot to the oldest hidden view that paused only because none was free.
- **Pause, settings, refresh.** The user's Pause is `paused: true` and visibility never undoes it. Probe settings
  (interval, pause, sort, view, filter) changed within 150 ms go as one update, with `clear` for what a change drops.
  Updates wait for `live.opened` (the backend registers a subscription just before it and refuses an earlier update
  `NOT_FOUND`), then go one at a time, in order, each computed from what the backend last accepted, so a resume never
  overtakes its pause. A refused one leaves the view showing what the backend still runs (a refused pause never reads
  Paused), with the reason in `error` and on the indicator; `TOO_MANY_REQUESTS`, `BUSY`, `TIMEOUT` and
  `BACKEND_UNAVAILABLE` refusals go again after 1 s, doubling to 30 s, any other with the view's next change, and the next
  accepted update clears the error. A view subscribing while paused pauses every probe in `live.subscribe` (there is no
  subscription-wide pause there) and unpauses them when it resumes; a view opened with `paused: true` (a paused Activity
  Monitor's Retry) is paused by the user from the start, so nothing samples before its pause could reach the backend. `setArgs` changes the source's `args` in place (the
  history and state carry on, and later subscriptions use them). Refresh sends `refresh: true` (a dormant view subscribes
  again); `track` sends a keyed table's tracked keys (and how many linger) with a new `seq` each time, and a new
  subscription sends them again with new ones. `probeOptions(probe)` reads a probe's settings as the view wants them (a
  copy), so a grid built again shows the sort its probe has.
- **Ends.** A backend that went away (`BACKEND_LOST`, `RESULT_UNAVAILABLE`, `BACKEND_UNAVAILABLE`) leaves the view `lost`
  with its history and its tables' handles (they read `lost`); nothing resubscribes by itself, since the connection went
  with its backend. When the owner moves to another connection (Reconnect retargets the tab), the view subscribes on it
  once the old stream's end has arrived (main and the backend count a cancelled stream until then, so a full window or
  server keeps the view's slot); a dormant view stays dormant until it shows. When the owner loses its connection, the
  view ends `disconnected`. Every other end is `ended` with the backend's reason. A finished source's kept tables stay
  readable until the view closes, which releases every result it kept (an append table's older segments too, which the
  view does not show yet); if the source finished while the view's cancel was on its way,
  `ResultClient` closes what it kept at once.
- **History.** `MetricRing` (`live/ring.ts`) keeps each metrics probe's samples in typed arrays: a sample's time, its gap
  and reset flags and one value per series (missing values NaN), with binary search by time and min and max per series.
  Its capacity is `liveData.historyMinutes` at the probe's interval, at most 7,200 samples, then fitted to 4 MiB a view and
  32 MiB in all, keeping the newest samples. It lives in renderer memory only, so it survives a backend restart.
- **Charts.** `ChartView` (`live/ChartView.ts`, imperative like `GridView`) draws one probe's ring on a canvas, and
  `LiveChart` (`live/LiveChart.tsx`) mounts it with its legend and "View as table"; React renders nothing per point.
  Series are lines, a line over a faint area, or stacked bands parted by a one-pixel line of the surface; a chart is a
  full chart (labels for the scale's top, or value and time axes) or a sparkline (one trace, no text). The window is the
  last `spanMs` up to the newest sample, or up to a fixed time. A draw happens at most once an animation frame (a tick,
  a ring resized by `LiveService` (`onRings`), a resize, a theme, forced-colors or color-scheme change asks for one), only
  if the ring's revision, the window, the size, the pixel ratio, the theme, the forced palette or the crosshair changed (a crosshair or a color alone repaints from the columns, bands and layout the last draw reduced the window to, without reading its samples again), and only while the canvas is on screen (`IntersectionObserver`) and the
  page is visible (`live.page`, test mode's `setPageHidden` included). Each series is reduced to the smallest and largest
  value per device pixel column (stacked bands to each column's mean), so a draw is O(samples in the window) plus at
  most two vertices a column, whatever the history holds; a gap flag or a missing value breaks a line, and a lone
  sample between gaps shows as a one-pixel tick. Stacked bands break at a gap flag or at a sample with no stacked value at
  all; a series missing from a sample that has other stacked values counts as 0 in it (a column's band is the mean over
  every such sample in the column), so its band drops onto the one below rather than breaking every band above it. A
  series whose `index` the ring does not have reads as no value, never as a neighbour's. Colors come only from the
  active theme's `charts.*` keys and the surface the chart sits on (series
  `charts.blue`, `.orange`, `.green`, `.yellow`, `.purple` in that order and `charts.gray` for Other; `charts.red` is a
  status mark, never a series; grid lines `charts.lines`, text and crosshair `charts.foreground`); under forced colors it
  draws in `CanvasText`, `Canvas` and `GrayText` as the DOM resolves them at each draw (from a hidden element styled with
  them), since a canvas keeps its own stale reading of those keywords when the contrast theme changes while forced colors
  stay on; it draws without fills, and each series after the first takes the dash of its place in the chart, as the legend
  shows it. A chart sits on `editor.background`, `panel.background` (the default), `editorWidget.background` or
  `tile.background`: its end markers are ringed and its bands parted in that color, and series and text are checked
  against all four. A tile's sparkline goes in the states kit's `Tile` chart slot (`<Tile><LiveChart variant="sparkline"
  surface="tile.background" …/></Tile>`), 32 px tall. A change of device pixel ratio alone (a move to a display of another scale)
  redraws it, through a `resolution` media query, since it resizes nothing. Canvas text uses the UI font at the type scale's 11 px step. The canvas is `role="img"` with a name such as
  "SQL Server CPU: 12 %, 3 % to 40 % over the last 5 minutes", changed at most every 5 s and never while the canvas has
  focus (a screen reader would read the whole name again at each change; it catches up on blur),
  `aria-roledescription="chart"`, and a description of its keys. The pointer shows a crosshair and a tooltip ("4:10 ago · 93 %") inside the plot, beside
  the crosshair (or against the plot's right edge when neither side has room; one wider than the plot wraps between its
  parts); a pointer held still keeps the crosshair under it as a live window moves, on the sample now nearest it; with the canvas focused, Left and Right step it one sample, Home and End go to the window's ends, Escape
  or a blur hides it (a keyboard crosshair whose sample a live window moves past stays on the window's oldest sample), and each step is announced through a polite status region (these are the chart's own keys, as the
  grid's arrows are the grid's, not workbench commands). Charts joined to one `ChartLink` show the same moment together,
  and a chart disposed while it drives the crosshair takes it off the others. "View as table" shows the window in the
  plot's place, at its size and scrolling there (a focusable region named "<title> table", its header kept in view),
  newest first, at most 120 rows or `tableRows` (a longer window is sampled evenly), a row marked when any sample since
  the row before it follows a gap (never the oldest row: the flag of a view's first, baseline sample parts it from nothing shown); the table, `latest()` and the keys read the window,
  not the canvas, so they work whatever size the canvas has. `LiveChart` keeps the table's state itself or takes it as
  `tableShown`/`onTableShownChange`, and `tableToggle: false` drops its button for a document that offers the command
  from its catalogue; it draws at most 12 series (`chartLimits.series`), and its legend and table list the same ones.
  A live window ends at the newest sample, so history stays in view when collection stops. Whether that sample reads as
  "now" comes from the view, not from the spacing of the ring's samples (which a refresh, a back-off or a new interval
  would mislead): `bindChart` follows the handle's snapshot, and the times read "now" and "ago" only while the probe is
  `fresh` or `limited` and its newest sample came within twice its effective interval (so a resumed view is not "now"
  until its first sample). Otherwise (paused, stale, failing, lost, ended) they read as clock times at once, and the name,
  like a fixed window's, gives the clock range ("… from 13:05:00 to 13:10:00"). The tooltip, announcements and table are Text nodes or React text, never markup. A chart reads any
  `RingReader` (`live/ring.ts`), so a series sent in one unit can be shown in another through `scaledRing(ring, factor)`, a
  cached view that multiplies values and keeps the ring's times, flags and revision (the Activity Monitor's waiting tasks,
  sent as wait milliseconds per second); a `ChartSource` may hand one out from `ring()`.
- **State.** A handle's snapshot has its status (`connecting`, `live`, `paused` by `hidden` or `user`, `dormant`, `lost`,
  `ended`) and each probe's state (`fresh`, `stale` once nothing arrived for twice its effective interval, `failing` with its
  probe error, `limited`, `unavailable`, `paused`), interval asked and run, newest sample time and cost. The stale moment
  is the one timer a running view keeps; it reads nothing. `liveIndicator` (`live/status.ts`) turns a snapshot into the
  pill and badge text ("Live · every 2 s", "Slowed to 4 s", "Paused while hidden", "Updated 12 s ago", "Connection lost").
  `live.peek(source)` reports open views as they are, for badges and summaries: it never subscribes, and a paused,
  hidden or stale view reads stale.
  `pillStatus` and `freshness` give the states kit's `LivePill` and `StaleBadge` the same facts: the pace of the probes
  that run (`slowed` when the backend runs one slower than asked), who paused the view and how it ended, the newest
  running sample's time, and since when a running probe has been stale or failing.
- **Tables.** `handle.table(probe, index)` is the table's latest result as a `ResultHandle`, with its revision, diff and
  departed rows (snapshot) or segment, `rolledFrom` and `restarted` (append). `tracked` carries the rows the backend
  found and, when the view still has it, the key list that `seq` answers: the view keeps every list it sent for the table
  since the newest one a sample answered (at most 64), since many may go while one sample runs.
- **Activity Monitor.** One monitor is one handle on the `activity` source with every probe the live catalogue declares,
  owned by its tab (`documentOwner`). `ActivityMonitorService` (`src/renderer/src/activity/`) keeps each probe paused unless
  a shown pane whose grid exists reads it (`paneProbes` in `src/shared/activity/catalog.ts`; the tiles' overview always
  runs), sends the monitor's interval raised to each probe's floor (`probeIntervalMs`), and changes only the probes a pane
  or interval change moves, through `setProbe` (one debounced `live.update`). Pause is the handle's user pause, Refresh Now
  its `refresh`, Retry a new handle. The view reads the overview's ring for its tiles and charts and runs no timer but the
  states kit's one-second age ticker.

**LiveGrid** (`live/LiveGrid.ts`, its React shell `live/LiveGridPane.tsx`): a live table in a results grid. It wraps
`GridView`, which renders it as any result (pools, tiles, `nodeValue` text, keys, selection, Copy) with three additions:
`GridView.swap(handle, descriptor, mapRow)` shows another result with the same columns in place (widths and scroll stay;
the first row shown, the active cell and each block move through `mapRow`, `grid/swap.ts`), a hidden tone column, and
follow tail.
- **Snapshot revisions.** After each applied tick (before it is acknowledged) the grid first reads the rows the new revision
  will show into the window cache (`GridView.prepare`, at most 250 ms), then swaps it in, so a swap never paints a frame of
  empty cells; a newer revision arriving meanwhile has retired the one shown and swaps in at once. The grid tracks the
  selected rows (the active row and every block's anchor and focus rows), then the rows next to the active row and the first
  row shown unless that is row 0 (at most 64): it reads their keys from the window cache's worker (`display: false` over
  the key columns, in as few windows as fit), sends them with `track` only when the list changes, with `linger` counting
  the selected rows' keys, so only a selected row that leaves stays one revision, and maps each row it knew to where the
  backend says its key went; rows it did not know keep their index. A revision sampled under an older list may not answer a
  selected row's key: the selection then stays at its index for now, but the grid keeps that key (pinned) for that row, sends
  it, reports it as `activeKey`, and moves the selection once a revision places it; a click or key of the user's replaces
  pinned keys, since the user chose by what they see. A block whose row is gone collapses to the active cell; an active row that is gone moves to
  where the nearest surviving row went (below, then above, within 64 rows), passing over rows whose place the grid does
  not know, and else stays at its index. A view scrolled to the very top stays at the top,
  so rows that sort first are seen. Departed rows are muted for their one revision, whatever their tone. A grid that is disposed
  (its pane unmounts) sends an empty list for its table, so the backend stops following, and keeping, the rows it selected.
- **Tones.** The tone column (the result's last, role `tone`) is not shown: each row tile the grid reads also reads the tile
  column that holds it, and each pooled row takes one class, `tone-error`, `tone-warning`, `tone-running` or
  `tone-muted` (theme keys `resultsGrid.row{Error,Warning,Running,Muted}{Background,Foreground}`; a NULL in a toned row drops
  its tint). Under forced colours a toned row's number gets a bar and a muted row dims. The owner may name tones for screen
  readers (`toneLabel`, "blocked", "ended"), which the active cell's label then ends with.
- **Append segments.** A segment grows in place. While the view is at its last row it stays there as rows arrive; scrolled
  up, it stays where it is and the pane counts the rows that arrived since ("n new rows · Jump to latest", which scrolls
  back and follows again; `newRowsLabel` names the rows another way). A roll swaps to the new segment and keeps
  following; a restart (a new filter or args) keeps the view's intent: the tail if it followed, else the top of the new rows.
- **Remounts.** An owner that unmounts the pane (a tab switch) keeps a `LiveGridState` and passes it again: GridView's scroll,
  widths, selection and `following` (a follow-tail grid built over a state that had left the tail opens where it was), the
  rows the segment had when the view left its tail, and the selected rows' keys (known in the same result, pinned in a newer
  one). The grid reports the selection it restores as its snapshot's `selection` and `activeKey`.
- **Sort, Copy, Save.** `sortBy(column, descending)` sets the probe's sort key for this grid's table (`table`, by catalogue
  column id; never the tone; append tables are in id order), keeping the keys of the probe's other tables (a probe-wide key gives way on this table and becomes a key of each other
  snapshot table with that column), and the next revision arrives sorted; the snapshot's `sort` is this table's keys in the probe's settings.
  GridView has no header sort yet: header presses select columns, and a header-click sort with its indicator and
  `aria-sort` is Activity Monitor's (AM2b) change to GridView. Copy acts on the revision the grid shows, through
  `results.copy`, which leases it: the samples after it may retire it mid-copy and the copy still completes. Save names
  that revision too, but a revision is retired two samples on, sooner than most save dialogs close, and the backend's
  lease starts only with the export: so for a live snapshot table main saves the table's newest revision the renderer owns
  once the file is chosen (`ResultsPortHost.liveNewest`, from the ticks it relays), the one the grid shows by then (which
  may hold a departed row that stays its one revision); it fails `RESULT_UNAVAILABLE` only if the subscription ended
  meanwhile without keeping the table (a source that ends keeps its newest revision, which is saved). When the view's rows are
  gone (the table it holds now is lost or released) and a job failed because its result was, Copy and Save answer in the live
  view's words, not a query's; a retired revision is not a stop, and any other failure (a file in use) keeps its own words. An append segment saves once it is complete (a roll
  or the source's end).
- **What the owner sees.** The grid's snapshot carries the table shown, the new-rows count, the sort, `lost` (the shown
  result was lost with the backend), `released` (the view's subscription ended and released it: `dormant` while hidden
  long enough to stop, which resumes when shown, else `stopped`; the pane shows an overlay for both and for `lost`), the selection the grid shows (a swap
  that moves it reports it, as a click does; one to a revision with no rows clears it, and the first cell a frame selects
  once rows come back is read from the grid) and the active row's key once known (`activeKey`), for a details pane, Kill
  or a context menu. It is published only when one of these changed, so scrolling renders nothing. Copy with Headers,
  Save's command and the context menu are the owning view's (later PRs).

## Results port and results worker

**Opening.** The renderer calls `window.varia.openResultsPort()` (`varia:results-port-open`, `trusted()`, at most 10 a
minute within one page load; a reload starts the count again). Main closes the previous port (cancelling its streams with reason 3), creates a `MessageChannelMain`, posts
`varia:results-port` with one port to the requesting main frame, and tells the worker the backend's generation and
status. The preload re-posts the port to its own window; `ResultClient` accepts it only from `window` itself, only while
it expects one, and only with exactly one port, then transfers it to the worker. The port closes on reload, renderer
crash and window close; a backend loss ends its streams but keeps the port.

**Worker → main** (`portRequestSchema`, strict; a parse failure answers `INVALID_REQUEST` when `rid` is readable, and the
100th invalid message closes the port):

```ts
{ t: 'read'; rid: u31; generation; resultId: u32; firstRow: 0..2^53-1; maxRows: 1..65_536; credit: 65_536..16_777_216; viewId?: u32 }
{ t: 'credit'; rid; bytes: 1..16_777_216 }
{ t: 'cancel'; rid }
{ t: 'close'; rid; generation; resultIds: u32[1..1024] }
{ t: 'rowBytes'; rid; generation; resultId: u32; firstRow: 0..2^53-1; count: 1..16_384; viewId?: u32 }
{ t: 'view'; rid; generation; resultId: u32; sort: ViewSortKey[1..16]; replaces?: u32 }
{ t: 'viewClose'; rid; generation; resultId: u32; viewIds: u32[1..64] }
{ t: 'search'; rid; generation; resultId: u32; text: string[1..1024]; fromRow; maxMatches: 1..10000; backward?: boolean; viewId?: u32 }
{ t: 'live'; rid; generation; params: live.subscribe params }
{ t: 'liveUpdate'; rid; generation; params: live.update params }
```

A read, close, rowBytes, view or viewClose must name the current generation and a result the renderer owns (from a query summary or event, at most
100,000 per generation), or it ends `RESULT_UNAVAILABLE`; at most 64 requests may be outstanding. A `live` request must name
the current, ready generation (`RESULT_UNAVAILABLE`) and a subscription id not already running on the port
(`DUPLICATE_REQUEST`); at most 16 live streams run per port (`TOO_MANY_REQUESTS`), counted apart from the 64. A
`liveUpdate` counts among the 64 and must name a live stream of the port and its generation (`NOT_FOUND`) with the same
source (`INVALID_REQUEST`). `credit` acknowledges a live event and `cancel` ends a live stream.

**Main → worker:** `backend { generation, status }` on every change, `page { rid, seq, body: ArrayBuffer }`,
`end { rid, ok, result | code, message }`, `query { queryId, event }`, `memory { usedBytes, globalBytes, generation, seq }`
(the generation of the backend that sent the event, which may be one being replaced), and `live { rid, bytes, event }` (a
validated live event with its EVENT body's length, which the worker grants back once the page has applied it). A live
stream and an update end with `end` (`result`: the live end or the update answer).

**The worker** (`worker-core.ts`) keeps an LRU of decoded pages keyed by generation, result and first row (64 MiB or 512
pages, each page charged its bytes plus 320 bytes per column for its decoded column views, so a wide page of few rows
counts what it holds; pages a pending window needs are never evicted, so once those alone pass 64 MiB, windows that already have rows
answer with them, as a shorter window), reads each missing contiguous range once with 4 MiB of credit, waits for rows a
read in flight will bring instead of reading them again, cancels a read nobody waits for, and grants credit after
caching each page (a page that arrives twice, the boundary page of two adjacent reads, is credited without being
decoded again). A page that fails `decodePage` ends its read with `PAGE_INVALID` and is not cached. A new generation
fails pending work with `RESULT_UNAVAILABLE` and drops older pages.

The worker also relays live subscriptions. The page sends `live { id, params }`, `liveUpdate { id, live, params }` (`live`
names the stream by the page's id), `liveAck { id, bytes }`, `cancel { id }` and `forget { generation, resultIds }`; the
worker answers `live { id, bytes, event }`, `liveEnd { id, result }`, `liveUpdated { id, result }` or `error`. It takes a
port rid for each from the counter reads use, skipping rids still in use (a live stream can outlive 2^31 reads), and
sends a stream to the generation main last announced on the port. Main takes a stream only for a generation that is
ready (an `unresponsive` one still is), so requests that come before main's first `backend` message, or while the
backend is `starting` or `restarting`, wait and go to the generation that becomes ready, never to more than one; a view
restored at launch, or resubscribed as soon as the page hears of a new generation, is not reported lost. With no backend
running (generation 0: `stopped` or `failed`) a stream fails `BACKEND_UNAVAILABLE`, including one that was waiting.
An update goes to its stream's generation; one for a stream that ended or is being cancelled fails `NOT_FOUND` at once.
A stream cancelled before it was sent ends `cancelled` with no ticks. Events are relayed as main validated them, never decoded; `liveAck`
becomes `credit` only within the bytes outstanding. When a new generation is announced the worker ends the older
generation's streams and updates with `RESULT_UNAVAILABLE` ("This live view ended because the SQL backend restarted."),
in case main's own `BACKEND_LOST` never arrives, and a replaced port ends them with `PORT_CLOSED`; later answers for them
are dropped. `forget` drops the pages of results the backend already released and ends reads still bringing rows of
them with `RESULT_RELEASED`, without sending `close`.

**`ResultClient`** (`ResultClient.ts`) is the renderer's API, the contract the PR7 grid builds on: `open(descriptor)`
returns a `ResultHandle` with `getSnapshot`, `subscribe` (coalesced per animation frame), `getWindow(first, count, o)`
(at most 4,096 rows, 262,144 cells and 4,000,000 characters; 1,024 characters per cell by default, at most 2,097,152;
flags 1 NULL, 2 truncated, 4 read error, 8 over the text budget), `peekWindow`, `prefetch`, `getCell` (a cell's whole stored
value; with `format: 'xml' | 'json'` the worker pretty-prints it with `doc-format.ts`, unless the backend stored only a
prefix, and reports `formatted`) and `close`, plus
`onQueryEvent`, `onMemory`, `onGeneration` and `applySummary`. It forgets a result once it is released or its
generation is gone (handles keep reporting `released` or `lost`). The grid reads tiles of 128 rows × 32 columns, at most
512 characters per displayed cell, and every grid shares one window cache of 256 windows and 16,777,216 UTF-16 units
(least recently used first, indexed by result so a result's windows go without a scan). A tile is read again only
from where its rows end: rows that arrived since (at most 10 reads a second), or, when its rows' pages do not fit the
worker's 64 MiB cache together (large XML or JSON values) and the worker answers with the rows it holds, the rest at
once, so the grid joins a tile's parts rather than reading its first rows over and over. `release(keys)` closes many
results at once, 1,024 ids a request: a run's sets close with one call when its tab runs again or closes, or Close
Results runs, since one request each would run into the port's 64 outstanding requests. Ids wait while the port is
down, and ones main refused as busy (`TOO_MANY_REQUESTS`) are sent again 250 ms later. A worker that fails is recreated
and reattached at most 3 times a minute; after that, results show "Results cannot be displayed; reload the
workbench."

`live(params, onEvent)` runs a live subscription and returns a `LiveStream`: `done` (settles once with the `LiveEnd`, or
with the failure as a value: never a rejection), `update(patch)` (live.update with the stream's subscription id and
source; failures are values, and a stream that ended answers `NOT_FOUND`), `cancel()` (`done` settles `cancelled` at once
when the stream was never sent, even if the port never attaches) and `ack(bytes)`. An exception from `onEvent` is
caught: the stream's bookkeeping goes on and the event stays unacknowledged. Before `onEvent(event, bytes)` runs, each table the event carries is applied (`applyLive`) and the results it retires are
forgotten, but only those this stream delivered (a retired list can never release a query's results). The caller applies
the event synchronously and then acknowledges it with `ack(bytes)`; nothing more arrives until it does. A cancelled
stream's events still count its results but no longer reach `onEvent`. When the stream ends, its results are forgotten
too, except those a finished source kept, which stay readable until `release` closes them. A failed worker ends streams
with `RESULT_DECODER_FAILED` (main cancels them when the new worker's port opens) and `dispose` with `PORT_CLOSED`.
`applyLive(descriptor)` creates or updates a result as query events do, so an append table's handle notifies its
listeners as it grows. `forget(keys)` marks results the backend already released as released, drops their windows, and
tells the worker to drop their pages, without `results.close`.


## Malformed input

| Side | Input | Handling |
| --- | --- | --- |
| main ← backend | Bad magic, kind or flags; a kind for the wrong direction; a second HELLO; a stream truncated at EOF; an id at or above the next one to be issued | **Fatal:** the process is killed and the generation ends (`protocol`), counting toward the breaker |
| main ← backend | First stdout byte `{` | Protocol 1 backend: `failed (incompatible)` |
| main ← backend | An oversized body (skipped); an undecodable RESPONSE or EVENT body; a bad envelope; an event failing `queryEventSchema` or `liveEventSchema`; a live EVENT out of sequence, over 256 KiB or before the previous one was acknowledged; DATA on a live stream; a credit overrun; a sequence gap; DATA for a request that is not a stream; a frame for a settled id | **Contained:** that request or stream fails with `STREAM_PROTOCOL` and gets CANCEL reason 3. The 8th contained violation in a generation is fatal. |
| main ← backend | A frame for an abandoned id | Dropped and counted |
| backend ← main | Bad magic, kind, flags or envelope | GOAWAY `PROTOCOL_ERROR`, exit 64 (main has a bug: fail fast) |
| backend ← main | An oversized REQUEST | Body skipped; RESPONSE `TOO_LARGE` with its id |
| backend ← main | Invalid params | `INVALID_PARAMS` |
| worker ← main | A page failing `decodePage` | That read ends with `PAGE_INVALID`; the worker keeps going |
| worker ← page | A live acknowledgement for more bytes than the stream's unacknowledged events took, not a positive integer, repeated, or for a stream that ended | Dropped: no credit is sent |
| backend | Unhandled exception, out of memory | Best-effort GOAWAY `BACKEND_CRASH` (exception type only), exit 70 |

Error details carry only a kind, an offset and a code: never bytes, SQL or server names.

## Backend threads and exit codes

- **Reader thread** (`varia-ipc-reader`) handles every frame inline: HELLO; REQUEST (validate the envelope, register
  the request, start its task); CANCEL; CREDIT; and PING, whose PONG it queues on the control lane itself, so liveness
  survives a starved thread pool (SMO is synchronous). More than 288 requests in flight are answered `BUSY`. At stdin
  EOF (main exited or closed the generation) it cancels everything, waits at most 1.5 s, disposes the service and exits 0.
- **Writer thread** (`varia-ipc-writer`) drains the control lane before the bulk lane, drops droppable events past 1,000
  frames or 8 MiB, and exits 0 if a write fails. .NET's console stdout ignores broken-pipe errors, so that does not
  happen when main exits: stdin EOF is what ends the process. The writer never exits because of queue size: main may be
  blocked by a synchronous dialog, and that must not end sessions.
- stdout carries frames only (`Console.Out` writes to stderr). stderr lines have the fixed form
  `varia-backend: {event} {ExceptionType} at {Type.Method}`: no SQL, messages, server names or connection strings.

| Exit code | Meaning |
| --- | --- |
| 0 | Normal (stdin closed) |
| 64 | Protocol error from main |
| 65 | No common protocol version |
| 70 | Crash |

## Generations, restarts, and lost connections

`BackendSupervisor` owns the backend process across generations (numbered from 1 per main process) and publishes a
`BackendState`: `starting`, `ready` (pid, runtime, platform), `unresponsive` (silence), `restarting` (with the losses),
`failed` (`crashLoop`, `spawn` or `incompatible`, with a message and Copy details), or `stopped`.

- **Binding.** A request is bound to the current generation when it is made (the next one while a restart is pending)
  and written only to that generation. If the generation ends first, the request fails with `BACKEND_LOST`. Nothing is
  re-sent or re-run, and the backend never retries commands (query sessions use `ConnectRetryCount = 0`).
- **Ids never cross generations.** `ConnectionInfo` and result keys carry the generation; main refuses a lost
  connection's id (`CONNECTION_LOST`) before sending, and answers its disconnect and session close locally.
- **Unexpected loss** (the process exits, crashes with GOAWAY, breaks the protocol, or sends no HELLO within 20 s): every
  written and queued request of that generation fails with `BACKEND_LOST`, port streams end, its connections become
  lost, its results are dropped, and the next generation starts after 0 s, 1 s, then 2 s. The third unexpected loss
  within 120 s trips the breaker: `failed (crashLoop)` until the user restarts. 300 s of continuous readiness resets
  the delays and the breaker. Spawn failures (`ENOENT`, `EACCES`) and incompatible builds fail at once, without retry.
  In development a missing `Varia.Backend.dll` is a spawn failure too: main checks for it before every launch, since
  `dotnet` would start without it and exit, which reads as a crash loop.
- **Silence.** Main sends PING every 5 s; any frame counts as liveness. After 15 s without one, the state is
  `unresponsive` and a warning banner offers **Restart now**; it returns to `ready` only when a frame arrives (not when
  main's own silence window restarts after a sleep or a stall). A silent backend
  is never killed automatically, because a restart closes every connection and rolls back open transactions: that is
  the user's decision. The watchdog ticks every second; a tick more than 2 s late means main itself stalled (a
  synchronous dialog, a long pause), so the silence window starts again, and every silence decision first yields one
  turn for frames already in the pipe. `powerMonitor` suspend pauses it and resume restarts the window.
- **Manual restart** (**Restart SQL Backend…**, **Restart now**) asks first when servers are connected ("Restart the SQL
  backend?" / "All {n} connections close and uncommitted transactions are rolled back.", or "The connection closes…" for
  one), closes the generation gracefully (stdin end, 2 s, then kill; 130 s while a Create Catalog is pending, which the
  backend finishes or undoes first), starts the next at once, and resets the breaker.
  **Reload** of the workbench restarts the backend the same way, without a notice, so no session outlives the page that
  owned it.
- **Lost renderer.** When the workbench's renderer process stops, main resets the page's state and restarts the backend
  once, then asks "Workbench stopped" (**Reload** or **Close**); the reload that follows restarts nothing. Its detail,
  and those of "Workbench not responding" and "Reload workbench", name AutoRecover's copies when that page's generation
  has any (see AutoRecover below); the reloaded page offers them. On Windows a
  process spawned while Chromium launches a renderer inherits every inheritable handle, that renderer's channel
  included: Node cannot spawn without passing them (libuv always lets the child inherit), so a backend generation that
  starts at that moment (a crash-loop restart at 0 s) holds the channel open, and when the renderer stops Chromium never
  hears of it. A watchdog in main therefore checks the window's renderer process every second and handles one that has
  exited while Chromium still reports it running exactly as Chromium's own report, once per renderer: whichever comes
  second is ignored. The reset ends that backend generation, which lets Chromium see the stop, and **Reload** waits up
  to 5 s for it; if Chromium still has not seen it (the holder is some other process), the workbench opens in a new
  window where the old one was, and a close or quit the lost page could not finish goes to that window's page. **Close**
  closes such a window at once: its renderer would never answer the unload a close sends it.
- **Quitting** waits for the backend to stop (stdin end, 2 s, then kill; up to 130 s while a Create Catalog is pending) before the app exits, and for any generation a
  restart is still closing, so a backend that cannot act on EOF never outlives the app with its sessions and locks. While
  it waits the app has no window and releases the single-instance lock, so relaunching starts a new instance at once.
  Closing the last window starts no new backend unless the app keeps running (macOS).
- **Reconnect.** A lost connection stays in Object Explorer as "{server} — connection lost" with **Reconnect…** and
  **Remove**. Only Reconnect (prefilled, without the password, which main fills in when one is remembered for the same
  credentials) replaces it, moving its query tabs to the new connection; their first execution starts with "This query
  opened a new SQL session. The previous session ended when the SQL backend restarted, so its SET options, temporary
  tables, and open transaction no longer exist."

## Limits

| Item | Value | Enforced by |
| --- | --- | --- |
| Request body (main → backend) | 4 MiB; a 1,000,000-character script is at most 3,000,000 UTF-8 bytes | main before writing (`TOO_LARGE`); the backend skips larger bodies |
| Response body (backend → main) | 16 MiB | backend (`RESPONSE_TOO_LARGE`); main skips larger bodies |
| Event body | 256 KiB; `resultSet.*` 4 MiB | backend |
| Control decoding | depth 16; 4,096 map entries; 1,048,576 array items; 128-byte keys; integers within ±(2⁵³ − 1) | both |
| Page | 1 – 4,096 rows and columns; sealed at 256 KiB or 4,096 rows; first page at 64 rows or 20 ms; idle seal 200 ms | backend; checked by the worker |
| Encoded row | 8 MiB; later cells become truncated prefixes | backend |
| Stored cells | text 65,535 characters; xml, json and showplan 2,097,152; vector 65,535; binary and CLR types 32,766 bytes | backend |
| Result sets kept per query | 1 – 1,000 (default 10) | zod and backend |
| Rows stored per query | 0 – 2,147,483,647 (0 = budget only) | zod and backend |
| Result budget | `clamp(available memory / 4, 256 MiB, 2 GiB)`; 50 % per query; none under high system memory load | backend |
| Messages | 1,000 entries / 1,000,000 characters, then up to 20 more errors; error text 16,384 characters | backend |
| Descriptors per summary | 8 MiB (bounded per set by names, types and 96 bytes per column) | backend |
| FOR XML / FOR JSON value | 2,097,152 characters, the rest marks it truncated | backend |
| Row sizes a request | `results.rowBytes`: 1 – 16,384 rows (`rowSizes.maxRows`) | zod and backend |
| Row identities | `results.rowIds` 1 – 16,384 rows; `results.findRows` 1 – 10,000 ids, 100,000 matches (`limits.identity`); 24 bytes a row while identifying, 8 kept, under the query budget | zod and backend |
| Result diffs | context -1 – 100 rows, 64 one-sided column names each side (`limits.diff`); about 80 bytes a row of both results and 12 a differing cell while aligning, the diff's rows under the query budget | zod and backend |
| Sorted views | 0 – 16 keys and 0 – 16 filters a view (one at least), 4,096 distinct values a filter, 256 cell ranges a selection, 1 – 64 ids a `results.viewClose`, 8 views a result (`limits.views`); 8 – 16 bytes per row and key or filtered column while building, 4 bytes a row kept, under the query budget | zod and backend |
| Search in results | 1 – 1,024 characters of text, 1 – 10,000 matches an answer plus its last row's columns (`limits.search`); no budget held | zod and backend |
| Column profiles | 0 – 32 columns a request (`limits.profile`), 20 buckets, distinct exact to 16,384, values cut to 256 characters; working memory under the query budget | zod and backend |
| Copy | 64 MiB of UTF-8 (estimated before any work; main cancels past 65 MiB received); DATA ≤ 1 MiB; 16 MiB initial credit; 120 s; one per window | backend and main |
| Save Results As | one per window; 1 MiB writes; no deadline; suggested name ≤ 128 characters, path ≤ 32,767 | main and backend |
| Job progress | EVENTs every ≥ 250 ms; pushed to the renderer ≤ 4 a second | backend and main |
| Action progress | EVENTs every ≥ 250 ms besides each step's start, the last held one at the interval's end; pushed ≤ 4 a second per request (a new step at once, the latest held one at the interval's end); step 0 – 519, percent 0 – 100; the renderer tracks ≤ 128 requests | backend, main and renderer |
| Long object actions | 1 per Varia connection, 2 in all, waited for ≤ 30 s, then `BUSY`; a closing generation waits 10 s plus the action's cleanup budget plus 5 s | backend and main |
| Pending requests in main | 256 per generation plus 32 for control-lane methods; 32 MiB queued for stdin | main |
| Connection environment | `environment` in the connection options: absent (None) or 1 – 32 characters after trimming, without control, format, line or paragraph separator characters; stored in `connections.json` (Set Connection Environment, `varia:connections-environment`, takes the same label and the live connection's options, and changes only that entry's label), never in the connection string | zod (main) and backend |
| Session prompts | 1,024 queries, names ≤ 512 characters, 10 listed by name; 15 s for cancelled queries to stop | zod and renderer |
| Files main opens | 32 at a time (an Open selection, the command line, a second instance, macOS open-file, a drop); paths ≤ 4,096 characters; errors ≤ 600 characters; change checks 2 comparisons at a time (counting those that outlived their 2 s) and none again for a file whose last one has not settled | zod and main |
| Recent Files | 50 entries in `recent-files.json` (≤ 256 KiB); 1 – 24 shown; names ≤ 260 characters; menu paths ≤ 60 | zod and main |
| AutoRecover | 64 records and 256 MiB in `AutoRecover/`, 32 MiB each, read or written; text ≤ the kind's limit (5,000,000 characters for a query, 4,194,304 for a value); names ≤ 512, servers ≤ 256, databases ≤ 128, paths ≤ 4,096 characters; 256 ids a discard; every 1 – 60 minutes, kept 1 – 90 days | zod, renderer and main |
| Server file picker | paths 1 – 260 UTF-16 code units, no U+0000 – U+001F or `*?"<>|`, absolute; ≤ 2,000 entries a folder (`truncated`), 10 s a listing (15 s deadline) | zod and backend |
| Restore Database | 1 – 64 backup files, each a server path as above; ≤ 1,024 databases and 1,024 sets a history or media read (`…Truncated`); ≤ 256 sets and 1,000 moves a restore; a file restore ≤ 1,024 sets, 256 files and 256 filegroups, 2,100 parameters; set names ≤ 128, ids ≤ 36 characters, LSNs ≤ 25 digits, positions 1 – 32,767; 120 s a read (130 s deadline) | zod and backend |
| Object Explorer requests | node names 1 – 128 UTF-16 code units, or a kind's own bound up to 260 (`maxName`, only for a kind without folders or rows of its own); other identity names, SSIS folders and projects included, 1 – 128; no U+0000; pages of 1 – 2,000 nodes; cursors ≤ 1,650 characters; 1 – 256 ids a cancel | zod and backend |
| SSIS requests | folder, project, environment and other names 1 – 128 UTF-16 code units, package names 1 – 260, no U+0000; 1 – 64 ids a cancel; describe lists ≤ 2,048 rows, values ≤ 4,000 characters, answers ≤ about 4,000,000 bytes; revisions 64 lowercase hex characters, only for a write verb that takes one; Stop Operation ids 1 – 2^53 − 1; Create Catalog passwords 1 – 128 UTF-16 code units, no U+0000, no lone surrogate, and the server paths it reads ≤ 1,024 characters; error messages ≤ 2,048. `ssis.operations` args: kinds 1 – 4 and statuses 1 – 9, distinct; folder, project and caller 1 – 128, package 1 – 260; windowHours 1 – 8,760; limit 1 – 10,000 (100 – 10,000 in Tools › Options): a window of at most 10,000 rows, at most 20,000 (2 × limit) read a sample and as many open ones with a baseline, at most 256 open ids read again a sample | zod and backend |
| Backend concurrency | 288 requests in flight; 8 metadata slots; 1,000 query sessions; 16 concurrent `results.read`; Object Explorer statements 4 per connection and 8 in all, 1,024 registered loads; SSIS reads 2 per connection and 4 in all, 256 registered; SSIS writes 1 per connection and 2 in all, 64 registered | backend |
| Credit | 64 KiB – 16 MiB per grant (worker 4 MiB); 16 MiB outstanding per stream, 64 MiB per port; one page of overdraft | main and backend |
| Results port | 64 outstanding requests; 100 invalid messages close it; 10 opens a minute per page load | main |
| Live subscriptions | 16 per results port, 32 per backend, 8 per SQL Server; 8 probes each, 4 snapshot and 4 append tables per probe, 8 tables a tick; one unacknowledged EVENT (64 KiB initial credit), at most 256 KiB (catalogue worst case 192 KiB); interval 1 s – 1 h; 64 series, 16 status values of 128 characters, 8 probe errors of 2,000; sort 4 columns, filter 400 characters on 8, track 64 keys of 512; resume 256; 64 kept results; snapshot revisions ≤ 10,000 rows, append segments 200,000 rows or 32 MiB (2 segments' worth kept, at most 8 results a table), ≤ 10,000 new append rows a tick; 64 MiB of tables per subscription, all live tables ≤ 25 % of the result budget; facets 7 columns × 100 values × 128 characters, ≤ 32 KiB of facet text a tick; live statements 2 per connection and 8 in the backend; statement budget 0.8 × interval within 500 ms – 10 s (5 s by default); back-off up to 60 s (or the asked interval); LOCK_TIMEOUT 1 s; connection back to the pool when idle 30 s | zod, main and backend |
| Results worker | 64 MiB / 512 cached pages (pending windows answer early past 64 MiB); windows of 4,096 rows, 262,144 cells, 4,000,000 characters | worker |
| Results grid | tiles of 128 rows × 32 columns; 512 characters per displayed cell; one window cache of 256 windows / 16,777,216 UTF-16 units; at most 12 grids mounted, 2 a frame | renderer |
| Timers | HELLO 20 s; PING every 5 s; unresponsive after 15 s; stop grace 2 s (130 s for a generation with a pending Create Catalog, whose backend waits up to 120 s for it); backstop deadline + 5 s; progress ≤ 10/s; messages every 100 ms | main and backend |
| Restarts | after 0 s, 1 s, 2 s; breaker at 3 unexpected losses in 120 s; reset after 300 s ready | main |
| Registries | 1,024 lost connection ids; 4,096 abandoned request ids; 100,000 owned results per generation; stderr 32 lines × 512 characters | main |

## Error codes and fixed sentences

Failures reach the renderer as `{ ok: false, error, code, details? }`. Messages are complete sentences shown as they are.

`details` comes with a failed `connections.connect` or `connections.databases` open, and with `BACKEND_ERROR`. The Connect
dialog shows them in **Error details** under a failed Connect, and under a failed **Load databases**' note, as SSMS does
for both. They are `{ number?: int32, state?: 0–255, class?: 0–255, server?: str ≤ 256, reason?: 'certificate',
exception?: str ≤ 512 }`: SqlClient's first error and the server that answered (the server typed when SqlClient names
none), and `reason` 'certificate' when the TLS handshake failed because the server's certificate is not trusted, by its
chain or its name (SqlClient's error number `SEC_E_UNTRUSTED_ROOT` or `SEC_E_WRONG_PRINCIPAL`, which the managed SNI on
Linux and macOS also uses for any certificate its validation rejects, `CERT_E_UNTRUSTEDROOT` or `CERT_E_CHAINING`, which
Windows' SNI reports once Host Name in Certificate is set, or an `AuthenticationException` about the certificate; never
`CERT_E_WRONG_USAGE`, a pinned certificate that does not match); the Connect dialog then offers **Trust server
certificate and connect**, except under Strict encryption, which ignores that setting, and when the connection pins a
Server Certificate or a Host Name in Certificate, which trusting would skip: there it explains instead. `BACKEND_ERROR` for an exception the backend did not expect carries only `exception`: the types
and HRESULTs from the outer exception inwards, at most four (`System.InvalidOperationException (0x80131509) >
System.DllNotFoundException (0x80131524)`), for **Copy details**, because its sentence is generic; never the exceptions'
messages, which can hold paths, names or SQL text. Details never hold the connection string or the password. Main
refuses (as a contained violation) details with any other member or out of these bounds.

Integrated authentication on Linux and macOS uses Kerberos through SqlClient's managed SNI. When the Negotiate token cannot
be built, SqlClient reports only error 0, class 11, "Cannot generate SSPI context." (procedure `GenClientContext`), so the
backend asks GSSAPI for the default initiator credential (`gss_acquire_cred`, which reads the credential cache without
contacting the KDC) and answers `AUTH_UNSUPPORTED` when the GSSAPI library is missing (what to install), or
`AUTH_KERBEROS` for a missing or expired ticket (run `kinit`) or for a ticket that does not reach the server (the SPN).
On Windows, SSPI failures keep SqlClient's message as `SQL_ERROR`. A ticket can also expire while connected, so every later open
from the connection maps a token failure the same way, without `details`: a query tab's session (`query.execute` answers
`AUTH_KERBEROS`, as it answers `SESSION_LOST`, and the next execution opens a new session), `databases.list`,
`tables.columns` (an error response), and `explorer.children` and `scripting.script` (a retryable `AUTH_KERBEROS` value: on the
node, and as Script As' `result.error`, "Could not script dbo.Orders: " and the advice). Connect's settings, which those pools derive from, set `Pool Blocking Period=NeverBlock`: SqlClient's default blocks
a pool after a failed open and rethrows that failure for 5 to 60 seconds without trying, so a Connect or Retry after
`kinit` would show the stale failure.

Microsoft Entra failures answer `AUTH_ENTRA` (Entra Integrated off Windows answers `AUTH_UNSUPPORTED` before anything is
opened). For connect and Load databases the `details` are error number 0, class 11, state 0 and the server, except that
an invalid user name or password (AADSTS50126) or client secret (AADSTS7000215) carries that number, which main's forget
rule for remembered passwords reads. The message is Varia's for a sign-in cancelled in the browser, a browser that could
not be opened, those two AADSTS errors, multifactor authentication required under Entra Password, no managed identity,
no identity for Entra Default, a refused sign-in address or resource, the 3-minute limit, a token cache cleared while the
browser waited, and a browser sign-in as another account than the user name entered; otherwise it is SqlClient's
first line followed by MSAL's or Azure.Identity's text. Messages are at most 2,000 characters on one line, with anything
shaped like a JSON Web Token redacted. Login failed (18456) on an Entra connect adds "If you were recently granted
access, choose Help › Clear Entra ID Token Cache, then connect again." The same pool opens as Kerberos's answer
`AUTH_ENTRA`, without `details`: a query tab's session, `databases.list`, `tables.columns`, and retryable
`AUTH_ENTRA` values for `explorer.children`, `scripting.script` and the object actions.

| Origin | Codes |
| --- | --- |
| Backend | `INVALID_REQUEST`, `INVALID_PARAMS`, `METHOD_NOT_FOUND`, `BUSY`, `CANCELLED`, `TIMEOUT`, `SQL_ERROR`, `SMO_ERROR`, `BACKEND_ERROR`, `NOT_CONNECTED`, `NOT_FOUND`, `DUPLICATE_QUERY`, `DUPLICATE_REQUEST`, `SESSION_BUSY`, `SESSION_LOST`, `SESSION_CLOSED`, `SESSION_TARGET`, `SESSION_LIMIT`, `AUTH_UNSUPPORTED`, `AUTH_KERBEROS`, `AUTH_ENTRA`, `INVALID_SCRIPT`, `TOO_LARGE`, `RESPONSE_TOO_LARGE`, `RESULT_NOT_FOUND`, `RESULT_RELEASED`, `VIEW_NOT_FOUND`, `IDENTITY_NOT_FOUND`, `EXPORT_FAILED` (message: one token), `RESULT_OPEN` |
| GOAWAY | `PROTOCOL_ERROR`, `PROTOCOL_UNSUPPORTED`, `BACKEND_CRASH` |
| Main | `BACKEND_LOST`, `BACKEND_UNAVAILABLE`, `CONNECTION_LOST`, `RESULT_UNAVAILABLE`, `TOO_MANY_REQUESTS`, `STREAM_PROTOCOL`, `PORT_CLOSED`, `TIMEOUT`, `CANCELLED` and `DUPLICATE_REQUEST` (Object Explorer loads, scripting, object actions and SSIS requests), `JOB_BUSY`, `TOO_LARGE` and `INVALID_REQUEST` (results jobs), `STALE` (a shortcuts save based on an older revision), `DUPLICATE_REQUEST` and `NOT_FOUND` (live streams of the results port); an unknown backend code becomes `BACKEND_ERROR` |
| Renderer | `PAGE_INVALID`, `RESULT_DECODER_FAILED` |

| Code | Sentence |
| --- | --- |
| `BACKEND_LOST` | "The SQL backend stopped before answering. The request was not retried." |
| `BACKEND_LOST` (`query.execute`) | "The SQL backend stopped while this script was running. It was not re-run. Statements that finished before the failure may have taken effect; SQL Server rolls back the session's open transaction when it detects the closed connection." |
| `BACKEND_LOST` (reload) | "The workbench was reloaded." |
| `CONNECTION_LOST` | "This connection was lost when the SQL backend restarted. Reconnect to continue; its sessions, temporary tables, and open transactions are gone." |
| `BACKEND_UNAVAILABLE` | "The SQL backend is not running. Use Restart SQL Backend from the command palette."; while closing, "The application is closing."; for a failed start, the spawn or incompatible sentence below |
| `RESULT_UNAVAILABLE` | "These results are no longer available because the SQL backend restarted." |
| `TIMEOUT` (main) | "The SQL backend did not answer within {n} seconds. The request was cancelled." |
| `TIMEOUT` (backend) | "The operation exceeded its time limit of {n} seconds." ("…its time limit." for the backend's own limits) |
| `TOO_LARGE` (main) | "The request is too large to send to the backend. Execute a smaller script or selection." |
| `TOO_MANY_REQUESTS` | "Too many pending backend requests."; for a 17th live stream on the results port, "Too many live views are open in this window. Close one and retry." |
| `DUPLICATE_REQUEST` (results port, live) | "This live view is already open." |
| `NOT_FOUND` (results port, live update) | "This live view has ended." |
| `STREAM_PROTOCOL` | "The SQL backend sent an invalid response. The request was cancelled." |
| `RESPONSE_TOO_LARGE` | "The backend result is too large to return (limit 16 MB)." |
| `TOO_LARGE` (copy, main's cap) | "The selection is too large to copy (more than 64 MB). Use Save Results As instead." |
| `JOB_BUSY` | "Another Save Results As is in progress. Wait for it to finish or cancel it." |
| `STALE` | "Shortcuts changed since they were opened. Review them and save again." |
| `RESULT_UNAVAILABLE` (closed during the save dialog) | "These results were closed before they could be saved." |
| `RESULT_OPEN` | "Save the results after this result set finishes loading." |
| `EXPORT_FAILED` | "Could not save the results: " + `ACCESS` "access to {file} is denied.", `DISK_FULL` "the disk is full.", `IN_USE` "{file} is open in another program.", `NOT_FOUND` "the folder no longer exists.", `IS_DIRECTORY` "{file} is a folder.", otherwise "{file} could not be written." |

| Surface | Text |
| --- | --- |
| Status bar | "Starting SQL backend…", "Ready" (its tooltip names the runtime and the SMO and SqlClient versions), "SQL backend not responding…", "Restarting SQL backend…", "SQL backend unavailable" |
| Banner: not responding | "The SQL backend is not responding. You can keep waiting, or restart it; restarting closes all connections and rolls back uncommitted transactions." **Restart now** |
| Banner: unexpected restart | "The SQL backend stopped unexpectedly and was restarted. {n} connection(s) were lost and {m} running script(s) were stopped; nothing was re-run." **Reconnect…** **Dismiss** |
| Banner: manual restart | "The SQL backend was restarted. {n} connection(s) were closed." **Reconnect…** **Dismiss** |
| Banner: crash loop | "The SQL backend stopped repeatedly and was not restarted again." **Restart SQL Backend** **Copy details** |
| Banner: cannot start | Development: "Could not start the .NET backend. Install .NET 10 and run npm run backend:build." Packaged: "Could not start the SQL backend. Reinstall Varia SQL Manager." |
| Banner: different build | "The SQL backend is from a different build (protocol {x}, expected 2{; missing: method}). Run npm run backend:build, then restart." (packaged: "Reinstall Varia SQL Manager.") |
| `SESSION_LIMIT` | "This query was not executed: 1,000 query tabs already hold SQL sessions, the most Varia SQL Manager keeps open. Close query tabs you no longer need, or disconnect idle ones (Query > Connection > Disconnect), then execute again." |
| `SESSION_LOST` (commit) | "The SQL session was lost, so SQL Server rolled back its transaction. Nothing was committed." While the commit ran: "The SQL session was lost while committing, so it is not known whether its transaction was committed. Check the data before running the work again." After a commit that never answered (state read too): "The SQL session was lost after a commit that did not finish (it was cancelled or timed out), so it is not known whether that commit took effect. Check the data before running the work again." |
| Execute hint, lost connection | "This query's connection was lost when the SQL backend restarted. Reconnect to run queries." |
| Running placeholder | "Your query is running… {n} rows" |

**Copy details** lists the generation, status, the last loss and its reason, exit code and signal, uptime, losses in the
last 120 s, the protocol, runtime and OS, and the stderr lines described above.

## Display formats

The backend formats every non-binary value into the text SSMS 2022 shows (`CellFormat.cs`), so the renderer never
formats SQL types. Every sample is a case in `tests/fixtures/sql-display.json`, checked against `CellFormat` offline and
against SQL Server by the live type matrix. Reads use `CommandBehavior.SequentialAccess`, call `IsDBNull` first, and read
each column once, in order, with a reader chosen once per result set from the schema table. A long value is kept up to
its cap and the rest is read past in 8,192-unit chunks (text and ntext through `GetTextReader`: `GetChars` reads their
whole value; json as UTF-8 bytes through `GetBytes`, decoded by the backend, since SqlClient 7.1.1's `GetChars` decodes
json one byte per character and its `GetTextReader` throws when a read ends inside a multi-byte sequence). The rows that are not stored (past `maxRows`, after the budget stops storing, or in a set that is not
kept) are read past with a synchronous `Read` when their set has a long column, on a dedicated thread: that `Read` also
waits for the server's next row (a lock, a slow plan), and on thread-pool threads a few such queries delayed every other
request, cancels included, by seconds. Either way, nothing near a huge value's size is held, and a cancel stops it: left
unread, the next `ReadAsync` would buffer all of it, in time quadratic in its size.

| SQL type | Display | Samples |
| --- | --- | --- |
| bit | `1` / `0` | `1`, `0` |
| tinyint, smallint, int, bigint | exact | `-9223372036854775808` |
| decimal, numeric (precision ≤ 28) | the column's scale | `-123.4500`, `42`, `0.50` |
| decimal, numeric (precision 29 – 38) | exact, via `SqlDecimal` | `12345678901234567890123456789012345678`, `1.5000000000` |
| money, smallmoney | two to four decimals (`0.00##`) | `1.00`, `1431.50`, `123.4567`, `-922337203685477.5808` |
| real | 7 significant digits (`G7`) | `0.1`, `3.141593`, `3.402823E+38`, `-1.5` |
| float | 15 significant digits (`G15`) | `0.1`, `0.3` (`0.1E0 + 0.2E0`), `3.14159265358979`, `1E+20`, `1E-05`, `2`, `-1.79769313486232E+308` |
| date | `yyyy-MM-dd` | `2026-10-08` |
| time(n) | n fractional digits | `12:34:56.1234567`, `00:00:00.0000000`, `12:34:56` |
| smalldatetime | `yyyy-MM-dd HH:mm:ss` | `2026-10-08 12:34:00` |
| datetime | milliseconds | `2026-10-08 12:34:56.123`, `1753-01-01 00:00:00.000` |
| datetime2(n) | n fractional digits | `2026-10-08 12:34:56.1234567`, `9999-12-31 23:59:59` |
| datetimeoffset(n) | n fractional digits and the offset | `2026-10-08 12:34:56.1234567 +05:30`, `2026-10-08 12:34:56 -08:00` |
| uniqueidentifier | uppercase | `6F9619FF-8B86-D011-B42D-00C04FC964FF` |
| char, varchar, text, nchar, nvarchar, ntext, sysname | the text; lone surrogates become U+FFFD; truncation never splits a pair | `héllo 😀` |
| xml, the showplan column | the text as SqlClient serialises it, role `xml` / `plan`, up to 2,097,152 characters. Streamed (`Results/SequentialXml.cs`): XmlReader parses the column's sequential stream as UTF-16 as it arrives, a text node's value is copied out in 8,192-character chunks, and once the cap is reached the rest of the value is read past as bytes, without parsing, so a long text node costs a few MB whatever its length (a 200 MB value allocates under 32 MB in all). XmlReader holds a whole start tag (all of its attributes together), comment or processing instruction before returning it, so the stream reports its end once 8 MiB pass with no new output; a node just inside that window is read whole, growing XmlReader's buffer to about 50 MB allocated in all. A cut value still keeps its first 2,097,152 characters, marked truncated: what the writer had written before that node, the parent's start tag closed with its `>`, then the node's own text as SQL Server sent it (`<r><a b="yyy…`, `<r>hello<a b="yyy…`, or `<a b="yyy…` when the node is the root element). The feed keeps that raw text from the node's `<` (it counts the `<` of every node XmlReader returns), at most the cap's worth, in 32 Ki-character chunks from the shared array pool that go back as XmlReader returns the nodes they hold and when the cell ends, so a long node read whole (most are) allocates nothing for it once the pool holds them. A cut node whose start the feed could not keep (one that follows, within XmlReader's look-ahead, a start tag read whole but longer than the cap and shrunk below it by character references), keeps only what was written before it, the parent's start tag closed. A NameTable that a cell's names grow past its cap (4,096 names or 262,144 characters) is dropped as that cell ends. Every xml cell of a set reuses one output buffer and one feed, so a small cell allocates about 28 KB, mostly XmlReader's and XmlWriter's own buffers (the live .NET suite reports it and checks it stays under 36 KB). SqlClient 7.1.1's `GetXmlReader` lets XmlReader guess the encoding (a value that starts with text throws or, for some characters, reads as other text; fixed after 7.1.1), so the stream is opened as `GetXmlReader` opens it, through SqlClient internals that an offline check pins, with `GetXmlReader` as the fallback (a malformed tail past the cap keeps the stored prefix, with a column message). `GetChars` on xml holds each node whole and is quadratic in a large text node, `GetSqlXml` reads the whole value, and `GetStream` and `GetTextReader` reject xml | `abc`, `é<a b="1" />` |
| json (SQL Server 2025) | the text, role `json`, up to 2,097,152 characters | — |
| vector (SQL Server 2025) | float32 values, shortest form, role `vector` | `[0.1,2,-3.5]` |
| binary, varbinary, image | `0x` + uppercase hex, up to 32,766 bytes | `0x0001FF`, `0x` |
| timestamp, rowversion | `0x` + uppercase hex | `0x00000000000007D1` |
| hierarchyid, geometry, geography, other CLR types | serialized bytes as `0x…`, as SSMS shows them; role `udt` | — |
| sql_variant | its base type's format; `SqlBinary` as `0x…` text. SqlClient reports neither the base type nor its scale, so date, time, datetime2 and datetimeoffset show 7 fractional digits (a date also shows `00:00:00.0000000`) and smalldatetime shows milliseconds | `2026-10-08 00:00:00.0000000`, `12:34:56.0000000`, `2026-10-08 12:34:00.000` |
| NULL | `NULL`, styled with `resultsGrid.nullForeground` | — |

SSMS runs on .NET Framework, whose default text for float and real has 15 and 7 significant digits, so SSMS shows
`PI()` as `3.14159265358979`, not .NET's shortest round-trip `3.141592653589793`; negative zero shows as `0`. The money
and float samples (`1.00`, `123.4567`, `1E+20`, `3.14159265358979`, `3.141593`) still await the owner's check against
SSMS 2022 on Windows; a correction is one line in `CellFormat.cs` plus its fixture line. The SQL Server 2025 json and vector paths are checked
only against a 2025 server; CI runs 2022 and reports that block as skipped.

## Security

- **Renderer → main.** Invoke requests pass `trusted()` and strict zod; port messages pass `portRequestSchema`,
  ownership and generation checks, clamped credits, an outstanding-request cap, an invalid-message limit and an open
  rate limit. Main never forwards renderer bytes: it re-encodes validated objects. `debug.*` methods are in no renderer
  schema.
- **Backend → renderer.** Unary responses and events are decoded in main under the control limits; pages are opaque to
  main, size- and credit-checked, copied exactly, decoded only in the results worker, and rendered as text.
- **SQL Server data is untrusted content**, bounded by the cell, row, page and budget limits.
- **Paths.** The renderer never names a file: main takes paths from its own dialogs, the command line, a second
  instance's handover, macOS's open-file and its Recent Files store, and the page refers to files by opaque ids. A drop
  is read in the preload's isolated world, from trusted events only, and sent on `varia:files-dropped`, which
  `window.varia` does not expose; main still accepts only absolute paths to regular files, at most 32, and reads them
  as Open does (5 MB).
- **AutoRecover** (`varia:recovery-write`, `-list`, `-take`, `-discard`, main's channels with strict zod schemas)
  writes query text, never results, connections or credentials, to `<userData>/AutoRecover/<uuid>.json` (a lower-case uuid;
  a file named in upper case still counts against the caps, is quarantined rather than offered, and is purged): the folder is
  0700 and each record 0600 on POSIX, written to a temporary file that is chmodded, synced and renamed, and never logged.
  The page names a record only by uuid and its file only by its opaque id; main adds the path from its own
  registration. Each record is owned by the main process and renderer generation that wrote it (the page the main frame
  had committed when the message arrived, so a page being replaced by a reload still writes as itself): a page may write only
  a new record or one its generation owns, and is offered every other (an earlier run's after a crash, kill or power
  loss; an earlier generation's after the renderer stopped or reloaded), which taking moves to it, once: a record is
  handed over only while it is offered, so it never backs two tabs. Writes stop while
  AutoRecover is off and once a close is approved; an approved close deletes the page's records first. An invalid
  record is quarantined and never offered; records, quarantined records and interrupted writes older than Keep
  AutoRecover information for are deleted at startup, only once settings were read, and not when settings.json held a
  retention that was reset because the file or that value was invalid.
- **Hot exit** (`varia:session-write`, `varia:session-take`, strict zod schemas; docs/hot-exit.md) writes the open text
  tabs' names, text (for untitled and unsaved tabs), line endings, file paths (main's, from the page's opaque file ids),
  server and database names to `<userData>/Session/session.json` as an approved close goes ahead: 0700/0600 on POSIX,
  atomic, at most 64 tabs and 64 MB, never results, connections, logins or credentials, never logged. The next start takes
  it and keeps it as `previous.json` until that run closes; an invalid file is quarantined. A close with hot exit off
  keeps only pinned tabs, or deletes both when there are no pins. Startup and Reload Window hold their checkpoint
  until a renderer has reopened the tabs and acknowledges it with `varia:session-restored`.
- **Secrets.** Passwords exist only inside REQUEST bodies on the private pipe: never in arguments, environment,
  `BackendState`, the fake backend's call log, traces or stderr. Lost connections keep their options without the
  password. A remembered password (Remember password) is Electron `safeStorage` ciphertext in `saved-passwords.json`,
  bound to its server, login and TLS settings by a SHA-256 hash beside it and a check over them and the password inside
  it (so a ciphertext moved between entries, or a rewritten hash, is refused); main decrypts it (async API only) and
  puts it into a `connections.connect` or `.databases` request whose options have that binding and an empty password,
  after `validateRequest`, and the frame is zeroed as before. The renderer only learns which history entries have one.
- **Test seams** are honoured only when `VARIA_SMOKE_TEST=1` and the app is not packaged: `VARIA_TEST_BACKEND` (with an
  absolute `VARIA_TEST_NODE`), `VARIA_BACKEND_TEST_HOOKS`, `VARIA_RESULT_BUDGET_BYTES`, `VARIA_BACKEND_LIVENESS_MS`,
  `--varia-test-mode` (`window.__variaResults`, `window.__variaGrid`, and `window.__variaRecovery.flush()`, AutoRecover's save at once),
  `globalThis.__variaTest`, and `VARIA_TEST_SAFE_STORAGE=test` (Remember password's reversible test cipher in place of
  `safeStorage`, for runs without a keyring). `VARIA_IPC_TRACE=1` (unpackaged only)
  logs each frame's kind, id and length to stderr, never a body.

## Testing

- **Shared vectors and golden pages.** `tests/fixtures/ipc-vectors.json` (control bodies, frames and pages, valid and
  invalid) is checked by both codecs; `tests/fixtures/pages/*.page` are written by the .NET checks
  (`VARIA_UPDATE_GOLDEN=1` after an intended format change) and decoded and re-encoded byte for byte in TypeScript.
- **Fuzzing.** Seeded on both sides; a failure prints its seed (`VARIA_FUZZ_SEED` replays it, `VARIA_FUZZ_ITERATIONS`
  raises the count). The differential test compares the TypeScript codec with `@msgpack/msgpack` (a devDependency used
  by that test only).
- **Fake backend.** `tests/fixtures/backend.mjs <mode>` speaks v2 through the real wire code under Node's type
  stripping, with modes for each misbehaviour (`silent`, `exit`, `crash-after`, `bad-magic`, `oversize`, `truncated`,
  `no-hello`, `v1`, `wrong-version`, `missing-method`, `late`, `credit-overrun`, `seq-gap`, `unknown-id`, `contained`,
  `unresponsive`, `live-overrun`, `live-data`, `live-big`, `live-seq-gap`, and others; echo mode runs `live.subscribe` as a few
  status ticks under stop-and-wait) and a `workbench` mode, whose `live.subscribe` runs `debug.synthetic` as the backend does, for the Electron smoke tests, controlled through
  `VARIA_TEST_BACKEND_DIR` (`calls.jsonl`, `hold/<method>`, `allow/audits`, `crash-next`, `fail-commit`, `silent-<generation>`). Each
  session counts its scripts' BEGIN TRAN, COMMIT and ROLLBACK and notes SET NOEXEC, PARSEONLY, FMTONLY and SHOWPLAN_*,
  so `query.session.state` answers as SQL Server would. A
  script whose first line is `-- varia-fake: sets=W1*200000@50000,N1*100,X1*5000,L1*3 messages=40 errors=2 memory=0.92
  hold` streams synthetic sets (`tests/fixtures/backend/shapes.mjs`; `@rate` is rows a second, `M1*n` is n one-row sets)
  with progress, message entries and a memory event, pages encoded per block on first read; `results.copy` and
  `results.export` use `text-writer.mjs`, and `hold/results.export` pauses an export after each page so a test can
  cancel it mid-save.
- **Copy and Save goldens.** `tests/fixtures/results-text/cases.json` holds small result sets (every edge the formats
  treat specially) with the exact Copy, CSV, TSV and JSON bytes; the C# writer and the JavaScript twin are both checked
  against them, through the real copy and export jobs on the C# side.
- **Real backend.** `tests/backend-sidecar.test.ts` drives the Release build over `BackendConnection`, including
  malformed frames, stdout purity and, with the test hooks, synthetic results, streams, cancellation, the budget, and live
  subscriptions whose every frame must pass main's schemas. `tests/live-protocol.test.ts` runs main's whole live path
  (supervisor, results port, a worker stand-in) over the fake backend, then the same path through the real worker
  core and `ResultClient`, and a `LiveService` view on it hidden, shown, lost with a restart and back after a Reconnect.
  `tests/live-service.test.ts` drives `LiveService` against a fake client with fake timers (the hysteresis, user pause,
  update order, debounce, stale, lost and Reconnect, kept tables, the 16-view cap, status-only views, `peek`, ring
  memory, the track lists a sample may answer), `tests/live-ring.test.ts` the ring and `tests/live-status.test.ts` the
  indicator text.
  `tests/chart-view.test.ts` draws charts into a context that records styles, paths and text: at most two vertices a
  pixel column for 7,200 samples, gaps and missing values breaking lines, no draw while hidden or unchanged, every color
  from the theme (the DOM's system colors, followed through a palette change, and dashes under forced colors), stacked
  bands and where they break, crosshair dots on the bands, the 5 s accessible name held while focused, the keyboard and
  pointer crosshair (a keyboard one kept on the oldest sample and a pointer's under the pointer as a live window moves, a
  move repainted without reading the window again), the tooltip inside a narrow plot, series indexes the ring lacks,
  stacked gaps, lone samples and missing values, the 12-series cap, linked charts, the table and `probeCurrent`'s bound;
  `tests/live-service.test.ts` binds a chart to a view and checks that "now" follows the probe's state through an
  interval change, a refresh, a back-off, a pause and a resume, and that a ring resize redraws a paused view's chart.
  `tests/live-grid.test.ts` covers `LiveGrid` against a stand-in grid and view (the swap's row map and
  selection, the tone column, tracked keys and how many linger, pinned keys a revision has not answered, prepare, follow
  tail and new rows, remounts over kept state, the selection, lost and released state it publishes, per-table sort, Copy), and `tests/results-jobs.test.ts` and `tests/results-port.test.ts` a Save of a live revision retired while
  its dialog is open.
  `scripts/backend-smoke.mjs` covers restarts, lost connections, the crash loop, the silent backend, a protocol 1
  backend, UI responsiveness while a million stored rows are read, and a live subscription to the real backend's
  `debug.synthetic` source through the Electron results worker, held by an unacknowledged tick. `scripts/live-smoke.mjs`
  runs `LiveService` views in the app on the fake backend through `window.__variaLive`: ticks acknowledged in turn, a
  hidden window pausing the view within 3 s and its frames stopping, a resume with a gap, a tab switch, the owner tab
  closing, and a killed backend reported lost and back after Reconnect. `scripts/chart-smoke.mjs` mounts charts of such
  a view and reads their canvas pixels: the series in the theme's chart color, redrawn as ticks arrive and not while the
  window is hidden, the accessible name (held while focused), the keyboard and pointer crosshair (a pointer held still near either edge
  keeps its tooltip as the window moves; a narrow two-series chart keeps its tooltip inside the plot), the table (its caption,
  header, focus ring and row cap), a legend of two series and none for one, a tile's sparkline (which takes no focus), a switch to Light, and
  forced colors through a dark-to-light contrast theme change, the pixels contrasting with the box behind them.
  `scripts/live-grid-smoke.mjs` mounts `LiveGridPane` (`window.__variaLive.mountGrid`) over the real backend's synthetic grid and log: tones and the hidden tone
  column, the selected item kept across revisions, muted once it leaves and then moved to a neighbour (with its key
  reported), Copy without the tone, a Save whose dialog stays open across samples, the sort hook, follow tail and "n new
  rows", a log mounted again over its kept state opening where it was, a stopped view's overlay and Copy, and a killed
  backend's overlay. `scripts/results-smoke.mjs` drives the grid on
  the fake backend's sets and then, with `VARIA_TEST_SQL_SERVER` set, against that server: a million rows shown while
  the script runs, Cancel keeping them, Copy of 100,000 rows and Save Results As of a million compared with the rows
  the query produces, a FOR XML PATH value, and an error reported between the messages around it.

## Benchmarks

```sh
npm run bench                                   # node harness: codecs, main ↔ Release backend ↔ results worker, grid models, chart draw, plan layout, object search
npm run bench:e2e                               # Electron, real backend with test hooks (add -- --live for SQL Server)
npm run bench:grid                              # Electron, the results grid on the fake backend (add -- --live for SQL Server)
node scripts/check-bench.mjs [--enforce]        # compare with tests/bench/floors.json; markdown to $GITHUB_STEP_SUMMARY
```

The harnesses need the Release backend and, for `bench:e2e` and `bench:grid`, the built app (`npm run check`). They
write `artifacts/bench/node.json`, `e2e.json` and `grid.json`; they are not part of `npm run check`. The benchmarks only
measure (and check that every row and cell arrived); `check-bench.mjs --enforce` fails when a value is worse than its
floor, or when a metric with a floor was not measured (a live one only when its harness ran `--live`). CI enforces
floors on Linux (with live SQL Server); Windows and macOS report only.

- **W1** is a typical wide row: int, nvarchar(50), datetime2(7), decimal(18,2), uniqueidentifier, nvarchar(200) of 80
  characters, bit, and an int that is NULL in every fifth row (about 220 bytes encoded). **B1** is two nvarchar(max)
  values of about 4 KB. Both come from `debug.results.synthesize`, so the backend stores them as it would query rows.
- **The node pipeline** runs main's real classes: `BackendSupervisor` and `BackendConnection` over stdio to the Release
  backend, `ResultsPortHost` over a `MessageChannel`, and `ResultsWorkerCore` in a worker thread reading windows of
  every row with every cell decoded (four windows in flight). Its live round trip subscribes the worker core to the
  backend's `debug.synthetic` source every 10 ms and has the bench's thread (the page) acknowledge each event 20 ms after
  it arrived, so the next sample is overdue when its credit reaches the backend: the time from an acknowledgement to the
  next event is the whole loop (page → worker → main → backend → main → worker → page), not the source's schedule.
  Its backend start spawns six fresh backends and times the last five (warm disk cache) from spawn to HELLO answered and
  then their first `system.health`, for the IL Release build and, with `VARIA_BENCH_BACKEND=<Varia.Backend executable>`, a
  published one such as the ReadyToRun build release packages carry (`dotnet publish -r <rid> --self-contained -c Release`):
  about 235 ms against 280 – 330 ms IL on a busy 24-CPU Windows desktop, 9 against 13 – 15 ms to the first answer. CI's
  Linux benchmarks publish that build as package.yml does and set the variable, and the bench first fails unless
  `Varia.Backend.dll`, `Microsoft.Data.SqlClient.dll` and `Microsoft.SqlServer.Smo.dll` there are ReadyToRun, so a publish
  that stops precompiling them fails a pull request rather than slowing a release.
- **The live snapshot churn** runs main's live path (`ResultsPortHost` with the test sources, the supervisor, the Release
  backend's table writer) with a worker stand-in that acknowledges each frame at once: `debug.synthetic.wide` stores 5,000
  rows of 23 typed columns every 10 ms if it can, each revision owned, retired, forgotten and released one at a time, for 5 s.
  It reports revisions a second and the backend's gen2 collections per revision, times 60: what a 1 s snapshot of that
  size runs a minute. The collections follow the revisions, not the clock (0.32 a revision at 10 ms and at 1 s alike), and
  none is induced or set off by the large object heap: a GC event listener counted every collection as an allocation
  budget one (reason AllocSmall), about 60 % of the gen2 ones blocking, and only the reused key dictionary allocating
  large objects. Each revision's source rows and pages live across a collection or two and are promoted (about 6 MB a
  revision out of gen0), so gen2 fills with revisions already released. The forced collection never runs for live tables.
  On a 24-CPU Windows machine: 52 – 54 revisions/s, 18 – 20 collections a minute (about 1,000 a minute at 10 ms).
- **The grid models** (`tests/bench/grid.bench.ts`) time what the results grid computes for each frame of a
  1600 × 1000 view, in one thread: selection blocks against the cells in view, scroll mapping past the scroll cap, tile
  planning, and the shared window cache (full, so every insert evicts). **The chart draw** (`tests/bench/chart.bench.ts`)
  times `ChartView`'s whole draw of a full ring (7,200 samples, two hours at 1 s) of six series over a 1,600 px chart
  with axes, into a context that only counts calls: what a live chart costs a frame at most.
- **The object search** (`tests/bench/search.bench.ts`) runs the .NET test program's `--search-bench` mode
  (`backend/Varia.Backend.Tests/SearchBench.cs`, built by `dotnet run` when out of date): Search Objects' in-memory search
  over a synthetic index of 1,000,000 objects in 20 databases (5,000 tables each, with 9 columns), for one letter, as the
  first key typed is. 700,000 objects match, so the scan runs far past the 20,000-candidate cap: it reports the p95 time
  of 20 warm searches and the memory one allocates, which stays bounded by the cap rather than by the hits.
- **The e2e run** reads every row through `window.__variaResults` in the built app (four windows in flight), watching
  the UI thread for long tasks and animation-frame gaps, and times 500 live ticks of the real backend's `debug.synthetic`
  source through `ResultClient.live` as the node pipeline does; `--live` stores a million W1-like rows from SQL Server with
  `maxRows: 0`, then 200,000 rows that each hold a small xml value (parsed and serialised cell by cell, as SqlClient's
  GetChars would), and times 200 executions of `SELECT 1` in a warm tab.
- **The grid run** (`scripts/grid-bench.mjs`) drives the built app in a 1600 × 1000 window (or the screen, if smaller)
  on the fake backend's synthetic sets: the first data cell painted after `resultSet.opened`, the UI thread's busy share
  while a million rows stream, `GridView.frame()` times from `window.__variaGrid` while the wheel scrolls a million rows
  and while scroll bar jumps cross 300 columns, each such jump's main-thread task time from the DevTools protocol (with
  300 bit columns too, the narrowest cells), the animation-frame intervals while 300 columns and 300 bit columns scroll
  down 400 px every frame for 3 s (natively, and past a lowered scroll cap), the DOM elements of a grid, scroll bar jumps to random rows of a million
  (each a cache miss), the window and page caches after a sweep and 300 jumps, heap growth after a collection, and long
  tasks. `--live` copies 100,000 rows and saves a million rows as CSV from SQL Server, comparing the text with the rows
  the query produces.

| Metric | Target | Floor (Linux CI) | Measured, 4 CPUs | Measured, 2 CPUs |
| --- | --- | --- | --- | --- |
| Control encode + decode, 1 KiB map | ≥ 100,000 ops/s | ≥ 25,000 ops/s | 46,000 – 50,000 ops/s | 55,000 ops/s |
| Frame parse, 64 KiB chunks, mixed sizes | ≥ 1,000 MB/s | ≥ 250 MB/s | 2,800 – 4,100 MB/s | 3,900 MB/s |
| `decodePage` and the text of every cell, W1 page | ≥ 300 MB/s | ≥ 75 MB/s | 370 – 385 MB/s | 395 MB/s |
| main ↔ backend `system.health`, p50 / p99 | ≤ 0.3 / 2 ms | p50 ≤ 2 ms | 0.12 – 0.14 / 0.4 – 0.5 ms | 0.09 / 0.8 ms |
| 256 concurrent `system.health` | ≤ 150 ms | ≤ 1 s | 4 – 7 ms | 7 ms |
| Backend start: spawn to HELLO answered, warm disk cache, median | ≤ 300 ms | ≤ 3 s | 280 – 330 ms (IL, Windows, 24 CPUs) | not measured |
| Backend start: the first `system.health` after HELLO, median | ≤ 20 ms | reported only | 13 – 15 ms (IL, Windows, 24 CPUs) | not measured |
| Published ReadyToRun backend start: spawn to HELLO answered, median | ≤ 250 ms | reported only | about 235 ms (Windows, 24 CPUs) | not measured |
| Published ReadyToRun backend start: the first `system.health` after HELLO, median | ≤ 15 ms | reported only | about 9 ms (Windows, 24 CPUs) | not measured |
| Live snapshot revisions, 5,000 × 23, stored, sent, acknowledged and released | ≥ 50 swaps/s | ≥ 10 swaps/s | – | – |
| Backend gen2 collections a minute of a 1 s snapshot of them (per revision × 60) | ≤ 60 | ≤ 120 | – | – |
| W1, 500,000 rows, store → main → port → worker | ≥ 1,000,000 rows/s, ≥ 200 MB/s | ≥ 250,000 rows/s, ≥ 50 MB/s | 710,000 – 935,000 rows/s, 150 – 203 MB/s | 514,000 – 612,000 rows/s, 112 – 133 MB/s |
| B1 through the same path | ≥ 400 MB/s | ≥ 100 MB/s | 250 – 410 MB/s | 249 MB/s |
| Main event-loop delay during W1, p99 | ≤ 20 ms | ≤ 100 ms | 12 – 14 ms | 17 ms |
| Page bytes sent ÷ distinct page bytes, W1 | ≤ 1.05 | reported only | 1.29 | 1.29 |
| Budget charged ÷ page bytes | ≤ 1.15 | ≤ 1.5 | 1.00 | 1.00 |
| Live tick round trip, acknowledgement → next tick at the page, p50 | ≤ 2 ms | ≤ 10 ms | 0.7 ms, p99 3.6 ms (Windows, 24 CPUs) | not measured |
| Grid frame: 64 selection blocks clipped, 1,800 cells tested | ≥ 5,000 ops/s | ≥ 1,000 ops/s | 4,500 – 4,900 ops/s | 5,300 – 5,700 ops/s |
| Grid frame: Mode B scroll mapping, 100M rows | ≥ 5,000,000 ops/s | ≥ 1,000,000 ops/s | 6,500,000 – 7,600,000 ops/s | 6,800,000 – 7,300,000 ops/s |
| Grid frame: visible range, tiles and prefetch ring, 300 columns | ≥ 500,000 ops/s | ≥ 100,000 ops/s | 700,000 – 850,000 ops/s | 800,000 – 870,000 ops/s |
| Grid frame: window cache, 3 lookups and 1 insert at 256 windows | ≥ 100,000 ops/s | ≥ 25,000 ops/s | 157,000 – 174,000 ops/s | 178,000 ops/s |
| Object search: one letter over 1,000,000 indexed objects (700,000 hits), p95 | ≤ 75 ms | ≤ 500 ms | 55 ms (Windows, 24 CPUs; 166 ms before hits were built lazily) | not measured |
| Object search: memory allocated by that search, median | ≤ 16 MB | ≤ 64 MB | 9 MB (322 MB before) | not measured |
| Plan ordered layout: 2,000 operators, 1,999 ordered inputs, p95 | ≤ 20 ms | ≤ 500 ms | 2.8 – 4.1 ms (Windows, 24 CPUs) | not measured |
| Plan ordered layout: 10,000 operators, four-way tree, p95 | ≤ 75 ms | ≤ 1,000 ms | 9.9 – 12 ms (Windows, 24 CPUs) | not measured |
| Plan cached layout lookup: 10,000 operators, p95 | ≤ 5 ms | ≤ 50 ms | 0.92 – 1.08 ms (Windows, 24 CPUs) | not measured |
| Plan comparison: two 10,000-operator inputs, unique/ambiguous, worst p95 (worker transport excluded) | ≤ 200 ms | ≤ 2,000 ms | 27–167 ms (Windows, 24 CPUs, varying concurrent load) | not measured |
| Chart draw: 7,200 samples × 6 series bucketed and stroked at 1,600 px | ≥ 1,000 ops/s | ≥ 100 ops/s | 770 – 780 ops/s (Windows, 24 CPUs) | not measured |
| Renderer invoke → backend → renderer, p50 / p99 | ≤ 1 / 5 ms | p50 ≤ 5 ms | 0.4 / 1.2 – 1.6 ms | 0.4 / 2 ms |
| Live tick round trip in the app, acknowledgement → next tick at the page, p50 / p99 | ≤ 2 / 10 ms | p50 ≤ 10 ms | 0.7 / 2.8 – 4 ms (Windows, 24 CPUs) | not measured |
| W1, 500,000 rows into the worker and UI windows | ≥ 500,000 rows/s, ≥ 100 MB/s | ≥ 100,000 rows/s, ≥ 20 MB/s | 240,000 – 303,000 rows/s, 52 – 66 MB/s | 200,000 rows/s, 44 MB/s |
| B1 into the worker | ≥ 200 MB/s | ≥ 40 MB/s | 90 – 143 MB/s | 90 MB/s |
| First 100-row window of a stored result | ≤ 50 ms | ≤ 250 ms | 17 – 21 ms | 20 ms |
| UI long tasks over 50 ms during W1 | 0 | ≤ 2 | 0 | 0 |
| Largest animation-frame gap during W1 | ≤ 50 ms | ≤ 300 ms | 17 – 33 ms | 133 ms |
| Live: 1,000,000 W1-like rows ingested and stored | ≥ 300,000 rows/s | ≥ 75,000 rows/s | 280,000 – 298,000 rows/s | 280,000 rows/s |
| Live: 200,000 rows with a small xml cell ingested and stored | ≥ 200,000 cells/s | ≥ 25,000 cells/s | 156,000 cells/s (Windows, 24 CPUs, local SQL Server 2025) | not measured |
| Live: first 100-row window after `resultSet.opened` | ≤ 50 ms | ≤ 250 ms | 45 – 103 ms | 102 ms |
| Live: `SELECT 1` in a warm tab, end to end, p50 | ≤ 5 ms | ≤ 50 ms | 0.6 ms, p99 1.3 ms (Windows, 24 CPUs, local SQL Server; 0.7 ms when every execution was followed by a session probe) | not measured |
| Grid: `resultSet.opened` → first data cell painted, median of 5 | ≤ 50 ms | ≤ 250 ms | 56 ms | 57 ms |
| Grid: UI thread busy while 1,000,000 W1 rows stream (250,000 a second) | ≤ 10 % | ≤ 25 % | 8 % | 9 % |
| Grid: `frame()` during a 3 s wheel scroll over 1,000,000 rows, p95 | ≤ 3 ms | ≤ 8 ms | 0.7 – 0.9 ms | 0.8 ms |
| Grid: animation-frame interval during that scroll, p95 / largest gap | ≤ 17.5 / 50 ms | gap ≤ 150 ms | 16.7 / 16.8 ms | 16.8 / 16.8 ms |
| Grid: scroll bar jump to a random row of 1,000,000 → painted, p95 | ≤ 50 ms | ≤ 250 ms | 64 – 71 ms | 66 – 67 ms |
| Grid: `frame()` after a scroll bar jump, 300 columns, p95 | ≤ 8 ms | ≤ 16 ms | 2.3 – 3.1 ms | 2.5 – 3.3 ms |
| Grid: main-thread task time per scroll bar jump, 300 columns / 300 bit columns, p95 | ≤ 50 / 50 ms | ≤ 170 / 260 ms | 73 – 85 / 102 – 128 ms | 75 – 76 / 99 – 129 ms |
| Grid: UI long tasks over 50 ms in those two jump segments (one retry each) | 0 | ≤ 50 | 7 – 23 | 4 – 16 |
| Grid: `frame()` scrolling across 300 columns, p95 | ≤ 6 ms | ≤ 12 ms | 0.5 – 0.8 ms | 0.7 ms |
| Grid: animation-frame interval, 300 columns scrolled 400 px a frame for 3 s, natively / past the cap, p95 | ≤ 17.5 / 17.5 ms | ≤ 60 / 60 ms | 18.4 / 18.9 ms | 21.4 / 22.7 ms |
| Grid: the same over 300 bit columns, p95 | ≤ 17.5 / 17.5 ms | ≤ 80 / 80 ms | 23.1 / 25.3 ms | 30.2 / 32.7 ms |
| Grid: UI long tasks over 50 ms in those four wheel segments | 0 | ≤ 20 | 0 | 0 |
| Grid: DOM elements, 8 / 300 / 300 bit columns | ≤ 1,500 / 4,000 / 4,000 | same | 535 / 931 / 1,811 | 535 / 931 / 1,811 |
| Grid: UI window cache after a sweep and 300 jumps, windows / text | ≤ 256 / 16 Mi units | same | 256 / 5.8 Mi | 256 / 5.8 Mi |
| Grid: worker page cache after the same | ≤ 64 MiB | same | 64 MiB | 64 MiB |
| Grid: worker page cache after 60 jumps over 5,000 rows of 300 columns, bytes charged beyond page bytes per cached column (the column-view charge; 0 if pages were charged their wire bytes alone) | ≥ 320 bytes | same | 320 bytes (33.8 MiB for 79 pages, Windows, 24 CPUs) | not measured |
| Grid: renderer heap growth, Ctrl+End then Ctrl+Home over 1,000,000 rows | ≤ 80 MB | ≤ 150 MB | 0.1 MB | 0.1 MB |
| Grid: UI long tasks over 50 ms in the measured segments / the longest | 0 / ≤ 50 ms | reported / ≤ 250 ms | 32 / 101 ms | 18 / 70 ms |
| Grid, live: Ctrl+A, Ctrl+C of 100,000 × 8 rows → clipboard (16.7 MB) | ≤ 1.5 s | ≤ 6 s | 0.57 – 0.81 s | 0.61 s |
| Grid, live: Save Results As CSV, 1,000,000 × 8 rows (172 MB) | ≤ 3 s | ≤ 15 s | 1.5 – 2.0 s | 1.5 s |

Measured in a shared Linux container (Xeon at 2.1 GHz, Node 24, .NET 10, SQL Server 2022 in Docker on the same machine)
while another build was running, once with its 4 CPUs and once with the app and benchmarks pinned to 2 (`taskset`), as
on a private repository's Linux runner; megabytes are 10⁶ bytes. Floors sit at about half of the 2-CPU values or lower,
so that slow, shared CI runners never fail them. The control codec misses its target: it is a hand-rolled, fully
validating decoder for small, infrequent bodies, and pages never pass through it. A result set's first page (64 rows) is
announced at once; the live first window needs 100 rows, from the second page, which the next progress event announces
(they are 100 ms apart). Four windows in flight read adjacent row ranges, and the page holding the boundary between two
of them comes once with each read (it is decoded once); that is the extra page bytes sent. The budget charge is the
pages, their bookkeeping and the column metadata, against the distinct page bytes main forwarded. The end-to-end W1 rate
includes copying each page from main into the renderer and cloning every window's text to the UI thread.

A single scroll bar jump reads its tiles at once; the grid waits for scrolling to settle (50 ms) only while it stays
faster than three views a frame. The grid's cache and element rows are bounds rather than speeds, so their floors are
the bounds themselves. Long tasks over the whole run are counted only for the report: `results-smoke.mjs` holds each of
its measured segments to no task with 50 ms of CPU time on Linux (100 ms elsewhere) and none of 250 ms by the clock (one
retry), read from a trace of the renderer's main thread, since a shared machine stretches short tasks by the clock;
over the whole run here only the longest task has a floor, which a freeze would break; opening the 2 MB value is one task of about 70 ms. Jumps across many columns miss
their 50 ms target: each rewrites every cell in view, and styling, laying out and painting that many cells (most of a
300 bit-column grid's 1,811 elements) takes 40 to 90 ms on these CPUs. Row numbers are one sticky column beside the
rows, because a sticky header inside each pooled row made every row a composited layer and every narrow-column jump a
long task (151 ms p95 before). `results-smoke.mjs` checks that nothing inside a row is sticky, and the jump segments'
long tasks have a floor of half their 100 jumps. Scrolling wide results continuously misses 60 frames a second: every
frame writes the cells of the rows that scrolled in, and 300 bit columns put about 1,800 elements in view, whose
styling, layout and painting take most of a frame on these CPUs. Rows are moved in the DOM (so browse-mode screen
readers read them in order) only in the first frame after scrolling stops, which took the 300 bit columns from 124 to
163 frames in those 3 s (p95 34.4 → 23.1 ms). The first data cell paints after two animation frames (the pane's update
and the tile's arrival) plus the tile's read: the stack mounts its first grids and draws their first frame before the
pane paints, which took the first paint from 80 to 56 ms; the two frames alone are 33 ms at 60 Hz, so the 50 ms target
is missed by the read.
