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
| Live subscriptions | `src/shared/live/` (catalogue, schemas, docs/live.md); main's parts in `connection.ts`, `supervisor.ts`, `results-port.ts` | `Live/LiveService.cs` (registry, scheduler), `LiveCatalog.cs`, `SqlSampler.cs` (pools, prologues, table reads), `LiveSql.cs` (probe text, lint), `LiveSqlReader.cs` (multi-statement sources), `Activity/ActivityReader.cs` and `ActivityRows.cs` (the Activity Monitor source), `LiveTables.cs` (snapshot and append writers), `LiveStart.cs`, `LiveDeltas.cs`, `LiveGates.cs`, `LiveResume.cs`, `LiveErrors.cs`, `SyntheticSampler.cs` |

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
| 4 | EVENT | backend → main | id of a `query.execute` request: a [query event](#query-events). id 0: `{ type: 'results.memory', usedBytes, globalBytes, seq }` |
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
become float64, which TypeScript accepts. Requests that carry a password (`connections.connect`, `.databases`,
`.preview`) are encoded into buffers that are zeroed after use on both sides; the JavaScript and .NET strings they came
from cannot be zeroed.

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
`actions` runs object action DDL at once under the action service's own gates (1 per connection, 2 in all, each waited
for at most 30 s, then `BUSY`), so a DROP waiting on a lock never holds a metadata slot. `live` takes no slot either: a
live subscription samples on its own task, and its statements, like those of any unary method on lane `live` (none yet;
`LiveService.RunGatedAsync`), run under the live gates (2 per connection, 8 in all, each waited for at most the
statement's budget, then `BUSY`; only for a connected id, else `NOT_CONNECTED`, so ids a request names never pile up).

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
| `query.execute` | invoke, events on the port | unary with EVENTs | query | none; backstop `timeoutSeconds + 30` s |
| `query.cancel` | invoke | unary | control | 10 s |
| `query.session.close` | invoke | unary | control | 10 s, 60 s with `transaction: 'commit'`; answered locally `{ closed: false }` for a session of an ended generation |
| `query.session.state` | invoke | unary | control | 5 s; answered locally `SESSION_LOST` for a session of an ended generation |
| `results.read` | port | stream | results | 60 s |
| `results.close` | port | unary | control | 10 s |
| `live.subscribe` | port | stream of credited EVENTs ([Live subscriptions](#live-subscriptions)) | live (no slot) | none, and no backstop: only CANCEL, a disconnect, a shutdown, a failure or its source ending ends it |
| `live.update` | port | unary | control | 10 s |
| `explorer.children` | invoke; cancelled with `explorerCancel` | unary | explorer | 45 s; the backend answers its own 40 s budget as an `error: TIMEOUT` value |
| `results.copy` | main only (`varia:results-copy`) | stream, with EVENTs | results | 120 s |
| `results.export` | main only (`varia:results-save`) | unary with EVENTs | results | none, and no backstop: only CANCEL (reason 1) ends it |
| `scripting.script` | invoke; cancelled with `cancelScripting` | unary | metadata | 60 s; the backend answers its own 55 s budget as an `error: TIMEOUT` value |
| `actions.describe` | invoke; cancelled with `cancelObjectActions` | unary | metadata | 45 s; the backend answers its own 40 s budget as an `error: TIMEOUT` value (reads wait at most 10 s for a lock: `BLOCKED`) |
| `actions.script` | invoke; cancelled with `cancelObjectActions` | unary | metadata | 30 s; the backend answers its own 25 s budget as an `error: TIMEOUT` value |
| `actions.execute` | invoke; cancelled with `cancelObjectActions` (Stop) | unary | actions | none, and no backstop: DDL waits for locks as SSMS does, and only CANCEL (reason 1) ends it, answered with its steps once SQL Server has ended the statement (at most 10 s later). Never re-sent |
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

**Scripting cancellation** works the same way (`ScriptingRequests`, `varia:scripting-cancel`, 1–64 ids, 256 tombstones
for 60 s). The backend sends an attention for the statement SMO has in flight, answers at once, and keeps the job's
gate (2 per connection, 4 in all) until its thread ends; scripting failures are `result.error` values (docs/scripting.md).

**Object action cancellation** works the same way (`ActionRequests`, `varia:actions-cancel`, 1–16 ids, 64 tombstones for
60 s; 128 running): the object dialog's Stop, the status bar's Stop for a rename, and a disconnect cancel
`actions.describe`, `actions.script` and `actions.execute` by `requestId` (main routes exactly these and
`explorer.children` and `scripting.script` to a cancel channel, `cancellableRequests`). The backend cancels the statement
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
`NAME_IN_USE`, `DATABASE_UNAVAILABLE`, `TIMEOUT`, `CONNECTION_LOST`, `SQL_ERROR`, `CANCELLED` (Stop), `AUTH_KERBEROS`,
`AUTH_UNSUPPORTED` and `AUTH_ENTRA` (docs/object-actions.md). `actions.execute` answers `{ steps: { status: done | failed | skipped |
cancelled, message? }[], messages: str[] (≤ 32 × 512), elapsedMs, error? }`: statements run in order and stop at the first
failure. The backend's DryRun, which selects a statement instead of running it, exists only for the .NET checks and is
not reachable from the wire.

**Database Properties** uses the same three methods. `actions.describe { connectionId, requestId, dialog:
'databaseProperties', target: { kind: 'database', name } }` (any database, SQL Server's own included) answers
`{ databaseProperties: { general, options, scoped, compatibilityLevels, collations (≤ 8,192), logins (≤ 1,024), files
(≤ 1,024), filesTruncated, filegroups (≤ 256), filegroupsTruncated, server: { level, sysadmin, filestreamLevel,
pathSeparator, edition, containedAuthentication }, sessions?, readOnlyReason? }, elapsedMs }`, where `options` and
`scoped` map the catalogue's option keys (docs/object-actions.md) to tokens. `actions.script` and `actions.execute` take
`{ action: 'properties', connectionId, requestId, target, closeConnections, changes: { owner?, options?, scoped? } }`:
only changed values, at least one and at most 512 statements, each key a settable option with one of its tokens (an
integer as plain decimal text in range, a collation name of letters, digits and underscores), and `closeConnections` (the
Open Connections prompt's Yes, `WITH ROLLBACK IMMEDIATE`) only with an option SSMS closes connections for. Script always
writes `WITH NO_WAIT` and answers `database: 'master'`; execute runs one step per statement, titled by the option's label.
Before any statement, execute counts the database's sessions again, as SSMS does when OK is pressed: an option SSMS closes
connections for, without `closeConnections`, while other sessions are in the database answers `IN_USE` with no steps, and
the dialog asks Open Connections. When execute has just closed the backend's own idle pooled connections in the database,
whose sessions SQL Server can still list for a few milliseconds, a count above zero is taken again every 50 ms for up to a
second first. Turning Database Read-Only on with a change SQL Server refuses after it on a read-only database (the owner,
scoped configurations, Target Recovery Time, Delayed Durability, FILESTREAM Non-Transacted Access) answers `NOT_SUPPORTED` before
anything runs, for Script too.
A script is at most 1,000,000 characters (`scriptChars`, main's query limit). The Open Connections question itself is
main's message box on its own channel, `varia:confirm-open-connections` (no payload, trusted senders only), answering
`true` only for Yes.

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

## Query execution

`query.execute` takes `{ connectionId, sessionId, database, sql, queryId, maxRows, timeoutSeconds, startLine?,
maxResultSets?, stopOnError? }`. `sessionId` is the query tab's UUID: the tab's SQL session is one unpooled connection
with connection recovery off, opened on its first execution and kept until the tab closes, its server changes, or it is
lost.

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
opened. The status bar shows `login (spid)`, as SSMS does. Nothing runs in the session after a script, so the next
script sees the `@@ROWCOUNT` and `@@ERROR` the previous one's last statement left, and the session's most recent SQL
(`DBCC INPUTBUFFER`, `sys.dm_exec_input_buffer`, sp_WhoIsActive) is the user's own; the live checks pin both.

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
committed. Check the data before running the work again." `'rollback'` is a plain close: SQL Server rolls back what a
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
| `resultSet.opened` | When a kept result set's columns are known, before its first row; carries the descriptor |
| `progress` | At most 10 times a second per query, latest value wins; up to 64 result sets with `rowsRead`, `rowsStored`, `rowsAvailable`, `bytesStored`. A sealed page is reported at once when no progress went out in the last 100 ms, and every set's first sealed page at once whatever the spacing, so the first rows of each set (one-row sets included) are readable without waiting for a tick |
| `messages` | Every 100 ms or 64 KiB, only entries stored under the message caps: `{ text, kind: 'info' \| 'error' }` ([Messages](#messages)) |
| `resultSet.closed` | Once per kept result set, with its final descriptor |
| `results.memory` (id 0) | Checked once a second and after each `results.close` (before its answer): when usage crosses 50, 75, 90 or 100 % of the budget, grows by 64 MiB, or falls below the last report (results were closed, or a lease ended). The status bar follows these events and each summary's `budget`, not the `usedBytes` of a close's answer, which could arrive after a newer event; a summary's `budget` counts as a report, so closing results that only a summary showed still sends the fall. Events and summary budgets take their `seq` from one counter of the backend process, under the same lock as the usage they carry, and main pairs it with the generation: a summary is serialized after its figure is taken, so a close in another tab can send its fall first, and the status bar ignores any report older than the one it shows. Like any droppable event it is refused while the control lane is full (main not reading); a refused report does not count as sent and takes no `seq`, so the next check sends it once the lane drains |

Progress and messages are droppable: when the backend's control lane holds 1,000 frames or 8 MiB, new ones are refused,
and one over 256 KiB is dropped. `resultSet.opened` and `resultSet.closed` are essential: never refused, and up to
4 MiB, enough for a descriptor of 4,096 columns with 128-character names (about 3.5 MB). RESPONSE, PONG and GOAWAY are
never dropped. The UI treats the summary as authoritative and
ignores a query's events once its summary has arrived.

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
  hooks.
- **Charges.** Each sealed page costs its length plus 96 bytes; a result set's metadata 512 bytes plus 2 per name
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
messages get "Column ‘{name}’ ({type}): some values could not be read and are shown as NULL."

## Messages

The summary's `messages` and the `messages` events carry `MessageEntry { text, kind: 'info' | 'error' }`, in order, under
the caps (1,000 entries, 1,000,000 characters); the summary is authoritative, since events may be dropped. Past the caps,
"Messages were truncated by the display limit; …" marks where entries stopped, and up to 20 more error entries (each cut
at 16,384 characters) are still kept, so the error that stopped a script, or its cancellation or timeout, is in Messages
after a flood of PRINT output or row counts. An event carries at most 1,000 entries; a summary at most 1,028 (the
stored entries, the late errors, and up to 8 notes). Should a summary with an `error` still hold no error entry, the
renderer adds its `error` as one.

- **Info:** PRINT and other severity 0 – 10 messages, row counts as SSMS writes them ("(1 row affected)", "({n} rows
  affected)", no digit grouping), the notes above, "Batch {b} raised an error; execution continued with the next batch."
  after a batch that raised an error when another remains ([Query execution](#query-execution)), and "The SQL session
  closed. …" when a session that had opened closed (not for one that failed to open). As in SSMS, "Changed database
  context to …" (5701) and "Changed language setting to …" (5703) are left out, whether from USE, a session's login, or
  the toolbar's database.
- **Error:** every severity 11+ error in SSMS's two-line form, `Msg {n}, Level {l}, State {s}, Line {k}` (the line within
  the whole script or selection) or `Msg …, Procedure {p}, Line {k}` (the procedure's own line), then a line feed and the
  message. Errors that arrive with an exception are added unless InfoMessage already delivered them (matched by number,
  state, line and text over the last 20). A cancel adds "The script was cancelled. Remaining batches were not executed."
  and a timeout "The script exceeded its execution timeout. Remaining batches were not executed."; an unexpected stop adds
  "Execution stopped unexpectedly: …". The summary's `error` keeps the first 20 errors (16,384 characters) as before.
- **`completedAt`** is the backend's local time, `yyyy-MM-ddTHH:mm:ss.fffffffzzz`, for SSMS's "Completion time:" line.
- **`budget`** is `{ usedBytes, globalBytes, queryBytes, seq }` when the summary was built; main adds `generation`. `seq`
  orders it with the `results.memory` events (see [Query events](#query-events)).

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

- **`results.copy { resultId, parts, headers, eol: 'crlf' | 'lf', maxBytes: 1 … 67,108,864 }`** (stream). A part is 1 –
  64 ascending, disjoint inclusive row ranges (a last row of 2⁵³ − 1 runs to the end) by 1 – 64 column ranges; up to 64
  parts, written in order. Open-ended rows end at the rows available when the copy starts, and `partial` says the set was
  still open. Before any work, `EstimateBytes` (O(pages × columns): the stored text spans, `2 × bytes + 2` per binary
  cell, 4 per NULL, separators and headers; replacements never lengthen text, so it is an upper bound) over `maxBytes`
  answers `TOO_LARGE` ("The selection is too large to copy ({n} MB; the limit is {m} MB). Use Save Results As
  instead.") with no DATA. Otherwise the text streams as DATA bodies of at most 1 MiB under the usual credit rules,
  checked for cancellation per page, then the RESPONSE `{ rows, bytes, truncatedCells, partial }`.
- **`results.export { resultId, path, format: 'csv' | 'tsv' | 'json', headers, nullText: 'empty' | 'NULL', temporaryId }`**
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
- **Main (`ResultsJobHost`).** `varia:results-copy { jobId, generation, resultId, headers, parts }` and
  `varia:results-save { jobId, generation, resultId, format?, suggestedName ≤ 128 }` are `trusted()`, strictly
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
Activity Monitor's `activity` (server DMVs: `activity.overview`, `activity.sessions`, and `activity.resources`, declared but not sampled yet). The test source `debug.synthetic` is accepted only by main's test schemas (`ResultsPortHost` with
`testSources`, set only in unpackaged smoke runs) and by a backend with `VARIA_BACKEND_TEST_HOOKS=1`, as
`debug.results.synthesize` is. Both methods are port methods (`PortMethods`): the renderer reaches them only through the
results port, and a backend whose HELLO lacks either is refused.

**Request** (strict at every level; the backend checks the same rules against the same catalogue):

```ts
live.subscribe { subscriptionId: uuid, connectionId: uuid, source, probes: { probe, intervalMs: 1,000..3,600,000, paused?,
                 sort?: { column, descending }[1..4], view?, filter?: { text: 1..400, columns?: id[1..8] } }[1..8],
                 args?, resume?: base64url ≤ 256 }
live.update    { subscriptionId, source, paused?, probes?: (the same, intervalMs optional, clear?: (sort | view | filter)[1..3])[1..8],
                 refresh?: true, track?: { probe, table, seq: u31, keys: str ≤ 512 [≤ 64] }[1..8], args? }
```

Every probe belongs to the source and is named once; the interval is then clamped to the probe's own minimum and maximum.
Sort names columns of the probe's snapshot tables (catalogue column ids, not ordinals; the row key breaks ties), a view must
be one the probe declares, and a filter needs a probe with a filter mode. `args` is checked by the source's own schema
(`liveArgsSchemas`): `debug.synthetic` takes `{ rows?: 0..10,000, tickMs?: 10..60,000, endAfterTicks?: 1..10,000,
errorEvery?: 1..1,000, logRows?: 0..10,000, logLevel?: 0..3, lateEvery?: 1..1,000, start? }`, a sampling period below the 1 s
minimum so tests run fast (samples still report the requested interval), a sample count after which the source ends, an
error value every n-th table sample, and its log's messages per sample, lowest level, late messages and start. `activity`
takes `{ filters?: activity filter[1..7], focusSession?: 0..32,767 }` (`activityLiveArgsSchema`), at least one member: one filter
per table (`activityFilterSchema`: Processes' view chip and System and Varia toggles, the filter box ≤ 400 characters, ≤ 8
column value filters of ≤ 50 values ≤ 256 characters on the table's facet columns, Hide benign waits on Resource Waits), and
the session the sessions probe's two series follow (the Details flyout; 0 for none). An update replaces the filters of the
tables it names and keeps the others; a table without one shows the catalogue's defaults (system sessions, Varia's pools and
benign waits hidden). The Activity Monitor's column ids are unique within a probe (its first table keeps the catalogue's ids,
the others take a prefix: `chainSessionId`, `activeCpuMs`; docs/activity-monitor.md), so one sort list orders each table by
its own columns and never reorders another. A source
whose append tables can start elsewhere than their first row takes `start` (`liveStartSchema`): `'beginning'`,
`{ tail: 1..200,000 }` (the last rows) or `{ before: 1..2^53−1 }` (the rows before an id, ending there). Tracking names a keyed
snapshot table by its index; each key is the key columns' stored cell texts joined with U+001F. A source without append
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
  of another of the probe's tables leave this one whole), sorts by the probe's sort (numbers as numbers, NULL first ascending,
  text case-insensitively and then exactly), then by the key, so equal values never trade places, and stores at most the
  table's row cap (`rowLimit` past it, the rows the source left out counted in `rowsRead`). `diff` counts keys added and
  removed and kept keys whose cells changed (a 64-bit hash of their texts); `tracked` gives each key of the latest track list
  its new row or −1. A key is its key cells' stored texts joined with U+001F, NULL as empty text, so it equals what the worker
  decodes. A table with `departed` keeps a tracked row that left the source (not one its view or filter hides) for one more
  revision, at the row it had, and lists it in `departed`; the next revision drops it. Facet columns carry their distinct
  values over every row the source gave (before the view and filter; NULL left out), most frequent first, at most 100 of at
  most 128 characters (values that differ only past them count together), and only when they changed since the table's last
  facets; a tick's facet text is shared by its tables up to 32 KiB, counting only the facets a sample sends, and what does
  not fit is left out (`more`) for a later tick to send.
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
- **Acknowledgement.** Main posts `{ t: 'live', rid, bytes, event }` to the worker; the page applies the event and the
  worker sends the existing `{ t: 'credit', rid, bytes }`. `ResultsPortHost` and `BackendConnection.credit` both clamp an
  acknowledgement to the bytes outstanding, so no acknowledgement, however large, lets two frames be in flight.
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
count; its grid probe stores two snapshot tables from one sample, items (a view, facets, departed rows) and their groups,
which come from the source's own state rather than a query, and with `errorEvery` fails the groups alone, as one failed
statement of a batch would; its log probe grows an append table from an in-memory log, with late messages, a start, and a
restart when its filter or level changes; and its wide probe stores the 23-column snapshot the churn benchmark swaps,
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

**SQL sources** (`Live/SqlSampler.cs`; scope `server`, the `activity` source): one pooled connection per subscription
from the connection's own **" - Activity Monitor"** pool (registered with the connection's pools, so a disconnect clears
it), held while it samples so its session id is known (`live.opened`'s `spid`; a tick carries `spid` when it reopened).
SSISDB sources (later) use the **" - Integration Services"** pool in `SSISDB` with their own prologue
(`LiveConnections`). Every command starts with its prologue, since a pooled connection can carry another command's SET
state: `SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;`
for server DMVs and SSISDB without READ_COMMITTED_SNAPSHOT, `READ COMMITTED` instead for SSISDB with it. Connecting takes
no live gate (a server that stopped answering a login never holds one that views on other servers need) and has its own
15 s bound, a `TIMEOUT` value past it, since a profile's Connect Timeout may be 0 (none); a connect that failed in a tick
is reported for that tick's other due probes rather than tried again at once. Opening connects and runs one session
probe (2 s budget, under a gate; with the gates full, the first tick runs it): `@@SPID` and `HAS_PERMS_BY_NAME` for VIEW
SERVER PERFORMANCE STATE (SQL Server 2022 and later) or VIEW SERVER STATE (earlier, Managed Instance), the permission name
a parameter. The Activity Monitor's source runs its capability probe in its place (Activity/ActivitySql.cs `Capabilities`):
the session id and whether the login reads server state, may end sessions (ALTER ANY CONNECTION) and sees every file's name
(VIEW ANY DEFINITION), and whether the query statistics have spills; its sessions probe sends the first two as the status
values `serverState` and `canKill` with its first sample on each new connection. A subscription whose probes all start paused connects for neither until one resumes (no SQL while paused). A probe whose catalogue gates (version
from its band, where Managed Instance counts as the newest; EngineEdition) exclude the server opens `unavailable`
`NOT_SUPPORTED`; one that needs server state the login lacks opens `unavailable` `PERMISSION_DENIED`; neither ever runs.
When the session probe did not run as the source opened (every probe paused, the gates full, the connect failed), such a
probe opens `ok` and stops at its first tick with a terminal `PERMISSION_DENIED`, running nothing.
A connection that fails to open there is reported by the first tick instead. Each statement waits for a live gate (at most
its budget, else `BUSY`), then runs with `CommandTimeout` 0 under a cancellation token that fires at its budget: 0.8 ×
the asked interval within the probe's `budgetMs` (500 ms to 5 s by default; never above 10 s), so a 2 s overview has 1.6 s,
more than `LOCK_TIMEOUT`. A source with several statements per probe (`ILiveSqlReader`; the Activity Monitor's
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
text per probe and band in `Live/LiveSql.cs` (none ships yet; the live checks register theirs): one batch per probe, its metrics
row (when it has series) with the columns it declares, mapped to the catalogue's series, then one result set per table, in
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
server's band and compare its columns.

**Errors** (`Live/LiveErrors.cs`): 1222 and 1205 are `BLOCKED`; the budget is `TIMEOUT`; 297, 300, 229 and 262
`PERMISSION_DENIED` and 207 and 208 `NOT_SUPPORTED` (both terminal; so are an SSIS source's `CATALOG_MISSING` and `NOT_FOUND`); 4060, 911, 942, 952 and the other offline,
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
baseline (`gap: 'reset'`); a counter that went down rebaselines alone (null, `reset`); the first sample, the first after a
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
{ t: 'read'; rid: u31; generation; resultId: u32; firstRow: 0..2^53-1; maxRows: 1..65_536; credit: 65_536..16_777_216 }
{ t: 'credit'; rid; bytes: 1..16_777_216 }
{ t: 'cancel'; rid }
{ t: 'close'; rid; generation; resultIds: u32[1..1024] }
{ t: 'live'; rid; generation; params: live.subscribe params }
{ t: 'liveUpdate'; rid; generation; params: live.update params }
```

A read or close must name the current generation and a result the renderer owns (from a query summary or event, at most
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
pages; pages a pending window needs are never evicted, so once those alone pass 64 MiB, windows that already have rows
answer with them, as a shorter window), reads each missing contiguous range once with 4 MiB of credit, waits for rows a
read in flight will bring instead of reading them again, cancels a read nobody waits for, and grants credit after
caching each page (a page that arrives twice, the boundary page of two adjacent reads, is credited without being
decoded again). A page that fails `decodePage` ends its read with `PAGE_INVALID` and is not cached. A new generation
fails pending work with `RESULT_UNAVAILABLE` and drops older pages.

**`ResultClient`** (`ResultClient.ts`) is the renderer's API, the contract the PR7 grid builds on: `open(descriptor)`
returns a `ResultHandle` with `getSnapshot`, `subscribe` (coalesced per animation frame), `getWindow(first, count, o)`
(at most 4,096 rows, 262,144 cells and 4,000,000 characters; 1,024 characters per cell by default, at most 2,097,152;
flags 1 NULL, 2 truncated, 4 read error, 8 over the text budget), `peekWindow`, `prefetch`, `getCell` (a cell's whole stored
value; with `format: 'xml' | 'json'` the worker pretty-prints it with `doc-format.ts`, unless the backend stored only a
prefix, and reports `formatted`) and `close`, plus
`onQueryEvent`, `onMemory`, `onGeneration` and `applySummary`. It forgets a result once it is released or its
generation is gone (handles keep reporting `released` or `lost`). The grid reads tiles of 128 rows × 32 columns, at most
512 characters per displayed cell, and every grid shares one window cache of 256 windows and 16,777,216 UTF-16 units
(least recently used first, indexed by result so a result's windows go without a scan). `release(keys)` closes many
results at once, 1,024 ids a request: a run's sets close with one call when its tab runs again or closes, or Close
Results runs, since one request each would run into the port's 64 outstanding requests. Ids wait while the port is
down, and ones main refused as busy (`TOO_MANY_REQUESTS`) are sent again 250 ms later. A worker that fails is recreated
and reattached at most 3 times a minute; after that, results show "Results cannot be displayed; reload the
workbench."


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
  one), closes the generation gracefully (stdin end, 2 s, then kill), starts the next at once, and resets the breaker.
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
- **Quitting** waits for the backend to stop (stdin end, 2 s, then kill) before the app exits, and for any generation a
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
| Copy | 64 MiB of UTF-8 (estimated before any work; main cancels past 65 MiB received); DATA ≤ 1 MiB; 16 MiB initial credit; 120 s; one per window | backend and main |
| Save Results As | one per window; 1 MiB writes; no deadline; suggested name ≤ 128 characters, path ≤ 32,767 | main and backend |
| Job progress | EVENTs every ≥ 250 ms; pushed to the renderer ≤ 4 a second | backend and main |
| Pending requests in main | 256 per generation plus 32 for control-lane methods; 32 MiB queued for stdin | main |
| Session prompts | 1,024 queries, names ≤ 512 characters, 10 listed by name; 15 s for cancelled queries to stop | zod and renderer |
| Files main opens | 32 at a time (an Open selection, the command line, a second instance, macOS open-file, a drop); paths ≤ 4,096 characters; errors ≤ 600 characters; change checks 2 comparisons at a time (counting those that outlived their 2 s) and none again for a file whose last one has not settled | zod and main |
| Recent Files | 50 entries in `recent-files.json` (≤ 256 KiB); 1 – 24 shown; names ≤ 260 characters; menu paths ≤ 60 | zod and main |
| AutoRecover | 64 records and 256 MiB in `AutoRecover/`, 32 MiB each, read or written; text ≤ the kind's limit (5,000,000 characters for a query, 4,194,304 for a value); names ≤ 512, servers ≤ 256, databases ≤ 128, paths ≤ 4,096 characters; 256 ids a discard; every 1 – 60 minutes, kept 1 – 90 days | zod, renderer and main |
| Backend concurrency | 288 requests in flight; 8 metadata slots; 1,000 query sessions; 16 concurrent `results.read`; Object Explorer statements 4 per connection and 8 in all, 1,024 registered loads | backend |
| Credit | 64 KiB – 16 MiB per grant (worker 4 MiB); 16 MiB outstanding per stream, 64 MiB per port; one page of overdraft | main and backend |
| Results port | 64 outstanding requests; 100 invalid messages close it; 10 opens a minute per page load | main |
| Live subscriptions | 16 per results port, 32 per backend, 8 per SQL Server; 8 probes each, 4 snapshot and 4 append tables per probe, 8 tables a tick; one unacknowledged EVENT (64 KiB initial credit), at most 256 KiB (catalogue worst case 192 KiB); interval 1 s – 1 h; 64 series, 16 status values of 128 characters, 8 probe errors of 2,000; sort 4 columns, filter 400 characters on 8, track 64 keys of 512; resume 256; 64 kept results; snapshot revisions ≤ 10,000 rows, append segments 200,000 rows or 32 MiB (2 segments' worth kept, at most 8 results a table), ≤ 10,000 new append rows a tick; 64 MiB of tables per subscription, all live tables ≤ 25 % of the result budget; facets 7 columns × 100 values × 128 characters, ≤ 32 KiB of facet text a tick; live statements 2 per connection and 8 in the backend; statement budget 0.8 × interval within 500 ms – 10 s (5 s by default); back-off up to 60 s (or the asked interval); LOCK_TIMEOUT 1 s; connection back to the pool when idle 30 s | zod, main and backend |
| Results worker | 64 MiB / 512 cached pages (pending windows answer early past 64 MiB); windows of 4,096 rows, 262,144 cells, 4,000,000 characters | worker |
| Results grid | tiles of 128 rows × 32 columns; 512 characters per displayed cell; one window cache of 256 windows / 16,777,216 UTF-16 units; at most 12 grids mounted, 2 a frame | renderer |
| Timers | HELLO 20 s; PING every 5 s; unresponsive after 15 s; stop grace 2 s; backstop deadline + 5 s; progress ≤ 10/s; messages every 100 ms | main and backend |
| Restarts | after 0 s, 1 s, 2 s; breaker at 3 unexpected losses in 120 s; reset after 300 s ready | main |
| Registries | 1,024 lost connection ids; 4,096 abandoned request ids; 100,000 owned results per generation; stderr 32 lines × 512 characters | main |

## Error codes and fixed sentences

Failures reach the renderer as `{ ok: false, error, code, details? }`. Messages are complete sentences shown as they are.

`details` comes only with a failed `connections.connect` or `connections.databases` open. The Connect dialog shows them in
**Error details** under a failed Connect, and under a failed **Load databases**' note, as SSMS does for both. They are
`{ number?: int32, state?: 0–255, class?: 0–255, server?: str ≤ 256 }`, SqlClient's first error and the
server that answered (the server typed when SqlClient names none). It never holds the connection string or the password.
Main refuses (as a contained violation) details with any other member or out of these bounds.

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
| Backend | `INVALID_REQUEST`, `INVALID_PARAMS`, `METHOD_NOT_FOUND`, `BUSY`, `CANCELLED`, `TIMEOUT`, `SQL_ERROR`, `SMO_ERROR`, `BACKEND_ERROR`, `NOT_CONNECTED`, `NOT_FOUND`, `DUPLICATE_QUERY`, `DUPLICATE_REQUEST`, `SESSION_BUSY`, `SESSION_LOST`, `SESSION_CLOSED`, `SESSION_TARGET`, `SESSION_LIMIT`, `AUTH_UNSUPPORTED`, `AUTH_KERBEROS`, `AUTH_ENTRA`, `INVALID_SCRIPT`, `TOO_LARGE`, `RESPONSE_TOO_LARGE`, `RESULT_NOT_FOUND`, `RESULT_RELEASED`, `EXPORT_FAILED` (message: one token), `RESULT_OPEN` |
| GOAWAY | `PROTOCOL_ERROR`, `PROTOCOL_UNSUPPORTED`, `BACKEND_CRASH` |
| Main | `BACKEND_LOST`, `BACKEND_UNAVAILABLE`, `CONNECTION_LOST`, `RESULT_UNAVAILABLE`, `TOO_MANY_REQUESTS`, `STREAM_PROTOCOL`, `PORT_CLOSED`, `TIMEOUT`, `CANCELLED` and `DUPLICATE_REQUEST` (Object Explorer loads), `JOB_BUSY`, `TOO_LARGE` and `INVALID_REQUEST` (results jobs), `DUPLICATE_REQUEST` and `NOT_FOUND` (live streams of the results port); an unknown backend code becomes `BACKEND_ERROR` |
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
| `RESULT_UNAVAILABLE` (closed during the save dialog) | "These results were closed before they could be saved." |
| `RESULT_OPEN` | "Save the results after this result set finishes loading." |
| `EXPORT_FAILED` | "Could not save the results: " + `ACCESS` "access to {file} is denied.", `DISK_FULL` "the disk is full.", `IN_USE` "{file} is open in another program.", `NOT_FOUND` "the folder no longer exists.", `IS_DIRECTORY` "{file} is a folder.", otherwise "{file} could not be written." |

| Surface | Text |
| --- | --- |
| Status bar | "Starting SQL backend…", "{runtime} · Ready", "SQL backend not responding…", "Restarting SQL backend…", "SQL backend unavailable" |
| Banner: not responding | "The SQL backend is not responding. You can keep waiting, or restart it; restarting closes all connections and rolls back uncommitted transactions." **Restart now** |
| Banner: unexpected restart | "The SQL backend stopped unexpectedly and was restarted. {n} connection(s) were lost and {m} running script(s) were stopped; nothing was re-run." **Reconnect…** **Dismiss** |
| Banner: manual restart | "The SQL backend was restarted. {n} connection(s) were closed." **Reconnect…** **Dismiss** |
| Banner: crash loop | "The SQL backend stopped repeatedly and was not restarted again." **Restart SQL Backend** **Copy details** |
| Banner: cannot start | Development: "Could not start the .NET backend. Install .NET 10 and run npm run backend:build." Packaged: "Could not start the SQL backend. Reinstall Varia SQL Manager." |
| Banner: different build | "The SQL backend is from a different build (protocol {x}, expected 2{; missing: method}). Run npm run backend:build, then restart." (packaged: "Reinstall Varia SQL Manager.") |
| `SESSION_LIMIT` | "This query was not executed: 1,000 query tabs already hold SQL sessions, the most Varia SQL Manager keeps open. Close query tabs you no longer need, or disconnect idle ones (Query > Connection > Disconnect), then execute again." |
| `SESSION_LOST` (commit) | "The SQL session was lost, so SQL Server rolled back its transaction. Nothing was committed." While the commit ran: "The SQL session was lost while committing, so it is not known whether its transaction was committed. Check the data before running the work again." |
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
whole value). The rows that are not stored (past `maxRows`, after the budget stops storing, or in a set that is not
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
| xml, the showplan column | the text as SqlClient serialises it, role `xml` / `plan`, up to 2,097,152 characters. Streamed (`Results/SequentialXml.cs`): XmlReader parses the column's sequential stream as UTF-16 as it arrives, a text node's value is copied out in 8,192-character chunks, and once the cap is reached the rest of the value is read past as bytes, without parsing, so a long text node costs a few MB whatever its length (a 200 MB value allocates under 32 MB in all). XmlReader holds a whole start tag (all of its attributes together), comment or processing instruction before returning it, so the stream reports its end once 8 MiB pass with no new output; a node just inside that window is read whole, growing XmlReader's buffer to about 50 MB allocated in all. A cut value keeps only what the writer had written before that node, marked truncated: the parent's start tag without its `>` (`<r`), text before it (`<r>hello`), or nothing when the node is the root element. Every xml cell of a set reuses one output buffer and one feed, so a small cell allocates about 28 KB, mostly XmlReader's and XmlWriter's own buffers (the live .NET suite reports it and checks it stays under 36 KB). SqlClient 7.1.1's `GetXmlReader` lets XmlReader guess the encoding (a value that starts with text throws or, for some characters, reads as other text; fixed after 7.1.1), so the stream is opened as `GetXmlReader` opens it, through SqlClient internals that an offline check pins, with `GetXmlReader` as the fallback. `GetChars` on xml holds each node whole and is quadratic in a large text node, `GetSqlXml` reads the whole value, and `GetStream` and `GetTextReader` reject xml | `abc`, `é<a b="1" />` |
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
  (supervisor, results port, a worker stand-in) over the fake backend.
  `scripts/backend-smoke.mjs` covers restarts, lost connections, the crash loop, the silent backend, a protocol 1
  backend, and UI responsiveness while a million stored rows are read. `scripts/results-smoke.mjs` drives the grid on
  the fake backend's sets and then, with `VARIA_TEST_SQL_SERVER` set, against that server: a million rows shown while
  the script runs, Cancel keeping them, Copy of 100,000 rows and Save Results As of a million compared with the rows
  the query produces, a FOR XML PATH value, and an error reported between the messages around it.

## Benchmarks

```sh
npm run bench                                   # node harness: codecs, main ↔ Release backend ↔ results worker, grid models
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
  every row with every cell decoded (four windows in flight).
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
  planning, and the shared window cache (full, so every insert evicts).
- **The e2e run** reads every row through `window.__variaResults` in the built app (four windows in flight), watching
  the UI thread for long tasks and animation-frame gaps; `--live` stores a million W1-like rows from SQL Server with
  `maxRows: 0`, and times 200 executions of `SELECT 1` in a warm tab.
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
| Live snapshot revisions, 5,000 × 23, stored, sent, acknowledged and released | ≥ 50 swaps/s | ≥ 10 swaps/s | – | – |
| Backend gen2 collections a minute of a 1 s snapshot of them (per revision × 60) | ≤ 60 | ≤ 120 | – | – |
| W1, 500,000 rows, store → main → port → worker | ≥ 1,000,000 rows/s, ≥ 200 MB/s | ≥ 250,000 rows/s, ≥ 50 MB/s | 710,000 – 935,000 rows/s, 150 – 203 MB/s | 514,000 – 612,000 rows/s, 112 – 133 MB/s |
| B1 through the same path | ≥ 400 MB/s | ≥ 100 MB/s | 250 – 410 MB/s | 249 MB/s |
| Main event-loop delay during W1, p99 | ≤ 20 ms | ≤ 100 ms | 12 – 14 ms | 17 ms |
| Page bytes sent ÷ distinct page bytes, W1 | ≤ 1.05 | reported only | 1.29 | 1.29 |
| Budget charged ÷ page bytes | ≤ 1.15 | ≤ 1.5 | 1.00 | 1.00 |
| Grid frame: 64 selection blocks clipped, 1,800 cells tested | ≥ 5,000 ops/s | ≥ 1,000 ops/s | 4,500 – 4,900 ops/s | 5,300 – 5,700 ops/s |
| Grid frame: Mode B scroll mapping, 100M rows | ≥ 5,000,000 ops/s | ≥ 1,000,000 ops/s | 6,500,000 – 7,600,000 ops/s | 6,800,000 – 7,300,000 ops/s |
| Grid frame: visible range, tiles and prefetch ring, 300 columns | ≥ 500,000 ops/s | ≥ 100,000 ops/s | 700,000 – 850,000 ops/s | 800,000 – 870,000 ops/s |
| Grid frame: window cache, 3 lookups and 1 insert at 256 windows | ≥ 100,000 ops/s | ≥ 25,000 ops/s | 157,000 – 174,000 ops/s | 178,000 ops/s |
| Renderer invoke → backend → renderer, p50 / p99 | ≤ 1 / 5 ms | p50 ≤ 5 ms | 0.4 / 1.2 – 1.6 ms | 0.4 / 2 ms |
| W1, 500,000 rows into the worker and UI windows | ≥ 500,000 rows/s, ≥ 100 MB/s | ≥ 100,000 rows/s, ≥ 20 MB/s | 240,000 – 303,000 rows/s, 52 – 66 MB/s | 200,000 rows/s, 44 MB/s |
| B1 into the worker | ≥ 200 MB/s | ≥ 40 MB/s | 90 – 143 MB/s | 90 MB/s |
| First 100-row window of a stored result | ≤ 50 ms | ≤ 250 ms | 17 – 21 ms | 20 ms |
| UI long tasks over 50 ms during W1 | 0 | ≤ 2 | 0 | 0 |
| Largest animation-frame gap during W1 | ≤ 50 ms | ≤ 300 ms | 17 – 33 ms | 133 ms |
| Live: 1,000,000 W1-like rows ingested and stored | ≥ 300,000 rows/s | ≥ 75,000 rows/s | 280,000 – 298,000 rows/s | 280,000 rows/s |
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
